import { Page } from 'playwright';
import { StepLogger } from '../logger';
import { DAC_STEPS } from './steps';

/**
 * Auto-payment config decrypted + validated in the job orchestrator.
 * Passed to createShipment when paymentType === REMITENTE and the tenant has
 * paymentAutoEnabled = true.
 */
export interface AutoPayConfig {
  brand: 'mastercard' | 'visa' | 'oca';
  last4: string;   // e.g. "3294"
  cvc: string;     // decrypted CVC (plain text, in-memory only)
}

export type PaymentOutcome =
  | { status: 'paid' }
  | { status: 'pending_manual'; reason: '3ds_required' | 'timeout' | 'saved_card_not_found' | 'selector_failure' | 'unknown' }
  | { status: 'failed_rejected'; reason: 'card_rejected' };

// Max time to wait for each Plexo step before declaring timeout
const PLEXO_STEP_TIMEOUT_MS = 30_000;
const PLEXO_FINAL_TIMEOUT_MS = 90_000; // 3DS + processing can be slow

/**
 * Drives the Plexo saved-card + CVC flow on secure.plexo.com.uy.
 *
 * Called AFTER the "Finalizar envío" button has been clicked on the DAC
 * shipment form. DAC triggers `/envios/initiate_payWithFiserv` which returns a
 * Plexo token and auto-submits a form, redirecting to
 * `https://secure.plexo.com.uy/{hash}`.
 *
 * From there, for a user with a saved card, the flow is:
 *   1. Click the "Tarjeta de débito/crédito" brand tile (Mastercard/VISA/OCA)
 *   2. Select the saved-card radio (identified by last4)
 *   3. Click CONTINUAR → navigates to /{hash}/cvv
 *   4. Fill the CVV input
 *   5. Click CONTINUAR → Plexo processes payment
 *   6. On success → Plexo redirects back to dac.com.uy/envios/guiacreada/{id}
 *      On 3DS → Plexo shows an OTP/verification challenge
 *      On decline → Plexo shows an error message
 *
 * This function NEVER throws on payment failure — it returns a structured
 * PaymentOutcome so the caller can mark the label appropriately. It only
 * throws on unexpected Playwright errors (context destroyed, browser closed).
 *
 * IMPORTANT: the caller must invoke this ONLY after clicking Finalizar, and
 * ONLY when paymentType === REMITENTE. Calling it on a DESTINATARIO shipment
 * will time out (no Plexo redirect happens).
 */
