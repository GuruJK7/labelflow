import { Page } from 'playwright';
import { ShopifyOrder } from '../shopify/types';
import { DacShipmentResult } from './types';
import { DAC_SELECTORS, DAC_URLS } from './selectors';
import { ensureLoggedIn } from './auth';
import { dacBrowser } from './browser';
import { DAC_STEPS } from './steps';
import { createStepLogger, StepLogger } from '../logger';
import logger from '../logger';
import { getDepartmentForCity, getBarriosFromZip, getDepartmentFromZip, getBarriosFromStreet } from './uruguay-geo';

// ---- Helpers ----

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Montevideo barrio aliases: maps common names/variations to the canonical
 * name DAC uses in its K_Barrio dropdown. This lets us match "Punta Carretas",
 * "Pta Carretas", "Punta carretas" etc. to the right dropdown option.
 */
const MONTEVIDEO_BARRIO_ALIASES: Record<string, string[]> = {
  'aguada': ['aguada'],
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
  'paso de las duranas': ['paso de las duranas'],
  'peñarol': ['penarol'],
  'piedras blancas': ['piedras blancas'],
  'pocitos': ['pocitos'],
  'pocitos nuevo': ['pocitos nuevo'],
  'prado': ['prado'],
  'punta carretas': ['punta carretas', 'pta carretas', 'punta carreta'],
  'punta de rieles': ['punta de rieles'],
  'punta gorda': ['punta gorda', 'pta gorda'],
  'reducto': ['reducto'],
  'sayago': ['sayago'],
  'sur': ['sur'],
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

  // Check each barrio and its aliases
  for (const [canonical, aliases] of Object.entries(MONTEVIDEO_BARRIO_ALIASES)) {
    for (const alias of aliases) {
      const normalizedAlias = normalize(alias);
      // Word boundary check: ensure we match the whole barrio name, not partial
      // e.g. "centro" should not match "concentrar"
      const regex = new RegExp(`\\b${normalizedAlias.replace(/\s+/g, '\\s+')}\\b`);
      if (regex.test(combined)) {
        return canonical;
      }
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
 * 1. ZIP code (highest priority, most reliable)
 * 2. Street name (medium priority)
 * 3. Barrio alias from address text (lower priority)
 * 4. Fallback: department from ZIP only
 */
function detectCityIntelligent(
  city: string,
  address1: string,
  address2: string,
  zip: string,
): IntelligentCityResult {
  const aliasBarrio = detectBarrio(city, address1, address2);
  const zipBarrios = getBarriosFromZip(zip);
  const streetBarrios = getBarriosFromStreet(address1) ?? getBarriosFromStreet(address2);
  const zipDept = getDepartmentFromZip(zip);

  // Strategy 1: ZIP code — if alias result agrees with ZIP candidates, high confidence
  if (zipBarrios && zipBarrios.length > 0) {
    if (aliasBarrio && zipBarrios.includes(aliasBarrio)) {
      return { barrio: aliasBarrio, department: zipDept, source: 'zip', confidence: 'high' };
    }
    // ZIP + street cross-reference
    if (streetBarrios) {
      const overlap = zipBarrios.filter(b => streetBarrios.includes(b));
      if (overlap.length > 0) {
        return { barrio: overlap[0], department: zipDept, source: 'zip', confidence: 'high' };
      }
    }
    // ZIP alone — still high confidence, pick first candidate
    return { barrio: zipBarrios[0], department: zipDept, source: 'zip', confidence: 'high' };
  }

  // Strategy 2: Street name detection
  if (streetBarrios && streetBarrios.length > 0) {
    if (aliasBarrio && streetBarrios.includes(aliasBarrio)) {
      return { barrio: aliasBarrio, department: zipDept ?? 'Montevideo', source: 'street', confidence: 'medium' };
    }
    return { barrio: streetBarrios[0], department: zipDept ?? 'Montevideo', source: 'street', confidence: 'medium' };
  }

  // Strategy 3: Alias detection alone
  if (aliasBarrio) {
    return { barrio: aliasBarrio, department: zipDept ?? 'Montevideo', source: 'alias', confidence: 'medium' };
  }

  // Fallback: only department from ZIP
  return { barrio: null, department: zipDept, source: 'none', confidence: 'low' };
}

/**
 * Merge address1 + address2 into a single clean delivery address.
 * Handles cases where the door number is in address2, or address2
 * contains supplementary info like apartment/floor.
 *
 * RULES:
 * - If address2 looks like just a number (door number), append to address1
 * - If address2 looks like apt/floor/block info, append to address1
 * - If address2 is a completely different address, combine them
 * - Strip leading/trailing whitespace and normalize separators
 */
export function mergeAddress(address1: string, address2: string | undefined | null): { fullAddress: string; extraObs: string } {
  const a1 = (address1 ?? '').trim();
  const a2 = (address2 ?? '').trim();

  if (!a2) return { fullAddress: a1, extraObs: '' };

  // DEDUP: if address2 is already at the end of address1, skip it
  // e.g. address1="18 De Julio 705", address2="705" → don't append again
  if (a1.endsWith(a2)) {
    return { fullAddress: a1, extraObs: '' };
  }

  // Detect "puerta/apto" pattern in address1: "3274/801" means door 3274, apt 801
  // If address1 already has this pattern, put the apt part in observations
  const slashApt = /(\d+)\s*\/\s*(\d+)\s*$/.exec(a1);
  if (slashApt && !a2) {
    return { fullAddress: a1, extraObs: `Apto ${slashApt[2]}` };
  }

  // Detect apartment/floor/unit info — ALWAYS goes to Observaciones too
  const aptPattern = /^(apto?\.?\s*\d|piso\s*\d|depto?\.?\s*\d|esc\.?\s*\d|torre\s*\d|block\s*\d|bloque\s*\d|unidad\s*\d|puerta\s*\d|casa\s*\d|local\s*\d|of\.?\s*\d|oficina\s*\d)/i;
  const isAptFloor = aptPattern.test(a2);

  // Detect "1502B" or "502 A" pattern — door+apt combined, needs separation
  const doorAptCombined = /^(\d{3,5})\s*([A-Za-z]\d{0,2})$/.exec(a2);

  // Pure door number: "1234"
  const isDoorNumber = /^\d{1,6}$/.test(a2);

  // Direction references
  const isDirectionRef = /^(esq|entre|frente|al lado|cerca|junto|casi|a metros|esquina)/i.test(a2);

  if (isDoorNumber) {
    // Check if address1 already ends with a number — if so, address2 might be apt number
    const a1EndsWithNum = /\d+\s*$/.test(a1);
    if (a1EndsWithNum) {
      // address1 already has a door number, address2 is likely apartment
      return { fullAddress: `${a1} Apto ${a2}`, extraObs: `Apto ${a2}` };
    }
    return { fullAddress: `${a1} ${a2}`, extraObs: '' };
  }

  if (doorAptCombined) {
    const doorNum = doorAptCombined[1];
    const aptPart = doorAptCombined[2];
    return { fullAddress: `${a1} ${doorNum} ${aptPart}`, extraObs: `Apto ${aptPart}` };
  }

  if (isAptFloor) {
    return { fullAddress: `${a1} ${a2}`, extraObs: a2 };
  }

  if (isDirectionRef) {
    return { fullAddress: `${a1} ${a2}`, extraObs: '' };
  }

  // Short number+text like "bis"
  if (/^\d{1,6}\s+(bis|esq)/i.test(a2)) {
    return { fullAddress: `${a1} ${a2}`, extraObs: '' };
  }

  // Short text starting with number
  if (a2.length < 30 && /^\d/.test(a2)) {
    const hasAptLetter = /\d+\s*[A-Za-z]/.test(a2);
    return { fullAddress: `${a1} ${a2}`, extraObs: hasAptLetter ? `Apto/Puerta: ${a2}` : '' };
  }

  // Default: put in both fullAddress and observations for safety
  return { fullAddress: `${a1} - ${a2}`, extraObs: a2 };
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

  // ===== STEP 1: Shipment Type =====
  slog.info(DAC_STEPS.STEP1_START, 'Filling Step 1: shipment type fields');

  const pickupVal = DAC_SELECTORS.PICKUP_VALUE_MOSTRADOR;
  const payVal = paymentType === 'REMITENTE'
    ? DAC_SELECTORS.PAYMENT_VALUE_REMITENTE
    : DAC_SELECTORS.PAYMENT_VALUE_DESTINATARIO;
  const packageVal = DAC_SELECTORS.PACKAGE_VALUE_PAQUETE;
  const deliveryVal = DAC_SELECTORS.DELIVERY_VALUE_DOMICILIO;

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

  if (addr.city) {
    const geoDept = getDepartmentForCity(addr.city);
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
          // Try partial match with first word of detected barrio
          const firstWord = normalize(detectedBarrioName).split(/\s+/)[0];
          const partialMatch = barrioOptions.find(b => normalize(b.text).includes(firstWord) && firstWord.length > 3);
          if (partialMatch) {
            await safeSelect(page, DAC_SELECTORS.RECIPIENT_BARRIO, partialMatch.value, slog, DAC_STEPS.STEP3_SELECT_BARRIO, `K_Barrio (partial match: ${partialMatch.text})`);
          } else if (barrioOptions.length > 0) {
            await safeSelect(page, DAC_SELECTORS.RECIPIENT_BARRIO, barrioOptions[0].value, slog, DAC_STEPS.STEP3_SELECT_BARRIO, `K_Barrio (first fallback: ${barrioOptions[0].text})`);
          }
        }
      } else {
        // No barrio detected by any strategy — select first option as last resort
        slog.warn(DAC_STEPS.STEP3_SELECT_BARRIO,
          `No barrio detected by any strategy (zip=${addr.zip ?? 'none'}, city=${addr.city ?? 'none'}, source=${intelligent.source}) �� using first option`,
          { zip: addr.zip, city: addr.city, address1: addr.address1, intelligentSource: intelligent.source }
        );
        const firstBarrio = await page.$$eval(`${DAC_SELECTORS.RECIPIENT_BARRIO} option`,
          (opts: any[]) => { const v = opts.filter(o => o.value && o.value !== '0' && o.value !== ''); return v[0]?.value || null; });
        if (firstBarrio) {
          await safeSelect(page, DAC_SELECTORS.RECIPIENT_BARRIO, firstBarrio, slog, DAC_STEPS.STEP3_SELECT_BARRIO, 'K_Barrio (last resort first option)');
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
    // Set fake lat/lng for Juan Lacaze area (BUG B: address validation requires geocoding)
    const lat = document.querySelector('[name="latitude"]') as HTMLInputElement;
    const lng = document.querySelector('[name="longitude"]') as HTMLInputElement;
    if (lat) lat.value = '-34.4565';
    if (lng) lng.value = '-57.4506';
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

  // ===== CLICK "Agregar" (adds to cart) =====
  slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, 'Clicking Agregar button via JS evaluate');

  const agregarResult = await page.evaluate(() => {
    // Ensure fieldset visible
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

  // Wait for response — DAC may show address validation modal or add to cart
  await page.waitForTimeout(3000);

  // Handle address validation modal (BUG B: "No ha seleccionado una direccion validada")
  // If the modal appears, we dismiss it — the item was still added to cart
  const modalDismissed = await page.evaluate(() => {
    // Check for Swal/Bootstrap modal with "Revisar" or "Cambiar"
    const modal = document.querySelector('.modal.show, .swal2-container, [class*="modal"]');
    if (modal) {
      // Click any close/dismiss button
      const closeBtn = modal.querySelector('button[data-dismiss="modal"], .close, button:last-child, .swal2-close') as HTMLButtonElement;
      if (closeBtn) { closeBtn.click(); return 'modal dismissed'; }
      // Try clicking the X
      const xBtn = modal.querySelector('.btn-close, [aria-label="Close"]') as HTMLButtonElement;
      if (xBtn) { xBtn.click(); return 'modal X clicked'; }
    }
    return 'no modal';
  });
  slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, `Modal check: ${modalDismissed}`);

  // Check if item was added to cart (look for price summary or "Finalizar envio")
  await page.waitForTimeout(1000);
  const hasCartItem = await page.evaluate(() => {
    const body = document.body?.textContent ?? '';
    return body.includes('Finalizar') || body.includes('Total') || body.includes('Subtotal');
  });

  if (!hasCartItem) {
    // Second attempt: click Agregar again (modal may have blocked first click)
    slog.warn(DAC_STEPS.STEP4_CLICK_SUBMIT, 'Cart item not detected, retrying Agregar click');
    await page.evaluate(() => {
      const btn = document.querySelector('.btnAdd') as HTMLButtonElement;
      if (btn) btn.click();
    });
    await page.waitForTimeout(3000);
    // Dismiss modal again if needed
    await page.evaluate(() => {
      const closeBtn = document.querySelector('.modal.show .close, .modal.show button, .swal2-close') as HTMLButtonElement;
      if (closeBtn) closeBtn.click();
    });
    await page.waitForTimeout(1000);
  }

  slog.info(DAC_STEPS.STEP4_OK, 'Item added to cart');

  // ===== FILL OBSERVACIONES (extra obs from address merge + order notes) =====
  // NOTE: address2 is now merged into fullAddress (DirD field) via mergeAddress().
  // Only extraObs (non-address info) goes here to avoid duplication.
  const observations: string[] = [];
  if (extraObs) observations.push(extraObs);
  if (order.note) observations.push(order.note);
  if (order.note_attributes && Array.isArray(order.note_attributes)) {
    for (const attr of order.note_attributes) {
      if (attr.value) observations.push(`${attr.name}: ${attr.value}`);
    }
  }

  if (observations.length > 0) {
    const obsText = observations.join(' | ');
    const obsFilled = await page.evaluate((text: string) => {
      // Try multiple selectors for the Observaciones textarea
      const selectors = [
        'textarea[name="Observaciones"]',
        'textarea[name="observaciones"]',
        'textarea[placeholder*="bservacion"]',
        'textarea',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLTextAreaElement;
        if (el && el.offsetParent !== null) {
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return sel;
        }
      }
      return null;
    }, obsText);

    if (obsFilled) {
      slog.info(DAC_STEPS.STEP4_OK, `Observaciones filled: "${obsText.substring(0, 80)}"`, { selector: obsFilled });
    } else {
      slog.warn(DAC_STEPS.STEP4_OK, `Could not fill Observaciones field (text: "${obsText.substring(0, 50)}")`);
    }
  }

  // ===== CLICK "Finalizar envio" (BUG C: separate button after Agregar) =====
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, 'Looking for Finalizar envio button');

  const finalizarResult = await page.evaluate(() => {
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

  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `Finalizar result: ${finalizarResult}`);

  if (finalizarResult.includes('no Finalizar')) {
    slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, 'Finalizar button not found — item may only be in cart, not finalized');
  }

  // Wait for redirect to confirmation page
  await page.waitForTimeout(5000);

  const currentUrl = page.url();
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `Current URL after Finalizar: ${currentUrl}`);

  await dacBrowser.screenshot(page, `after-finalizar-${order.name.replace('#', '')}`);

  // ===== EXTRACT GUIA =====
  slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, 'Extracting guia number');

  const GUIA_REGEX = /\b88\d{10,}\b/;
  const excludeGuias = usedGuias ? Array.from(usedGuias) : [];
  let guia: string = '';
  let trackingUrl: string | undefined;

  /**
   * Extract guia numbers AND their href links from <a> elements on the page.
   * Returns array of { guia, href } objects.
   */
  async function extractGuiasWithLinks(pg: Page): Promise<{ guia: string; href: string | null }[]> {
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

  // Method 0: Try to extract guia from confirmation page URL
  // DAC redirects to /envios/guiacreada/XXXXX — page content should have the 88... guia
  if (currentUrl.includes('guiacreada')) {
    // Wait extra for confirmation page content to fully render
    await page.waitForTimeout(2000);
    // Log page text for debugging
    const pagePreview = await page.evaluate(() => document.body?.textContent?.substring(0, 500) ?? '');
    slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Confirmation page content preview: "${pagePreview.substring(0, 200)}"`);
  }

  // Method 1: Search CURRENT page for guia + href, excluding already-assigned ones
  let pageResults = await extractGuiasWithLinks(page);
  let newResults = pageResults.filter(r => !excludeGuias.includes(r.guia));

  // Log what was found vs excluded for debugging
  if (pageResults.length > 0) {
    slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Current page: ${pageResults.length} guias found, ${pageResults.length - newResults.length} excluded (already in DB)`, {
      found: pageResults.map(r => r.guia),
      excluded: pageResults.filter(r => excludeGuias.includes(r.guia)).map(r => r.guia),
      new: newResults.map(r => r.guia),
    });
  }

  if (newResults.length > 0) {
    const picked = newResults[newResults.length - 1]; // Last = most recently created
    guia = picked.guia;
    trackingUrl = picked.href || undefined;
    slog.success(DAC_STEPS.SUBMIT_OK, `Guia found on current page: ${guia}`, {
      guia, trackingUrl: trackingUrl ?? 'none', orderName: order.name, url: currentUrl,
      totalOnPage: pageResults.length, excluded: excludeGuias.length,
    });
  }

  // Method 2: If not found, navigate to historial and find the NEW guia + href
  if (!guia) {
    slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, 'Guia not on current page — checking mis envios');
    await page.goto('https://www.dac.com.uy/envios', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(3000);

    pageResults = await extractGuiasWithLinks(page);
    newResults = pageResults.filter(r => !excludeGuias.includes(r.guia));

    if (newResults.length > 0) {
      const picked = newResults[newResults.length - 1]; // LAST = most recent (historial is chronological, oldest first)
      guia = picked.guia;
      trackingUrl = picked.href || undefined;
      slog.success(DAC_STEPS.SUBMIT_OK, `Guia found in historial: ${guia}`, {
        guia, trackingUrl: trackingUrl ?? 'none', orderName: order.name,
        totalOnPage: pageResults.length, excluded: excludeGuias.length,
        newGuiasAvailable: newResults.length,
      });
    } else if (pageResults.length > 0) {
      slog.error(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `All ${pageResults.length} guias on historial are already assigned to other orders in this batch`, {
        orderName: order.name, excludedGuias: excludeGuias,
      });
    }
  }

  // Method 3: If we have guia but no trackingUrl, try to find the link in historial
  if (guia && !trackingUrl && !guia.startsWith('PENDING-')) {
    slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, `Have guia ${guia} but no tracking URL, checking historial for link`);
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
  }

  // Method 4: Still no guia — use PENDING as last resort
  if (!guia) {
    guia = `PENDING-${Date.now()}`;
    slog.warn(DAC_STEPS.SUBMIT_EXTRACT_GUIA, 'Could not extract guia from any page', { orderName: order.name, url: page.url() });
    await dacBrowser.screenshot(page, `no-guia-found-${order.name.replace('#', '')}`);
  }

  return { guia, trackingUrl, screenshotPath: '' };
}
