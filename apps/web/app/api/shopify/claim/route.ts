import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { getAuthenticatedUser } from '@/lib/api-utils';
import { db } from '@/lib/db';
import { encrypt } from '@/lib/encryption';
import { escapeHtml } from '@/lib/html-escape';
import { PENDING_INSTALL_COOKIE, PENDING_INSTALL_PATH } from '@/lib/shopify-oauth';
import { openPendingInstall } from '@/lib/shopify-pending-install';
import { fetchShopInfo, tenantSlugForShop } from '@/lib/shopify-provision';
import { registerShopifyWebhooks } from '@/lib/shopify-register-webhooks';
import { nuevoTenantBase } from '@/lib/tenant-provision';

export const dynamic = 'force-dynamic';

/**
 * /api/shopify/claim — el dueño de una cuenta reclama una instalación del
 * App Store que quedó pendiente (D11).
 *
 * CÓMO SE LLEGA ACÁ
 * -----------------
 * /callback (rama App Store) encontró que el email de contacto de la tienda ya
 * tiene cuenta. En vez de colgarle la tienda a esa cuenta sin preguntar, dejó
 * el token cifrado en la cookie `shopify_pending_install` (10 minutos, path
 * /api/shopify) y mandó al comerciante acá. Sin sesión, ESTA ruta lo manda a
 * /login?shopify=claim&next=/api/shopify/claim y LoginForm lo trae de vuelta.
 * (El middleware no toca /api/shopify/*: ni público ni protegido.)
 *
 * GET PREGUNTA, POST ESCRIBE (D19)
 * --------------------------------
 * El GET no vincula nada: muestra "¿Vincular <tienda> a la cuenta <email>?"
 * con un botón que hace POST acá mismo y un enlace para entrar con otra
 * cuenta. Antes el GET escribía directo, y eso ataba el token de la tienda a
 * la sesión que hubiera en el navegador: en una máquina compartida (agencia
 * que "ayuda a instalar", empleado, dueño anterior) la tienda quedaba bajo
 * la cuenta equivocada sin que nadie lo viera. Poner el email adelante y
 * pedir un clic cierra eso sin exigir re-autenticación.
 *
 * POR QUÉ EL POST NO NECESITA TOKEN ANTI-CSRF PROPIO: la cookie pendiente es
 * sameSite=lax con path /api/shopify. Un navegador NO adjunta una cookie lax
 * a un POST iniciado desde otro sitio (lax sólo la manda en navegaciones
 * top-level con método seguro), así que un formulario ajeno que apunte acá
 * llega sin cookie y termina en claim_expired sin tocar la base. La cookie de
 * sesión de NextAuth es lax también: ese mismo POST llega sin sesión. El
 * único POST que trae las dos cookies es el del formulario que servimos en
 * el GET, desde nuestro origen. Igual se chequea `Origin` cuando viene (paso
 * 0 abajo): cuesta una línea y no depende de que ningún navegador respete
 * `lax` bien.
 *
 * LO QUE EXIGE EL POST, EN ORDEN
 * ------------------------------
 *   0. Si el navegador manda `Origin`, que sea el nuestro. Es la segunda
 *      cerradura contra CSRF (la primera es la cookie lax, arriba) y va antes
 *      de leer sesión o cookie: si el formulario salió de otro sitio no hay
 *      nada que mirar. Sin header se sigue: clientes viejos y algunos modos
 *      privados no lo mandan, y la cookie lax sola ya alcanza.
 *   1. Sesión. Sin sesión se vuelve al login CON la cookie intacta: es el único
 *      caso en que no se borra, porque borrarla haría imposible completar el
 *      flujo (el login vuelve acá).
 *   2. Cookie presente, que descifre, con forma válida y con menos de 10 min.
 *   2b. Que el formulario nombre la MISMA tienda que la cookie: el GET puso en
 *      un `<input type="hidden" name="shop">` exactamente lo que mostró. Ata
 *      el clic a lo que la persona leyó: si la cookie cambió entre el GET y el
 *      POST (otra instalación en otra pestaña dentro de los 10 minutos), el
 *      POST no vincula una tienda que nadie confirmó.
 *   3. Dentro de UNA transacción: la tienda sigue sin dueño → se crea el tenant
 *      'shop-<handle>' bajo el usuario de la SESIÓN (no el del email de la
 *      tienda: la sesión es la identidad verificada, el email no). Si la tienda
 *      ya es de un tenant de ESTE usuario → already_yours (no es un error: la
 *      conectó por otro camino dentro de los 10 minutos). De otro → already_linked.
 *   4. Webhooks (best-effort) y a /settings?shopify=connected&shop=<handle>.
 *      El handle va porque el tenant reclamado no queda activo (ver abajo).
 *
 * Todo redirect que sale del POST (login, claim_*, already_*, connected) va
 * con 303, no con el 307 por defecto: ver `RedirectStatus`.
 *
 * La cookie se borra SIEMPRE al terminar el POST, con éxito o con error: un
 * token que ya se usó, o que no se va a usar, no tiene por qué seguir viajando.
 * El GET también la borra cuando no sirve (vencida o ilegible): sin cookie
 * útil no hay nada que confirmar.
 */

