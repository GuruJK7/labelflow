import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Render real del Sidebar en node (react-dom/server; no hay testing-library
 * en el repo). Verifica que lo que sale al HTML respeta el rol, no sólo la
 * lista de nav.ts.
 */
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode; onClick?: unknown }) =>
    createElement('a', { href }, children),
}));

import { Sidebar } from '@/components/layout/Sidebar';

function linksOf(html: string): string[] {
  return Array.from(html.matchAll(/href="([^"]+)"/g)).map((m) => m[1]);
}

describe('<Sidebar isAdmin>', () => {
  it('usuario normal: sólo /dashboard, /labels y /settings (más el logo a /dashboard)', () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { isAdmin: false }));
    const links = new Set(linksOf(html));
    expect(links).toEqual(new Set(['/dashboard', '/labels', '/settings']));
    for (const oculto of ['/control', '/orders', '/reports', '/settings/referrals', '/settings/billing', '/admin', '/ads', '/recover']) {
      expect(html).not.toContain(`href="${oculto}"`);
    }
    expect(html).not.toContain('Meta Ads');
    expect(html).not.toContain('Recover');
    expect(html).toContain('Configuración');
    expect(html).toContain('Cerrar sesión');
  });

  it('sin prop → usuario normal (default seguro)', () => {
    const html = renderToStaticMarkup(createElement(Sidebar, {}));
    expect(html).not.toContain('href="/control"');
    expect(html).not.toContain('href="/admin"');
  });

  it('admin: Control, Pedidos, Reportes, Comprar envíos, Referidos y Admin', () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { isAdmin: true }));
    const links = new Set(linksOf(html));
    for (const visible of ['/control', '/orders', '/reports', '/settings/billing', '/settings/referrals', '/admin']) {
      expect(links.has(visible)).toBe(true);
    }
    expect(html).toContain('Comprar envíos');
    expect(html).toContain('Admin');
  });
});
