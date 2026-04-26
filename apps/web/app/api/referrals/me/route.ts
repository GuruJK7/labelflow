import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { generateReferralCode } from '@/lib/referrals';

/**
 * Devuelve el código de referido del tenant + estadísticas + lista de
 * referidos. Si el tenant no tiene código todavía (creado antes de la
 * migración), lo genera lazy en este endpoint y lo persiste — más simple
 * que un script de backfill que requiere downtime.
 */
export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  type TenantRow = {
    id: string;
    slug: string;
    referralCode: string | null;
    referralCreditsEarned: number;
  };

  const initial = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: {
      id: true,
      slug: true,
      referralCode: true,
      referralCreditsEarned: true,
    },
  });

  if (!initial) return apiError('Tenant no encontrado', 404);

  let tenant: TenantRow = initial;

  // Lazy backfill: generar código si no tiene. Reintentamos hasta 5 veces
  // por si chocamos con una colisión (16^4 espacio por prefijo, raro).
  if (!tenant.referralCode) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateReferralCode(tenant.slug);
      try {
        const updated: TenantRow = await db.tenant.update({
          where: { id: tenant.id },
          data: { referralCode: candidate },
          select: {
            id: true,
            slug: true,
            referralCode: true,
            referralCreditsEarned: true,
          },
        });
        tenant = updated;
        break;
      } catch (err) {
        // P2002 = unique violation → reintentar con otro random
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
  }

  // Lista de referidos (tenants con referredById = este tenant)
  const referrals = await db.tenant.findMany({
    where: { referredById: tenant.id },
    select: {
      id: true,
      name: true,
      createdAt: true,
      creditsPurchased: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  // Acreditaciones recibidas (cuándo y cuánto se ganó)
  const accruals = await db.referralCreditAccrual.findMany({
    where: { referrerTenantId: tenant.id },
    select: {
      id: true,
      shipmentsAccrued: true,
      createdAt: true,
      referee: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const referralLink = tenant.referralCode
    ? `${appUrl}/signup?ref=${tenant.referralCode}`
    : null;

  return apiSuccess({
    referralCode: tenant.referralCode,
    referralLink,
    referralCreditsEarned: tenant.referralCreditsEarned,
    referralsCount: referrals.length,
    referrals,
    accruals,
  });
}
