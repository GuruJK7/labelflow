import { Page } from 'playwright';
import { Solver } from '2captcha-ts';
import { DAC_SELECTORS, DAC_URLS } from './selectors';
import { dacBrowser } from './browser';
import logger from '../logger';

const RECAPTCHA_SITEKEY = '6LeKGrIaAAAAAANa6NZk_i6xkQD-c-_U3Bt-OffC';
const FAST_TIMEOUT = 5_000; // 5s instead of 30s for fail-fast

/**
 * Solve reCAPTCHA v2 INVISIBLE via 2Captcha service.
 *
 * DAC's login page uses reCAPTCHA v2 INVISIBLE (data-size="invisible"), not
 * the classic checkbox variant — 2Captcha needs the `invisible: true` flag
 * or it won't solve it (surfaces as ERROR_API).
 *
 * OUTER RETRY LOOP (this function):
 *   2Captcha occasionally returns ERROR_CAPTCHA_UNSOLVABLE when its worker
 *   pool has a bad streak on a specific sitekey (e.g. Google temporarily
 *   flags some 2Captcha IPs). Each 2Captcha internal attempt already tries
 *   up to 3 workers. By retrying 3x from our side with a backoff, we get
 *   up to 9 independent worker pools, which pushes success rate close to
 *   100% for normal outages. No charge when UNSOLVABLE — 2Captcha refunds.
 *
 * DETAILED ERROR LOGGING:
 *   Every failed attempt logs errName/errMessage/errCode/errData so future
 *   outages can be diagnosed from Render logs alone without grepping the
 *   library source.
 */
const CAPTCHA_OUTER_RETRIES = 3;
const CAPTCHA_RETRY_BACKOFF_MS = 10_000;

async function solveRecaptcha(pageUrl: string): Promise<string> {
  const apiKey = process.env.CAPTCHA_API_KEY;
  if (!apiKey) {
    throw new Error('CAPTCHA_API_KEY env var is required for DAC login');
  }

  const solver = new Solver(apiKey);
  let lastErr: Error | null = null;

  for (let attempt = 1; attempt <= CAPTCHA_OUTER_RETRIES; attempt++) {
    logger.info({ attempt, maxAttempts: CAPTCHA_OUTER_RETRIES }, 'Solving reCAPTCHA via 2Captcha...');
    try {
      const result = await solver.recaptcha({
        pageurl: pageUrl,
        googlekey: RECAPTCHA_SITEKEY,
        invisible: true,
      });

      logger.info({ attempt, taskId: result.id }, 'reCAPTCHA solved');
      return result.data;
    } catch (err) {
      const e = err as Error & { code?: string; data?: unknown };
      lastErr = e;
      logger.warn(
        {
          attempt,
          maxAttempts: CAPTCHA_OUTER_RETRIES,
          errName: e.name,
          errMessage: e.message,
          errCode: e.code ?? null,
          errData: e.data ?? null,
          pageUrl,
          sitekey: RECAPTCHA_SITEKEY,
        },
        `2Captcha solve attempt ${attempt}/${CAPTCHA_OUTER_RETRIES} failed`,
      );

      if (attempt < CAPTCHA_OUTER_RETRIES) {
        await new Promise((r) => setTimeout(r, CAPTCHA_RETRY_BACKOFF_MS));
      }
    }
  }

  // All outer retries exhausted — log at error level and throw.
  const e = lastErr ?? new Error('unknown 2Captcha failure');
  logger.error(
    {
      totalAttempts: CAPTCHA_OUTER_RETRIES,
      errName: e.name,
      errMessage: e.message,
      errCode: (e as any).code ?? null,
      errData: (e as any).data ?? null,
      pageUrl,
      sitekey: RECAPTCHA_SITEKEY,
    },
    '2Captcha solve exhausted all outer retries — see errMessage/errCode for root cause',
  );
  throw e;
}

/**
 * Try to login using saved cookies (no CAPTCHA needed).
 * Returns true if session is still valid.
 */
