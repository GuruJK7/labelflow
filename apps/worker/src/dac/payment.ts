import { Page } from 'playwright';
import { writeFile } from 'fs/promises';
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
  | {
      status: 'pending_manual';
      reason:
        | '3ds_required'
        | 'timeout'
        | 'saved_card_not_found'
        | 'selector_failure'
        | 'cart_not_reached'
        | 'terms_not_found'
        | 'pagar_not_clickable'
        | 'unknown';
    }
  | { status: 'failed_rejected'; reason: 'card_rejected' };

// Max time to wait for each Plexo step before declaring timeout
const PLEXO_STEP_TIMEOUT_MS = 30_000;
const PLEXO_FINAL_TIMEOUT_MS = 90_000; // 3DS + processing can be slow
// DAC cart (T&C + PAGAR) appears between Finalizar click and Plexo redirect
const DAC_CART_TIMEOUT_MS = 20_000;
const DAC_CART_FAST_CHECK_MS = 3_000; // quick check if Finalizar already went to Plexo

/**
 * Dump the current page state (HTML + screenshot + inline DOM summary) to /tmp
 * and emit a structured `[pay-debug]` warning line. Used whenever a payment
 * step can't find its expected selectors so we can iterate on real DOM data
 * instead of guessing. NEVER throws.
 */
async function dumpDiagnostic(page: Page, slog: StepLogger, tag: string): Promise<void> {
  try {
    const ts = Date.now();
    const htmlPath = `/tmp/labelflow-pay-${tag}-${ts}.html`;
    const pngPath = `/tmp/labelflow-pay-${tag}-${ts}.png`;

    try {
      const html = await page.content();
      await writeFile(htmlPath, html, 'utf8');
    } catch (err) {
      slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay-debug] html dump failed: ${(err as Error).message}`);
    }

    await page.screenshot({ path: pngPath, fullPage: true }).catch((err: Error) =>
      slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay-debug] screenshot failed: ${err.message}`),
    );

    const summary = await page
      .evaluate(() => {
        const url = location.href;
        const clickables = Array.from(
          document.querySelectorAll(
            'button, a[role=button], [role=button], input[type=submit], input[type=button]',
          ),
        )
          .map(b => ((b as HTMLElement).textContent ?? (b as HTMLInputElement).value ?? '').trim().slice(0, 50))
          .filter(Boolean)
          .slice(0, 15);
        const checkboxes = document.querySelectorAll('input[type=checkbox]').length;
        const textInputs = document.querySelectorAll(
          'input[type=text], input[type=tel], input[type=email], input[type=number], input[type=password]',
        ).length;
        const labels = Array.from(document.querySelectorAll('label'))
          .map(l => (l.textContent ?? '').trim().slice(0, 60))
          .filter(Boolean)
          .slice(0, 10);
        return { url, clickables, checkboxes, textInputs, labels };
      })
      .catch(() => null);

    if (summary) {
      slog.warn(
        DAC_STEPS.SUBMIT_WAIT_NAV,
        `[pay-debug] ${tag} url=${summary.url} buttons=[${summary.clickables.join(' | ')}] labels=[${summary.labels.join(' | ')}] checkboxes=${summary.checkboxes} inputs=${summary.textInputs}`,
      );
    }
    slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay-debug] ${tag} artifacts: html=${htmlPath} png=${pngPath}`);
  } catch (err) {
    slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay-debug] diagnostic failed: ${(err as Error).message}`);
  }
}

/**
 * After clicking "Finalizar envío" on the DAC form, DAC can route us through
 * TWO paths before Plexo takes over:
 *
 *   Path A (direct): DAC redirects straight to secure.plexo.com.uy/{hash}.
 *     Seen on some account configurations. Nothing to click.
 *
 *   Path B (cart):   DAC navigates to its own cart page (still under dac.com.uy,
 *     typically /envios/nuevo with new DOM state). The user must:
 *       - tick a "Acepto términos y condiciones" checkbox
 *       - click the "PAGAR" button
 *     Only after that does DAC POST to /envios/initiate_payWithFiserv and
 *     redirect to Plexo.
 *
 * This function handles both paths. Returns null on success (page is now on
 * Plexo or the caller can proceed). Returns a PaymentOutcome on failure, with
 * artifacts already dumped to /tmp for offline inspection.
 */
