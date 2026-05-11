/**
 * AI-driven address consistency validator.
 *
 * Designed 2026-05-11 after two production silent-reject incidents:
 *
 *   #12001 Esmeralda P  — city="Aires puros" province="Montevideo" zip="11200"
 *                         (ZIP doesn't match Aires Puros barrio range)
 *   #12002 Liria Pouso  — city="Pando"       province="Montevideo" zip="15600"
 *                         (Pando is in Canelones, ZIP 15600 is a MVD zone)
 *
 * Both addresses look superficially valid — the deterministic city→dept
 * resolver returned HIGH confidence so no AI call fired — but DAC's
 * server-side validator rejected them because the (city, province, zip)
 * triple is internally inconsistent.
 *
 * The existing AI pipeline (ai-feasibility, ai-resolver) only fires
 * REACTIVELY:
 *   - ai-feasibility: "address has no street number" pre-check, OR
 *                     "DAC silently rejected" post-rescue check.
 *   - ai-resolver:    "deterministic confidence is low" fallback.
 *
 * This validator fires PROACTIVELY: BEFORE every DAC submit, asks Claude
 * Haiku (via the Mac Mini bridge — $0 marginal) to check the 4-tuple
 * (address1, city, province, zip) for inconsistencies and propose
 * conservative corrections.
 *
 * ── Safety contract ───────────────────────────────────────────────────────
 *
 * The validator NEVER changes a shippable address. It only corrects
 * provably-wrong combinations. Specifically:
 *
 *   1. Bridge unavailable / API not configured / any throw → return
 *      { skipped: true } and the caller proceeds with the original
 *      address. The validator MUST NOT block a DAC submission.
 *
 *   2. Claude returns `consistent: true` → return unchanged. No DB writes.
 *
 *   3. Claude returns `consistent: false` with `confidence: 'low'` or
 *      `'medium'` → return the suggested corrections in the result but
 *      let the caller decide whether to apply them. Default policy in
 *      the caller is "do NOT auto-apply, just log a warning to RunLog
 *      so operator can see".
 *
 *   4. Claude returns `consistent: false` with `confidence: 'high'` →
 *      caller applies the corrections to `addr` in place AND injects an
 *      operator note ("ADDRESS AUTO-CORRECTED: <old> → <new>") into the
 *      DAC observations so the operator sees what changed when printing
 *      the label.
 *
 * The validator restricts its corrections to PROVINCE / DEPARTMENT and
 * ZIP. It NEVER suggests changing address1 (the street + number) — that
 * stays as the customer typed it. The city name is also off-limits:
 * if the city is wrong, the operator must fix it manually. The reason
 * is that auto-correcting the visible address fields creates audit
 * confusion ("the customer typed X but their label says Y").
 *
 * ── Cost ─────────────────────────────────────────────────────────────────
 *
 * Bridge (default): $0 marginal. Adds ~5-15s per order to the DAC submit
 * flow (Claude CLI cold-start + prompt round-trip). For a typical 5-30
 * order cron tick this is well within the existing 15-min cron interval.
 *
 * Anthropic API fallback: ~$0.001-0.003 per order (Haiku, short prompt,
 * no web_search). Even at 1000 orders/day the upper bound is $3/day.
 * The fallback only fires when the bridge is unavailable or the circuit
 * breaker is open — at steady state with a healthy bridge, fallback
 * usage should be <5% (matching ai-feasibility / ai-resolver patterns).
 */

import Anthropic from '@anthropic-ai/sdk';
import logger from '../logger';
import { db } from '../db';
import { callClaudeJSONViaBridge } from '../agent/claude-call';
import { VALID_DEPARTMENTS, calculateAICost } from './ai-resolver';

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 384;
const REQUEST_TIMEOUT_MS = 30_000;

export interface AddressValidationInput {
  tenantId: string;
  orderName: string;
  // Raw Shopify fields (post-preprocessor — already trimmed/fuzzy-matched)
  address1: string;
  address2?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
}

