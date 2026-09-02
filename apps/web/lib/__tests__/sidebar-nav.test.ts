import { describe, it, expect } from 'vitest';
import { navSectionsFor } from '@/components/layout/nav';

/** Menú por rol (D32). Lo que el usuario normal NO ve tiene que estar acá. */
const hrefs = (isAdmin: boolean) => navSectionsFor(isAdmin).flatMap((s) => s.items.map((i) => i.href));

describe('navSectionsFor', () => {
  it('usuario normal: exactamente Dashboard, Etiquetas y Configuración', () => {
    const sections = navSectionsFor(false);
    expect(sections.map((s) => s.label)).toEqual(['Principal', 'Sistema']);
    expect(sections[0].items.map((i) => i.href)).toEqual(['/dashboard', '/labels']);
    expect(sections[1].items.map((i) => i.href)).toEqual(['/settings']);
    expect(sections[1].items[0].label).toBe('Configuración');
  });

  it('usuario normal: sin Control, Pedidos, Meta Ads, Recover, Reportes, Referidos, Envíos ni Admin', () => {
    const h = hrefs(false);
    for (const oculto of ['/control', '/orders', '/ads', '/recover', '/reports', '/settings/referrals', '/settings/billing', '/admin']) {
      expect(h).not.toContain(oculto);
    }
    // Tampoco secciones "Soon" (META ADS / RECOVER) que se colapsan en un umbrella.
    expect(navSectionsFor(false).some((s) => s.displayLabel)).toBe(false);
  });

  it('admin: todo lo de hoy más /admin, y "Comprar envíos" en vez de "Envíos"', () => {
    const h = hrefs(true);
    for (const visible of ['/dashboard', '/control', '/orders', '/labels', '/ads', '/recover', '/reports', '/settings', '/settings/shipping-rules', '/settings/billing', '/settings/referrals', '/admin']) {
      expect(h).toContain(visible);
    }
    const billing = navSectionsFor(true).flatMap((s) => s.items).find((i) => i.href === '/settings/billing');
    expect(billing?.label).toBe('Comprar envíos');
    expect(navSectionsFor(true).map((s) => s.label)).toEqual(['Principal', 'META ADS', 'RECOVER', 'Sistema']);
  });

  it('cada item tiene icono (componente) y label con texto', () => {
    for (const item of navSectionsFor(true).flatMap((s) => s.items)) {
      expect(typeof item.icon).not.toBe('undefined');
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});
