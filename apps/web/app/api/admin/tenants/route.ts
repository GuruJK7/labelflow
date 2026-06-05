import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/admin';
import { apiSuccess } from '@/lib/api-utils';
import { NextResponse } from 'next/server';

/**
 * GET /api/admin/tenants
 *
 * Lightweight tenant directory used to populate the store filter in the
 * admin analytics dashboard. Intentionally tiny: just enough to render the
 * dropdown (name, slug, connection flag) plus this-month label volume so
 * the list can be sorted by "busiest store first".
 *
 * Admin-gated like /api/admin/metrics — non-admins get a 404 so the
 * endpoint's existence isn't advertised.
 */

export interface AdminTenantOption {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  shopifyConnected: boolean;
  labelsThisMonth: number; // recomputed from Label rows (UY month), not a cached counter
}

export async function GET() {
  const admin = await getAdminSession();
  if (!admin) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const monthStart = startOfUyMonth(new Date());

  const [tenants, perTenantThisMonth] = await Promise.all([
    db.tenant.findMany({
      select: {
        id: true,
        name: true,
        slug: true,
        isActive: true,
        shopifyStoreUrl: true,
      },
    }),
    db.label.groupBy({
      by: ['tenantId'],
      where: {
        createdAt: { gte: monthStart },
        status: { in: ['CREATED', 'COMPLETED'] },
      },
      _count: true,
    }),
  ]);

  const thisMonth = new Map<string, number>();
  for (const r of perTenantThisMonth) thisMonth.set(r.tenantId, r._count);

  const options: AdminTenantOption[] = tenants
    .map((t) => ({
      id: t.id,
      name: t.name || t.slug,
      slug: t.slug,
      isActive: t.isActive,
      shopifyConnected: !!t.shopifyStoreUrl,
      labelsThisMonth: thisMonth.get(t.id) ?? 0,
    }))
    .sort((a, b) => {
      // Busiest first; ties broken alphabetically so the list is stable.
      if (b.labelsThisMonth !== a.labelsThisMonth) {
        return b.labelsThisMonth - a.labelsThisMonth;
      }
      return a.name.localeCompare(b.name, 'es');
    });

  return apiSuccess({ tenants: options });
}

/**
 * Start of the current month anchored to America/Montevideo (UTC-3, no DST).
 * Mirrors the helper in /api/admin/metrics so both endpoints agree on what
 * "this month" means.
 */
function startOfUyMonth(d: Date): Date {
  const uy = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const y = uy.getUTCFullYear();
  const m = uy.getUTCMonth();
  return new Date(Date.UTC(y, m, 1, 3, 0, 0, 0));
}
