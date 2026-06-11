/**
 * GET /api/v1/control/shipments?range=7|30|90
 * GET /api/v1/control/shipments?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * "Cuantos envios por tienda" — counts dispatched shipments (status
 * CREATED|COMPLETED) per store over a date window, for the authenticated
 * user's stores. Powers the shipments-by-store filter + chart.
 *
 * Date boundaries are Uruguay-local (UTC-3, no DST) so "today" / a chosen day
 * matches what the operator sees. Counting key is Label.createdAt (the row is
 * created when the guia lands; there is no separate shippedAt column).
 */

import { db } from '@/lib/db';
import { getAuthenticatedUser, apiError, apiSuccess } from '@/lib/api-utils';
import { startOfDayUy } from '@/lib/uy-time';

const ALLOWED_RANGES = [7, 30, 90];
const DEFAULT_RANGE = 30;
const DONE_STATUSES = ['CREATED', 'COMPLETED'];
const UY_OFFSET_MS = 3 * 60 * 60 * 1000; // UY = UTC-3, fixed.
const DAY_MS = 24 * 60 * 60 * 1000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** 00:00 UY of a YYYY-MM-DD, as the corresponding UTC instant. */
function uyDayStart(ymd: string): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + UY_OFFSET_MS);
}

export async function GET(req: Request) {
  const auth = await getAuthenticatedUser();
  if (!auth) return apiError('No autorizado', 401);

  const { searchParams } = new URL(req.url);
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');

  let gte: Date;
  let lt: Date | undefined;
  let label: string;

  if (fromParam && toParam && YMD.test(fromParam) && YMD.test(toParam)) {
    const start = uyDayStart(fromParam);
    const end = new Date(uyDayStart(toParam).getTime() + DAY_MS); // inclusive `to`
    if (end.getTime() <= start.getTime()) return apiError('Rango de fechas invalido', 422);
    gte = start;
    lt = end;
    label = `${fromParam} a ${toParam}`;
  } else {
    const rangeParam = Number(searchParams.get('range'));
    const range = ALLOWED_RANGES.includes(rangeParam) ? rangeParam : DEFAULT_RANGE;
    // Last `range` days inclusive of today (UY).
    gte = new Date(startOfDayUy().getTime() - (range - 1) * DAY_MS);
    lt = undefined; // open-ended to now
    label = `Ultimos ${range} dias`;
  }

  const tenants = await db.tenant.findMany({
    where: { userId: auth.userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, name: true },
  });
  if (tenants.length === 0) return apiSuccess({ stores: [], total: 0, window: label });

  const tenantIds = tenants.map((t) => t.id);
  const rows = await db.label.groupBy({
    by: ['tenantId'],
    where: {
      tenantId: { in: tenantIds },
      status: { in: DONE_STATUSES as never },
      createdAt: lt ? { gte, lt } : { gte },
    },
    _count: true,
  });

  const countByTenant = new Map(rows.map((r) => [r.tenantId, r._count]));
  const stores = tenants
    .map((t) => ({ tenantId: t.id, tenantName: t.name, count: countByTenant.get(t.id) ?? 0 }))
    .sort((a, b) => b.count - a.count);
  const total = stores.reduce((sum, s) => sum + s.count, 0);

  return apiSuccess({
    stores,
    total,
    window: label,
    from: gte.toISOString(),
    to: lt ? lt.toISOString() : new Date().toISOString(),
  });
}
