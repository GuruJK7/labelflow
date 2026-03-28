import { MercadoPagoConfig, Preference, Payment, PreApproval } from 'mercadopago';

let _config: MercadoPagoConfig | null = null;

function getConfig(): MercadoPagoConfig {
  if (_config) return _config;

  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('MERCADOPAGO_ACCESS_TOKEN is required');
  }

  _config = new MercadoPagoConfig({ accessToken });
  return _config;
}

export function getPreferenceClient(): Preference {
  return new Preference(getConfig());
}

export function getPaymentClient(): Payment {
  return new Payment(getConfig());
}

export function getPreApprovalClient(): PreApproval {
  return new PreApproval(getConfig());
}

export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceUSD: 15,
    priceUYU: 600,
    labelLimit: 100,
    tier: 'STARTER' as const,
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceUSD: 35,
    priceUYU: 1400,
    labelLimit: 500,
    tier: 'GROWTH' as const,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUSD: 69,
    priceUYU: 2760,
    labelLimit: 999999,
    tier: 'PRO' as const,
  },
} as const;

export type PlanId = keyof typeof PLANS;

export function getPlanByTier(tier: string): (typeof PLANS)[PlanId] | null {
  for (const plan of Object.values(PLANS)) {
    if (plan.tier === tier) return plan;
  }
  return null;
}

export function getPlanLimit(planId: string | null): number {
  if (!planId) return 0;
  const plan = PLANS[planId as PlanId];
  return plan?.labelLimit ?? 0;
}

export function getPlanTier(planId: string | null): string {
  if (!planId) return 'NONE';
  const plan = PLANS[planId as PlanId];
  return plan?.tier ?? 'NONE';
}
