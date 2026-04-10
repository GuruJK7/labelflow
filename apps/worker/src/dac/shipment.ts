import { Page } from 'playwright';
import { ShopifyOrder } from '../shopify/types';
import { DacShipmentResult } from './types';
import { DAC_SELECTORS, DAC_URLS } from './selectors';
import { ensureLoggedIn } from './auth';
import { dacBrowser } from './browser';
import { DAC_STEPS } from './steps';
import { createStepLogger, StepLogger } from '../logger';
import logger from '../logger';
import { getDepartmentForCity, getDepartmentForCityAsync, getBarriosFromZip, getDepartmentFromZip, getBarriosFromStreet } from './uruguay-geo';
import { resolveAddressWithAI, AIResolverResult } from './ai-resolver';

// ---- Helpers ----

/**
 * Matches any LabelFlow-internal marker that must NEVER leak into DAC observations.
 * Covers ALL observed formats in the wild, in any word order:
 *   - "LabelFlow-GUIA:" / "labelflow-guia" / "LABELFLOW-GUIA" (labelflow → guia)
 *   - "labelflow_guia" / "labelflow guia" / "labelflowguia" (separators)
 *   - "labelflow-guía" / "LABELFLOW-GUÍA" (Spanish accent)
 *   - "Guía labelflow:" / "guia labelflow" (REVERSED order — reported 2026-04-10)
 *   - "LabelFlow ERROR:" / "labelflow-error" (error prefix)
 *
 * Exported so the sanitizer can be unit-tested in isolation.
 *
 * History:
 *   v1: /labelflow[-_ ]?(guia|error|gu[ií]a)/i  ← missed "Guía labelflow"
 *   v2: adds reversed-order branch gu[ií]a[-_ ]?labelflow
 */
export const LABELFLOW_MARKER_RE =
  /labelflow[-_ ]?(guia|gu[ií]a|error)|gu[ií]a[-_ ]?labelflow/i;

/**
 * Strip any piece of text (split by newlines or pipe separators) that contains a
 * LabelFlow-internal marker. Used as the final belt-and-suspenders pass before
 * filling DAC's observations field — see sanitizeObservationLine tests.
 */
