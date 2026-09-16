/**
 * Fuente INTERNA: los pedidos que el comerciante cargó a mano o importó de un
 * Excel en la propia web (tabla `PedidoInterno`).
 *
 * Es la única fuente que no depende de nada externo. Shopify necesita la tienda
 * conectada; la fuente `dashboard` necesita una URL y un token de OTRO sistema.
 * Quien no tenía ninguno de los dos no podía completar el onboarding ni
 * despachar un envío — medido contra producción el 14-09-2026: ninguna cuenta
 * orgánica llegó jamás a `onboardingComplete`.
 *
 * Traduce `PedidoInterno` → `DashboardOrder` y con eso TODO el resto del job
 * (adaptador, dedup, contrareembolso, Correo Uruguayo, DAC, PDF) corre sin
 * enterarse de que existe una fuente nueva.
 */
import { db } from '../db';
import { stableNumericId } from '../dashboard/adapter';
import { isPickupAtDacBranch } from '../dac/shipment';
import type { FuenteDePedidos, TenantDeFuente, Configuracion, DashboardOrder } from './tipos';

export interface CtxInterna {
  tenantId: string;
}

/** Lo que guarda el comerciante por ítem. `precio` va EN PESOS, no en centavos. */
interface ItemGuardado {
  nombre?: unknown;
  cantidad?: unknown;
  precio?: unknown;
}

const texto = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
};

const numero = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * La dirección que va a ver DAC.
 *
 * Si el pedido es un retiro en sucursal, se escribe con la forma que
 * `isPickupAtDacBranch` (dac/shipment.ts) ya reconoce —"Agencia DAC <nombre>"—
 * en vez de agregarle un campo estructurado al pipeline. Esa función es la que
 * decide `TipoEntrega=Agencia` y está testeada; meter un camino nuevo para el
 * mismo efecto sería duplicar una decisión delicada.
 *
 * Devuelve null si no hay ni dirección ni agencia: ese pedido no se puede
 * despachar y el job lo cuenta como `sinDireccion`.
 */
export function direccionParaDac(p: { direccion: string | null; agencia: string | null }): string | null {
  const agencia = texto(p.agencia);
  if (agencia) {
    // La guarda es la PROPIA función que después toma la decisión, no un regex
    // parecido: así el texto que sale de acá no puede dejar de reconocerse.
    //
    // 🔴 No alcanza con mirar si dice "agencia": "Agencia Pocitos" NO matchea
    // (el patrón real exige "agencia DAC"), y dejarlo tal cual haría que DAC lo
    // tomara como entrega a domicilio a una calle llamada "Agencia Pocitos".
    if (isPickupAtDacBranch(agencia, null, null)) return agencia;
    // Se saca un "Agencia "/"Sucursal " que el comerciante haya escrito, para no
    // terminar en "Agencia DAC Agencia Pocitos".
    const limpio = agencia.replace(/^\s*(agencia|sucursal)\s+/i, '').trim() || agencia;
    return `Agencia DAC ${limpio}`;
  }
  return texto(p.direccion);
}

/** Fila de `PedidoInterno`, sólo lo que esta fuente necesita leer. */
export interface FilaPedidoInterno {
  id: string;
  nombre: string;
  telefono: string;
  documento: string | null;
  email: string | null;
  departamento: string;
  localidad: string | null;
  direccion: string | null;
  agencia: string | null;
  referencia: string | null;
  items: unknown;
  totalUyu: number;
  contraEntrega: boolean;
  observaciones: string | null;
}

/** `PedidoInterno` → `DashboardOrder`, el dialecto que ya habla todo el job. */
export function aDashboardOrder(p: FilaPedidoInterno): DashboardOrder {
  const crudos: ItemGuardado[] = Array.isArray(p.items) ? (p.items as ItemGuardado[]) : [];
  const items = crudos.map((it) => ({
    name: texto(it.nombre) ?? 'Artículo',
    qty: Math.max(1, Math.trunc(numero(it.cantidad)) || 1),
    price: numero(it.precio),
  }));

  return {
    id: p.id,
    status: 'confirmed',
    buyer_name: p.nombre,
    items,
    address: {
      full_name: p.nombre,
      phone: p.telefono,
      department: p.departamento,
      address_line: direccionParaDac(p),
      document: texto(p.documento),
      // El mail llega a `order.email` por el adaptador (dashboard/adapter.ts:71)
      // y de ahí a `construirEnvio` (correo/validate.ts), que rechaza SIN
      // excepción un mail vacío: AHIVA lo exige para avisar la llegada. Hasta el
      // 16-09-2026 esta fuente no lo mandaba, así que TODO pedido cargado a mano
      // o por Excel en una tienda con Correo iba a NEEDS_REVIEW por «Email
      // inválido o vacío», corrida tras corrida. DAC lo ignora: null es válido.
      email: texto(p.email),
      city: texto(p.localidad),
      // Para Correo Uruguayo `neighborhood` es la localidad que pide AHIVA y el
      // dato que más ayuda a elegir la agencia (ver el comentario de la rama de
      // Correo en el job). El adaptador de DAC lo ignora, así que ponerlo acá no
      // le cambia nada a ese camino.
      neighborhood: texto(p.localidad),
      // La agencia que el comerciante escribió, CRUDA. `address_line` ya lleva
      // el mismo dato envuelto en "Agencia DAC …" para que `isPickupAtDacBranch`
      // lo reconozca, pero esa forma sólo la entiende DAC: Correo necesita el
      // nombre pelado para matchearlo contra el catálogo de AHIVA.
      // Sin esto, el texto del comerciante moría acá y Correo elegía la oficina
      // por su cuenta (o mandaba el pedido a revisión).
      pickup_office: texto(p.agencia),
      reference: texto(p.referencia),
    },
    dac_text: texto(p.observaciones),
    // El contrareembolso se decide POR PEDIDO. El monto sólo se usa si la tienda
    // tiene `codEnabled` prendido — eso lo resuelve `codDeLaFuenteDashboard` en
    // el job, igual que para la fuente remota, para que los dos transportistas y
    // las dos fuentes no puedan divergir.
    cod_amount: p.contraEntrega ? Math.round(p.totalUyu) || null : null,
  };
}