export async function tryLoginWithCookies(
  page: Page,
  tenantId: string
): Promise<boolean> {
  const loaded = await dacBrowser.loadCookies(tenantId);
  if (!loaded) return false;

  logger.info('Trying login with saved cookies...');

  // Navigate to a protected page to test session
  await page.goto(DAC_URLS.NEW_SHIPMENT, { waitUntil: 'domcontentloaded', timeout: 15_000 });

  // Check if we got redirected to login
  const url = page.url();
  if (url.includes('/usuarios/login') || url.includes('/login')) {
    logger.info('Saved cookies expired, need fresh login');
    return false;
  }

  // Check for a form element that only shows when logged in
  try {
    await page.waitForSelector(DAC_SELECTORS.PICKUP_TYPE, { timeout: FAST_TIMEOUT });
    logger.info('Cookie login successful — skipped CAPTCHA!');
    return true;
  } catch {
    logger.info('Cookie login failed, form not found');
    return false;
  }
}

/**
 * Full login with CAPTCHA solving.
 */
export async function loginDac(page: Page, username: string, password: string): Promise<void> {
  logger.info('Logging into DAC (full login with CAPTCHA)...');

  await page.goto(DAC_URLS.LOGIN, { waitUntil: 'domcontentloaded', timeout: 15_000 });

  // Wait for login form
  await page.waitForSelector(DAC_SELECTORS.LOGIN_USER_INPUT, { timeout: 10_000 });

  // Fill credentials
  await page.fill(DAC_SELECTORS.LOGIN_USER_INPUT, username);
  await page.fill(DAC_SELECTORS.LOGIN_PASSWORD_INPUT, password);

  // Solve reCAPTCHA
  let captchaToken: string;
  try {
    captchaToken = await solveRecaptcha(DAC_URLS.LOGIN);
  } catch (err) {
    const screenshotPath = await dacBrowser.screenshot(page, 'captcha-failed');
    throw new Error(`reCAPTCHA solving failed: ${(err as Error).message}. Screenshot: ${screenshotPath}`);
  }

  // Inject token and submit
  await page.evaluate((token: string) => {
    const responseField = document.querySelector('#g-recaptcha-response') as HTMLTextAreaElement;
    if (responseField) responseField.value = token;

    const allResponses = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
    allResponses.forEach((el) => { (el as HTMLTextAreaElement).value = token; });

    if (typeof (window as any).LoginSend === 'function') {
      (window as any).LoginSend();
    }
  }, captchaToken);

  // Wait for redirect (use shorter timeout)
  try {
    await page.waitForURL('**/envios/**', { timeout: 15_000 });
    logger.info('DAC login successful');
  } catch {
    const errorText = await page.evaluate(() => {
      const alerts = document.querySelectorAll('.alert, .error, .formError, .validationError');
      return Array.from(alerts).map(el => el.textContent?.trim()).filter(Boolean).join('; ');
    });

    const screenshotPath = await dacBrowser.screenshot(page, 'login-failed');
    throw new Error(
      errorText
        ? `DAC login failed: ${errorText}. Screenshot: ${screenshotPath}`
        : `DAC login failed. Check credentials. Screenshot: ${screenshotPath}`
    );
  }
}

/**
 * Smart login: try cookies first, fall back to full login.
 * Saves cookies after successful login for next time.
 */
export async function smartLogin(
  page: Page,
  username: string,
  password: string,
  tenantId: string
): Promise<void> {
  // Try cookie-based login first (no CAPTCHA, ~2s)
  const cookieSuccess = await tryLoginWithCookies(page, tenantId);
  if (cookieSuccess) return;

  // Full login with CAPTCHA (~60-80s)
  await loginDac(page, username, password);

  // Save cookies for next time
  await dacBrowser.saveCookies(tenantId);
}

/**
 * Checks if current page has active DAC session.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (url.includes('/usuarios/login')) return false;
    const indicator = await page.$(DAC_SELECTORS.LOGIN_SUCCESS_INDICATOR);
    return indicator !== null;
  } catch {
    return false;
  }
}

/**
 * Ensures logged in, using smart login (cookies first).
 */
export async function ensureLoggedIn(
  page: Page,
  username: string,
  password: string,
  tenantId?: string
): Promise<void> {
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    logger.info('DAC session expired, re-authenticating...');
    if (tenantId) {
      await smartLogin(page, username, password, tenantId);
    } else {
      await loginDac(page, username, password);
    }
  }
}
