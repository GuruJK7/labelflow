import { redirect } from 'next/navigation';
import { Sidebar } from '@/components/layout/Sidebar';
import { ChatWidget } from '@/components/chat/ChatWidget';
import { TopBar } from '@/components/layout/TopBar';
import { AhaMomentModal } from '@/components/onboarding/AhaMomentModal';
import { LowCreditsBanner } from '@/components/onboarding/LowCreditsBanner';
import { CreditExhaustedModal } from '@/components/onboarding/CreditExhaustedModal';
import { getAuthenticatedTenant } from '@/lib/api-utils';
import { db } from '@/lib/db';

/**
 * Server-component dashboard layout.
 *
 * Why this layout — and NOT middleware — gates onboarding:
 *   Middleware runs on the Edge runtime, which can't bundle Prisma. We need
 *   a DB read to check `onboardingComplete` (it's intentionally NOT in the
 *   JWT — completing onboarding must take effect on the very next request,
 *   not after the 15-min JWT refresh window). Doing the check here means
 *   one extra `findUnique` per dashboard request (~20–50 ms on Supabase
 *   pooler), which is acceptable for the activation gate.
 *
 * The tenant query also drives the credit counter in the TopBar and the
 * "aha moment" modal, so we coalesce all three lookups into a single round
 * trip on layout render.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const auth = await getAuthenticatedTenant();
  // Middleware already redirected unauthenticated users to /login; this is
  // belt-and-suspenders. If somehow we got here without a session, bounce.
  if (!auth) redirect('/login');

  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: {
      onboardingComplete: true,
      shipmentCredits: true,
      referralBonusCredits: true,
      firstJobCompletedAt: true,
      shopifyStoreUrl: true,
      shopifyToken: true,
      dacUsername: true,
      dacPassword: true,
      // Email verification gate — only checked when EMAIL_VERIFICATION_REQUIRED
      // is on. Selecting this field always is cheap (one extra timestamp on
      // a row we already fetch) and lets us flip the flag without a
      // redeploy.
      user: { select: { email: true, emailVerified: true } },
    },
  });

  if (!tenant) redirect('/login');

  // Email-verification gate. Off by default so a Resend outage or a fresh
  // preview deploy without `RESEND_API_KEY` doesn't lock everyone out. Once
  // delivery is stable in production we flip `EMAIL_VERIFICATION_REQUIRED=1`
  // in Vercel env to enforce it. Existing users (pre-flag-flip) stay
  // grandfathered in via a one-time SQL backfill (`UPDATE "User" SET
  // "emailVerified" = NOW() WHERE "emailVerified" IS NULL`) — we don't want
  // legacy customers to suddenly hit a wall.
  const verifyRequired = process.env.EMAIL_VERIFICATION_REQUIRED === '1' ||
    process.env.EMAIL_VERIFICATION_REQUIRED === 'true';
  if (verifyRequired && tenant.user && !tenant.user.emailVerified) {
    const email = encodeURIComponent(tenant.user.email);
    redirect(`/verify-email?email=${email}`);
  }

  // Onboarding gate: if the user hasn't finished the wizard yet, force them
  // through it. We also re-check the underlying credentials are still set —
  // if they cleared one in /settings without re-doing onboarding, treat the
  // tenant as un-onboarded so the activation funnel rebuilds them properly.
  const hasShopify = !!tenant.shopifyStoreUrl && !!tenant.shopifyToken;
  const hasDac = !!tenant.dacUsername && !!tenant.dacPassword;

  // Missing credentials → always force the wizard. Nothing else matters.
  if (!hasShopify || !hasDac) {
    redirect('/onboarding');
  }

  // Legacy backfill: tenants that existed before the `onboardingComplete`
  // column was added all default to `false`, even though they may have been
  // fully configured (manually preloaded creds, internal/test accounts, users
  // who finished setup before this PLG funnel shipped). If both credentials
  // are present we treat that as proof of completed onboarding and flip the
  // flag in-place — one fire-and-forget UPDATE the first time they hit the
  // dashboard post-deploy. Subsequent renders skip this branch entirely.
  if (!tenant.onboardingComplete) {
    await db.tenant.update({
      where: { id: auth.tenantId },
      data: {
        onboardingComplete: true,
        onboardingCompletedAt: new Date(),
      },
    });
  }

  // "Aha moment" trigger: first time a label transitions to COMPLETED, light
  // up the celebration modal. The modal calls /api/v1/onboarding/aha-seen
  // on dismiss, which writes firstJobCompletedAt — so it never re-shows.
  let showAha = false;
  if (!tenant.firstJobCompletedAt) {
    const completed = await db.label.findFirst({
      where: { tenantId: auth.tenantId, status: 'COMPLETED' },
      select: { id: true },
    });
    showAha = !!completed;
  }

  // Para los gates de UX (banner amarillo, modal "sin envíos"), lo que
  // importa es el TOTAL de envíos que el usuario puede despachar — no
  // distinguimos pago vs bonus aquí, porque el worker drena bonus primero
  // de forma transparente. El TopBar SÍ separa las dos métricas para que
  // el usuario vea de dónde sale el saldo.
  const paidCredits = tenant.shipmentCredits;
  const bonusCredits = tenant.referralBonusCredits;
  const totalCredits = paidCredits + bonusCredits;

  return (
    <div className="min-h-screen bg-[#050505]">
      <Sidebar />
      <main className="lg:ml-60 min-h-screen">
        <TopBar credits={paidCredits} bonusCredits={bonusCredits} />
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
          {totalCredits > 0 && totalCredits <= 2 && (
            <LowCreditsBanner credits={totalCredits} />
          )}
          {children}
        </div>
      </main>
      <ChatWidget />
      {showAha && <AhaMomentModal />}
      {totalCredits === 0 && <CreditExhaustedModal />}
    </div>
  );
}
