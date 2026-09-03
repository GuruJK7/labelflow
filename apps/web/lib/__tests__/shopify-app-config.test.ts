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

  it('la redirect_url del toml es la que arma el código (sobre el ORIGEN de la App URL)', () => {
    const appUrl = tomlValue('application_url');
    expect(appUrl).toBeTruthy();
    // La App URL apunta a /api/shopify/entry (instalación desde el App Store);
    // el callback de OAuth vive en el mismo origen, no debajo de esa ruta.
    const origen = new URL(appUrl as string).origin;
    const esperada = callbackUrl(origen);
    expect(TOML).toContain(esperada);
  });

  it('la App URL es la entrada sin sesión del App Store', () => {
    const appUrl = tomlValue('application_url');
    expect(new URL(appUrl as string).pathname).toBe('/api/shopify/entry');
  });

  it('el toml no declara topics de negocio: esos se registran por tienda', () => {
    // Declarar `topics` en el toml (app-scoped) ADEMÁS de la mutación
    // (shop-scoped) entrega cada orders/paid dos veces, y
    // `webhookSubscriptions` no puede ver las app-scoped para deduplicar.
    // Fuente única de los de negocio: lib/shopify-register-webhooks.ts.
    //
    // 🔴 Lo que sí va en el toml son los de CUMPLIMIENTO: Shopify los llama sin
    // que exista una tienda instalada, así que no hay dónde registrarlos por
    // tienda. Por eso el test ya no prohíbe `[[webhooks.subscriptions]]` — sólo
    // prohíbe que ese bloque traiga `topics`.
    const activo = TOML.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(activo).not.toMatch(/^\s*topics\s*=/m);
    expect(activo).toContain('compliance_topics');
  });

  it('los endpoints que registra la app por tienda existen de verdad', () => {
    // Las suscripciones ya no viven en el toml (ver el test anterior): la fuente
    // es lib/shopify-register-webhooks.ts, así que se verifica ESE módulo.
    const mod = fs.readFileSync(path.join(__dirname, '..', 'shopify-register-webhooks.ts'), 'utf8');
    expect(mod).toContain('/api/webhooks/shopify');
    expect(mod).toContain('/api/shopify/uninstalled');
    for (const f of ['api/webhooks/shopify/route.ts', 'api/shopify/uninstalled/route.ts']) {
      const p = path.join(__dirname, '..', '..', 'app', f);
      expect(fs.existsSync(p), `la app registra un webhook hacia un endpoint que no existe: ${f}`).toBe(true);
    }
  });

  it('declara los tres webhooks de cumplimiento en el formato VIGENTE', () => {
    // 🔴 `[webhooks.privacy_compliance]` con `customer_data_request_url` está
    // DEPRECADO. La CLI lo acepta sin error y NO registra nada: la app queda
    // sin webhooks de cumplimiento y la comprobación automática de Shopify
    // falla con «Error en el webhook», sin explicar por qué. Costó tres
    // despliegues encontrarlo (2026-09-03). El formato vigente es una
    // suscripción con `compliance_topics`.
    // Sin los comentarios: el toml EXPLICA el formato deprecado, así que una
    // aserción sobre el archivo crudo se dispara contra su propia
    // documentación. Lo que importa es lo que la CLI lee.
    const activo = TOML.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(activo).not.toContain('[webhooks.privacy_compliance]');
    expect(activo).not.toContain('customer_data_request_url');

    const bloque = activo.slice(activo.indexOf('compliance_topics'));
    for (const t of ['customers/data_request', 'customers/redact', 'shop/redact']) {
      expect(bloque, `falta el topic de cumplimiento ${t}`).toContain(t);
    }
    expect(TOML).toContain('/api/webhooks/shopify/gdpr');

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
