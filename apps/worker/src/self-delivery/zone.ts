/**
 * Deteccion de "este pedido cae en una zona de reparto propio".
 *
 * Para que existe: hay departamentos que el tenant reparte por su cuenta (el
 * caso que motivo esto es Maldonado). Esos pedidos NO deben cargarse en DAC —
 * no se gasta guia, no se gasta credito, no se toca el navegador. En vez de
 * eso, LabelFlow emite su propia etiqueta.
 *
 * SESGO DELIBERADO HACIA DAC. Los dos errores posibles NO cuestan lo mismo:
 *
 *   - Falso positivo (decimos "reparto propio" y en realidad va a Rocha):
 *     el paquete queda esperando un reparto que nunca sale. El cliente no
 *     recibe nada y nadie se entera hasta el reclamo.
 *   - Falso negativo (decimos "DAC" y en realidad era Maldonado): se genera
 *     una guia de mas. Cuesta plata, pero el paquete LLEGA.
 *
 * Por eso la regla es: se excluye de DAC solo si alguna senal dice zona propia
 * y NINGUNA senal dice un departamento distinto. Ante contradiccion, gana DAC.
 *
 * Las tres senales, en el mismo orden de confianza que ya usa el resto del
 * sistema (ver buildSafeLabelGeoFields):
 *   1. ciudad resuelta contra la base geografica  (la mas confiable)
 *   2. codigo postal por prefijo                  (20xxx = Maldonado)
 *   3. province tal como lo mando Shopify         (la escribe el cliente)
 *
 * Modulo puro: sin DB, sin logger, sin Playwright. La resolucion de ciudad se
 * inyecta como parametro para poder testear sin red.
 */

/** Los 19 departamentos, en la grafia canonica que usa uruguay-geo (sin tildes). */
const DEPARTAMENTOS_CANONICOS = [
  'Artigas', 'Canelones', 'Cerro Largo', 'Colonia', 'Durazno', 'Flores',
  'Florida', 'Lavalleja', 'Maldonado', 'Montevideo', 'Paysandu', 'Rio Negro',
  'Rivera', 'Rocha', 'Salto', 'San Jose', 'Soriano', 'Tacuarembo',
  'Treinta y Tres',
];

/**
 * Lleva un texto de departamento a la grafia canonica, o null si no reconoce.
 * Tolera lo que realmente escriben los clientes en el checkout de Shopify:
 * tildes, mayusculas, "Depto.", "Departamento de", sufijo "Department" (que
 * es lo que manda Shopify en ingles), y separadores raros.
 */
export function normalizarDepartamento(valor: string | null | undefined): string | null {
  if (!valor) return null;
  let s = String(valor)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // saca tildes
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Shopify manda "Maldonado Department"; la gente escribe "Depto de Maldonado".
  s = s
    .replace(/\bdepartment\b/g, '')
    .replace(/\bdepartamento\b/g, '')
    .replace(/\bdepto\b/g, '')
    .replace(/\bdpto\b/g, '')
    .replace(/\bde\b\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!s) return null;

  for (const canon of DEPARTAMENTOS_CANONICOS) {
    const canonNorm = canon
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (s === canonNorm) return canon;
  }
  return null;
}

export interface DireccionDestino {
  city?: string | null;
  province?: string | null;
  zip?: string | null;
}

export interface SenalesZona {
  /** Departamento segun cada senal (null = la senal no dice nada). */
  porCiudad: string | null;
  porZip: string | null;
  porProvince: string | null;
}

export interface VeredictoZona {
  /** true = sale del circuito DAC y lo reparte el tenant. */
  esRepartoPropio: boolean;
  /** Departamento que se le atribuye al pedido (canonico), si se pudo determinar. */
  departamento: string | null;
  /** Por que se decidio asi — va al log del job para que el operador lo entienda. */
  motivo: string;
  senales: SenalesZona;
}

/**
 * Decide si un pedido cae en zona de reparto propio.
 *
 * @param depsPropios departamentos que el tenant reparte (grafia canonica o no)
 * @param deptPorCiudad resultado de getDepartmentForCityAsync(city), ya resuelto
 * @param deptPorZip resultado de getDepartmentFromZip(zip), ya resuelto
 */
export function evaluarZonaRepartoPropio(
  addr: DireccionDestino,
  depsPropios: string[],
  deptPorCiudad: string | null | undefined,
  deptPorZip: string | null | undefined,
): VeredictoZona {
  const propios = new Set(
    depsPropios.map((d) => normalizarDepartamento(d)).filter((d): d is string => !!d),
  );

  const senales: SenalesZona = {
    porCiudad: normalizarDepartamento(deptPorCiudad),
    porZip: normalizarDepartamento(deptPorZip),
    porProvince: normalizarDepartamento(addr.province),
  };

  if (propios.size === 0) {
    return { esRepartoPropio: false, departamento: senales.porCiudad, motivo: 'no hay departamentos de reparto propio configurados', senales };
  }

  const presentes = [senales.porCiudad, senales.porZip, senales.porProvince].filter(
    (d): d is string => !!d,
  );

  if (presentes.length === 0) {
    return {
      esRepartoPropio: false,
      departamento: null,
      motivo: 'no se pudo determinar el departamento del destino — va a DAC por defecto',
      senales,
    };
  }

  const aFavor = presentes.filter((d) => propios.has(d));
  const enContra = presentes.filter((d) => !propios.has(d));

  if (aFavor.length === 0) {
    return {
      esRepartoPropio: false,
      departamento: senales.porCiudad ?? senales.porZip ?? senales.porProvince,
      motivo: `destino en ${presentes[0]}, fuera de la zona de reparto propio`,
      senales,
    };
  }

  // Contradiccion: una senal dice zona propia y otra dice otro departamento.
  // Gana DAC — el paquete llega igual, que es lo que importa.
  if (enContra.length > 0) {
    const detalle = [
      senales.porCiudad ? `ciudad→${senales.porCiudad}` : null,
      senales.porZip ? `CP→${senales.porZip}` : null,
      senales.porProvince ? `provincia→${senales.porProvince}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return {
      esRepartoPropio: false,
      departamento: senales.porCiudad ?? senales.porZip ?? senales.porProvince,
      motivo: `señales contradictorias (${detalle}) — ante la duda va a DAC`,
      senales,
    };
  }

  const fuente = senales.porCiudad ? 'la ciudad' : senales.porZip ? 'el código postal' : 'la provincia';
  return {
    esRepartoPropio: true,
    departamento: aFavor[0],
    motivo: `destino en ${aFavor[0]} según ${fuente} — reparto propio, no se carga en DAC`,
    senales,
  };
}
