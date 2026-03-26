import Stripe from 'stripe';

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is required');
  _stripe = new Stripe(key, { apiVersion: '2024-04-10', typescript: true });
  return _stripe;
}

// Alias for convenience
export const stripe = { get instance() { return getStripe(); } };

export const PLAN_PRICE_MAP: Record<string, { tier: string; limit: number }> = {
  [process.env.STRIPE_PRICE_STARTER ?? 'price_starter']: { tier: 'STARTER', limit: 100 },
  [process.env.STRIPE_PRICE_GROWTH ?? 'price_growth']: { tier: 'GROWTH', limit: 500 },
  [process.env.STRIPE_PRICE_PRO ?? 'price_pro']: { tier: 'PRO', limit: 999999 },
};

export function getPlanLimit(priceId: string | null): number {
  if (!priceId) return 0;
  return PLAN_PRICE_MAP[priceId]?.limit ?? 0;
}

export function getPlanTier(priceId: string | null): string {
  if (!priceId) return 'NONE';
  return PLAN_PRICE_MAP[priceId]?.tier ?? 'NONE';
}
