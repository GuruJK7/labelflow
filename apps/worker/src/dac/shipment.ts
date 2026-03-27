import { Page } from 'playwright';
import { ShopifyOrder } from '../shopify/types';
import { DacShipmentResult } from './types';
import { DAC, DAC_URLS } from './selectors';
import { ensureLoggedIn } from './auth';
import { dacBrowser } from './browser';
import logger from '../logger';
import { cleanPhone } from '../utils';

/**
 * Creates a shipment in DAC via Playwright browser automation.
 * Uses confirmed selectors from live DOM inspection.
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

  logger.info({
    tenantId,
    orderId: order.id,
    orderName: order.name,
    paymentType,
  }, 'Creating shipment in DAC');

  // 1. Navigate directly to new shipment form
  await page.goto(DAC_URLS.NEW_SHIPMENT, { waitUntil: 'networkidle' });

  // 2. Pickup type: Mostrador (value=0)
  try {
    await page.selectOption(DAC.shipment.pickupType, DAC.shipment.pickupValues.mostrador);
  } catch {
    logger.debug('TipoServicio select not found, may have different name in /envios/nuevo');
  }

  // 3. Delivery type: Domicilio (value=2)
  try {
    await page.selectOption(DAC.shipment.deliveryType, DAC.shipment.deliveryValues.domicilio);
    await page.waitForLoadState('networkidle');
  } catch {
    logger.warn('Could not set delivery type to domicilio');
  }

  // 4. Package type: Paquete (value=1)
  try {
    await page.selectOption(DAC.shipment.packageType, DAC.shipment.packageValues.paquete);
  } catch {
    logger.debug('TipoEnvio select not found');
  }

  // 5. Payment type via hidden TipoGuia field
  try {
    const payValue = paymentType === 'REMITENTE' ? '1' : '2';
    await page.evaluate(
      ({ selector, value }) => {
        const el = document.querySelector(selector) as HTMLInputElement | null;
        if (el) el.value = value;
      },
      { selector: DAC.shipment.paymentType, value: payValue }
    );
  } catch {
    logger.warn('Could not set TipoGuia hidden field');
  }

  // 6. Department (select K_Estado, by label text)
  try {
    await page.selectOption(DAC.shipment.department, { label: addr.province ?? '' });
    // Wait for dynamic city loading
    await page.waitForTimeout(1500);
  } catch {
    logger.warn({ province: addr.province }, 'Could not select department');
  }

  // 7. City (select K_Ciudad, dynamic)
  try {
    await page.selectOption(DAC.shipment.city, { label: addr.city ?? '' });
  } catch {
    logger.warn({ city: addr.city }, 'Could not select city');
  }

  // 8. Address
  try {
    await page.fill(DAC.shipment.address, addr.address1);
  } catch {
    logger.warn('Could not fill address field');
  }

  // 9. Recipient name
  const fullName = `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim() || 'Cliente';
  try {
    const nameSelectors = DAC.shipment.recipientName.split(',').map((s: string) => s.trim());
    for (const sel of nameSelectors) {
      const el = await page.$(sel);
      if (el) { await page.fill(sel, fullName); break; }
    }
  } catch {
    logger.warn('Could not fill recipient name');
  }

  // 10. Recipient phone
  const phone = cleanPhone(addr.phone);
  try {
    const phoneSelectors = DAC.shipment.recipientPhone.split(',').map((s: string) => s.trim());
    for (const sel of phoneSelectors) {
      const el = await page.$(sel);
      if (el) { await page.fill(sel, phone); break; }
    }
  } catch {
    logger.warn('Could not fill recipient phone');
  }

  // 11. Quantity
  try {
    await page.fill(DAC.shipment.quantity, '1');
  } catch {
    logger.debug('Quantity field not found, may default to 1');
  }

  // 12. Screenshot before submit
  await dacBrowser.screenshot(page, `pre-submit-${order.name.replace('#', '')}`);

  // 13. Submit
  try {
    const submitSelectors = DAC.shipment.submitButton.split(',').map((s: string) => s.trim());
    for (const sel of submitSelectors) {
      const el = await page.$(sel);
      if (el) { await page.click(sel); break; }
    }
  } catch {
    throw new Error('Could not find submit button');
  }

  // 14. Wait for confirmation and extract guia
  let guia = '';

  try {
    await page.waitForSelector(DAC.shipment.successMessage, { timeout: 15_000 }).catch(() => {});

    const guiaSelectors = DAC.shipment.guiaDisplay.split(',').map((s: string) => s.trim());
    for (const sel of guiaSelectors) {
      const el = await page.$(sel);
      if (el) {
        const text = await page.textContent(sel);
        guia = (text ?? '').replace(/\D/g, '').trim();
        if (guia) break;
      }
    }
  } catch {
    // Fallback: regex search in page
  }

  if (!guia) {
    const pageText = await page.textContent('body');
    const match = pageText?.match(/(?:gu[ií]a|tracking|n[uú]mero)[:\s]*(\d{6,})/i);
    if (match) guia = match[1];
  }

  if (!guia) {
    const ssPath = await dacBrowser.screenshot(page, `no-guia-${order.name.replace('#', '')}`);
    throw new Error(`Could not extract guia number. Screenshot: ${ssPath}`);
  }

  const ssPath = await dacBrowser.screenshot(page, `success-${order.name.replace('#', '')}`);
  logger.info({ orderId: order.id, orderName: order.name, guia, tenantId }, 'DAC shipment created');

  return { guia, screenshotPath: ssPath };
}