export const fuenteInterna: FuenteDePedidos<CtxInterna> = {
  nombre: 'interna',

  configurar(tenant: TenantDeFuente): Configuracion<CtxInterna> {
    if (!tenant.internalSourceEnabled) {
      return { ok: false, motivo: 'La carga de pedidos propia no está activada para esta tienda' };
    }
    return { ok: true, ctx: { tenantId: tenant.id } };
  },

  async traer(ctx, limit) {
    const filas = await db.pedidoInterno.findMany({
      where: { tenantId: ctx.tenantId, estado: 'PENDIENTE' },
      orderBy: { createdAt: 'asc' }, // el más viejo primero: nadie se queda atrás
      take: limit,
    });

    const orders: DashboardOrder[] = [];
    let sinDireccion = 0;
    for (const f of filas) {
      const o = aDashboardOrder(f as FilaPedidoInterno);
      // Sin dirección ni agencia no hay nada que cargar en DAC. Se cuenta y se
      // deja PENDIENTE: el comerciante lo corrige desde /pedidos y sale solo en
      // la próxima corrida.
      if (!o.address?.address_line) {
        sinDireccion++;
        continue;
      }
      orders.push(o);
    }

    return { orders, saturado: filas.length >= limit, sinDireccion };
  },

  async marcarCargadas(ctx, ids) {
    if (ids.length === 0) return 0;

    // Atar cada pedido con SU etiqueta. La identidad que comparten es
    // `Label.shopifyOrderId === String(stableNumericId(pedido.id))`, el mismo
    // hash que usa el dedup de DAC. La fuente remota no puede hacer esto —el
    // hash es de una sola vía y del otro lado no tienen la tabla— pero acá
    // tenemos las dos puntas, así que el vínculo queda explícito en la fila y
    // la web no necesita re-derivar nada para mostrar la guía.
    const porHash = new Map(ids.map((id) => [String(stableNumericId(id)), id]));
    const etiquetas = await db.label.findMany({
      where: { tenantId: ctx.tenantId, shopifyOrderId: { in: [...porHash.keys()] } },
      select: { id: true, shopifyOrderId: true, dacGuia: true },
    });
    const datosPorPedido = new Map<string, { labelId: string; dacGuia: string | null }>();
    for (const e of etiquetas) {
      const pedidoId = porHash.get(e.shopifyOrderId);
      if (pedidoId) datosPorPedido.set(pedidoId, { labelId: e.id, dacGuia: e.dacGuia });
    }

    // A diferencia de la fuente remota, acá el writeback es una escritura local:
    // no se puede perder en la red. Se acota por tenantId además del id para que
    // un id de otra tienda no pueda tocar nada — los ids vienen del propio job,
    // pero la consulta no tiene por qué confiar en eso.
    const despachadoAt = new Date();
    let actualizados = 0;
    for (const id of ids) {
      const extra = datosPorPedido.get(id);
      const r = await db.pedidoInterno.updateMany({
        where: { id, tenantId: ctx.tenantId, estado: 'PENDIENTE' },
        data: {
          estado: 'DESPACHADO',
          despachadoAt,
          errorMessage: null,
          ...(extra ? { labelId: extra.labelId, dacGuia: extra.dacGuia } : {}),
        },
      });
      actualizados += r.count;
    }
    return actualizados;
  },

  // `publicarEtiquetas` a propósito NO se implementa: el PDF ya quedó en
  // Supabase y en `Label.pdfPath`, que es de donde lo lee la web. Mandárselo a
  // sí misma en base64 sería trabajo puro.
};
