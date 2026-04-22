/**
 * AI Address Resolver — fallback for ambiguous delivery addresses.
 *
 * When deterministic rules in shipment.ts cannot resolve an address with high
 * confidence (ambiguous barrio, missing ZIP, unknown city, descriptive text),
 * this module asks Claude Haiku 4.5 to resolve it using structured tool use.
 *
 * Flow:
 *   1. Hash the inputs and check the cache (AddressResolution table).
 *   2. Check tenant quota (aiResolverDailyUsed / aiResolverDailyLimit).
 *   3. Call Claude with the address_resolver tool.
 *   4. Validate the AI response against whitelists of valid departments and barrios.
 *   5. Persist the resolution to cache for future reuse.
 *   6. Return the structured result to the caller.
 *
 * All decisions are auditable via the AddressResolution table. The feedback
 * loop (dacAccepted) is updated by process-orders.job.ts after the DAC form fill.
 */

import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import { db } from '../db';
import logger from '../logger';
import {
  DAC_CITIES_PROMPT_BLOCK,
  canonicalizeCityName,
} from './dac-city-constraints';
import { resolveDepartmentDeterministic } from './dac-dept-resolver';
import { resolveCityDeterministic } from './dac-city-resolver';
import { geocodeAddressToDepartment } from './geocode-fallback';
import {
  candidateDeptsFor,
  nonPreferredConflict,
} from './duplicate-city-tiebreaker';
import { mvdBarrioFromStreet, parseMvdAddress } from './mvd-street-ranges';

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 512;

// Haiku 4.5 pricing (USD per 1M tokens) — as of April 2026
// Source: https://platform.claude.com/docs/en/about-claude/pricing
const PRICE_INPUT_PER_MTOK = 1.0;
const PRICE_OUTPUT_PER_MTOK = 5.0;
// Prompt caching (5-minute ephemeral):
//   - Cache writes cost 1.25x base input (we pay this only on the first call
//     in a 5-minute window, or when cached content changes)
//   - Cache reads cost 0.1x base input (every subsequent call within 5 minutes
//     that hits the cache pays this reduced rate)
// For LabelFlow's use case (batches of orders processed by the same worker),
// this yields ~70% savings on the cached portion after the first call.
const PRICE_CACHE_WRITE_PER_MTOK = 1.25;
const PRICE_CACHE_READ_PER_MTOK = 0.1;
// Server-side web_search tool: $10 per 1000 requests = $0.01/request.
// Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
const PRICE_WEB_SEARCH_PER_REQUEST = 0.01;

// 19 departments of Uruguay — AI MUST return one of these exactly
export const VALID_DEPARTMENTS = [
  'Montevideo',
  'Canelones',
  'Maldonado',
  'Rocha',
  'Colonia',
  'San Jose',
  'Florida',
  'Durazno',
  'Flores',
  'Lavalleja',
  'Treinta y Tres',
  'Cerro Largo',
  'Rivera',
  'Artigas',
  'Salto',
  'Paysandu',
  'Rio Negro',
  'Soriano',
  'Tacuarembo',
] as const;

