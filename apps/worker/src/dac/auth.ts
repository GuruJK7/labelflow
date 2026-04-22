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
 * DAC's login page uses reCAPTCHA v2 INVISIBLE (data-size="invisible"), not the
 * classic checkbox variant. Without the `invisible: true` flag, 2Captcha solves
 * the checkbox variant — Google rejects the token at submit time, and the
 * library surfaces the error as "ERROR_API / An Unexpected Error has occured".
 *
 * If 2Captcha returns an error, we log the full error payload (name + message
 * + any APIError code) so that future outages are debuggable without having to
 * grep the library source.
 */
async function solveRecaptcha(pageUrl: string): Promise<string> {
  const apiKey = process.env.CAPTCHA_API_KEY;
  if (!apiKey) {
    throw new Error('CAPTCHA_API_KEY env var is required for DAC login');
  }

  logger.info('Solving reCAPTCHA via 2Captcha...');
  const solver = new Solver(apiKey);

  try {
    const result = await solver.recaptcha({
      pageurl: pageUrl,
      googlekey: RECAPTCHA_SITEKEY,
      invisible: true,
    });

    logger.info({ taskId: result.id }, 'reCAPTCHA solved');
    return result.data;
  } catch (err) {
    // 2captcha-ts wraps errors in an APIError class; include everything we can
    // so the failure mode is unambiguous next time (balance vs. key vs. ip
    // block vs. invisible-mismatch vs. google-side rejection).
    const e = err as Error & { code?: string; data?: unknown };
    logger.error(
      {
        errName: e.name,
        errMessage: e.message,
        errCode: e.code ?? null,
        errData: e.data ?? null,
        pageUrl,
        sitekey: RECAPTCHA_SITEKEY,
      },
      '2Captcha solve failed — see errMessage/errCode for root cause',
    );
    throw err;
  }
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
