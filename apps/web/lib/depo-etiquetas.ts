/**
 * Etiquetas del depósito, distribuidas POR CLIENTE (cada marca es una tienda).
 *
 * El operador del depósito necesita saber cuántas etiquetas se emitieron para
 * cada marca en un rango. Hasta acá ese número había que sacarlo tienda por
 * tienda desde Control, una por una.
 *
 * MÓDULO PURO: sin Prisma, sin next/server, sin `new Date()`. Todo entra por
 * parámetro para poder testearlo sin base ni red.
 */

/** Lo mínimo que este resumen necesita de una etiqueta. */
export interface EtiquetaDeposito {
  tenantId: string;
  tenantName: string;
  /** La tienda opera contra el depósito (ver la definición en la ruta). */
  esDeposito: boolean;
}

/** Una fila del resumen: un cliente con su cuenta. */
export interface FilaCliente {
  tenantId: string;
  tenantName: string;
  esDeposito: boolean;
  total: number;
}

export interface ResumenDeposito {
  clientes: FilaCliente[];
  total: number;
}

/**
 * Agrupa las etiquetas por cliente y las cuenta.
 *
 * ORDEN DE LAS FILAS, y no es cosmético: primero las tiendas del depósito (que
 * son las que el operador vino a mirar), después el resto; dentro de cada
 * bloque, la de más volumen arriba. Con volumen empatado se ordena por nombre
 * para que dos cargas seguidas de la misma pantalla no bailen.
 *
 * Un cliente con 0 etiquetas en el rango NO aparece: el resumen se arma con lo
 * que hubo, no con el catálogo de tiendas. Una fila en cero se lee como "esta
 * tienda falló", y no falló: no despachó.
 */
export function resumirDeposito(labels: EtiquetaDeposito[]): ResumenDeposito {
  const porCliente = new Map<string, FilaCliente>();

  for (const l of labels) {
    const fila = porCliente.get(l.tenantId);
    if (fila) {
      fila.total += 1;
    } else {
      porCliente.set(l.tenantId, {
        tenantId: l.tenantId,
        tenantName: l.tenantName,
        esDeposito: l.esDeposito,
        total: 1,
      });
    }
  }

  const clientes = [...porCliente.values()].sort((a, b) => {
    if (a.esDeposito !== b.esDeposito) return a.esDeposito ? -1 : 1;
    if (b.total !== a.total) return b.total - a.total;
    return a.tenantName.localeCompare(b.tenantName, 'es');
  });

  return { clientes, total: clientes.reduce((n, c) => n + c.total, 0) };
}

/**
 * Porcentaje entero de una parte sobre un total, seguro ante total 0.
 *
 * Existe para que la UI no tenga que acordarse de la división por cero: con
 * total 0 devuelve 0, no NaN ni Infinity.
 */
export function pct(parte: number, total: number): number {
  if (!Number.isFinite(parte) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((parte / total) * 100);
}
