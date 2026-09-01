/**
 * Departamentos de Uruguay + discriminador "esto lo repartimos nosotros".
 *
 * ⚠️ `normalizarDepartamento()` es una COPIA LITERAL de
 * `apps/worker/src/self-delivery/zone.ts`. NO es un descuido y no se puede
 * reemplazar por un import:
 *
 *   - El Dockerfile del worker NO mete `packages/` en el build context (rootDir
 *     = apps/worker en Render), así que mover la función a `packages/shared`
 *     rompería el build del worker.
 *   - apps/web no puede importar de apps/worker: son dos builds separados
 *     (Vercel / Render) con tsconfigs distintos y ningún path alias entre ellos.
 *
 * Regla de mantenimiento: si cambia la lista de departamentos o la
 * normalización en un lado, cambia en los dos. Los tests de este archivo
 * (`lib/__tests__/departamentos.test.ts`) incluyen los mismos casos que los del
 * worker justamente para que una divergencia se note.
 *
 * Módulo PURO: sin Prisma, sin node:crypto, sin next/server. El portal es un
 * componente cliente y lo importa, así que no puede arrastrar nada de servidor.
 */

/** Los 19 departamentos, en la grafía canónica que usa uruguay-geo (sin tildes). */
const DEPARTAMENTOS_CANONICOS = [
  'Artigas', 'Canelones', 'Cerro Largo', 'Colonia', 'Durazno', 'Flores',
  'Florida', 'Lavalleja', 'Maldonado', 'Montevideo', 'Paysandu', 'Rio Negro',
  'Rivera', 'Rocha', 'Salto', 'San Jose', 'Soriano', 'Tacuarembo',
  'Treinta y Tres',
];

/**
 * Lleva un texto de departamento a la grafía canónica, o null si no reconoce.
 * Tolera lo que realmente escriben los clientes en el checkout de Shopify:
 * tildes, mayúsculas, "Depto.", "Departamento de", sufijo "Department" (que
 * es lo que manda Shopify en inglés), y separadores raros.
 *
 * En prod `Label.department` está sucio a propósito de nadie: conviven
 * "Paysandu" y "Paysandú", hay 15 filas vacías y hasta un "Valencia". Por eso
 * TODO lo que lea ese campo tiene que pasar por acá primero.
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

/**
 * Prefijo de las guías que emite LabelFlow para su propio reparto (la etiqueta
 * propia de `apps/worker/src/self-delivery/`). DAC nunca emite guías con este
 * prefijo, así que es un discriminador sin falsos positivos.
 */
export const LF_GUIA_PREFIX = 'LF-';

/**
 * Departamentos que hoy se reparten con logística propia. Es la MISMA lista
 * que el default de `selfDeliveryDepartments` del worker; vive acá aparte
 * porque el portal y el export son read-only y no leen la config del tenant.
 */
export const DEPARTAMENTOS_REPARTO_PROPIO = ['Maldonado'];

/** Forma mínima que el discriminador necesita de una etiqueta. */
export interface EtiquetaZonificable {
  dacGuia?: string | null;
  department?: string | null;
}

/**
 * Discriminador de reparto propio, por UNIÓN de dos señales:
 *
 *   1. la guía empieza con "LF-"  → la emitió el reparto propio de LabelFlow,
 *      no hay nada que discutir; y
 *   2. el departamento normalizado está en la lista de reparto propio.
 *
 * Es UNIÓN y no intersección a propósito. Hoy (2026-09-01) no existe ni una
 * fila con guía "LF-" en toda la base y `selfDeliveryEnabled` está en false en
 * todos los tenants, así que en la práctica manda la señal (2). Cuando el
 * reparto propio se prenda, las etiquetas nuevas van a traer "LF-" y las
 * viejas de Maldonado (que salieron por DAC) tienen que seguir cayendo en el
 * mismo grupo: si esto fuera una intersección, el día del switch la pila se
 * partiría en dos por un detalle de implementación.
 */
export function esRepartoPropio(
  label: EtiquetaZonificable,
  departamentosPropios: string[] = DEPARTAMENTOS_REPARTO_PROPIO,
): boolean {
  const guia = (label.dacGuia ?? '').trim().toUpperCase();
  if (guia.startsWith(LF_GUIA_PREFIX)) return true;

  const dept = normalizarDepartamento(label.department);
  if (!dept) return false;

  return departamentosPropios
    .map((d) => normalizarDepartamento(d))
    .filter((d): d is string => !!d)
    .includes(dept);
}
