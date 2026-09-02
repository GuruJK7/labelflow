/**
 * READ-ONLY DAC agency-form structure probe.
 *
 * Purpose: ground-truth diagnosis only. Discover what fields DAC's new-shipment
 * form shows when TipoEntrega=Agencia (pickup at branch) is selected — because
 * the worker code only ever inspected the Domicilio (home-delivery) flow, and
 * agency pickups (#5404 "DAC Tres Cruces", #5399 "DAC Ciudad del Plata") get
 * silently rejected at Finalizar even though every home-delivery field is filled.
 *
 * HYPOTHESIS being tested: agency delivery requires selecting a destination
 * AGENCY (a dropdown / picker the code never touches). This probe dumps the
 * live DOM at each step so we can SEE the real required field instead of guessing.
 *
 * SAFETY (hard guarantees):
 *   - Cookie fast-path ONLY (tryLoginWithCookies). No captcha, never re-saves cookies.
 *   - Navigates the wizard with "Siguiente" (pure step navigation) and reads the
 *     DOM. It NEVER clicks "Agregar" (cart add) or "Finalizar envio" (submit),
 *     never fills recipient data, never creates a guía. Selecting a dropdown and
 *     reading options creates nothing in DAC.
 *   - Prints only field names/ids/option labels and dropdown contents — never
 *     cookies, keys, passwords, or any customer PII.
 *
 * Run (secrets via web app's prod env through dotenv preload; never echoed):
 *   cd apps/worker
 *   DOTENV_CONFIG_PATH=../web/.env.production.local REDIS_URL=redis://localhost:6379 \
 *     PLAYWRIGHT_HEADLESS=true TS_NODE_TRANSPILE_ONLY=1 \
 *     ../../node_modules/.bin/ts-node -r dotenv/config src/probe-dac-form.ts
 */
import type { Page } from 'playwright';
import { dacBrowser } from './dac/browser';
import { tryLoginWithCookies } from './dac/auth';
import { DAC_URLS, DAC_SELECTORS } from './dac/selectors';
import { db } from './db';

const TENANT = process.env.PROBE_TENANT || 'cmpvjrj8j000112ak1fp6fm09';

type FieldDump = {
  selects: Array<{
    name: string | null;
    id: string | null;
    visible: boolean;
    optionCount: number;
    options: Array<{ v: string; t: string }>;
  }>;
  inputs: Array<{
    tag: string;
    name: string | null;
    id: string | null;
    type: string | null;
    placeholder: string | null;
    visible: boolean;
  }>;
  agencyHints: Array<{ tag: string; text: string }>;
};

async function dumpFields(page: Page): Promise<FieldDump> {
  return page.evaluate(() => {
    const isVisible = (el: Element): boolean => {
      const he = el as HTMLElement;
      const s = window.getComputedStyle(he);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      return he.offsetParent !== null || s.position === 'fixed';
    };
    const selects = Array.from(document.querySelectorAll('select')).map((sel) => {
      const s = sel as HTMLSelectElement;
      return {
        name: s.name || null,
        id: s.id || null,
        visible: isVisible(s),
        optionCount: s.options.length,
        options: Array.from(s.options)
          .slice(0, 30)
          .map((o) => ({ v: o.value, t: (o.textContent || '').replace(/\s+/g, ' ').trim() })),
      };
    });
    const inputs = Array.from(document.querySelectorAll('input, textarea')).map((inp) => {
      const e = inp as HTMLInputElement;
      return {
        tag: e.tagName.toLowerCase(),
        name: e.name || null,
        id: e.id || null,
        type: e.type || null,
        placeholder: e.placeholder || null,
        visible: isVisible(e),
      };
    });
    const agencyHints = Array.from(
      document.querySelectorAll('label, span, h1, h2, h3, h4, h5, button, a, p, strong'),
    )
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      }))
      .filter((x) => /agenc|sucursal|retiro|recoge|recoger|punto de|destino/i.test(x.text) && x.text.length <= 80)
      .slice(0, 30);
    return { selects, inputs, agencyHints };
  });
}

function printDump(label: string, d: FieldDump) {
  console.log(`\n========== ${label} ==========`);
  console.log(`--- SELECTS (${d.selects.length}) ---`);
  for (const s of d.selects) {
    const vis = s.visible ? 'VIS' : 'hid';
    const opts = s.options
      .filter((o) => o.v !== '' && o.v !== '0')
      .slice(0, 18)
      .map((o) => `${o.v}:${o.t}`)
      .join(' | ');
    console.log(`  [${vis}] name=${s.name ?? '∅'} id=${s.id ?? '∅'} (${s.optionCount} opts) ${opts ? '=> ' + opts : ''}`);
  }
  console.log(`--- INPUTS/TEXTAREAS (${d.inputs.length}) ---`);
  for (const i of d.inputs) {
    if (i.type === 'hidden' && !i.name) continue;
    const vis = i.visible ? 'VIS' : 'hid';
    console.log(`  [${vis}] <${i.tag}> name=${i.name ?? '∅'} id=${i.id ?? '∅'} type=${i.type ?? '∅'}${i.placeholder ? ' ph="' + i.placeholder + '"' : ''}`);
  }
  console.log(`--- AGENCY/PICKUP TEXT HINTS (${d.agencyHints.length}) ---`);
  for (const h of d.agencyHints) {
    console.log(`  <${h.tag}> ${h.text}`);
  }
}

