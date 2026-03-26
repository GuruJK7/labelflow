export type SubscriptionStatus =
  | 'INACTIVE'
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELED'
  | 'PAUSED';

export type PlanTier = 'STARTER' | 'GROWTH' | 'PRO';

export const PLAN_LIMITS: Record<PlanTier, number> = {
  STARTER: 100,
  GROWTH: 500,
  PRO: 999999,
};

export const PLAN_PRICES: Record<PlanTier, { usd: number; label: string }> = {
  STARTER: { usd: 15, label: 'Starter' },
  GROWTH: { usd: 35, label: 'Growth' },
  PRO: { usd: 69, label: 'Pro' },
};

export interface TenantPublicConfig {
  shopifyStoreUrl: string | null;
  shopifyConnected: boolean;
  dacConnected: boolean;
  emailConfigured: boolean;
  paymentThreshold: number;
  cronSchedule: string;
  maxOrdersPerRun: number;
  isActive: boolean;
  subscriptionStatus: SubscriptionStatus;
  labelsThisMonth: number;
  storeName: string | null;
}
