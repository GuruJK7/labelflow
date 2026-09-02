import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Fija el NOMBRE VISIBLE de la app en las dos pantallas que ve primero un
 * comerciante: el login (antes de entrar) y la sidebar (apenas entra).
 *
 * Por qué existe este test: el dominio, la landing y el listado del Shopify
 * App Store dicen "AutoEnvía", pero la app decía "LabelFlow" adentro. El
 * revisor de Shopify compara la app instalada contra el listado, y un
 * comerciante que instala "AutoEnvía" no puede aterrizar en algo que se
 * llama distinto. La marca de cara al cliente es AutoEnvía; "LabelFlow SAS"
 * es la razón social y sólo aparece como firma ("por LabelFlow SAS"), que es
 * lo que figura en Shopify Partners.
 *
 * OJO: esto NO cubre los marcadores internos que el worker escribe en las
 * notas de Shopify ("LabelFlow-GUIA:", "LabelFlow ERROR:"). Esos son
 * funcionales — el worker los vuelve a buscar para deduplicar — y no se
 * renombran.
 */
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-auth/react', () => ({ signIn: vi.fn(), signOut: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href }, children),
}));

import { Sidebar } from '@/components/layout/Sidebar';
import { LoginForm } from '@/app/(auth)/login/LoginForm';

/** El wordmark viaja partido en dos nodos (`Auto` + `<span>Envía</span>`) para
 *  pintar de cyan la segunda mitad, así que hay que mirar el texto plano. */
function texto(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

describe('nombre visible de la app', () => {
  it('la sidebar dice AutoEnvía y firma "por LabelFlow SAS"', () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { isAdmin: false }));
    const plano = texto(html);

    expect(plano).toContain('AutoEnvía');
    expect(plano).toContain('por LabelFlow SAS');
    // La marca vieja no puede quedar suelta (la firma es la única excepción).
    expect(plano.replace(/por LabelFlow SAS/g, '')).not.toContain('LabelFlow');
    // El acento cyan sigue en la segunda mitad del wordmark.
    expect(html).toContain('<span class="text-cyan-400">Envía</span>');
  });

  it('el login dice AutoEnvía y firma "por LabelFlow SAS"', () => {
    const html = renderToStaticMarkup(
      createElement(LoginForm, { googleEnabled: false }),
    );
    const plano = texto(html);

    expect(plano).toContain('AutoEnvía');
    expect(plano).toContain('por LabelFlow SAS');
    expect(plano.replace(/por LabelFlow SAS/g, '')).not.toContain('LabelFlow');
  });
});
