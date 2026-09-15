/**
 * Contadores con ventana FIJA.
 *
 * 🔴 EL BUG QUE ESTO ARREGLA (14-09-2026). Todos los límites de la app hacían
 * `INCR key` + `EXPIRE key ttl` en la MISMA tubería, en cada request — incluidos
 * los que estaban por rechazarse. O sea que el vencimiento se volvía a estampar
 * a cada intento y la ventana se corría hacia adelante:
 *
 *     minuto 0   6º intento → 429, vence a los 60
 *     minuto 55  reintenta  → 429, vence a los 115
 *     minuto 110 reintenta  → 429, vence a los 170   … y así para siempre
 *
 * El mensaje promete «esperá una hora e intentá de nuevo», pero quien hacía
 * exactamente eso —probar de vuelta— reiniciaba su propio castigo y no salía
 * NUNCA. Lo sufrí probando el alta en producción, y después lo encontré igual en
 * el reenvío de confirmación, en el reseteo de contraseña y en el chat.
 *
 * Pega más fuerte en Uruguay que en otros lados: con el CGNAT de Antel muchos
 * clientes comparten una misma IP pública, así que una sola persona insistiendo
 * dejaba afuera a todos los demás de esa red, sin que ninguno supiera por qué.
 *
 * La regla correcta: el vencimiento se pone UNA vez, cuando el contador nace.
 * `INCR` devuelve 1 exactamente cuando la clave no existía, así que ese 1 es la
 * señal de "recién creado" y no hace falta ni un GET extra ni un script Lua.
 *
 * Fail-open a propósito: si Redis no está o no contesta, se deja pasar. Un alta
 * de más es mucho más barato que dejar a un cliente real afuera.
 */

/** Lo poco que necesitamos de un cliente Redis. Evita atarse al tipo del SDK. */
interface TuberiaRedis {
  /** Encadenable: `pipeline().incr(k).exec()`. */
  incr(key: string): TuberiaRedis;
  exec(): Promise<Array<[unknown, unknown]> | null>;
}

export interface RedisContador {
  pipeline(): TuberiaRedis;
  expire(key: string, seconds: number): Promise<unknown>;
}

/**
 * Suma uno y devuelve cuánto va en esta ventana. Le pone vencimiento sólo al
 * crearla, para que reintentar no corra el reloj.
 */
export async function contarEnVentanaFija(
  redis: RedisContador,
  key: string,
  ttlSegundos: number,
): Promise<number> {
  const res = await redis.pipeline().incr(key).exec();
  const count = (res?.[0]?.[1] as number) ?? 1;
  if (count === 1) {
    // Sin esto el contador quedaría para siempre y la clave no se liberaría nunca.
    await redis.expire(key, ttlSegundos);
  }
  return count;
}
