import { Browser, BrowserContext, Page, chromium, Cookie } from 'playwright';
import { getConfig } from '../config';
import { db } from '../db';
import logger from '../logger';
import fs from 'fs';
import path from 'path';

const COOKIE_STORAGE_KEY = 'dac_cookies';

// Memory management: restart browser every N orders to prevent memory leaks
// Render Starter tier has 512MB RAM, Chromium uses ~200-400MB, each page adds ~100MB
const BROWSER_RESTART_INTERVAL = 5; // restart browser every 5 orders

class DacBrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private activePage: Page | null = null;
  private pageCount: number = 0;

  async getPage(): Promise<Page> {
    // Proactive memory management: restart browser every N orders
    if (this.pageCount >= BROWSER_RESTART_INTERVAL && this.browser) {
      logger.info({ pageCount: this.pageCount }, 'Proactive browser restart (memory management)');
      await this.close();
    }

    if (!this.browser || !this.browser.isConnected()) {
      const config = getConfig();
      logger.info({ headless: config.PLAYWRIGHT_HEADLESS }, 'Starting Playwright browser');

      this.browser = await chromium.launch({
        headless: config.PLAYWRIGHT_HEADLESS,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process', // reduces memory fragmentation
          '--disable-extensions',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-features=TranslateUI,BlinkGenPropertyTrees',
          '--disable-ipc-flooding-protection',
          '--js-flags=--max-old-space-size=256', // cap Chromium JS heap at 256MB
        ],
      });

      this.context = await this.browser.newContext({
        acceptDownloads: true,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        // Block heavy resources we don't need (images, fonts, media)
        serviceWorkers: 'block',
      });

      // Block images, fonts, stylesheets from loading (DAC form only needs HTML/JS)
      await this.context.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet') {
          route.abort();
        } else {
          route.continue();
        }
      });

      this.pageCount = 0;
    }

    if (!this.context) throw new Error('Browser context not initialized');

    // Close old page if exists — don't reuse to prevent DOM memory retention
    if (this.activePage && !this.activePage.isClosed()) {
      await this.activePage.close().catch(() => {});
      this.activePage = null;
    }

    this.activePage = await this.context.newPage();
    this.pageCount++;
    return this.activePage;
  }

  /**
   * Explicitly close the current page to free memory after an order completes.
   * Browser stays alive for next order (reused), but page DOM is freed.
   */
  async closePage(): Promise<void> {
    if (this.activePage && !this.activePage.isClosed()) {
      await this.activePage.close().catch(() => {});
      this.activePage = null;
    }
  }

  /**
   * Save current cookies to DB for a tenant (to reuse session later).
   */
  async saveCookies(tenantId: string): Promise<void> {
    if (!this.context) return;
    try {
      const cookies = await this.context.cookies();
      const dacCookies = cookies.filter(c => c.domain.includes('dac.com.uy'));
      if (dacCookies.length > 0) {
        await db.tenant.update({
          where: { id: tenantId },
          data: {
            // Store cookies in a JSON field (we use the storeName field temporarily
            // or we can add a proper field. For now, store as a RunLog entry)
          },
        });
        // Store in a RunLog with special level for retrieval
        await db.runLog.create({
          data: {
            tenantId,
            level: 'INFO',
            message: COOKIE_STORAGE_KEY,
            meta: JSON.parse(JSON.stringify(dacCookies)),
          },
        });
        logger.info({ count: dacCookies.length, tenantId }, 'DAC cookies saved');
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Failed to save cookies');
    }
  }

  /**
   * Load previously saved cookies for a tenant.
   * Returns true if cookies were loaded successfully.
   */
  async loadCookies(tenantId: string): Promise<boolean> {
    if (!this.context) return false;
    try {
      const cookieLog = await db.runLog.findFirst({
        where: { tenantId, message: COOKIE_STORAGE_KEY },
        orderBy: { createdAt: 'desc' },
      });

      if (!cookieLog?.meta) return false;

      // Check if cookies are less than 4 hours old
      const age = Date.now() - cookieLog.createdAt.getTime();
      if (age > 4 * 60 * 60 * 1000) {
        logger.info('Saved cookies are too old (>4h), will re-login');
        return false;
      }

      const cookies = cookieLog.meta as unknown as Cookie[];
      if (Array.isArray(cookies) && cookies.length > 0) {
        await this.context.addCookies(cookies);
        logger.info({ count: cookies.length, ageMinutes: Math.round(age / 60000) }, 'DAC cookies loaded from DB');
        return true;
      }
    } catch (err) {
      logger.warn({ error: (err as Error).message }, 'Failed to load cookies');
    }
    return false;
  }

  async close(): Promise<void> {
    if (this.activePage && !this.activePage.isClosed()) {
      await this.activePage.close().catch(() => {});
    }
    this.activePage = null;
    if (this.context) { await this.context.close().catch(() => {}); this.context = null; }
    if (this.browser) { await this.browser.close().catch(() => {}); this.browser = null; }
    this.pageCount = 0;
    // Force garbage collection if available (node --expose-gc)
    if (global.gc) {
      try { global.gc(); } catch {}
    }
  }

  /**
   * Take screenshot only on error or when explicitly requested.
   * In production, skip screenshots to save time.
   */
  async screenshot(page: Page, name: string, dir = '/tmp/labelflow/screenshots'): Promise<string> {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${name}-${Date.now()}.png`);
      await page.screenshot({ path: filePath, fullPage: false }); // Not fullPage = faster
      return filePath;
    } catch {
      return '';
    }
  }
}

export const dacBrowser = new DacBrowserManager();
