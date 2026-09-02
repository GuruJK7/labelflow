import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  getWhopCheckoutUrls,
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