const LOGIN_CLAIM_PATH = '/login?shopify=claim&next=/api/shopify/claim';

function borrarPendiente(r: NextResponse): NextResponse {
  r.cookies.delete({ name: PENDING_INSTALL_COOKIE, path: PENDING_INSTALL_PATH });
  return r;
}

/**
 * Estado de los redirects: el GET usa el 307 por defecto; el POST usa 303
 * (Post/Redirect/Get). 307 conserva el método, así que el navegador seguía
 * el redirect con OTRO POST a /settings, y un refresh en /settings volvía a
 * enviar el formulario. 303 lo convierte en GET.
 */
type RedirectStatus = 303 | 307;

function loginRedirect(origin: string, status: RedirectStatus): NextResponse {
  const destino = new URL('/login', origin);
  destino.searchParams.set('shopify', 'claim');
  destino.searchParams.set('next', '/api/shopify/claim');
  return NextResponse.redirect(destino, status);
}

/**
 * Sesión + cookie pendiente válida, o la respuesta que corresponde si falta
 * alguna de las dos. Compartido por GET y POST para que los dos exijan
 * exactamente lo mismo antes de mostrar o de escribir.
 */
async function abrirReclamo(
  req: NextRequest,
  status: RedirectStatus,
): Promise<
  | { ok: true; user: { userId: string }; shop: string; token: string }
  | { ok: false; res: NextResponse }
> {
  const origin = req.nextUrl.origin;
  const fail = (motivo: string) =>
    borrarPendiente(NextResponse.redirect(new URL(`/settings?shopify=${motivo}`, origin), status));

  // 1. Sesión.
  const user = await getAuthenticatedUser();
  if (!user) return { ok: false, res: loginRedirect(origin, status) };

  // 2. Cookie.
  const raw = req.cookies.get(PENDING_INSTALL_COOKIE)?.value;
  if (!raw) return { ok: false, res: fail('claim_expired') };
  const pendiente = openPendingInstall(raw);
  if (!pendiente) return { ok: false, res: fail('claim_invalid') };

  return { ok: true, user, shop: pendiente.shop, token: pendiente.token };
}

export async function GET(req: NextRequest) {
  const abierto = await abrirReclamo(req, 307);
  if (!abierto.ok) return abierto.res;

  const cuenta = await db.user.findUnique({
    where: { id: abierto.user.userId },
    select: { email: true },
  });

  return new NextResponse(confirmPage(abierto.shop, cuenta?.email ?? null), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const fail = (motivo: string) =>
    borrarPendiente(NextResponse.redirect(new URL(`/settings?shopify=${motivo}`, origin), 303));

  // 0. Origin, antes de tocar nada (ver cabecera).
  const from = req.headers.get('origin');
  if (from !== null && from !== origin) return fail('claim_invalid');

  const abierto = await abrirReclamo(req, 303);
  if (!abierto.ok) return abierto.res;
  const { user, shop, token } = abierto;

  // 2b. La tienda del formulario tiene que ser la de la cookie (ver cabecera).
  if ((await tiendaDelFormulario(req)) !== shop) return fail('claim_invalid');

  const handle = shop.split('.')[0];
  const slug = tenantSlugForShop(shop);

  // Nombre real de la tienda si Shopify contesta; si no, el handle. No vale
  // la pena frenar un reclamo por un nombre.
  const info = await fetchShopInfo(shop, token);
  const name = info?.name ?? handle;

  // 3. Crear el tenant bajo el usuario de la sesión, si la tienda sigue libre.
  //
  // La base NO tiene índice único sobre shopifyStoreUrl (está escrito en
  // prisma/migrations/…_tenant_shop_domain_unique, sin aplicar y pendiente
  // de una decisión: D22, main soporta a propósito que dos tenants compartan
  // tienda). La protección real contra dos reclamos a la vez es este
  // findFirst dentro de la transacción más el slug determinista
  // 'shop-<handle>', que sí es @unique: el segundo insert choca en el slug
  // con P2002.
  let resultado:
    | { kind: 'created'; tenantId: string }
    | { kind: 'conflict' }
    | { kind: 'already_yours' };
  try {
    resultado = await db.$transaction(async (tx) => {
      const tomada = await tx.tenant.findFirst({
        where: { shopifyStoreUrl: { equals: shop, mode: 'insensitive' } },
        select: { id: true, userId: true },
      });
      if (tomada) {
        return tomada.userId === user.userId
          ? ({ kind: 'already_yours' } as const)
          : ({ kind: 'conflict' } as const);
      }

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
          // El bonus de bienvenida es por USUARIO, no por tienda (mismo
          // criterio que POST /api/v1/tenants): el user de la sesión ya lo
          // recibió con su primer tenant. Sin esto, reclamar N tiendas
          // regalaría 10 envíos por cada una (default del schema).
          shipmentCredits: 0,
        },
        select: { id: true },
      });
      return { kind: 'created', tenantId: tenant.id } as const;
    });
  } catch (err) {
    const e = err as { name?: string; code?: string; message?: unknown };
    if (e.code === 'P2002') return fail('already_linked');
    // Sin esto un claim_failed es invisible en los logs. Va el mínimo para
    // diagnosticar; NUNCA el token ni la cookie. Un KnownRequestError de
    // Prisma (P-xxxx) nunca trae valores de fila en el message; cualquier
    // otro error (p.ej. PrismaClientValidationError, que vuelca los args del
    // create enteros) se recorta a su primera línea.
    console.error('[shopify/claim]', {
      shop,
      userId: user.userId,
      name: e.name,
      code: e.code,
      message: mensajeSeguro(err),
    });
    return fail('claim_failed');
  }
  if (resultado.kind === 'conflict') return fail('already_linked');
  if (resultado.kind === 'already_yours') {
    const destino = new URL('/settings?shopify=already_yours', origin);
    destino.searchParams.set('shop', handle);
    return borrarPendiente(NextResponse.redirect(destino, 303));
  }

  // 4. Webhooks, best-effort (mismo criterio que /callback).
  let webhookWarning = '';
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? origin;
    const r = await registerShopifyWebhooks(shop, token, appUrl);
    if (r.failed.length > 0) webhookWarning = '&webhooks=partial';
  } catch {
    webhookWarning = '&webhooks=failed';
  }

  // El tenant reclamado NO queda activo: el tenant activo vive en el JWT y
  // sólo cambia desde el TenantSwitcher (POST /tenants/switch + update de
  // sesión, client-side). Un redirect no puede hacer eso. Así que /settings
  // se abre sobre el tenant anterior y el banner tiene que decir de qué
  // tienda habla: va el handle en la query y Settings lo valida antes de
  // mostrarlo.
  const destino = new URL(`/settings?shopify=connected${webhookWarning}`, origin);
  destino.searchParams.set('shop', handle);
  return borrarPendiente(NextResponse.redirect(destino, 303));
}

