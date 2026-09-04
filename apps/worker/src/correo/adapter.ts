/**
 * De un pedido de AutoEnvía a un envío de Correo Uruguayo.
 *
 * AGNÓSTICO DE LA FUENTE, a propósito. Las tres fuentes que existen hoy —Shopify,
 * el panel (Kinevia / Todo a Mano / VentaFlow) y la carga masiva por Excel—
 * terminan normalizando al mismo tipo `ShopifyOrder` (el panel lo hace en
 * `dashboard/adapter.ts:57`), así que este archivo trabaja sobre esa forma y
 * sirve para las tres sin ramas por fuente. Las fuentes que tienen datos más
 * ricos que Shopify (el panel trae barrio, número de puerta y cédula, y hoy los
 * tira al aplanar la dirección) los pasan por `extras` sin tocar el camino común.
 *
 * Lo que este archivo NO hace, y es deliberado:
 *
 *  - NO usa `cleanPhone()` de utils.ts. Esa función sustituye el teléfono
 *    faltante por `099000000`, que para Correo es formalmente válido (9 dígitos,
 *    empieza en 09) y despacharía el paquete con un contacto inexistente: el
 *    aviso de que llegó a la agencia nunca llega, y en contra entrega eso
 *    significa que nadie lo retira. Acá se prueban los teléfonos reales del
 *    pedido en orden y, si ninguno sirve, el envío va a revisión.
 *
 *  - NO inventa peso. Correo lo exige (>0 y <30 kg) y DAC nunca lo pidió, así
 *    que ninguna tienda lo tiene cargado. Si no hay peso propio ni default de
 *    tienda, el pedido va a revisión en vez de despacharse con un número
 *    inventado que después factura mal.
 */

import type { ShopifyOrder } from '../shopify/types';
import { resolverOficinaEntrega, type DestinoParaOficina } from './oficina';
import type { PedidoParaCorreo } from './validate';
import type { LocalidadCorreo, ResponsablePago } from './types';
import { normalizarCelular } from './mapper';
// El chequeo vive en shopify/ porque lo usan los tres transportistas.
export { yaEstaCobrado } from '../shopify/payment-state';
import { yaEstaCobrado } from '../shopify/payment-state';

/** Configuración de Correo de la tienda (columnas de Tenant). */
export interface ConfigCorreoTienda {
  /** Peso por defecto en kg para los pedidos que no traen el suyo. */
  pesoDefaultKg?: number | null;
  /** Oficina a la que Correo devuelve el paquete si no se puede entregar. */
  oficinaDevolucion?: string | null;
  /**
   * Si el envío se cobra al entregar. Cuando es true, el monto sale del total
   * del pedido y el paquete viaja como contra reembolso.
   */
  contraEntrega: boolean;
  /** Quién paga el flete. Default DESTINATARIO. */
  pagaFlete?: ResponsablePago;
  /** Quién paga el servicio de contra reembolso. Default DESTINATARIO. */
  pagaServicioCod?: ResponsablePago;
}

/** Datos que algunas fuentes tienen y Shopify no. Todos opcionales. */
export interface ExtrasPedido {
  /** Barrio. El panel lo trae; en Montevideo es lo que más ayuda a elegir agencia. */
  barrio?: string | null;
  /** Agencia pedida explícitamente para este pedido. Gana sobre la derivación. */
  oficinaPreferida?: string | null;
  /** Peso real del pedido en kg, si la fuente lo conoce. */
  pesoKg?: number | null;
  /** Nº de referencia/remito propio para el contra reembolso. Default: el nombre del pedido. */
  nroReferencia?: string | null;
}

export type ResultadoAdaptacion =
  | {
      ok: true;
      pedido: PedidoParaCorreo;
      oficina: LocalidadCorreo;
      motivoOficina: string;
    }
  | { ok: false; motivos: string[]; candidatas: string[] };

/**
 * Devuelve el primer teléfono del pedido que sea un celular uruguayo de verdad.
 *
 * Se prueban todos los que trae Shopify porque en datos reales el celular
 * aparece en cualquiera de ellos: el de envío suele estar vacío en pedidos
 * hechos desde el celular, y el de la cuenta del cliente es el que más
 * frecuentemente está bien cargado.
 */
export function celularDelPedido(order: ShopifyOrder): string | null {
  const candidatos = [
    order.shipping_address?.phone,
    order.phone,
    order.billing_address?.phone,
    order.customer?.phone,
    order.customer?.default_address?.phone,
  ];
  for (const c of candidatos) {
    const normalizado = normalizarCelular(c);
    if (normalizado) return normalizado;
  }
  return null;
}

