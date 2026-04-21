/**
 * test-dac-10-shipments.ts
 *
 * Runs 10 real test shipments against dac.com.uy using account 49665891.
 * Uses the production 2Captcha automated CAPTCHA-solving path — same as Render.
 *
 * Usage (from apps/worker/):
 *   npx ts-node --transpile-only src/test-dac-10-shipments.ts
 *
 * Env: loaded from $HOME/Documents/labelflow/apps/worker/.env
 * (contains DATABASE_URL, REDIS_URL, ENCRYPTION_KEY, CAPTCHA_API_KEY)
 */

// ── Env must be loaded BEFORE any imports that call getConfig() ──────────────
import os from 'os';
import path from 'path';
require('dotenv').config({ path: path.join(os.homedir(), 'Documents/labelflow/apps/worker/.env') });
// Fall back to Vercel-pulled values for anything not in the worker .env
require('dotenv').config({ path: '/tmp/labelflow-env-pull.env' });

// Point the invoke-claude spawn at this Mac's claude binary (the default in
// invoke-claude.ts is /Users/jk7/.local/bin/claude, which does not exist here).
if (!process.env.CLAUDE_BIN) {
  process.env.CLAUDE_BIN = '/Users/Work/.local/bin/claude';
}

// ── Imports ───────────────────────────────────────────────────────────────────
import { createShipment, AddressOverride } from './dac/shipment';
import { dacBrowser } from './dac/browser';
import { resolveAddressCorrection } from './agent/invoke-claude';
import { classifyOrder } from './rules/order-classifier';
import { createStepLogger } from './logger';
import type { ShopifyOrder } from './shopify/types';

const DAC_USERNAME = '49665891';
const DAC_PASSWORD = 'JK7Claude777';
const FAKE_TENANT_ID = 'test-run-local-001';

// ── Helper ────────────────────────────────────────────────────────────────────

function order(
  id: number,
  name: string,
  firstName: string,
  lastName: string,
  phone: string,
  address1: string,
  address2: string,
  city: string,
  province: string,
  zip: string,
  note: string | null = null,
): ShopifyOrder {
  return {
    id,
    name,
    email: '',
    total_price: '1500.00',
    currency: 'UYU',
    tags: '',
    note,
    note_attributes: null,
    shipping_address: {
      first_name: firstName,
      last_name: lastName,
      phone,
      address1,
      address2,
      city,
      province,
      zip,
      country: 'Uruguay',
    },
    line_items: [{ title: 'Producto test', quantity: 1, price: '1500.00', product_id: null }],
  };
}

// ── 10 test orders ─────────────────────────────────────────────────────────────
//
//  Classification is based on the address challenge presented to the pipeline,
//  not a formal GREEN/YELLOW/RED pass — these go directly to createShipment().
//
//  GREEN  = clean address, city maps unambiguously to correct department
//  YELLOW = correctable ambiguity (wrong dept, apt in addr1, barrio as city, etc.)
//  RED    = bad/missing data — pipeline may fallback or fail

interface TestOrder {
  label: string;
  classification: 'GREEN' | 'YELLOW' | 'RED';
  challenge: string;
  paymentType: 'REMITENTE' | 'DESTINATARIO';
  order: ShopifyOrder;
  override?: AddressOverride;
}