async function clickSiguienteSafe(page: Page, n: number): Promise<boolean> {
  // Click the first VISIBLE "Siguiente" navigation control. Never matches
  // Agregar/Finalizar. Returns true if a click happened.
  const handle = await page.evaluateHandle(() => {
    const els = Array.from(document.querySelectorAll('a, button')) as HTMLElement[];
    const vis = (el: HTMLElement) => {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
    };
    const target = els.find(
      (el) => /\bsiguiente\b/i.test(el.textContent || '') && vis(el) && !/agregar|finaliz/i.test(el.textContent || ''),
    );
    return target ?? null;
  });
  const el = handle.asElement();
  if (!el) {
    console.log(`  (siguiente #${n}: no visible Siguiente found)`);
    return false;
  }
  await el.click().catch(() => {});
  console.log(`  (siguiente #${n}: clicked)`);
  return true;
}

async function main() {
  const page = await dacBrowser.getPage();

  const ok = await tryLoginWithCookies(page, TENANT);
  if (!ok) {
    console.log('COOKIE_LOGIN_FAILED — cookies stale; aborting (read-only probe does NOT fall back to captcha).');
    await dacBrowser.close();
    await db.$disconnect();
    return;
  }
  console.log('COOKIE_LOGIN_OK — navigating to new-shipment form (read-only, agency-mode inspection)…');

  await page.goto(DAC_URLS.NEW_SHIPMENT, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector(DAC_SELECTORS.PICKUP_TYPE, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // CP1 — initial form, no interaction (reveals hidden agency fields if static)
  printDump('CP1 — INITIAL FORM (no interaction)', await dumpFields(page));

  // Select Step-1 values for an AGENCY pickup (no submit — these are just selects)
  await page.selectOption(DAC_SELECTORS.PICKUP_TYPE, DAC_SELECTORS.PICKUP_VALUE_MOSTRADOR).catch(() => {});
  await page.waitForTimeout(200);
  await page.selectOption(DAC_SELECTORS.PACKAGE_TYPE, DAC_SELECTORS.PACKAGE_VALUE_PAQUETE).catch(() => {});
  await page.waitForTimeout(200);
  await page.selectOption(DAC_SELECTORS.DELIVERY_TYPE, DAC_SELECTORS.DELIVERY_VALUE_AGENCIA).catch(() => {});
  await page.waitForTimeout(800);
  console.log('\n>> Selected TipoServicio=0, TipoEnvio=1, TipoEntrega=1 (AGENCIA)');

  // CP2 — after choosing Agencia, still on step 1 (some forms inject fields on change)
  printDump('CP2 — AFTER TipoEntrega=AGENCIA (still step 1)', await dumpFields(page));

  // Navigate step 1 -> 2 -> 3 with Siguiente (pure navigation, no submit)
  console.log('\n>> Advancing wizard with Siguiente (navigation only)…');
  await clickSiguienteSafe(page, 1);
  await page.waitForTimeout(1200);
  await clickSiguienteSafe(page, 2);
  await page.waitForTimeout(1500);

  // CP3 — recipient/destination step in AGENCY mode (the key view)
  printDump('CP3 — STEP 3 RECIPIENT IN AGENCY MODE', await dumpFields(page));

  // The "Oficina" (Agencia *) dropdown is AJAX-populated per department. Loop
  // over the departments behind our stuck agency orders and dump just the
  // agency list for each, so we can confirm the exact agency option exists.
  const deptsToCheck = (process.env.PROBE_DEPTS || 'Montevideo,San José,Rivera,Canelones')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const hasDept = await page.$(DAC_SELECTORS.RECIPIENT_DEPARTMENT);
  if (hasDept) {
    for (const deptName of deptsToCheck) {
      const val = await page.$$eval(
        `${DAC_SELECTORS.RECIPIENT_DEPARTMENT} option`,
        (opts: any[], dn: string) => {
          const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
          const m = opts.find((o) => norm(o.textContent || '') === norm(dn));
          return m ? (m as HTMLOptionElement).value : null;
        },
        deptName,
      ).catch(() => null);
      if (!val) {
        console.log(`\n>> [${deptName}] no matching K_Estado option`);
        continue;
      }
      await page.selectOption(DAC_SELECTORS.RECIPIENT_DEPARTMENT, val).catch(() => {});
      await page.waitForTimeout(1800);
      const officinas = await page.$$eval('select[name="Oficina"] option', (opts: any[]) =>
        opts.filter((o) => o.value && o.value !== '' && o.value !== '0').map((o) => `${o.value}:${(o.textContent || '').replace(/\s+/g, ' ').trim()}`),
      ).catch(() => []);
      console.log(`\n>> AGENCIES (Oficina) FOR DEPARTMENT "${deptName}" (${officinas.length}):`);
      for (const o of officinas) console.log(`     ${o}`);
    }
  } else {
    console.log('\n>> No K_Estado dropdown present in agency mode (agency picker likely replaces address fields).');
  }

  console.log('\nPROBE_DONE — no submit performed, no guía created.');
  await dacBrowser.close();
  await db.$disconnect();
}

main().catch(async (e) => {
  console.error('PROBE_ERR', (e as Error)?.message);
  try { await dacBrowser.close(); } catch {}
  try { await db.$disconnect(); } catch {}
  process.exit(1);
});
