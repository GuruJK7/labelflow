import { Page } from 'playwright';
import { ShopifyOrder } from '../shopify/types';
import { DacShipmentResult } from './types';
import { DAC_SELECTORS, DAC_URLS } from './selectors';
import { ensureLoggedIn } from './auth';
import { dacBrowser } from './browser';
import logger from '../logger';

function cleanPhone(phone: string | undefined): string {
  if (!phone) return '099000000';
  const cleaned = phone.replace(/\D/g, '');
  return cleaned.length >= 6 ? cleaned : '099000000';
}

async function clickNextButton(page: Page, stepNum: number): Promise<void> {
  // There are multiple "Siguiente" links, one per step. Click the visible one.
  const nextLinks = await page.$$('a[href="javascript:"]');
  for (const link of nextLinks) {
    const text = await link.textContent();
    const isVisible = await link.isVisible();
    if (text?.includes('Siguiente') && isVisible) {
      await link.click();
      await page.waitForTimeout(1000);
      logger.debug({ step: stepNum }, 'Clicked Siguiente');
      return;
    }
  }
  logger.warn({ step: stepNum }, 'Could not find visible Siguiente button');
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

  await ensureLoggedIn(page, dacUsername, dacPassword);

  logger.info({ tenantId, orderName: order.name, paymentType }, 'Creating shipment in DAC');

  // Navigate to new shipment form
  await page.goto(DAC_URLS.NEW_SHIPMENT, { waitUntil: 'networkidle' });
  await page.waitForSelector(DAC_SELECTORS.PICKUP_TYPE, { timeout: 10000 });

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
  await page.waitForSelector(DAC_SELECTORS.RECIPIENT_NAME, { timeout: 5000 });

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

  // Departamento (select by label)
  if (addr.province) {
    try {
      await page.selectOption(DAC_SELECTORS.RECIPIENT_DEPARTMENT, { label: addr.province });
      // Wait for dynamic city dropdown to load
      await page.waitForTimeout(2000);
    } catch {
      logger.warn({ province: addr.province }, 'Could not select department');
    }
  }

  // Ciudad (dynamic, loaded after department)
  if (addr.city) {
    try {
      await page.selectOption(DAC_SELECTORS.RECIPIENT_CITY, { label: addr.city });
      await page.waitForTimeout(1000);
    } catch {
      logger.warn({ city: addr.city }, 'Could not select city');
    }
  }

  // Barrio (dynamic, loaded after city) — try with address2
  if (addr.address2) {
    try {
      await page.selectOption(DAC_SELECTORS.RECIPIENT_BARRIO, { label: addr.address2 });
    } catch {
      logger.debug('Could not select barrio, trying first option');
      // Select first non-empty option as fallback
      try {
        const options = await page.$$eval(
          `${DAC_SELECTORS.RECIPIENT_BARRIO} option`,
          (opts) => opts.filter((o: any) => o.value !== '0').map((o: any) => o.value)
        );
        if (options.length > 0) {
          await page.selectOption(DAC_SELECTORS.RECIPIENT_BARRIO, options[0]);
        }
      } catch { /* barrio might not be required */ }
    }
  }

  // Click Siguiente (step 3 -> step 4)
  await clickNextButton(page, 3);

  // ===== STEP 4: Cantidad + Submit =====
  // Quantity defaults to 1, just verify
  try {
    await page.fill(DAC_SELECTORS.PACKAGE_QUANTITY, '1');
  } catch {
    logger.debug('Quantity field not found, using default');
  }

  // Screenshot before submit
  await dacBrowser.screenshot(page, `pre-submit-${order.name.replace('#', '')}`);

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

  // Wait for response
  await page.waitForTimeout(3000);

  // Screenshot after submit
  const ssPath = await dacBrowser.screenshot(page, `post-submit-${order.name.replace('#', '')}`);

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
