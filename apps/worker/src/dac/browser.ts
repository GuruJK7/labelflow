import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { getConfig } from '../config';
import logger from '../logger';
import fs from 'fs';
import path from 'path';

class DacBrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  async getPage(): Promise<Page> {
    if (!this.browser || !this.browser.isConnected()) {
      const config = getConfig();
      logger.info({ headless: config.PLAYWRIGHT_HEADLESS }, 'Starting Playwright browser');

      this.browser = await chromium.launch({
        headless: config.PLAYWRIGHT_HEADLESS,
        slowMo: config.PLAYWRIGHT_HEADLESS ? 0 : 100,
      });

      this.context = await this.browser.newContext({
        acceptDownloads: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
      });
    }

    if (!this.context) throw new Error('Browser context not initialized');
    return this.context.newPage();
  }

  async close(): Promise<void> {
    if (this.context) { await this.context.close().catch(() => {}); this.context = null; }
    if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; }
  }

  async screenshot(page: Page, name: string, dir = '/tmp/labelflow/screenshots'): Promise<string> {
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}-${Date.now()}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    return filePath;
  }
}

export const dacBrowser = new DacBrowserManager();