export async function handlePaymentFlow(
  page: Page,
  cfg: AutoPayConfig,
  slog: StepLogger,
): Promise<PaymentOutcome> {
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, '[pay] awaiting Plexo redirect after Finalizar');

  // --- Step 0: wait for Plexo to take over ---
  try {
    await page.waitForURL('**/secure.plexo.com.uy/**', { timeout: PLEXO_STEP_TIMEOUT_MS });
  } catch {
    // Might already be on Plexo, or the DAC flow never redirected (DESTINATARIO
    // mis-routed here, or payment was bypassed). Check current URL:
    const url = page.url();
    if (!url.includes('plexo.com.uy')) {
      slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] no Plexo redirect (current: ${url}) — treating as pending`);
      return { status: 'pending_manual', reason: 'selector_failure' };
    }
  }
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] on Plexo: ${page.url()}`);

  // --- Step 1: click the brand tile (Mastercard/VISA/OCA) ---
  // The tile acts as a section toggle revealing the saved-card list.
  // On the initial Plexo page the CONTINUAR is disabled until a section opens.
  try {
    // The "Tarjeta de débito/crédito" block is the whole container with the 3
    // brand icons. Clicking anywhere in the block opens the saved-card list.
    // We click the text label first; if that fails we try the brand-specific icon.
    const brandTileClicked = await page.evaluate((brand: string) => {
      // Try to find the heading "Tarjeta de débito/crédito" and click its card container
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, p, div, span'));
      const heading = headings.find(el => {
        const t = (el.textContent ?? '').trim().toLowerCase();
        return t === 'tarjeta de débito/crédito' || t === 'tarjeta de debito/credito';
      });
      if (heading) {
        const clickable = heading.closest('[role=button], button, a, [class*=card i], [class*=option i], div, section') as HTMLElement | null;
        if (clickable) {
          clickable.click();
          return 'heading-parent';
        }
        (heading as HTMLElement).click();
        return 'heading-self';
      }
      // Fallback: click any element whose img alt matches the brand
      const imgs = Array.from(document.querySelectorAll('img'));
      const match = imgs.find(img => (img.alt ?? '').toLowerCase().includes(brand));
      if (match) {
        (match.closest('button, a, [role=button], div') as HTMLElement | null)?.click();
        return 'brand-icon';
      }
      return 'none';
    }, cfg.brand);

    slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] brand tile click: ${brandTileClicked}`);
    if (brandTileClicked === 'none') {
      return { status: 'pending_manual', reason: 'selector_failure' };
    }
    await page.waitForTimeout(800); // let the section expand
  } catch (err) {
    slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] brand tile click failed: ${(err as Error).message}`);
    return { status: 'pending_manual', reason: 'selector_failure' };
  }

  // --- Step 2: select the saved-card radio identified by last4 ---
  const savedCardSelected = await page.evaluate((last4: string) => {
    // Find text "**** {last4}" in the document, walk up to the radio input
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const txt = node.textContent ?? '';
      if (txt.includes(last4) && /\*{2,}/.test(txt)) {
        let el: HTMLElement | null = node.parentElement;
        // Search up to 6 ancestors for an <input type=radio>
        for (let i = 0; i < 6 && el; i++) {
          const radio = el.querySelector('input[type=radio]') as HTMLInputElement | null;
          if (radio) {
            radio.checked = true;
            radio.dispatchEvent(new Event('change', { bubbles: true }));
            radio.dispatchEvent(new Event('click', { bubbles: true }));
            radio.click();
            return true;
          }
          el = el.parentElement;
        }
      }
    }
    return false;
  }, cfg.last4);

  if (!savedCardSelected) {
    slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] saved card ending in ${cfg.last4} not found on Plexo page`);
    return { status: 'pending_manual', reason: 'saved_card_not_found' };
  }
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] saved card **** ${cfg.last4} selected`);
  await page.waitForTimeout(300);

  // --- Step 3: click CONTINUAR, expect navigation to /cvv ---
  try {
    await Promise.all([
      page.waitForURL('**/cvv**', { timeout: PLEXO_STEP_TIMEOUT_MS }),
      page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const btn = btns.find(b => (b.textContent ?? '').trim().toUpperCase().includes('CONTINUAR'));
        if (btn) (btn as HTMLButtonElement).click();
      }),
    ]);
  } catch {
    slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] CONTINUAR to /cvv did not navigate — url=${page.url()}`);
    // Maybe already there (fast navigation) — check
    if (!page.url().includes('/cvv')) {
      return { status: 'pending_manual', reason: 'selector_failure' };
    }
  }
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, '[pay] on /cvv step');

  // --- Step 4: fill CVV input ---
  try {
    // The CVV input is a single text-like input — try multiple selectors
    const filled = await page.evaluate((cvc: string) => {
      const candidates = Array.from(document.querySelectorAll<HTMLInputElement>(
        'input[type=text], input[type=tel], input[type=password], input[inputmode=numeric], input[autocomplete*=security], input'
      ));
      // Prefer an input whose label/placeholder mentions "seguridad" or "cvv"/"cvc"
      let target: HTMLInputElement | undefined;
      for (const inp of candidates) {
        const ctx = `${inp.placeholder ?? ''} ${inp.getAttribute('aria-label') ?? ''} ${inp.name ?? ''} ${inp.id ?? ''}`.toLowerCase();
        const labelText = (inp.labels && inp.labels[0]?.textContent) ? inp.labels[0].textContent.toLowerCase() : '';
        if (ctx.includes('seguridad') || ctx.includes('cvv') || ctx.includes('cvc') ||
            labelText.includes('seguridad') || labelText.includes('cvv') || labelText.includes('cvc')) {
          target = inp;
          break;
        }
      }
      // Fallback: first visible input
      if (!target) {
        target = candidates.find(i => i.offsetParent !== null);
      }
      if (!target) return false;
      // React-friendly value set
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(target, cvc);
      else target.value = cvc;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, cfg.cvc);

    if (!filled) {
      slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, '[pay] CVV input not found');
      return { status: 'pending_manual', reason: 'selector_failure' };
    }
    slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, '[pay] CVV filled');
  } catch (err) {
    slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] CVV fill failed: ${(err as Error).message}`);
    return { status: 'pending_manual', reason: 'selector_failure' };
  }

  // --- Step 5: click CONTINUAR and race on final outcomes ---
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const btn = btns.find(b => (b.textContent ?? '').trim().toUpperCase().includes('CONTINUAR'));
    if (btn) (btn as HTMLButtonElement).click();
  });
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, '[pay] CONTINUAR clicked on /cvv — awaiting outcome');

  type RaceWinner = 'success' | '3ds' | 'rejected' | 'timeout';
  const outcome = await Promise.race<RaceWinner>([
    // Success: Plexo redirects back to DAC confirmation
    page.waitForURL('**/envios/guiacreada/**', { timeout: PLEXO_FINAL_TIMEOUT_MS }).then(() => 'success' as const).catch(() => 'timeout' as const),
    // Also treat any return to dac.com.uy as success-ish (guía extractor will verify)
    page.waitForURL(/dac\.com\.uy/, { timeout: PLEXO_FINAL_TIMEOUT_MS }).then(() => 'success' as const).catch(() => 'timeout' as const),
    // 3DS / OTP challenge
    page.waitForSelector(
      'text=/c[oó]digo.*sms|autenticaci[oó]n|verificaci[oó]n|desaf[ií]o|otp|one[- ]time/i',
      { timeout: PLEXO_FINAL_TIMEOUT_MS }
    ).then(() => '3ds' as const).catch(() => 'timeout' as const),
    // Rejection messages
    page.waitForSelector(
      'text=/rechazad|denegad|insuficient|inv[aá]lid|error.*pago|no.*autorizad/i',
      { timeout: PLEXO_FINAL_TIMEOUT_MS }
    ).then(() => 'rejected' as const).catch(() => 'timeout' as const),
  ]);

  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] Plexo outcome: ${outcome} (url=${page.url()})`);

  switch (outcome) {
    case 'success':
      return { status: 'paid' };
    case '3ds':
      return { status: 'pending_manual', reason: '3ds_required' };
    case 'rejected':
      return { status: 'failed_rejected', reason: 'card_rejected' };
    case 'timeout':
    default:
      // Check URL one more time — Plexo might have completed without emitting
      // a detectable DOM change in time.
      if (page.url().includes('dac.com.uy') && !page.url().includes('plexo.com.uy')) {
        return { status: 'paid' };
      }
      return { status: 'pending_manual', reason: 'timeout' };
  }
}
