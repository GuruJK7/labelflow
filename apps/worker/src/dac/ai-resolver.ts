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

// ───────────────────────────────────────────────────────────────────────────
// Constants
// ───────────────────────────────────────────────────────────────────────────

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 512;

// Haiku 4.5 pricing (USD per 1M tokens)
const PRICE_INPUT_PER_MTOK = 1.0;
const PRICE_OUTPUT_PER_MTOK = 5.0;

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
}

export interface AIResolverResult {
  barrio: string | null;
  city: string;
  department: string;
  deliveryAddress: string;
  extraObservations: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  source: 'ai' | 'cache';
  inputHash: string;
  aiCostUsd?: number;
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
// Hashing
// ───────────────────────────────────────────────────────────────────────────

function normalizeForHash(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function hashAddressInput(input: AIResolverInput): string {
  const normalized = JSON.stringify({
    c: normalizeForHash(input.city),
    a1: normalizeForHash(input.address1),
    a2: normalizeForHash(input.address2),
    z: (input.zip ?? '').trim(),
  });
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

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
14. NUNCA inventes datos. Si no podes con certeza, confidence="low" y dejas claro por que en reasoning.

ABREVIATURAS URUGUAYAS COMUNES:
- "Rbla" / "Rmbla" = Rambla (expandir a "Rambla")
- "Av" / "Avda" = Avenida (expandir a "Avenida")
- "Cno" = Camino (expandir a "Camino")
- "Bvar" / "Bvard" = Bulevar (expandir a "Bulevar")
- "Gral" = General
- "Dr" = Doctor
- "Cnel" = Coronel
- "Pta" = Punta

CONTEXTO GEOGRAFICO CLAVE:
- Codigos postales 11xxx = Montevideo
- Codigos postales 90xxx = Canelones (Ciudad de la Costa, Pando, Las Piedras, etc.)
- Codigos postales 20xxx = Maldonado (Punta del Este, San Carlos, Piriapolis)
- Codigos postales 70xxx = Colonia
- 18 de Julio es la avenida principal de Montevideo Centro
- La Rambla bordea todo Montevideo (barrios Pocitos, Buceo, Malvin, Punta Gorda, Carrasco)
- "Ciudad de la Costa" pertenece a Canelones, no Montevideo
- Si la city dice "Pueblo X" o "Villa X", X suele ser el nombre del pueblo/barrio real
- "Juan Lacaze" es una ciudad en Colonia
- "Young" es una ciudad en Rio Negro
- "Minas" es la capital de Lavalleja`;

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
          'Ciudad normalizada. Para Montevideo es siempre "Montevideo". Para otros departamentos es la ciudad/pueblo especifico como aparece en el dropdown de DAC.',
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

  // 1. Cache lookup — accept if no feedback yet or feedback was positive
  try {
    const cached = await db.addressResolution.findUnique({
      where: { tenantId_inputHash: { tenantId: input.tenantId, inputHash: hash } },
    });
    if (cached && cached.dacAccepted !== false) {
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

  // 2. Tenant opt-in + quota check
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
  if (tenant.aiResolverDailyUsed >= tenant.aiResolverDailyLimit) {
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

  // 3. API key check
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.error('ANTHROPIC_API_KEY not set — AI resolver unavailable');
    return null;
  }

  // 4. Build user message
  const userMessage = [
    'Resolve this Uruguayan delivery address:',
    '',
    `City: ${input.city || '(empty)'}`,
    `Address line 1: ${input.address1 || '(empty)'}`,
    `Address line 2: ${input.address2 || '(empty)'}`,
    `ZIP: ${input.zip || '(empty)'}`,
    `Province (from Shopify): ${input.province || '(empty)'}`,
    input.orderNotes ? `Order notes: ${input.orderNotes.slice(0, 400)}` : '',
    '',
    `Valid Montevideo barrios (58): ${VALID_MVD_BARRIOS.join(', ')}`,
    '',
    'Use the resolve_address tool to provide the structured resolution.',
  ]
    .filter(Boolean)
    .join('\n');

  // 5. Call Claude Haiku with tool use
  const client = new Anthropic({ apiKey });
  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [ADDRESS_RESOLVER_TOOL],
      tool_choice: { type: 'tool', name: 'resolve_address' },
      messages: [{ role: 'user', content: userMessage }],
    });
  } catch (err) {
    logger.error(
      { hash, error: (err as Error).message },
      'AI resolver API call failed',
    );
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
      logger.error(
        { hash, barrio: result.barrio },
        'AI returned invalid Montevideo barrio — rejected',
      );
      return null;
    }
    result.barrio = barrioLower;
  }
  if (result.department !== 'Montevideo' && result.barrio !== null) {
    logger.warn(
      { hash, dept: result.department, barrio: result.barrio },
      'AI set barrio for non-Montevideo department — clearing',
    );
    result.barrio = null;
  }
  if (!result.deliveryAddress || result.deliveryAddress.trim().length === 0) {
    logger.error({ hash }, 'AI returned empty deliveryAddress — rejected');
    return null;
  }
  if (!['high', 'medium', 'low'].includes(result.confidence)) {
    logger.error({ hash, confidence: result.confidence }, 'Invalid confidence value');
    return null;
  }

  // 8. Cost tracking
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costUsd =
    (inputTokens / 1_000_000) * PRICE_INPUT_PER_MTOK +
    (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_MTOK;

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
      },
    });
  } catch (err) {
    logger.warn(
      { hash, error: (err as Error).message },
      'Failed to persist AddressResolution, continuing',
    );
  }

  // 10. Increment tenant daily quota
  try {
    await db.tenant.update({
      where: { id: input.tenantId },
      data: { aiResolverDailyUsed: { increment: 1 } },
    });
  } catch (err) {
    logger.warn(
      { error: (err as Error).message },
      'Failed to increment quota counter',
    );
  }

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
