/**
 * GET /api/v1/control/depo-etiquetas?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&soloDeposito=1
 *
 * Cuántas etiquetas se emitieron en un rango, DISTRIBUIDAS POR CLIENTE (cada
 * marca del depósito es una tienda). Hasta acá ese número había que sacarlo
 * tienda por tienda desde Control.
 *
 * Devuelve sólo el resumen. Para ver las etiquetas de UN cliente ya existe
 * `/api/v1/control/labels?tenantId=<id>`, que es lo que abre el detalle: acá no
 * se duplica esa consulta ni su lógica de privacidad.
 *
 * ── Estados incluidos ────────────────────────────────────────────────────────
 * CREATED y COMPLETED: el mismo conjunto de "envío realmente emitido" que usa
 * el export al WMS. Las PENDING todavía no tienen guía y FAILED / SKIPPED /
 * NEEDS_REVIEW no se despacharon, así que contarlas inflaría el número.
 *
 * ── Fechas ───────────────────────────────────────────────────────────────────
 * `desde` y `hasta` son días LOCALES de Uruguay (inclusive los dos), resueltos
 * con `uyDayRange()`, el mismo helper del export al WMS. Sin parámetros: los
 * últimos 30 días uruguayos terminando hoy.
 *
 * ── Alcance y privacidad ─────────────────────────────────────────────────────
 * Usa `controlTenantWhere()`: un usuario normal ve sólo sus tiendas; el admin
 * ve además las activas de todos. Devuelve CONTEOS, nunca nombres, teléfonos ni
 * direcciones de compradores — aun así se registra el acceso a tenants ajenos,
 * porque sigue siendo un operador mirando la operación de un cliente.
 */
import { NextRequest } from 'next/server';
import { LabelStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { apiError, apiSuccess } from '@/lib/api-utils';
import { getControlActor, controlTenantWhere, auditControlAccess } from '@/lib/control-scope';
import { uyDayRange, uyToday, YMD_REGEX } from '@/lib/wms-export';
import { resumirDeposito, type EtiquetaDeposito } from '@/lib/depo-etiquetas';

/** Envío realmente emitido. Mismo conjunto que el export al WMS. */
const DESPACHADAS: LabelStatus[] = [LabelStatus.CREATED, LabelStatus.COMPLETED];

/** Días por defecto hacia atrás cuando no mandan `desde`. */
const DIAS_POR_DEFECTO = 30;

/**
 * Tope de filas que se traen a memoria.
 *
 * No es un límite de negocio, es un cinturón: si alguien pide un rango de dos
 * años, mejor devolver un total marcado como PARCIAL que tumbar el proceso. La
 * respuesta trae `truncado: true` para que la UI lo diga en pantalla — un total
 * recortado en silencio es peor que no tenerlo.
 */
const TOPE_FILAS = 50_000;

/** Resta días a un `YYYY-MM-DD` sin arrastrar zona horaria. */
function restarDias(ymd: string, dias: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - dias * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  const actor = await getControlActor();
  if (!actor) return apiError('No autorizado', 401);

  const sp = req.nextUrl.searchParams;
  const hasta = sp.get('hasta') || uyToday();
  const desde = sp.get('desde') || restarDias(hasta, DIAS_POR_DEFECTO - 1);

  if (!YMD_REGEX.test(desde) || !YMD_REGEX.test(hasta)) {
    return apiError('Fechas inválidas: se espera YYYY-MM-DD', 422);
  }
  const rangoDesde = uyDayRange(desde);
  const rangoHasta = uyDayRange(hasta);
  if (!rangoDesde || !rangoHasta) return apiError('Fechas inválidas', 422);
  if (rangoDesde.gte >= rangoHasta.lt) {
    return apiError('El rango está al revés: "desde" tiene que ser anterior a "hasta"', 422);
  }

  // Por defecto sólo las tiendas del depósito, que es lo que se vino a mirar.
  // `soloDeposito=0` muestra todas — sirve para comprobar que no falte ninguna.
  const soloDeposito = (sp.get('soloDeposito') ?? '1') !== '0';

  // Qué hace que una tienda sea "del depósito". Son las dos señales que YA
  // existen en Tenant, sin columna nueva:
  //   - slug `ae-depo-*`  → el alta la hizo DEPO (mismo criterio que /control).
  //   - portalSplitZonas  → tiene prendido el corte por zona del portal, que es
  //     la operación de dos pilas del depósito.
  // Es la única definición del sistema y hasta acá vivía sólo en la vista de
  // Control; queda escrita también acá para que las dos no se separen.
  const tenants = await db.tenant.findMany({
    where: controlTenantWhere(actor),
    select: { id: true, name: true, slug: true, portalSplitZonas: true },
  });

  const meta = new Map(
    tenants.map((t) => [
      t.id,
      {
        name: t.name,
        esDeposito:
          (typeof t.slug === 'string' && t.slug.startsWith('ae-depo-')) || t.portalSplitZonas === true,
      },
    ]),
  );

  const idsVisibles = tenants.map((t) => t.id);
  const ids = soloDeposito ? idsVisibles.filter((id) => meta.get(id)?.esDeposito) : idsVisibles;

  if (ids.length === 0) {
    return apiSuccess({ desde, hasta, soloDeposito, truncado: false, clientes: [], total: 0 });
  }

  const filas = await db.label.findMany({
    where: {
      tenantId: { in: ids },
      status: { in: DESPACHADAS },
      createdAt: { gte: rangoDesde.gte, lt: rangoHasta.lt },
    },
    // Sólo lo necesario para contar. Nada de datos del comprador.
    select: { tenantId: true },
    take: TOPE_FILAS + 1,
  });

  const truncado = filas.length > TOPE_FILAS;
  const usadas = truncado ? filas.slice(0, TOPE_FILAS) : filas;

  const entrada: EtiquetaDeposito[] = usadas.map((l) => {
    const m = meta.get(l.tenantId);
    return {
      tenantId: l.tenantId,
      tenantName: m?.name ?? 'Tienda sin nombre',
      esDeposito: m?.esDeposito ?? false,
    };
  });

  const resumen = resumirDeposito(entrada);

  // Queda registro de que un operador miró la operación de un cliente ajeno.
  // Sólo de las tiendas que efectivamente aparecen en el resultado.
  await Promise.all(
    resumen.clientes.map((c) => auditControlAccess(actor, c.tenantId, 'control.depo-etiquetas.read')),
  );

  return apiSuccess({ desde, hasta, soloDeposito, truncado, ...resumen });
}