const TEST_ORDERS: TestOrder[] = [
  // ── GREEN (4 orders) ──────────────────────────────────────────────────────
  {
    label: 'T-01',
    classification: 'GREEN',
    challenge: 'Montevideo Pocitos — barrio in city, province correct, clean address',
    paymentType: 'DESTINATARIO',
    order: order(90001, '#T-01', 'Carlos', 'Rodríguez', '098765432',
      'Av. Luis Piera 1250', '', 'Pocitos', 'Montevideo', '11300'),
  },
  {
    label: 'T-02',
    classification: 'GREEN',
    challenge: 'Montevideo Centro — 18 de Julio address, province and city both correct',
    paymentType: 'DESTINATARIO',
    order: order(90002, '#T-02', 'Ana', 'González', '097654321',
      '18 de Julio 1492', '', 'Montevideo', 'Montevideo', '11100'),
  },
  {
    label: 'T-03',
    classification: 'GREEN',
    challenge: 'Canelones Las Piedras — interior city, province correct',
    paymentType: 'DESTINATARIO',
    order: order(90003, '#T-03', 'Martín', 'López', '099123456',
      'Artigas 568', '', 'Las Piedras', 'Canelones', '90100'),
  },
  {
    label: 'T-04',
    classification: 'GREEN',
    challenge: 'Maldonado city — coastal interior, province correct',
    paymentType: 'DESTINATARIO',
    order: order(90004, '#T-04', 'Sofía', 'Fernández', '042123456',
      'Venecia 820', '', 'Maldonado', 'Maldonado', '20000'),
  },

  // ── YELLOW (4 orders) ─────────────────────────────────────────────────────
  {
    label: 'T-05',
    classification: 'YELLOW',
    challenge: 'Solymar (Canelones) but province says Montevideo — geo pipeline must correct dept',
    paymentType: 'DESTINATARIO',
    order: order(90005, '#T-05', 'Diego', 'Pérez', '099887766',
      'Calle Los Pinos 456', '', 'Solymar', 'Montevideo', ''),
  },
  {
    label: 'T-06',
    classification: 'YELLOW',
    challenge: 'Apartment embedded in address1 — mergeAddress must strip "Apto 12" to extraObs',
    paymentType: 'DESTINATARIO',
    order: order(90006, '#T-06', 'Laura', 'Martínez', '098112233',
      'Bulevar España 2098 Apto 12', '', 'Montevideo', 'Montevideo', '11200'),
  },
  {
    label: 'T-07',
    classification: 'YELLOW',
    challenge: 'City is "Carrasco" (Montevideo barrio), province empty — barrio detection must resolve',
    paymentType: 'DESTINATARIO',
    order: order(90007, '#T-07', 'Fernando', 'Sosa', '099334455',
      'Dr. Alejandro Gallinal 1560', '', 'Carrasco', '', '11500'),
  },
  {
    label: 'T-08',
    classification: 'YELLOW',
    challenge: 'Salto city + province, address2 has "Piso 2" — should move to extraObs',
    paymentType: 'DESTINATARIO',
    order: order(90008, '#T-08', 'Valentina', 'Suárez', '073212345',
      'Uruguay 456', 'Piso 2', 'Salto', 'Salto', '50000'),
  },

  // ── RED (2 orders) ────────────────────────────────────────────────────────
  {
    label: 'T-09',
    classification: 'RED',
    challenge: 'Fake city "Xyzzylandia" — AI resolver invoked, expected fallback to Montevideo',
    paymentType: 'DESTINATARIO',
    order: order(90009, '#T-09', 'Roberto', 'García', '099000111',
      'Calle Falsa 742', '', 'Xyzzylandia', '', ''),
  },
  {
    label: 'T-10',
    classification: 'RED',
    challenge: 'City is raw "UY" (garbage input) — worst-case pipeline fallback test',
    paymentType: 'DESTINATARIO',
    order: order(90010, '#T-10', 'Patricia', 'Castro', '091234567',
      'Rivera 1234', '', 'UY', 'Uruguay', ''),
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

interface ShipmentResult {
  label: string;
  classification: 'GREEN' | 'YELLOW' | 'RED';
  challenge: string;
  status: 'SUCCESS' | 'FAILED' | 'NEEDS_REVIEW';
  guia?: string;
  trackingUrl?: string;
  errorMessage?: string;
  durationMs: number;
  claudeInvoked: boolean;
  claudeMs?: number;
  claudeOverride?: AddressOverride;
}

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════');
  console.log('  LabelFlow — DAC Direct Shipment Test (10 orders)');
  console.log('  Account:', DAC_USERNAME);
  console.log('  CAPTCHA: automated via 2Captcha (production path)');
  console.log('═══════════════════════════════════════════════════\n');

  // Use the production dacBrowser (same as worker on Render)
  const page = await dacBrowser.getPage();

  const results: ShipmentResult[] = [];
  const usedGuias = new Set<string>();

  try {
    for (let i = 0; i < TEST_ORDERS.length; i++) {
      const { label, classification, challenge, paymentType, order: o, override } = TEST_ORDERS[i];
      const addr = o.shipping_address!;

      console.log(`\n──────────────────────────────────────────────────`);
      console.log(`  ${label} [${classification}] (${i + 1}/10)`);
      console.log(`  ${challenge}`);
      console.log(`  ${addr.first_name} ${addr.last_name} | ${addr.phone}`);
      console.log(`  ${addr.address1}${addr.address2 ? ', ' + addr.address2 : ''}, ${addr.city} (${addr.province || 'no prov'})`);
      console.log(`──────────────────────────────────────────────────`);

      const t0 = Date.now();
      let claudeInvoked = false;
      let claudeMs: number | undefined;
      let effectiveOverride: AddressOverride | undefined = override;

      // YELLOW/RED → route through Claude Desktop for address correction first
      // (this is the whole point of the new YELLOW path — Claude reasons about
      //  the ambiguous fields and returns a corrected AddressOverride).
      if (classification === 'YELLOW' || classification === 'RED') {
        claudeInvoked = true;
        const cls = classifyOrder(o);
        const slog = createStepLogger(`test-job-${label}`, FAKE_TENANT_ID);
        const cT0 = Date.now();
        console.log(`  🧠 Invoking Claude Desktop for ${classification} order (zone=${cls.zone}, reasons=${cls.reasons.join(',') || '—'})`);
        try {
          const claudeOverride = await resolveAddressCorrection({
            entry: {
              order: o,
              classification: cls,
              labelId: `test-label-${label}`,
              paymentType,
            },
            jobId: `test-job-${label}`,
            slog,
          });
          claudeMs = Date.now() - cT0;
          if (claudeOverride) {
            effectiveOverride = claudeOverride;
            console.log(`  🧠 Claude override (${(claudeMs / 1000).toFixed(1)}s): ${JSON.stringify(claudeOverride)}`);
          } else {
            console.log(`  🧠 Claude returned null — NEEDS_REVIEW (skipping DAC submit)  (${(claudeMs / 1000).toFixed(1)}s)`);
            results.push({
              label, classification, challenge,
              status: 'NEEDS_REVIEW',
              errorMessage: 'Claude could not resolve address',
              durationMs: Date.now() - t0,
              claudeInvoked: true,
              claudeMs,
            });
            if (i < TEST_ORDERS.length - 1) {
              await new Promise((r) => setTimeout(r, 2000));
            }
            continue;
          }
        } catch (err) {
          claudeMs = Date.now() - cT0;
          const errorMessage = (err as Error).message;
          console.log(`  🧠 Claude spawn error (${(claudeMs / 1000).toFixed(1)}s): ${errorMessage.substring(0, 120)}`);
          results.push({
            label, classification, challenge,
            status: 'NEEDS_REVIEW',
            errorMessage: `Claude spawn error: ${errorMessage}`,
            durationMs: Date.now() - t0,
            claudeInvoked: true,
            claudeMs,
          });
          if (i < TEST_ORDERS.length - 1) {
            await new Promise((r) => setTimeout(r, 2000));
          }
          continue;
        }
      }

      try {
        const result = await createShipment(
          page,
          o,
          paymentType,
          DAC_USERNAME,
          DAC_PASSWORD,
          FAKE_TENANT_ID,
          `test-job-${label}`,
          usedGuias,
          effectiveOverride,
        );

        const durationMs = Date.now() - t0;
        usedGuias.add(result.guia);

        results.push({
          label, classification, challenge,
          status: 'SUCCESS',
          guia: result.guia,
          trackingUrl: result.trackingUrl,
          durationMs,
          claudeInvoked,
          claudeMs,
          claudeOverride: effectiveOverride,
        });

        console.log(`  ✅ Guía: ${result.guia}  (${(durationMs / 1000).toFixed(1)}s)`);
        if (result.trackingUrl) console.log(`  🔗 ${result.trackingUrl}`);

      } catch (err) {
        const durationMs = Date.now() - t0;
        const errorMessage = (err as Error).message;
        results.push({
          label, classification, challenge,
          status: 'FAILED',
          errorMessage,
          durationMs,
          claudeInvoked,
          claudeMs,
          claudeOverride: effectiveOverride,
        });
        console.log(`  ❌ FAILED (${(durationMs / 1000).toFixed(1)}s): ${errorMessage.substring(0, 120)}`);
      }

      // 2s pause between orders (let the page settle)
      if (i < TEST_ORDERS.length - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  } finally {
    await dacBrowser.close();
  }

  // ── Final report ────────────────────────────────────────────────────────────
  const succeeded = results.filter((r) => r.status === 'SUCCESS');
  const failed = results.filter((r) => r.status === 'FAILED');
  const needsReview = results.filter((r) => r.status === 'NEEDS_REVIEW');
  const claudeUsed = results.filter((r) => r.claudeInvoked);
  const byClass = (cls: string) => results.filter((r) => r.classification === cls);
  const avgS = (rs: ShipmentResult[]) =>
    rs.length ? (rs.reduce((s, r) => s + r.durationMs, 0) / rs.length / 1000).toFixed(1) : '—';

  console.log('\n\n═══════════════════════════════════════════════════');
  console.log('  FINAL REPORT');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Total: ${succeeded.length}/10 succeeded  |  ${failed.length} failed  |  ${needsReview.length} needs_review`);
  console.log(`  Claude Desktop invoked on ${claudeUsed.length}/10 orders (YELLOW+RED)\n`);

  for (const cls of ['GREEN', 'YELLOW', 'RED'] as const) {
    const group = byClass(cls);
    const ok = group.filter((r) => r.status === 'SUCCESS');
    console.log(`  ${cls} (${group.length}): ${ok.length} succeeded, avg ${avgS(group)}s`);
  }

  console.log('\n  Individual results:');
  console.log('  ──────────────────────────────────────────────────');
  for (const r of results) {
    const claudeTag = r.claudeInvoked
      ? `  🧠 Claude ${r.claudeMs ? (r.claudeMs/1000).toFixed(1) + 's' : '?'}`
      : '';
    if (r.status === 'SUCCESS') {
      console.log(`  ✅ ${r.label} [${r.classification}] — Guía: ${r.guia}  (${(r.durationMs/1000).toFixed(1)}s)${claudeTag}`);
      if (r.claudeOverride) {
        console.log(`       ↳ override: ${JSON.stringify(r.claudeOverride)}`);
      }
    } else if (r.status === 'NEEDS_REVIEW') {
      console.log(`  ⚠️  ${r.label} [${r.classification}] — NEEDS_REVIEW: ${(r.errorMessage ?? '').substring(0, 90)}  (${(r.durationMs/1000).toFixed(1)}s)${claudeTag}`);
    } else {
      console.log(`  ❌ ${r.label} [${r.classification}] — ${(r.errorMessage ?? '').substring(0, 90)}  (${(r.durationMs/1000).toFixed(1)}s)${claudeTag}`);
    }
  }

  if (succeeded.length > 0) {
    console.log('\n  Guías generated:');
    for (const r of succeeded) {
      console.log(`    ${r.label}: ${r.guia}${r.trackingUrl ? '  ' + r.trackingUrl : ''}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});
