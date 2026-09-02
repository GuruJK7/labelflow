import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  getWhopCheckoutUrls,
  getWhopPlanRules,
  checkWhopPlanForPack,
  verifyStandardWebhookSignature,
  signStandardWebhook,
  whopSigningKey,
  _resetWhopWarnings,
} from '@/lib/whop';

describe('getWhopCheckoutUrls', () => {
  afterEach(() => _resetWhopWarnings());

  it('vacío o ausente → {}', () => {
    expect(getWhopCheckoutUrls({})).toEqual({});
    expect(getWhopCheckoutUrls({ WHOP_CHECKOUT_URLS: '  ' })).toEqual({});
  });

  it('JSON inválido → {} y un solo console.error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getWhopCheckoutUrls({ WHOP_CHECKOUT_URLS: '{nope' })).toEqual({});
    expect(getWhopCheckoutUrls({ WHOP_CHECKOUT_URLS: '[1,2]' })).toEqual({});
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).not.toContain('{nope');
  });

  it('sólo conserva URLs https', () => {
    expect(
      getWhopCheckoutUrls({
        WHOP_CHECKOUT_URLS: JSON.stringify({ pack_100: 'https://whop.com/a', pack_50: 'http://x', pack_10: 5 }),
      }),
    ).toEqual({ pack_100: 'https://whop.com/a' });
  });
});

describe('getWhopPlanRules', () => {
  afterEach(() => _resetWhopWarnings());

  it('vacío o ausente → {}', () => {
    expect(getWhopPlanRules({})).toEqual({});
    expect(getWhopPlanRules({ WHOP_PLAN_IDS: ' ' })).toEqual({});
  });

  it('JSON inválido → {} y un solo console.error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    err.mockClear();
    expect(getWhopPlanRules({ WHOP_PLAN_IDS: '{nope' })).toEqual({});
    expect(getWhopPlanRules({ WHOP_PLAN_IDS: '["plan_1"]' })).toEqual({});
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('acepta string (sólo plan) u objeto {planId, minUsd}; descarta entradas rotas', () => {
    expect(
      getWhopPlanRules({
        WHOP_PLAN_IDS: JSON.stringify({
          pack_100: ' plan_100 ',
          pack_500: { planId: 'plan_500', minUsd: 60 },
          pack_250: { planId: 'plan_250', minUsd: -1 },
          pack_50: { minUsd: 10 },
          pack_10: 7,
          pack_1000: '',
        }),
      }),
    ).toEqual({
      pack_100: { planId: 'plan_100' },
      pack_500: { planId: 'plan_500', minUsd: 60 },
      pack_250: { planId: 'plan_250' },
    });
  });
});

describe('checkWhopPlanForPack (fail-closed sobre el producto)', () => {
  const rules = {
    pack_100: { planId: 'plan_100' },
    pack_10: { planId: 'plan_10', minUsd: 5 },
  };
  const base = { packId: 'pack_100', payloadPlanIds: ['plan_100'], amount: null, currency: null, rules };

  it('plan del pack presente en el payload → ok', () => {
    expect(checkWhopPlanForPack(base)).toEqual({ ok: true });
    expect(checkWhopPlanForPack({ ...base, payloadPlanIds: ['prod_x', 'plan_100'] })).toEqual({ ok: true });
  });

  it('sin reglas, pack sin regla, payload sin plan, plan distinto → cada razón', () => {
    expect(checkWhopPlanForPack({ ...base, rules: {} })).toEqual({ ok: false, reason: 'no_rules' });
    expect(checkWhopPlanForPack({ ...base, packId: 'pack_1000' })).toEqual({ ok: false, reason: 'pack_not_mapped' });
    expect(checkWhopPlanForPack({ ...base, payloadPlanIds: [] })).toEqual({ ok: false, reason: 'plan_missing' });
    expect(checkWhopPlanForPack({ ...base, packId: 'pack_100', payloadPlanIds: ['plan_10'] })).toEqual({
      ok: false,
      reason: 'plan_mismatch',
    });
  });

  it('con minUsd exige monto, USD y piso; sin minUsd no mira el monto', () => {
    const p10 = { ...base, packId: 'pack_10', payloadPlanIds: ['plan_10'] };
    expect(checkWhopPlanForPack(p10)).toEqual({ ok: false, reason: 'amount_missing' });
    expect(checkWhopPlanForPack({ ...p10, amount: 5, currency: 'eur' })).toEqual({ ok: false, reason: 'currency_mismatch' });
    expect(checkWhopPlanForPack({ ...p10, amount: 5, currency: null })).toEqual({ ok: false, reason: 'currency_mismatch' });
    expect(checkWhopPlanForPack({ ...p10, amount: 4.99, currency: 'USD' })).toEqual({ ok: false, reason: 'amount_below_min' });
    expect(checkWhopPlanForPack({ ...p10, amount: 5, currency: 'usd' })).toEqual({ ok: true });
    expect(checkWhopPlanForPack({ ...base, amount: 0.01, currency: 'eur' })).toEqual({ ok: true });
  });
});

describe('verifyStandardWebhookSignature', () => {
  const key = crypto.randomBytes(32);
  const secret = `whsec_${key.toString('base64')}`;
  const body = '{"type":"payment.succeeded","data":{"id":"pay_1"}}';
  const now = 1_800_000_000_000;
  const ts = String(Math.floor(now / 1000));

  it('la clave whsec_ se decodifica de base64; la plana se usa tal cual', () => {
    expect(whopSigningKey(secret).equals(key)).toBe(true);
    expect(whopSigningKey('plano').toString()).toBe('plano');
  });

  it('vector calculado a mano: HMAC-SHA256(key, "id.ts.body") en base64', () => {
    const expected = crypto.createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
    expect(signStandardWebhook(secret, 'msg_1', ts, body)).toBe(expected);
    expect(
      verifyStandardWebhookSignature({
        secret, webhookId: 'msg_1', timestamp: ts, signatureHeader: `v1,${expected}`, rawBody: body, nowMs: now,
      }),
    ).toEqual({ ok: true });
  });

  it('razones de fallo', () => {
    const good = signStandardWebhook(secret, 'msg_1', ts, body);
    const base = { secret, webhookId: 'msg_1', timestamp: ts, signatureHeader: `v1,${good}`, rawBody: body, nowMs: now };
    expect(verifyStandardWebhookSignature({ ...base, webhookId: null })).toEqual({ ok: false, reason: 'missing_headers' });
    expect(verifyStandardWebhookSignature({ ...base, timestamp: 'ayer' })).toEqual({ ok: false, reason: 'bad_timestamp' });
    expect(verifyStandardWebhookSignature({ ...base, nowMs: now + 301_000 })).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
    expect(verifyStandardWebhookSignature({ ...base, nowMs: now + 300_000 })).toEqual({ ok: true });
    expect(verifyStandardWebhookSignature({ ...base, rawBody: body + ' ' })).toEqual({ ok: false, reason: 'no_match' });
    expect(verifyStandardWebhookSignature({ ...base, signatureHeader: `v2,${good}` })).toEqual({ ok: false, reason: 'no_match' });
    expect(verifyStandardWebhookSignature({ ...base, signatureHeader: `v1,xx v1,${good}` })).toEqual({ ok: true });
  });
});
