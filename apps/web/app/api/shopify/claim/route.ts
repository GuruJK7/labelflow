import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/api-utils';
import { db } from '@/lib/db';
import { encrypt } from '@/lib/encryption';
import { PENDING_INSTALL_COOKIE, PENDING_INSTALL_PATH } from '@/lib/shopify-oauth';
import { openPendingInstall } from '@/lib/shopify-pending-install';
import { fetchShopInfo, tenantSlugForShop } from '@/lib/shopify-provision';
import { registerShopifyWebhooks } from '@/lib/shopify-register-webhooks';
import { nuevoTenantBase } from '@/lib/tenant-provision';

export const dynamic = 'force-dynamic';

/**
 * GET /api/shopify/claim — el dueño de una cuenta reclama una instalación del
 * App Store que quedó pendiente (D11).
 *
 * CÓMO SE LLEGA ACÁ
 * -----------------
 * /callback (rama App Store) encontró que el email de contacto de la tienda ya
 * tiene cuenta. En vez de colgarle la tienda a esa cuenta sin preguntar, dejó
 * el token cifrado en la cookie `shopify_pending_install` (10 minutos, path
 * /api/shopify) y mandó al comerciante a /login?next=/api/shopify/claim. Al
 * loguearse, LoginForm lo trae acá.
 *
 * LO QUE SE EXIGE, EN ORDEN
 * -------------------------
 *   1. Sesión. Sin sesión se vuelve al login CON la cookie intacta: es el único
 *      caso en que no se borra, porque borrarla haría imposible completar el
 *      flujo (el login vuelve acá).
 *   2. Cookie presente, que descifre, con forma válida y con menos de 10 min.
 *   3. Dentro de UNA transacción: la tienda sigue sin dueño → se crea el tenant
 *      'shop-<handle>' bajo el usuario de la SESIÓN (no el del email de la
 *      tienda: la sesión es la identidad verificada, el email no).
 *   4. Webhooks (best-effort) y a /settings.
 *
 * La cookie se borra SIEMPRE al terminar, con éxito o con error: un token que
 * ya se usó, o que no se va a usar, no tiene por qué seguir viajando.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;

  const borrarPendiente = (r: NextResponse) => {
    r.cookies.delete({ name: PENDING_INSTALL_COOKIE, path: PENDING_INSTALL_PATH });
    return r;
  };
  const fail = (motivo: string) =>
    borrarPendiente(NextResponse.redirect(new URL(`/settings?shopify=${motivo}`, origin)));

  // 1. Sesión.
  const user = await getAuthenticatedUser();
  if (!user) {
    const destino = new URL('/login', origin);
    destino.searchParams.set('shopify', 'claim');
    destino.searchParams.set('next', '/api/shopify/claim');
    return NextResponse.redirect(destino);
  }

  // 2. Cookie.
  const raw = req.cookies.get(PENDING_INSTALL_COOKIE)?.value;
  if (!raw) return fail('claim_expired');
  const pendiente = openPendingInstall(raw);
  if (!pendiente) return fail('claim_invalid');

  const { shop, token } = pendiente;
  const slug = tenantSlugForShop(shop);

  // Nombre real de la tienda si Shopify contesta; si no, el handle. No vale
  // la pena frenar un reclamo por un nombre.
  const info = await fetchShopInfo(shop, token);
  const name = info?.name ?? shop.split('.')[0];

  // 3. Crear el tenant bajo el usuario de la sesión, si la tienda sigue libre.
  let resultado: { kind: 'created'; tenantId: string } | { kind: 'conflict' };
  try {
    resultado = await db.$transaction(async (tx) => {
      const tomada = await tx.tenant.findFirst({
        where: { shopifyStoreUrl: shop },
        select: { id: true },
      });
      if (tomada) return { kind: 'conflict' } as const;

      const base = await nuevoTenantBase(tx, slug);
      const tenant = await tx.tenant.create({
        data: {
          userId: user.userId,
          slug,
          name,
          shopifyStoreUrl: shop,
          shopifyToken: encrypt(token),
          apiKey: base.apiKey,
          referralCode: base.referralCode,
        },
        select: { id: true },
      });
      return { kind: 'created', tenantId: tenant.id } as const;
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return fail('already_linked');
    return fail('claim_failed');
  }
  if (resultado.kind === 'conflict') return fail('already_linked');

  // 4. Webhooks, best-effort (mismo criterio que /callback).
  let webhookWarning = '';
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? origin;
    const r = await registerShopifyWebhooks(shop, token, appUrl);
    if (r.failed.length > 0) webhookWarning = '&webhooks=partial';
  } catch {
    webhookWarning = '&webhooks=failed';
  }

  return borrarPendiente(
    NextResponse.redirect(new URL(`/settings?shopify=connected${webhookWarning}`, origin)),
  );
}
