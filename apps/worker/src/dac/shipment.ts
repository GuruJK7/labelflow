import { Page } from 'playwright';
import { ShopifyOrder } from '../shopify/types';
import { DacShipmentResult } from './types';
import { DAC_SELECTORS, DAC_URLS } from './selectors';
import { ensureLoggedIn } from './auth';
import { dacBrowser } from './browser';
import logger from '../logger';

/**
 * Normalize a string for fuzzy matching: lowercase, remove accents, trim.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Find the best matching option value in a select element.
 */
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

  for (const opt of options) {
    if (normalize(opt.text) === search && opt.value && opt.value !== '0') return opt.value;
  }
  for (const opt of options) {
    if (normalize(opt.text).includes(search) && opt.value && opt.value !== '0') return opt.value;
  }
  for (const opt of options) {
    if (opt.text.length > 2 && search.includes(normalize(opt.text)) && opt.value && opt.value !== '0') return opt.value;
  }
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
 * Inspect the current page DOM to understand form structure.
 * Logs all interactive elements for debugging.
 */
async function inspectFormDOM(page: Page, label: string): Promise<void> {
  const domInfo = await page.evaluate(() => {
    // Get all visible links with text
    const links = Array.from(document.querySelectorAll('a')).map(a => ({
      text: a.textContent?.trim().substring(0, 50),
      href: a.href?.substring(0, 80),
      visible: a.offsetParent !== null,
      classes: a.className?.substring(0, 50),
    })).filter(a => a.text && a.text.length > 0);

    // Get all buttons
    const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]')).map(b => ({
      text: (b.textContent?.trim() || (b as HTMLInputElement).value)?.substring(0, 50),
      type: (b as HTMLButtonElement).type,
      visible: (b as HTMLElement).offsetParent !== null,
      classes: b.className?.substring(0, 50),
      id: b.id,
    }));

    // Get all form steps/tabs/wizard indicators
    const steps = Array.from(document.querySelectorAll('[class*="step"], [class*="wizard"], [class*="tab"], [class*="fase"], [role="tabpanel"], .nav-tabs li, .nav-pills li')).map(s => ({
      text: s.textContent?.trim().substring(0, 50),
      classes: s.className?.substring(0, 80),
      visible: (s as HTMLElement).offsetParent !== null,
    }));

    // Get all selects and their current values
    const selects = Array.from(document.querySelectorAll('select')).map(s => ({
      name: s.name,
      id: s.id,
      value: s.value,
      visible: s.offsetParent !== null,
      optionCount: s.options.length,
    }));

    // Get all inputs
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])')).map(i => ({
      name: (i as HTMLInputElement).name,
      type: (i as HTMLInputElement).type,
      id: i.id,
      value: (i as HTMLInputElement).value?.substring(0, 30),
      visible: (i as HTMLElement).offsetParent !== null,
      placeholder: (i as HTMLInputElement).placeholder?.substring(0, 30),
    }));

    // Get page title and URL
    const title = document.title;
    const url = window.location.href;

    return { title, url, links: links.slice(0, 20), buttons, steps, selects, inputs: inputs.slice(0, 20) };
  });

  logger.info({ label, dom: domInfo }, 'DOM inspection');
}

/**
 * Navigate the multi-step form using JavaScript execution.
 * DAC's form uses Chukupax framework which may hide/show steps via JS.
 */
