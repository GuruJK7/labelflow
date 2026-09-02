import { z } from 'zod';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { encrypt } from '@/lib/encryption';

/**
 * POST /api/v1/onboarding/test-dashboard
 *
 * Espejo de `test-shopify` para la fuente "AutoEnvía Dashboard" (pedidos
 * cargados desde un Excel). Prueba la URL + token con la MISMA llamada que
 * hace el worker (`GET {url}/api/v1/orders?status=confirmed&limit=1` con
 * `Authorization: Bearer`, apps/worker/src/dashboard/orders.ts) y, si
 * responde, guarda la fuente prendida con el token cifrado. Así el paso 2 del
 * wizard puede decir "conectado" con la misma certeza que con Shopify.
 *
 * La URL la escribe el usuario y este server la va a llamar: sólo https y
 * nunca localhost ni una IP literal, para que el endpoint no sirva de proxy
 * hacia adentro de la red de Vercel. El token viaja únicamente a esa URL y
 * jamás al log.
 */
const bodySchema = z.object({
  dashboardUrl: z
    .string()
    .trim()
    .url('URL inválida')
    .refine((u) => isPublicHttpsUrl(u), 'La URL tiene que ser https y pública (no localhost ni una IP)'),
  dashboardToken: z.string().min(8, 'El token es demasiado corto').max(512),
});

function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  // IPv4 literal o IPv6 (viene entre corchetes en `hostname` sin ellos).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.includes(':')) return false;
  return true;
}

export async function POST(request: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError('JSON inválido', 400);
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0]?.message ?? 'Datos inválidos', 400);
  }

  const dashboardUrl = parsed.data.dashboardUrl.replace(/\/+$/, '');
  const { dashboardToken } = parsed.data;

  let ordersSeen: number | null = null;
  try {
    const res = await fetch(`${dashboardUrl}/api/v1/orders?status=confirmed&limit=1`, {
      headers: { Authorization: `Bearer ${dashboardToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      return apiError('El dashboard rechazó el token. Copialo de nuevo desde la página de tu cliente.', 422);
    }
    if (!res.ok) {
      return apiError(`El dashboard respondió ${res.status}. Verificá la URL.`, 422);
    }
    try {
      const data = (await res.json()) as { orders?: unknown };
      ordersSeen = Array.isArray(data?.orders) ? data.orders.length : null;
    } catch {
      ordersSeen = null;
    }
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return apiError(
      isTimeout
        ? 'El dashboard tardó demasiado en responder. Probá de nuevo.'
        : 'No se pudo conectar al dashboard. Verificá la URL.',
      422,
    );
  }

  await db.tenant.update({
    where: { id: auth.tenantId },
    data: {
      dashboardUrl,
      dashboardToken: encrypt(dashboardToken),
      dashboardSourceEnabled: true,
    },
  });

  return apiSuccess({ ok: true, ordersSeen });
}
