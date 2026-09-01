import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyShopifyWebhook } from '@/lib/shopify-webhook';
import { normalizeShopDomain } from '@/lib/shopify-oauth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/shopify/uninstalled — topic `app/uninstalled`.
 *
 * Cuando el comerciante desinstala la app, Shopify invalida el token al
 * instante. Si no lo limpiamos:
 *   - el worker sigue intentando y acumula fallos contra una tienda muerta,
 *   - el cron sigue encolando trabajos que nunca van a servir para nada, y
 *   - queda un token inservible cifrado en la base sin razón.
 *
 * Se limpia el token pero NO se borra el tenant ni su historial: las etiquetas
 * ya emitidas y el saldo son del cliente, y puede volver a instalar mañana.
 *
 * HMAC primero, DB después — mismo criterio que el webhook principal (C-2):
 * sin verificar, un atacante podría desconectar tiendas ajenas enumerando
 * dominios.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const hmac = req.headers.get('x-shopify-hmac-sha256');

  if (!verifyShopifyWebhook(raw, hmac)) {
    // 401 y nada más: no confirmamos ni desmentimos que la tienda exista.
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  // El dominio se toma del CUERPO YA VERIFICADO, no del header.
  //
  // El HMAC de Shopify firma únicamente el cuerpo crudo (`lib/shopify-webhook.ts`).
  // El header `x-shopify-shop-domain` queda FUERA de la firma, así que confiar en
  // él para decidir a quién desconectar deja la puerta abierta a reenviar un
  // cuerpo válido cambiando el header y desconectar tiendas ajenas.
  let shopFromBody: string | null = null;
  try {
    const body = JSON.parse(raw) as { myshopify_domain?: string; domain?: string };
    shopFromBody = normalizeShopDomain(body.myshopify_domain ?? body.domain ?? null);
  } catch {
    return NextResponse.json({ ok: true });
  }
  if (!shopFromBody) return NextResponse.json({ ok: true });

  // El header sólo sirve para contrastar. Si no coincide, algo está mal.
  const shopFromHeader = normalizeShopDomain(req.headers.get('x-shopify-shop-domain'));
  if (shopFromHeader && shopFromHeader !== shopFromBody) {
    return NextResponse.json({ error: 'domain mismatch' }, { status: 401 });
  }

  // Se limpia SÓLO el token.
  //
  // 🔴 NO tocar `isActive`: no es un flag de "conectado a Shopify", es el flag de
  // FACTURACIÓN que lee el scheduler del worker (`jobs/scheduler.ts`) y
  // `checkRunGate`. Apagarlo acá le cortaba el despacho al cliente por TODAS sus
  // fuentes —VentaFlow, reparto propio, Correo— y nada lo volvía a prender:
  // ni reconectar por OAuth ni comprar otro pack. Peor en multi-tienda, donde el
  // saldo vive en el tenant más viejo: desinstalar en una tienda apagaba todas.
  // Lo encontró la revisión adversarial del 2026-09-01.
  //
  // Insensible a mayúsculas (D18): una fila guardada por el camino manual
  // como `MiTienda.myshopify.com` no se encontraba con el dominio en
  // minúsculas que manda Shopify, y el token quedaba vivo después de la
  // desinstalación. Hasta que se aplique el UPDATE … lower() de la migración,
  // esta es la única forma de que la limpieza le pegue a esas filas.
  await db.tenant.updateMany({
    where: { shopifyStoreUrl: { equals: shopFromBody, mode: 'insensitive' } },
    data: { shopifyToken: null },
  });

  return NextResponse.json({ ok: true });
}