async function handleDacCart(page: Page, slog: StepLogger): Promise<PaymentOutcome | null> {
  // Path A: quick probe — maybe Finalizar already went straight to Plexo
  const directPlexo = await page
    .waitForURL('**/secure.plexo.com.uy/**', { timeout: DAC_CART_FAST_CHECK_MS })
    .then(() => true)
    .catch(() => false);

  if (directPlexo) {
    slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, '[pay] Finalizar → Plexo direct (no cart step)');
    return null;
  }

  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, '[pay] no direct Plexo redirect — looking for DAC cart');

  // Path B: wait for PAGAR button to appear (signals cart is loaded)
  const pagarSelectors = [
    'button:has-text("PAGAR")',
    'button:has-text("Pagar")',
    'a:has-text("PAGAR")',
    'a:has-text("Pagar")',
    'input[type=submit][value="PAGAR" i]',
    'input[type=button][value="PAGAR" i]',
    'button.btn-pagar',
    '[class*="pagar" i]:is(button, a)',
  ];
  const pagarBtn = await page
    .waitForSelector(pagarSelectors.join(', '), { timeout: DAC_CART_TIMEOUT_MS })
    .catch(() => null);

  if (!pagarBtn) {
    await dumpDiagnostic(page, slog, 'cart-not-reached');
    return { status: 'pending_manual', reason: 'cart_not_reached' };
  }

  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, '[pay] PAGAR button found — accepting T&C checkbox');

  // Accept T&C (multiple fallback strategies)
  const termsClicked = await page.evaluate(() => {
    // Strategy 1: checkbox with name/id mentioning terms/conditions/acceptance
    const byAttr = document.querySelector<HTMLInputElement>(
      [
        'input[type=checkbox][name*="term" i]',
        'input[type=checkbox][id*="term" i]',
        'input[type=checkbox][name*="condic" i]',
        'input[type=checkbox][id*="condic" i]',
        'input[type=checkbox][name*="acept" i]',
        'input[type=checkbox][id*="acept" i]',
      ].join(', '),
    );
    if (byAttr) {
      if (!byAttr.checked) byAttr.click();
      return 'by-attr';
    }

    // Strategy 2: <label> text mentions acepto/términos/condiciones — click label, and inner checkbox
    const labels = Array.from(document.querySelectorAll('label'));
    const labelMatch = labels.find(l => {
      const t = (l.textContent ?? '').toLowerCase();
      return (
        t.includes('acepto') ||
        t.includes('términos') ||
        t.includes('terminos') ||
        t.includes('condiciones')
      );
    });
    if (labelMatch) {
      labelMatch.click();
      const innerCb = labelMatch.querySelector<HTMLInputElement>('input[type=checkbox]');
      const hrefCb = labelMatch.htmlFor
        ? (document.getElementById(labelMatch.htmlFor) as HTMLInputElement | null)
        : null;
      const cb = innerCb ?? hrefCb;
      if (cb && !cb.checked) cb.click();
      return 'by-label';
    }

    // Strategy 3: if only one visible checkbox on the page, that's it
    const allCbs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
    const visibleCbs = allCbs.filter(cb => cb.offsetParent !== null);
    if (visibleCbs.length === 1) {
      if (!visibleCbs[0].checked) visibleCbs[0].click();
      return 'single-visible';
    }

    return 'none';
  });

  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] T&C checkbox: ${termsClicked}`);
  if (termsClicked === 'none') {
    await dumpDiagnostic(page, slog, 'terms-not-found');
    return { status: 'pending_manual', reason: 'terms_not_found' };
  }

  // Small settle so PAGAR can become enabled if it's gated on T&C
  await page.waitForTimeout(600);

  // Re-evaluate PAGAR button state — some sites swap it after T&C is ticked
  const isEnabled = await pagarBtn.isEnabled().catch(() => true);
  if (!isEnabled) {
    slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, '[pay] PAGAR still disabled after T&C — extra 2s wait');
    await page.waitForTimeout(2000);
  }

  // Click PAGAR and race against Plexo redirect
  try {
    await Promise.all([
      page.waitForURL('**/secure.plexo.com.uy/**', { timeout: PLEXO_STEP_TIMEOUT_MS }),
      (async () => {
        // Primary click via ElementHandle
        try {
          await pagarBtn.click({ timeout: 5_000 });
        } catch (err) {
          slog.warn(
            DAC_STEPS.SUBMIT_WAIT_NAV,
            `[pay] PAGAR native click failed (${(err as Error).message}) — retry via evaluate`,
          );
          // Fallback: click via evaluate (bypasses overlays, waits for visibility differently)
          await page.evaluate(() => {
            const candidates = Array.from(
              document.querySelectorAll<HTMLElement>(
                'button, a, input[type=submit], input[type=button]',
              ),
            );
            const btn = candidates.find(b => {
              const text = (
                b.textContent ?? (b as HTMLInputElement).value ?? ''
              )
                .trim()
                .toLowerCase();
              return text === 'pagar';
            });
            btn?.click();
          });
        }
      })(),
    ]);
  } catch {
    // Last resort: maybe the redirect already happened but we missed the wait
    if (page.url().includes('plexo.com.uy')) {
      slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, '[pay] Plexo URL reached despite waitForURL reject');
      return null;
    }
    await dumpDiagnostic(page, slog, 'pagar-not-clickable');
    return { status: 'pending_manual', reason: 'pagar_not_clickable' };
  }

  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] cart flow complete — on Plexo: ${page.url()}`);
  return null;
}

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
  slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, '[pay] payment flow start');

  // --- Step 0: navigate the DAC cart (T&C + PAGAR) when present, then reach Plexo ---
  const cartResult = await handleDacCart(page, slog);
  if (cartResult) return cartResult; // failure — artifacts already dumped + logged

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
      await dumpDiagnostic(page, slog, 'brand-tile-not-found');
      return { status: 'pending_manual', reason: 'selector_failure' };
    }
    await page.waitForTimeout(800); // let the section expand
  } catch (err) {
    slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] brand tile click failed: ${(err as Error).message}`);
    await dumpDiagnostic(page, slog, 'brand-tile-error');
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
    await dumpDiagnostic(page, slog, 'saved-card-not-found');
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
      await dumpDiagnostic(page, slog, 'continuar-to-cvv-failed');
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
      await dumpDiagnostic(page, slog, 'cvv-input-not-found');
      return { status: 'pending_manual', reason: 'selector_failure' };
    }
    slog.info(DAC_STEPS.SUBMIT_WAIT_NAV, '[pay] CVV filled');
  } catch (err) {
    slog.warn(DAC_STEPS.SUBMIT_WAIT_NAV, `[pay] CVV fill failed: ${(err as Error).message}`);
    await dumpDiagnostic(page, slog, 'cvv-fill-error');
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
      await dumpDiagnostic(page, slog, 'final-timeout');
      return { status: 'pending_manual', reason: 'timeout' };
  }
}
