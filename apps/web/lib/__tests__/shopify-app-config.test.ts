import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_SCOPES, callbackUrl } from '../shopify-oauth';

/**
 * El `shopify.app.toml` y el código tienen que decir lo mismo.
 *
 * Si se desincronizan, el modo de falla es de los peores: el comerciante
 * conecta bien, ve "Tienda conectada", y el despacho falla recién horas
 * después con un 403 de Shopify que no dice qué permiso falta.
 */

const TOML = fs.readFileSync(path.join(__dirname, '..', '..', 'shopify.app.toml'), 'utf8');

function tomlValue(key: string): string | null {
  const m = TOML.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

describe('shopify.app.toml — coherencia con el código', () => {
  it('declara exactamente los mismos scopes que pide el flujo OAuth', () => {
    const scopes = tomlValue('scopes');
    expect(scopes, 'falta la línea scopes = "..." en el toml').toBeTruthy();
    const enToml = (scopes as string).split(',').map((s) => s.trim()).filter(Boolean);
    expect(enToml.slice().sort()).toEqual([...REQUIRED_SCOPES].sort());
  });

  it('la redirect_url del toml es la que arma el código', () => {
    const appUrl = tomlValue('application_url');
    expect(appUrl).toBeTruthy();
    const esperada = callbackUrl(appUrl as string);
    expect(TOML).toContain(esperada);
  });

  it('suscribe los dos webhooks que el sistema necesita', () => {
    expect(TOML).toContain('"orders/paid"');
    expect(TOML).toContain('"app/uninstalled"');
  });

  it('apunta cada webhook al endpoint que existe de verdad', () => {
    expect(TOML).toContain('uri = "/api/webhooks/shopify"');
    expect(TOML).toContain('uri = "/api/shopify/uninstalled"');
    for (const f of ['api/webhooks/shopify/route.ts', 'api/shopify/uninstalled/route.ts']) {
      const p = path.join(__dirname, '..', '..', 'app', f);
      expect(fs.existsSync(p), `el toml apunta a un endpoint que no existe: ${f}`).toBe(true);
    }
  });

  it('declara los tres webhooks de privacidad, obligatorios para app pública', () => {
    for (const k of ['customer_data_request_url', 'customer_deletion_url', 'shop_deletion_url']) {
      expect(tomlValue(k), `falta ${k}`).toContain('/api/webhooks/shopify/gdpr');
    }
    const gdpr = path.join(__dirname, '..', '..', 'app', 'api/webhooks/shopify/gdpr/route.ts');
    expect(fs.existsSync(gdpr)).toBe(true);
  });

  it('NO contiene el client secret — ese va sólo en variables de entorno', () => {
    expect(TOML).not.toMatch(/client_secret/i);
    // shpss_ es el prefijo de los secretos de app de Shopify.
    expect(TOML).not.toMatch(/shpss_/);
    expect(TOML).not.toMatch(/shpat_/);
  });
});