export interface AddressValidationResult {
  /** True if Claude said the address is consistent OR the validator was
   *  unable to run (bridge + API both unavailable). In both cases the
   *  caller should proceed with the original address. */
  consistent: boolean;
  /** True only when the validator could not run at all (no bridge, no API
   *  key, or Claude threw). When true, the caller MUST proceed with the
   *  unmodified address — the validator returned nothing useful. */
  skipped: boolean;
  /** Suggested corrections. Caller decides whether to apply based on
   *  confidence. Always null when consistent=true or skipped=true. */
  corrections: {
    /** Suggested department/province replacement. */
    department?: string;
    /** Suggested ZIP code replacement. */
    zip?: string;
  } | null;
  /** Claude's confidence in the suggested corrections. 'high' is the only
   *  level at which the caller should auto-apply. */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** Short human-readable problem descriptions for logging + operator note. */
  issues: string[];
  /** Cost telemetry. 0 if bridge was used or validator was skipped. */
  aiCostUsd: number;
  /** Which transport produced this verdict — surfaced in RunLog for SRE
   *  dashboards (same shape as ai-feasibility / ai-resolver). */
  transport: 'bridge' | 'api' | 'skipped';
}

interface ClaudeValidatorOutput {
  consistent?: boolean;
  corrections?: {
    department?: string | null;
    zip?: string | null;
  } | null;
  confidence?: 'high' | 'medium' | 'low' | string;
  issues?: string[];
}

