/**
 * El límite de pedidos de una corrida manual — y por qué "Todos" no era todos.
 *
 * 🔴 EL BUG (05-09-2026). Hay TRES intenciones distintas y el código las
 * colapsaba en dos:
 *
 *   | el usuario                  | body            | qué tiene que pasar          |
 *   |-----------------------------|-----------------|------------------------------|
 *   | no eligió nada              | sin `maxOrders` | manda `Tenant.maxOrdersPerRun` |
 *   | eligió "Todos"              | `maxOrders: 0`  | TODOS, sin tope              |
 *   | eligió un número            | `maxOrders: N`  | exactamente N                |
 *
 * Las dos rutas parseaban con `if (body?.maxOrders && …)`. `0` es *falsy*, así
 * que la guarda cortaba y "Todos" quedaba indistinguible de "no elegí nada".
 * Después, `if (effectiveMax > 0)` volvía a filtrar el 0 y NO se escribía el
 * RunLog con el override. Sin override, el worker cae a `tenant.maxOrdersPerRun`
 * (`process-orders.job.ts`, `effectiveLimit`), que vale **5 en Curvadivina y 20
 * en las otras 31 tiendas**.
 *
 * Resultado: apretar "Todos" despachaba 5 o 20 pedidos y dejaba el resto sin
 * avisar. El worker SIEMPRE supo interpretar `0` como ilimitado
 * (`const isUnlimited = effectiveLimit === 0`) — esa rama era código muerto
 * porque ninguna ruta le mandaba nunca un 0.
 *
 * Este módulo es el único lugar donde se decide eso, para que las dos rutas
 * (`/api/v1/jobs` del comerciante y `/api/v1/control/run` del panel) no puedan
 * volver a divergir.
 */

/** Tope de un límite explícito. Igual que el `z.number().max(50)` de settings. */
export const MAX_LIMITE_EXPLICITO = 50;

/** `0` es el centinela de "sin tope" que ya entiende el worker. */
export const TODOS = 0;

/**
 * Lee `maxOrders` del body de una corrida manual.
 *
 * @returns `undefined` cuando el usuario no pidió ningún límite (se usa el
 *   default de la tienda), `0` cuando pidió TODOS, o el número pedido.
 *   Un valor inválido (texto, decimal, negativo, > 50) se trata como ausente:
 *   la corrida sale con el default de la tienda en vez de fallar.
 */
export function leerLimitePedido(body: unknown): number | undefined {
  const raw = (body as { maxOrders?: unknown } | null | undefined)?.maxOrders;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined;
  if (raw < 0 || raw > MAX_LIMITE_EXPLICITO) return undefined;
  return raw;
}

/**
 * El límite que finalmente se guarda en el RunLog, combinando lo pedido con el
 * modo de prueba.
 *
 * `testMode` sin límite explícito significa "una sola guía para ver que
 * anda" — comportamiento histórico, se mantiene. Si el usuario pidió un
 * límite, ese manda: pedir `testMode` con "Todos" es una contradicción que
 * resuelve el usuario, no nosotros.
 */
export function limiteEfectivo(
  pedido: number | undefined,
  testMode: boolean,
): number | undefined {
  if (pedido !== undefined) return pedido;
  return testMode ? 1 : undefined;
}

/** `true` cuando hay que escribir el RunLog con el override. */
export function hayOverride(limite: number | undefined): limite is number {
  return limite !== undefined;
}

/** Texto para el usuario. `0` es "todos los pedidos", no "0 pedidos". */
export function etiquetaDeLimite(limite: number | undefined): string {
  if (limite === undefined || limite === TODOS) return 'todos los pedidos';
  return limite === 1 ? '1 pedido' : `${limite} pedidos`;
}
