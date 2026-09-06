/**
 * Recupera los PDFs de guías que SÍ se emitieron en DAC pero quedaron sin
 * etiqueta imprimible.  [06-09-2026]
 *
 * QUÉ PASÓ. Supabase restringió el proyecto por cuota de egress:
 *
 *   402 — "Service for this project is restricted due to the following
 *          violations: exceed_egress_quota. The project owner must upgrade
 *          their plan or remove spend caps to restore service."
 *
 * El worker igual emitía la guía en DAC (real, facturada al cliente), bajaba el
 * PDF, y recién ahí fallaba al subirlo. `process-orders.job.ts` hace lo correcto
 * en ese caso: marca la etiqueta NEEDS_REVIEW y **no cobra el crédito**. Pero el
 * PDF se pierde, así que el comerciante tiene una guía que no puede imprimir.
 *
 * QUÉ HACE ESTE SCRIPT. Por cada etiqueta NEEDS_REVIEW con guía real y sin
 * `pdfPath`: vuelve a bajar el pegote de DAC, lo sube al storage y la marca
 * COMPLETED, cobrando 1 crédito — exactamente la misma semántica que el camino
 * manual del dashboard (`app/api/v1/labels/[id]/upload-pdf/route.ts`), que es
 * el que ya estaba auditado.
 *
 * POR QUÉ ES SEGURO:
 *   - `downloadLabel` es un GET a `/envios/getPegote?CodigoRastreo=<guia>` con
 *     la cookie de sesión. NO puede crear un envío ni tocar el formulario.
 *   - Sólo mira etiquetas que YA tienen `dacGuia` real (no `PENDING-`), así que
 *     no hay forma de que emita una guía nueva.
 *   - Es idempotente: si la etiqueta ya tiene `pdfPath`, la saltea.
 *   - Arranca en SIMULACRO. Sin `--aplicar` no escribe nada.
 *   - Chequea el storage ANTES de abrir el navegador: si sigue bloqueado, corta
 *     sin loguearse a DAC ni una vez.
 *
 * USO:
 *   npx tsx src/recuperar-pdfs.ts                # simulacro: dice qué haría
 *   npx tsx src/recuperar-pdfs.ts --aplicar      # recupera de verdad
 *   npx tsx src/recuperar-pdfs.ts --aplicar --tienda=CarHub
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from './db';
import { decryptOrRaw, decryptIfPresent } from './encryption';
import { dacBrowser } from './dac/browser';
import { downloadLabel } from './dac/label';
import { uploadLabelPdf } from './storage/upload';
import { verificarStorage } from './storage/health';
import { deductCreditsAndStamp } from './credits';
import logger from './logger';

const APLICAR = process.argv.includes('--aplicar');
const SOLO_TIENDA = process.argv.find((a) => a.startsWith('--tienda='))?.split('=')[1] ?? null;

interface Pendiente {
  id: string;
  tenantId: string;
  tienda: string;
  orderName: string;
  guia: string;
  codAmount: number | null;
  status: string;
  dacUsername: string | null;
  dacPassword: string | null;
}

async function main() {
  console.log(APLICAR ? '=== RECUPERACIÓN REAL ===' : '=== SIMULACRO (sin --aplicar no se escribe nada) ===');

  const pendientes = await db.$queryRawUnsafe<Pendiente[]>(`
    SELECT l.id, l."tenantId", t.name AS tienda, l."shopifyOrderName" AS "orderName",
           l."dacGuia" AS guia, l."codAmount", l.status,
           t."dacUsername", t."dacPassword"
    FROM "Label" l JOIN "Tenant" t ON t.id = l."tenantId"
    -- Los dos estados que acepta el camino manual del dashboard
    -- (labels/[id]/upload-pdf): en revision, o creada pero sin PDF. El cobro
    -- distingue despues: solo NEEDS_REVIEW se cobra, porque es el unico que el
    -- worker dejo explicitamente sin cobrar.
    WHERE l.status IN ('NEEDS_REVIEW', 'CREATED')
      AND l."dacGuia" IS NOT NULL
      AND l."dacGuia" NOT LIKE 'PENDING-%'
      AND l."pdfPath" IS NULL
      ${SOLO_TIENDA ? `AND t.name = '${SOLO_TIENDA.replace(/'/g, "''")}'` : ''}
    ORDER BY t.name, l."createdAt"
  `);

  if (pendientes.length === 0) {
    console.log('No hay nada que recuperar.');
    return;
  }

  const porTienda = new Map<string, Pendiente[]>();
  for (const p of pendientes) {
    const l = porTienda.get(p.tenantId) ?? [];
    l.push(p);
    porTienda.set(p.tenantId, l);
  }

  console.log(`${pendientes.length} etiqueta(s) para recuperar, en ${porTienda.size} tienda(s):`);
  for (const [, lista] of porTienda) {
    const cod = lista.filter((x) => x.codAmount !== null).length;
    const aCobrar = lista.filter((x) => x.status === 'NEEDS_REVIEW').length;
    console.log(
      `  · ${lista[0].tienda}: ${lista.length}` +
      ` (${aCobrar} se cobran, ${lista.length - aCobrar} ya estaban cobradas)` +
      `${cod ? ` · ${cod} contrareembolso` : ''}`,
    );
  }

  // Preflight: sin storage no tiene sentido tocar DAC.
  const st = await verificarStorage();
  console.log(`\nStorage: ${st.escribible ? 'ESCRIBIBLE ✅' : `BLOQUEADO ❌ — ${st.error}`}`);
  if (!st.escribible) {
    console.log(
      '\nNo se recupera nada hasta que el storage vuelva. Si el mensaje dice\n' +
      '"exceed_egress_quota", hay que subir el plan o sacar el spend cap en\n' +
      'el panel de Supabase del proyecto. Después, volvé a correr esto.',
    );
    return;
  }

  if (!APLICAR) {
    console.log('\nSimulacro: no se tocó nada. Corré con --aplicar para recuperarlas.');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'recuperar-pdfs-'));
  let ok = 0;
  const fallidas: Array<{ orderName: string; guia: string; motivo: string }> = [];

  for (const [tenantId, lista] of porTienda) {
    const usuario = decryptOrRaw(lista[0].dacUsername);
    const clave = decryptIfPresent(lista[0].dacPassword);
    if (!usuario || !clave) {
      for (const p of lista) fallidas.push({ orderName: p.orderName, guia: p.guia, motivo: 'la tienda no tiene credenciales de DAC' });
      continue;
    }

    console.log(`\n--- ${lista[0].tienda} (${lista.length}) ---`);
    const page = await dacBrowser.getPage();

    // 🔴 Reusar la sesión que el worker YA guardó en `DacSession`.
    // Sin esto, `downloadLabel` hace un login completo, que en DAC exige
    // resolver un reCAPTCHA — y esa clave (`CAPTCHA_API_KEY`) sólo vive en
    // Render. Corriendo desde afuera, cada descarga fallaba en el login.
    // Con las cookies puestas, `ensureLoggedIn` ve la sesión viva y no
    // vuelve a autenticar.
    const conSesion = await dacBrowser.loadCookies(tenantId).catch(() => false);
    console.log(conSesion
      ? '  (sesión de DAC reutilizada, sin login)'
      : '  (sin sesión guardada: va a intentar login — necesita CAPTCHA_API_KEY)');
    try {
      for (const p of lista) {
        try {
          // Re-chequeo por si otra corrida la resolvió mientras tanto.
          const actual = await db.label.findUnique({ where: { id: p.id }, select: { pdfPath: true, status: true } });
          if (!actual || actual.pdfPath) {
            console.log(`  ${p.orderName}: ya tenía PDF, se saltea`);
            continue;
          }

          const archivo = await downloadLabel(page, p.guia, tmp, usuario, clave);
          const buffer = fs.readFileSync(archivo);
          if (buffer.subarray(0, 5).toString('utf-8') !== '%PDF-') {
            throw new Error('lo que bajó DAC no es un PDF');
          }

          const subida = await uploadLabelPdf(tenantId, p.id, buffer);
          if (subida.error) throw new Error(`subida al storage: ${subida.error}`);

          // Misma transacción y mismo audit log que el camino manual del
          // dashboard, para que las dos vías queden indistinguibles.
          const eraNeedsReview = actual.status === 'NEEDS_REVIEW';
          await db.$transaction(async (tx) => {
            await tx.label.update({
              where: { id: p.id },
              data: { status: 'COMPLETED', pdfPath: subida.path, errorMessage: null },
            });
            await tx.runLog.create({
              data: {
                tenantId, jobId: null, level: 'INFO',
                message: 'label-manual-pdf-upload',
                meta: {
                  labelId: p.id, shopifyOrderName: p.orderName,
                  previousStatus: actual.status, previousPdfPath: null,
                  newPdfPath: subida.path, billed: eraNeedsReview,
                  triggeredBy: 'recuperar-pdfs-2026-09-06',
                },
              },
            });
          });
          // Fuera de la transacción, igual que el endpoint: si falla el cobro
          // no se revierte una subida que ya está hecha.
          if (eraNeedsReview) await deductCreditsAndStamp(tenantId, 1);

          fs.unlinkSync(archivo);
          ok++;
          console.log(`  ${p.orderName}: ✅ guía ${p.guia}${p.codAmount ? ` · COD $${p.codAmount}` : ''}`);
        } catch (err) {
          const motivo = (err as Error).message;
          fallidas.push({ orderName: p.orderName, guia: p.guia, motivo });
          console.log(`  ${p.orderName}: ❌ ${motivo}`);
        }
      }
    } finally {
      await dacBrowser.closePage().catch(() => {});
    }
  }

  await dacBrowser.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n=== RESULTADO: ${ok} recuperada(s), ${fallidas.length} sin recuperar ===`);
  for (const f of fallidas) console.log(`  ${f.orderName} (guía ${f.guia}): ${f.motivo}`);
  if (fallidas.length > 0) {
    console.log('\nLas que fallaron siguen en NEEDS_REVIEW y no se cobraron: se puede volver a correr.');
  }
}

main()
  .catch((e) => {
    logger.error({ error: (e as Error).message }, 'recuperar-pdfs falló');
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
