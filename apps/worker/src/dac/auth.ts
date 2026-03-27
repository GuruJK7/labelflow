import { Page } from 'playwright';
import { DAC_SELECTORS, DAC_URLS } from './selectors';
import { dacBrowser } from './browser';
import logger from '../logger';

/**
 * Login to dac.com.uy using document/RUT + password.
 * DAC uses JS onclick button (NOT form submit).
 */
export async function loginDac(page: Page, username: string, password: string): Promise<void> {
  logger.info('Logging into DAC...');

  await page.goto(DAC_URLS.LOGIN, { waitUntil: 'networkidle' });

  // Wait for login form
  await page.waitForSelector(DAC_SELECTORS.LOGIN_USER_INPUT, { timeout: 10_000 });

  // Fill document/RUT
  await page.fill(DAC_SELECTORS.LOGIN_USER_INPUT, username);

  // Fill password
  await page.fill(DAC_SELECTORS.LOGIN_PASSWORD_INPUT, password);

  // Click login button (type="button", JS onclick)
  await page.click(DAC_SELECTORS.LOGIN_SUBMIT_BUTTON);

  // Wait for navigation to /envios/nuevo
  try {
    await page.waitForURL('**/envios/**', { timeout: 15_000 });
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
    const url = page.url();
    if (url.includes('/usuarios/login')) return false;
    const bienvenido = await page.$('text=Bienvenido');
    return bienvenido !== null;
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