// Canonical Montevideo barrios (must match DAC K_Barrio dropdown keys in shipment.ts)
export const VALID_MVD_BARRIOS = [
  'aguada',
  'aires puros',
  'atahualpa',
  'barrio sur',
  'belvedere',
  'brazo oriental',
  'buceo',
  'capurro',
  'carrasco',
  'carrasco norte',
  'casabo',
  'casavalle',
  'centro',
  'cerrito',
  'cerro',
  'ciudad vieja',
  'colon',
  'cordon',
  'flor de maronas',
  'goes',
  'jacinto vera',
  'jardines del hipódromo',
  'la blanqueada',
  'la comercial',
  'la figurita',
  'la teja',
  'larrañaga',
  'las acacias',
  'las canteras',
  'lezica',
  'malvin',
  'malvin norte',
  'manga',
  'maronas',
  'mercado modelo',
  'nuevo paris',
  'palermo',
  'parque batlle',
  'parque rodo',
  'paso de la arena',
  'paso de las duranas',
  'peñarol',
  'piedras blancas',
  'pocitos',
  'pocitos nuevo',
  'prado',
  'punta carretas',
  'punta de rieles',
  'punta gorda',
  'reducto',
  'sayago',
  'tres cruces',
  'tres ombues',
  'union',
  'villa dolores',
  'villa española',
  'villa garcia',
  'villa muñoz',
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export interface AIResolverInput {
  tenantId: string;
  city: string;
  address1: string;
  address2?: string;
  zip?: string;
  province?: string;
  orderNotes?: string;
  // ── Phase-1 enrichment (2026-04-21) ──
  // Extra signals passed to the AI so it can disambiguate addresses that the
  // city+address tuple alone cannot resolve. None of these are part of the
  // cache hash — the address tuple is still the cache key — but they change
  // how confidently the AI can answer on a cache MISS.
  /** Shopify customer email — used to look up prior successful shipments. */
  customerEmail?: string;
  /** Customer phone (any format) — Uruguayan landline prefixes hint at region. */
  customerPhone?: string;
  /** Customer first name (for matching prior orders and as a mild signal). */
  customerFirstName?: string;
  /** Customer last name. */
  customerLastName?: string;
  /** ISO country from Shopify shipping address (defensive: reject non-UY). */
  country?: string;
}

export interface AIResolverResult {
  barrio: string | null;
  city: string;
  department: string;
  deliveryAddress: string;
  extraObservations: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  /**
   * Origin of the resolution:
   *   - 'deterministic' — resolved by rules (ZIP prefix, capital/major city
   *     scan, DAC whitelist match). Zero cost, zero latency. Only possible
   *     for non-Montevideo orders (MVD needs AI for barrio selection).
   *   - 'ai'            — Claude Haiku call succeeded.
   *   - 'cache'         — prior AI result reused from AddressResolution table.
   */
  source: 'ai' | 'cache' | 'deterministic';
  inputHash: string;
  aiCostUsd?: number;
  /** Count of server-side web_search tool invocations in this call (0 on cache hits). */
  webSearchRequests?: number;
  /** Count of prior shipments from this customer fed to the AI as context. */
  priorShipmentsUsed?: number;
}

interface AIToolResponse {
  barrio: string | null;
  city: string;
  department: string;
  deliveryAddress: string;
  extraObservations: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Cost calculation (pure function, exported for testing)
// ───────────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Number of web_search tool requests billed in this API call. */
  web_search_requests?: number;
}

/**
 * Compute the USD cost of a single Anthropic API call given the token usage
 * breakdown from the response. Handles both uncached calls and cached calls
 * (prompt caching with ephemeral 5-minute breakpoints).
 *
 * Priced using the Haiku 4.5 rates hardcoded in this module.
 */
export function calculateAICost(usage: TokenUsage): number {
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const webSearches = usage.web_search_requests ?? 0;
  return (
    (usage.input_tokens / 1_000_000) * PRICE_INPUT_PER_MTOK +
    (cacheCreation / 1_000_000) * PRICE_CACHE_WRITE_PER_MTOK +
    (cacheRead / 1_000_000) * PRICE_CACHE_READ_PER_MTOK +
    (usage.output_tokens / 1_000_000) * PRICE_OUTPUT_PER_MTOK +
    webSearches * PRICE_WEB_SEARCH_PER_REQUEST
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Hashing
// ───────────────────────────────────────────────────────────────────────────
//
// The cache key (AddressResolution.inputHash) has one job: collapse the
// many equivalent spellings Shopify emits for the SAME physical address
// into the same hash, so the second order from the same house hits cache
// instead of re-spending an AI call.
//
// Equivalences we want to collapse (same hash):
//   - "Av. Italia 4500"         == "Avenida Italia 4500"
//   - "Italia 4500"             == "Italia 4500 apto 2"
//   - "Italia 4500"             == "Italia 4500, piso 3"
//   - "Italia 4500"             == "italia 4500"
//   - "Gral. Flores 2400"       == "General Flores 2400"
//   - "Rambla Tomás Berreta 8000" == "Rambla Tomas Berreta 8000"
//   - "18 de Julio 1000"        == "Avda 18 de Julio 1000"
//
// Distinctions we must preserve (different hash):
//   - "Italia 4500"             vs "Italia 45"    (different house)
//   - "Italia 4500" in MVD      vs "Italia 4500" in Paysandú
//     → city is part of the hash tuple
//   - "Italia 4500" with zip 11400 vs zip 60000
//     → zip is part of the hash tuple
//
// Collisions we accept: two genuinely different addresses whose city,
// normalized address1, address2, and zip all agree — that shouldn't
// happen in real data, and if it does, the DAC feedback loop
// (dacAccepted=false) invalidates the cache entry.
//
// Changing this function invalidates all existing cache entries. That's
// fine — the cache rebuilds from normal traffic within hours/days, and
// correctness isn't affected (stale entries fail the dacAccepted gate
// and bypass cache).

// Prefix words that are pure noise for cache keying. Stripping collapses
// "Av. Italia" / "Avenida Italia" / "Italia" into one key. Keep the list
// conservative — only prefixes that are genuinely redundant. Do NOT add
// "don", "san", "santa" etc. — those are part of the street name.
const HASH_STRIP_PREFIXES = new Set([
  'av',
  'avda',
  'avenida',
  'bvar',
  'bulevar',
  'blvd',
  'boulevard',
  'calle',
  'camino',
  'cno',
  'pasaje',
  'pje',
  'peatonal',
  'rambla',
  'ruta',
  'general',
  'gral',
  'doctor',
  'dr',
  'plaza',
  'pza',
  'teniente',
  'tte',
  'capitan',
  'cap',
  'ing',
  'ingeniero',
  'prof',
  'profesor',
]);

// Apartment/unit trailers ONLY. Everything from here to EOL is dropped
// before hashing — it doesn't identify the building, just the unit
// inside. We explicitly do NOT strip intersection trailers
// (esq/esquina/casi/entre/y) because in grid cities like Atlántida the
// cross-street IS the address: "Calle 11 esquina 22" and "Calle 11
// esquina 33" are different houses. Stripping those would collide them
// in the cache and propagate wrong answers.
const HASH_STRIP_TRAILER =
  /(^|\s+)(apto|apt|dpto|depto|piso|bis|unidad|of|oficina|local)\b.*$/i;

function normalizeAddressForHash(s: string | null | undefined): string {
  const base = (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // accents
    .replace(/['´`]/g, '') // apostrophes ("o'higgins" → "ohiggins")
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';

  // Drop apto/piso/esq/etc. trailers (keep house number, lose unit info).
  const noTrailer = base.replace(HASH_STRIP_TRAILER, '').trim();

  // Strip leading prefix words recursively (handles "Av. Gral Flores" →
  // "flores"). Cap at 3 iterations so a pathological all-prefix string
  // can't loop forever.
  const words = noTrailer.split(' ').filter(Boolean);
  for (let i = 0; i < 3 && words.length > 1; i++) {
    if (HASH_STRIP_PREFIXES.has(words[0])) {
      words.shift();
    } else {
      break;
    }
  }
  return words.join(' ');
}

function normalizeForHash(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize a free-form `province` input to one of our 19 DAC canonical
 * department names, or empty string if we cannot recognize it. Handles
 * accent folding ("Paysandú" → "Paysandu"), case, and a few common
 * spelling variations ("San José" → "San Jose"). Returns '' (not null)
 * so callers can compare with `===` without worrying about nullish.
 */
function normalizeInputDept(raw: string | null | undefined): string {
  if (!raw) return '';
  const n = (raw ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (!n) return '';
  for (const dept of VALID_DEPARTMENTS) {
    if (dept.toLowerCase() === n) return dept;
  }
  // Common aliases seen in Shopify input
  const aliases: Record<string, (typeof VALID_DEPARTMENTS)[number]> = {
    'san jose': 'San Jose',
    'rio negro': 'Rio Negro',
    'treinta y tres': 'Treinta y Tres',
    'cerro largo': 'Cerro Largo',
  };
  return aliases[n] ?? '';
}

/**
 * H-1 (2026-04-21 audit): cache-key version tag.
 *
 * Every entry in AddressResolution is keyed by `hashAddressInput(input)`. If
 * we change the hashing dictionary (HASH_STRIP_PREFIXES, HASH_STRIP_TRAILER,
 * the MVD_STREET_RANGES used by the resolver, or any of the canonicalization
 * rules), old cache entries silently map the SAME physical address to a hash
 * the new code would never generate — and worse, they may map DIFFERENT
 * physical addresses to a hash the new code uses for something else.
 *
 * Bumping DICT_VERSION invalidates every prior cache entry in one step (new
 * code can't collide with old hashes). The cache rebuilds naturally from
 * traffic; correctness during the transition is preserved because the
 * dacAccepted feedback loop filters stale answers anyway.
 *
 * Bump this integer whenever you change:
 *   - HASH_STRIP_PREFIXES / HASH_STRIP_TRAILER
 *   - normalizeAddressForHash / normalizeForHash / normalizeInputDept
 *   - the set of fields included in the hash tuple below
 */
const DICT_VERSION = 2;

/**
 * H-2 (2026-04-21 audit): TTL for AddressResolution cache entries.
 *
 * 90 days is long enough that real traffic patterns keep the cache warm
 * (90% of a customer's subsequent orders arrive within ~40 days) and short
 * enough that when we update MVD_STREET_RANGES, CITY_TO_DEPARTMENT, or DAC's
 * department boundaries, the cache self-heals within a quarter — no manual
 * flush needed. Stale-but-DAC-accepted entries are the failure mode this
 * bounds; the dacAccepted=false gate already handles outright-bad entries.
 *
 * Exported for use in a cleanup sweeper.
 */
export const ADDRESS_RESOLUTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** H-2: derive the expiry timestamp for a newly-written/updated cache row. */
export function computeAddressResolutionExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + ADDRESS_RESOLUTION_TTL_MS);
}

export function hashAddressInput(input: AIResolverInput): string {
  // H-1: `p` (province) is part of the tuple. Previously "Italia 4500,
  // Montevideo" and "Italia 4500, Paysandú" (if the 'city' slot happened to
  // contain "Italia 4500" for both) could collide. We fold via
  // normalizeInputDept so "paysandu", "Paysandú", and "Paysandu " all hash
  // the same; unknown/empty province hashes to '' so pre-H-1 callers that
  // don't pass province still get a consistent key (distinct from any
  // valid-province key because '' !== 'Montevideo' etc.).
  const normalized = JSON.stringify({
    v: DICT_VERSION,
    p: normalizeInputDept(input.province),
    c: normalizeForHash(input.city),
    a1: normalizeAddressForHash(input.address1),
    a2: normalizeAddressForHash(input.address2),
    z: (input.zip ?? '').trim(),
  });
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// ───────────────────────────────────────────────────────────────────────────
// Customer-recurrence shortcut (Tier 3)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Match today's address against a customer's prior-shipment history.
 *
 * Intent:
 *   A returning customer ordering from "Rambla O'Higgins 14500" when they
 *   already received shipments at "Rambla O'Higgins 14000" is almost
 *   certainly shipping to the same destination (same building or block).
 *   The AI sometimes gets confused by borderline geography ("14500 is on the
 *   Punta Gorda / Carrasco line") and picks the wrong barrio; the customer
 *   pattern cuts through that ambiguity.
 *
 * We match on two tiers:
 *   - EXACT: same normalized street, same house number → confidence 'high'
 *   - NEAR:  same normalized street, number within ±MAX_DIFF → 'medium'
 *
 * Street comparison is lenient-accurate: `parseMvdAddress` strips
 * case, accents, apostrophes, and street-type prefixes ("Av.", "Rambla",
 * "Bulevar", etc.), so variants like "Av. Italia 4500" and "italia 4500"
 * collide as intended. Number drift ≤ MAX_DIFF covers typo variants
 * ("4500" vs "4501") and legitimately-same-block drift (a customer ordering
 * alternately from their home at 4500 and their office at 4520).
 *
 * Returns null when:
 *   - no prior shipments
 *   - current address cannot be parsed (no street / no number)
 *   - no prior shipment shares a street with today's address
 *   - the closest same-street match differs by > MAX_DIFF
 */
export function resolveByCustomerRecurrence(
  input: AIResolverInput,
  priorShipments: ReadonlyArray<{
    department: string;
    city: string;
    deliveryAddress: string;
  }>,
  hash: string,
): AIResolverResult | null {
  if (priorShipments.length === 0) return null;
  const current = parseMvdAddress(input.address1);
  if (!current) return null;

  // Tolerance for house-number drift. 2000 is a compromise: it catches
  // legitimate same-block variation (a customer ordering from home and
  // office a few houses apart) without collapsing genuinely-different
  // addresses on a long avenue. Av. Italia 4500 vs 6000 = different barrios.
  const MAX_DIFF = 2000;

  let best: {
    prior: (typeof priorShipments)[number];
    parsed: { street: string; number: number };
    delta: number;
  } | null = null;

  for (const p of priorShipments) {
    const parsed = parseMvdAddress(p.deliveryAddress);
    if (!parsed) continue;
    if (parsed.street !== current.street) continue;
    const delta = Math.abs(parsed.number - current.number);
    if (delta > MAX_DIFF) continue;
    if (!best || delta < best.delta) {
      best = { prior: p, parsed, delta };
    }
  }
  if (!best) return null;

  const dept = best.prior.department;
  // Derive barrio for MVD from the NEW address (not the prior). MVD_STREET_RANGES
  // is the single source of truth — using the prior's address would be circular
  // and couldn't handle the case where the customer moves one block and the new
  // number falls in a different barrio range.
  let barrio: string | null = null;
  if (dept === 'Montevideo') {
    const hit = mvdBarrioFromStreet(input.address1);
    if (hit) barrio = hit.barrio;
  }

  // confidence: exact number match = 'high' (same physical address);
  // near match = 'medium' (same block, probably same destination but not
  // guaranteed). We never return 'low' from here — if the signal is that
  // weak we'd have returned null already.
  const confidence: 'high' | 'medium' = best.delta === 0 ? 'high' : 'medium';

  logger.info(
    {
      hash,
      tenantId: input.tenantId,
      dept,
      barrio,
      priorAddress: best.prior.deliveryAddress,
      currentAddress: input.address1,
      delta: best.delta,
      priorCount: priorShipments.length,
      confidence,
    },
    'AI resolver customer-recurrence shortcut — no AI invocation needed',
  );

  return {
    barrio,
    // MVD orders always ship with city="Montevideo" (DAC uses barrio as the
    // finer-grained field). For the interior, trust the prior's city —
    // DAC has already canonicalized it on the prior successful shipment.
    city: dept === 'Montevideo' ? 'Montevideo' : best.prior.city,
    department: dept,
    deliveryAddress: '',
    extraObservations: '',
    confidence,
    reasoning:
      best.delta === 0
        ? `customer-recurrence: exact match with prior shipment "${best.prior.deliveryAddress}"`
        : `customer-recurrence: same street as "${best.prior.deliveryAddress}", number drift ${best.delta} ≤ ${MAX_DIFF}`,
    source: 'deterministic',
    inputHash: hash,
    aiCostUsd: 0,
    webSearchRequests: 0,
    priorShipmentsUsed: priorShipments.length,
  };
}

// Exported for unit tests only — do not use at call sites.
export const _testing = { normalizeAddressForHash };

// ───────────────────────────────────────────────────────────────────────────
// System prompt + tool definition
// ───────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sos un experto en geografia uruguaya y direcciones postales. Tu tarea es resolver direcciones ambiguas de pedidos de e-commerce para que un sistema de logistica (DAC Uruguay) las pueda procesar automaticamente.

REGLAS ESTRICTAS:
1. Respondes SOLO con la tool "resolve_address". Nada de texto libre.
2. El department DEBE ser uno de estos 19 exactos: Montevideo, Canelones, Maldonado, Rocha, Colonia, San Jose, Florida, Durazno, Flores, Lavalleja, Treinta y Tres, Cerro Largo, Rivera, Artigas, Salto, Paysandu, Rio Negro, Soriano, Tacuarembo.
3. Si department es Montevideo, barrio DEBE ser uno de los 58 barrios oficiales que te doy en la lista del mensaje del usuario. Si no podes determinar el barrio con certeza, devolve null y confidence="low".
4. Si department NO es Montevideo, barrio DEBE ser null.
5. deliveryAddress contiene SOLO calle + numero de puerta. Nada mas. Sin telefonos, sin apartamentos, sin referencias, sin "casa azul", sin horarios.
6. extraObservations contiene TODO lo demas: apto, piso, instrucciones, referencias, codigos de entrada, horarios.
7. "Puerta X" en direcciones uruguayas es un codigo de entrada, NO un numero de apartamento. Va a extraObservations tal cual ("Puerta 3"), no al deliveryAddress.
8. "Apto X", "Ap X", "Dpto X", "Depto X" = apartamento. Normalizar siempre a "Apto X" en extraObservations.
9. Si address2 contiene un telefono (8+ digitos seguidos), descartarlo. El telefono ya esta en otro campo.
10. Si address2 contiene solo el nombre de una ciudad o departamento ya mencionado, descartarlo.
11. Si la direccion es una descripcion sin calle/numero ("al lado del super el dorado", "casa amarilla frente al kiosco"), setear confidence="low" y poner la descripcion entera en extraObservations. En deliveryAddress poner lo mejor posible (nombre del lugar o calle cercana) o "S/N" si no hay nada.
12. Si falta el numero de puerta, usar "S/N" al final del deliveryAddress.
13. En reasoning explicar en 1-2 oraciones cortas por que decidiste asi. Sirve para auditoria.
14. ANTES de rendirte: usá la tool web_search. Una consulta tipo '"<nombre calle>" "<ciudad o barrio>" Uruguay' casi siempre te da el barrio/departamento correcto (OSM, Google Maps, Mercadolibre, paginas amarillas locales). NO INVENTES datos, pero TAMPOCO te rindas antes de intentar buscar. Solo despues de haber buscado con web_search y seguir sin certeza — usá confidence="low" y explicá en reasoning QUE buscaste y por que igual no pudiste resolver. confidence="low" sin haber intentado web_search antes es ERROR tuyo.
14b. INTERPRETACION DE RESULTADOS DE WEB_SEARCH: los resultados te dan la UBICACION de la calle (ej: "Calle Ellauri está en el barrio Punta Carretas, Montevideo"). Tu trabajo es MAPEAR esa ubicacion al barrio CORRECTO de la lista oficial de 58 barrios. NUNCA devuelvas el nombre de la calle como barrio — "Ellauri" es una calle, "Punta Carretas" es el barrio. Si el resultado de web_search menciona un barrio que NO esta en la lista oficial (ej: web_search dice "Villa Biarritz" pero esa no esta en la lista), elegi el barrio OFICIAL mas cercano de la lista (en ese ejemplo "punta carretas") y pone confidence="medium" con reasoning que explique la correspondencia. Nunca inventes barrios fuera de la lista.
15. HISTORIAL DEL CLIENTE: son envios PREVIOS del mismo cliente, NO necesariamente su residencia. Si la direccion actual coincide o es consistente con el historial (misma calle, mismo barrio, mismo department) es evidencia FUERTE de que este pedido va al mismo lugar → confidence="high". Si la direccion actual CLARAMENTE apunta a otro lado (otra ciudad, otra calle, otro barrio, otro department), DESCARTA el historial — el cliente pudo haberse mudado, puede estar mandando un regalo, o puede estar comprando para otra persona. La direccion actual SIEMPRE gana sobre el historial cuando hay contradiccion clara. Usa el historial como TIEBREAKER, no como override.
16. customerPhone NO es señal del destino. Es el contacto del cliente, no la ubicacion del envio. Un cliente en Montevideo puede mandar un regalo a Salto; una empresa puede enviar a cualquier departamento. No pases el telefono por un filtro geografico. Si address2 u orderNotes contienen un numero telefonico, descartalo (regla 9). NUNCA dejes que el prefijo del customerPhone influya en el department/barrio del envio.
17a. PRIORIDAD DEL CAMPO address2/address1 POR SOBRE city CUANDO HAY CONTRADICCION:
    El campo "city" en Shopify muchas veces viene mal llenado (cliente puso "Montevideo" por default aunque vive en el interior). Si:
    - city="Montevideo" (o similar), Y
    - address1 o address2 contiene claramente un nombre de ciudad/localidad reconocible de OTRO departamento (ej: "Tacuarembó", "Paysandú", "Salto", "Rivera", "Melo", "Minas", "Durazno", "Florida", "Trinidad", "Colonia", "Mercedes", "Fray Bentos", "Young", "Maldonado", "Punta del Este", "San José", "Rocha", "La Paloma", "Treinta y Tres", etc.)
    → el department CORRECTO es el de esa ciudad del interior, NO Montevideo.
    Capitales departamentales para disambiguar:
    - Artigas=Artigas, Canelones=Canelones, Cerro Largo=Melo, Colonia=Colonia del Sacramento, Durazno=Durazno, Flores=Trinidad, Florida=Florida, Lavalleja=Minas, Maldonado=Maldonado, Paysandú=Paysandú, Río Negro=Fray Bentos, Rivera=Rivera, Rocha=Rocha, Salto=Salto, San José=San José de Mayo, Soriano=Mercedes, Tacuarembó=Tacuarembó, Treinta y Tres=Treinta y Tres.
    Ciudades grandes NO-capital que también son fuertes señales: Young (Río Negro), Juan Lacaze y Carmelo (Colonia), Dolores y Nueva Palmira (Soriano), Bella Unión (Artigas), Paso de los Toros (Tacuarembó), Chuy (Rocha), Piriápolis y San Carlos (Maldonado).
    Si ves cualquiera de estos nombres claramente en address1/address2, PRIORIZA el department correcto sobre lo que diga el campo city.

17. NOMBRES AMBIGUOS ENTRE DEPARTAMENTOS: varios nombres de ciudad/pueblo/barrio existen en 2+ departamentos de Uruguay. Casos reales confirmados (no exhaustivo):
    - "Las Piedras" = Canelones (ciudad grande, muy comun) O Artigas (pueblito chico). Casi siempre Canelones salvo que address1/ZIP indique claramente Artigas.
    - "Toledo" = Canelones (conocida) O Cerro Largo (pueblito). Casi siempre Canelones.
    - "Santa Catalina" = barrio de Montevideo O pueblo en Soriano.
    - "La Paz" = Canelones (conocida) O Colonia (pueblo chico).
    - "Ituzaingo" = barrio de Montevideo O localidad de San Jose.
    - "La Paloma" = Rocha (balneario famoso) O Durazno (pueblito). Casi siempre Rocha.
    - "Cerro Chato" = Durazno, Florida, Paysandu, O Treinta y Tres (4 departamentos).
    - "San Antonio" = Canelones, Rocha, O Salto.
    - "Barros Blancos" = Canelones (comun).
    - "Las Toscas" = Canelones (balneario Costa de Oro) O Tacuarembo.
    - "Bella Vista" = Maldonado O Paysandu.
    - "Agraciada" = Colonia O Soriano.
    Cuando veas uno de estos: (a) usa el ZIP como desempate (ver la REGLA HARD SOBRE ZIP arriba — la tabla completa cubre los 19 departamentos); (b) si el ZIP no ayuda, prioriza la version mas grande/conocida; (c) si la province de Shopify contradice la city de forma OBVIA (ej: city="San Jose", province="Montevideo"), casi siempre la city es correcta y la province es typo del cliente — VERIFICA con web_search antes de decidir; (d) si despues de todo lo anterior sigue ambiguo, usa web_search con '"<nombre>" "<calle>" Uruguay' para resolver.

ABREVIATURAS URUGUAYAS COMUNES:
- "Rbla" / "Rmbla" = Rambla (expandir a "Rambla")
- "Av" / "Avda" = Avenida (expandir a "Avenida")
- "Cno" = Camino (expandir a "Camino")
- "Bvar" / "Bvard" = Bulevar (expandir a "Bulevar")
- "Gral" = General
- "Dr" = Doctor
- "Cnel" = Coronel
- "Pta" = Punta

REGLA HARD SOBRE ZIP CODE (máxima prioridad):
Uruguay usa CPs de 5 dígitos. Los PRIMEROS DOS dígitos determinan el department con ALTA CONFIABILIDAD. Si el ZIP está presente y es válido (5 dígitos numéricos), el department SE DETERMINA por el prefijo — NUNCA lo override con city="Montevideo" (el cliente suele ponerlo por default en Shopify) ni con web_search.

Tabla OFICIAL de prefijos → department (Correo Uruguayo, confirmada contra 30 envíos reales en producción):
- 11 → Montevideo
- 15 → Canelones (este: Pando, Las Piedras, Las Toscas, Neptunia, Cuchilla Alta)
- 20 → Maldonado (Maldonado, Punta del Este, San Carlos, Piriápolis, Portezuelo)
- 27 → Rocha (Rocha, Chuy, La Paloma, Castillos)
- 30 → Lavalleja (Minas, José Batlle y Ordóñez)
- 33 → Treinta y Tres
- 37 → Cerro Largo (Melo, Río Branco)
- 40 → Rivera (Rivera, Tranqueras, Vichadero)
- 45 → Tacuarembó (Tacuarembó, Paso de los Toros)
- 50 → Salto (Salto, Constitución, Belén)
- 55 → Artigas (Artigas, Bella Unión)
- 60 → Paysandú (Paysandú, Guichón)
- 65 → Rio Negro (Fray Bentos, Young)
- 70 → Colonia (Colonia del Sacramento, Carmelo, Juan Lacaze)
- 75 → Soriano (Mercedes, Dolores, Cardona, Palmitas)
- 80 → San José (San José de Mayo, Libertad, Ciudad del Plata)
- 85 → Flores (Trinidad)
- 90/91 → Canelones (Ciudad de la Costa, Solymar, Lagomar, Atlántida, Canelones capital)
- 94 → Florida (Florida, Sarandí Grande)
- 97 → Durazno (Durazno, Sarandí del Yí)

Si ZIP existe y su prefijo está en esta tabla: USALO COMO department. Solo ignoralo si el ZIP es claramente corrupto (p.ej. "00000", "12345" genérico, menos de 5 dígitos).

CONTEXTO GEOGRAFICO CLAVE:
- 18 de Julio es la avenida principal de Montevideo Centro
- La Rambla bordea todo Montevideo (barrios Pocitos, Buceo, Malvin, Punta Gorda, Carrasco)
- "Ciudad de la Costa" pertenece a Canelones, no Montevideo
- Si la city dice "Pueblo X" o "Villa X", X suele ser el nombre del pueblo/barrio real
- "Juan Lacaze" es una ciudad en Colonia
- "Young" es una ciudad en Rio Negro
- "Minas" es la capital de Lavalleja

LOCALIDADES DE CANELONES (NO son barrios de Montevideo — NUNCA las clasifiques como Montevideo):
- Costa de Oro (este-oeste): Barra de Carrasco, Paso Carrasco, Shangrila, Lagomar, Solymar, El Pinar, Neptunia, Salinas, Marindia, Pinamar, San Luis, Parque del Plata, Las Toscas, Atlantida, Las Vegas, La Floresta, Cuchilla Alta
- Interior Canelones: Ciudad de la Costa, Pando, Las Piedras, La Paz, Progreso, Barros Blancos, Joaquin Suarez, Toledo, Sauce, Canelones (capital), Santa Lucia, Las Toscas, Empalme Olmos, Tala, San Ramon, San Bautista, Migues
Si ves cualquiera de estas palabras en address1/address2/city, department es "Canelones" y barrio es null.

LOCALIDADES DE SAN JOSE (NO son Montevideo):
- Ciudad del Plata, Delta del Tigre, Playa Pascual, Rincon de la Bolsa, Libertad, Rodriguez, Ecilda Paullier, Mal Abrigo, San Jose de Mayo
Si ves estas palabras, department es "San Jose".

LOCALIDADES DE MALDONADO (NO son Montevideo):
- Punta del Este, Maldonado, San Carlos, Piriapolis, Pan de Azucar, Aigua, Punta Ballena, La Barra, Manantiales, Jose Ignacio
Si ves estas palabras, department es "Maldonado".

IMPORTANTE: si la dirección contiene el nombre de una localidad NO-Montevideo (de las listas de arriba) y VOS dudás, es MUCHO mejor clasificarla por su department real con barrio=null que forzar un barrio de Montevideo inventado. Un barrio inventado hace que DAC rechace el envío entero.

CALLES FAMOSAS DE MONTEVIDEO → BARRIO (usar directamente, confidence="high", sin web_search):
- "18 de Julio" (avenida): tramo 900-1500 = centro; 1500-2200 = cordon. Default = centro (tramo mas conocido y largo).
- "Colonia" (calle): tramo 1000-1800 = centro; tramo mas alto = cordon. Default = centro.
- "Rivera" (avenida): atraviesa Pocitos, Punta Carretas, Buceo, Malvin, Punta Gorda, Carrasco. Usar numero de puerta para decidir (ver tramos en web_search si dudas).
- "Av. Brasil" / "Avenida Brasil" = pocitos (atraviesa pocitos nuevo tambien, pero default pocitos).
- "Av. Italia" / "Avenida Italia": 0-2500 = tres cruces/la blanqueada; 2500-5000 = buceo/malvin; 5000+ = malvin norte/carrasco norte. Si dudas, web_search.
- "Ellauri" (Jose Ellauri) = punta carretas.
- "Sarandi" (calle peatonal) = ciudad vieja.
- "Bacacay" = ciudad vieja.
- "Buenos Aires" (calle) = ciudad vieja.
- "Perez Castellano" = ciudad vieja.
- "Solis" = ciudad vieja.
- "Gonzalo Ramirez" = cordon (principalmente) o parque rodo.
- "Constituyente" = cordon / centro.
- "Canelones" (calle en MVD) = centro / cordon.
- "Mercedes" (calle) = centro / cordon.
- "Uruguay" (calle) = centro.
- "San Jose" (calle en MVD) = centro.
- "Rambla Gandhi" = punta carretas.
- "Rambla Pte. Wilson" = pocitos.
- "Rambla Rep. del Peru" = pocitos.
- "Rambla Armenia" = malvin.
- "Rambla O'Higgins" = buceo / malvin.
- "Propios" (avenida) = atraviesa jacinto vera/larrañaga/la blanqueada. Usar tramo.
- "Garibaldi" (avenida) = la figurita / jacinto vera / la comercial.
- "8 de Octubre" (avenida) = la blanqueada / union / flor de maronas. Usar tramo.
- "Millan" (avenida) = prado / paso de las duranas / sayago. Usar tramo.
- "Agraciada" (avenida) = aguada / reducto / belvedere. Usar tramo.
- "Luis Alberto de Herrera" (avenida) = tres cruces / parque batlle / buceo. Usar tramo.
- "Bulevar Artigas" = atraviesa parque rodo/pocitos/tres cruces/parque batlle. Usar tramo.

BARRIOS VALIDOS DE MONTEVIDEO (58 total):
Si department es "Montevideo", barrio DEBE ser EXACTAMENTE uno de estos (en lowercase):
${VALID_MVD_BARRIOS.join(', ')}

Si no podes determinar el barrio con certeza de esta lista exacta, devolve barrio=null y confidence="low". NUNCA devuelvas un nombre de calle como barrio. NUNCA inventes barrios que no estan en la lista.

CIUDADES VALIDAS DE DAC (dropdown oficial del sistema de envios):
Para department != "Montevideo", el campo "city" DEBE coincidir EXACTAMENTE (o muy cerca, sin acentos) con una de las ciudades listadas debajo para ese department. Si la direccion menciona un balneario, barrio, o localidad que NO esta en la lista del department correspondiente, elegi la ciudad/cabecera mas cercana que SI este en la lista (normalmente la capital departamental o la ciudad cabecera de zona) y explicalo en reasoning. Para Montevideo el campo city es siempre "Montevideo".
${DAC_CITIES_PROMPT_BLOCK}`;

const ADDRESS_RESOLVER_TOOL: Anthropic.Tool = {
  name: 'resolve_address',
  description:
    'Resuelve una direccion uruguaya ambigua en campos estructurados que DAC Uruguay pueda procesar.',
  input_schema: {
    type: 'object',
    properties: {
      barrio: {
        type: ['string', 'null'] as any,
        description:
          'Barrio de Montevideo (solo si department es Montevideo). Debe ser uno exacto de la lista de 58 barrios. null si no es Montevideo o no se puede determinar.',
      },
      city: {
        type: 'string',
        description:
          'Ciudad/localidad normalizada. Para Montevideo es siempre "Montevideo". Para el resto DEBE ser una de las ciudades de la lista "CIUDADES VALIDAS DE DAC" del system prompt correspondiente al department elegido (sin acentos, con la capitalizacion de la lista). Si la direccion real es un balneario/pueblito que NO aparece en la lista para ese department, elegi la ciudad/cabecera mas cercana que SI este en la lista y explica en reasoning.',
      },
      department: {
        type: 'string',
        enum: [...VALID_DEPARTMENTS],
        description: 'Departamento de Uruguay. Uno de los 19 oficiales exacto.',
      },
      deliveryAddress: {
        type: 'string',
        description:
          'Solo calle + numero de puerta. Sin apartamento, sin piso, sin referencias, sin telefonos, sin horarios. Si falta el numero, terminar con "S/N".',
      },
      extraObservations: {
        type: 'string',
        description:
          'Toda la info extra: apto, piso, "Puerta X", referencias, instrucciones de entrega, codigos. String vacio si no hay nada.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          'Tu certeza sobre esta resolucion. high si todos los campos estan claros, medium si hiciste alguna inferencia razonable, low si la direccion es muy ambigua.',
      },
      reasoning: {
        type: 'string',
        description:
          'Explicacion corta (1-2 oraciones) de como llegaste a esta resolucion. Sirve para auditoria.',
      },
    },
    required: [
      'barrio',
      'city',
      'department',
      'deliveryAddress',
      'extraObservations',
      'confidence',
      'reasoning',
    ],
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Main entry point
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resolve an ambiguous address with AI fallback.
 * Returns null if AI is disabled, quota exceeded, API key missing, or call failed.
 * Callers should fall back to deterministic rules when null is returned.
 */
export async function resolveAddressWithAI(
  input: AIResolverInput,
): Promise<AIResolverResult | null> {
  const hash = hashAddressInput(input);

  // 0. Deterministic-first shortcut — the fast path.
  //
  // Most real orders have ONE strong, unambiguous signal that pins down the
  // department: the ZIP prefix, a capital-city name in address2, or a major
  // interior city like "Punta del Este" or "Young". When we catch that
  // signal AND the target is NOT Montevideo, we can resolve the whole
  // address without ever invoking Claude — saving ~$0.002 per call and ~2s
  // of latency.
  //
  // Why we skip Montevideo here: MVD uses a 58-option barrio dropdown, and
  // picking the right barrio from a street + number is genuinely hard for
  // rules. The existing AI path (with its prompt + web_search fallback)
  // does a good job on that. So for MVD we keep the legacy flow intact.
  //
  // Why we skip cache write for deterministic hits: recomputing rules is
  // free. Writing cache rows for every deterministic hit would bloat the
  // AddressResolution table without reducing future cost. The cache remains
  // useful for AI-resolved rows (which are expensive to recompute).
  try {
    const deptRes = resolveDepartmentDeterministic({
      city: input.city,
      address1: input.address1,
      address2: input.address2 ?? '',
      zip: input.zip,
      province: input.province,
      orderNotes: input.orderNotes,
    });

    // ─── MVD barrio shortcut (Tier 2) ───────────────────────────────────
    //
    // When the department is clearly Montevideo AND the address1 matches a
    // hand-curated street-range in MVD_STREET_RANGES, answer
    // deterministically with the barrio. Skips Nominatim + AI entirely.
    //
    // We gate on confidence='high' (city-exact-mvd or zip prefix) so we
    // never apply the shortcut on weak dept signals like province alone.
    // On miss, we fall through to the normal flow — the lookup is free
    // and failure is indistinguishable from the current behavior.
    if (
      deptRes &&
      deptRes.department === 'Montevideo' &&
      deptRes.confidence === 'high'
    ) {
      const barrioHit = mvdBarrioFromStreet(input.address1);
      if (barrioHit) {
        logger.info(
          {
            hash,
            tenantId: input.tenantId,
            dept: 'Montevideo',
            barrio: barrioHit.barrio,
            matchedStreet: barrioHit.matchedStreet,
            number: barrioHit.number,
            rangeNote: barrioHit.note,
            deptVia: deptRes.matchedVia,
          },
          'AI resolver MVD barrio shortcut — no AI invocation needed',
        );
        return {
          barrio: barrioHit.barrio,
          // city is always "Montevideo" for MVD orders — the DAC form only
          // cares about barrio inside MVD.
          city: 'Montevideo',
          department: 'Montevideo',
          deliveryAddress: '',
          extraObservations: '',
          // High: every range in MVD_STREET_RANGES is hand-verified
          // against the canonical fixture address it serves. A hit means
          // the address is well inside a known barrio interval, not on a
          // fuzzy boundary. The operator can still override via the DAC
          // form before printing if the edge case slipped through.
          confidence: 'high',
          reasoning: `determ MVD: "${barrioHit.matchedStreet}" #${barrioHit.number} → ${barrioHit.barrio}${barrioHit.note ? ` (${barrioHit.note})` : ''}`,
          source: 'deterministic',
          inputHash: hash,
          aiCostUsd: 0,
          webSearchRequests: 0,
          priorShipmentsUsed: 0,
        };
      }
    }

    // ─── MVD shortcut via explicit province (Tier 2 follow-up) ──────────
    //
    // When city is ambiguous (e.g. "Santa Catalina" exists in both Soriano
    // and as an MVD peripheral zona) or empty but `province="Montevideo"`
    // is explicitly set by the customer, the dept resolver returns
    // Montevideo with matchedVia='province' / confidence='medium'. We
    // bypass the AI in two steps:
    //   1. Try the MVD street-range barrio lookup first (e.g. H04's
    //      "Rambla Tomás Berreta 8000" resolves to Carrasco). Confidence
    //      stays 'medium' because the dept signal came from province —
    //      without city confirmation we can't claim 'high'.
    //   2. Fall back to dept-only if no barrio match (e.g. L07's "Camino
    //      Colman" in a peripheral zona). Operator fills the barrio in
    //      two seconds from the DAC dropdown.
    // Both beat the alternative (AI ignoring province and guessing a
    // different dept from street-name heuristics).
    if (
      deptRes &&
      deptRes.department === 'Montevideo' &&
      deptRes.matchedVia === 'province'
    ) {
      const barrioHit = mvdBarrioFromStreet(input.address1);
      if (barrioHit) {
        logger.info(
          {
            hash,
            tenantId: input.tenantId,
            dept: 'Montevideo',
            barrio: barrioHit.barrio,
            matchedStreet: barrioHit.matchedStreet,
            number: barrioHit.number,
            rangeNote: barrioHit.note,
            deptVia: deptRes.matchedVia,
          },
          'AI resolver MVD barrio shortcut (via province) — no AI invocation needed',
        );
        return {
          barrio: barrioHit.barrio,
          city: 'Montevideo',
          department: 'Montevideo',
          deliveryAddress: '',
          extraObservations: '',
          // Medium: street-range is hand-verified, but dept came from
          // province (medium) not a canonical city signal. Downgrading
          // to match the weakest link keeps the contract honest.
          confidence: 'medium',
          reasoning: `determ MVD (via province): "${barrioHit.matchedStreet}" #${barrioHit.number} → ${barrioHit.barrio}${barrioHit.note ? ` (${barrioHit.note})` : ''}`,
          source: 'deterministic',
          inputHash: hash,
          aiCostUsd: 0,
          webSearchRequests: 0,
          priorShipmentsUsed: 0,
        };
      }
      logger.info(
        {
          hash,
          tenantId: input.tenantId,
          dept: 'Montevideo',
          deptReason: deptRes.reason,
          deptVia: deptRes.matchedVia,
        },
        'AI resolver MVD dept-only shortcut (explicit province) — no AI invocation needed',
      );
      return {
        barrio: null,
        city: 'Montevideo',
        department: 'Montevideo',
        deliveryAddress: '',
        extraObservations: '',
        confidence: deptRes.confidence,
        reasoning: `determ MVD (dept-only, province): ${deptRes.reason}`,
        source: 'deterministic',
        inputHash: hash,
        aiCostUsd: 0,
        webSearchRequests: 0,
        priorShipmentsUsed: 0,
      };
    }

    // Gate: high confidence OR address2-tiebreaker (which is legitimately
    // medium confidence but still deterministic enough to beat AI guessing).
    // Without the tiebreaker carve-out, Shopify-autofilled `city=Montevideo`
    // orders whose real locality lives in address2 (e.g. "La Paz" meaning
    // Canelones) fall through to the AI and get mis-routed to Montevideo.
    if (
      deptRes &&
      deptRes.department !== 'Montevideo' &&
      (deptRes.confidence === 'high' ||
        deptRes.matchedVia === 'address2-tiebreaker')
    ) {
      const cityRes = resolveCityDeterministic(deptRes.department, {
        city: input.city,
        address1: input.address1,
        address2: input.address2 ?? '',
        orderNotes: input.orderNotes,
      });

      if (cityRes) {
        logger.info(
          {
            hash,
            tenantId: input.tenantId,
            dept: deptRes.department,
            city: cityRes.city,
            deptReason: deptRes.reason,
            deptVia: deptRes.matchedVia,
            cityReason: cityRes.reason,
            cityVia: cityRes.matchedVia,
          },
          'AI resolver deterministic shortcut — no AI invocation needed',
        );
        return {
          // Non-Montevideo shipments don't use barrio.
          barrio: null,
          city: cityRes.city,
          department: deptRes.department,
          // Leaving deliveryAddress empty signals the caller (shipment.ts) to
          // keep whatever mergeAddress() already produced. The caller only
          // overwrites fullAddress when aiResolution.deliveryAddress is
          // non-empty (see shipment.ts:1102).
          deliveryAddress: '',
          extraObservations: '',
          confidence: 'high',
          reasoning: `determ: ${deptRes.reason}; ${cityRes.reason}`,
          source: 'deterministic',
          inputHash: hash,
          aiCostUsd: 0,
          webSearchRequests: 0,
          priorShipmentsUsed: 0,
        };
      }
      // dept was decided but city wasn't. If the dept signal is strong enough
      // to trust by itself — ZIP prefix or an explicit capital/major-city
      // match inside address2/orderNotes — we short-circuit with an empty
      // city rather than letting the AI override our dept.
      //
      // Why: Shopify customers commonly leave city="Montevideo" on autofill
      // even when the ZIP or address2 clearly says "Canelones". When the AI
      // sees city="Montevideo" as the dominant signal, it ignores the ZIP
      // (regression category I01/I02/I05/I08 in the fixture suite). Since UY
      // ZIP prefixes are very reliable (11xx=MVD, 90xx=Canelones coast, etc.)
      // and address2 mentions of a capital like "Tacuarembó" are essentially
      // unambiguous, we commit to the deterministic dept and let the
      // operator pick the DAC canonical city from the dropdown. Wrong dept →
      // package ships to the wrong department (costly); empty city with
      // right dept → operator picks in two seconds (cheap).
      const deptViaIsAuthoritative =
        deptRes.matchedVia === 'zip' ||
        deptRes.matchedVia === 'address-capital' ||
        deptRes.matchedVia === 'address-major-city' ||
        deptRes.matchedVia === 'address2-tiebreaker';
      if (deptViaIsAuthoritative) {
        logger.info(
          {
            hash,
            tenantId: input.tenantId,
            dept: deptRes.department,
            deptReason: deptRes.reason,
            deptVia: deptRes.matchedVia,
          },
          'AI resolver deterministic shortcut — dept authoritative, city deferred to operator',
        );
        return {
          barrio: null,
          city: '',
          department: deptRes.department,
          deliveryAddress: '',
          extraObservations: '',
          confidence: deptRes.confidence,
          reasoning: `determ (dept-only): ${deptRes.reason}`,
          source: 'deterministic',
          inputHash: hash,
          aiCostUsd: 0,
          webSearchRequests: 0,
          priorShipmentsUsed: 0,
        };
      }
    }
  } catch (err) {
    // Never let the shortcut throw — always degrade to the legacy AI path.
    logger.debug(
      { hash, error: (err as Error).message },
      'Deterministic shortcut threw — falling through to AI',
    );
  }

  // 1. Cache lookup — accept if no feedback yet or feedback was positive
  //    AND the entry has not passed its TTL (H-2, 2026-04-21 audit).
  //    Expired rows are left in place; the sweeper deletes them asynchronously
  //    (see cleanupExpiredAddressResolutions below). An expired row here is
  //    treated exactly like a cache miss — we fall through to the AI path,
  //    which will rewrite the row with a fresh expiry via the upsert.
  try {
    const cached = await db.addressResolution.findUnique({
      where: { tenantId_inputHash: { tenantId: input.tenantId, inputHash: hash } },
    });
    const now = new Date();
    const notExpired = !cached?.expiresAt || cached.expiresAt > now;
    if (cached && cached.dacAccepted !== false && notExpired) {
      logger.info(
        { hash, tenantId: input.tenantId, dacAccepted: cached.dacAccepted },
        'AI resolver cache HIT',
      );
      return {
        barrio: cached.resolvedBarrio,
        city: cached.resolvedCity,
        department: cached.resolvedDepartment,
        deliveryAddress: cached.resolvedDeliveryAddress,
        extraObservations: cached.resolvedObs,
        confidence: cached.confidence.toLowerCase() as 'high' | 'medium' | 'low',
        reasoning: cached.aiReasoning ?? '(from cache)',
        source: 'cache',
        inputHash: hash,
      };
    }
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'Cache lookup failed, continuing');
  }

  // 1b. Geocoding fallback — OpenStreetMap Nominatim.
  //
  // Runs when the deterministic shortcut could not pin the department
  // (no ZIP, no capital-city name, no major-city match) and the cache is
  // cold. Free (1 req/s, shared rate limiter in geocode-fallback.ts),
  // but adds up to ~1s latency to the ~10% of calls that reach this
  // point. Worth it because this layer catches the classic "Shopify
  // autofilled city=Montevideo but the customer actually lives in the
  // interior" failure mode before we spend an AI call.
  //
  // We only trust Nominatim for NON-Montevideo results. Montevideo needs
  // a barrio pick from the 58-entry DAC list, and Nominatim's "suburb"
  // field rarely matches DAC barrios cleanly — so MVD keeps falling
  // through to the AI (which has the full barrio-to-street mapping in
  // its prompt).
  //
  // On a hit for the interior we canonicalize the Nominatim-returned
  // locality against DAC's city dropdown. If that also resolves, we
  // answer with confidence="medium" and skip the AI entirely. If only
  // the department resolves, we still commit (operator picks the city
  // in two seconds — wrong department is far costlier).
  try {
    const geo = await geocodeAddressToDepartment({
      city: input.city,
      address1: input.address1,
      address2: input.address2,
      zip: input.zip,
    });

    // ─── Post-Nominatim MVD barrio retry (Tier 2 follow-up) ─────────────
    //
    // The pre-Nominatim barrio shortcut at line ~553 only fires when the
    // deterministic dept resolver can already pin Montevideo with high
    // confidence (city-exact-mvd or ZIP). For addresses that arrive with
    // empty city/province (Shopify does this on returning customers who
    // didn't retype), the dept resolver gives up and we end up here. If
    // Nominatim confirms dept=Montevideo, retry the barrio lookup before
    // spending an AI call. Same table, same confidence rules, just a
    // different entry point.
    if (geo && geo.department === 'Montevideo') {
      const barrioHit = mvdBarrioFromStreet(input.address1);
      if (barrioHit) {
        logger.info(
          {
            hash,
            tenantId: input.tenantId,
            dept: 'Montevideo',
            barrio: barrioHit.barrio,
            matchedStreet: barrioHit.matchedStreet,
            number: barrioHit.number,
            rangeNote: barrioHit.note,
            nominatimLocality: geo.locality,
          },
          'AI resolver MVD barrio shortcut (post-nominatim) — no AI invocation needed',
        );
        return {
          barrio: barrioHit.barrio,
          city: 'Montevideo',
          department: 'Montevideo',
          deliveryAddress: '',
          extraObservations: '',
          confidence: 'high',
          reasoning: `determ MVD (post-nominatim): "${barrioHit.matchedStreet}" #${barrioHit.number} → ${barrioHit.barrio}${barrioHit.note ? ` (${barrioHit.note})` : ''}`,
          source: 'deterministic',
          inputHash: hash,
          aiCostUsd: 0,
          webSearchRequests: 0,
          priorShipmentsUsed: 0,
        };
      }
    }

    if (geo && geo.department !== 'Montevideo') {
      // ─── duplicate-city tiebreaker ───────────────────────────────────
      //
      // 34 DAC city names exist in >1 dept ("La Paz" is in Canelones AND
      // Colonia, "Las Piedras" is in Canelones AND Artigas, etc.).
      // Nominatim picks ONE of those based on search-score heuristics —
      // often the tiny pueblo when the customer almost certainly meant
      // the major city of the same name. We override ONLY when:
      //   (a) the locality is in our duplicate-city table AND
      //   (b) Nominatim's dept is NOT the preferred default AND
      //   (c) the user-provided `province` does not corroborate Nominatim
      //       (an explicit province always wins — customer's own claim).
      const provinceDept = normalizeInputDept(input.province);
      const tiebreakerLocality = geo.locality || input.city;
      let effectiveDept = geo.department;
      let tiebreakerNote = '';
      if (tiebreakerLocality && provinceDept !== geo.department) {
        const preferred = nonPreferredConflict(
          tiebreakerLocality,
          geo.department,
        );
        // Only switch if the preferred dept doesn't contradict province
        // (when province is set). When province is empty, we accept the
        // tiebreaker unconditionally — that's exactly the case it was
        // built for.
        if (
          preferred &&
          (provinceDept === '' || provinceDept === preferred)
        ) {
          effectiveDept = preferred;
          tiebreakerNote = ` [tiebreaker: "${tiebreakerLocality}" → ${preferred} over ${geo.department}]`;
          logger.info(
            {
              hash,
              tenantId: input.tenantId,
              locality: tiebreakerLocality,
              nominatimDept: geo.department,
              preferredDept: preferred,
              provinceInput: input.province,
            },
            'Nominatim dept overridden by duplicate-city tiebreaker',
          );
        }
      }

      const cityRes = resolveCityDeterministic(effectiveDept, {
        // Feed Nominatim's locality as the candidate city — it's usually
        // more accurate than Shopify's city field on the cases we reach
        // here. Address fields stay as originally provided so
        // `resolveCityDeterministic` can still scan them as a fallback.
        city: geo.locality || input.city,
        address1: input.address1,
        address2: input.address2 ?? '',
        orderNotes: input.orderNotes,
      });

      // ─── confidence scoring ──────────────────────────────────────────
      //
      // Upgrade to 'high' when we have strong agreement between
      // independent signals:
      //   1. DAC canonical city resolved via exact match (not fuzzy scan)
      //   2. AND at least one of:
      //      - user-provided province matches the final effective dept
      //      - the locality is NOT in the duplicate-city table (truly
      //        unambiguous city name)
      //
      // When both conditions hold, there is effectively zero room for
      // error: Nominatim + DAC + Shopify's province all agree, or the
      // locality is so uniquely named that confusion is impossible.
      const confidence: 'high' | 'medium' | 'low' =
        cityRes?.matchedVia === 'city-exact' &&
        (provinceDept === effectiveDept ||
          !candidateDeptsFor(tiebreakerLocality))
          ? 'high'
          : 'medium';

      if (cityRes) {
        logger.info(
          {
            hash,
            tenantId: input.tenantId,
            dept: effectiveDept,
            city: cityRes.city,
            nominatimLocality: geo.locality,
            nominatimDept: geo.department,
            tiebreakerApplied: !!tiebreakerNote,
            confidence,
            displayName: geo.displayName,
          },
          'AI resolver Nominatim shortcut — no AI invocation needed',
        );
        return {
          barrio: null,
          city: cityRes.city,
          department: effectiveDept,
          deliveryAddress: '',
          extraObservations: '',
          confidence,
          reasoning: `nominatim: ${geo.displayName}; ${cityRes.reason}${tiebreakerNote}`,
          source: 'deterministic',
          inputHash: hash,
          aiCostUsd: 0,
          webSearchRequests: 0,
          priorShipmentsUsed: 0,
        };
      }
      // Dept resolved but locality didn't match a DAC city. Still a
      // net win: the operator only has to pick the city from the DAC
      // dropdown — everything else is correct.
      logger.info(
        {
          hash,
          tenantId: input.tenantId,
          dept: effectiveDept,
          nominatimLocality: geo.locality,
          nominatimDept: geo.department,
          tiebreakerApplied: !!tiebreakerNote,
          displayName: geo.displayName,
        },
        'AI resolver Nominatim shortcut — dept only (city deferred to operator)',
      );
      return {
        barrio: null,
        city: '',
        department: effectiveDept,
        deliveryAddress: '',
        extraObservations: '',
        confidence: 'medium',
        reasoning: `nominatim (dept-only): ${geo.displayName}${tiebreakerNote}`,
        source: 'deterministic',
        inputHash: hash,
        aiCostUsd: 0,
        webSearchRequests: 0,
        priorShipmentsUsed: 0,
      };
    }
  } catch (err) {
    // Nominatim is best-effort. Never let it block the AI path.
    logger.debug(
      { hash, error: (err as Error).message },
      'Nominatim fallback threw — falling through to AI',
    );
  }

  // 1c. Customer-history fetch + recurrence shortcut.
  //
  // We hoist the Label-history query ABOVE the tenant/quota/api-key checks so
  // that (a) the recurrence shortcut can short-circuit even for tenants with
  // AI disabled (this is strictly better than returning null → falling back
  // to rules that already failed), and (b) we only query the DB once even
  // when the shortcut misses and the AI path reuses the result.
  //
  // The shortcut fires when TODAY's address shares a street with a prior
  // successful shipment from the same customer. See resolveByCustomerRecurrence
  // for matching semantics. On a hit we return immediately with
  // source='deterministic' — no AI call, no tenant quota charged.
  let priorShipments: Array<{
    department: string;
    city: string;
    deliveryAddress: string;
  }> = [];
  try {
    const customerKey = (input.customerEmail || '').trim().toLowerCase();
    const phoneDigits = (input.customerPhone || '').replace(/\D/g, '');
    if (customerKey || phoneDigits.length >= 7) {
      priorShipments = await db.label.findMany({
        where: {
          tenantId: input.tenantId,
          status: { in: ['CREATED', 'COMPLETED'] },
          OR: [
            customerKey ? { customerEmail: customerKey } : undefined,
            phoneDigits.length >= 7
              ? { customerPhone: { contains: phoneDigits } }
              : undefined,
          ].filter(Boolean) as any,
        },
        select: { department: true, city: true, deliveryAddress: true },
        orderBy: { createdAt: 'desc' },
        take: 3,
      });
    }
  } catch (err) {
    logger.debug(
      { error: (err as Error).message },
      'Customer history lookup failed — continuing without it',
    );
  }

  const recurrenceHit = resolveByCustomerRecurrence(
    input,
    priorShipments,
    hash,
  );
  if (recurrenceHit) return recurrenceHit;

  // 2. Tenant opt-in + quota check (M-4, 2026-04-21 audit)
  //
  // Previously this was a three-step "read → check → later-increment" dance:
  //
  //     const t = await db.tenant.findUnique(...)
  //     if (t.aiResolverDailyUsed >= t.aiResolverDailyLimit) return null;
  //     // ... make the AI call ...
  //     await db.tenant.update({ data: { aiResolverDailyUsed: { increment: 1 } } });
  //
  // Under concurrent callers the read-then-increment is not atomic: N
  // orders classified as YELLOW in the same 10-second window all read the
  // same `aiResolverDailyUsed`, all pass the cap check, all fire the AI
  // call, and then all increment — blowing past the limit by N-1 and
  // silently driving up the Anthropic bill.
  //
  // Replaced with a single atomic UPDATE that increments only when the
  // cap is not reached AND the tenant has AI enabled. If the row was
  // touched we won a slot and the counter is already reserved; if not,
  // we're either disabled or over-limit and fall back. We trade a rare
  // "quota burned on a failed AI call" for a hard cap on overshoot —
  // the quota resets at midnight UY anyway, so one wasted slot per
  // daily failure is negligible.
  const reserved = await db.$queryRaw<
    { ai_resolver_daily_used: number; ai_resolver_daily_limit: number }[]
  >`
    UPDATE "Tenant"
    SET "aiResolverDailyUsed" = "aiResolverDailyUsed" + 1
    WHERE id = ${input.tenantId}
      AND "aiResolverEnabled" = true
      AND "aiResolverDailyUsed" < "aiResolverDailyLimit"
    RETURNING "aiResolverDailyUsed" AS ai_resolver_daily_used,
              "aiResolverDailyLimit" AS ai_resolver_daily_limit
  `;

  if (reserved.length === 0) {
    // Distinguish "disabled" from "over-quota" from "tenant gone" with a
    // single diagnostic read. This is only hit on the failure path, so
    // the extra round-trip doesn't matter in steady state.
    const tenant = await db.tenant.findUnique({
      where: { id: input.tenantId },
      select: {
        aiResolverEnabled: true,
        aiResolverDailyLimit: true,
        aiResolverDailyUsed: true,
      },
    });
    if (!tenant) {
      logger.warn({ tenantId: input.tenantId }, 'Tenant not found for AI resolver');
      return null;
    }
    if (!tenant.aiResolverEnabled) {
      logger.info({ tenantId: input.tenantId }, 'AI resolver disabled for this tenant');
      return null;
    }
    logger.warn(
      {
        tenantId: input.tenantId,
        used: tenant.aiResolverDailyUsed,
        limit: tenant.aiResolverDailyLimit,
      },
      'AI resolver daily quota exceeded, falling back to rules',
    );
    return null;
  }

  // Slot reserved — record the post-increment counter for logging.
  const quotaSnapshot = reserved[0];
  logger.debug(
    {
      tenantId: input.tenantId,
      used: quotaSnapshot.ai_resolver_daily_used,
      limit: quotaSnapshot.ai_resolver_daily_limit,
    },
    'AI resolver quota slot reserved (atomic CAS-increment)',
  );

  // 3. API key check
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error('ANTHROPIC_API_KEY not set — AI resolver unavailable');
    return null;
  }

  // 4a. priorShipments was already fetched above (1c) — reuse it here so the
  // AI sees the customer history as context even when recurrence missed.

  // 4b. Build enriched user message.
  //
  // Still small enough that the cached prefix (system + tools) dominates cost.
  // Fields added in Phase 1 (2026-04-21): customer name/email/phone, country,
  // and prior shipments. The address tuple alone is not enough for hard cases
  // like "José María Silva 4058" — these extra signals give the AI the context
  // it needs to answer with high confidence, or to decide to use web_search.
  const customerFullName = [input.customerFirstName, input.customerLastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  const historyBlock =
    priorShipments.length > 0
      ? [
          '',
          'HISTORIAL DEL CLIENTE (envios previos exitosos, mas recientes primero):',
          ...priorShipments.map(
            (p, i) =>
              `  ${i + 1}. ${p.department} / ${p.city || '(sin ciudad)'} / ${p.deliveryAddress}`,
          ),
          '',
        ].join('\n')
      : '';
  const userMessage = [
    'Resolve this Uruguayan delivery address:',
    '',
    `City: ${input.city || '(empty)'}`,
    `Address line 1: ${input.address1 || '(empty)'}`,
    `Address line 2: ${input.address2 || '(empty)'}`,
    `ZIP: ${input.zip || '(empty)'}`,
    `Province (from Shopify): ${input.province || '(empty)'}`,
    `Country: ${input.country || '(empty)'}`,
    customerFullName ? `Customer name: ${customerFullName}` : '',
    input.customerEmail ? `Customer email: ${input.customerEmail}` : '',
    // customerPhone is INTENTIONALLY NOT passed to the AI — see system prompt
    // rule 16. The phone is the customer's contact, not the destination. We
    // still keep it in AIResolverInput because it is used for the DB history
    // lookup (matching prior shipments by phone digits when email is absent).
    input.orderNotes ? `Order notes: ${input.orderNotes.slice(0, 400)}` : '',
    historyBlock,
    'If the address is unambiguous or matches the customer history, respond directly with the resolve_address tool.',
    'If the street/city is unfamiliar, ambiguous, or you are about to return confidence="low", FIRST use the web_search tool to look it up, THEN respond with resolve_address.',
  ]
    .filter(Boolean)
    .join('\n');

  // 5. Call Claude Haiku with tool use + web_search + prompt caching.
  //
  // Tool set:
  //   - resolve_address: our structured-output tool (final answer)
  //   - web_search: Anthropic server-side tool, auto-executes. Capped at 2 uses
  //     per request to keep latency + cost bounded.
  //
  // tool_choice = "auto" (not forced). Claude picks web_search when uncertain
  // and resolve_address when it has enough info. For clear addresses, only the
  // resolve_address call happens (same latency/cost as before). For ambiguous
  // ones, 1–2 server-side web searches add ~2–5s latency and ~$0.01/search but
  // turn otherwise-manual review cases into automatic resolutions.
  //
  // Cache breakpoint stays on the last tool so system + tool schemas cache.
  // The user message remains uncached (changes per request). After first call
  // in a 5-min window, cached portion pays 0.1x base input.
  //
  // For implementation details see:
  //   https://platform.claude.com/docs/en/build-with-claude/prompt-caching
  //   https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
  const client = new Anthropic({ apiKey });
  const requestBody = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: 'text' as const,
        text: SYSTEM_PROMPT,
      },
    ],
    tools: [
      // web_search: Anthropic server-side tool. user_location is intentionally
      // omitted — Anthropic only accepts a short list of supported country
      // codes for user_location.country (UY is not in it, the API returns a
      // 400). Rule 14 in the system prompt already tells the AI to include
      // "Uruguay" in every search query, which achieves the same geo-bias
      // without needing the location hint.
      {
        type: 'web_search_20250305' as const,
        name: 'web_search' as const,
        max_uses: 2,
      },
      {
        ...ADDRESS_RESOLVER_TOOL,
        cache_control: { type: 'ephemeral' as const },
      },
    ],
    tool_choice: { type: 'auto' as const },
    messages: [{ role: 'user' as const, content: userMessage }],
  };

  // Retry with exponential backoff. Anthropic's input-token-per-minute rate
  // limit (50k tpm on our tier) is per-organization and bursty batches can
  // hit it even though steady-state throughput is fine. We also retry on
  // transient 5xx and overloaded_error (529). Non-retryable errors (400, 401,
  // 403, 404) return null immediately so we don't waste time on them.
  let response: Anthropic.Message | null = null;
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = await client.messages.create(requestBody);
      break;
    } catch (err) {
      const e = err as any;
      const status: number | undefined = e?.status;
      const retryable =
        status === 429 ||
        status === 529 ||
        (typeof status === 'number' && status >= 500 && status < 600);
      if (!retryable || attempt === MAX_ATTEMPTS) {
        logger.error(
          { hash, status, attempt, error: (err as Error).message },
          'AI resolver API call failed (non-retryable or out of attempts)',
        );
        return null;
      }
      // Exponential backoff: 1s, 4s, 16s, 64s — capped at 60s. For 429 we
      // honor the retry-after header if the SDK surfaces it. The long upper
      // bound lets us ride out a full 1-minute token-rate window.
      const retryAfterHeader = e?.headers?.['retry-after'];
      const retryAfterSec =
        retryAfterHeader && !isNaN(parseFloat(retryAfterHeader))
          ? Math.min(60, parseFloat(retryAfterHeader))
          : null;
      const backoffMs = retryAfterSec
        ? Math.ceil(retryAfterSec * 1000)
        : Math.min(60_000, Math.pow(4, attempt - 1) * 1_000);
      logger.warn(
        { hash, status, attempt, backoffMs, error: (err as Error).message },
        'AI resolver retry after transient error',
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  if (!response) {
    logger.error({ hash }, 'AI resolver failed after all retries');
    return null;
  }

  // 6. Extract tool_use from response
  const toolUse = response.content.find(
    (c) => c.type === 'tool_use' && c.name === 'resolve_address',
  );
  if (!toolUse || toolUse.type !== 'tool_use') {
    logger.error({ hash }, 'AI resolver did not return tool_use block');
    return null;
  }
  const result = toolUse.input as AIToolResponse;

  // 7. Validate against whitelists (reject hallucinations)
  if (!VALID_DEPARTMENTS.includes(result.department as any)) {
    logger.error(
      { hash, dept: result.department },
      'AI returned invalid department — rejected',
    );
    return null;
  }
  if (result.department === 'Montevideo' && result.barrio) {
    const barrioLower = result.barrio.toLowerCase();
    if (!VALID_MVD_BARRIOS.includes(barrioLower as any)) {
      // The AI sometimes returns a street name or an obscure locality as the
      // barrio. Instead of rejecting the whole response (which throws away
      // the valid department/address and forces a full fallback), we null
      // the barrio and downgrade confidence. This matches rule 3 in the
      // system prompt ("if unsure, return null") and keeps the rest of the
      // resolution usable — the caller can still ship to Montevideo and let
      // DAC's barrio dropdown do the final pick.
      logger.warn(
        { hash, barrio: result.barrio },
        'AI returned invalid Montevideo barrio — clearing to null, downgrading confidence',
      );
      result.barrio = null;
      if (result.confidence === 'high') result.confidence = 'medium';
    } else {
      result.barrio = barrioLower;
    }
  }
  if (result.department !== 'Montevideo' && result.barrio !== null) {
    logger.warn(
      { hash, dept: result.department, barrio: result.barrio },
      'AI set barrio for non-Montevideo department — clearing',
    );
    result.barrio = null;
  }

  // 7b. Canonicalize city against DAC's dropdown whitelist.
  //
  // The prompt now includes the full DAC city list per department, but models
  // occasionally return a balneario/pueblito that isn't the canonical DAC
  // name, or a slight spelling variant ("Colonia del Sacramento" vs DAC's
  // "Colonia Del Sacramento"). We try to round-trip the AI's city through
  // canonicalizeCityName so downstream DAC-ID resolution gets an exact match.
  //
  // For Montevideo we force city="Montevideo" (the DAC map only has one
  // entry for the capital — barrios drive the routing, not city).
  //
  // If we can't find any match, we DON'T reject — we keep the AI's original
  // city value but downgrade confidence, so the downstream fuzzy resolver in
  // dac-geo-resolver.ts still gets a chance. Rejecting would discard an
  // otherwise-correct department/address pair.
  if (result.department === 'Montevideo') {
    result.city = 'Montevideo';
  } else {
    const canonical = canonicalizeCityName(result.department, result.city);
    if (canonical) {
      if (canonical !== result.city) {
        logger.info(
          { hash, from: result.city, to: canonical, dept: result.department },
          'AI city normalized to DAC canonical spelling',
        );
        result.city = canonical;
      }
    } else {
      logger.warn(
        { hash, dept: result.department, city: result.city },
        'AI city is not in DAC dropdown for this department — downgrading confidence',
      );
      if (result.confidence === 'high') result.confidence = 'medium';
    }
  }

  if (!result.deliveryAddress || result.deliveryAddress.trim().length === 0) {
    logger.error({ hash }, 'AI returned empty deliveryAddress — rejected');
    return null;
  }
  // Normalize confidence: AI occasionally returns casing/whitespace variants
  // ("HIGH", "Medium ", etc.) or a synonym ("certain", "maybe"). Map to the
  // canonical set, defaulting to "low" rather than rejecting the whole
  // response — a low-confidence resolution is still useful downstream.
  const rawConf = (result.confidence ?? '').toString().toLowerCase().trim();
  if (rawConf === 'high' || rawConf === 'medium' || rawConf === 'low') {
    result.confidence = rawConf as 'high' | 'medium' | 'low';
  } else {
    logger.warn(
      { hash, confidence: result.confidence },
      'AI returned non-canonical confidence — defaulting to "low"',
    );
    result.confidence = 'low';
  }

  // 8. Cost tracking — includes cache accounting
  //
  // With prompt caching enabled, the usage response splits input tokens into
  // three categories:
  //   - input_tokens: uncached portion (always the user message in our setup)
  //   - cache_creation_input_tokens: cached portion when this call WROTE the
  //     cache (priced at 1.25x base — only happens on the first call of a
  //     5-minute window or when the cached prefix changes)
  //   - cache_read_input_tokens: cached portion when this call READ the cache
  //     (priced at 0.10x base — huge savings on subsequent calls)
  // The three categories sum to the total input token count. In steady-state
  // batch processing, cache_read dominates and the average per-call cost
  // drops to ~30% of the uncached baseline.
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const cacheCreationTokens =
    (response.usage as any).cache_creation_input_tokens ?? 0;
  const cacheReadTokens =
    (response.usage as any).cache_read_input_tokens ?? 0;
  const webSearchRequests =
    (response.usage as any).server_tool_use?.web_search_requests ?? 0;

  const costUsd = calculateAICost({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    cache_read_input_tokens: cacheReadTokens,
    web_search_requests: webSearchRequests,
  });

  // 9. Persist to cache + audit log
  try {
    await db.addressResolution.upsert({
      where: { tenantId_inputHash: { tenantId: input.tenantId, inputHash: hash } },
      create: {
        tenantId: input.tenantId,
        inputHash: hash,
        rawCity: input.city,
        rawAddress1: input.address1,
        rawAddress2: input.address2 ?? null,
        rawZip: input.zip ?? null,
        rawProvince: input.province ?? null,
        resolvedBarrio: result.barrio,
        resolvedCity: result.city,
        resolvedDepartment: result.department,
        resolvedDeliveryAddress: result.deliveryAddress,
        resolvedObs: result.extraObservations ?? '',
        source: 'AI',
        confidence: result.confidence.toUpperCase() as 'HIGH' | 'MEDIUM' | 'LOW',
        aiModel: MODEL,
        aiReasoning: result.reasoning,
        aiCostUsd: costUsd,
        // H-2 (2026-04-21 audit): TTL cap so stale AI resolutions don't live
        // forever. DAC address validity drifts (new barrios, renumbered
        // streets, typo corrections in prior AI calls); without expiry, a
        // confidently-wrong answer from today can haunt this tenant for years.
        // 90 days balances cache-hit rate against staleness risk.
        expiresAt: computeAddressResolutionExpiry(),
      },
      update: {
        resolvedBarrio: result.barrio,
        resolvedCity: result.city,
        resolvedDepartment: result.department,
        resolvedDeliveryAddress: result.deliveryAddress,
        resolvedObs: result.extraObservations ?? '',
        source: 'AI',
        confidence: result.confidence.toUpperCase() as 'HIGH' | 'MEDIUM' | 'LOW',
        aiModel: MODEL,
        aiReasoning: result.reasoning,
        aiCostUsd: costUsd,
        dacAccepted: null, // reset feedback on re-resolution
        expiresAt: computeAddressResolutionExpiry(), // refresh TTL
      },
    });
  } catch (err) {
    logger.warn(
      { hash, error: (err as Error).message },
      'Failed to persist AddressResolution, continuing',
    );
  }

  // 10. Quota already incremented atomically at step 2 (M-4).

  logger.info(
    {
      hash,
      tenantId: input.tenantId,
      costUsd: costUsd.toFixed(6),
      confidence: result.confidence,
      dept: result.department,
      barrio: result.barrio,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      cacheHit: cacheReadTokens > 0,
      webSearchRequests,
      priorShipmentsUsed: priorShipments.length,
    },
    'AI resolver SUCCESS',
  );

  return {
    barrio: result.barrio,
    city: result.city,
    department: result.department,
    deliveryAddress: result.deliveryAddress,
    extraObservations: result.extraObservations ?? '',
    confidence: result.confidence,
    reasoning: result.reasoning,
    source: 'ai',
    inputHash: hash,
    aiCostUsd: costUsd,
    webSearchRequests,
    priorShipmentsUsed: priorShipments.length,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Feedback loop
// ───────────────────────────────────────────────────────────────────────────

/**
 * Called by process-orders.job.ts after DAC processing to update the cache
 * feedback. If DAC accepted the resolution, the cache entry is reinforced; if
 * rejected, it is marked as bad so future calls won't reuse it.
 */
export async function markAddressResolutionFeedback(
  tenantId: string,
  inputHash: string,
  accepted: boolean,
  guia?: string,
  errorMessage?: string,
): Promise<void> {
  try {
    await db.addressResolution.update({
      where: { tenantId_inputHash: { tenantId, inputHash } },
      data: {
        dacAccepted: accepted,
        dacGuia: guia ?? null,
        dacError: accepted ? null : (errorMessage ?? null),
      },
    });
    logger.info(
      { tenantId, inputHash, accepted, guia },
      'AddressResolution feedback recorded',
    );
  } catch (err) {
    // Non-fatal — the resolution might not exist if it came from deterministic rules
    logger.debug(
      { tenantId, inputHash, error: (err as Error).message },
      'Failed to record AddressResolution feedback (may not exist)',
    );
  }
}

/**
 * Reset daily quota counters for all tenants. Called by the scheduler cron at
 * midnight in America/Montevideo timezone.
 */
export async function resetAllDailyQuotas(): Promise<number> {
  const result = await db.tenant.updateMany({
    data: {
      aiResolverDailyUsed: 0,
      aiResolverLastReset: new Date(),
    },
  });
  logger.info({ count: result.count }, 'AI resolver daily quotas reset');
  return result.count;
}

/**
 * H-2 (2026-04-21 audit): delete AddressResolution rows whose `expiresAt`
 * has passed. The cache-read guard at line ~1077 already ignores expired
 * entries, so stale rows are harmless for correctness — this sweeper just
 * keeps the table from growing without bound over time.
 *
 * Call from a daily cron (same schedule as resetAllDailyQuotas is fine).
 * Rows with `expiresAt = null` are legacy (pre-H-2) entries and are left
 * alone; they will be overwritten on the next re-resolution for that hash.
 */
export async function cleanupExpiredAddressResolutions(): Promise<number> {
  const result = await db.addressResolution.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });
  logger.info(
    { count: result.count },
    'AddressResolution expired rows deleted',
  );
  return result.count;
}
