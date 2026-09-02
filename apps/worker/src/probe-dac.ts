/**
 * READ-ONLY DAC historial probe.
 *
 * Purpose: ground-truth diagnosis only. For the test tenant, dumps the most
 * recent historial rows (guía + visible row text) so we can see EXACTLY what
 * recipient-name / destination text DAC stores — and whether parked orders
 * (#5404 "Freddy Moreni", #5399 "Alejandro Pareja", #5380 "Santiago Fraga")
 * actually have an orphan guía that the in-line rescue's name matcher missed.
 *
 * SAFETY (hard guarantees):
 *   - Uses the cookie fast-path ONLY (tryLoginWithCookies). No captcha, and
 *     tryLoginWithCookies never re-saves cookies.
 *   - Navigates to the historial list page and reads the DOM. It NEVER fills
 *     or submits the new-shipment form, never clicks Finalizar, never creates
 *     a guía. Pure GET + DOM scrape.
 *   - Prints only the tenant's own shipment list text (names/destinations) and
 *     guía numbers — never cookies, keys, or passwords.
 *
 * Run (secrets come from the web app's prod env via dotenv preload; never echoed):
 *   cd apps/worker
 *   DOTENV_CONFIG_PATH=../web/.env.production.local REDIS_URL=redis://localhost:6379 \
 *     PLAYWRIGHT_HEADLESS=true ../../node_modules/.bin/ts-node -r dotenv/config src/probe-dac.ts
 */
import { dacBrowser } from './dac/browser';
import { tryLoginWithCookies } from './dac/auth';
import { DAC_URLS } from './dac/selectors';
import { db } from './db';

const TENANT = process.env.PROBE_TENANT || 'cmpvjrj8j000112ak1fp6fm09';
const NEEDLES = (process.env.PROBE_NEEDLES ||
  'freddy,moreni,alejandro,pareja,santiago,fraga')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

async function main() {
  const page = await dacBrowser.getPage();

  const ok = await tryLoginWithCookies(page, TENANT);
  if (!ok) {
    console.log('COOKIE_LOGIN_FAILED — cookies stale; aborting (read-only probe does NOT fall back to captcha).');
    await dacBrowser.close();
    await db.$disconnect();
    return;
  }
  console.log('COOKIE_LOGIN_OK — session valid, navigating to historial (read-only)…');

  await page.goto(DAC_URLS.HISTORY, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  try {
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('tr')).some((tr) =>
          /\b88\d{10,}\b/.test((tr as HTMLElement).innerText || ''),
        ),
      undefined,
      { timeout: 20_000 },
    );
  } catch {
    // non-fatal — scrape whatever rendered
  }
  await page.waitForTimeout(1_500);

  const rows = await page.evaluate(() => {
    const out: { guia: string; text: string }[] = [];
    const trs = Array.from(document.querySelectorAll('tr'));
    for (const tr of trs) {
      const text = ((tr as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim();
      const m = text.match(/\b88\d{10,}\b/);
      if (m) out.push({ guia: m[0], text });
    }
    return out;
  });

  console.log(`TOTAL_GUIA_ROWS ${rows.length}`);
  console.log('=== FIRST 50 ROWS (guia | row text) ===');
  rows.slice(0, 50).forEach((r, i) => {
    console.log(`${String(i).padStart(2, '0')} ${r.guia} | ${r.text.slice(0, 180)}`);
  });

  console.log('=== NEEDLE HITS (parked-order recipients) ===');
  let hits = 0;
  for (const r of rows) {
    const low = r.text.toLowerCase();
    if (NEEDLES.some((n) => low.includes(n))) {
      hits++;
      console.log(`HIT ${r.guia} | ${r.text.slice(0, 220)}`);
    }
  }
  if (hits === 0) console.log('(no historial row contains any of the parked-order recipient names)');

  await dacBrowser.close();
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error('PROBE_ERR', (e as Error)?.message);
  try { await dacBrowser.close(); } catch {}
  try { await db.$disconnect(); } catch {}
  process.exit(1);
});
