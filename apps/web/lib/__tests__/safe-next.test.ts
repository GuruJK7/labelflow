import { describe, it, expect } from 'vitest';
import { safeRelativePath } from '../safe-next';

/**
 * /login lee ?next= de la URL. Si aceptara cualquier cosa, sería un open
 * redirect con nuestra marca: "iniciá sesión en AutoEnvía" y te manda a
 * evil.com. Sólo rutas relativas del mismo origen.
 */
describe('safeRelativePath', () => {
  it('acepta rutas relativas del mismo origen', () => {
    expect(safeRelativePath('/dashboard')).toBe('/dashboard');
    expect(safeRelativePath('/api/shopify/claim')).toBe('/api/shopify/claim');
    expect(safeRelativePath('/settings?shopify=connected&webhooks=partial')).toBe(
      '/settings?shopify=connected&webhooks=partial',
    );
    expect(safeRelativePath('  /orders  ')).toBe('/orders');
    expect(safeRelativePath('/')).toBe('/');
    expect(safeRelativePath('/orders/abc-123_x.pdf')).toBe('/orders/abc-123_x.pdf');
    expect(safeRelativePath('/a/b%20c')).toBe('/a/b%20c');
  });

  it('rechaza todo lo que el navegador leería como otro origen', () => {
    const malos = [
      '//evil.com',
      '//evil.com/dashboard',
      '///evil.com',
      'https://evil.com',
      'http://evil.com',
      'evil.com',
      'javascript:alert(1)',
      '/\\evil.com',
      '\\\\evil.com',
      '/%5cevil.com'.replace('%5c', '\\'),
      '/https:evil.com',
      '/dashboard\nLocation: evil',
      '',
      '   ',
      null,
      undefined,
    ];
    for (const m of malos) {
      expect(safeRelativePath(m), `debería rechazar ${JSON.stringify(m)}`).toBeNull();
    }
  });

  it('rechaza rutas absurdamente largas', () => {
    expect(safeRelativePath('/' + 'a'.repeat(3000))).toBeNull();
  });
});
