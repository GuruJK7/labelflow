import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  normalizeShopDomain,
  buildAuthorizeUrl,
  verifyOAuthHmac,
  missingScopes,
  statesMatch,
  generateState,
  callbackUrl,
  REQUIRED_SCOPES,
  SCOPES_PARAM,
} from '../shopify-oauth';

const SECRET = 'client-secret-del-partner-dashboard';

/** Firma un query string como lo hace Shopify en el callback de OAuth. */
function signQuery(params: Record<string, string>, secret = SECRET): string {
  const msg = Object.keys(params)
    .filter((k) => k !== 'hmac' && k !== 'signature')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHmac('sha256', secret).update(msg, 'utf8').digest('hex');
}

describe('normalizeShopDomain — la defensa principal del flujo', () => {
  it('acepta las formas legítimas y las normaliza a una sola', () => {
    const esperado = 'acme.myshopify.com';
    expect(normalizeShopDomain('acme.myshopify.com')).toBe(esperado);
    expect(normalizeShopDomain('acme')).toBe(esperado);
    expect(normalizeShopDomain('ACME.MyShopify.COM')).toBe(esperado);
    expect(normalizeShopDomain('  acme.myshopify.com  ')).toBe(esperado);
    expect(normalizeShopDomain('https://acme.myshopify.com')).toBe(esperado);
    expect(normalizeShopDomain('https://acme.myshopify.com/admin/products')).toBe(esperado);
    expect(normalizeShopDomain('acme.myshopify.com/admin')).toBe(esperado);
    expect(normalizeShopDomain('acme.myshopify.com?foo=1')).toBe(esperado);
  });

  it('acepta guiones y dígitos en el handle', () => {
    expect(normalizeShopDomain('mi-tienda-2026.myshopify.com')).toBe('mi-tienda-2026.myshopify.com');
    expect(normalizeShopDomain('a1.myshopify.com')).toBe('a1.myshopify.com');
  });

  it('RECHAZA todo lo que abriría un open redirect o un SSRF', () => {
    // Si alguno de estos pasara, redirigimos al usuario al sitio del atacante
    // y le posteamos el code (y por lo tanto la sesión de la tienda) a su host.
    const ataques = [
      'evil.com',
      'acme.myshopify.com.evil.com',
      'evil.com/acme.myshopify.com',
      'https://evil.com',
      'https://acme.myshopify.com.evil.com',
      'acme.myshopify.com@evil.com',
      'https://user:pass@acme.myshopify.com',
      'acme.myshopify.com:8080',
      'sub.acme.myshopify.com',
      'acme.myshopify.com.',
      '.myshopify.com',
      '-acme.myshopify.com',
      'acme-.myshopify.com',
      'acme.shopify.com',
      'acme.myshopify.co',
      'javascript:alert(1)',
      'http://localhost/acme.myshopify.com',
      '//evil.com',
      '',
      '   ',
    ];
    for (const a of ataques) {
      expect(normalizeShopDomain(a), `deberia rechazar: ${JSON.stringify(a)}`).toBeNull();
    }
  });

  it('rechaza null, undefined y no-strings vacíos', () => {
    expect(normalizeShopDomain(null)).toBeNull();
    expect(normalizeShopDomain(undefined)).toBeNull();
  });

  it('rechaza dominios absurdamente largos', () => {
    expect(normalizeShopDomain('a'.repeat(120) + '.myshopify.com')).toBeNull();
  });
});

