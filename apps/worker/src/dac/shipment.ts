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
 * Tries: exact label, case-insensitive, accent-insensitive, partial contains.
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

  // 1. Exact match (case-insensitive, accent-insensitive)
  for (const opt of options) {
    if (normalize(opt.text) === search && opt.value && opt.value !== '0') {
      return opt.value;
    }
  }

  // 2. Option contains search text
  for (const opt of options) {
    if (normalize(opt.text).includes(search) && opt.value && opt.value !== '0') {
      return opt.value;
    }
  }

  // 3. Search text contains option text
  for (const opt of options) {
    if (opt.text.length > 2 && search.includes(normalize(opt.text)) && opt.value && opt.value !== '0') {
      return opt.value;
    }
  }

  // 4. Word-level match (any word in search matches any word in option)
  const searchWords = search.split(/\s+/);
  for (const opt of options) {
    const optWords = normalize(opt.text).split(/\s+/);
    const hasMatch = searchWords.some(sw => optWords.some(ow => ow === sw && sw.length > 2));
    if (hasMatch && opt.value && opt.value !== '0') {
      return opt.value;
    }
  }

  return null;
}

function cleanPhone(phone: string | undefined): string {
  if (!phone) return '099000000';
  const cleaned = phone.replace(/\D/g, '');
  return cleaned.length >= 6 ? cleaned : '099000000';
}

async function clickNextButton(page: Page, stepNum: number): Promise<void> {
  // Strategy 1: Find visible "Siguiente" link
  const nextLinks = await page.$$('a[href="javascript:"], a[href="javascript:void(0)"], a[href="#"]');
  for (const link of nextLinks) {
    const text = await link.textContent();
    const isVisible = await link.isVisible();
    if (text?.toLowerCase().includes('siguiente') && isVisible) {
      await link.click();
      await page.waitForTimeout(800);
      logger.info({ step: stepNum }, 'Clicked Siguiente link');
      return;
    }
  }

  // Strategy 2: Find any button/link with "Siguiente" text
  try {
    const btn = await page.$('button:has-text("Siguiente"), input[value*="Siguiente"], a:has-text("Siguiente")');
    if (btn) {
      const isVisible = await btn.isVisible();
      if (isVisible) {
        await btn.click();
        await page.waitForTimeout(800);
        logger.info({ step: stepNum }, 'Clicked Siguiente button');
        return;
      }
    }
  } catch { /* continue */ }

  // Strategy 3: Try clicking via JS (for hidden elements that are triggered by JS)
  try {
    await page.evaluate((step: number) => {
      const links = Array.from(document.querySelectorAll('a'));
      const nextLink = links.find(a =>
        a.textContent?.toLowerCase().includes('siguiente') &&
        a.offsetParent !== null
      );
      if (nextLink) {
        (nextLink as HTMLElement).click();
        return true;
      }
      // Try any "next" style button
      const btns = Array.from(document.querySelectorAll('button, input[type="button"]'));
      const nextBtn = btns.find(b =>
        b.textContent?.toLowerCase().includes('siguiente') ||
        (b as HTMLInputElement).value?.toLowerCase().includes('siguiente')
      );
      if (nextBtn) {
        (nextBtn as HTMLElement).click();
        return true;
      }
      return false;
    }, stepNum);
    await page.waitForTimeout(800);
    logger.info({ step: stepNum }, 'Clicked Siguiente via JS evaluate');
  } catch (err) {
    logger.warn({ step: stepNum, error: (err as Error).message }, 'Could not find Siguiente button');
  }
}

