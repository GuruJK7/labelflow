import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';
import { normalizarPedido, destinoLegible, type PedidoCrudo } from '@/lib/pedido-interno';
import { exigirEmailParaTenant } from '@/lib/pedido-interno.server';

/**
 * POST /api/v1/pedidos/validar — la previsualización del importador.
 *
 * Corre EXACTAMENTE la misma validación que el alta (`normalizarPedido`) pero no
 * escribe nada. Sirve para que el comerciante vea qué filas van a entrar y cuáles
 * no ANTES de importar, con el número de fila del Excel al lado del problema.
 *
 * Que la previsualización la haga el servidor y no el navegador es a propósito:
 * si validara el cliente, lo que muestra la pantalla y lo que después acepta el
 * alta podrían decir cosas distintas. Acá hay un solo juez.
 */

const MAX_FILAS = 500;

export async function POST(req: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('Datos inválidos', 400);
  }

  const filas = (body as { filas?: unknown })?.filas;
  if (!Array.isArray(filas)) return apiError('Mandá las filas del archivo', 400);
  if (filas.length === 0) return apiError('El archivo no tiene ninguna fila con datos', 400);
  if (filas.length > MAX_FILAS) {
    return apiError(`El archivo tiene ${filas.length} filas (máximo ${MAX_FILAS}). Partilo en varios.`, 413);
  }

  // El mismo flag que usa el alta: si acá no se exigiera el mail y en el alta
  // sí, la revisión diría «entra» y la importación la rechazaría.
  const exigirEmail = await exigirEmailParaTenant(auth.tenantId);
  const resultados = (filas as Array<{ fila?: unknown; pedido?: unknown }>).map((f, i) => {
    const r = normalizarPedido((f?.pedido ?? {}) as PedidoCrudo, { exigirEmail });
    // El número lo pone el cliente porque es el del Excel, que acá no se ve.
    const nroFila = typeof f?.fila === 'number' ? f.fila : i + 2;
    if (r.ok) {
      return {
        fila: nroFila,
        ok: true as const,
        // Lo justo para que se reconozca la fila en la tabla de revisión.
        resumen: {
          nombre: r.pedido.nombre,
          email: r.pedido.email,
          destino: destinoLegible(r.pedido),
          departamento: r.pedido.departamento,
          totalUyu: r.pedido.totalUyu,
          contraEntrega: r.pedido.contraEntrega,
        },
      };
    }
    return { fila: nroFila, ok: false as const, errores: r.errores };
  });

  const validas = resultados.filter((r) => r.ok).length;
  return apiSuccess(resultados, { total: resultados.length, validas, invalidas: resultados.length - validas });
}