describe('buildAuthorizeUrl', () => {
  const base = {
    shop: 'acme.myshopify.com',
    clientId: 'abc123',
    redirectUri: 'https://autoenvia.com/api/shopify/callback',
    state: 'nonce123',
  };

  it('arma la URL contra el dominio de la tienda, no contra el nuestro', () => {
    const u = new URL(buildAuthorizeUrl(base));
    expect(u.origin).toBe('https://acme.myshopify.com');
    expect(u.pathname).toBe('/admin/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('abc123');
    expect(u.searchParams.get('state')).toBe('nonce123');
    expect(u.searchParams.get('redirect_uri')).toBe(base.redirectUri);
  });

  it('pide token OFFLINE por default — el worker despacha sin nadie logueado', () => {
    const u = new URL(buildAuthorizeUrl(base));
    expect(u.searchParams.get('grant_options[]')).toBeNull();
    const online = new URL(buildAuthorizeUrl({ ...base, online: true }));
    expect(online.searchParams.get('grant_options[]')).toBe('per-user');
  });

  it('pide exactamente los diez scopes que necesita el worker', () => {
    const u = new URL(buildAuthorizeUrl(base));
    const pedidos = (u.searchParams.get('scope') ?? '').split(',');
    expect(pedidos.sort()).toEqual([...REQUIRED_SCOPES].sort());
    expect(pedidos).toHaveLength(10);
  });

  it('normaliza el shop antes de construir la URL', () => {
    const u = new URL(buildAuthorizeUrl({ ...base, shop: 'ACME' }));
    expect(u.origin).toBe('https://acme.myshopify.com');
  });

  it('se planta con entradas inválidas en vez de generar una URL peligrosa', () => {
    expect(() => buildAuthorizeUrl({ ...base, shop: 'evil.com' })).toThrow(/inválido/);
    expect(() => buildAuthorizeUrl({ ...base, clientId: '' })).toThrow(/clientId/);
    expect(() => buildAuthorizeUrl({ ...base, state: '' })).toThrow(/state/);
    expect(() => buildAuthorizeUrl({ ...base, redirectUri: 'http://autoenvia.com/cb' })).toThrow(/https/);
    expect(() => buildAuthorizeUrl({ ...base, redirectUri: 'no-es-url' })).toThrow(/inválida/);
  });

  it('permite http SOLO en localhost, para desarrollo', () => {
    expect(() =>
      buildAuthorizeUrl({ ...base, redirectUri: 'http://localhost:3000/api/shopify/callback' }),
    ).not.toThrow();
  });
});

describe('verifyOAuthHmac — el HMAC del callback (query en hex, no el del body en base64)', () => {
  const params = {
    code: 'authcode123',
    host: 'YWNtZS5teXNob3BpZnkuY29t',
    shop: 'acme.myshopify.com',
    state: 'nonce123',
    timestamp: '1788285000',
  };

  it('acepta una firma válida', () => {
    const q = { ...params, hmac: signQuery(params) };
    expect(verifyOAuthHmac(q, SECRET)).toBe(true);
  });

  it('funciona igual con URLSearchParams', () => {
    const sp = new URLSearchParams({ ...params, hmac: signQuery(params) });
    expect(verifyOAuthHmac(sp, SECRET)).toBe(true);
  });

  it('el orden de los parámetros no importa — se ordenan antes de firmar', () => {
    const hmac = signQuery(params);
    const desordenado = new URLSearchParams();
    desordenado.set('timestamp', params.timestamp);
    desordenado.set('shop', params.shop);
    desordenado.set('hmac', hmac);
    desordenado.set('code', params.code);
    desordenado.set('state', params.state);
    desordenado.set('host', params.host);
    expect(verifyOAuthHmac(desordenado, SECRET)).toBe(true);
  });

  it('rechaza si alguien toca un solo parámetro', () => {
    const hmac = signQuery(params);
    expect(verifyOAuthHmac({ ...params, shop: 'otra.myshopify.com', hmac }, SECRET)).toBe(false);
    expect(verifyOAuthHmac({ ...params, code: 'otro', hmac }, SECRET)).toBe(false);
    expect(verifyOAuthHmac({ ...params, hmac: hmac.slice(0, -1) + '0' }, SECRET)).toBe(false);
  });

  it('rechaza si falta el hmac', () => {
    expect(verifyOAuthHmac(params, SECRET)).toBe(false);
  });

  it('rechaza una firma hecha con otro secreto', () => {
    const hmac = signQuery(params, 'secreto-del-atacante');
    expect(verifyOAuthHmac({ ...params, hmac }, SECRET)).toBe(false);
  });

  it('FAIL-CLOSED sin secreto configurado', () => {
    const hmac = signQuery(params);
    expect(verifyOAuthHmac({ ...params, hmac }, undefined)).toBe(false);
    expect(verifyOAuthHmac({ ...params, hmac }, '')).toBe(false);
  });

  it('ignora `signature` legacy en el cálculo', () => {
    const hmac = signQuery(params);
    expect(verifyOAuthHmac({ ...params, signature: 'basura-legacy', hmac }, SECRET)).toBe(true);
  });

  it('no explota con un hmac de largo distinto', () => {
    expect(verifyOAuthHmac({ ...params, hmac: 'corto' }, SECRET)).toBe(false);
  });
});

describe('state anti-CSRF', () => {
  it('genera nonces largos y distintos', () => {
    const a = generateState();
    const b = generateState();
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('compara sin filtrar por timing y rechaza faltantes', () => {
    const s = generateState();
    expect(statesMatch(s, s)).toBe(true);
    expect(statesMatch(s, generateState())).toBe(false);
    expect(statesMatch(s, null)).toBe(false);
    expect(statesMatch(null, s)).toBe(false);
    expect(statesMatch('', '')).toBe(false);
    expect(statesMatch(s, s.slice(0, -2))).toBe(false);
  });
});

describe('missingScopes', () => {
  it('no falta nada cuando Shopify concede todo', () => {
    expect(missingScopes(SCOPES_PARAM)).toEqual([]);
    expect(missingScopes([...REQUIRED_SCOPES])).toEqual([]);
  });

  it('detecta el que falta aunque el orden cambie y sobren scopes', () => {
    const concedidos = [...REQUIRED_SCOPES].reverse().filter((s) => s !== 'write_products');
    expect(missingScopes([...concedidos, 'read_themes'])).toEqual(['write_products']);
  });

  it('tolera espacios y valores vacíos', () => {
    expect(missingScopes(' read_orders , write_orders ')).not.toContain('read_orders');
  });

  it('con nada concedido, faltan los diez', () => {
    expect(missingScopes(null)).toHaveLength(10);
    expect(missingScopes('')).toHaveLength(10);
  });
});

describe('callbackUrl', () => {
  it('arma la URL que hay que declarar en el Partner Dashboard', () => {
    expect(callbackUrl('https://autoenvia.com')).toBe('https://autoenvia.com/api/shopify/callback');
    expect(callbackUrl('https://autoenvia.com/')).toBe('https://autoenvia.com/api/shopify/callback');
  });
});
