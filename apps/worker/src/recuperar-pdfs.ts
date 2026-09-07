/**
 * Recupera los PDFs de guías que SÍ se emitieron en DAC pero cuya etiqueta no
 * está donde el portal la busca.  [06-09-2026]
 *
 * DOS CAUSAS, UN MISMO ARREGLO:
 *
 *  1. Supabase restringió el proyecto por cuota de egress (402
 *     `exceed_egress_quota`). El worker emitía la guía en DAC —real y
 *     facturada—, bajaba el PDF, y recién ahí fallaba al subirlo: quedaron 152
 *     etiquetas con guía y sin PDF, marcadas NEEDS_REVIEW y sin cobrar.
 *  2. Para destrabar el despacho se mudó el storage a un proyecto nuevo. Las
 *     ~1.880 etiquetas que YA tenían `pdfPath` guardan la ruta, no el proyecto,
 *     así que su archivo quedó en el bucket anterior y los portales de Kinevia,
 *     Todo a Mano, Vastora, Curvadivina y Aura no muestran ningún PDF.
 *
 * En los dos casos la guía existe en DAC y el pegote se puede volver a bajar.
 *
 * POR QUÉ CORRE COMO JOB DEL WORKER. El login de DAC exige resolver un
 * reCAPTCHA y `CAPTCHA_API_KEY` sólo vive en Render. Corriendo desde afuera,
 * cada descarga falla en el login. Como job, hereda todas las variables del
 * servicio y ninguna clave tiene que salir de Render.
 *
 * POR QUÉ ES SEGURO:
 *   - `downloadLabel` es un GET a `/envios/getPegote?CodigoRastreo=<guia>`.
 *     NO puede crear un envío ni tocar el formulario de alta.
 *   - Sólo mira etiquetas que YA tienen `dacGuia` real (no `PENDING-`).
 *   - Le pregunta al bucket si el archivo está, así que es idempotente y
 *     reanudable: una corrida cortada a la mitad no repite lo hecho.
 *   - Cobra 1 crédito SÓLO si la etiqueta venía en NEEDS_REVIEW — el único
 *     estado que el worker dejó deliberadamente sin cobrar. Igual que el
 *     camino manual del dashboard (`labels/[id]/upload-pdf`), ya auditado.
 *
 * USO COMO CLI (necesita CAPTCHA_API_KEY en el entorno):
 *   npx tsx src/recuperar-pdfs.ts                    # simulacro
 *   npx tsx src/recuperar-pdfs.ts --aplicar --dias=3
 *
 * USO COMO JOB (lo normal): una fila en "Job" con type RECOVER_PDFS.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from './db';
import { decryptOrRaw, decryptIfPresent } from './encryption';
import { dacBrowser } from './dac/browser';
import { downloadLabel } from './dac/label';
import { uploadLabelPdf, existeEnStorage } from './storage/upload';
import { verificarStorage } from './storage/health';
import { deductCreditsAndStamp } from './credits';
import logger from './logger';

interface Pendiente {
  id: string;
  tenantId: string;
  tienda: string;
  orderName: string;
  guia: string;
  codAmount: number | null;
  status: string;
  pdfPath: string | null;
  dacUsername: string | null;
  dacPassword: string | null;
}

export interface OpcionesRecuperacion {
  aplicar: boolean;
  /**
   * Ventana en días. `PdfRetention` borra los PDFs a los 15, así que re-bajar
   * algo más viejo es trabajo tirado: el portal no lo muestra y el worker lo
   * va a borrar igual.
   */
  dias: number;
  soloTienda?: string | null;
  /** Tope de descargas de esta corrida, para ir por etapas. */
  tope?: number;
  /** Adónde va el progreso: consola en el CLI, RunLog en el job. */
  log: (linea: string) => void | Promise<void>;
}

export interface ResultadoRecuperacion {
  candidatas: number;
  recuperadas: number;
  yaEstaban: number;
  fallidas: number;
  storageOk: boolean;
}

