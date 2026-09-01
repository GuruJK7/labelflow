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

  const shop = normalizeShopDomain(req.headers.get('x-shopify-shop-domain'));
  if (!shop) return NextResponse.json({ ok: true });

  // updateMany: si no hay tenant con ese dominio, es un no-op silencioso.
  // Devolvemos 200 igual — a Shopify hay que contestarle rápido y OK, si no
  // reintenta y termina dando de baja la suscripción del webhook.
  await db.tenant.updateMany({
    where: { shopifyStoreUrl: shop },
    data: { shopifyToken: null, isActive: false },
  });

  return NextResponse.json({ ok: true });
}