/** Nombre de quien recibe, con el mismo orden de preferencia que usa el resto del pipeline. */
export function nombreDelPedido(order: ShopifyOrder): string {
  const envio = [order.shipping_address?.first_name, order.shipping_address?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (envio) return envio;
  const cuenta = [order.customer?.first_name, order.customer?.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  return cuenta;
}

/**
 * Descripción del contenido que se imprime en la etiqueta. Se arma con los
 * títulos de los ítems porque es lo que le sirve a quien despacha para
 * reconocer la caja, y se corta para que entre en la etiqueta.
 */
export function contenidoDelPedido(order: ShopifyOrder, max = 60): string {
  const titulos = (order.line_items ?? []).map((i) => i.title).filter(Boolean);
  if (titulos.length === 0) return '';
  const texto = titulos.length === 1 ? titulos[0] : `${titulos[0]} +${titulos.length - 1}`;
  return texto.length > max ? `${texto.slice(0, max - 1)}…` : texto;
}

/**
 * Monto a cobrar en destino. Es el total del pedido, redondeado a entero.
 *
 * 🔴 OJO CON EL DOBLE COBRO. Este número sólo tiene sentido si el pedido NO
 * está ya cobrado — de ahí `yaEstaCobrado`, que se chequea antes de llamar acá.
 */
export function montoAcobrar(order: ShopifyOrder): { monto: number } | { error: string } {
  // La moneda importa: AHIVA cobra en pesos uruguayos y punto. Un total de
  // "45.00" en USD despachado como $45 le cobraría al comprador ~43 veces menos
  // de lo que vale la mercadería, y la tienda se entera cuando ya se entregó.
  const moneda = (order.currency ?? '').trim().toUpperCase();
  if (moneda && moneda !== 'UYU') {
    return {
      error: `El pedido está en ${moneda} y Correo cobra en pesos uruguayos: no se puede convertir el monto a cobrar.`,
    };
  }

  const crudo = parseFloat(order.total_price);
  if (!Number.isFinite(crudo)) {
    return { error: `No se pudo leer el total del pedido ("${order.total_price}") para cobrarlo en destino.` };
  }
  const total = Math.round(crudo);
  if (total <= 0) {
    return { error: `El total del pedido es ${total}: no hay monto que cobrar en destino.` };
  }
  return { monto: total };
}

/**
 * Convierte un pedido en un `PedidoParaCorreo` listo para el pre-vuelo, o
 * devuelve TODOS los motivos por los que no se puede.
 *
 * Junta los motivos en vez de cortar en el primero: quien opera necesita saber
 * de una que al pedido le falta el mail Y el celular, no descubrirlo de a uno
 * en corridas sucesivas.
 */
export function pedidoDesdeOrden(
  order: ShopifyOrder,
  catalogo: LocalidadCorreo[],
  cfg: ConfigCorreoTienda,
  extras: ExtrasPedido = {},
): ResultadoAdaptacion {
  const motivos: string[] = [];

  const addr = order.shipping_address;
  if (!addr) {
    return {
      ok: false,
      motivos: ['El pedido no tiene dirección de envío.'],
      candidatas: [],
    };
  }

  const nombre = nombreDelPedido(order);
  if (!nombre) motivos.push('El pedido no trae nombre de destinatario.');

  const celular = celularDelPedido(order);
  if (!celular) {
    motivos.push(
      'Ningún teléfono del pedido es un celular uruguayo válido (9 dígitos empezando en 09). ' +
        'Correo lo exige para avisar que el paquete llegó a la agencia.',
    );
  }

  // --- a qué agencia va ------------------------------------------------------
  const destino: DestinoParaOficina = {
    departamento: addr.province,
    ciudad: addr.city,
    barrio: extras.barrio ?? null,
    zip: addr.zip,
    calle: addr.address1,
  };
  const resolucion = resolverOficinaEntrega(destino, catalogo, {
    oficinaPreferida: extras.oficinaPreferida,
  });
  if (!resolucion.ok) {
    motivos.push(resolucion.motivo);
    return { ok: false, motivos, candidatas: resolucion.candidatas };
  }

  // --- monto a cobrar en destino --------------------------------------------
  // Sólo se calcula si la tienda cobra al entregar. Si no se puede calcular, el
  // pedido NO sale: despacharlo "sin cobro" sería entregar la mercadería y no
  // cobrarla nunca, que es peor que revisarlo a mano.
  //
  // 🔴 EL CHEQUEO QUE EVITA COBRAR DOS VECES. `contraEntrega` es una propiedad
  // de la TIENDA ("cobro al entregar"), no del pedido. Desde que el pipeline
  // trae también los pedidos `pending`, una tienda puede tener las dos clases
  // mezcladas: el que pagó por MercadoPago y el que paga al recibir. Cobrarle
  // en destino a quien ya pagó en el checkout es cobrarle dos veces, y se
  // entera cuando el cartero le pide la plata.
  //
  // No es un motivo de revisión: el pedido pagado se despacha perfecto, sólo
  // que sin cobro en destino, que es exactamente lo correcto.
  let codAmount: number | null = null;
  if (cfg.contraEntrega && !yaEstaCobrado(order)) {
    const monto = montoAcobrar(order);
    if ('error' in monto) motivos.push(monto.error);
    else codAmount = monto.monto;
  }

  if (motivos.length > 0) return { ok: false, motivos, candidatas: [] };

  const pedido: PedidoParaCorreo = {
    referencia: order.name,
    nombre,
    mail: order.email || null,
    celular,
    oficinaCorreo: resolucion.oficina.nombre,
    oficinaDevolucion: cfg.oficinaDevolucion ?? null,
    pesoKg: extras.pesoKg ?? null,
    pesoDefaultKg: cfg.pesoDefaultKg ?? null,
    contenido: contenidoDelPedido(order),
    pagaFlete: cfg.pagaFlete ?? 'DESTINATARIO',
    codAmount,
    codReferencia: extras.nroReferencia ?? order.name,
    pagaServicioCod: cfg.pagaServicioCod ?? 'DESTINATARIO',
  };

  return {
    ok: true,
    pedido,
    oficina: resolucion.oficina,
    motivoOficina: resolucion.motivoEleccion,
  };
}
