import { describe, it, expect } from 'vitest';

import {
  shopHandleFromParam,
  connectedNewStoreMessage,
  shopifyLoginMessage,
  SHOPIFY_LOGIN_GENERIC_ERROR,
} from '../shopify-messages';

/**
 * `shop` llega a /settings por la URL: lo que no tenga forma de handle de
 * Shopify no se muestra. El banner es verde y dice "quedó conectada": es el
 * lugar ideal para colar texto ajeno si no se filtra.
 */
describe('shopHandleFromParam', () => {
  it('acepta un handle con la forma de Shopify y lo normaliza a minúsculas', () => {
    expect(shopHandleFromParam('acme')).toBe('acme');
    expect(shopHandleFromParam('  Acme-Store2 ')).toBe('acme-store2');
    expect(shopHandleFromParam('0a')).toBe('0a');
  });

  it('rechaza lo que no es un handle: vacío, dominios, espacios, HTML, guión final, largo', () => {
    for (const malo of [
      null,
      undefined,
      '',
      '   ',
      'acme.myshopify.com',
      'acme store',
      '<script>alert(1)</script>',
      'acme:llamá al 099',
      '-acme',
      'acme-',
      'ácme',
      'a'.repeat(101),
    ]) {
      expect(shopHandleFromParam(malo), String(malo)).toBeNull();
    }
  });
});

describe('connectedNewStoreMessage', () => {
  it('nombra la tienda y manda al selector', () => {
    const m = connectedNewStoreMessage('acme', false);
    expect(m.ok).toBe(true);
    expect(m.text).toBe(
      'La tienda acme quedó conectada como tienda nueva: elegila en el selector para cargar sus credenciales de DAC.',
    );
  });

  it('con webhooks fallidos agrega el aviso de demora sin perder el nombre', () => {
    const m = connectedNewStoreMessage('acme', true);
    expect(m.text).toContain('La tienda acme quedó conectada');
    expect(m.text).toContain('15 minutos');
  });
});

describe('shopifyLoginMessage', () => {
  it('already_linked tiene texto propio en el login (no cae en el genérico)', () => {
    const m = shopifyLoginMessage('already_linked');
    expect(m?.ok).toBe(false);
    expect(m?.text).toBe(
      'Esta tienda ya está vinculada a una cuenta. Iniciá sesión con esa cuenta y usá Reconectar en Configuración.',
    );
    expect(m).not.toBe(SHOPIFY_LOGIN_GENERIC_ERROR);
  });

  it('cualquier otro error sigue cayendo en el genérico', () => {
    expect(shopifyLoginMessage('bad_hmac')).toBe(SHOPIFY_LOGIN_GENERIC_ERROR);
    expect(shopifyLoginMessage(null)).toBeNull();
  });
});
