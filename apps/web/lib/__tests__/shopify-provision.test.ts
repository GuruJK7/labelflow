import { describe, it, expect } from 'vitest';
import { tenantSlugForShop } from '../shopify-provision';

/**
 * El slug es la clave de idempotencia del alta desde el App Store: reinstalar
 * tiene que reusar la misma tienda, no crear una nueva. Si esta función deja de
 * ser estable, cada reinstalación duplica el tenant del comerciante.
 */
describe('tenantSlugForShop', () => {
  it('es estable: el mismo dominio da siempre el mismo slug', () => {
    expect(tenantSlugForShop('mi-tienda.myshopify.com')).toBe('shop-mi-tienda');
    expect(tenantSlugForShop('mi-tienda.myshopify.com')).toBe('shop-mi-tienda');
  });

  it('dos tiendas distintas nunca colisionan', () => {
    const a = tenantSlugForShop('aura.myshopify.com');
    const b = tenantSlugForShop('kinevia.myshopify.com');
    expect(a).not.toBe(b);
  });

  it('sale del handle, no del dominio completo', () => {
    expect(tenantSlugForShop('cfzf6b-dk.myshopify.com')).toBe('shop-cfzf6b-dk');
  });

  it('descarta cualquier carácter que no sea seguro en un slug', () => {
    expect(tenantSlugForShop('Tienda_Rara!.myshopify.com')).toMatch(/^shop-[a-z0-9-]*$/);
  });

  it('acota el largo para no romper el índice único', () => {
    const s = tenantSlugForShop('a'.repeat(120) + '.myshopify.com');
    expect(s.length).toBeLessThanOrEqual(45);
    expect(s.startsWith('shop-')).toBe(true);
  });
});
