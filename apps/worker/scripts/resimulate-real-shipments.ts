/**
 * Re-simulate 30 real production shipments against the CURRENT resolver code
 * (post Capa 1 + Capa 2 + Capa 3 + Capa 3b).
 *
 * Picks the tenant with the most Labels and re-runs the resolver against the
 * raw inputs reconstructed from each Label (deliveryAddress + city + zip as
 * best-effort stand-ins for the original Shopify inputs). The Label's stored
 * department reflects whatever the OLD resolver returned AND what DAC
 * accepted — DAC only validates form format, not geographic truth. When the
 * new dept disagrees with the stored dept BUT agrees with the ZIP prefix,
 * that's a CORRECTION of an old bug (the package was shipping to the wrong
 * dept and the customer probably called asking where it was).
 *
 * Usage:
 *   set -a && . ../web/.env.production.local && . ./.env && set +a && \
 *   npx tsx scripts/resimulate-real-shipments.ts [tenantId]
 */
import { db } from '../src/db';
import { resolveAddressWithAI } from '../src/dac/ai-resolver';

interface Row {
  id: string;
  tenantId: string;
  shopifyOrderName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  // Reconstructed from stored Label data — we don't have the exact Shopify
  // raw inputs, but deliveryAddress + city + zip is what DAC received.
  city: string;
  address1: string;
  zip: string | null;
  storedDept: string;
  storedCity: string;
}

async function pickTenant(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  // Pick the tenant with the most Labels — most data = most signal for
  // the simulation.
  const grouped = await db.label.groupBy({
    by: ['tenantId'],
    _count: { _all: true },
    orderBy: { _count: { tenantId: 'desc' } },
    take: 5,
  });
  if (grouped.length === 0) throw new Error('No Label rows in DB');
  console.log('Top tenants by Label count:');
  for (const g of grouped) {
    const t = await db.tenant.findUnique({ where: { id: g.tenantId }, select: { name: true, shopifyStoreUrl: true } });
    console.log(`  ${g.tenantId}  name="${t?.name ?? '-'}"  url=${t?.shopifyStoreUrl ?? '-'}  labels=${g._count._all}`);
  }
  return grouped[0].tenantId;
}

// Extract ZIP from the deliveryAddress or city field (some Shopify stores
// concatenate everything into address1). Returns null if no 5-digit run
// found at a plausible position.
function extractZip(row: { address1: string; city: string }): string | null {
  const m1 = row.address1.match(/\b(\d{5})\b/);
  if (m1) return m1[1];
  const m2 = row.city.match(/\b(\d{5})\b/);
  if (m2) return m2[1];
  return null;
}

