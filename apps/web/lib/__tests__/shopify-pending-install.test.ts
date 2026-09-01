import { describe, it, expect } from 'vitest';

process.env.ENCRYPTION_KEY = '22'.repeat(32);

import { sealPendingInstall, openPendingInstall, PENDING_INSTALL_PREFIX } from '../shopify-pending-install';
import { encrypt } from '../encryption';

/** Cifra un payload arbitrario CON el prefijo de dominio: prueba la forma, no el prefijo. */
function sealRaw(plain: string): string {
  return encrypt(PENDING_INSTALL_PREFIX + plain);
}

/**
 * La cookie de instalación pendiente lleva un token de Shopify. Tiene que ser
 * ilegible, inalterable y de vida corta: cualquiera de las tres que falle
 * deja un token de tienda a merced del navegador.
 */
describe('sealPendingInstall / openPendingInstall', () => {
  const input = { shop: 'acme.myshopify.com', token: 'shpat_abc' };

  it('ida y vuelta: lo que se sella se abre igual', () => {
    const now = 1_800_000_000_000;
    const sealed = sealPendingInstall(input, now);
    expect(sealed).not.toContain('shpat_abc');
    expect(sealed).not.toContain('acme');
    expect(openPendingInstall(sealed, now + 5_000)).toEqual({
      shop: 'acme.myshopify.com',
      token: 'shpat_abc',
      iat: Math.floor(now / 1000),
    });
  });

  it('vence a los 600 segundos, ni uno más', () => {
    const now = 1_800_000_000_000;
    const sealed = sealPendingInstall(input, now);
    expect(openPendingInstall(sealed, now + 600_000)).not.toBeNull();
    expect(openPendingInstall(sealed, now + 601_000)).toBeNull();
  });

  it('rechaza una cookie "del futuro" (reloj corrido o payload manipulado)', () => {
    const now = 1_800_000_000_000;
    const sealed = sealPendingInstall(input, now);
    expect(openPendingInstall(sealed, now - 5_000)).toBeNull();
  });

  it('rechaza vacío, basura, y cifrado con forma pero sin sentido', () => {
    expect(openPendingInstall(null)).toBeNull();
    expect(openPendingInstall(undefined)).toBeNull();
    expect(openPendingInstall('')).toBeNull();
    expect(openPendingInstall('no-es-cifrado')).toBeNull();
    expect(openPendingInstall('aa:bb:cc')).toBeNull();
    expect(openPendingInstall(sealRaw('no es json'))).toBeNull();
    expect(openPendingInstall(sealRaw(JSON.stringify({ shop: 'acme.myshopify.com' })))).toBeNull();
    expect(openPendingInstall(sealRaw(JSON.stringify({ shop: 'acme.myshopify.com', token: '', iat: 1 })))).toBeNull();
  });

  it('rechaza un dominio que no sea *.myshopify.com aunque el cifrado sea válido', () => {
    const now = 1_800_000_000_000;
    const malo = sealRaw(JSON.stringify({ shop: 'evil.com', token: 'x', iat: Math.floor(now / 1000) }));
    expect(openPendingInstall(malo, now)).toBeNull();
  });

  it('separación de dominio: un shopifyToken cifrado con la misma primitiva NO abre como cookie pendiente', () => {
    // Exactamente lo que hay en Tenant.shopifyToken: encrypt(token), misma
    // clave, mismo AES-GCM. Descifra perfecto y aun así no es una cookie.
    expect(openPendingInstall(encrypt('shpat_de_la_base'))).toBeNull();

    // Peor todavía: un payload con la forma EXACTA de la cookie pero cifrado
    // sin el prefijo. Si esto abriera, cualquier ciphertext nuestro que
    // casualmente fuera un JSON válido serviría de cookie.
    const now = 1_800_000_000_000;
    const sinPrefijo = encrypt(JSON.stringify({ shop: 'acme.myshopify.com', token: 'x', iat: Math.floor(now / 1000) }));
    expect(openPendingInstall(sinPrefijo, now)).toBeNull();

    // Y el texto plano sellado empieza por el prefijo (es lo que se exige).
    expect(PENDING_INSTALL_PREFIX).toBe('pending-install:v1:');
    expect(openPendingInstall(sealRaw(JSON.stringify({ shop: 'acme.myshopify.com', token: 'x', iat: Math.floor(now / 1000) })), now)?.token).toBe('x');
  });

  it('una cookie editada a mano no descifra (GCM autentica)', () => {
    const sealed = sealPendingInstall(input);
    const [iv, tag, ct] = sealed.split(':');
    const flipped = (parseInt(ct[0], 16) ^ 1).toString(16) + ct.slice(1);
    expect(openPendingInstall(`${iv}:${tag}:${flipped}`)).toBeNull();
  });
});