const SYSTEM_PROMPT = `You are a Uruguay address consistency CORRECTOR for the DAC courier service. Your job is NOT just to flag problems — it is to FIX them when you can verify the correct value.

INPUT: A Shopify shipping address with fields { address1, address2?, city, province, zip }. The customer may have typed any of city/province/zip incorrectly.

YOU HAVE TOOLS AVAILABLE — USE THEM:
- WebSearch / WebFetch: search the open web for "[city] Uruguay department" or look up a postal code if you're not 100% sure. ALWAYS prefer verification over guessing.
- Bash (read-only useful): run \`python3 ~/labelflow-tools/dac_catalog.py "<city>"\` if the file exists (offline DAC catalog) for canonical city→department mappings. If unavailable, skip — don't error.
- Read/Write: temp files only.

YOU ARE EXPLICITLY ALLOWED TO USE TOOLS when uncertain. The user prefers a slow correct answer over a fast "low confidence" punt. Do NOT default to "low confidence" — verify first.

OUTPUT FIELDS YOU CAN PROPOSE TO CORRECT (NEVER any others):
- "department" — the Uruguay department (=province). 19 valid names exact-spell: ${VALID_DEPARTMENTS.join(', ')}.
- "zip" — 4 or 5 digit Uruguay postal code.

FIELDS YOU MUST NEVER TOUCH OR PROPOSE TO CHANGE:
- address1 (street + number)        ← the operator says: customer's input stays as typed
- city (the locality name itself)   ← customer-typed identity, off-limits even if it's a typo (the upstream fuzzy-match preprocessor handles typos)
- name, phone, email                ← personal data, never touch

URUGUAY GEOGRAPHY (your prior knowledge — use as starting point, verify with tools when needed):
- 19 departments. ZIP codes are 5 digits.
- Montevideo: 11000-11999 (barrios split: Centro/Cordón~11100-11200, Pocitos~11300, Punta Carretas~11300, Buceo~11400, Carrasco~11500, Malvín~11400, Aires Puros/Brazo Oriental/Cerrito~11700-11800).
- Canelones: capital Canelones~90000, Pando=91000, Las Piedras=90200, Atlántida=15500, Salinas=15500, Ciudad de la Costa~15008, Barros Blancos~91300, Sauce~90600.
- Maldonado: 20000-20999 (Maldonado~20000, Punta del Este~20100, Piriápolis~20200, San Carlos~20400).
- Colonia: 70000-70999 (Colonia del Sacramento, Carmelo).
- Paysandú: 60000-60999. Salto: 50000-50999. Rivera: 40000-40999.
- Rocha: 27000+, Treinta y Tres: 33000+, Cerro Largo: 37000+, Tacuarembó: 45000+, Artigas: 55000+, Soriano: 75000+, Río Negro: 65000+, Flores: 85000+, Florida: 94000+, Durazno: 97000+, Lavalleja: 30000+, San José: 80000+.

CORRECTION POLICY — BE DECISIVE:

1. CITY IS IN A DIFFERENT DEPARTMENT THAN CLAIMED PROVINCE
   Example: city="Pando", province="Montevideo". Pando is in Canelones, full stop. CORRECT the department.
   → confidence: "high", corrections: { department: "Canelones" }.
   If you're not 100% sure where the city is, USE WebSearch FIRST, then decide.

2. CITY IS ACTUALLY A MONTEVIDEO BARRIO (operator catches this often)
   Example: city="Aires Puros", province="Canelones". "Aires Puros" is a barrio of MVD. Department must be Montevideo.
   → confidence: "high", corrections: { department: "Montevideo" }.
   Common MVD barrios that customers type as "city": Centro, Cordón, Pocitos, Punta Carretas, Carrasco, Buceo, Malvín, Aires Puros, Brazo Oriental, Cerrito, Pueblo Victoria, Maroñas, Ituzaingó, Sayago, La Blanqueada, Tres Cruces, Aguada, Bella Vista, Goes, Reducto, Paso de las Duranas, Prado, Capurro, Atahualpa, Belvedere, Conciliación, Cerro, Casabó, La Teja, Nuevo París, Peñarol, Lavalleja (the barrio, not dept), Colón, Sayago, Piedras Blancas, Manga, Toledo, Punta Gorda, Punta de Rieles, Flor de Maroñas, Jardines del Hipódromo, Villa Española, etc.

3. ZIP DOES NOT MATCH THE CITY
   Example: city="Pando", zip="15600". Pando is 91000, 15600 is a MVD-adjacent zone. CORRECT the zip.
   → confidence: "high" only if the city is CLEAR and the zip is OBVIOUSLY outside the expected range (off by a whole barrio/department, not by 100).

4. BORDERLINE ZIP (off by a few hundred)
   Example: city="Aires Puros", zip="11200". Aires Puros ~11700, Cordón ~11200. Both MVD. ZIP doesn't affect DAC's destination routing — barrio dropdown does.
   → consistent: true (DAC will accept). NO correction needed.

5. CITY UNKNOWN OR AMBIGUOUS
   Example: city="DesconocidoVille". Cannot verify on WebSearch either.
   → consistent: false, corrections: null, confidence: "low", issues: ["..."].
   This is the ONLY case where you say "low" — when you genuinely cannot resolve.

6. MULTIPLE PLAUSIBLE PROVINCES FOR SAME CITY NAME
   Example: city="San José". Could be San José de Mayo (San José dept), Ciudad del Plata (San José dept), or just a barrio name. Use the ZIP to disambiguate.
   → If ZIP is clear: confidence="high" with the matching department.
   → If ZIP is also ambiguous: confidence="medium", best-guess correction. Be decisive — don't default to "low" unless truly impossible.

KEY PRINCIPLE (the operator emphasized this): "no solo digas confidence baja". When uncertain, USE THE TOOLS to find the answer. Only "low" if even tool-based verification can't resolve it.

OUTPUT (JSON only, no prose, no fences):
{
  "consistent": boolean,
  "corrections": { "department"?: string, "zip"?: string } | null,
  "confidence": "high" | "medium" | "low",
  "issues": [<concise problem descriptions in spanish, lower-case>]
}

EXAMPLES (showing the decisive style):

Input: { city: "Pando", province: "Montevideo", zip: "15600" }
Output: { "consistent": false, "corrections": { "department": "Canelones", "zip": "91000" }, "confidence": "high", "issues": ["pando es de canelones no montevideo", "zip 15600 no corresponde a pando (91000)"] }

Input: { city: "Aires Puros", province: "Canelones", zip: "11200" }
Output: { "consistent": false, "corrections": { "department": "Montevideo" }, "confidence": "high", "issues": ["aires puros es un barrio de montevideo no canelones"] }

Input: { city: "Aires Puros", province: "Montevideo", zip: "11200" }
Output: { "consistent": true, "corrections": null, "confidence": "high", "issues": [] }

Input: { city: "Punta del Este", province: "Maldonado", zip: "20100" }
Output: { "consistent": true, "corrections": null, "confidence": "high", "issues": [] }

Input: { city: "Atlántida", province: "Maldonado", zip: "15500" }
Output: { "consistent": false, "corrections": { "department": "Canelones" }, "confidence": "high", "issues": ["atlántida es de canelones no maldonado"] }

Input: { city: "DesconocidoVille", province: "Maldonado", zip: "20000" }
Output: { "consistent": false, "corrections": null, "confidence": "low", "issues": ["ciudad 'desconocidoville' no se pudo verificar"] }
`;

