/**
 * Pre-vuelo de un envío de Correo Uruguayo: convierte un pedido nuestro en un
 * `DataEnvio` válido, o devuelve la lista COMPLETA de motivos por los que no se
 * puede despachar.
 *
 * Por qué existe además de `mapper.ts`: el mapper valida campo por campo y corta
 * en el primero que falla. Para operar (cargar 20 pedidos y saber cuáles hay que
 * arreglar) hace falta lo contrario — juntar TODOS los motivos de una pasada, y
 * decidir domicilio vs. sucursal, que el mapper no hace.
 *
 * Regla dura del módulo: si algo no cierra, NO se arma el envío. Una llamada a
 * AHIVA cuesta plata y emite una guía real; es preferible mandar el pedido a
 * revisión con un motivo legible que despacharlo con un dato inventado.
 *
 * Puro, sin I/O: el catálogo de oficinas entra por parámetro.
 */

import {
  normalizarCelular,
  normalizarDepartamento,
  resolverLocalidad,
  resolverPesoKg,
  stripAccentsUpper,
  esMailValido,
} from './mapper';
import {
  CorreoEmpaque,
  type CorreoAlmacenamiento,
  type DataEnvio,
  type DataPaquete,
  type LocalidadCorreo,
  type ResponsablePago,
} from './types';
import { estimarCargoCodUYU, planDeCodCorreo } from './cod';

/**
 * Un pedido nuestro, en la forma mínima que necesita Correo. Deliberadamente
 * NO es el tipo de Shopify ni el de Prisma: este módulo tiene que servir tanto
 * al job automático como a una carga manual desde un JSON, y atarlo a una de
 * las dos fuentes lo volvería inservible para la otra.
 */
export interface PedidoParaCorreo {
  /** Nº de pedido nuestro. Se imprime en la etiqueta y es la clave de idempotencia. */
  referencia: string;

  nombre?: string | null;
  mail?: string | null;
  celular?: string | null;

  /** Departamento tal cual viene de la tienda ("Paysandú", "Maldonado"...). */
  departamento?: string | null;
  /** Ciudad/localidad. En Montevideo se ignora en favor de `barrio`. */
  ciudad?: string | null;
  /** Barrio. OBLIGATORIO si el departamento es Montevideo. */
  barrio?: string | null;
  calle?: string | null;
  nroPuerta?: string | null;
  nroApto?: string | null;
  observaciones?: string | null;

  /**
   * Si viene, el envío es RETIRO EN SUCURSAL y tiene que coincidir exacto con
   * un `nombre` del catálogo de `obtenerLocalidadesCorreo()`.
   */
  oficinaCorreo?: string | null;

  /** Peso real en kg. Tiene prioridad sobre `gramos`. */
  pesoKg?: number | null;
  /** Peso en gramos (lo que devuelve Shopify). */
  gramos?: number | null;
  /** Peso por defecto de la tienda, para cuando el pedido no trae peso. */
  pesoDefaultKg?: number | null;

  /** Descripción del contenido. Sale impresa en la etiqueta. */
  contenido?: string | null;
  /** Quién paga el flete. Default DESTINATARIO (la mercadería ya está cobrada). */
  pagaFlete?: ResponsablePago;
  /** Días que la sucursal destino guarda el paquete. 10 gratis, 20 con costo. */
  almacenamiento?: CorreoAlmacenamiento;
  empaque?: CorreoEmpaque;

  // --- contrareembolso (mercadería a cobrar en destino) ---------------------
  /**
   * Monto de la mercadería que Correo le cobra al destinatario y le gira al
   * remitente. null/0/ausente = envío normal, sin cobro. Es el "Valor total"
   * del paso 3 del portal AhíVA.
   */
  codAmount?: number | null;
  /**
   * "Referencia / Remito / No Factura" del portal. Obligatorio cuando hay cobro;
   * si no viene, se usa `referencia`.
   */
  codReferencia?: string | null;
  /** Quién paga el COSTO del servicio de contrareembolso. Default DESTINATARIO. */
  pagaServicioCod?: ResponsablePago;

  // --- devolución ------------------------------------------------------------
  /**
   * Oficina de Correo a la que vuelve el paquete si no se puede entregar
   * ("Oficina Devolución" en el paso de confirmación del portal). Tiene que
   * coincidir con un `nombre` del catálogo, igual que `oficinaCorreo`.
   */
  oficinaDevolucion?: string | null;
}

export type ResultadoValidacion =
  | { ok: true; envio: DataEnvio; avisos: string[] }
  | { ok: false; motivos: string[]; avisos: string[] };