async function navigateToNextStep(page: Page, stepNum: number): Promise<boolean> {
  // Take screenshot for debugging
  await dacBrowser.screenshot(page, `step-${stepNum}-before-click`);

  // Strategy 1: Execute any JS function that DAC uses to advance steps
  const jsResult = await page.evaluate((step: number) => {
    // Common patterns for multi-step forms:
    // 1. Direct function call (Chukupax-style)
    if (typeof (window as any).siguiente === 'function') {
      (window as any).siguiente();
      return 'called window.siguiente()';
    }
    if (typeof (window as any).nextStep === 'function') {
      (window as any).nextStep();
      return 'called window.nextStep()';
    }
    if (typeof (window as any).next === 'function') {
      (window as any).next();
      return 'called window.next()';
    }

    // 2. Look for onclick handlers on links/buttons with "Siguiente"
    const allElements = Array.from(document.querySelectorAll('a, button, input[type="button"]'));
    for (const el of allElements) {
      const text = el.textContent?.toLowerCase() || (el as HTMLInputElement).value?.toLowerCase() || '';
      if (text.includes('siguiente') || text.includes('next')) {
        // Try to get onclick attribute
        const onclick = el.getAttribute('onclick');
        if (onclick) {
          try {
            eval(onclick);
            return `eval onclick: ${onclick.substring(0, 100)}`;
          } catch { /* continue */ }
        }
        // Force click even if hidden
        (el as HTMLElement).click();
        return `force-clicked: ${text.substring(0, 30)}`;
      }
    }

    // 3. Try to find step navigation via data attributes
    const nextBtns = document.querySelectorAll('[data-step], [data-target], [data-slide="next"]');
    for (const btn of Array.from(nextBtns)) {
      (btn as HTMLElement).click();
      return 'clicked data-step/target element';
    }

    // 4. Look for tab navigation
    const tabs = document.querySelectorAll('.nav-tabs a, .nav-pills a, [role="tab"]');
    const tabArray = Array.from(tabs);
    if (tabArray.length > step) {
      (tabArray[step] as HTMLElement).click();
      return `clicked tab ${step}`;
    }

    return 'no_method_found';
  }, stepNum);

  logger.info({ step: stepNum, result: jsResult }, 'Navigate step result');

  await page.waitForTimeout(1000);
  await dacBrowser.screenshot(page, `step-${stepNum}-after-click`);

  return jsResult !== 'no_method_found';
}

/**
 * Creates a shipment in DAC via Playwright browser automation.
 */
