import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REQUIRED_SCOPES, SCOPES_PARAM } from '../shopify-oauth';

/**
 * Requisito 3.2 del App Store: «Request only necessary access scopes».
 *
 * La app pedía `read_fulfillments` y `write_fulfillments` con el comentario
 * "marcar el pedido como enviado". Era falso. Verificado el 2026-09-16 contra
 * la doc 2026-07 de Shopify:
 *
 *   - `usage/access-scopes` mapea read_fulfillments / write_fulfillments a UN
 *     recurso: `FulfillmentService`.
 *   - `build-for-fulfillment-services`: «To register a fulfillment service,
 *     your app requires the write_fulfillments access scope». AutoEnvía no
 *     registra ninguno — grep de fulfillmentService/fulfillment_service en
 *     apps/ da cero.
 *   - `mutations/fulfillmentCreate`: «Requires write_assigned_fulfillment_orders,
 *     write_merchant_managed_fulfillment_orders or
 *     write_third_party_fulfillment_orders». No menciona write_fulfillments.
 *   - `queries/fulfillment`: pide read_orders o los read_*_fulfillment_orders.
 *   - `admin-rest/resources/fulfillment` (el `POST /fulfillments.json` con
 *     `line_items_by_fulfillment_order` que corre el worker en modo REST): los
 *     GET piden `orders`; ni read_fulfillments ni write_fulfillments aparecen.
 *   - La guía de apps de gestión de pedidos —que es lo que AutoEnvía es— lista
 *     sólo `merchant_managed_fulfillment_orders` y
 *     `third_party_fulfillment_orders`.
 *
 * Efecto de pedirlos: el comerciante veía «Administrar servicios de
 * cumplimiento» en la pantalla de OAuth por un permiso que la app nunca
 * ejerce.
 *
 * Este archivo existe porque el defecto no era una línea: la lista estaba
 * copiada a mano en CINCO lugares y el conteo ("10 alcances") en catorce
 * cadenas. Arreglar una sola deja el arreglo a medio círculo — la pantalla de
 * OAuth limpia pero el wizard de onboarding todavía dictándole al comerciante
 * los dos scopes de más.
 */

const WEB = path.join(__dirname, '..', '..');
const leer = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8');

/** Quita SÓLO las líneas de comentario, sin tocar strings con `//` adentro. */
function sinComentarios(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

/** Los `name: '...'` del array REQUIRED_SCOPES local de un componente. */
function scopesDeclaradosEn(rel: string): string[] {
  const src = leer(rel);
  const i = src.indexOf('const REQUIRED_SCOPES');
  expect(i, `${rel} ya no declara REQUIRED_SCOPES`).toBeGreaterThan(-1);
  // Uno cierra con `];` y el otro con `] as const;`.
  const cierre = src.slice(i).match(/\n\](?: as const)?;/);
  expect(cierre, `${rel}: no encuentro el cierre del array`).toBeTruthy();
  const fin = i + (cierre as RegExpMatchArray).index!;
  const bloque = src.slice(i, fin);
  return [...bloque.matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1]);
}

/** Scopes que Shopify asocia a FulfillmentService, no a fulfillment orders. */
const SOLO_FULFILLMENT_SERVICE = ['read_fulfillments', 'write_fulfillments'];

describe('3.2 — la app no pide scopes que no ejerce', () => {
  it('REQUIRED_SCOPES no trae los scopes de FulfillmentService', () => {
    for (const s of SOLO_FULFILLMENT_SERVICE) {
      expect(
        REQUIRED_SCOPES as readonly string[],
        `${s} mapea a FulfillmentService y la app no registra ninguno (requisito 3.2)`,
      ).not.toContain(s);
    }
    // Y sí conserva los que hacen el trabajo de verdad.
    for (const s of [
      'read_orders',
      'write_orders',
      'read_products',
      'write_assigned_fulfillment_orders',
      'write_merchant_managed_fulfillment_orders',
    ]) {
      expect(REQUIRED_SCOPES as readonly string[]).toContain(s);
    }
  });

  it('la pantalla de OAuth no ofrece «servicios de cumplimiento»', () => {
    for (const s of SOLO_FULFILLMENT_SERVICE) {
      expect(SCOPES_PARAM.split(',')).not.toContain(s);
    }
  });

  it('el shopify.app.toml tampoco los declara', () => {
    const toml = leer('shopify.app.toml');
    const linea = toml.match(/^\s*scopes\s*=\s*"([^"]*)"/m);
    expect(linea, 'falta la línea scopes en el toml').toBeTruthy();
    const enToml = (linea as RegExpMatchArray)[1].split(',').map((s) => s.trim());
    for (const s of SOLO_FULFILLMENT_SERVICE) {
      expect(enToml).not.toContain(s);
    }
    expect(enToml.slice().sort()).toEqual([...REQUIRED_SCOPES].sort());
  });
});

describe('3.2 — una sola fuente de verdad para la lista', () => {
  it('el banner del dashboard mira la lista canónica, no una copia a mano', () => {
    // Si `required` se vuelve a escribir a mano, el banner puede reclamar un
    // permiso que la app ya no pide (el caso que motivó esto) o callarse uno
    // que sí falta. Las dos fallas son mudas.
    const route = sinComentarios(leer('app/api/v1/shopify-scopes/route.ts'));
    expect(route).toContain("from '@/lib/shopify-oauth'");
    expect(route).toContain('REQUIRED_SCOPES');
    for (const s of SOLO_FULFILLMENT_SERVICE) {
      expect(route, `la ruta todavía nombra ${s}`).not.toContain(s);
    }
  });

  it.each([
    ['app/tutorial/shopify-token/page.tsx'],
    ['app/onboarding/_components/ShopifyTutorial.tsx'],
  ])('%s le dicta al comerciante exactamente los scopes canónicos', (rel) => {
    // Los dos tienen un botón "Copiar (CSV)": lo que listan es literalmente lo
    // que el comerciante pega en el campo "Alcances" del Dev Dashboard. Si acá
    // sobran los dos de FulfillmentService, la app sigue pidiéndolos aunque el
    // toml esté limpio.
    expect(scopesDeclaradosEn(rel)).toEqual([...REQUIRED_SCOPES]);
  });
});

describe('3.2 — el conteo de alcances se deriva, no se escribe', () => {
  it.each([
    ['app/tutorial/shopify-token/page.tsx'],
    ['app/onboarding/_components/ShopifyTutorial.tsx'],
    ['app/api/v1/onboarding/test-shopify/route.ts'],
  ])('%s no tiene el número escrito a mano', (rel) => {
    // Cómo se rompió: la página decía "10 alcances" con NUEVE en el array.
    // Alguien sacó un scope y ninguna de las catorce cadenas se enteró. Con el
    // conteo derivado de REQUIRED_SCOPES.length eso no puede volver a pasar.
    const src = sinComentarios(leer(rel));
    expect(src, 'hay un conteo de alcances escrito a mano').not.toMatch(/\b\d+\s+alcances/);
    expect(src, 'hay un conteo escrito a mano en el verificador de scopes')
      .not.toMatch(/ALL\s+\d+\s+LABELFLOW/);
  });
});