/**
 * Creates a shipment in DAC via Playwright browser automation.
 * Follows the confirmed 4-step form flow.
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

  // Navigate to new shipment form (domcontentloaded is faster than networkidle)
  await page.goto(DAC_URLS.NEW_SHIPMENT, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.waitForSelector(DAC_SELECTORS.PICKUP_TYPE, { timeout: 8_000 });

  // ===== STEP 1: Shipment Type =====
  // Solicitud: Mostrador
  await page.selectOption(DAC_SELECTORS.PICKUP_TYPE, DAC_SELECTORS.PICKUP_VALUE_MOSTRADOR);

  // Tipo de Guia (pago): 1=Remitente, 4=Destinatario
  const payValue = paymentType === 'REMITENTE'
    ? DAC_SELECTORS.PAYMENT_VALUE_REMITENTE
    : DAC_SELECTORS.PAYMENT_VALUE_DESTINATARIO;
  await page.selectOption(DAC_SELECTORS.PAYMENT_TYPE, payValue);

  // Tipo de envio: Paquete
  await page.selectOption(DAC_SELECTORS.PACKAGE_TYPE, DAC_SELECTORS.PACKAGE_VALUE_PAQUETE);

  // Tipo de entrega: Domicilio
  await page.selectOption(DAC_SELECTORS.DELIVERY_TYPE, DAC_SELECTORS.DELIVERY_VALUE_DOMICILIO);
  await page.waitForTimeout(500);

  // Click Siguiente (step 1 -> step 2)
  await clickNextButton(page, 1);

  // ===== STEP 2: Origen (auto-filled) =====
  // Just click Siguiente (origin is pre-filled from account)
  await clickNextButton(page, 2);

  // ===== STEP 3: Destino =====
  await page.waitForSelector(DAC_SELECTORS.RECIPIENT_NAME, { timeout: 8_000 });

  // Nombre
  const fullName = `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim() || 'Cliente';
  await page.fill(DAC_SELECTORS.RECIPIENT_NAME, fullName);

  // Telefono
  await page.fill(DAC_SELECTORS.RECIPIENT_PHONE, cleanPhone(addr.phone));

  // Email (optional)
  if (order.email) {
    try {
      await page.fill(DAC_SELECTORS.RECIPIENT_EMAIL, order.email);
    } catch { /* optional field */ }
  }

  // Direccion
  await page.fill(DAC_SELECTORS.RECIPIENT_ADDRESS, addr.address1);

  // Departamento (select by partial match, case insensitive)
  if (addr.province) {
    try {
      const deptMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_DEPARTMENT, addr.province);
      if (deptMatch) {
        await page.selectOption(DAC_SELECTORS.RECIPIENT_DEPARTMENT, deptMatch);
        await page.waitForTimeout(1200); // Wait for city dropdown to load
        logger.info({ province: addr.province, matched: deptMatch }, 'Department selected');
      } else {
        logger.warn({ province: addr.province }, 'Could not match department');
      }
    } catch (err) {
      logger.warn({ province: addr.province, error: (err as Error).message }, 'Error selecting department');
    }
  }

  // Ciudad (dynamic, loaded after department — partial match)
  if (addr.city) {
    try {
      const cityMatch = await findBestOptionMatch(page, DAC_SELECTORS.RECIPIENT_CITY, addr.city);
      if (cityMatch) {
        await page.selectOption(DAC_SELECTORS.RECIPIENT_CITY, cityMatch);
        await page.waitForTimeout(800); // Wait for barrio dropdown
        logger.info({ city: addr.city, matched: cityMatch }, 'City selected');
      } else {
        // Fallback: select first non-empty option
        const firstOption = await page.$$eval(
          `${DAC_SELECTORS.RECIPIENT_CITY} option`,
          (opts: any[]) => {
            const valid = opts.filter(o => o.value && o.value !== '0' && o.value !== '');
            return valid.length > 0 ? valid[0].value : null;
          }
        );
        if (firstOption) {
          await page.selectOption(DAC_SELECTORS.RECIPIENT_CITY, firstOption);
          await page.waitForTimeout(1000);
          logger.warn({ city: addr.city, fallback: firstOption }, 'City not matched, using first option');
        } else {
          logger.warn({ city: addr.city }, 'No city options available');
        }
      }
    } catch (err) {
      logger.warn({ city: addr.city, error: (err as Error).message }, 'Error selecting city');
    }
  }

  // Barrio (dynamic, loaded after city — try match, fallback to first)
  try {
    const barrioSelector = DAC_SELECTORS.RECIPIENT_BARRIO;
    const barrioExists = await page.$(barrioSelector);
    if (barrioExists) {
      if (addr.address2) {
        const barrioMatch = await findBestOptionMatch(page, barrioSelector, addr.address2);
        if (barrioMatch) {
          await page.selectOption(barrioSelector, barrioMatch);
        } else {
          // Select first valid option
          const first = await page.$$eval(
            `${barrioSelector} option`,
            (opts: any[]) => {
              const valid = opts.filter(o => o.value && o.value !== '0' && o.value !== '');
              return valid.length > 0 ? valid[0].value : null;
            }
          );
          if (first) await page.selectOption(barrioSelector, first);
        }
      } else {
        // No address2, just pick first barrio
        const first = await page.$$eval(
          `${barrioSelector} option`,
          (opts: any[]) => {
            const valid = opts.filter(o => o.value && o.value !== '0' && o.value !== '');
            return valid.length > 0 ? valid[0].value : null;
          }
        );
        if (first) await page.selectOption(barrioSelector, first);
      }
    }
  } catch { /* barrio might not exist or not be required */ }

  // Click Siguiente (step 3 -> step 4)
  await clickNextButton(page, 3);

  // ===== STEP 4: Cantidad + Submit =====
  // Quantity defaults to 1, just verify
  try {
    await page.fill(DAC_SELECTORS.PACKAGE_QUANTITY, '1');
  } catch {
    logger.debug('Quantity field not found, using default');
  }

  // Skip pre-submit screenshot in production (saves ~2s)

  // Click "Agregar" (final submit)
  const agregarBtn = await page.$('button:has-text("Agregar")');
  if (!agregarBtn) {
    // Fallback: find any button with class btn-secondary
    const fallback = await page.$('button.btn-secondary');
    if (fallback) {
      await fallback.click();
    } else {
      throw new Error('Could not find Agregar submit button');
    }
  } else {
    await agregarBtn.click();
  }

  // Wait for response (reduced from 3s)
  await page.waitForTimeout(2000);

  // Screenshot only for debugging (skip in fast mode)
  const ssPath = '';

  // Try to extract guia number from the page
  let guia = '';
  const pageText = await page.textContent('body') ?? '';

  // Look for guia patterns
  const guiaPatterns = [
    /gu[ií]a[:\s#]*(\d{6,})/i,
    /tracking[:\s#]*(\d{6,})/i,
    /n[uú]mero[:\s#]*(\d{6,})/i,
    /envio[:\s#]*(\d{6,})/i,
    /DAC[:\s-]*(\d{6,})/i,
  ];

  for (const pattern of guiaPatterns) {
    const match = pageText.match(pattern);
    if (match) {
      guia = match[1];
      break;
    }
  }

  // If no guia found, it might be in the cart page
  if (!guia) {
    logger.warn('No guia found on page, checking cart...');
    await page.goto(DAC_URLS.HISTORY, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const cartText = await page.textContent('body') ?? '';
    for (const pattern of guiaPatterns) {
      const match = cartText.match(pattern);
      if (match) {
        guia = match[1];
        break;
      }
    }
  }

  if (!guia) {
    // Use timestamp as temporary ID
    guia = `PENDING-${Date.now()}`;
    logger.warn({ orderName: order.name, ssPath }, 'Could not extract guia, using temporary ID');
  }

  logger.info({ orderName: order.name, guia, tenantId }, 'DAC shipment created');
  return { guia, screenshotPath: ssPath };
}
