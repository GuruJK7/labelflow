/**
 * ¿A qué agencia de Correo va este pedido?
 *
 * Cuando la entrega es "sí o sí en agencia", cada pedido necesita el NOMBRE de
 * una oficina del catálogo de AHIVA. Ese dato no existe en ninguna fuente:
 * Shopify no lo trae, el panel tampoco, y el checkout no tiene dónde ponerlo.
 * Así que hay que derivarlo del destino del comprador.
 *
 * EL ERROR CARO QUE ESTE ARCHIVO EVITA. Elegir una oficina "razonable" cuando el
 * destino es ambiguo manda al comprador a retirar el paquete a otra ciudad —
 * y como el envío es contra entrega, nadie lo retira, el paquete vuelve, y la
 * tienda paga el flete de ida y el de vuelta sin cobrar la mercadería. Por eso
 * la regla es: se elige SÓLO cuando hay una sola respuesta posible. Ante duda,
 * se devuelve la lista de candidatas y el pedido va a revisión.
 *
 * La asimetría es deliberada: revisar un pedido a mano cuesta un minuto,
 * despacharlo a la sucursal equivocada cuesta dos fletes y una venta.
 *
 * Puro: el catálogo entra por parámetro, no hay red ni DB.
 *
 * `uruguay-geo` se IMPORTA de `dac/`, no se mueve: moverlo obligaría a editar
 * `dac/shipment.ts`, que es intocable. El archivo no tiene un solo import
 * top-level, así que importarlo no arrastra Playwright al bundle.
 */

import { getDepartmentForCity, getDepartmentFromZip, isAmbiguousCityName } from '../dac/uruguay-geo';
import { normalizarDepartamento, stripAccentsUpper } from './mapper';
import type { CorreoDepartamento, LocalidadCorreo } from './types';

/** Lo que se sabe del destino del comprador, tal cual llega de la tienda. */
export interface DestinoParaOficina {
  /** Departamento tal cual viene ("Maldonado", "Montevideo", "Paysandú"...). */
  departamento?: string | null;
  ciudad?: string | null;
  /** Barrio, si la fuente lo trae (el panel sí, Shopify normalmente no). */
  barrio?: string | null;
  zip?: string | null;
  /** Dirección libre. Sólo se usa para inferir barrio en Montevideo. */
  calle?: string | null;
}

export type ResolucionOficina =
  | { ok: true; oficina: LocalidadCorreo; motivoEleccion: string }
  | { ok: false; motivo: string; candidatas: string[] };

/** Comparación de nombres de lugar: sin tildes, mayúscula, espacios colapsados. */
function normalizar(v: string | null | undefined): string {
  return stripAccentsUpper(v ?? '').replace(/\s+/g, ' ');
}

/**
 * Resuelve el departamento del destino con las tres señales que ya usa el resto
 * del pipeline, en el mismo orden de confianza: lo que declaró la tienda, la
 * ciudad, y el código postal.
 */
export function resolverDepartamentoDestino(
  destino: DestinoParaOficina,
): CorreoDepartamento | null {
  const declarado = normalizarDepartamento(destino.departamento);
  if (declarado) return declarado;

  // Sin departamento declarado, la ciudad sola NO alcanza para decidir.
  //
  // 🔴 Uruguay tiene ciudades homónimas en departamentos distintos y el catálogo
  // de Correo tiene oficina en las dos puntas: "Colón" es un barrio de Montevideo
  // Y una ciudad de Lavalleja; "La Paz" está en Canelones Y en Colonia. Antes se
  // devolvía el departamento de la ciudad sin más, así que un comprador de Colón,
  // Lavalleja terminaba con el paquete en una agencia de Montevideo a 120 km. En
  // contra entrega eso es flete de ida, flete de vuelta y mercadería sin cobrar.
  //
  // El CP deja de ser un fallback y pasa a ser CORROBORACIÓN: si contradice a la
  // ciudad, o si la ciudad está en la lista de homónimas de `dac/uruguay-geo`
  // (la misma que ya usa DAC en shipment.ts), se devuelve null. Con null,
  // `resolverOficinaEntrega` manda el pedido a revisión con un motivo legible,
  // que es la respuesta correcta para un destino que no se puede determinar.
  const desdeZip = normalizarDepartamento(getDepartmentFromZip(destino.zip));
  const porCiudad = destino.ciudad ? getDepartmentForCity(destino.ciudad) : undefined;
  const desdeCiudad = normalizarDepartamento(porCiudad);

  if (desdeCiudad) {
    if (isAmbiguousCityName(destino.ciudad) && desdeCiudad !== desdeZip) return null;
    if (desdeZip && desdeZip !== desdeCiudad) return null;
    return desdeCiudad;
  }

  return desdeZip;
}