async function pickRows(tenantId: string, n: number): Promise<Row[]> {
  // Pull most-recent Labels regardless of whether an AddressResolution row
  // exists. Broad enough to include the problematic cases (Portezuelo,
  // Cuchilla Alta, Libertad) that may have been resolved via the AI path
  // but where the cache row might have been evicted.
  const labels = await db.label.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: n,
  });

  const rows: Row[] = labels.map((l) => {
    // Enrich with raw inputs from AddressResolution if available (better
    // quality than reconstruction from Label). Async lookup below.
    return {
      id: l.id,
      tenantId,
      shopifyOrderName: l.shopifyOrderName,
      customerEmail: l.customerEmail,
      customerPhone: l.customerPhone,
      city: l.city,
      address1: l.deliveryAddress,
      zip: null,
      storedDept: l.department,
      storedCity: l.city,
    };
  });

  // Best-effort enrichment: if an AddressResolution row exists for this
  // tenant with the same resolvedDeliveryAddress, pull its rawZip/rawCity/
  // rawAddress1 (the Shopify originals) which are the CORRECT inputs to
  // the resolver.
  for (const r of rows) {
    const ar = await db.addressResolution.findFirst({
      where: {
        tenantId,
        resolvedDeliveryAddress: r.address1,
        resolvedCity: r.storedCity,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (ar) {
      r.city = ar.rawCity;
      r.address1 = ar.rawAddress1;
      r.zip = ar.rawZip;
    } else {
      r.zip = extractZip({ address1: r.address1, city: r.city });
    }
  }

  return rows;
}

const ZIP_PREFIX_TO_DEPT: Record<string, string> = {
  '11': 'Montevideo',
  '15': 'Canelones',
  '20': 'Maldonado',
  '27': 'Rocha',
  '30': 'Lavalleja',
  '33': 'Treinta y Tres',
  '37': 'Cerro Largo',
  '40': 'Rivera',
  '45': 'Tacuarembo',
  '50': 'Salto',
  '55': 'Artigas',
  '60': 'Paysandu',
  '65': 'Rio Negro',
  '70': 'Colonia',
  '75': 'Soriano',
  '80': 'San Jose',
  '85': 'Flores',
  '90': 'Canelones',
  '91': 'Canelones',
  '94': 'Florida',
  '97': 'Durazno',
};

function zipImpliedDept(zip?: string | null): string | null {
  if (!zip) return null;
  const clean = zip.trim();
  if (!/^\d{5}$/.test(clean)) return null;
  const prefix = clean.slice(0, 2);
  return ZIP_PREFIX_TO_DEPT[prefix] ?? null;
}

async function main() {
  const explicitTenant = process.argv[2];
  const n = 30;
  console.log(`\n[resimulate-real-shipments] Starting run for ${n} shipments\n`);

  const tenantId = await pickTenant(explicitTenant);
  console.log(`\nTenant: ${tenantId}\n`);

  const rows = await pickRows(tenantId, n);
  console.log(`Picked ${rows.length} rows\n`);

  type Result = {
    row: Row;
    newDept: string | null;
    newCity: string | null;
    source: string;
    confidence: string | null;
    reasoning: string;
    zipImplied: string | null;
    matchesStored: boolean;
    matchesZip: boolean;
    isDetermCorrectionOfOldBug: boolean;
    aiCost: number;
  };

  const results: Result[] = [];
  let totalCost = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    process.stdout.write(`[${i + 1}/${rows.length}] ${r.shopifyOrderName} city="${r.city}" zip=${r.zip ?? '-'} ... `);
    let resolved;
    try {
      resolved = await resolveAddressWithAI({
        tenantId: r.tenantId,
        city: r.city,
        address1: r.address1,
        address2: '',
        zip: r.zip ?? undefined,
        customerEmail: r.customerEmail ?? undefined,
        customerPhone: r.customerPhone ?? undefined,
      });
    } catch (err) {
      console.log(`ERROR: ${(err as Error).message}`);
      continue;
    }
    const newDept = resolved?.department ?? null;
    const newCity = resolved?.city ?? null;
    const source = resolved?.source ?? 'null';
    const confidence = resolved?.confidence ?? null;
    const reasoning = resolved?.reasoning ?? '';
    const cost = resolved?.aiCostUsd ?? 0;
    totalCost += cost;
    const zipImp = zipImpliedDept(r.zip);
    const matchesStored = newDept !== null && newDept === r.storedDept;
    const matchesZip = newDept !== null && zipImp !== null && newDept === zipImp;
    const isDetermCorrectionOfOldBug =
      zipImp !== null &&
      r.storedDept !== zipImp &&
      newDept === zipImp;
    results.push({
      row: r,
      newDept,
      newCity,
      source,
      confidence,
      reasoning,
      zipImplied: zipImp,
      matchesStored,
      matchesZip,
      isDetermCorrectionOfOldBug,
      aiCost: cost,
    });
    const tag = matchesStored ? 'MATCH' : isDetermCorrectionOfOldBug ? 'CORRECTION' : 'DIFF';
    console.log(
      `new=${newDept}/${newCity || '(empty)'} stored=${r.storedDept} zip=${zipImp ?? '-'} src=${source} ${tag}`,
    );
  }

  console.log('\n━━━ SUMMARY ━━━');
  const matchCount = results.filter((r) => r.matchesStored).length;
  const correctionCount = results.filter((r) => r.isDetermCorrectionOfOldBug).length;
  const diffCount = results.length - matchCount - correctionCount;
  const aiCount = results.filter((r) => r.source === 'ai').length;
  const detCount = results.filter((r) => r.source === 'deterministic').length;
  const cacheCount = results.filter((r) => r.source === 'cache').length;
  const matchesZipCount = results.filter((r) => r.matchesZip).length;
  const zipAvailCount = results.filter((r) => r.zipImplied !== null).length;

  console.log(`Total simulated:       ${results.length}`);
  console.log(`Matches stored:        ${matchCount}`);
  console.log(`Corrections of old:    ${correctionCount}`);
  console.log(`Still diverges:        ${diffCount}`);
  console.log(`Matches ZIP-implied:   ${matchesZipCount} / ${zipAvailCount} rows with valid ZIP`);
  console.log(`Source: deterministic=${detCount}  ai=${aiCount}  cache=${cacheCount}`);
  console.log(`Total AI cost:         $${totalCost.toFixed(4)}`);

  if (correctionCount > 0) {
    console.log('\n━━━ CORRECTIONS (old resolver was wrong; new one matches ZIP) ━━━');
    for (const r of results.filter((x) => x.isDetermCorrectionOfOldBug)) {
      console.log(
        `  ${r.row.shopifyOrderName}: city="${r.row.city}" zip=${r.row.zip} ` +
          `OLD=${r.row.storedDept} NEW=${r.newDept} (zipImplied=${r.zipImplied})`,
      );
      console.log(`    src=${r.source} conf=${r.confidence} :: ${r.reasoning.slice(0, 140)}`);
    }
  }

  if (diffCount > 0) {
    console.log('\n━━━ REMAINING DIVERGENCES (new != stored AND not a ZIP correction) ━━━');
    for (const r of results.filter((x) => !x.matchesStored && !x.isDetermCorrectionOfOldBug)) {
      console.log(
        `  ${r.row.shopifyOrderName}: city="${r.row.city}" addr="${r.row.address1.slice(0, 40)}" zip=${r.row.zip ?? '-'}`,
      );
      console.log(
        `    OLD=${r.row.storedDept} NEW=${r.newDept}/${r.newCity || '-'} (zipImplied=${r.zipImplied ?? '-'})`,
      );
      console.log(`    src=${r.source} conf=${r.confidence} :: ${r.reasoning.slice(0, 160)}`);
    }
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error('FATAL:', err);
  db.$disconnect();
  process.exit(1);
});