export async function createShipment(
  page: Page,
  order: ShopifyOrder,
  paymentType: 'REMITENTE' | 'DESTINATARIO',
  dacUsername: string,
  dacPassword: string,
  tenantId: string
): Promise<DacShipmentResult> {
  const addr = order.shipping_address;

  if (!addr || !addr.address1) {
    throw new Error(`Order ${order.name} has no shipping address`);
  }

  await ensureLoggedIn(page, dacUsername, dacPassword, tenantId);

  logger.info({ tenantId, orderName: order.name, paymentType }, 'Creating shipment in DAC');

  // Navigate to new shipment form
  await page.goto(DAC_URLS.NEW_SHIPMENT, { waitUntil: 'domcontentloaded', timeout: 15_000 });

  // Wait for page to be interactive
  await page.waitForTimeout(2000);

  // INSPECT the DOM to understand the form structure
  await inspectFormDOM(page, 'new-shipment-loaded');
  await dacBrowser.screenshot(page, `form-initial-${order.name.replace('#', '')}`);

  // Check if form is a multi-step wizard or single page
  const formType = await page.evaluate(() => {
    // Check for common wizard patterns
    const hasSteps = document.querySelectorAll('[class*="step"], [class*="wizard"], [class*="fase"]').length > 0;
    const hasTabs = document.querySelectorAll('.nav-tabs, .nav-pills, [role="tablist"]').length > 0;
    const hasSiguiente = Array.from(document.querySelectorAll('a, button')).some(
      el => el.textContent?.toLowerCase().includes('siguiente')
    );
    const hasAgregar = Array.from(document.querySelectorAll('button')).some(
      el => el.textContent?.toLowerCase().includes('agregar')
    );

    // Check what fields are visible right now
    const visibleSelects = Array.from(document.querySelectorAll('select')).filter(
      s => (s as HTMLElement).offsetParent !== null
    ).map(s => s.name);

    const visibleInputs = Array.from(document.querySelectorAll('input:not([type="hidden"])')).filter(
      i => (i as HTMLElement).offsetParent !== null
    ).map(i => (i as HTMLInputElement).name);

    // Get all forms on the page
    const forms = Array.from(document.querySelectorAll('form')).map(f => ({
      id: f.id,
      action: f.action?.substring(0, 80),
      method: f.method,
    }));

    return {
      hasSteps,
      hasTabs,
      hasSiguiente,
      hasAgregar,
      visibleSelects,
      visibleInputs,
      forms,
    };
  });

  logger.info({ formType }, 'Form structure detected');

  // Try to find and wait for TipoServicio select
  let hasTipoServicio = false;
  try {
    await page.waitForSelector('select[name="TipoServicio"]', { timeout: 5_000 });
    hasTipoServicio = true;
  } catch {
    logger.warn('TipoServicio select not found, form may have different structure');
  }

  if (hasTipoServicio) {
    // ===== STANDARD FORM FLOW (as confirmed in selectors.ts) =====
    logger.info('Using standard DAC form flow');

    // Set all Step 1 fields via JS
    await page.evaluate(({ pickupVal, payVal, packageVal, deliveryVal }: {
      pickupVal: string; payVal: string; packageVal: string; deliveryVal: string;
    }) => {
      function setField(name: string, value: string) {
        const el = document.querySelector(`[name="${name}"]`) as HTMLSelectElement | HTMLInputElement;
        if (!el) return false;
        el.value = value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      setField('TipoServicio', pickupVal);
      setField('TipoGuia', payVal);
      setField('TipoEnvio', packageVal);
      setField('TipoEntrega', deliveryVal);
    }, {
      pickupVal: DAC_SELECTORS.PICKUP_VALUE_MOSTRADOR,
      payVal: paymentType === 'REMITENTE'
        ? DAC_SELECTORS.PAYMENT_VALUE_REMITENTE
        : DAC_SELECTORS.PAYMENT_VALUE_DESTINATARIO,
      packageVal: DAC_SELECTORS.PACKAGE_VALUE_PAQUETE,
      deliveryVal: DAC_SELECTORS.DELIVERY_VALUE_DOMICILIO,
    });

    logger.info({ paymentType }, 'Step 1 fields set');
    await page.waitForTimeout(500);
  }

  // Try to advance to next step
  const advanced1 = await navigateToNextStep(page, 1);
  if (!advanced1) {
    logger.warn('Could not advance past step 1, trying to fill all fields on current page');
  }

  // Try to advance step 2 (origin, pre-filled)
  await page.waitForTimeout(500);
  await navigateToNextStep(page, 2);

  // ===== FILL RECIPIENT DATA =====
  // Try to find recipient fields (may be on current page or next step)
  await page.waitForTimeout(1000);
  await inspectFormDOM(page, 'before-recipient-fields');

  const fullName = `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim() || 'Cliente';
  const phone = cleanPhone(addr.phone);

  // Fill all fields using page.evaluate to handle any visibility issues
  const fillResult = await page.evaluate(({ name, phoneNum, email, address, province, city, barrio }: {
    name: string; phoneNum: string; email: string; address: string;
    province: string; city: string; barrio: string;
  }) => {
    const results: string[] = [];

    function fillInput(selectors: string[], value: string, label: string) {
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLInputElement;
        if (el) {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          results.push(`${label}: filled via ${sel}`);
          return true;
        }
      }
      results.push(`${label}: NOT FOUND`);
      return false;
    }

    // Name
    fillInput([
      'input[name="nombre"]', 'input[name="NombreD"]',
      'input[name="nombre_destinatario"]', 'input[placeholder*="ombre"]',
    ], name, 'name');

    // Phone - DAC uses name="TelD" (confirmed from DOM inspection)
    fillInput([
      'input[name="TelD"]', 'input[name="telefono"]', 'input[name="TelefonoD"]',
      'input[name="tel"]', 'input[type="tel"]', 'input[placeholder*="el"]',
    ], phoneNum, 'phone');

    // Email
    if (email) {
      fillInput([
        'input[name="email"]', 'input[name="EmailD"]',
        'input[type="email"]', 'input[placeholder*="mail"]',
      ], email, 'email');
    }

    // Address
    fillInput([
      '#DirD', 'input[name="DirD"]',
      'input[name="direccion"]', 'input[name="DireccionD"]',
      'input[placeholder*="irecc"]',
    ], address, 'address');

    return results;
  }, {
    name: fullName,
    phoneNum: phone,
    email: order.email ?? '',
    address: addr.address1,
    province: addr.province ?? '',
    city: addr.city ?? '',
    barrio: addr.address2 ?? '',
  });

  logger.info({ fillResult }, 'Recipient fields fill result');

  // Department (select)
  if (addr.province) {
    try {
      const deptMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_DEPARTMENT, addr.province);
      if (deptMatch) {
        await page.selectOption(DAC_SELECTORS.RECIPIENT_DEPARTMENT, deptMatch);
        await page.waitForTimeout(1500);
        logger.info({ province: addr.province, matched: deptMatch }, 'Department selected');
      }
    } catch (err) {
      logger.warn({ province: addr.province, error: (err as Error).message }, 'Error selecting department');
    }
  }

  // City
  if (addr.city) {
    try {
      const cityMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_CITY, addr.city);
      if (cityMatch) {
        await page.selectOption(DAC_SELECTORS.RECIPIENT_CITY, cityMatch);
        await page.waitForTimeout(800);
        logger.info({ city: addr.city, matched: cityMatch }, 'City selected');
      } else {
        const firstOpt = await page.$$eval(`${DAC_SELECTORS.RECIPIENT_CITY} option`,
          (opts: any[]) => { const v = opts.filter(o => o.value && o.value !== '0'); return v[0]?.value || null; });
        if (firstOpt) await page.selectOption(DAC_SELECTORS.RECIPIENT_CITY, firstOpt);
      }
    } catch (err) {
      logger.warn({ city: addr.city, error: (err as Error).message }, 'Error selecting city');
    }
  }

  // Barrio
  try {
    const barrioEl = await page.$(DAC_SELECTORS.RECIPIENT_BARRIO);
    if (barrioEl) {
      const firstBarrio = await page.$$eval(`${DAC_SELECTORS.RECIPIENT_BARRIO} option`,
        (opts: any[]) => { const v = opts.filter(o => o.value && o.value !== '0' && o.value !== ''); return v[0]?.value || null; });
      if (firstBarrio) await page.selectOption(DAC_SELECTORS.RECIPIENT_BARRIO, firstBarrio);
    }
  } catch { /* barrio optional */ }

  // Try to advance to step 4 (quantity + submit)
  await navigateToNextStep(page, 3);
  await page.waitForTimeout(1000);

  // Set quantity and package size on step 4
  await page.evaluate(() => {
    function setField(name: string, value: string) {
      const el = document.querySelector(`[name="${name}"]`) as HTMLSelectElement | HTMLInputElement;
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Quantity = 1
    setField('Cantidad', '1');
    // Package size: 1 = "Hasta 2Kg 20x20x20" (chico)
    setField('K_Tipo_Empaque', '1');
  });
  await page.waitForTimeout(500);

  // Take screenshot before submit
  await dacBrowser.screenshot(page, `pre-submit-${order.name.replace('#', '')}`);

  // ===== SUBMIT =====
  // The form action is /envios/SaveGuias (confirmed from DOM).
  // The "Agregar" button (class btnAdd) may be hidden due to step navigation.
  // Strategy: use the form's btnAdd click via JS, OR submit the form directly.
  const submitResult = await page.evaluate(() => {
    // 1. Try clicking btnAdd (the actual submit button for adding to cart)
    const btnAdd = document.querySelector('.btnAdd') as HTMLButtonElement;
    if (btnAdd) {
      btnAdd.click();
      return 'clicked: .btnAdd';
    }

    // 2. Try any button with "Agregar" text
    const btns = Array.from(document.querySelectorAll('button'));
    for (const btn of btns) {
      if (btn.textContent?.toLowerCase().includes('agregar')) {
        btn.click();
        return `clicked: ${btn.textContent.trim().substring(0, 30)}`;
      }
    }

    // 3. Try form submit directly to SaveGuias
    const form = document.querySelector('#formNuevo, form[action*="SaveGuias"]') as HTMLFormElement;
    if (form) {
      form.submit();
      return 'form.submit() to SaveGuias';
    }

    return 'no_submit_found';
  });

  logger.info({ submitResult }, 'Submit result');

  // Wait for DAC to process
  await page.waitForTimeout(4000);
  await dacBrowser.screenshot(page, `post-submit-${order.name.replace('#', '')}`);

  // Check if we were redirected to cart (success) or stayed on form (error)
  const currentUrl = page.url();
  logger.info({ currentUrl }, 'Post-submit URL');

  // Extract guia by checking the cart/history page
  let guia = '';

  // Navigate to envios history to find the latest shipment
  await page.goto(DAC_URLS.CART, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.waitForTimeout(2000);
  await dacBrowser.screenshot(page, `cart-after-submit-${order.name.replace('#', '')}`);

  // Look for the first guia number in the table (most recent shipment)
  const guiaFromCart = await page.evaluate(() => {
    // DAC cart page has a table with guia numbers in the first column
    const rows = document.querySelectorAll('table tr, .envio-row, [class*="envio"]');
    for (const row of Array.from(rows)) {
      const text = row.textContent ?? '';
      // DAC guia numbers are 12+ digit numbers starting with 88
      const match = text.match(/\b(88\d{10,})\b/);
      if (match) return match[1];
    }
    // Fallback: any 12+ digit number in the page
    const pageText = document.body?.textContent ?? '';
    const allGuias = pageText.match(/\b(88\d{10,})\b/g);
    if (allGuias && allGuias.length > 0) return allGuias[0]; // First (most recent)
    return null;
  });

  if (guiaFromCart) {
    guia = guiaFromCart;
    logger.info({ guia }, 'Guia extracted from cart page');
  } else {
    guia = `PENDING-${Date.now()}`;
    logger.warn({ orderName: order.name }, 'Could not extract guia from cart');
  }

  logger.info({ orderName: order.name, guia, tenantId }, 'DAC shipment created');
  return { guia, screenshotPath: '' };
}
