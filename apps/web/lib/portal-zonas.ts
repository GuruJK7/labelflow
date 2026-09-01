/**
 * Corte por zona DENTRO de cada día del portal del cliente: la pila que sale a
 * repartir LabelFlow y la que se despacha por DAC. Son dos operaciones físicas
 * distintas (una la carga el repartidor en la camioneta, la otra va al
 * mostrador de DAC), así que se imprimen y se cuentan por separado.
 *
 * ⚠️ ESTÁ GATEADO POR TENANT (`Tenant.portalSplitZonas`, default false). Con el
 * gate apagado se devuelve UN SOLO grupo con las etiquetas TAL CUAL vinieron:
 * mismo orden, sin subtítulo de zona (el portal dibuja el subtítulo sólo cuando
 * hay más de un grupo) y con los mismos botones que antes de esta feature. Los
 * 4 portales que ya existen (Curvadivina, Onix, Vastora, Aura) despachan todo
 * por DAC: partirles el día en dos pilas les cambiaría el orden de impresión y
 * les agregaría controles que nadie pidió.
 *
 * El discriminador es esRepartoPropio() de lib/departamentos.ts — EL MISMO que
 * usa el export al WMS. Si acá se usara otra regla, el operador vería una pila
 * en pantalla y DEPO recibiría otra.
 *
 * Módulo PURO: sin Prisma, sin node:crypto, sin next/server. Lo importa un
 * componente cliente ('use client'), así que no puede arrastrar nada de
 * servidor. Vive acá y no dentro del componente para poder testearlo sin
 * levantar React (ver lib/__tests__/portal-zonas.test.ts).
 */
import { esRepartoPropio } from './departamentos';
import type { ClientViewLabel } from './client-view';

export interface ZonaDelDia {
  key: 'propio' | 'resto' | 'todas';
  titulo: string;
  items: ClientViewLabel[];
}

/**
 * Parte las etiquetas de UN día en las zonas que se imprimen por separado.
 *
 * Se devuelven sólo los grupos con etiquetas: un día que es todo DAC no tiene
 * por qué mostrar un encabezado "Maldonado" vacío.
 */
export function zonasDelDia(
  items: ClientViewLabel[],
  splitZonas: boolean,
): ZonaDelDia[] {
  if (!splitZonas) {
    return items.length > 0
      ? [{ key: 'todas' as const, titulo: 'Todas', items }]
      : [];
  }

  const propio: ClientViewLabel[] = [];
  const resto: ClientViewLabel[] = [];
  for (const l of items) {
    if (esRepartoPropio(l)) propio.push(l);
    else resto.push(l);
  }
  return [
    { key: 'propio' as const, titulo: 'Maldonado (reparto propio)', items: propio },
    { key: 'resto' as const, titulo: 'Todo Uruguay', items: resto },
  ].filter((z) => z.items.length > 0);
}
