import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VolumeSelector } from '@/app/(dashboard)/settings/billing/_components/VolumeSelector';
import { WEBHOOK_TOPICS, webhookAddressFor, webhookTopicEnum } from '@/lib/shopify-register-webhooks';

/**
 * La regla de cumplimiento hecha pantalla.
 *
 * Requisito 1.2 del App Store: una app distribuida ahí no puede cobrar por
 * fuera de la Billing API. Traducido a la pantalla de compra: si la tienda
 * entró por la app de Shopify, el ÚNICO botón de pago es el de Shopify.
 * Dejar visible el de MercadoPago es literalmente lo que hace que la ficha se
 * rechace, así que esto es un test de cumplimiento, no de estilo.
 */
function render(shopifyBilling: boolean, whopPacks: string[] = ['pack_100', 'pack_250']) {
  return renderToStaticMarkup(
    createElement(VolumeSelector, {
      usdUyuRateMilli: 40_000,
      usdUyuRateLabel: '40',
      largePacks: false,
      whopPacks,
      loadingPackId: null,
      onPayMercadoPago: vi.fn(),
      onPayWhop: vi.fn(),
      shopifyBilling,
      onPayShopify: vi.fn(),
      currency: 'USD' as const,
      onCurrencyChange: vi.fn(),
    }),
  );
}

describe('pantalla de compra con cobro por Shopify', () => {
  it('🔴 no ofrece MercadoPago ni Whop', () => {
    const html = render(true);
    expect(html).not.toContain('MercadoPago');
    expect(html).not.toContain('Whop');
  });

  it('ofrece Shopify y dice dónde se cobra', () => {
    const html = render(true);
    expect(html).toContain('Pagar con Shopify');
    expect(html).toContain('factura de tu tienda de Shopify');
    expect(html).toContain('pago único');
  });

  it('sin Shopify, la pantalla de siempre no cambia', () => {
    const html = render(false);
    expect(html).toContain('Pagar con MercadoPago');
    expect(html).toContain('Pagar con Whop');
    expect(html).not.toContain('Pagar con Shopify');
  });

  it('el aviso del tipo de cambio sólo aparece donde se cobra en pesos', () => {
    // Con Shopify se cobra en dólares: hablar de UYU/USD ahí confunde.
    expect(render(true)).not.toContain('UYU/USD');
    expect(render(false)).toContain('UYU/USD');
  });
});

describe('registro del webhook de cobro', () => {
  it('el topic está en la lista que se registra al instalar', () => {
    expect(WEBHOOK_TOPICS).toContain('app_purchases_one_time/update');
  });

  it('el enum que espera Shopify sale bien de la conversión', () => {
    expect(webhookTopicEnum('app_purchases_one_time/update')).toBe('APP_PURCHASES_ONE_TIME_UPDATE');
  });

  it('cada topic va a su propia ruta', () => {
    const origen = 'https://autoenvia.com';
    expect(webhookAddressFor('app_purchases_one_time/update', origen)).toBe(
      'https://autoenvia.com/api/webhooks/shopify/app-purchases',
    );
    expect(webhookAddressFor('orders/paid', origen)).toBe('https://autoenvia.com/api/webhooks/shopify');
    expect(webhookAddressFor('app/uninstalled', origen)).toBe('https://autoenvia.com/api/shopify/uninstalled');
  });

  it('las tres rutas son distintas: ninguna se come los eventos de otra', () => {
    const origen = 'https://autoenvia.com';
    const rutas = WEBHOOK_TOPICS.map((t) => webhookAddressFor(t, origen));
    expect(new Set(rutas).size).toBe(WEBHOOK_TOPICS.length);
  });
});

/**
 * La pantalla de compra COMPLETA, no sólo los botones.
 *
 * 🔴 POR QUÉ ESTE TEST EXISTE. Al sacar las capturas para el App Store, la
 * pantalla de "Comprar envíos" seguía diciendo "MercadoPago los cobra en
 * pesos" en la bajada, en el aviso de pago pendiente y en el sello de "Pago
 * seguro" — aunque los botones ya fueran de Shopify. Una captura con la
 * palabra MercadoPago adentro es exactamente lo que un revisor marca como
 * cobro fuera de la Billing API (requisito 1.2). Los botones no alcanzan: lo
 * que se revisa es la pantalla.
 */
describe('la pantalla de compra no nombra otro cobrador', () => {
  const FUENTE = readFileSync(
    join(__dirname, '..', '..', 'app', '(dashboard)', 'settings', 'billing', 'page.tsx'),
    'utf8',
  );

  it('cada mención a MercadoPago está detrás de la bandera del riel', () => {
    // Se recorre línea por línea: toda línea que nombre MercadoPago en TEXTO
    // visible tiene que estar en una expresión que dependa de `shopifyBilling`.
    const sospechosas = FUENTE.split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /MercadoPago/.test(l))
      .filter(([, l]) => !/^\s*\*/.test(l)) // comentarios no se renderizan
      .filter(([, l]) => !/onPayMercadoPago/.test(l)) // el nombre del prop no se ve
      .filter(([, l]) => !/shopifyBilling/.test(l));
    // Lo que queda tiene que estar dentro de un ternario abierto en las líneas
    // previas; se acepta sólo si la línea anterior menciona la bandera.
    const lineas = FUENTE.split('\n');
    const huerfanas = sospechosas.filter(([n]) =>
      !lineas.slice(Math.max(0, n - 6), n - 1).some((l) => /shopifyBilling/.test(l)),
    );
    expect(huerfanas.map(([n, l]) => `${n}: ${l.trim()}`)).toEqual([]);
  });
});