/**
 * Un celular de relleno: `utils.ts` y `dac/shipment.ts` sustituyen el teléfono
 * faltante por `099000000` antes de mandarlo a DAC. A DAC le da igual; Correo
 * lo acepta (son 9 dígitos y empieza en 09) y el paquete sale con un contacto
 * que no existe, así que el aviso de entrega nunca llega.
 *
 * Criterio: seis ceros finales. Cubre `099000000` y `090000000` sin arriesgar
 * un número real — un celular legítimo que termine en 000000 es prácticamente
 * inexistente, y el costo de un falso positivo (revisar a mano) es muchísimo
 * menor que el de despachar sin contacto.
 */
export function esCelularPlaceholder(celular: string): boolean {
  return /0{6}$/.test(celular);
}

/**
 * Busca una oficina por nombre exacto. AHIVA espera el `nombre` textual del
 * catálogo, con su acentuación propia ("Piriápolis" lleva tilde, "Aigua" y
 * "Pan de Azucar" no) — por eso la comparación laxa es sólo para SUGERIR, y lo
 * que se manda siempre es el `nombre` canónico del catálogo.
 */
export function buscarOficina(
  nombre: string,
  catalogo: LocalidadCorreo[],
):
  | { ok: true; oficina: LocalidadCorreo; duplicadas: number }
  | { ok: false; sugerencias: string[] } {
  const objetivo = stripAccentsUpper(nombre).replace(/\s+/g, ' ');

  // Se filtra en vez de buscar el primero: el catálogo de PRODUCCIÓN tiene
  // nombres repetidos (verificado el 2026-08-28: "Colonia Miguelete" aparece
  // dos veces, mismo CP, direcciones y códigos AHIVA distintos). Como el campo
  // `oficinaCorreo` viaja como TEXTO, no por código, elegir en silencio una de
  // las dos sería adivinar cuál sucursal recibe el paquete.
  const exactas = catalogo.filter(
    (o) => stripAccentsUpper(o.nombre).replace(/\s+/g, ' ') === objetivo,
  );
  if (exactas.length > 0) {
    return { ok: true, oficina: exactas[0], duplicadas: exactas.length };
  }

  const sugerencias = catalogo
    .filter((o) => {
      const n = stripAccentsUpper(o.nombre);
      return n.includes(objetivo) || objetivo.includes(n);
    })
    .map((o) => `${o.nombre} (${o.departamento})`)
    .slice(0, 5);

  return { ok: false, sugerencias };
}

/**
 * Tarifario público de Ahíva, contado, todo el país.
 *
 * DATO VOLÁTIL — vigencia declarada 01/11/2025, re-verificado contra el PDF
 * oficial el 2026-08-27. Se usa SÓLO para estimar antes de mandar y para poder
 * comparar contra lo que devuelve el servicio. La cifra que vale es la del
 * campo `costos` de la respuesta de AHIVA, nunca ésta.
 */
export const CORREO_TARIFAS_UYU: ReadonlyArray<{ hastaKg: number; precio: number }> = [
  { hastaKg: 2, precio: 195 },
  { hastaKg: 5, precio: 220 },
  { hastaKg: 10, precio: 275 },
  { hastaKg: 15, precio: 325 },
  { hastaKg: 20, precio: 405 },
  { hastaKg: 25, precio: 465 },
  { hastaKg: 30, precio: 550 },
];

/** Estimación de flete en UYU. null si el peso está fuera de tabla. */
export function estimarTarifaUYU(pesoKg: number): number | null {
  for (const t of CORREO_TARIFAS_UYU) {
    if (pesoKg <= t.hastaKg) return t.precio;
  }
  return null;
}

/**
 * Arma el `DataEnvio` o junta todos los motivos por los que no se puede.
 *
 * @param catalogo oficinas de `obtenerLocalidadesCorreo()`. Sólo hace falta si
 *   el pedido es retiro en sucursal; si es a domicilio se puede omitir.
 */
