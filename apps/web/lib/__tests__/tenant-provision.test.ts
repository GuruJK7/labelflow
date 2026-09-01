import { describe, it, expect, vi } from 'vitest';
import { nuevaApiKey, elegirReferralCode, nuevoTenantBase } from '../tenant-provision';

describe('tenant-provision — campos base de todo tenant nuevo', () => {
  it('apiKey: 32 bytes aleatorios en hex, distinta cada vez', () => {
    const a = nuevaApiKey();
    const b = nuevaApiKey();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('referralCode: mismo formato que signup y reintenta ante colisión', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ id: 'ocupado' })
      .mockResolvedValueOnce(null);
    const code = await elegirReferralCode({ tenant: { findUnique } }, 'shop-mi-tienda');
    expect(code).toMatch(/^[A-Z0-9]{2,8}-[A-Z0-9]{4,8}$/);
    expect(code?.startsWith('SHOP')).toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('referralCode: tras 5 colisiones queda null en vez de colgarse', async () => {
    const findUnique = vi.fn().mockResolvedValue({ id: 'ocupado' });
    const code = await elegirReferralCode({ tenant: { findUnique } }, 'x');
    expect(code).toBeNull();
    expect(findUnique).toHaveBeenCalledTimes(5);
  });

  it('nuevoTenantBase junta las dos cosas', async () => {
    const base = await nuevoTenantBase({ tenant: { findUnique: vi.fn().mockResolvedValue(null) } }, 'shop-x');
    expect(base.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(base.referralCode).toMatch(/^[A-Z0-9]{2,8}-[A-Z0-9]{4,8}$/);
  });
});