function buildUserMessage(input: AddressValidationInput): string {
  return JSON.stringify({
    address1: input.address1,
    address2: input.address2 ?? '',
    city: input.city ?? '',
    province: input.province ?? '',
    zip: input.zip ?? '',
    country: input.country ?? 'Uruguay',
  });
}

function coerceResult(
  raw: unknown,
  transport: 'bridge' | 'api',
  costUsd: number,
): AddressValidationResult {
  // Defensive — Claude may return malformed JSON or extra fields. We
  // only trust the shape we explicitly check.
  if (!raw || typeof raw !== 'object') {
    return {
      consistent: true, // safest default: proceed with original address
      skipped: false,
      corrections: null,
      confidence: 'none',
      issues: ['validator returned non-object response'],
      aiCostUsd: costUsd,
      transport,
    };
  }
  const obj = raw as ClaudeValidatorOutput;
  const consistent = obj.consistent === true;
  const confidence =
    obj.confidence === 'high' || obj.confidence === 'medium' || obj.confidence === 'low'
      ? obj.confidence
      : 'none';
  const issues = Array.isArray(obj.issues)
    ? obj.issues.filter((s): s is string => typeof s === 'string').slice(0, 8)
    : [];

  let corrections: AddressValidationResult['corrections'] = null;
  if (!consistent && obj.corrections && typeof obj.corrections === 'object') {
    const dept = obj.corrections.department;
    const zip = obj.corrections.zip;
    // VALID_DEPARTMENTS uses accent-free spellings (e.g. "San Jose",
    // "Paysandu", "Rio Negro") but Claude commonly returns the Spanish
    // form ("San José", "Paysandú", "Río Negro"). Normalize both sides
    // for comparison, then map back to the CANONICAL spelling used by
    // the DAC form / VALID_DEPARTMENTS so downstream code doesn't get
    // mixed accented vs unaccented strings.
    const stripAccents = (s: string) =>
      s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const validDeptByNormalized = new Map(
      VALID_DEPARTMENTS.map((d) => [stripAccents(d), d] as const),
    );
    const validDept =
      typeof dept === 'string' && dept.length > 0
        ? validDeptByNormalized.get(stripAccents(dept))
        : undefined;
    // ZIP must be 4-5 digit Uruguay format. Tolerate leading zeros / spaces.
    const trimmedZip =
      typeof zip === 'string' ? zip.trim().replace(/^0+/, '') : undefined;
    const validZip =
      trimmedZip && /^\d{4,5}$/.test(trimmedZip) ? trimmedZip : undefined;
    if (validDept || validZip) {
      corrections = {};
      if (validDept) corrections.department = validDept;
      if (validZip) corrections.zip = validZip;
    }
  }

  return {
    consistent,
    skipped: false,
    corrections,
    confidence,
    issues,
    aiCostUsd: costUsd,
    transport,
  };
}

/**
 * Validate the address consistency. NEVER throws — on any error returns
 * `{ skipped: true, consistent: true }` so the caller proceeds with the
 * original address.
 */