export function construirEnvio(
  pedido: PedidoParaCorreo,
  catalogo?: LocalidadCorreo[],
): ResultadoValidacion {
  const motivos: string[] = [];
  const avisos: string[] = [];

  // --- referencia (clave de idempotencia: sin esto no se despacha nada) -----
  const referencia = (pedido.referencia ?? '').trim();
  if (!referencia) {
    motivos.push('Falta la referencia del pedido (es la clave de idempotencia)');
  }

  // --- destinatario ---------------------------------------------------------
  const nombre = (pedido.nombre ?? '').trim();
  if (!nombre) motivos.push('Falta el nombre del destinatario');

  const mail = (pedido.mail ?? '').trim();
  if (!esMailValido(mail)) {
    motivos.push(
      `Email inválido o vacío (recibido: ${mail ? `"${mail}"` : 'vacío'}). Correo Uruguayo valida el formato.`,
    );
  }

  const celular = normalizarCelular(pedido.celular);
  if (!celular) {
    motivos.push(
      `Celular inválido (recibido: ${pedido.celular ? `"${pedido.celular}"` : 'vacío'}). Correo exige 9 dígitos empezando en 09.`,
    );
  } else if (esCelularPlaceholder(celular)) {
    motivos.push(
      `El celular ${celular} es el relleno que pone cleanPhone() cuando el pedido no trae teléfono. ` +
        'El paquete saldría sin contacto real: conseguí el número antes de despachar.',
    );
  }

  // --- entrega: sucursal o domicilio, excluyentes ---------------------------
  const oficinaPedida = (pedido.oficinaCorreo ?? '').trim();
  let lugarEntrega: DataEnvio['lugarEntrega'] | null = null;

  if (oficinaPedida) {
    if (!catalogo || catalogo.length === 0) {
      motivos.push(
        `El pedido es retiro en sucursal ("${oficinaPedida}") pero no se pasó el catálogo de oficinas para validarlo.`,
      );
    } else {
      const r = buscarOficina(oficinaPedida, catalogo);
      if (r.ok) {
        lugarEntrega = { oficinaCorreo: r.oficina.nombre };
        if (r.oficina.nombre !== oficinaPedida) {
          avisos.push(`Oficina normalizada: "${oficinaPedida}" → "${r.oficina.nombre}"`);
        }
        if (r.duplicadas > 1) {
          avisos.push(
            `El catálogo tiene ${r.duplicadas} oficinas llamadas "${r.oficina.nombre}" ` +
              `en ${r.oficina.departamento}, con direcciones distintas. AHIVA identifica la ` +
              'sucursal por el nombre, así que no hay forma de elegir cuál: confirmá con Correo ' +
              'antes de despachar a esta oficina.',
          );
        }
      } else {
        motivos.push(
          `La oficina "${oficinaPedida}" no existe en el catálogo de Correo.` +
            (r.sugerencias.length ? ` ¿Quisiste decir: ${r.sugerencias.join(' · ')}?` : ''),
        );
      }
    }
  } else {
    const departamento = normalizarDepartamento(pedido.departamento);
    if (!departamento) {
      motivos.push(
        `Departamento no reconocido (recibido: ${pedido.departamento ? `"${pedido.departamento}"` : 'vacío'}). ` +
          'Tiene que ser uno de los 19 departamentos uruguayos.',
      );
    }

    const calle = (pedido.calle ?? '').trim();
    if (!calle) motivos.push('Falta la calle (obligatoria para entrega a domicilio)');

    const nroPuerta = (pedido.nroPuerta ?? '').trim();
    if (!nroPuerta) {
      avisos.push('Sin número de puerta: el cartero puede no encontrar la dirección.');
    }

    if (departamento) {
      const localidad = resolverLocalidad(departamento, pedido.ciudad, pedido.barrio);
      if (!localidad) {
        motivos.push(
          departamento === 'MONTEVIDEO'
            ? 'Montevideo sin barrio: en Montevideo el campo "localidad" ES el barrio, y sin él el envío se rechaza.'
            : 'Falta la localidad/ciudad de destino.',
        );
      } else if (calle) {
        lugarEntrega = {
          departamento,
          localidad,
          calle,
          nroPuerta: nroPuerta || undefined,
          nroApto: (pedido.nroApto ?? '').trim() || undefined,
          observacionesDireccion: (pedido.observaciones ?? '').trim() || undefined,
        };
      }
    }
  }

  // --- peso -----------------------------------------------------------------
  const gramosEfectivos =
    typeof pedido.pesoKg === 'number' && pedido.pesoKg > 0
      ? Math.round(pedido.pesoKg * 1000)
      : (pedido.gramos ?? null);

  const peso = resolverPesoKg(gramosEfectivos, pedido.pesoDefaultKg);
  let pesoKg: number | null = null;
  if ('error' in peso) {
    motivos.push(peso.error);
  } else {
    pesoKg = peso.pesoKg;
    if (gramosEfectivos === null || gramosEfectivos <= 0) {
      avisos.push(
        `Peso tomado del default de la tienda (${pesoKg} kg): el pedido no traía peso propio.`,
      );
    }
  }

  // --- contenido ------------------------------------------------------------
  const contenido = (pedido.contenido ?? '').trim();
  if (!contenido) {
    avisos.push('Sin descripción de contenido: la etiqueta va a salir sin referencia legible.');
  }

  // --- oficina de devolución -------------------------------------------------
  // El portal la pide con asterisco en TODOS los envíos, no sólo en los que
  // llevan cobro (paso de confirmación: "Oficina Devolución", y la etiqueta
  // impresa muestra esa oficina como remitente). El WSDL, en cambio, declara
  // `datosdevolucion` sin `minOccurs=1`, así que no hay forma de saber desde el
  // contrato si el servicio la exige. Ante esa contradicción se elige el camino
  // que no bloquea despachos: si falta, se avisa; si viene mal, se rechaza.
  const devolucionPedida = (pedido.oficinaDevolucion ?? '').trim();
  let datosdevolucion: DataEnvio['datosdevolucion'];

  if (devolucionPedida) {
    if (!catalogo || catalogo.length === 0) {
      motivos.push(
        `Se pidió devolver a la oficina "${devolucionPedida}" pero no se pasó el catálogo de oficinas para validarla.`,
      );
    } else {
      const r = buscarOficina(devolucionPedida, catalogo);
      if (r.ok) {
        datosdevolucion = { oficinaCorreo: r.oficina.nombre };
        if (r.oficina.nombre !== devolucionPedida) {
          avisos.push(`Oficina de devolución normalizada: "${devolucionPedida}" → "${r.oficina.nombre}"`);
        }
        if (r.duplicadas > 1) {
          avisos.push(
            `El catálogo tiene ${r.duplicadas} oficinas de devolución llamadas "${r.oficina.nombre}": ` +
              'AHIVA las identifica por nombre, así que no hay forma de elegir cuál.',
          );
        }
      } else {
        motivos.push(
          `La oficina de devolución "${devolucionPedida}" no existe en el catálogo de Correo.` +
            (r.sugerencias.length ? ` ¿Quisiste decir: ${r.sugerencias.join(' · ')}?` : ''),
        );
      }
    }
  } else {
    avisos.push(
      'Sin oficina de devolución: el portal la pide en todos los envíos. Si Correo no puede ' +
        'entregar el paquete, la sucursal a la que vuelve la decide Correo, no vos.',
    );
  }

  // --- contrareembolso -------------------------------------------------------
  // planDeCodCorreo distingue "no lleva cobro" (silencioso, es un envío normal)
  // de "lleva cobro y está mal cargado" (motivo). Sin esa distinción, un monto
  // fuera de tope se despacharía como envío simple: la mercadería llega y nadie
  // la cobra.
  const cod = planDeCodCorreo(
    {
      codAmount: pedido.codAmount,
      nroReferencia: pedido.codReferencia,
      pagaServicioCod: pedido.pagaServicioCod,
    },
    referencia,
  );
  if (!cod.esCod && 'motivo' in cod) motivos.push(cod.motivo);

  if (motivos.length > 0 || !lugarEntrega || pesoKg === null || !celular) {
    // El segundo chequeo es defensivo: si faltó armar el lugar de entrega o el
    // peso, ya hay un motivo cargado. Nunca devolvemos ok:true a medias.
    if (motivos.length === 0) motivos.push('Faltan datos obligatorios del envío');
    return { ok: false, motivos, avisos };
  }

  const paquete: DataPaquete = {
    peso: pesoKg,
    responsableServEntrega: pedido.pagaFlete ?? 'DESTINATARIO',
    referencia: contenido || referencia,
    empaque: pedido.empaque ?? CorreoEmpaque.NoPrecisa,
    almacenamiento: pedido.almacenamiento ?? 10,
  };

  // El paquete va en UNA sola lista. Con cobro en destino vive dentro de
  // `contraReembolsos[].paquetes`; sin cobro, en `paquetesSimples`. Ponerlo en
  // las dos haría que AHIVA facture dos piezas por una sola caja real
  // (regla textual del contrato, types.ts:141-144).
  const envio: DataEnvio = cod.esCod
    ? {
        soloDestinatario: false,
        destinatario: { nombre, mail, celular },
        lugarEntrega,
        datosdevolucion,
        contraReembolsos: [
          {
            monto: cod.monto,
            nroreferencia: cod.nroreferencia,
            responsableServContraReembolso: cod.responsableServContraReembolso,
            paquetes: [paquete],
          },
        ],
      }
    : {
        soloDestinatario: false,
        destinatario: { nombre, mail, celular },
        lugarEntrega,
        datosdevolucion,
        paquetesSimples: [paquete],
      };

  if (cod.esCod) {
    const cargo = estimarCargoCodUYU(cod.monto);
    avisos.push(
      `Contrareembolso: Correo le cobra $${cod.monto} al destinatario (referencia "${cod.nroreferencia}")` +
        (cargo !== null ? `, con un cargo estimado de $${cargo} por el servicio` : '') +
        `. Lo paga: ${cod.responsableServContraReembolso.toLowerCase()}.`,
    );
  }

  return { ok: true, avisos, envio };
}