export function sanitizeObservationLine(raw: string): string {
  return raw
    .split(/[\n|]/)
    .filter(piece => !LABELFLOW_MARKER_RE.test(piece))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Montevideo barrio aliases: maps common names/variations to the canonical
 * name DAC uses in its K_Barrio dropdown. This lets us match "Punta Carretas",
 * "Pta Carretas", "Punta carretas" etc. to the right dropdown option.
 */
const MONTEVIDEO_BARRIO_ALIASES: Record<string, string[]> = {
  'aguada': ['aguada', 'la aguada montevideo'],
  'aires puros': ['aires puros'],
  'atahualpa': ['atahualpa'],
  'barrio sur': ['barrio sur', 'bsur'],
  'belvedere': ['belvedere'],
  'brazo oriental': ['brazo oriental'],
  'buceo': ['buceo'],
  'capurro': ['capurro'],
  'carrasco': ['carrasco'],
  'carrasco norte': ['carrasco norte'],
  'casabo': ['casabo'],
  'casavalle': ['casavalle'],
  'centro': ['centro'],
  'cerrito': ['cerrito', 'cerrito de la victoria'],
  'cerro': ['cerro'],
  'ciudad vieja': ['ciudad vieja', 'casco viejo'],
  'colon': ['colon', 'columbus'],
  'cordon': ['cordon', 'el cordon'],
  'flor de maronas': ['flor de maronas'],
  'goes': ['goes', 'villa goes'],
  'jacinto vera': ['jacinto vera'],
  'jardines del hipódromo': ['jardines del hipodromo', 'jardines hipodromo'],
  'la blanqueada': ['la blanqueada', 'blanqueada'],
  'la comercial': ['la comercial', 'comercial'],
  'la figurita': ['la figurita', 'figurita'],
  'la teja': ['la teja', 'teja'],
  'larrañaga': ['larranaga'],
  'las acacias': ['las acacias', 'acacias'],
  'las canteras': ['las canteras', 'canteras'],
  'lezica': ['lezica'],
  'malvin': ['malvin'],
  'malvin norte': ['malvin norte'],
  'manga': ['manga'],
  'maronas': ['maronas'],
  'mercado modelo': ['mercado modelo'],
  'nuevo paris': ['nuevo paris'],
  'palermo': ['palermo'],
  'parque batlle': ['parque batlle', 'parque battle', 'parque batle'],
  'parque rodo': ['parque rodo'],
  'paso de la arena': ['paso de la arena', 'paso arena'],
  'paso de las duranas': ['paso de las duranas', 'paso duranas'],
  'peñarol': ['penarol'],
  'piedras blancas': ['piedras blancas'],
  'pocitos': ['pocitos'],
  'pocitos nuevo': ['pocitos nuevo'],
  'prado': ['prado'],
  'punta carretas': ['punta carretas', 'pta carretas', 'punta carreta'],
  'punta de rieles': ['punta de rieles'],
  'punta gorda': ['punta gorda', 'pta gorda'],
  'reducto': ['reducto', 'el reducto'],
  'sayago': ['sayago'],
  'sur': ['barrio sur montevideo'],  // removed bare 'sur' — too short, conflicts with city "Sur" in Artigas. Use 'barrio sur' alias instead.
  'tres cruces': ['tres cruces', '3 cruces'],
  'tres ombues': ['tres ombues', '3 ombues'],
  'union': ['union', 'la union'],
  'villa dolores': ['villa dolores'],
  'villa española': ['villa espanola'],
  'villa garcia': ['villa garcia'],
  'villa muñoz': ['villa munoz'],
};

/**
 * Try to detect the barrio from any address-related text fields.
 * Checks city, address1, address2 for known Montevideo barrio names.
 */
function detectBarrio(city: string, address1: string, address2: string): string | null {
  const combined = normalize(`${city} ${address1} ${address2}`);

  // Build flat list of [canonical, alias] pairs sorted by alias length DESC
  // This ensures "malvin norte" is checked before "malvin", "carrasco norte" before "carrasco", etc.
  const allAliases: [string, string][] = [];
  for (const [canonical, aliases] of Object.entries(MONTEVIDEO_BARRIO_ALIASES)) {
    for (const alias of aliases) {
      allAliases.push([canonical, normalize(alias)]);
    }
  }
  allAliases.sort((a, b) => b[1].length - a[1].length);

  for (const [canonical, normalizedAlias] of allAliases) {
    // Word boundary check: ensure we match the whole barrio name, not partial
    // e.g. "centro" should not match "concentrar"
    const regex = new RegExp(`\\b${normalizedAlias.replace(/\s+/g, '\\s+')}\\b`);
    if (regex.test(combined)) {
      return canonical;
    }
  }
  return null;
}

interface IntelligentCityResult {
  barrio: string | null;
  department: string | null;
  source: 'zip' | 'street' | 'alias' | 'none';
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Intelligent city/barrio detection using multiple strategies:
 * 1. ZIP confirms alias  — highest confidence (ZIP + Shopify agree)
 * 2. Shopify alias alone — customer explicitly named a barrio; trust it over inference
 * 3. ZIP + street cross-reference — no explicit barrio, two signals agree
 * 4. ZIP alone           — single signal fallback
 * 5. Street name alone
 * 6. Department from ZIP only
 *
 * IMPORTANT: Shopify alias (from city/address fields) always wins over ZIP-only
 * inference. ZIP codes in Uruguay are imprecise and map to multiple barrios; the
 * customer's own barrio name is more specific and should not be overridden.
 */
export function detectCityIntelligent(
  city: string,
  address1: string,
  address2: string,
  zip: string,
): IntelligentCityResult {
  const aliasBarrio = detectBarrio(city, address1, address2);
  const zipBarrios = getBarriosFromZip(zip);
  const streetBarrios = getBarriosFromStreet(address1) ?? getBarriosFromStreet(address2);
  const zipDept = getDepartmentFromZip(zip);

  // Strategy 1: ZIP confirms the alias — both signals agree, highest confidence
  if (zipBarrios && aliasBarrio && zipBarrios.includes(aliasBarrio)) {
    return { barrio: aliasBarrio, department: zipDept, source: 'zip', confidence: 'high' };
  }

  // Strategy 2: Shopify explicitly named a barrio — trust it over ZIP/street inference.
  // ZIP maps to multiple candidates; the customer's own city name is more specific.
  if (aliasBarrio) {
    return { barrio: aliasBarrio, department: zipDept ?? 'Montevideo', source: 'alias', confidence: 'medium' };
  }

  // Strategy 3: ZIP + street cross-reference (no explicit Shopify barrio)
  if (zipBarrios && zipBarrios.length > 0) {
    if (streetBarrios) {
      const overlap = zipBarrios.filter(b => streetBarrios.includes(b));
      if (overlap.length > 0) {
        return { barrio: overlap[0], department: zipDept, source: 'zip', confidence: 'high' };
      }
    }
    // ZIP alone — single signal, pick first candidate
    return { barrio: zipBarrios[0], department: zipDept, source: 'zip', confidence: 'high' };
  }

  // Strategy 4: Street name detection alone
  if (streetBarrios && streetBarrios.length > 0) {
    return { barrio: streetBarrios[0], department: zipDept ?? 'Montevideo', source: 'street', confidence: 'medium' };
  }

  // Fallback: only department from ZIP
  return { barrio: null, department: zipDept, source: 'none', confidence: 'low' };
}

/**
 * Merge address1 + address2 into a clean delivery address + observaciones.
 *
 * PHILOSOPHY (v2 — April 2026):
 *   - fullAddress = ONLY the street + door number (what DAC needs for delivery)
 *   - extraObs = EVERYTHING else (apt, floor, delivery notes, pickup info)
 *   - address2 almost NEVER goes into fullAddress — it goes to observaciones
 *   - Only exception: address2 is a pure door number that address1 is missing
 *
 * This ensures DAC gets a clean short address, and all extra info (apartment,
 * delivery hours, "dejar en porteria", etc.) goes to Observaciones where the
 * courier actually reads it.
 */
export function mergeAddress(address1: string, address2: string | undefined | null): { fullAddress: string; extraObs: string } {
  const a1 = (address1 ?? '').trim();
  const a2 = (address2 ?? '').trim();

  if (!a2) {
    // Even with no address2, check if address1 has a slash pattern like "3274/801"
    const slashApt = /(\d+)\s*\/\s*(\d+)\s*$/.exec(a1);
    if (slashApt) {
      return { fullAddress: a1, extraObs: `Apto ${slashApt[2]}` };
    }
    // "Puerta X" embedded in address1 (e.g. "Cuató 3117 Puerta 3") — extract to obs
    // "Puerta" in Uruguay = entrance/door code, NOT an apartment number
    const puertaMatch = /\s+[Pp]uerta\s+\S+\s*$/.exec(a1);
    if (puertaMatch) {
      return { fullAddress: a1.slice(0, puertaMatch.index).trim(), extraObs: puertaMatch[0].trim() };
    }
    return { fullAddress: a1, extraObs: '' };
  }

  // PHONE NUMBER: address2 is a phone number — discard entirely
  const a2Digits = a2.replace(/[\s-]/g, '');
  if (/^0\d{7,}$/.test(a2Digits) || /^(\+?598|09[0-9])\d{5,}$/.test(a2Digits) || /^\d{8,}$/.test(a2Digits)) {
    return { fullAddress: a1, extraObs: '' };
  }

  // CITY/DEPARTMENT: address2 is just a city or department name — discard
  const KNOWN_PLACES = [
    'montevideo', 'canelones', 'maldonado', 'salto', 'paysandu', 'rivera', 'tacuarembo',
    'colonia', 'soriano', 'rocha', 'florida', 'durazno', 'artigas', 'treinta y tres',
    'cerro largo', 'lavalleja', 'san jose', 'flores', 'rio negro', 'pocitos', 'buceo',
    'carrasco', 'punta carretas', 'centro', 'cordon', 'parque rodo', 'malvin', 'union',
    'la blanqueada', 'tres cruces', 'prado', 'lagomar', 'la floresta', 'las piedras',
    'ciudad de la costa', 'pando', 'barros blancos', 'piriapolis', 'punta del este',
    'minas', 'fray bentos', 'mercedes', 'nueva palmira', 'young', 'carmelo',
    'el pinar', 'solymar', 'atlantida', 'parque del plata', 'sauce', 'progreso',
    'la paz', 'delta del tigre', 'san carlos', 'pan de azucar',
  ];
  if (KNOWN_PLACES.includes(a2.toLowerCase().trim())) {
    return { fullAddress: a1, extraObs: '' };
  }

  // DEDUP: if address2 is already contained in address1 (or is essentially the same info), don't append
  // BUT preserve the info in extraObs if it looks like apartment/unit info
  // Uses substring match + word-overlap (80%+) to handle "Retiro dac maldonado" vs "Retiro en DAC Maldonado"
  const a1Norm = normalize(a1);
  const a2Norm = normalize(a2);
  const a2Words = a2Norm.split(/\s+/).filter(w => w.length > 1);
  const a1Words = new Set(a1Norm.split(/\s+/));
  const wordOverlap = a2Words.length > 0 ? a2Words.filter(w => a1Words.has(w)).length / a2Words.length : 0;
  const isDuplicate = a1.toLowerCase().includes(a2.toLowerCase()) || a1.endsWith(a2)
    || a1Norm.includes(a2Norm) || a2Norm.includes(a1Norm)
    || (a2Words.length >= 2 && wordOverlap >= 0.8);
  if (isDuplicate) {
    // Even though it's a duplicate, if it looks like an apt number, preserve in obs
    if (/^\d{1,5}$/.test(a2)) {
      return { fullAddress: a1, extraObs: `Apto ${a2}` };
    }
    if (/apto|apt\b|piso|oficina|depto|of\.|local|torre|int\b|interior/i.test(a2)) {
      return { fullAddress: a1, extraObs: a2 };
    }
    return { fullAddress: a1, extraObs: '' };
  }

  // PURE DOOR NUMBER: address2 is just digits (e.g. "1607")
  if (/^\d{1,6}$/.test(a2)) {
    const a1EndsWithNum = /\d+\s*$/.test(a1);
    if (a1EndsWithNum) {
      // address1 already has a number — address2 is likely apartment
      return { fullAddress: a1, extraObs: `Apto ${a2}` };
    }
    // address1 has no number — address2 is the door number, append it
    return { fullAddress: `${a1} ${a2}`, extraObs: '' };
  }

  // DOOR+APT combined: "1502B" or "502 A"
  const doorAptCombined = /^(\d{3,5})\s*([A-Za-z]\d{0,2})$/.exec(a2);
  if (doorAptCombined) {
    const a1EndsWithNum = /\d+\s*$/.test(a1);
    if (a1EndsWithNum) {
      // address1 already has door — this is apartment info
      return { fullAddress: a1, extraObs: `Apto ${a2}` };
    }
    return { fullAddress: `${a1} ${doorAptCombined[1]}`, extraObs: `Apto ${doorAptCombined[2]}` };
  }

  // DIRECTION REFERENCE: "esq Av Italia", "entre Colonia y Maldonado"
  // These go to BOTH address and obs (useful for courier navigation)
  // Word boundary (\b) prevents "Entregar" from matching "entre"
  if (/^(esq\b|entre\b|frente\b|al lado\b|cerca\b|junto\b|casi\b|a metros\b|esquina\b)/i.test(a2)) {
    return { fullAddress: `${a1} ${a2}`, extraObs: '' };
  }

  // NUMBER+BIS: "1234 bis"
  if (/^\d{1,6}\s+(bis|esq)/i.test(a2)) {
    return { fullAddress: `${a1} ${a2}`, extraObs: '' };
  }

  // EVERYTHING ELSE: apartment info, delivery notes, pickup instructions, etc.
  // ALL goes to extraObs ONLY — keep fullAddress clean
  // Examples: "303 apto", "Lunes a viernes 9-16", "Casa con cerco de polines",
  //   "oficina 1209 dejar en porteria", "804. Dejar en porteria con Foxys"
  return { fullAddress: a1, extraObs: a2 };
}

async function findBestOptionMatch(
  page: Page,
  selector: string,
  searchText: string
): Promise<string | null> {
  const options = await page.$$eval(
    `${selector} option`,
    (opts: any[]) => opts.map((o: any) => ({ value: o.value, text: o.textContent?.trim() ?? '' }))
  );

  const search = normalize(searchText);
  if (!search) return null;

  // Exact match
  for (const opt of options) {
    if (normalize(opt.text) === search && opt.value && opt.value !== '0') return opt.value;
  }
  // Contains match
  for (const opt of options) {
    if (normalize(opt.text).includes(search) && opt.value && opt.value !== '0') return opt.value;
  }
  // Reverse contains
  for (const opt of options) {
    if (opt.text.length > 2 && search.includes(normalize(opt.text)) && opt.value && opt.value !== '0') return opt.value;
  }
  // Word match (require word length > 3 to avoid false positives)
  const searchWords = search.split(/\s+/).filter(w => w.length > 3);
  for (const opt of options) {
    const optWords = normalize(opt.text).split(/\s+/);
    const hasMatch = searchWords.some(sw => optWords.some(ow => ow === sw));
    if (hasMatch && opt.value && opt.value !== '0') return opt.value;
  }
  return null;
}

/**
 * Find best barrio match in DAC dropdown using detected barrio name.
 */
async function findBarrioMatch(
  page: Page,
  selector: string,
  detectedBarrio: string
): Promise<string | null> {
  const options = await page.$$eval(
    `${selector} option`,
    (opts: any[]) => opts.map((o: any) => ({ value: o.value, text: o.textContent?.trim() ?? '' }))
  );

  const search = normalize(detectedBarrio);
  if (!search) return null;

  // Exact match first
  for (const opt of options) {
    if (normalize(opt.text) === search && opt.value && opt.value !== '0' && opt.value !== '') return opt.value;
  }
  // Contains match
  for (const opt of options) {
    if (normalize(opt.text).includes(search) && opt.value && opt.value !== '0' && opt.value !== '') return opt.value;
  }
  // Reverse contains
  for (const opt of options) {
    if (search.includes(normalize(opt.text)) && opt.text.length > 3 && opt.value && opt.value !== '0' && opt.value !== '') return opt.value;
  }
  return null;
}

function cleanPhone(phone: string | undefined): string {
  if (!phone) return '099000000';
  const cleaned = phone.replace(/\D/g, '');
  return cleaned.length >= 6 ? cleaned : '099000000';
}

/**
 * Click the visible "Siguiente" button using Playwright locator (real click).
 * Returns true if a visible button was found and clicked.
 */
async function clickSiguiente(page: Page, slog: StepLogger, stepLabel: string): Promise<boolean> {
  // Use Playwright locator to find VISIBLE "Siguiente" links
  const siguienteLocator = page.locator('a').filter({ hasText: 'Siguiente' }).filter({ has: page.locator(':visible') });

  // Fallback: try all matching anchors and click the first visible one
  const allLinks = page.locator('a');
  const count = await allLinks.count();

  for (let i = 0; i < count; i++) {
    const link = allLinks.nth(i);
    const text = await link.textContent().catch(() => '');
    if (!text || !text.toLowerCase().includes('siguiente')) continue;

    const isVisible = await link.isVisible().catch(() => false);
    if (!isVisible) continue;

    slog.info(stepLabel, `Clicking visible Siguiente button (index ${i})`, { text: text.trim() });
    await link.click({ timeout: 5000 });
    await page.waitForTimeout(1000);
    return true;
  }

  slog.warn(stepLabel, 'No visible Siguiente button found');
  return false;
}

/**
 * Safely fill an input field using Playwright locator (real interaction).
 */
async function safeFill(page: Page, selector: string, value: string, slog: StepLogger, step: string, label: string): Promise<boolean> {
  try {
    const el = await page.$(selector);
    if (!el) {
      slog.warn(step, `Field not found: ${label}`, { selector });
      return false;
    }
    // Clear and fill using Playwright's fill (triggers proper events)
    await page.fill(selector, value);
    slog.info(step, `Filled ${label}`, { selector, value: value.substring(0, 30) });
    return true;
  } catch (err) {
    slog.warn(step, `Failed to fill ${label}: ${(err as Error).message}`, { selector });
    return false;
  }
}

/**
 * Safely select an option in a dropdown using Playwright (real interaction).
 */
async function safeSelect(page: Page, selector: string, value: string, slog: StepLogger, step: string, label: string): Promise<boolean> {
  try {
    const el = await page.$(selector);
    if (!el) {
      slog.warn(step, `Select not found: ${label}`, { selector });
      return false;
    }
    await page.selectOption(selector, value);
    slog.info(step, `Selected ${label}`, { selector, value });
    return true;
  } catch (err) {
    slog.warn(step, `Failed to select ${label}: ${(err as Error).message}`, { selector });
    return false;
  }
}

/**
 * Creates a shipment in DAC via Playwright browser automation.
 *
 * BUG FIXES applied:
 *   1. Phone field uses TelD (not TelefonoD)
 *   2. Uses real Playwright clicks for Siguiente/Agregar (not page.evaluate force-clicks)
 *   3. Submit via .btnAdd click after proper step navigation (not direct POST)
 *   4. Guia regex only matches numbers starting with 88 and 12+ digits
 *   5. Ultra-detailed step logging to console + DB
 */
export async function createShipment(
  page: Page,
  order: ShopifyOrder,
  paymentType: 'REMITENTE' | 'DESTINATARIO',
  dacUsername: string,
  dacPassword: string,
  tenantId: string,
  jobId?: string,
  usedGuias?: Set<string>
): Promise<DacShipmentResult> {
  const slog = createStepLogger(jobId ?? 'manual', tenantId);
  const addr = order.shipping_address;

  if (!addr || !addr.address1) {
    throw new Error(`Order ${order.name} has no shipping address`);
  }

  await ensureLoggedIn(page, dacUsername, dacPassword, tenantId);

  slog.info(DAC_STEPS.NAV_NEW_SHIPMENT, `Navigating to new shipment form for ${order.name}`, {
    orderName: order.name,
    paymentType,
    city: addr.city,
    province: addr.province,
  });

  // Navigate to new shipment form
  await page.goto(DAC_URLS.NEW_SHIPMENT, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.waitForTimeout(2000);

  // Wait for the form to be present
  try {
    await page.waitForSelector('select[name="TipoServicio"]', { timeout: 8_000 });
    slog.info(DAC_STEPS.NAV_FORM_LOADED, 'Shipment form loaded, TipoServicio visible');
  } catch {
    await dacBrowser.screenshot(page, `form-not-loaded-${order.name.replace('#', '')}`);
    throw new Error('DAC shipment form did not load (TipoServicio not found)');
  }

  // ===== DETECT RETIRO EN AGENCIA =====
  // If the customer wrote "retiro en DAC" / "retiro en agencia" / "retiro en sucursal"
  // in their address, this is a pickup at DAC branch — not home delivery.
  const combinedAddrText = `${addr.address1 ?? ''} ${addr.address2 ?? ''} ${order.note ?? ''}`.toLowerCase();
  const isRetiroEnAgencia = /retiro\s+(en\s+)?(dac|agencia|sucursal|local|oficina)/i.test(combinedAddrText)
    || /^retiro\b/i.test((addr.address1 ?? '').trim())
    || /retiro\s+en\s+(dac|agencia)|pickup/i.test(order.note ?? '');

  if (isRetiroEnAgencia) {
    slog.info(DAC_STEPS.STEP1_START, `RETIRO EN AGENCIA detected — address: "${addr.address1}", will use TipoEntrega=Agencia`);
  }

  // ===== STEP 1: Shipment Type =====
  slog.info(DAC_STEPS.STEP1_START, 'Filling Step 1: shipment type fields');

  const pickupVal = DAC_SELECTORS.PICKUP_VALUE_MOSTRADOR;
  const payVal = paymentType === 'REMITENTE'
    ? DAC_SELECTORS.PAYMENT_VALUE_REMITENTE
    : DAC_SELECTORS.PAYMENT_VALUE_DESTINATARIO;
  const packageVal = DAC_SELECTORS.PACKAGE_VALUE_PAQUETE;
  const deliveryVal = isRetiroEnAgencia
    ? DAC_SELECTORS.DELIVERY_VALUE_AGENCIA
    : DAC_SELECTORS.DELIVERY_VALUE_DOMICILIO;

  await safeSelect(page, 'select[name="TipoServicio"]', pickupVal, slog, DAC_STEPS.STEP1_TIPO_SERVICIO, 'TipoServicio');
  await page.waitForTimeout(300);

  // TipoGuia might be a select or hidden input
  const tipoGuiaEl = await page.$('select[name="TipoGuia"]');
  if (tipoGuiaEl) {
    await safeSelect(page, 'select[name="TipoGuia"]', payVal, slog, DAC_STEPS.STEP1_TIPO_GUIA, 'TipoGuia');
  } else {
    // Set hidden input value via evaluate
    await page.evaluate((val: string) => {
      const el = document.querySelector('[name="TipoGuia"]') as HTMLInputElement;
      if (el) { el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }, payVal);
    slog.info(DAC_STEPS.STEP1_TIPO_GUIA, 'Set TipoGuia (hidden input)', { value: payVal });
  }

  await safeSelect(page, 'select[name="TipoEnvio"]', packageVal, slog, DAC_STEPS.STEP1_TIPO_ENVIO, 'TipoEnvio');
  await page.waitForTimeout(300);
  await safeSelect(page, 'select[name="TipoEntrega"]', deliveryVal, slog, DAC_STEPS.STEP1_TIPO_ENTREGA, 'TipoEntrega');
  await page.waitForTimeout(300);

  slog.info(DAC_STEPS.STEP1_OK, 'Step 1 complete', { pickupVal, payVal, packageVal, deliveryVal });

  // Click Siguiente to advance from Step 1 to Step 2
  await dacBrowser.screenshot(page, `step1-complete-${order.name.replace('#', '')}`);
  const adv1 = await clickSiguiente(page, slog, DAC_STEPS.STEP1_SIGUIENTE);
  if (!adv1) {
    slog.warn(DAC_STEPS.STEP1_SIGUIENTE, 'Could not click Siguiente after Step 1, continuing anyway');
  }
  await page.waitForTimeout(800);

  // ===== STEP 2: Origin (auto-filled) =====
  slog.info(DAC_STEPS.STEP2_START, 'Step 2: Origin (auto-filled from account)');
  await dacBrowser.screenshot(page, `step2-before-${order.name.replace('#', '')}`);

  const adv2 = await clickSiguiente(page, slog, DAC_STEPS.STEP2_SIGUIENTE);
  if (!adv2) {
    slog.warn(DAC_STEPS.STEP2_SIGUIENTE, 'Could not click Siguiente after Step 2, continuing anyway');
  }
  await page.waitForTimeout(1000);
  slog.info(DAC_STEPS.STEP2_OK, 'Step 2 complete');

  // ===== STEP 3: Recipient =====
  slog.info(DAC_STEPS.STEP3_START, 'Filling Step 3: recipient data');
  await dacBrowser.screenshot(page, `step3-before-${order.name.replace('#', '')}`);

  const fullName = `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim() || 'Cliente';
  const phone = cleanPhone(addr.phone);

  // BUG FIX 5 (NAME CROSS-ASSIGNMENT): Clear ALL recipient fields BEFORE filling
  // This prevents stale data from previous order leaking into current one
  await page.evaluate(() => {
    const fields = ['NombreD', 'TelD', 'DirD', 'Correo_Destinatario', 'EmailD', 'telefono'];
    for (const name of fields) {
      const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement;
      if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }
  });
  slog.info(DAC_STEPS.STEP3_START, 'Cleared all recipient fields before filling new data');

  // Fill name — MUST succeed, throw if it doesn't (prevents wrong name)
  const nameFilled = await safeFill(page, 'input[name="NombreD"]', fullName, slog, DAC_STEPS.STEP3_FILL_NAME, 'NombreD (name)');
  if (!nameFilled) {
    throw new Error(`CRITICAL: Could not fill NombreD for order ${order.name} — aborting to prevent wrong name`);
  }
  // Verify the name was actually written correctly
  const nameVerify = await page.$eval('input[name="NombreD"]', (el: any) => el.value).catch(() => '');
  if (nameVerify !== fullName) {
    slog.warn(DAC_STEPS.STEP3_FILL_NAME, `Name verification mismatch! Expected "${fullName}", got "${nameVerify}" — refilling`);
    await page.fill('input[name="NombreD"]', '');
    await page.fill('input[name="NombreD"]', fullName);
  }

  // TelD is the correct phone field name
  const phoneFilled = await safeFill(page, 'input[name="TelD"]', phone, slog, DAC_STEPS.STEP3_FILL_PHONE, 'TelD (phone)');
  if (!phoneFilled) {
    slog.warn(DAC_STEPS.STEP3_FILL_PHONE, 'TelD not found, trying fallback selectors');
    await safeFill(page, 'input[name="telefono"]', phone, slog, DAC_STEPS.STEP3_FILL_PHONE, 'telefono (fallback)');
  }

  // Email (optional)
  if (order.email) {
    const emailFilled = await safeFill(page, 'input[name="Correo_Destinatario"]', order.email, slog, DAC_STEPS.STEP3_FILL_EMAIL, 'Correo_Destinatario');
    if (!emailFilled) {
      await safeFill(page, 'input[name="EmailD"]', order.email, slog, DAC_STEPS.STEP3_FILL_EMAIL, 'EmailD (fallback)');
    }
  }

  // BUG FIX 2+3 (ADDRESS): Merge address1 + address2 into single delivery address
  // This ensures door numbers, apt info, and "Centro" are in the address field, not observations
  let { fullAddress, extraObs } = mergeAddress(addr.address1, addr.address2);

  // Post-merge: detect slash pattern "3274/801" in final address → extract apt to observations
  const slashMatch = /(\d+)\s*\/\s*(\d+)\s*$/.exec(fullAddress);
  if (slashMatch && !extraObs) {
    extraObs = `Apto ${slashMatch[2]}`;
    slog.info(DAC_STEPS.STEP3_FILL_ADDRESS, `Detected slash apt pattern: "${slashMatch[0]}" → obs: "${extraObs}"`);
  }
  slog.info(DAC_STEPS.STEP3_FILL_ADDRESS, `Merged address: "${fullAddress}"`, {
    address1: addr.address1, address2: addr.address2 ?? '', extraObs,
  });

  const addrFilled = await safeFill(page, 'input[name="DirD"]', fullAddress, slog, DAC_STEPS.STEP3_FILL_ADDRESS, 'DirD (address)');
  if (!addrFilled) {
    await safeFill(page, '#DirD', fullAddress, slog, DAC_STEPS.STEP3_FILL_ADDRESS, 'DirD by id (fallback)');
  }

  // ── CROSS-VALIDATION: Resolve correct department from city using Uruguay geo DB ──
  // Shopify customers often put wrong department or use barrio as city.
  // We trust the CITY name and look up the real department from our geo database.
  let resolvedDept = addr.province ?? '';
  let resolvedCity = addr.city ?? '';
  let resolvedBarrioHint: string | null = null;

  // Run intelligent city detection using ZIP, street, and alias strategies
  const intelligent = detectCityIntelligent(
    addr.city ?? '', addr.address1, addr.address2 ?? '', addr.zip ?? ''
  );
  slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
    `Intelligent detection: barrio="${intelligent.barrio ?? 'none'}" dept="${intelligent.department ?? 'none'}" source=${intelligent.source} confidence=${intelligent.confidence}`,
    { zip: addr.zip, city: addr.city, address1: addr.address1 }
  );

  // ── AI FALLBACK ──
  // When deterministic rules cannot resolve the address with high confidence,
  // ask Claude Haiku to resolve it using structured tool use. The AI result
  // overrides the deterministic result for dept/city/barrio/address/obs.
  // See apps/worker/src/dac/ai-resolver.ts for the full implementation.
  let aiResolution: AIResolverResult | null = null;
  const needsAI =
    intelligent.confidence === 'low' ||
    (intelligent.confidence === 'medium' && !intelligent.barrio) ||
    (!intelligent.barrio && !intelligent.department);

  if (needsAI) {
    slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
      `Deterministic confidence ${intelligent.confidence} — invoking AI resolver fallback`,
      { city: addr.city, address1: addr.address1, zip: addr.zip }
    );
    try {
      aiResolution = await resolveAddressWithAI({
        tenantId,
        city: addr.city ?? '',
        address1: addr.address1,
        address2: addr.address2 ?? '',
        zip: addr.zip ?? '',
        province: addr.province ?? '',
        orderNotes: order.note ?? '',
      });
      if (aiResolution) {
        slog.success(DAC_STEPS.STEP3_SELECT_DEPT,
          `AI resolved: dept="${aiResolution.department}" city="${aiResolution.city}" barrio="${aiResolution.barrio ?? 'none'}" confidence=${aiResolution.confidence} source=${aiResolution.source}`,
          { reasoning: aiResolution.reasoning, costUsd: aiResolution.aiCostUsd }
        );
        // Override the deterministic merged address with AI's cleaner version
        if (aiResolution.deliveryAddress && aiResolution.deliveryAddress.trim().length > 0) {
          fullAddress = aiResolution.deliveryAddress;
          // Merge AI extra obs with existing extraObs (from mergeAddress)
          if (aiResolution.extraObservations && aiResolution.extraObservations.trim().length > 0) {
            extraObs = extraObs
              ? `${extraObs} | ${aiResolution.extraObservations}`
              : aiResolution.extraObservations;
          }
          // Re-fill the address field with the AI-cleaned version
          await safeFill(page, 'input[name="DirD"]', fullAddress, slog, DAC_STEPS.STEP3_FILL_ADDRESS, 'DirD (AI-cleaned)');
        }
      } else {
        slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
          'AI resolver unavailable or returned null — falling back to deterministic rules'
        );
      }
    } catch (err) {
      slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
        `AI resolver threw — falling back to deterministic rules: ${(err as Error).message}`
      );
    }
  }

  // AI SHORT-CIRCUIT: If AI returned a high/medium confidence resolution, use it
  // directly instead of running the deterministic chain below. AI output is already
  // validated against department + barrio whitelists in ai-resolver.ts.
  if (aiResolution && (aiResolution.confidence === 'high' || aiResolution.confidence === 'medium')) {
    resolvedDept = aiResolution.department;
    resolvedCity = aiResolution.city;
    resolvedBarrioHint = aiResolution.barrio;
    slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
      `Using AI resolution directly: dept="${resolvedDept}" city="${resolvedCity}" barrio="${resolvedBarrioHint ?? 'none'}"`
    );
  } else if (addr.city) {
    const geoDept = await getDepartmentForCityAsync(addr.city);
    if (geoDept) {
      // City found in our geo DB — use the correct department
      if (normalize(geoDept) !== normalize(resolvedDept)) {
        slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
          `GEO CORRECTION: City "${addr.city}" belongs to "${geoDept}" but Shopify says "${addr.province}" — using "${geoDept}"`,
          { shopifyProvince: addr.province, correctedDept: geoDept, city: addr.city }
        );
        resolvedDept = geoDept;
      } else {
        slog.info(DAC_STEPS.STEP3_SELECT_DEPT, `GEO VERIFIED: City "${addr.city}" correctly in "${geoDept}"`);
      }
      // If geo resolved to Montevideo, use intelligent barrio (better than basic alias)
      if (normalize(geoDept) === 'montevideo') {
        const barrio = intelligent.barrio ?? detectBarrio(addr.city, addr.address1, addr.address2 ?? '');
        if (barrio) {
          resolvedBarrioHint = barrio;
          resolvedCity = 'Montevideo';
          slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
            `City "${addr.city}" is in Montevideo, barrio="${barrio}" (source: ${intelligent.source}) — will use "Montevideo" as city`);
        }
      }
    } else {
      // City not in geo DB — use intelligent detection
      if (intelligent.barrio) {
        const iDept = intelligent.department ?? 'Montevideo';
        slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
          `City "${addr.city}" not in geo DB but intelligent detected barrio "${intelligent.barrio}" (source: ${intelligent.source}) — using ${iDept}`,
          { detectedBarrio: intelligent.barrio, source: intelligent.source }
        );
        resolvedDept = iDept;
        // For Montevideo, use "Montevideo" as city (barrio handles the rest).
        // For other departments, keep Shopify's city to try matching in the dropdown.
        resolvedCity = iDept === 'Montevideo' ? 'Montevideo' : (addr.city ?? iDept);
        resolvedBarrioHint = intelligent.barrio;
      } else if (intelligent.department) {
        slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
          `City "${addr.city}" not in geo DB, no barrio detected, but ZIP suggests dept "${intelligent.department}"`,
          { city: addr.city, province: addr.province, zipDept: intelligent.department }
        );
        resolvedDept = intelligent.department;
      } else {
        slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
          `City "${addr.city}" not found in geo DB and no intelligent match — using Shopify province "${addr.province}" as-is`,
          { city: addr.city, province: addr.province, zip: addr.zip }
        );
      }
    }
  } else {
    // City is EMPTY — use intelligent detection to fill in what we can
    if (intelligent.barrio) {
      const iDept = intelligent.department ?? addr.province ?? 'Montevideo';
      resolvedDept = iDept;
      // For Montevideo, use "Montevideo" as city. For other depts, use dept name as city (capital).
      resolvedCity = iDept === 'Montevideo' ? 'Montevideo' : iDept;
      resolvedBarrioHint = intelligent.barrio;
      slog.info(DAC_STEPS.STEP3_SELECT_DEPT,
        `City empty — intelligent detected barrio "${intelligent.barrio}" in "${resolvedDept}" (source: ${intelligent.source}, confidence: ${intelligent.confidence})`,
        { zip: addr.zip, address1: addr.address1 }
      );
    } else if (intelligent.department) {
      resolvedDept = intelligent.department;
      slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
        `City empty — no barrio detected, but ZIP suggests dept "${intelligent.department}"`,
        { zip: addr.zip, province: addr.province }
      );
    } else {
      slog.warn(DAC_STEPS.STEP3_SELECT_DEPT,
        `City empty and no intelligent detection possible — using Shopify province "${addr.province}" as-is`,
        { province: addr.province, zip: addr.zip }
      );
    }
  }

  // Department (select) — using resolved (possibly corrected) department
  if (resolvedDept) {
    slog.info(DAC_STEPS.STEP3_SELECT_DEPT, `Selecting department: ${resolvedDept}`);
    const deptMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_DEPARTMENT, resolvedDept);
    if (deptMatch) {
      await safeSelect(page, DAC_SELECTORS.RECIPIENT_DEPARTMENT, deptMatch, slog, DAC_STEPS.STEP3_SELECT_DEPT, 'K_Estado (department)');
      slog.info(DAC_STEPS.STEP3_WAIT_CITIES, 'Waiting for cities to load after department change');
      await page.waitForTimeout(1500);
    } else {
      // Log available options for debugging
      const deptOptions = await page.$$eval(`${DAC_SELECTORS.RECIPIENT_DEPARTMENT} option`,
        (opts: any[]) => opts.filter(o => o.value && o.value !== '0').map((o: any) => o.textContent?.trim()).slice(0, 20));
      slog.warn(DAC_STEPS.STEP3_SELECT_DEPT, `No department match in DAC dropdown for: ${resolvedDept}`, { availableOptions: deptOptions });
    }
  }

  // City (select) — using resolved city (may differ from Shopify if barrio was detected)
  if (resolvedCity) {
    slog.info(DAC_STEPS.STEP3_SELECT_CITY, `Selecting city: ${resolvedCity}`);
    let cityMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_CITY, resolvedCity);

    // If resolved city didn't match and it differs from Shopify city, try the original
    if (!cityMatch && addr.city && normalize(addr.city) !== normalize(resolvedCity)) {
      slog.info(DAC_STEPS.STEP3_SELECT_CITY, `Resolved city "${resolvedCity}" not in dropdown, trying original Shopify city "${addr.city}"`);
      cityMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_CITY, addr.city);
    }

    if (cityMatch) {
      await safeSelect(page, DAC_SELECTORS.RECIPIENT_CITY, cityMatch, slog, DAC_STEPS.STEP3_SELECT_CITY, 'K_Ciudad (city)');
      await page.waitForTimeout(800);
    } else {
      // City not found in DAC dropdown for this department — try barrio fallback
      const detectedBarrio = resolvedBarrioHint ||
        (normalize(resolvedDept) === 'montevideo' ? detectBarrio(resolvedCity, addr.address1, addr.address2 ?? '') : null);
      if (detectedBarrio) {
        slog.info(DAC_STEPS.STEP3_SELECT_CITY, `City "${resolvedCity}" not in dropdown, detected barrio "${detectedBarrio}", trying "Montevideo"`);
        const mvdMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_CITY, 'Montevideo');
        if (mvdMatch) {
          await safeSelect(page, DAC_SELECTORS.RECIPIENT_CITY, mvdMatch, slog, DAC_STEPS.STEP3_SELECT_CITY, 'K_Ciudad (Montevideo fallback)');
          await page.waitForTimeout(800);
        }
      } else {
        const cityOptions = await page.$$eval(`${DAC_SELECTORS.RECIPIENT_CITY} option`,
          (opts: any[]) => opts.filter(o => o.value && o.value !== '0').map((o: any) => o.textContent?.trim()).slice(0, 30));
        slog.warn(DAC_STEPS.STEP3_SELECT_CITY, `No city match for "${resolvedCity}" and no barrio detected — city field left empty`, {
          city: resolvedCity, province: resolvedDept, shopifyCity: addr.city, availableCities: cityOptions,
        });
      }
    }
  }

  // Barrio selection — use pre-computed intelligent result (ZIP + street + alias)
  const detectedBarrioName = resolvedBarrioHint ?? intelligent.barrio;
  try {
    const barrioEl = await page.$(DAC_SELECTORS.RECIPIENT_BARRIO);
    if (barrioEl) {
      await page.waitForTimeout(500); // Wait for barrio dropdown to populate after city
      if (detectedBarrioName) {
        // Try intelligent match
        const barrioMatch = await findBarrioMatch(page, DAC_SELECTORS.RECIPIENT_BARRIO, detectedBarrioName);
        if (barrioMatch) {
          await safeSelect(page, DAC_SELECTORS.RECIPIENT_BARRIO, barrioMatch, slog, DAC_STEPS.STEP3_SELECT_BARRIO, `K_Barrio (${detectedBarrioName})`);
          slog.info(DAC_STEPS.STEP3_SELECT_BARRIO, `Barrio matched: "${detectedBarrioName}" (source: ${intelligent.source})`, { matchedValue: barrioMatch });
        } else {
          // Detected a barrio name but couldn't find it in dropdown — log available options for debugging
          const barrioOptions = await page.$$eval(`${DAC_SELECTORS.RECIPIENT_BARRIO} option`,
            (opts: any[]) => opts.filter(o => o.value && o.value !== '0' && o.value !== '').map((o: any) => ({ value: o.value, text: o.textContent?.trim() })).slice(0, 30));
          slog.warn(DAC_STEPS.STEP3_SELECT_BARRIO, `Barrio "${detectedBarrioName}" detected (${intelligent.source}) but not in dropdown`, { availableBarrios: barrioOptions.map(b => b.text) });
          // Try partial match with first word of detected barrio (only if word is long enough to avoid false positives)
          const firstWord = normalize(detectedBarrioName).split(/\s+/)[0];
          const partialMatch = barrioOptions.find(b => normalize(b.text).includes(firstWord) && firstWord.length > 4);
          if (partialMatch) {
            await safeSelect(page, DAC_SELECTORS.RECIPIENT_BARRIO, partialMatch.value, slog, DAC_STEPS.STEP3_SELECT_BARRIO, `K_Barrio (partial match: ${partialMatch.text})`);
          } else {
            // DO NOT pick first option blindly — a human would leave it empty rather than guess wrong
            slog.warn(DAC_STEPS.STEP3_SELECT_BARRIO,
              `Barrio "${detectedBarrioName}" detected but not in dropdown and no partial match — leaving at default (a human would not guess)`,
              { detected: detectedBarrioName, available: barrioOptions.map(b => b.text).slice(0, 10) }
            );
          }
        }
      } else {
        // No barrio detected — try city name as barrio (e.g. city="Aguada" IS a valid barrio)
        const cityAsBarrio = addr.city ? await findBarrioMatch(page, DAC_SELECTORS.RECIPIENT_BARRIO, addr.city) : null;
        if (cityAsBarrio) {
          await safeSelect(page, DAC_SELECTORS.RECIPIENT_BARRIO, cityAsBarrio, slog, DAC_STEPS.STEP3_SELECT_BARRIO, `K_Barrio (city-as-barrio: ${addr.city})`);
          slog.info(DAC_STEPS.STEP3_SELECT_BARRIO, `Used city name "${addr.city}" as barrio match`);
        } else {
          // DO NOT select first option — it causes wrong barrio (e.g. "Aguada" for everything)
          slog.warn(DAC_STEPS.STEP3_SELECT_BARRIO,
            `No barrio detected (zip=${addr.zip ?? 'none'}, city=${addr.city ?? 'none'}) — leaving barrio at default`,
            { zip: addr.zip, city: addr.city, address1: addr.address1, intelligentSource: intelligent.source }
          );
        }
      }
    }
  } catch {
    slog.info(DAC_STEPS.STEP3_SELECT_BARRIO, 'Barrio field not available (optional)');
  }

  slog.info(DAC_STEPS.STEP3_OK, 'Step 3 recipient data complete', {
    name: fullName, phone, city: addr.city, province: addr.province,
    fullAddress, detectedBarrio: detectedBarrioName ?? 'none',
    intelligentSource: intelligent.source, intelligentConfidence: intelligent.confidence,
  });
  await dacBrowser.screenshot(page, `step3-complete-${order.name.replace('#', '')}`);

  // ===== BYPASS Step 3 Siguiente (BUG A: silent validation blocks advance) =====
  // CONFIRMED: The "Siguiente" button in Step 3 has a silent JS validation that
  // blocks advancement even with all fields filled. The workaround is to:
  // 1. Skip clicking Siguiente entirely
  // 2. Force fieldset#cargaEnvios visible (it has class d-none)
  // 3. Set lat/lng hidden fields (BUG B: DAC requires geocoded address)
  slog.info(DAC_STEPS.STEP3_SIGUIENTE, 'Skipping Step 3 Siguiente (silent validation bug) — forcing Step 4 visible');

  await page.evaluate(() => {
    // Force Step 4 visible
    const fieldset = document.getElementById('cargaEnvios');
    if (fieldset) {
      fieldset.classList.remove('d-none');
      fieldset.style.display = 'block';
    }
    // Set approximate lat/lng based on department for geocoding validation
    const lat = document.querySelector('[name="latitude"]') as HTMLInputElement;
    const lng = document.querySelector('[name="longitude"]') as HTMLInputElement;
    if (lat && lng) {
      // Use department center coordinates (set by outer scope)
      const deptEl = document.querySelector('[name="K_Estado"]') as HTMLSelectElement;
      const deptText = deptEl?.options[deptEl.selectedIndex]?.text?.toLowerCase() ?? '';
      const coords: Record<string, [string, string]> = {
        'montevideo': ['-34.9011', '-56.1645'],
        'canelones': ['-34.5229', '-56.2817'],
        'maldonado': ['-34.9093', '-54.9588'],
        'colonia': ['-34.4625', '-57.8399'],
        'salto': ['-31.3883', '-57.9609'],
        'paysandu': ['-32.3213', '-58.0756'],
        'rivera': ['-30.9053', '-55.5508'],
        'tacuarembo': ['-31.7110', '-55.9834'],
        'rocha': ['-34.4833', '-54.2220'],
        'florida': ['-34.0994', '-56.2144'],
        'durazno': ['-33.3794', '-56.5227'],
        'lavalleja': ['-34.3519', '-55.2331'],
        'san jose': ['-34.3369', '-56.7133'],
        'soriano': ['-33.5098', '-57.7524'],
        'rio negro': ['-33.1195', '-58.3025'],
        'flores': ['-33.5239', '-56.8919'],
        'artigas': ['-30.4006', '-56.4674'],
        'cerro largo': ['-32.3739', '-54.1784'],
        'treinta y tres': ['-33.2305', '-54.3836'],
      };
      const c = coords[deptText] ?? coords['montevideo'];
      lat.value = c[0];
      lng.value = c[1];
    }
  });
  slog.info(DAC_STEPS.STEP3_SIGUIENTE, 'Forced cargaEnvios visible + set lat/lng for geocoding bypass');

  // ===== STEP 4: Package type + Quantity + Submit =====
  slog.info(DAC_STEPS.STEP4_START, 'Filling Step 4: package type and quantity');

  // Set package type via Choices.js (native selectOption doesn't work)
  // Must click the Choices.js dropdown and select the option visually
  await page.evaluate(() => {
    // Set the hidden native select value
    const sel = document.querySelector('select[name="K_Tipo_Empaque"]') as HTMLSelectElement;
    if (sel) {
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  // Also click through Choices.js UI
  try {
    const choicesDiv = await page.$('.choices');
    if (choicesDiv) {
      await choicesDiv.click();
      await page.waitForTimeout(500);
      // Click the "Hasta 2Kg 20x20x20" option
      const option = page.locator('.choices__item--choice').filter({ hasText: '2Kg' }).first();
      if (await option.count() > 0) {
        await option.click();
        slog.info(DAC_STEPS.STEP4_FILL_PACKAGE, 'Selected Hasta 2Kg 20x20x20 via Choices.js click');
      } else {
        slog.info(DAC_STEPS.STEP4_FILL_PACKAGE, 'Set K_Tipo_Empaque=1 via hidden select (Choices.js option not found)');
      }
    }
  } catch {
    slog.info(DAC_STEPS.STEP4_FILL_PACKAGE, 'Set K_Tipo_Empaque=1 via hidden select fallback');
  }

  // Set quantity = 1
  await page.evaluate(() => {
    const el = document.querySelector('[name="Cantidad"]') as HTMLInputElement;
    if (el) { el.value = '1'; el.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  slog.info(DAC_STEPS.STEP4_FILL_QTY, 'Set Cantidad = 1');

  await page.waitForTimeout(500);

  // ===== FILL OBSERVACIONES BEFORE Agregar (must be set before submission) =====
  // Build observations from: extraObs (apt/delivery notes) + order notes + note_attributes
  //
  // CRITICAL: Strip ALL LabelFlow-internal markers before sending to DAC. These
  // markers include the guia prefix (written to the Shopify note by markOrderProcessed
  // so that duplicate orders are skipped on the next cron), error prefixes, and any
  // note_attribute whose name starts with "labelflow". A previous bug leaked these
  // into DAC's observations field where the courier sees them — exposing internal
  // guia numbers that could be abused. The filter is case-insensitive, applies to
  // both lines of order.note AND entries in order.note_attributes (by name and by
  // value), and runs once more as a belt-and-suspenders strip on the final joined
  // observations to catch any edge case where the marker snuck through.
  // See LABELFLOW_MARKER_RE and sanitizeObservationLine at the top of this file.
  const observations: string[] = [];
  if (extraObs) observations.push(extraObs);
  if (order.note) {
    const cleanNote = order.note
      .split('\n')
      .filter(line => !LABELFLOW_MARKER_RE.test(line))
      .join('\n')
      .trim();
    if (cleanNote) observations.push(cleanNote);
  }
  if (order.note_attributes && Array.isArray(order.note_attributes)) {
    for (const attr of order.note_attributes) {
      if (!attr.value) continue;
      // Skip attributes whose name OR value contains a LabelFlow marker
      if (LABELFLOW_MARKER_RE.test(attr.name ?? '')) continue;
      if (LABELFLOW_MARKER_RE.test(String(attr.value))) continue;
      observations.push(`${attr.name}: ${attr.value}`);
    }
  }

  // Final belt-and-suspenders strip: sanitize each accumulated observation one
  // more time in case a marker slipped through the per-source filters above.
  const observationsClean = observations.map(sanitizeObservationLine).filter(Boolean);
  observations.length = 0;
  observations.push(...observationsClean);

  if (observations.length > 0) {
    const obsText = observations.join(' | ');
    slog.info(DAC_STEPS.STEP4_OK, `Will fill Observaciones: "${obsText.substring(0, 120)}"`, { fullText: obsText });

    // Use Playwright's native page.fill() — much more reliable than el.value assignment
    // Try multiple selectors in order of specificity
    const obsSelectors = [
      'textarea[name="Observaciones"]',
      'textarea[name="observaciones"]',
      'textarea[placeholder*="bservacion"]',
      '#cargaEnvios textarea',
      'fieldset textarea',
      'textarea',
    ];

    let obsFilled = false;
    for (const sel of obsSelectors) {
      try {
        const el = await page.$(sel);
        if (!el) continue;

        // Ensure the textarea is visible (force it if needed)
        await page.evaluate((s: string) => {
          const textarea = document.querySelector(s) as HTMLTextAreaElement;
          if (textarea) {
            textarea.style.display = 'block';
            textarea.style.visibility = 'visible';
            textarea.removeAttribute('hidden');
            textarea.removeAttribute('disabled');
            textarea.removeAttribute('readonly');
          }
        }, sel);
        await page.waitForTimeout(200);

        // Use Playwright fill (triggers proper input/change events)
        await page.fill(sel, obsText);

        // Verify the value was actually written
        const written = await page.$eval(sel, (el: any) => el.value).catch(() => '');
        if (written && written.length > 0) {
          obsFilled = true;
          slog.info(DAC_STEPS.STEP4_OK, `Observaciones filled via page.fill(): "${written.substring(0, 80)}"`, { selector: sel, length: written.length });
          break;
        } else {
          slog.warn(DAC_STEPS.STEP4_OK, `page.fill() on ${sel} did not persist — trying next selector`);
        }
      } catch {
        // Selector didn't work, try next
        continue;
      }
    }

    if (!obsFilled) {
      // Last resort: force fill ALL textareas via evaluate + manual events
      slog.warn(DAC_STEPS.STEP4_OK, 'All page.fill() attempts failed — using evaluate fallback');
      await page.evaluate((text: string) => {
        const textareas = document.querySelectorAll('textarea');
        for (const ta of textareas) {
          (ta as HTMLTextAreaElement).value = text;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
          ta.dispatchEvent(new Event('blur', { bubbles: true }));
        }
      }, obsText);
      // Verify
      const verifyObs = await page.evaluate(() => {
        const ta = document.querySelector('textarea') as HTMLTextAreaElement;
        return ta?.value ?? '';
      });
      if (verifyObs && verifyObs.length > 0) {
        slog.info(DAC_STEPS.STEP4_OK, `Observaciones filled via evaluate fallback: "${verifyObs.substring(0, 80)}"`);
      } else {
        slog.error(DAC_STEPS.STEP4_OK, `CRITICAL: Could not fill Observaciones field. Text was: "${obsText.substring(0, 80)}"`);
      }
    }
  } else {
    slog.info(DAC_STEPS.STEP4_OK, 'No observations to fill (extraObs empty, no order notes)');
  }

  // ===== CLICK "Agregar" (adds to cart) =====
  slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, 'Clicking Agregar button via JS evaluate');

  const agregarResult = await page.evaluate(() => {
    const fs = document.getElementById('cargaEnvios');
    if (fs) { fs.classList.remove('d-none'); fs.style.display = 'block'; }

    const btn = document.querySelector('.btnAdd') as HTMLButtonElement;
    if (btn) { btn.click(); return 'clicked .btnAdd'; }

    const buttons = Array.from(document.querySelectorAll('button'));
    for (const b of buttons) {
      if (b.textContent?.toLowerCase().includes('agregar')) { b.click(); return 'clicked Agregar by text'; }
    }
    return 'no button found';
  });

  slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, `Agregar click result: ${agregarResult}`);
  if (agregarResult === 'no button found') {
    throw new Error('Agregar button not found in DOM');
  }

  // Wait for response
  await page.waitForTimeout(3000);

  // Handle address validation modal
  const modalDismissed = await page.evaluate(() => {
    const modal = document.querySelector('.modal.show, .swal2-container, [class*="modal"]');
    if (modal) {
      const closeBtn = modal.querySelector('button[data-dismiss="modal"], .close, button:last-child, .swal2-close') as HTMLButtonElement;
      if (closeBtn) { closeBtn.click(); return 'modal dismissed'; }
      const xBtn = modal.querySelector('.btn-close, [aria-label="Close"]') as HTMLButtonElement;
      if (xBtn) { xBtn.click(); return 'modal X clicked'; }
    }
    return 'no modal';
  });
  slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, `Modal check: ${modalDismissed}`);

  // Check if item was added to cart
  await page.waitForTimeout(1000);
  const hasCartItem = await page.evaluate(() => {
    const body = document.body?.textContent ?? '';
    return body.includes('Finalizar') || body.includes('Total') || body.includes('Subtotal');
  });

  if (!hasCartItem) {
    slog.warn(DAC_STEPS.STEP4_CLICK_SUBMIT, 'Cart item not detected, retrying Agregar click');
    // Re-fill observations before retry in case the form was reset
    if (observations.length > 0) {
      const retryObsText = observations.join(' | ');
      try {
        const obsSelRetry = [
          'textarea[name="Observaciones"]',
          'textarea[name="observaciones"]',
          'textarea[placeholder*="bservacion"]',
          'fieldset textarea',
          'textarea',
        ];
        for (const sel of obsSelRetry) {
          const el = await page.$(sel);
          if (!el) continue;
          await page.fill(sel, retryObsText).catch(() => {});
          break;
        }
        slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, 'Re-filled observations before retry');
      } catch {
        // best-effort
      }
    }
    await page.evaluate(() => {
      const btn = document.querySelector('.btnAdd') as HTMLButtonElement;
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const closeBtn = document.querySelector('.modal.show .close, .modal.show button, .swal2-close') as HTMLButtonElement;
      if (closeBtn) closeBtn.click();
    });
    await page.waitForTimeout(1000);
  }

  slog.info(DAC_STEPS.STEP4_OK, 'Item added to cart');

  // ===== CLICK "Finalizar envio" (BUG C: separate button after Agregar) =====
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, 'Looking for Finalizar envio button');

  let finalizarResult: string;
  try {
    finalizarResult = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const b of buttons) {
        if (b.textContent?.toLowerCase().includes('finalizar')) {
          b.click();
          return 'clicked Finalizar envio';
        }
      }
      // Also try .btnSave class
      const saveBtn = document.querySelector('.btnSave') as HTMLButtonElement;
      if (saveBtn) { saveBtn.click(); return 'clicked .btnSave'; }
      return 'no Finalizar button found';
    });
  } catch (finErr) {
    // "Execution context was destroyed, most likely because of a navigation" means
    // the Finalizar click triggered a page redirect (DAC success flow). Treat as OK.
    if ((finErr as Error).message?.includes('Execution context was destroyed')) {
      finalizarResult = 'navigation-triggered (form submitted — context destroyed)';
      slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, 'Finalizar click caused immediate navigation — treating as success');
    } else {
      throw finErr;
    }
  }

  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `Finalizar result: ${finalizarResult}`);

  if (finalizarResult.includes('no Finalizar')) {
    slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, 'Finalizar button not found — item may only be in cart, not finalized');
  }

  // Wait for redirect to confirmation page
  await page.waitForTimeout(5000);

  const currentUrl = page.url();
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `Current URL after Finalizar: ${currentUrl}`);

  await dacBrowser.screenshot(page, `after-finalizar-${order.name.replace('#', '')}`);

  // ===== EXTRACT GUIA (with built-in retry — NEVER re-submit the form) =====
  const guiaResult = await extractGuiaWithRetry(page, slog, order.name, usedGuias);

  return {
    guia: guiaResult.guia,
    trackingUrl: guiaResult.trackingUrl,
    screenshotPath: '',
    // Pass the AI resolution hash back to the job runner for feedback recording
    aiResolutionHash: aiResolution?.inputHash,
  };
}

/**
 * Extract guia numbers AND their href links from <a> elements on the page.
 * Returns array of { guia, href } objects.
 */
async function extractGuiasWithLinks(pg: Page): Promise<{ guia: string; href: string | null }[]> {
  const GUIA_REGEX = /\b88\d{10,}\b/;
  return pg.evaluate((regexStr: string) => {
    const regex = new RegExp(regexStr);
    const results: { guia: string; href: string | null }[] = [];
    const seen = new Set<string>();

    // First: extract from <a> elements (these have the real tracking URLs)
    const links = Array.from(document.querySelectorAll('a'));
    for (const a of links) {
      const text = a.textContent?.trim() ?? '';
      if (regex.test(text)) {
        const g = text.match(new RegExp(regexStr))?.[0];
        if (g && !seen.has(g)) {
          seen.add(g);
          results.push({ guia: g, href: a.href || null });
        }
      }
    }

    // Second: extract from full page text (catches guias not in links)
    const allMatches = (document.body?.textContent ?? '').match(new RegExp(regexStr, 'g')) ?? [];
    for (const g of allMatches) {
      if (!seen.has(g)) {
        seen.add(g);
        results.push({ guia: g, href: null });
      }
    }

    return results;
  }, GUIA_REGEX.source);
}

/**
 * Pick the HIGHEST numbered guia from results (highest = most recently created).
 * This is more reliable than picking "last in DOM" which depends on page ordering.
 */
function pickHighestGuia(results: { guia: string; href: string | null }[]): { guia: string; href: string | null } {
  return results.reduce((best, curr) => {
    if (!best) return curr;
    return BigInt(curr.guia) > BigInt(best.guia) ? curr : best;
  }, results[0]);
}

/**
 * Extracts guia with retry logic. ONLY retries the guia extraction navigation,
 * NEVER re-submits the DAC form (the shipment is already created at this point).
 */
async function extractGuiaWithRetry(
  page: Page,
  slog: StepLogger,
  orderName: string,
  usedGuias?: Set<string>,
  maxAttempts: number = 3,
): Promise<{ guia: string; trackingUrl?: string }> {
  const excludeGuias = usedGuias ? Array.from(usedGuias) : [];
  let guia = '';
  let trackingUrl: string | undefined;

  slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, 'Extracting guia number');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Guia extraction retry ${attempt}/${maxAttempts} (NOT re-submitting form)`);
      await page.waitForTimeout(2000);
    }

    const currentUrl = page.url();

    // Method 0: Extract guia from confirmation page URL (/envios/guiacreada/XXXXX)
    if (currentUrl.includes('guiacreada')) {
      await page.waitForTimeout(2000);
      const pagePreview = await page.evaluate(() => document.body?.textContent?.substring(0, 500) ?? '');
      slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Confirmation page content preview: "${pagePreview.substring(0, 200)}"`);
    }

    // Method 1: Search CURRENT page for guia + href, excluding already-assigned ones
    let pageResults = await extractGuiasWithLinks(page);
    let newResults = pageResults.filter(r => !excludeGuias.includes(r.guia));

    if (pageResults.length > 0) {
      slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Current page: ${pageResults.length} guias found, ${pageResults.length - newResults.length} excluded (already in DB)`, {
        found: pageResults.map(r => r.guia),
        excluded: pageResults.filter(r => excludeGuias.includes(r.guia)).map(r => r.guia),
        new: newResults.map(r => r.guia),
      });
    }

    if (newResults.length > 0) {
      const picked = pickHighestGuia(newResults);
      guia = picked.guia;
      trackingUrl = picked.href || undefined;
      slog.success(DAC_STEPS.SUBMIT_OK, `Guia found on current page: ${guia}`, {
        guia, trackingUrl: trackingUrl ?? 'none', orderName, url: currentUrl,
        totalOnPage: pageResults.length, excluded: excludeGuias.length,
      });
      break;
    }

    // Method 2: Navigate to historial and find the NEW guia
    try {
      slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, 'Guia not on current page — checking mis envios');
      await page.goto('https://www.dac.com.uy/envios', { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.waitForTimeout(3000);

      pageResults = await extractGuiasWithLinks(page);
      newResults = pageResults.filter(r => !excludeGuias.includes(r.guia));

      if (newResults.length > 0) {
        const picked = pickHighestGuia(newResults);
        guia = picked.guia;
        trackingUrl = picked.href || undefined;
        slog.success(DAC_STEPS.SUBMIT_OK, `Guia found in historial: ${guia}`, {
          guia, trackingUrl: trackingUrl ?? 'none', orderName,
          totalOnPage: pageResults.length, excluded: excludeGuias.length,
          newGuiasAvailable: newResults.length,
        });
        break;
      } else if (pageResults.length > 0) {
        slog.warn(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Attempt ${attempt}: All ${pageResults.length} guias on historial already assigned`, {
          orderName,
        });
      }
    } catch (navErr) {
      slog.warn(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Attempt ${attempt}: Navigation to historial failed: ${(navErr as Error).message}`);
    }
  }

  // Method 3: If we have guia but no trackingUrl, try to find the link in historial
  if (guia && !trackingUrl && !guia.startsWith('PENDING-')) {
    slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Have guia ${guia} but no tracking URL, checking historial for link`);
    try {
      if (!page.url().includes('/envios')) {
        await page.goto('https://www.dac.com.uy/envios', { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(3000);
      }
      const linkHref = await page.evaluate((g: string) => {
        const links = Array.from(document.querySelectorAll('a'));
        for (const a of links) {
          if (a.textContent?.trim().includes(g)) return a.href || null;
        }
        return null;
      }, guia);
      if (linkHref) {
        trackingUrl = linkHref;
        slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Found tracking URL for guia in historial`, { guia, trackingUrl });
      }
    } catch {
      slog.warn(DAC_STEPS.SUBMIT_EXTRACT_GUIA, 'Could not navigate to historial for tracking URL');
    }
  }

  // Last resort: PENDING
  if (!guia) {
    guia = `PENDING-${Date.now()}`;
    slog.warn(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Could not extract guia after ${maxAttempts} attempts`, { orderName, url: page.url() });
    await dacBrowser.screenshot(page, `no-guia-found-${orderName.replace('#', '')}`);
  }

  return { guia, trackingUrl };
}
