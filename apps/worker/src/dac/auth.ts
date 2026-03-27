import { Page } from 'playwright';
import { Solver } from '2captcha-ts';
import { DAC_SELECTORS, DAC_URLS } from './selectors';
import { dacBrowser } from './browser';
import logger from '../logger';

const RECAPTCHA_SITEKEY = '6LeKGrIaAAAAAANa6NZk_i6xkQD-c-_U3Bt-OffC';

/**
 * Solve reCAPTCHA v2 on DAC login page using 2Captcha service.
 * Returns the g-recaptcha-response token.
 */
async function solveRecaptcha(pageUrl: string): Promise<string> {
  const apiKey = process.env.CAPTCHA_API_KEY;
  if (!apiKey) {
    throw new Error('CAPTCHA_API_KEY env var is required for DAC login (2captcha.com API key)');
  }

  logger.info('Solving reCAPTCHA via 2Captcha...');
  const solver = new Solver(apiKey);

  const result = await solver.recaptcha({
    pageurl: pageUrl,
    googlekey: RECAPTCHA_SITEKEY,
  });

  logger.info({ taskId: result.id }, 'reCAPTCHA solved successfully');
  return result.data;
}

/**
 * Login to dac.com.uy using document/RUT + password.
 * Handles reCAPTCHA v2 via 2Captcha solving service.
 *
 * Flow:
 * 1. Navigate to login page
 * 2. Fill credentials
 * 3. Solve reCAPTCHA via 2Captcha API
 * 4. Inject token into g-recaptcha-response
 * 5. Call LoginSend() JS function to submit
 * 6. Wait for redirect to /envios/nuevo
 */
export async function loginDac(page: Page, username: string, password: string): Promise<void> {
  logger.info('Logging into DAC...');

  await page.goto(DAC_URLS.LOGIN, { waitUntil: 'networkidle' });

  // Wait for login form
  await page.waitForSelector(DAC_SELECTORS.LOGIN_USER_INPUT, { timeout: 15_000 });

  // Fill document/RUT
  await page.fill(DAC_SELECTORS.LOGIN_USER_INPUT, username);

  // Fill password
  await page.fill(DAC_SELECTORS.LOGIN_PASSWORD_INPUT, password);

  // Solve reCAPTCHA
  let captchaToken: string;
  try {
    captchaToken = await solveRecaptcha(DAC_URLS.LOGIN);
  } catch (err) {
    const screenshotPath = await dacBrowser.screenshot(page, 'captcha-failed');
    throw new Error(`reCAPTCHA solving failed: ${(err as Error).message}. Screenshot: ${screenshotPath}`);
  }

  // Inject reCAPTCHA token and submit via DAC's LoginSend() function
  await page.evaluate((token: string) => {
    // Set the reCAPTCHA response textarea (standard field used by grecaptcha)
    const responseField = document.querySelector('#g-recaptcha-response') as HTMLTextAreaElement;
    if (responseField) {
      responseField.value = token;
    }

    // Also set any textarea with name g-recaptcha-response (some sites use multiple)
    const allResponses = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
    allResponses.forEach((el) => {
      (el as HTMLTextAreaElement).value = token;
    });

    // Call DAC's LoginSend() function directly (defined in /usuarios.js)
    if (typeof (window as any).LoginSend === 'function') {
      (window as any).LoginSend();
    }
  }, captchaToken);

  // Wait for navigation to /envios/nuevo or any post-login page
  try {
    await page.waitForURL('**/envios/**', { timeout: 20_000 });
    logger.info('DAC login successful');
  } catch {
    // Check if there's an error message on the page
    const errorText = await page.evaluate(() => {
      const alerts = document.querySelectorAll('.alert, .error, .formError, .validationError');
      return Array.from(alerts).map(el => el.textContent?.trim()).filter(Boolean).join('; ');
    });

    const screenshotPath = await dacBrowser.screenshot(page, 'login-failed');

    if (errorText) {
      throw new Error(`DAC login failed: ${errorText}. Screenshot: ${screenshotPath}`);
    }

    throw new Error(`DAC login failed. Check credentials. Screenshot: ${screenshotPath}`);
  }
}

/**
 * Checks if the current page has an active DAC session.
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
 * Ensures we're logged in, re-authenticating if needed.
 */
export async function ensureLoggedIn(page: Page, username: string, password: string): Promise<void> {
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    logger.info('DAC session expired, re-authenticating...');
    await loginDac(page, username, password);
  }
}
