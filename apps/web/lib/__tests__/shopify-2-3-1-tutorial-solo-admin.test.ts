/**
 * Requisito 2.3.1 — fuga 2, la mitad de la página.
 *
 * /tutorial/shopify-token enseña paso a paso a crearse una app privada en
 * Shopify y a copiar un Admin API token: el flujo exacto que 2.3.1 prohíbe
 * ofrecer. El 05-09 se lo sacó de `publicPaths` y se lo puso en
 * `protectedPaths`, pero ese gate del middleware es `getToken()` — pide SESIÓN,
 * no admin. Un revisor de Shopify se registra como un comerciante más, se
 * loguea, y llegaba igual.
 *
 * El gate real vive DENTRO de la página (`requireAdminOrNotFound`, que responde
 * 404 en vez de 403: al que no corresponde no se le revela ni que existe). Este
 * test lo fija: si alguien saca esa línea, se pone rojo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const NOT_FOUND = 'NEXT_NOT_FOUND';

const mocks = vi.hoisted(() => ({ requireAdminOrNotFound: vi.fn() }));
vi.mock('@/lib/admin', () => ({
  requireAdminOrNotFound: mocks.requireAdminOrNotFound,
  // El módulo real exporta más cosas; la página sólo usa ésta.
  isAdminEmail: vi.fn(),
  getAdminSession: vi.fn(),
}));

import Pagina, { metadata } from '@/app/tutorial/shopify-token/page';

beforeEach(() => vi.clearAllMocks());

describe('/tutorial/shopify-token — sólo admin', () => {
  it('a un comerciante logueado le corta con 404 antes de armar la página', async () => {
    // Así se comporta `notFound()` de Next: tira, no devuelve.
    mocks.requireAdminOrNotFound.mockRejectedValue(new Error(NOT_FOUND));
    await expect(Pagina()).rejects.toThrow(NOT_FOUND);
    expect(mocks.requireAdminOrNotFound).toHaveBeenCalledTimes(1);
  });

  it('el admin la sigue viendo: el tutorial no se borró, se gateó', async () => {
    mocks.requireAdminOrNotFound.mockResolvedValue({
      userId: 'u-admin',
      email: 'adrijk7.cr@gmail.com',
    });
    const salida = await Pagina();
    expect(salida).toBeTruthy();
    expect(mocks.requireAdminOrNotFound).toHaveBeenCalledTimes(1);
  });

  it('el <meta> no publica el alta manual fuera del gate', async () => {
    // La descripción anterior describía cómo obtener un token `shpat_` — texto
    // indexable y previsualizable que no depende de estar logueado.
    const texto = `${metadata.title} ${metadata.description}`;
    expect(texto).not.toContain('shpat_');
    expect(texto).not.toMatch(/token de Shopify/i);
    expect(metadata.robots).toMatchObject({ index: false });
  });
});