/** Oficinas del catálogo que están en ese departamento. */
export function oficinasDeDepartamento(
  departamento: CorreoDepartamento,
  catalogo: LocalidadCorreo[],
): LocalidadCorreo[] {
  return catalogo.filter((o) => normalizar(o.departamento) === departamento);
}

/**
 * Elige la agencia de retiro para un destino.
 *
 * @param opts.oficinaPreferida nombre pedido explícitamente (por el operador o
 *   por un atributo del pedido). Una elección humana explícita gana sobre la
 *   derivación automática, pero igual se valida contra el catálogo.
 */
export function resolverOficinaEntrega(
  destino: DestinoParaOficina,
  catalogo: LocalidadCorreo[],
  opts: { oficinaPreferida?: string | null } = {},
): ResolucionOficina {
  if (!catalogo || catalogo.length === 0) {
    return {
      ok: false,
      motivo: 'No se pudo bajar el catálogo de oficinas de Correo: sin él no se puede elegir agencia.',
      candidatas: [],
    };
  }

  const departamento = resolverDepartamentoDestino(destino);

  // --- 0. elección explícita ------------------------------------------------
  const pedida = (opts.oficinaPreferida ?? '').trim();
  if (pedida) {
    const objetivo = normalizar(pedida);
    const exactas = catalogo.filter((o) => normalizar(o.nombre) === objetivo);
    if (exactas.length === 1) {
      const oficina = exactas[0];
      // Se avisa la discrepancia pero se respeta la elección: si alguien pidió
      // esa sucursal a mano, sabe algo que el geo no sabe.
      const discrepa = departamento && normalizar(oficina.departamento) !== departamento;
      return {
        ok: true,
        oficina,
        motivoEleccion: discrepa
          ? `Oficina pedida explícitamente ("${oficina.nombre}", ${oficina.departamento}), que NO es el departamento del destino (${departamento}).`
          : `Oficina pedida explícitamente: ${oficina.nombre}.`,
      };
    }
    if (exactas.length > 1) {
      return {
        ok: false,
        motivo:
          `El catálogo tiene ${exactas.length} oficinas llamadas "${exactas[0].nombre}" y AHIVA las ` +
          'identifica por nombre: no hay forma de elegir cuál.',
        candidatas: exactas.map((o) => `${o.nombre} (${o.departamento}, ${o.direccion})`),
      };
    }
    return {
      ok: false,
      motivo: `La oficina pedida "${pedida}" no existe en el catálogo de Correo.`,
      candidatas: catalogo
        .filter((o) => normalizar(o.nombre).includes(objetivo) || objetivo.includes(normalizar(o.nombre)))
        .map((o) => `${o.nombre} (${o.departamento})`)
        .slice(0, 8),
    };
  }

  // --- 1. departamento ------------------------------------------------------
  if (!departamento) {
    return {
      ok: false,
      motivo:
        `No se pudo determinar el departamento del destino (departamento: ${destino.departamento ?? '—'}, ` +
        `ciudad: ${destino.ciudad ?? '—'}, CP: ${destino.zip ?? '—'}), así que no hay de dónde sacar la agencia.`,
      candidatas: [],
    };
  }

  const enDepto = oficinasDeDepartamento(departamento, catalogo);
  if (enDepto.length === 0) {
    return {
      ok: false,
      motivo: `Correo no tiene ninguna oficina en ${departamento} según el catálogo vigente.`,
      candidatas: [],
    };
  }

  // --- 2. una sola oficina en el departamento: no hay nada que elegir -------
  if (enDepto.length === 1) {
    return {
      ok: true,
      oficina: enDepto[0],
      motivoEleccion: `Única oficina de Correo en ${departamento}.`,
    };
  }

  // --- 3. señales DETERMINADAS: el barrio declarado y la ciudad -------------
  // Son valores únicos: si uno de ellos nombra exactamente una oficina del
  // departamento, no hay ambigüedad que resolver.
  const barrioDeclarado = normalizar(destino.barrio);
  for (const nombre of [barrioDeclarado, normalizar(destino.ciudad)].filter(Boolean)) {
    const porNombre = enDepto.filter((o) => normalizar(o.nombre) === nombre);
    if (porNombre.length === 1) {
      return {
        ok: true,
        oficina: porNombre[0],
        motivoEleccion: `La oficina "${porNombre[0].nombre}" coincide con el destino en ${departamento}.`,
      };
    }
    const porCiudad = enDepto.filter((o) => normalizar(o.ciudad) === nombre);
    if (porCiudad.length === 1) {
      return {
        ok: true,
        oficina: porCiudad[0],
        motivoEleccion: `Única oficina en ${porCiudad[0].ciudad}, ${departamento}.`,
      };
    }
  }

  // --- 4. el código postal, contra el catálogo del PROPIO Correo -----------
  //
  // 🔴 Acá había un error que valía dos fletes. La versión anterior infería el
  // barrio con `getBarriosFromZip` / `getBarriosFromStreet` de `dac/uruguay-geo`
  // y se quedaba con el primero que matcheara. Dos problemas, los dos reales:
  //
  //  1. Esas tablas son de DAC y CONTRADICEN al catálogo de Correo: Correo le
  //     asigna a cada una de sus oficinas su propio `codigoPostal`, y esa es la
  //     única fuente que no se puede pelear consigo misma.
  //  2. Devuelven LISTAS de candidatos, no determinaciones. "Rambla 123" da los
  //     nueve barrios de la costa, de Ciudad Vieja a Punta Gorda, porque la
  //     rambla los atraviesa a todos. Quedarse con el primero manda el paquete a
  //     la punta opuesta de la ciudad — y como es contra entrega, nadie lo
  //     retira y vuelve.
  //
  // Se compara el CP del destino contra el CP que Correo publica para cada
  // oficina. Si da una sola, es una determinación legítima. Si da varias, lo
  // único que aporta es acortar la lista para quien elige a mano.
  const zip = (destino.zip ?? '').trim();
  let acotadas: LocalidadCorreo[] = enDepto;
  if (zip) {
    const porCp = enDepto.filter((o) => o.codigoPostal.trim() === zip);
    if (porCp.length === 1) {
      return {
        ok: true,
        oficina: porCp[0],
        motivoEleccion: `Única oficina de ${departamento} con el código postal ${zip}: ${porCp[0].nombre}.`,
      };
    }
    if (porCp.length > 1) acotadas = porCp;
  }

  // --- 5. no hay una sola respuesta: a revisión, con la lista más corta ----
  const seAcoto = acotadas.length < enDepto.length;
  return {
    ok: false,
    motivo:
      `Correo tiene ${enDepto.length} oficinas en ${departamento} y el destino ` +
      `(${destino.barrio || destino.ciudad || 'sin localidad'}) no identifica ninguna. ` +
      (seAcoto ? `Por el código postal ${zip}, las posibles son ${acotadas.length}. ` : '') +
      'Elegí la agencia a mano: mandarlo a la sucursal equivocada significa que nadie lo retira ' +
      'y el paquete vuelve sin cobrarse.',
    candidatas: acotadas.map((o) => o.nombre).sort(),
  };
}