/** El `shop` del formulario, o null si no hay cuerpo, no es un form, o no trae `shop`. */
async function tiendaDelFormulario(req: NextRequest): Promise<string | null> {
  try {
    const v = (await req.formData()).get('shop');
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function mensajeSeguro(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.message;
  const msg = String((err as { message?: unknown })?.message ?? '');
  return msg.split('\n')[0].slice(0, 200);
}

/**
 * Página de confirmación. Server-rendered, sin JS, estilos inline: es una
 * sola pregunta y un botón, y tiene que servirse desde un route handler que
 * no participa del layout de la app. Todo lo que viene de datos pasa por
 * escapeHtml: el dominio ya fue validado por normalizeShopDomain, el email
 * es lo que haya en la tabla User. El hidden `shop` lleva la misma tienda que
 * el título: el POST exige que coincida con la cookie (2b en la cabecera).
 */
function confirmPage(shop: string, email: string | null): string {
  const tienda = escapeHtml(shop);
  const cuenta = email ? `<strong>${escapeHtml(email)}</strong>` : 'tu cuenta';
  const salir = `/api/auth/signout?callbackUrl=${encodeURIComponent(LOGIN_CLAIM_PATH)}`;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Vincular tienda · AutoEnvía</title>
<style>
  html,body{margin:0;background:#050505;color:#e5e7eb;font:15px/1.5 "Space Grotesk",system-ui,-apple-system,sans-serif}
  main{max-width:440px;margin:12vh auto;padding:32px 28px;border:1px solid #1f2937;border-radius:12px;background:#0b0d10}
  h1{font-size:18px;font-weight:600;margin:0 0 12px}
  p{margin:0 0 20px;color:#9ca3af}
  code{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;color:#22d3ee}
  strong{color:#e5e7eb;font-weight:600}
  button{width:100%;padding:11px 16px;border:0;border-radius:8px;background:#22d3ee;color:#050505;font:inherit;font-weight:600;cursor:pointer}
  button:hover{background:#67e8f9}
  a{display:block;margin-top:14px;text-align:center;color:#9ca3af;font-size:13px}
  a:hover{color:#22d3ee}
</style>
</head>
<body>
<main>
  <h1>¿Vincular <code>${tienda}</code> a la cuenta ${cuenta}?</h1>
  <p>La tienda queda como tienda nueva dentro de esta cuenta. Si no es la tuya, entrá con la correcta antes de vincular.</p>
  <form method="post" action="/api/shopify/claim">
    <input type="hidden" name="shop" value="${tienda}">
    <button type="submit">Vincular</button>
  </form>
  <a href="${salir}">Entrar con otra cuenta</a>
</main>
</body>
</html>
`;
}
