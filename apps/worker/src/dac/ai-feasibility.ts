/**
 * AI-driven address-feasibility assessment.
 *
 * Audit 2026-05-06 — when the deterministic preprocessor wants to bounce
 * an order ("no street number, contact customer"), or when DAC silently
 * rejected the form and the rescue couldn't recover it, ask Claude
 * Haiku for a SECOND OPINION before declaring the address unshippable.
 *
 * Why this exists:
 *   The deterministic preprocessor in shipment.ts is conservative — it
 *   throws DacAddressRejectedError as soon as address1 has no digit, on
 *   the assumption that DAC needs a numeric street number. But customer
 *   data is often messier than that:
 *
 *     - The "address" might be in address2 or order.note instead.
 *     - The customer might have given a landmark + city, recoverable.
 *     - The customer's prior orders (stored in DB) might have a usable
 *       address we can reuse.
 *     - DAC sometimes silently rejects valid addresses for unrelated
 *       reasons (rate-limiting, transient form bugs); calling the
 *       address "broken" in those cases puts the burden on the
 *       customer when really we should retry or just escalate.
 *
 *   The AI verdict turns these ambiguous cases into actionable answers:
 *   "yes, ship it with this fix" or "no, here's the specific question
 *   the operator must ask the customer before any shipping attempt".
 *
 * Cost: ~$0.001 per call (Haiku 4.5 with no web_search). At ~10–20
 * stuck orders/day this is ~$0.02/day — negligible.
 *
 * This module is INTENTIONALLY narrower than ai-resolver.ts:
 *   - No web_search (the resolver already does that for normal cases)
 *   - No prompt caching (called on rare paths, cache benefit is small)
 *   - No DB cache (each stuck order is unique enough that hash hits
 *     would be rare)
 *   - No daily quota check (it gates on AI being configured at all)
 *
 * The verdict is logged and surfaced to the operator via the Shopify
 * note. We do NOT mutate the order based on AI suggestion alone — the
 * caller decides whether to apply the suggestedAddress1 / suggestedCity.
 */

import Anthropic from '@anthropic-ai/sdk';
import logger from '../logger';
import {
  calculateAICost,
  TokenUsage,
  VALID_DEPARTMENTS,
  VALID_MVD_BARRIOS,
} from './ai-resolver';
import {
  DAC_CITIES_PROMPT_BLOCK,
  canonicalizeCityName,
} from './dac-city-constraints';
import { callClaudeJSONViaBridge } from '../agent/claude-call';

// Same model as the resolver — Haiku 4.5, fast + cheap.
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 384;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Why we're asking for an AI verdict. Different reasons lead to slightly
 * different prompts and different operator notes.
 */
export type FeasibilityReason =
  | 'no-street-number'    // Pre-DAC: address1 has no digit anywhere.
  | 'dac-silent-reject';  // Post-DAC: form clicked, URL stuck on /envios/nuevo, rescue exhausted.

export interface FeasibilityInput {
  reason: FeasibilityReason;
  // Tenant context (for logging only; not used in the prompt)
  tenantId: string;
  orderName: string;
  // Customer info (helps AI decide if a prior shipment is recoverable)
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  orderNotes?: string;
  // Raw Shopify shipping_address fields
  city?: string;
  address1: string;
  address2?: string;
  zip?: string;
  province?: string;
  country?: string;
  // Only for reason='dac-silent-reject' — what dept/city/barrio we tried
  attemptedDept?: string;
  attemptedCity?: string;
  attemptedBarrio?: string;
  /**
   * Department the caller plans to use for the DAC submission. Used to
   * validate AI's suggestedCity against DAC's dropdown for that
   * department. When omitted, suggestedCity validation falls back to
   * trying all 19 departments — slower but still safe.
   *
   * For reason='dac-silent-reject' this is typically `attemptedDept`.
   * For reason='no-street-number' it's typically `province` (after
   * normalization to a recognized UY dept).
   */
  targetDepartment?: string;
}

