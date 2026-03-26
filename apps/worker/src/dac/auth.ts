import { Page } from 'playwright';
import { DAC, DAC_URLS } from './selectors';
import { dacBrowser } from './browser';
import logger from '../logger';

/**
 * Login to dac.com.uy using document/RUT + password.
 * DAC uses JS onclick buttons (NOT form submit).
 */
export async function loginDac(page: Page, username: string, password: string): Promise<void> {
  logger.info('Logging into DAC...');

  await page.goto(DAC_URLS.LOGIN, { waitUntil: 'networkidle' });

  // Wait for login form
  await page.waitForSelector(DAC.login.form, { timeout: 10_000 });

  // Fill document/RUT
  await page.fill(DAC.login.userInput, username);

  // Fill password
  await page.fill(DAC.login.passwordInput, password);

  // Click login button (type="button", JS onclick)
  await page.click(DAC.login.submitButton);

  // Wait for navigation — the click triggers JS POST to /usuarios/doLogin
  try {
    await page.waitForURL('**/envios/**', { timeout: 10_000 }).catch(() => {});
    await page.waitForSelector(DAC.login.successIndicator, { timeout: 10_000 });
    logger.info('DAC login successful');
  } catch {
    const screenshotPath = await dacBrowser.screenshot(page, 'login-failed');
    throw new Error(`DAC login failed. Check credentials. Screenshot: ${screenshotPath}`);
  }
}

/**
 * Checks if the current page has an active DAC session.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  try {
    const indicator = await page.$(DAC.login.successIndicator);
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