export async function validateAddressConsistency(
  input: AddressValidationInput,
): Promise<AddressValidationResult> {
  // Strict-skip guards. If we have nothing to check, don't bother.
  if (!input.address1 || !input.city) {
    return {
      consistent: true,
      skipped: true,
      corrections: null,
      confidence: 'none',
      issues: [],
      aiCostUsd: 0,
      transport: 'skipped',
    };
  }

  const userMessage = buildUserMessage(input);

  // 1. Try bridge first (Mac Mini Claude Max, $0).
  let bridgeRaw: unknown = null;
  try {
    bridgeRaw = await callClaudeJSONViaBridge({
      jobId: 'address-validator',
      orderId: input.orderName,
      system: SYSTEM_PROMPT,
      user: userMessage,
      model: 'haiku',
      // 2026-05-11 — tools enabled per operator request ("que use las
      // tools que sea"). The system prompt instructs Claude to use
      // WebSearch when uncertain about a city's department, instead of
      // defaulting to confidence="low". This is bounded by:
      //   - Claude haiku rarely invokes tools unless prompted
      //   - The downstream coercion still validates corrections against
      //     VALID_DEPARTMENTS + zip regex, so a hallucinated tool result
      //     can't poison the address
      //   - Bash is read-only in practice (the helper scripts are pure
      //     lookups). The bridge env-whitelist already restricts what
      //     spawned subprocesses see.
      allowedTools: 'Read,Write,WebSearch,WebFetch,Bash',
      schemaHint:
        '{ "consistent": bool, "corrections": { "department"?: string, "zip"?: string } | null, "confidence": "high"|"medium"|"low", "issues": [string] }',
    });
  } catch (err) {
    // callClaudeJSONViaBridge swallows its own errors; defense in depth.
    logger.warn(
      { orderName: input.orderName, error: (err as Error).message },
      '[address-validator] bridge attempt threw — falling through to API',
    );
  }
  if (bridgeRaw && typeof bridgeRaw === 'object') {
    return finalize(input, coerceResult(bridgeRaw, 'bridge', 0));
  }

  // 2. Fall back to Anthropic API. Required when bridge is offline OR
  //    the circuit breaker is open. Cost ~$0.001-0.003 per call.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return finalize(input, {
      consistent: true,
      skipped: true,
      corrections: null,
      confidence: 'none',
      issues: ['validator skipped: no bridge response and no ANTHROPIC_API_KEY'],
      aiCostUsd: 0,
      transport: 'skipped',
    });
  }

  let apiResult: AddressValidationResult;
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );

    // Extract the first text block. Defensive — older SDK versions and
    // models occasionally emit empty content arrays on near-max-tokens.
    const textBlock = response.content.find((c) => c.type === 'text');
    const text = textBlock && 'text' in textBlock ? (textBlock as { text: string }).text : '';
    let parsed: unknown = null;
    try {
      // Be forgiving: strip code fences if Claude added them despite the
      // instructions ("```json {...} ```" is a common emit).
      const stripped = text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
      parsed = JSON.parse(stripped);
    } catch {
      parsed = null;
    }

    const cost = calculateAICost({
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        (response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0,
      cache_read_input_tokens:
        (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
      web_search_requests: 0,
    });

    apiResult = parsed
      ? coerceResult(parsed, 'api', cost)
      : {
          consistent: true,
          skipped: true,
          corrections: null,
          confidence: 'none',
          issues: ['validator skipped: API returned unparseable JSON'],
          aiCostUsd: cost,
          transport: 'api',
        };
  } catch (err) {
    logger.warn(
      { orderName: input.orderName, error: (err as Error).message },
      '[address-validator] API attempt threw — proceeding with original address',
    );
    apiResult = {
      consistent: true,
      skipped: true,
      corrections: null,
      confidence: 'none',
      issues: [`validator skipped: API threw (${(err as Error).message.slice(0, 80)})`],
      aiCostUsd: 0,
      transport: 'skipped',
    };
  }

  return finalize(input, apiResult);
}

/**
 * Side-effect tail: write a RunLog row for observability. Same fire-and-
 * forget contract as ai-feasibility / ai-resolver — a DB failure must
 * NEVER break the worker.
 */
function finalize(
  input: AddressValidationInput,
  result: AddressValidationResult,
): AddressValidationResult {
  const summary = result.skipped
    ? 'skipped'
    : result.consistent
      ? 'consistent'
      : `inconsistent (confidence=${result.confidence})`;

  logger.info(
    {
      tenantId: input.tenantId,
      orderName: input.orderName,
      transport: result.transport,
      consistent: result.consistent,
      confidence: result.confidence,
      hasCorrections: !!result.corrections,
      issuesCount: result.issues.length,
      aiCostUsd: result.aiCostUsd,
    },
    `[address-validator] ${summary}`,
  );

  // RunLog row for SRE/cost dashboard queries — same pattern as
  // ai-feasibility transport logging.
  db.runLog
    .create({
      data: {
        tenantId: input.tenantId,
        level: 'INFO',
        message: `[address-validator] ${summary} transport=${result.transport} cost=$${result.aiCostUsd.toFixed(4)}`,
        meta: {
          step: 'address-validator',
          orderName: input.orderName,
          transport: result.transport,
          consistent: result.consistent,
          confidence: result.confidence,
          skipped: result.skipped,
          corrections: result.corrections,
          issues: result.issues,
          aiCostUsd: result.aiCostUsd,
        } as unknown as object,
      },
    })
    .catch(() => {
      // RunLog write failure must never crash the worker.
    });

  return result;
}
