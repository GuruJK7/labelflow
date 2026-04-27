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
      firstJobCompletedAt: true,
      shopifyStoreUrl: true,
      shopifyToken: true,
      dacUsername: true,
      dacPassword: true,
    },
  });

  if (!tenant) redirect('/login');

  // Onboarding gate: if the user hasn't finished the wizard yet, force them
  // through it. We also re-check the underlying credentials are still set —
  // if they cleared one in /settings without re-doing onboarding, treat the
  // tenant as un-onboarded so the activation funnel rebuilds them properly.
  const hasShopify = !!tenant.shopifyStoreUrl && !!tenant.shopifyToken;
  const hasDac = !!tenant.dacUsername && !!tenant.dacPassword;
  if (!tenant.onboardingComplete || !hasShopify || !hasDac) {
    redirect('/onboarding');
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

  const credits = tenant.shipmentCredits;

  return (
    <div className="min-h-screen bg-[#050505]">
      <Sidebar />
      <main className="lg:ml-60 min-h-screen">
        <TopBar credits={credits} />
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
          {credits > 0 && credits <= 2 && <LowCreditsBanner credits={credits} />}
          {children}
        </div>
      </main>
      <ChatWidget />
      {showAha && <AhaMomentModal />}
      {credits === 0 && <CreditExhaustedModal />}
    </div>
  );
}
