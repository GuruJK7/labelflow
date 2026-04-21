/**
 * Smoke test for resolveAddressCorrection — verifies the Anthropic API
 * fallback path works end-to-end. Not part of the unit test suite; run
 * manually to confirm the API key + prompt produce a parseable override.
 *
 * Usage (with LABELFLOW_BRIDGE_URL unset so it skips straight to API):
 *   ANTHROPIC_API_KEY=sk-ant-xxx npx ts-node src/smoke-dispatcher.ts
 */

import { resolveAddressCorrection } from './agent/invoke-claude';
import { createStepLogger } from './logger';

async function main() {
  const fakeEntry: any = {
    order: {
      id: 77001,
      name: '#77001',
      shipping_address: {
        first_name: 'María',
        last_name: 'Rodríguez',
        address1: 'Av. Brasil 2500, Apto 12B',
        address2: '',
        city: 'Solymar',
        province: 'Montevideo', // wrong — Solymar is in Canelones
        zip: '',
        phone: '099-887-766',  // has dashes
        country: 'Uruguay',
      },
    },
    classification: {
      zone: 'YELLOW',
      reasons: ['UNKNOWN_CITY', 'APARTMENT_IN_ADDRESS'],
      summary: 'smoke',
      orderId: '77001',
      orderName: '#77001',
    },
    labelId: 'smoke-label',
    paymentType: 'DESTINATARIO',
  };

  const slog = createStepLogger('smoke-dispatcher', 'smoke-tenant');

  console.log('env check:');
  console.log('  LABELFLOW_BRIDGE_URL:', process.env.LABELFLOW_BRIDGE_URL || '(unset)');
  console.log('  ANTHROPIC_API_KEY:   ', process.env.ANTHROPIC_API_KEY ? `set (${process.env.ANTHROPIC_API_KEY.slice(0, 18)}...)` : '(unset)');
  console.log();

  const t0 = Date.now();
  const override = await resolveAddressCorrection({
    entry: fakeEntry,
    jobId: 'smoke-job',
    slog,
  });
  const ms = Date.now() - t0;

  console.log(`\nResult (${ms}ms):`, JSON.stringify(override, null, 2));

  if (!override) {
    console.error('FAIL: got null override');
    process.exit(1);
  }

  // Basic sanity: override should at least correct one of the known issues
  const corrected = override.department === 'Canelones'
    || /Apto|apartment/i.test(override.notes ?? '')
    || /^\d{8}$/.test(override.phone ?? '');

  if (!corrected) {
    console.error('FAIL: override did not correct any known issue');
    process.exit(1);
  }

  console.log('\nPASS — dispatcher returned a plausibly-correct override.');
}

main().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});
