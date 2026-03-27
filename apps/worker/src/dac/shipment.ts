import { Page } from 'playwright';
import { ShopifyOrder } from '../shopify/types';
import { DacShipmentResult } from './types';
import { DAC_SELECTORS, DAC_URLS } from './selectors';
import { ensureLoggedIn } from './auth';
import { dacBrowser } from './browser';
import { DAC_STEPS } from './steps';
import { createStepLogger, StepLogger } from '../logger';
import logger from '../logger';

// ---- Helpers ----

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
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
  // Word match
  const searchWords = search.split(/\s+/);
  for (const opt of options) {
    const optWords = normalize(opt.text).split(/\s+/);
    const hasMatch = searchWords.some(sw => optWords.some(ow => ow === sw && sw.length > 2));
    if (hasMatch && opt.value && opt.value !== '0') return opt.value;
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
  jobId?: string
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

  // BUG FIX 1: Phone field is "TelD" not "TelefonoD"
  // Fill each field using Playwright's fill() for real browser events
  await safeFill(page, 'input[name="NombreD"]', fullName, slog, DAC_STEPS.STEP3_FILL_NAME, 'NombreD (name)');

  // TelD is the correct phone field name
  const phoneFilled = await safeFill(page, 'input[name="TelD"]', phone, slog, DAC_STEPS.STEP3_FILL_PHONE, 'TelD (phone)');
  if (!phoneFilled) {
    // Fallback: try other possible phone selectors
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

  // Address
  const addrFilled = await safeFill(page, 'input[name="DirD"]', addr.address1, slog, DAC_STEPS.STEP3_FILL_ADDRESS, 'DirD (address)');
  if (!addrFilled) {
    await safeFill(page, '#DirD', addr.address1, slog, DAC_STEPS.STEP3_FILL_ADDRESS, 'DirD by id (fallback)');
  }

  // Department (select)
  if (addr.province) {
    slog.info(DAC_STEPS.STEP3_SELECT_DEPT, `Selecting department: ${addr.province}`);
    const deptMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_DEPARTMENT, addr.province);
    if (deptMatch) {
      await safeSelect(page, DAC_SELECTORS.RECIPIENT_DEPARTMENT, deptMatch, slog, DAC_STEPS.STEP3_SELECT_DEPT, 'K_Estado (department)');
      // Wait for city dropdown to populate after department change
      slog.info(DAC_STEPS.STEP3_WAIT_CITIES, 'Waiting for cities to load after department change');
      await page.waitForTimeout(1500);
    } else {
      slog.warn(DAC_STEPS.STEP3_SELECT_DEPT, `No department match for: ${addr.province}`);
    }
  }

  // City (select)
  if (addr.city) {
    slog.info(DAC_STEPS.STEP3_SELECT_CITY, `Selecting city: ${addr.city}`);
    const cityMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_CITY, addr.city);
    if (cityMatch) {
      await safeSelect(page, DAC_SELECTORS.RECIPIENT_CITY, cityMatch, slog, DAC_STEPS.STEP3_SELECT_CITY, 'K_Ciudad (city)');
      await page.waitForTimeout(800);
    } else {
      // Pick first non-empty option as fallback
      slog.warn(DAC_STEPS.STEP3_SELECT_CITY, `No city match for: ${addr.city}, using first option`);
      const firstOpt = await page.$$eval(`${DAC_SELECTORS.RECIPIENT_CITY} option`,
        (opts: any[]) => { const v = opts.filter(o => o.value && o.value !== '0'); return v[0]?.value || null; });
      if (firstOpt) {
        await safeSelect(page, DAC_SELECTORS.RECIPIENT_CITY, firstOpt, slog, DAC_STEPS.STEP3_SELECT_CITY, 'K_Ciudad (first option)');
      }
    }
  }

  // Barrio (select, optional)
  try {
    const barrioEl = await page.$(DAC_SELECTORS.RECIPIENT_BARRIO);
    if (barrioEl) {
      const firstBarrio = await page.$$eval(`${DAC_SELECTORS.RECIPIENT_BARRIO} option`,
        (opts: any[]) => { const v = opts.filter(o => o.value && o.value !== '0' && o.value !== ''); return v[0]?.value || null; });
      if (firstBarrio) {
        await safeSelect(page, DAC_SELECTORS.RECIPIENT_BARRIO, firstBarrio, slog, DAC_STEPS.STEP3_SELECT_BARRIO, 'K_Barrio');
      }
    }
  } catch {
    slog.info(DAC_STEPS.STEP3_SELECT_BARRIO, 'Barrio field not available (optional)');
  }

  slog.info(DAC_STEPS.STEP3_OK, 'Step 3 recipient data complete', { name: fullName, phone, city: addr.city, province: addr.province });
  await dacBrowser.screenshot(page, `step3-complete-${order.name.replace('#', '')}`);

  // BUG FIX 2 & 3: Click Siguiente to advance from Step 3 to Step 4
  // The phone field being empty (old TelefonoD bug) was preventing form validation
  // from allowing the step advance. Now that TelD is correctly filled, this should work.
  const adv3 = await clickSiguiente(page, slog, DAC_STEPS.STEP3_SIGUIENTE);
  if (!adv3) {
    slog.error(DAC_STEPS.STEP3_SIGUIENTE, 'CRITICAL: Could not advance past Step 3 to Step 4');
    await dacBrowser.screenshot(page, `step3-stuck-${order.name.replace('#', '')}`);
    throw new Error('Cannot advance past Step 3 (recipient). Form validation may have failed.');
  }
  await page.waitForTimeout(1000);

  // ===== STEP 4: Quantity + Submit =====
  slog.info(DAC_STEPS.STEP4_START, 'Filling Step 4: quantity and package size');

  // Fill quantity = 1
  const qtyFilled = await safeFill(page, 'input[name="Cantidad"]', '1', slog, DAC_STEPS.STEP4_FILL_QTY, 'Cantidad');
  if (!qtyFilled) {
    // Try via evaluate as fallback
    await page.evaluate(() => {
      const el = document.querySelector('[name="Cantidad"]') as HTMLInputElement;
      if (el) { el.value = '1'; el.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    slog.info(DAC_STEPS.STEP4_FILL_QTY, 'Set Cantidad via evaluate fallback');
  }

  // Package size: 1 = small
  const pkgEl = await page.$('select[name="K_Tipo_Empaque"]');
  if (pkgEl) {
    await safeSelect(page, 'select[name="K_Tipo_Empaque"]', '1', slog, DAC_STEPS.STEP4_FILL_PACKAGE, 'K_Tipo_Empaque');
  } else {
    await page.evaluate(() => {
      const el = document.querySelector('[name="K_Tipo_Empaque"]') as HTMLInputElement;
      if (el) { el.value = '1'; el.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    slog.info(DAC_STEPS.STEP4_FILL_PACKAGE, 'Set K_Tipo_Empaque via evaluate fallback');
  }

  await page.waitForTimeout(500);
  await dacBrowser.screenshot(page, `step4-pre-submit-${order.name.replace('#', '')}`);

  // BUG FIX 3: Click .btnAdd via real Playwright click (NOT page.request.post)
  // Wait for the submit button to become visible
  slog.info(DAC_STEPS.STEP4_WAIT_BTN, 'Waiting for .btnAdd (Agregar) button to be visible');

  let btnFound = false;

  // Try .btnAdd first (common class in DAC)
  try {
    await page.waitForSelector('.btnAdd', { state: 'visible', timeout: 10_000 });
    btnFound = true;
    slog.info(DAC_STEPS.STEP4_WAIT_BTN, '.btnAdd is visible');
  } catch {
    slog.warn(DAC_STEPS.STEP4_WAIT_BTN, '.btnAdd not visible after 10s, trying alternative selectors');
  }

  // Fallback: button with text "Agregar"
  if (!btnFound) {
    try {
      const agregarBtn = page.locator('button, input[type="button"], input[type="submit"]').filter({ hasText: /agregar/i });
      const agregarCount = await agregarBtn.count();
      if (agregarCount > 0) {
        btnFound = true;
        slog.info(DAC_STEPS.STEP4_WAIT_BTN, `Found Agregar button via text match (count: ${agregarCount})`);
      }
    } catch {
      // continue
    }
  }

  if (!btnFound) {
    await dacBrowser.screenshot(page, `no-submit-btn-${order.name.replace('#', '')}`);
    throw new Error('Submit button (.btnAdd / Agregar) not found or not visible after Step 4');
  }

  // Click the submit button
  slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, 'Clicking submit button');

  try {
    // Prefer .btnAdd
    const btnAddEl = await page.$('.btnAdd');
    if (btnAddEl && await btnAddEl.isVisible()) {
      await page.click('.btnAdd', { timeout: 5000 });
      slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, 'Clicked .btnAdd successfully');
    } else {
      // Fallback: click by text
      await page.locator('button:has-text("Agregar")').first().click({ timeout: 5000 });
      slog.info(DAC_STEPS.STEP4_CLICK_SUBMIT, 'Clicked Agregar button by text');
    }
  } catch (clickErr) {
    await dacBrowser.screenshot(page, `submit-click-error-${order.name.replace('#', '')}`);
    throw new Error(`Failed to click submit button: ${(clickErr as Error).message}`);
  }

  slog.info(DAC_STEPS.STEP4_OK, 'Submit button clicked');

  // ===== POST-SUBMIT: Wait for navigation to cart =====
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, 'Waiting for navigation after submit');

  // Wait for the page to navigate (DAC should redirect to cart)
  try {
    await page.waitForURL('**/envios/cart**', { timeout: 15_000 });
    slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, 'Redirected to cart page');
  } catch {
    // May not redirect -- check current URL
    const currentUrl = page.url();
    slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `No redirect detected, current URL: ${currentUrl}`);

    // Navigate to cart manually
    await page.goto(DAC_URLS.CART, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForTimeout(2000);
  }

  await dacBrowser.screenshot(page, `cart-after-submit-${order.name.replace('#', '')}`);

  // ===== EXTRACT GUIA =====
  slog.info(DAC_STEPS.SUBMIT_EXTRACT_GUIA, 'Extracting guia from cart page');

  // BUG FIX 4: Guia regex only matches numbers starting with 88 and 12+ digits
  const GUIA_REGEX = /\b88\d{10,}\b/;

  const guiaFromCart = await page.evaluate((regexStr: string) => {
    const regex = new RegExp(regexStr);
    // Check table rows first
    const rows = document.querySelectorAll('table tr, .envio-row, [class*="envio"]');
    for (const row of Array.from(rows)) {
      const text = row.textContent ?? '';
      const match = text.match(regex);
      if (match) return match[0];
    }
    // Fallback: search full page text
    const pageText = document.body?.textContent ?? '';
    const allGuias = pageText.match(new RegExp(regexStr, 'g'));
    if (allGuias && allGuias.length > 0) return allGuias[0];
    return null;
  }, GUIA_REGEX.source);

  let guia: string;

  if (guiaFromCart) {
    guia = guiaFromCart;
    slog.success(DAC_STEPS.SUBMIT_OK, `Shipment created! Guia: ${guia}`, { guia, orderName: order.name });
  } else {
    guia = `PENDING-${Date.now()}`;
    slog.warn(DAC_STEPS.SUBMIT_EXTRACT_GUIA, 'Could not extract guia from cart page', { orderName: order.name });
    await dacBrowser.screenshot(page, `no-guia-found-${order.name.replace('#', '')}`);
  }

  return { guia, screenshotPath: '' };
}
