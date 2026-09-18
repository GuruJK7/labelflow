/**
 * 🔴 POR QUÉ ESTE TEST. El barrido de compras abandonadas de `reconcile.job.ts`
 * marcaba FAILED toda `CreditPurchase` PENDING de más de 24 h, sin mirar el
 * riel. El cargo de Shopify vive DOS DÍAS. En la ventana de la hora 24 a la 48
 * el comerciante todavía podía aprobar: Shopify le cobraba de verdad y
 * `settlePaidPurchase` no le acreditaba un solo envío, porque su `updateMany`
 * exige `status: 'PENDING'` y la fila ya estaba en FAILED.
 *
 * El primer test de este archivo es el que falla si se neutraliza el arreglo:
 * poné `shopify: 24 * 60 * 60 * 1000` en `VENTANA_POR_RIEL_MS` y la compra de
 * Shopify a las 30 h vuelve a darse por abandonada.
 */
import { describe, it, expect } from 'vitest';
import {
  esCompraAbandonada,
  rielDeCompra,
  VENTANA_POR_RIEL_MS,
  VENTANA_MINIMA_MS,
} from '../jobs/stale-purchase';

const AHORA = new Date('2026-09-18T12:00:00.000Z');
const HORA_MS = 60 * 60 * 1000;

/** Una compra creada hace `horas`, del riel que diga el prefijo. */
function compra(prefijo: string, horas: number) {
  return {
    mpExternalRef: `${prefijo}|abc123`,
    createdAt: new Date(AHORA.getTime() - horas * HORA_MS),
  };
}

describe('ventana de abandono por riel', () => {
  it('🔴 PERDONA la compra de Shopify de 30 h: el cargo todavía se puede aprobar y cobrar', () => {
    // El caso de pérdida de plata: a las 30 h el barrido viejo ya la había
    // matado, y Shopify aceptaba la aprobación hasta las 48 h.
    expect(esCompraAbandonada(compra('shopify', 30), AHORA)).toBe(false);
  });

  it('🔴 perdona a Shopify en el borde justo antes de las 48 h documentadas', () => {
    expect(esCompraAbandonada(compra('shopify', 47), AHORA)).toBe(false);
    expect(esCompraAbandonada(compra('shopify', 48), AHORA)).toBe(false); // + 1 h de gracia
  });

  it('sí barre la compra de Shopify cuando Shopify ya no la puede aprobar', () => {
    expect(esCompraAbandonada(compra('shopify', 49), AHORA)).toBe(true);
    expect(esCompraAbandonada(compra('shopify', 72), AHORA)).toBe(true);
  });

  it('NO cambia el comportamiento histórico de MercadoPago: 24 h y afuera', () => {
    expect(esCompraAbandonada(compra('pkg', 23), AHORA)).toBe(false);
    expect(esCompraAbandonada(compra('pkg', 24), AHORA)).toBe(true);
    expect(esCompraAbandonada(compra('pkg', 30), AHORA)).toBe(true);
  });

  it('NO cambia el comportamiento histórico de Whop: 24 h y afuera', () => {
    expect(esCompraAbandonada(compra('whop', 23), AHORA)).toBe(false);
    expect(esCompraAbandonada(compra('whop', 24), AHORA)).toBe(true);
  });

  it('una compra sin mpExternalRef cae en el camino histórico (MercadoPago, 24 h)', () => {
    expect(esCompraAbandonada({ mpExternalRef: null, createdAt: new Date(AHORA.getTime() - 25 * HORA_MS) }, AHORA)).toBe(true);
    expect(esCompraAbandonada({ mpExternalRef: null, createdAt: new Date(AHORA.getTime() - 23 * HORA_MS) }, AHORA)).toBe(false);
  });
});

describe('rielDeCompra', () => {
  it('lee el prefijo que escribe cada checkout', () => {
    // shopify-checkout/route.ts escribe `shopify|<uuid>` al crear la fila y
    // después `shopify|<purchaseId>`: las dos formas tienen que dar shopify.
    expect(rielDeCompra('shopify|0f0e7a2c-1111-2222-3333-444455556666')).toBe('shopify');
    expect(rielDeCompra('shopify|cmabc123')).toBe('shopify');
    expect(rielDeCompra('whop|cmabc123')).toBe('whop');
    expect(rielDeCompra('pkg|cmabc123')).toBe('mercadopago');
    expect(rielDeCompra(null)).toBe('mercadopago');
    expect(rielDeCompra(undefined)).toBe('mercadopago');
  });

  it('no se deja engañar por un id que apenas contenga la palabra', () => {
    // El prefijo es el ancla: un external ref que sólo mencione shopify
    // adentro no convierte la fila en un cargo de la Billing API.
    expect(rielDeCompra('pkg|pedido-de-shopify|9')).toBe('mercadopago');
  });
});

describe('VENTANA_MINIMA_MS (el pre-filtro de la query)', () => {
  it('es el corte más corto, para que la query no deje afuera a ningún candidato', () => {
    expect(VENTANA_MINIMA_MS).toBe(Math.min(...Object.values(VENTANA_POR_RIEL_MS)));
    // Si alguna vez alguien baja un riel por debajo de 24 h, esto lo sigue.
    for (const ventana of Object.values(VENTANA_POR_RIEL_MS)) {
      expect(ventana).toBeGreaterThanOrEqual(VENTANA_MINIMA_MS);
    }
  });

  it('la ventana de Shopify cubre los dos días que documenta shopify.dev', () => {
    // «EXPIRED — The app purchase was not accepted within two days of being created.»
    expect(VENTANA_POR_RIEL_MS.shopify).toBeGreaterThan(48 * HORA_MS);
  });
});