export interface FeasibilityResult {
  /**
   * AI verdict on whether this order can be shipped at all.
   *   true  — AI thinks it's shippable, possibly with a repair suggestion
   *   false — AI thinks the address is fundamentally incomplete; operator
   *           MUST contact the customer before any shipping attempt
   */
  shippable: boolean;
  confidence: 'high' | 'medium' | 'low';
  /** 1–2 sentence justification for audit trail. */
  reasoning: string;
  /**
   * If shippable=true and AI is confident the customer's address1 can be
   * fixed (e.g. found a number in address2 / order.note), the suggested
   * cleaned-up address1. Empty string when no concrete fix is available.
   */
  suggestedAddress1?: string;
  /**
   * If shippable=true and AI suggests a different city than the
   * customer typed (e.g. resolved a misspelling beyond Levenshtein 1).
   */
  suggestedCity?: string;
  /**
   * If shippable=false, the SPECIFIC question the operator should ask
   * the customer (in Spanish). Goes into the Shopify operator note
   * verbatim. Empty when shippable=true.
   */
  operatorQuestion?: string;
  /** 'ai' on real call, 'unavailable' when API key is missing or all retries failed. */
  source: 'ai' | 'unavailable';
  aiCostUsd?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────────

const FEASIBILITY_TOOL: Anthropic.Tool = {
  name: 'address_feasibility_verdict',
  description:
    'Decide si una direccion uruguaya puede enviarse a DAC tal cual o si necesita corregirse antes (contactar al cliente).',
  input_schema: {
    type: 'object',
    properties: {
      shippable: {
        type: 'boolean',
        description:
          'true si la direccion es enviable tal cual o con un fix concreto que puedas sugerir. false si la informacion del cliente esta tan incompleta que el operador DEBE contactarlo antes de cualquier intento de envio.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Tu certeza sobre el veredicto.',
      },
      reasoning: {
        type: 'string',
        description: 'Explicacion corta (1-2 oraciones, en espanol). Sirve para auditoria.',
      },
      suggestedAddress1: {
        type: 'string',
        description:
          'Si shippable=true Y podes sugerir un address1 reparado (ej. extraer el numero de address2 o de order.notes), pone aca la direccion completa "Calle Numero". String vacio si no hay sugerencia concreta.',
      },
      suggestedCity: {
        type: 'string',
        description:
          'Si shippable=true Y la ciudad que tipeo el cliente es claramente erronea (typo no obvio, abreviatura, etc), pone la ciudad correcta. String vacio si la ciudad original esta bien.',
      },
      operatorQuestion: {
        type: 'string',
        description:
          'Si shippable=false, la PREGUNTA EXACTA en espanol que el operador le tiene que hacer al cliente para conseguir el dato faltante. Ej: "Por favor confirme el nombre completo de la calle y el numero de puerta". String vacio si shippable=true.',
      },
    },
    required: [
      'shippable',
      'confidence',
      'reasoning',
      'suggestedAddress1',
      'suggestedCity',
      'operatorQuestion',
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Prompts
// ─────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Sos un asistente experto en direcciones uruguayas y logistica de envios DAC.

Tu trabajo es decidir si una direccion que un cliente ingreso en Shopify es ENVIABLE como esta o si necesita correccion del cliente antes de cualquier intento.

CONTEXTO DAC:
- Uruguay tiene 19 departamentos: ${VALID_DEPARTMENTS.join(', ')}.
- Para crear un envio en DAC necesitas: departamento, ciudad/localidad VALIDA del dropdown oficial de DAC para ese departamento (lista mas abajo), y address1 con calle + numero (DAC rechaza silenciosamente si falta el numero).
- Si la ciudad es Montevideo, ademas necesitas un barrio. DAC solo acepta exactamente uno de estos 58 barrios (todos lowercase): ${VALID_MVD_BARRIOS.join(', ')}.

REGLAS DE DECISION:
1. shippable=true cuando:
   - El address1 ya tiene calle + numero claros, O
   - El numero esta en address2 o order.notes y podes recuperarlo, O
   - Una abreviatura/typo de ciudad puede corregirse sin ambiguedad (ej. "Mvdo" → "Montevideo").
   - En esos casos pone suggestedAddress1 / suggestedCity con el fix concreto.

2. shippable=false cuando:
   - El cliente solo escribio el nombre del pueblo o departamento como direccion (ej. "La Paloma" como address1 y nada mas), Y
   - No hay numero de puerta deducible en address2 ni order.notes ni el resto del pedido.
   - En esos casos pone operatorQuestion con la pregunta EXACTA que el operador tiene que hacerle al cliente (en espanol, formal-amable, una sola oracion).

3. Si tenes dudas razonables, prefere shippable=false con confidence=medium y una operatorQuestion clara — es mejor que un orphan guia en DAC.

4. REGLA CRITICA — NO ALUCINES NUMEROS:
   - Si pones suggestedAddress1, los DIGITOS que aparezcan ahi (numero de puerta, apto, etc.) DEBEN aparecer literalmente en alguno de los campos del input (address1, address2, order.notes, zip).
   - NUNCA inventes un numero que el cliente no escribio. Si el customer no dio el numero, dejalo en operatorQuestion.

5. REGLA CRITICA — suggestedCity DEBE ser de la lista DAC:
   - Si pones suggestedCity y el departamento NO es Montevideo, la ciudad DEBE ser EXACTAMENTE una de las listadas para ese departamento en el bloque "CIUDADES VALIDAS DE DAC" mas abajo (sin acentos esta bien, espacios y mayusculas tienen que matchear).
   - Si la direccion del cliente apunta a un balneario/pueblito que NO esta en la lista del departamento, suggestedCity debe ser la ciudad/cabecera mas cercana QUE SI esta en la lista (no inventes ciudades que DAC no tiene en su dropdown — DAC las rechaza silenciosamente).
   - Para Montevideo, suggestedCity es siempre "Montevideo" (los barrios manejan la geografia, no los city names).

6. Para "dac-silent-reject" (DAC ya rechazo el formulario silenciosamente):
   - Mira que dept/city/barrio probamos.
   - Si pensas que probamos algo equivocado y hay una alternativa razonable (ej. otra ciudad cercana del mismo depto que SI esta en la lista DAC), pone shippable=true + suggestedCity con la alternativa y explica en reasoning.
   - Si la direccion ya parece bien y DAC fallo por otra razon (rate limit, bug del form), pone shippable=true con confidence=medium, suggestedAddress1/City vacios, y reasoning describiendo que es un posible bug de DAC.
   - Si la direccion es realmente confusa o incompleta, pone shippable=false como en regla 2.

CIUDADES VALIDAS DE DAC POR DEPARTAMENTO (estas son las opciones EXACTAS del dropdown del sistema):
${DAC_CITIES_PROMPT_BLOCK}

OUTPUT FORMAT (regla MAS importante — la cumplis SIEMPRE):
Tu respuesta es exactamente un objeto JSON con estos 6 campos. Sin prosa
antes ni despues, sin code fences (sin \`\`\`), sin comentarios:

  {
    "shippable": true | false,
    "confidence": "high" | "medium" | "low",
    "reasoning": "<espanol, 1-2 oraciones, sirve para auditoria>",
    "suggestedAddress1": "<string vacio si no hay sugerencia>",
    "suggestedCity": "<string vacio si no hay sugerencia>",
    "operatorQuestion": "<vacio si shippable=true; sino, la pregunta exacta en espanol formal>"
  }

DOS MODOS DE ENTREGAR ESTE JSON (cualquiera es equivalente):
- (A) Si tenes acceso a una herramienta llamada "address_feasibility_verdict",
  INVOCALA pasando los 6 campos como parametros. El sistema captura tu
  invocacion como respuesta.
- (B) Si NO tenes esa herramienta, escribi el objeto JSON literal en el
  archivo de salida que el usuario te indica (la instruccion del usuario
  te va a decir donde escribir).

Nunca mezcles los dos modos. Nunca devuelvas texto libre, prosa, ni
explicaciones fuera del JSON / tool_use — el sistema downstream solo
parsea el objeto estructurado.`;

function buildUserMessage(input: FeasibilityInput): string {
  const lines: string[] = [];
  lines.push(`MOTIVO DE LA CONSULTA: ${input.reason}`);
  if (input.reason === 'no-street-number') {
    lines.push(
      '  → Nuestro preprocesador detecto que address1 no tiene NINGUN digito. Antes de bouncear el pedido al operador con "contactar cliente", queremos tu veredicto.',
    );
  } else {
    lines.push(
      '  → DAC rechazo el formulario silenciosamente despues de hacer click en Finalizar (URL quedo en /envios/nuevo, sin error visible). El rescue del historial tampoco encontro la guia. Antes de declarar "posible guia huerfana", queremos tu veredicto.',
    );
  }
  lines.push('');
  lines.push(`PEDIDO: ${input.orderName}`);
  lines.push(`CLIENTE: ${input.customerName}`);
  if (input.customerEmail) lines.push(`  email: ${input.customerEmail}`);
  if (input.customerPhone) lines.push(`  phone: ${input.customerPhone}`);
  if (input.country) lines.push(`  country: ${input.country}`);
  lines.push('');
  lines.push('SHIPPING ADDRESS (Shopify):');
  lines.push(`  city:     ${JSON.stringify(input.city ?? '')}`);
  lines.push(`  province: ${JSON.stringify(input.province ?? '')}`);
  lines.push(`  zip:      ${JSON.stringify(input.zip ?? '')}`);
  lines.push(`  address1: ${JSON.stringify(input.address1)}`);
  lines.push(`  address2: ${JSON.stringify(input.address2 ?? '')}`);
  if (input.orderNotes) {
    lines.push(`  order.note: ${JSON.stringify(input.orderNotes)}`);
  }
  if (input.reason === 'dac-silent-reject') {
    lines.push('');
    lines.push('LO QUE INTENTAMOS EN DAC (y fue silently-rejected):');
    if (input.attemptedDept) lines.push(`  department: ${input.attemptedDept}`);
    if (input.attemptedCity) lines.push(`  city:       ${input.attemptedCity}`);
    if (input.attemptedBarrio) lines.push(`  barrio:     ${input.attemptedBarrio}`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────

/**
 * Ask Claude Haiku whether the given address is shippable. Always returns
 * a result — when AI is unavailable (no API key, all retries failed) the
 * result has source='unavailable' and shippable=false (conservative —
 * caller falls back to the existing operator-bounce path).
 */
export async function assessAddressFeasibility(
  input: FeasibilityInput,
): Promise<FeasibilityResult> {
  const userMessage = buildUserMessage(input);

  // 1) Try the Mac Mini bridge first ($0, uses Claude Max subscription).
  //    The bridge helper has its own 8s timeout + circuit breaker, so a
  //    cold/offline Mac Mini never costs more than ~40s wasted per cron
  //    (and even that goes to ~0s once the breaker opens). On any failure
  //    (bridge unavailable, parse error, schema mismatch) we fall through
  //    to the existing Anthropic SDK path below — fully backward compatible.
  let toolInput: Record<string, unknown> | null = null;
  let usedBridge = false;
  let cost = 0;

  try {
    const bridgeResult = await callClaudeJSONViaBridge({
      jobId: 'feasibility',
      orderId: input.orderName,
      system: SYSTEM_PROMPT,
      user: userMessage,
      model: 'haiku',
      allowedTools: 'Read,Write',
      schemaHint:
        '{ "shippable": boolean, "confidence": "high"|"medium"|"low", ' +
        '"reasoning": string, "suggestedAddress1": string, ' +
        '"suggestedCity": string, "operatorQuestion": string }',
    });
    if (
      bridgeResult &&
      typeof bridgeResult === 'object' &&
      !Array.isArray(bridgeResult) &&
      'shippable' in (bridgeResult as object)
    ) {
      toolInput = bridgeResult as Record<string, unknown>;
      usedBridge = true;
      // cost stays 0 — subscription, not metered.
    }
  } catch (err) {
    // callClaudeJSONViaBridge swallows its own errors, but defense in depth.
    logger.warn(
      { tenantId: input.tenantId, orderName: input.orderName, error: (err as Error).message },
      'AI feasibility: bridge attempt threw (falling through to API)',
    );
  }

  // 2) Fall back to Anthropic SDK if bridge didn't produce a result.
  if (!toolInput) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      logger.warn(
        { tenantId: input.tenantId, orderName: input.orderName, reason: input.reason },
        'AI feasibility: bridge unavailable AND ANTHROPIC_API_KEY not set — falling back to caller default',
      );
      return {
        shippable: false,
        confidence: 'low',
        reasoning: 'AI feasibility unavailable (ANTHROPIC_API_KEY not set and bridge unavailable).',
        operatorQuestion: '',
        source: 'unavailable',
      };
    }

    const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });

    // Up to 3 retries on transient errors. Pattern matches ai-resolver.ts
    // but capped lower since this is a fallback path — if the first 2
    // attempts fail we'd rather bounce to the operator than block the
    // cron tick for 60+ seconds.
    const MAX_ATTEMPTS = 3;
    let response: Anthropic.Message | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        response = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          tools: [FEASIBILITY_TOOL],
          tool_choice: { type: 'tool' as const, name: 'address_feasibility_verdict' },
          messages: [{ role: 'user' as const, content: userMessage }],
        });
        break;
      } catch (err) {
        const status = (err as any)?.status;
        const retryable =
          status === 429 ||
          status === 529 ||
          (typeof status === 'number' && status >= 500 && status < 600);
        if (!retryable || attempt === MAX_ATTEMPTS) {
          logger.error(
            {
              tenantId: input.tenantId,
              orderName: input.orderName,
              reason: input.reason,
              status,
              attempt,
              error: (err as Error).message,
            },
            'AI feasibility: API call failed (non-retryable or out of attempts)',
          );
          return {
            shippable: false,
            confidence: 'low',
            reasoning: `AI feasibility call failed (${(err as Error).message.substring(0, 80)}).`,
            operatorQuestion: '',
            source: 'unavailable',
          };
        }
        const backoffMs = Math.min(15_000, Math.pow(3, attempt - 1) * 1_000);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    if (!response) {
      return {
        shippable: false,
        confidence: 'low',
        reasoning: 'AI feasibility: no response after retries.',
        operatorQuestion: '',
        source: 'unavailable',
      };
    }

    // Extract tool_use
    const toolUse = response.content.find(
      (c) => c.type === 'tool_use' && c.name === 'address_feasibility_verdict',
    );
    if (!toolUse || toolUse.type !== 'tool_use') {
      logger.warn(
        { tenantId: input.tenantId, orderName: input.orderName, reason: input.reason },
        'AI feasibility: response did not invoke address_feasibility_verdict tool',
      );
      return {
        shippable: false,
        confidence: 'low',
        reasoning: 'AI feasibility: tool not invoked in response.',
        operatorQuestion: '',
        source: 'unavailable',
      };
    }

    toolInput = toolUse.input as Record<string, unknown>;
    const usage: TokenUsage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: (response.usage as any).cache_creation_input_tokens,
      cache_read_input_tokens: (response.usage as any).cache_read_input_tokens,
    };
    cost = calculateAICost(usage);
  }

  let suggestedAddress1 = typeof toolInput.suggestedAddress1 === 'string' ? toolInput.suggestedAddress1 : '';
  let suggestedCity = typeof toolInput.suggestedCity === 'string' ? toolInput.suggestedCity : '';

  // ── ANTI-HALLUCINATION GUARD #1: suggestedAddress1 numbers ──
  //
  // Every digit-sequence in AI's suggestedAddress1 MUST appear somewhere
  // in the customer's original input (address1 / address2 / orderNotes
  // / zip). If AI invented a number, drop the suggestion entirely —
  // we'd rather bounce to the operator than ship to a hallucinated
  // address. The number is what determines where the package physically
  // ends up.
  if (suggestedAddress1) {
    const digitsInSuggestion = suggestedAddress1.match(/\d+/g) ?? [];
    const haystack = [
      input.address1 ?? '',
      input.address2 ?? '',
      input.orderNotes ?? '',
      input.zip ?? '',
    ].join(' ');
    const allDigitsPresent = digitsInSuggestion.every((d) => haystack.includes(d));
    if (!allDigitsPresent) {
      logger.warn(
        {
          tenantId: input.tenantId,
          orderName: input.orderName,
          suggestedAddress1,
          digits: digitsInSuggestion,
          audit: '2026-05-06',
        },
        'AI feasibility: dropping suggestedAddress1 — contains digits not present in original input (possible hallucination)',
      );
      suggestedAddress1 = '';
    }
  }

  // ── ANTI-HALLUCINATION GUARD #2: suggestedCity must be a real DAC dropdown option ──
  //
  // If AI suggests a city that DAC's dropdown for the target department
  // doesn't have, DAC will silently reject the form and we'd be back
  // where we started. canonicalizeCityName() returns the DAC-canonical
  // spelling for accepted matches and null for misses. When it returns
  // null we drop the suggestion (don't apply a fix that DAC won't accept).
  if (suggestedCity) {
    // Resolve which dept to validate against:
    //   1. caller-provided targetDepartment (most accurate)
    //   2. attemptedDept for dac-silent-reject scenarios
    //   3. customer's province (last resort)
    const validateAgainst =
      input.targetDepartment ?? input.attemptedDept ?? input.province ?? '';
    if (validateAgainst) {
      // Special case: Montevideo has only one valid city ("Montevideo"
      // itself). Any other suggestedCity for MVD is a hallucination.
      const isMvd = /^montevideo$/i.test(
        validateAgainst.normalize('NFD').replace(/[̀-ͯ]/g, '').trim(),
      );
      if (isMvd) {
        if (!/^montevideo$/i.test(suggestedCity.trim())) {
          logger.warn(
            { tenantId: input.tenantId, orderName: input.orderName, suggestedCity, audit: '2026-05-06' },
            'AI feasibility: dropping suggestedCity — Montevideo dept only accepts city "Montevideo"',
          );
          suggestedCity = '';
        } else {
          suggestedCity = 'Montevideo';
        }
      } else {
        const canonical = canonicalizeCityName(validateAgainst, suggestedCity);
        if (canonical) {
          // Round-trip to DAC's canonical spelling so dropdown match is exact.
          if (canonical !== suggestedCity) {
            logger.info(
              {
                tenantId: input.tenantId,
                orderName: input.orderName,
                from: suggestedCity,
                to: canonical,
                dept: validateAgainst,
              },
              'AI feasibility: suggestedCity normalized to DAC-canonical spelling',
            );
            suggestedCity = canonical;
          }
        } else {
          logger.warn(
            {
              tenantId: input.tenantId,
              orderName: input.orderName,
              suggestedCity,
              dept: validateAgainst,
              audit: '2026-05-06',
            },
            'AI feasibility: dropping suggestedCity — not in DAC dropdown for the target department',
          );
          suggestedCity = '';
        }
      }
    }
  }

  const result: FeasibilityResult = {
    shippable: Boolean(toolInput.shippable),
    confidence: (toolInput.confidence as 'high' | 'medium' | 'low') ?? 'low',
    reasoning: typeof toolInput.reasoning === 'string' ? toolInput.reasoning : '',
    suggestedAddress1,
    suggestedCity,
    operatorQuestion: typeof toolInput.operatorQuestion === 'string' ? toolInput.operatorQuestion : '',
    source: 'ai',
    aiCostUsd: cost,
  };

  logger.info(
    {
      tenantId: input.tenantId,
      orderName: input.orderName,
      reason: input.reason,
      shippable: result.shippable,
      confidence: result.confidence,
      hasSuggestedAddress1: Boolean(result.suggestedAddress1),
      hasSuggestedCity: Boolean(result.suggestedCity),
      aiCostUsd: cost,
      transport: usedBridge ? 'bridge' : 'api',
    },
    'AI feasibility verdict',
  );

  return result;
}
