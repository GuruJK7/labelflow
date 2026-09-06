import { describe, it, expect } from 'vitest';
import { puedeConectarShopifyAMano } from '../shopify-manual';

/**
 * El requisito 2.3.1 del App Store prohíbe pedirle a un COMERCIANTE el dominio
 * `.myshopify.com` o un Admin API token durante la instalación. Apagar esa UI
 * dejó al dueño de AutoEnvía sin poder conectar ninguna tienda: el único camino
 * restante es el App Store, y la app todavía está en revisión.
 *
 * La salida es que dependa de QUIÉN mira. Estos tests fijan las dos mitades:
 * el admin lo ve, cualquier otro no.
 *
 * `NEXT_PUBLIC_ALLOW_MANUAL_SHOPIFY` se lee al importar el módulo, y en el
 * entorno de test no está seteada — o sea que estos casos corren con el flag
 * global APAGADO, que es exactamente la configuración de producción.
 */
describe('puedeConectarShopifyAMano', () => {
  it('un admin lo ve aunque el flag global esté apagado — el caso que estaba roto', () => {
    expect(puedeConectarShopifyAMano(true)).toBe(true);
  });

  it('un comerciante NO lo ve: es lo que exige el requisito 2.3.1', () => {
    expect(puedeConectarShopifyAMano(false)).toBe(false);
  });

  it('sin saber quién es, apagado (fail-closed)', () => {
    expect(puedeConectarShopifyAMano(undefined)).toBe(false);
  });

  it('sólo el booleano true habilita: nada de valores truthy sueltos', () => {
    // Si el flag llegara de un JSON mal tipado, un string no puede abrir la UI
    // que arriesga el rechazo de la app.
    expect(puedeConectarShopifyAMano('true' as unknown as boolean)).toBe(false);
    expect(puedeConectarShopifyAMano(1 as unknown as boolean)).toBe(false);
    expect(puedeConectarShopifyAMano(null as unknown as boolean)).toBe(false);
  });
});
