import { describe, it, expect } from 'vitest';
import { getRequestIp, rateLimitBucketForIp } from '../rate-limit-ip';

/**
 * Cubo del rate limit del alta (D26): IPv4 exacta, IPv6 por /64. La clave
 * de Redis se arma con esto; si dos direcciones del mismo /64 dieran cubos
 * distintos, el límite por IP no limitaría nada en IPv6.
 */
describe('rateLimitBucketForIp', () => {
  it('IPv4 queda tal cual', () => {
    expect(rateLimitBucketForIp('203.0.113.9')).toBe('203.0.113.9');
    expect(rateLimitBucketForIp('unknown')).toBe('unknown');
  });

  it('IPv6: dos direcciones del mismo /64 caen en el mismo cubo', () => {
    const a = rateLimitBucketForIp('2001:db8:85a3:1::8a2e:370:7334');
    const b = rateLimitBucketForIp('2001:0db8:85a3:0001:ffff:ffff:ffff:ffff');
    expect(a).toBe('2001:db8:85a3:1::/64');
    expect(b).toBe(a);
  });

  it('IPv6: /64 distintos dan cubos distintos', () => {
    expect(rateLimitBucketForIp('2001:db8:85a3:1::1')).not.toBe(
      rateLimitBucketForIp('2001:db8:85a3:2::1'),
    );
  });

  it('expande `::` al principio y en el medio sin perder hextetos', () => {
    expect(rateLimitBucketForIp('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitBucketForIp('fe80::1')).toBe('fe80:0:0:0::/64');
    expect(rateLimitBucketForIp('2001:db8::1:2:3:4')).toBe('2001:db8:0:0::/64');
  });

  it('IPv4 mapeada en IPv6 se trata como la IPv4', () => {
    expect(rateLimitBucketForIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });
});

describe('getRequestIp', () => {
  const req = (headers: Record<string, string>) =>
    new Request('https://autoenvia.com/x', { headers });

  it('primer salto de x-forwarded-for, sin espacios', () => {
    expect(getRequestIp(req({ 'x-forwarded-for': ' 203.0.113.9 , 10.0.0.1' }))).toBe('203.0.113.9');
  });

  it('sin x-forwarded-for cae a x-real-ip', () => {
    expect(getRequestIp(req({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('sin ninguno → "unknown" (todos los sin-IP comparten contador)', () => {
    expect(getRequestIp(req({}))).toBe('unknown');
  });
});