export async function recuperarPdfs(op: OpcionesRecuperacion): Promise<ResultadoRecuperacion> {
  const log = async (s: string) => { await op.log(s); };
  const vacio: ResultadoRecuperacion = {
    candidatas: 0, recuperadas: 0, yaEstaban: 0, fallidas: 0, storageOk: false,
  };

  const filtroTienda = op.soloTienda ? `AND t.name = '${op.soloTienda.replace(/'/g, "''")}'` : '';
  const pendientes = await db.$queryRawUnsafe<Pendiente[]>(`
    SELECT l.id, l."tenantId", t.name AS tienda, l."shopifyOrderName" AS "orderName",
           l."dacGuia" AS guia, l."codAmount", l.status, l."pdfPath",
           t."dacUsername", t."dacPassword"
    FROM "Label" l JOIN "Tenant" t ON t.id = l."tenantId"
    WHERE l."dacGuia" IS NOT NULL
      AND l."dacGuia" NOT LIKE 'PENDING-%'
      AND l.status IN ('NEEDS_REVIEW', 'CREATED', 'COMPLETED')
      AND l."createdAt" > NOW() - INTERVAL '${Math.max(1, Math.floor(op.dias))} days'
      ${filtroTienda}
    ORDER BY t.name, l."createdAt" DESC
  `);

  if (pendientes.length === 0) {
    await log('No hay candidatas en la ventana pedida.');
    return { ...vacio, storageOk: true };
  }

  const porTienda = new Map<string, Pendiente[]>();
  for (const p of pendientes) {
    const l = porTienda.get(p.tenantId) ?? [];
    l.push(p);
    porTienda.set(p.tenantId, l);
  }
  await log(
    `${pendientes.length} candidata(s) en ${porTienda.size} tienda(s), últimos ${op.dias} días. ` +
    'Las que ya estén en el bucket se saltean.',
  );

  // Sin storage no tiene ningún sentido abrir DAC.
  const st = await verificarStorage();
  if (!st.escribible) {
    await log(`Storage NO escribible: ${st.error}. No se recupera nada.`);
    return vacio;
  }
  if (!op.aplicar) {
    await log('Simulacro: storage OK, no se tocó nada.');
    return { ...vacio, candidatas: pendientes.length, storageOk: true };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recuperar-pdfs-'));
  let recuperadas = 0;
  let yaEstaban = 0;
  let fallidas = 0;
  const tope = op.tope && op.tope > 0 ? op.tope : Number.POSITIVE_INFINITY;

  try {
    for (const [tenantId, lista] of porTienda) {
      if (recuperadas >= tope) break;
      const usuario = decryptOrRaw(lista[0].dacUsername);
      const clave = decryptIfPresent(lista[0].dacPassword);
      if (!usuario || !clave) {
        fallidas += lista.length;
        await log(`${lista[0].tienda}: sin credenciales de DAC, se saltea (${lista.length})`);
        continue;
      }

      // Descartar sin abrir el navegador lo que ya está en el bucket.
      const faltan: Pendiente[] = [];
      for (const p of lista) {
        if (p.pdfPath && (await existeEnStorage(p.pdfPath))) yaEstaban++;
        else faltan.push(p);
      }
      if (faltan.length === 0) {
        await log(`${lista[0].tienda}: las ${lista.length} ya estaban en el bucket.`);
        continue;
      }
      await log(`${lista[0].tienda}: ${faltan.length} para bajar (de ${lista.length}).`);

      const page = await dacBrowser.getPage();
      try {
        for (const p of faltan) {
          if (recuperadas >= tope) break;
          try {
            const actual = await db.label.findUnique({
              where: { id: p.id }, select: { pdfPath: true, status: true },
            });
            if (!actual) continue;
            if (actual.pdfPath && (await existeEnStorage(actual.pdfPath))) { yaEstaban++; continue; }

            const archivo = await downloadLabel(page, p.guia, tmp, usuario, clave);
            const buffer = fs.readFileSync(archivo);
            if (buffer.subarray(0, 5).toString('utf-8') !== '%PDF-') {
              throw new Error('lo que bajó DAC no es un PDF');
            }
            const subida = await uploadLabelPdf(tenantId, p.id, buffer);
            if (subida.error) throw new Error(`subida al storage: ${subida.error}`);

            // Sólo se cobra lo que el worker dejó explícitamente sin cobrar.
            const seCobra = actual.status === 'NEEDS_REVIEW';
            await db.$transaction(async (tx) => {
              await tx.label.update({
                where: { id: p.id },
                data: { status: 'COMPLETED', pdfPath: subida.path, errorMessage: null },
              });
              await tx.runLog.create({
                data: {
                  tenantId, jobId: null, level: 'INFO', message: 'label-manual-pdf-upload',
                  meta: {
                    labelId: p.id, shopifyOrderName: p.orderName,
                    previousStatus: actual.status, previousPdfPath: actual.pdfPath,
                    newPdfPath: subida.path, billed: seCobra,
                    triggeredBy: 'recuperar-pdfs-2026-09-06',
                  },
                },
              });
            });
            // Fuera de la transacción, igual que el endpoint: un fallo de cobro
            // no revierte una subida ya hecha.
            if (seCobra) await deductCreditsAndStamp(tenantId, 1);

            fs.unlinkSync(archivo);
            recuperadas++;
            if (recuperadas % 25 === 0) await log(`… ${recuperadas} recuperadas`);
          } catch (err) {
            fallidas++;
            await log(`${p.orderName} (guía ${p.guia}): ${(err as Error).message.slice(0, 160)}`);
          }
        }
      } finally {
        await dacBrowser.closePage().catch(() => {});
      }
    }
  } finally {
    await dacBrowser.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  await log(`RESULTADO: ${recuperadas} recuperadas · ${yaEstaban} ya estaban · ${fallidas} sin recuperar`);
  return { candidatas: pendientes.length, recuperadas, yaEstaban, fallidas, storageOk: true };
}

/* ─── CLI ──────────────────────────────────────────────────────────────── */

if (process.argv[1]?.includes('recuperar-pdfs')) {
  const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
  const dias = Number.parseInt(arg('dias') ?? '', 10);
  const tope = Number.parseInt(arg('tope') ?? '', 10);
  recuperarPdfs({
    aplicar: process.argv.includes('--aplicar'),
    dias: Number.isFinite(dias) && dias > 0 ? dias : 20,
    soloTienda: arg('tienda') ?? null,
    tope: Number.isFinite(tope) && tope > 0 ? tope : undefined,
    log: (s) => console.log(s),
  })
    .then((r) => console.log(JSON.stringify(r)))
    .catch((e) => {
      logger.error({ error: (e as Error).message }, 'recuperar-pdfs falló');
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
