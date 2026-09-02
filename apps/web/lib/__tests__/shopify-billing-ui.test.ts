import { describe, it, expect, vi } from 'vitest';
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
