/**
 * AutoEnvía Dashboard source — processor.
 *
 * Fuente PARALELA a Shopify: trae los pedidos confirmados del dashboard
 * (autoenvia-dash), crea la guía en DAC reusando el MISMO motor (createShipment),
 * y marca cargadas en el dashboard. Reusa los primitivos de DAC/créditos/lock y
 * REPLICA las mismas guardas de robustez del job de Shopify (reconcile de
 * huérfanas, filtro de stuck-PendingShipment C-4, checkpoint de successCount por
 * orden + drain de créditos en el path de crash).
 *
 * AISLAMIENTO de Shopify (regla dura): este archivo NO importa NADA de ../shopify.
 * No puede tocar Shopify ni físicamente. El writeback es POST /api/v1/orders/loaded
 * (no fulfillOrderWithTracking/markOrderProcessed). Corre bajo el MISMO
 * withTenantDacLock(tenantId) que el job de Shopify, así nunca usan DAC a la vez.
 * Pensado para un tenant DEDICADO (sin pedidos Shopify) -> sin colisión de dedup.
 */
import path from 'path';
import fs from 'fs';
import { db } from '../db';
import { deductCreditsAndStamp } from '../credits';
import { getCreditHolderTenantId } from '../credit-holder';
import { decryptIfPresent, decryptOrRaw } from '../encryption';
import { getConfig } from '../config';
import { dacBrowser } from '../dac/browser';
import { smartLogin } from '../dac/auth';
import { createShipment, DuplicateSubmitError, DacAddressRejectedError } from '../dac/shipment';
import { reconcileOrphansForTenant } from '../dac/orphan-reconcile';
import { withTenantDacLock, DacLockHeldError } from '../dac/tenant-lock';
import { downloadLabel } from '../dac/label';
import { uploadLabelPdf } from '../storage/upload';
import { buildSafeLabelGeoFields } from './label-safe-fields';
import { createStepLogger } from '../logger';
import logger from '../logger';
import { shadowRecordShipment } from '../billing/shadow';
import { sleep } from '../utils';
import { getConfirmedDashboardOrders, markDashboardOrdersLoaded, pushDashboardLabels, type DashboardLabelResult } from '../dashboard/orders';
import { toShopifyOrder, stableNumericId } from '../dashboard/adapter';

const DELAY_BETWEEN_ORDERS_MS = 500;
const DASHBOARD_FETCH_LIMIT = 100;

/** Entry point (router). Toma el lease DAC del tenant; si está ocupado, re-encola.
 *  Es exactamente el mismo patrón que processOrdersJob (Shopify). */
export async function processDashboardOrdersJob(tenantId: string, jobId: string): Promise<void> {
  try {
    await withTenantDacLock(tenantId, jobId, () => processDashboardOrdersJobInner(tenantId, jobId));
  } catch (err) {
    if (err instanceof DacLockHeldError) {
      logger.warn({ tenantId, jobId, heldBy: err.holderId }, '[DAC-Lock] Tenant lease busy — re-queueing dashboard job to PENDING');
      await db.job
        .update({ where: { id: jobId }, data: { status: 'PENDING', startedAt: null, errorMessage: `Deferred: DAC lease held by ${err.holderId}` } })
        .catch((updateErr) => logger.error({ tenantId, jobId, error: (updateErr as Error).message }, '[DAC-Lock] Failed to re-queue deferred dashboard job'));
      return;
    }
    throw err;
  }
}

async function processDashboardOrdersJobInner(tenantId: string, jobId: string): Promise<void> {
  const startTime = Date.now();
  let successCount = 0;
  let failedCount = 0;
  let reviewCount = 0;
  let skippedCount = 0;
  let totalOrders = 0;
  let browserOpen = false;
  let billed = false; // true tras un deduct exitoso -> el catch NO vuelve a cobrar

  // Hoisted para el drain del path de crash (mirror del job de Shopify):
  let dashboardUrl: string | null = null;
  let dashboardToken: string | null = null;
  const loadedIds: string[] = [];
  // Órdenes con guía + PDF imprimible → writeback ENRIQUECIDO (guía + PDF) a
  // AutoEnvía, para que el cliente imprima desde su dashboard. El resto va legacy.
  const labelResults: DashboardLabelResult[] = [];

  const slog = createStepLogger(jobId, tenantId);
  const config = getConfig();

  try {
    await db.job.update({ where: { id: jobId }, data: { status: 'RUNNING', startedAt: new Date() } });

    // STEP 1: tenant + credenciales
    const tenant = await db.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      slog.error('config', 'Tenant not found');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Tenant not found' } });
      return;
    }

    dashboardUrl = tenant.dashboardUrl;
    dashboardToken = decryptIfPresent(tenant.dashboardToken);
    const dashboardEnabled = !!tenant.dashboardSourceEnabled;
    const dacUsername = decryptOrRaw(tenant.dacUsername);
    const dacPassword = decryptIfPresent(tenant.dacPassword);

    if (!dashboardEnabled || !dashboardUrl || !dashboardToken) {
      slog.error('config', 'Dashboard source not configured');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Missing dashboard config' } });
      return;
    }
    if (!dacUsername || !dacPassword) {
      slog.error('config', 'DAC credentials not configured');
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: 'Missing DAC config' } });
      return;
    }

    slog.info('start', 'Starting dashboard order processing cycle');

    // STEP 2: credit gate (mismo criterio que Shopify: saldo del holder)
    const holderId = await getCreditHolderTenantId(tenantId);
    const liveCredits = await db.tenant.findUnique({ where: { id: holderId }, select: { shipmentCredits: true, referralBonusCredits: true } });
    const availableCredits = (liveCredits?.shipmentCredits ?? 0) + (liveCredits?.referralBonusCredits ?? 0);
    if (availableCredits <= 0) {
      slog.warn('credits', `Tenant sin créditos al iniciar el run (saldo=${availableCredits}). Abortando sin procesar.`);
      await db.job.update({ where: { id: jobId }, data: { status: 'COMPLETED', totalOrders: 0, errorMessage: 'Sin créditos disponibles. Comprá un pack para continuar.', finishedAt: new Date(), durationMs: Date.now() - startTime } });
      return;
    }

    // STEP 3: traer confirmadas del dashboard
    let orders = await getConfirmedDashboardOrders(dashboardUrl, dashboardToken, DASHBOARD_FETCH_LIMIT);
    totalOrders = orders.length;
    slog.info('dashboard', `Fetched ${orders.length} confirmed orders from dashboard`);

    // STEP 3.1: filtro de stuck-PendingShipment (C-4) — una orden con
    // PendingShipment PENDING/ORPHANED necesita reconciliación del operador y NO
    // debe consumir slot de crédito cada run (incidente Shopify: 5 huérfanas
    // tomaban todos los slots y las nuevas nunca salían). Mismo criterio que
    // partitionByStuckPendingShipment del job de Shopify, sobre los ids derivados.
    if (orders.length > 0) {
      const derivedIds = orders.map((d) => String(stableNumericId(d.id)));
      const stuck = await db.pendingShipment.findMany({
        where: { tenantId, status: { in: ['PENDING', 'ORPHANED'] }, shopifyOrderId: { in: derivedIds } },
        select: { shopifyOrderId: true },
      });
      if (stuck.length > 0) {
        const stuckSet = new Set(stuck.map((s) => s.shopifyOrderId));
        const before = orders.length;
        orders = orders.filter((d) => !stuckSet.has(String(stableNumericId(d.id))));
        const dropped = before - orders.length;
        skippedCount += dropped;
        slog.warn('filter', `Skipped ${dropped} orden(es) con PendingShipment PENDING/ORPHANED (C-4): requieren reconciliación del operador (revisar historial DAC / desbloquear). No consumen slots, así fluyen las nuevas.`);
      }
    }

    // STEP 3.2: cap por crédito
    if (orders.length > availableCredits) {
      const dropped = orders.length - availableCredits;
      skippedCount += dropped;
      orders = orders.slice(0, availableCredits);
      slog.warn('credits', `Saldo de ${availableCredits} envíos: limitando a ${orders.length} órdenes, ${dropped} aplazadas hasta próxima recarga.`);
    }

    if (orders.length === 0) {
      await db.job.update({ where: { id: jobId }, data: { status: 'COMPLETED', totalOrders, successCount: 0, skippedCount, finishedAt: new Date(), durationMs: Date.now() - startTime } });
      slog.info('done', 'No hay órdenes confirmadas para procesar (tras filtros)');
      return;
    }

    // STEP 4: login DAC
    const page = await dacBrowser.getPage();
    browserOpen = true;
    try {
      await smartLogin(page, dacUsername, dacPassword, tenantId);
    } catch (loginErr) {
      slog.error('dac-login', `DAC login failed: ${(loginErr as Error).message}`);
      await db.job.update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: `DAC login failed: ${(loginErr as Error).message}`, finishedAt: new Date(), durationMs: Date.now() - startTime } });
      await dacBrowser.close();
      return;
    }

    // STEP 4.5: reconcile de huérfanas (mirror del STEP 3.5 de Shopify) — usa la
    // misma sesión DAC para rescatar PendingShipments ORPHANED. Best-effort: si
    // el scan de historial falla, NO tira abajo el ciclo.
    try {
      await reconcileOrphansForTenant(page, tenantId, slog);
    } catch (orphanErr) {
      slog.warn('orphan-reconcile', `Orphan reconcile pass threw — leaving orphans untouched, continuing: ${(orphanErr as Error).message}`);
    }

    const tmpDir = path.join(config.LABELS_TMP_DIR, new Date().toISOString().split('T')[0]);
    const usedGuias = new Set<string>();

    // STEP 5: por orden -> createShipment (DESTINATARIO + addressOverride)
    for (let i = 0; i < orders.length; i++) {
      const { order, override, dashboardId } = toShopifyOrder(orders[i]);
      const addr = order.shipping_address!;
      const customerName = `${addr.first_name ?? ''} ${addr.last_name ?? ''}`.trim() || 'Cliente';
      slog.info('order', `(${i + 1}/${orders.length}) ${order.name} — ${customerName} — ${addr.province || 'sin depto'}`);

      try {
        const result = await createShipment(page, order, 'DESTINATARIO', dacUsername, dacPassword, tenantId, jobId, usedGuias, override);
        if (result.guia && !result.guia.startsWith('PENDING-')) usedGuias.add(result.guia);
        slog.success('order-shipment', `DAC guía ${result.guia} para ${order.name}`);

        const { safeCity, safeDepartment } = buildSafeLabelGeoFields({ city: addr.city, province: addr.province, resolvedDepartment: addr.province || null });
        const labelRecord = await db.label.upsert({
          where: { tenantId_shopifyOrderId: { tenantId, shopifyOrderId: String(order.id) } },
          create: {
            tenantId, jobId,
            shopifyOrderId: String(order.id),
            shopifyOrderName: order.name,
            customerName,
            customerEmail: order.email,
            customerPhone: addr.phone,
            deliveryAddress: addr.address1,
            city: safeCity,
            department: safeDepartment,
            totalUyu: parseFloat(order.total_price) || 0,
            paymentType: 'DESTINATARIO',
            paymentStatus: result.paymentStatus ?? 'not_required',
            paymentFailureReason: result.paymentFailureReason ?? null,
            paymentAttemptedAt: null,
            dacGuia: result.guia,
            status: 'CREATED',
          },
          update: { jobId, dacGuia: result.guia, status: 'CREATED', errorMessage: null, autoRetryCount: 0 },
        });
        // Ledger en sombra (WALLET_SHADOW=1). Nunca lanza; no reemplaza el cobro real.
        await shadowRecordShipment({ tenantId, dacGuia: result.guia, labelId: labelRecord.id, jobId, at: labelRecord.createdAt });

        // PDF (best-effort, no bloquea el éxito)
        let pdfBase64: string | null = null;
        if (result.guia && !result.guia.startsWith('PENDING-')) {
          try {
            const labelLocalPath = await downloadLabel(page, result.guia, tmpDir, dacUsername, dacPassword);
            if (labelLocalPath && fs.existsSync(labelLocalPath)) {
              const pdfBuffer = fs.readFileSync(labelLocalPath);
              pdfBase64 = pdfBuffer.toString('base64'); // para el writeback enriquecido a AutoEnvía
              const upload = await uploadLabelPdf(tenantId, labelRecord.id, pdfBuffer);
              if (!upload.error) await db.label.update({ where: { id: labelRecord.id }, data: { pdfPath: upload.path, status: 'COMPLETED' } });
              try { fs.unlinkSync(labelLocalPath); } catch { /* best-effort */ }
            }
          } catch (dlErr) {
            slog.warn('order-pdf', `PDF download/upload falló: ${(dlErr as Error).message}`, { guia: result.guia });
          }
        }

        // Con guía real + PDF descargado → vía ENRIQUECIDA (con PDF). Sin PDF
        // (duplicado, descarga fallida) → sólo loadedIds (vía legacy, sin cambios).
        if (pdfBase64 && result.guia && !result.guia.startsWith('PENDING-')) {
          labelResults.push({
            order_id: dashboardId,
            status: 'labeled',
            tracking: result.guia,
            pdf_base64: pdfBase64,
            dac_account_used: dacUsername,
          });
        }
        loadedIds.push(dashboardId);
        successCount++;
        // Checkpoint del successCount por orden (mirror Shopify): si un crash
        // duro mata el proceso, el contador persistido evita el revenue-leak.
        await db.job
          .update({ where: { id: jobId }, data: { successCount: { increment: 1 } } })
          .catch((cpErr) => logger.warn({ tenantId, jobId, error: (cpErr as Error).message }, '[checkpoint] Failed to persist successCount mid-run (non-fatal)'));
      } catch (err) {
        if (err instanceof DuplicateSubmitError) {
          const existingGuia = (err as DuplicateSubmitError).existingGuia;
          if (existingGuia) {
            loadedIds.push(dashboardId);
            slog.warn('order-dup', `${order.name} ya tenía guía ${existingGuia} (C-4) — se marca cargada`);
          } else {
            slog.warn('order-dup', `${order.name}: PendingShipment sin guía (huérfana) — NO se marca cargada (la reconcilia el reconcile pass)`);
          }
        } else if (err instanceof DacAddressRejectedError) {
          reviewCount++;
          slog.warn('order-review', `${order.name}: DAC rechazó la dirección — queda para revisar (no se marca cargada)`);
        } else {
          failedCount++;
          slog.error('order-fail', `${order.name} falló: ${(err as Error).message}`);
        }
      }

      if (i < orders.length - 1) await sleep(DELAY_BETWEEN_ORDERS_MS);
    }

    // STEP 6: marcar cargadas en el dashboard (best-effort; el dedup de DAC es el backstop).
    //  6a: las que tienen PDF imprimible → writeback ENRIQUECIDO (guía + PDF), para
    //      que el cliente imprima desde AutoEnvía.
    //  6b: el resto (duplicados, PDF que no descargó) → writeback LEGACY { ids },
    //      comportamiento actual sin cambios.
    if (loadedIds.length) {
      const enrichedIds = new Set(labelResults.map((r) => r.order_id));
      const legacyIds = loadedIds.filter((id) => !enrichedIds.has(id));
      try {
        if (labelResults.length) {
          const labeled = await pushDashboardLabels(dashboardUrl, dashboardToken, labelResults);
          slog.info('dashboard', `Etiquetas enviadas a AutoEnvía con PDF: ${labeled}`);
        }
        if (legacyIds.length) {
          const updated = await markDashboardOrdersLoaded(dashboardUrl, dashboardToken, legacyIds);
          slog.info('dashboard', `Marcadas como cargadas (sin PDF): ${updated}`);
        }
      } catch (markErr) {
        slog.error('dashboard', `No se pudieron marcar cargadas (se reintentará el próximo run; createShipment dedup evita doble-envío): ${(markErr as Error).message}`);
      }
    }

    // STEP 7: cookies + cerrar browser + marcar COMPLETED. El deduct va DESPUÉS,
    // como ÚLTIMA operación del try (igual que el job de Shopify): así nada que
    // pueda lanzar queda después del cobro, y si algo de acá arriba lanza, el
    // control va al catch ANTES de cobrar y el drain cobra UNA sola vez.
    await dacBrowser.saveCookies(tenantId);
    await dacBrowser.close();
    browserOpen = false;

    await db.job.update({
      where: { id: jobId },
      // successCount NO se setea acá: ya quedó persistido por el checkpoint por-orden.
      data: { status: 'COMPLETED', totalOrders, failedCount, skippedCount, finishedAt: new Date(), durationMs: Date.now() - startTime },
    });

    // FACTURAR — última sentencia del try. El flag `billed` evita que el catch
    // re-cobre si el deduct ya corrió (deductCreditsAndStamp NO es idempotente).
    await deductCreditsAndStamp(tenantId, successCount);
    billed = true;
    slog.success('done', `Dashboard run OK: ${successCount} ok · ${failedCount} fallidas · ${reviewCount} a revisar · ${skippedCount} aplazadas`);
  } catch (err) {
    slog.error('fatal', `Dashboard job error: ${(err as Error).message}`);
    if (browserOpen) { try { await dacBrowser.close(); } catch { /* best-effort */ } }

    // Drain del path de crash (mirror del job de Shopify): si ya se enviaron N
    // guías reales antes del crash, FACTURAR esos éxitos (sino: envíos gratis) y
    // marcar cargadas las ya enviadas para que el dashboard no las re-sirva.
    if (successCount > 0 && !billed) {
      await deductCreditsAndStamp(tenantId, successCount).catch((deductErr) =>
        logger.error({ tenantId, jobId, successCount, error: (deductErr as Error).message }, '[credits] Failed to drain credits in crash path — manual reconciliation needed'));
      if (dashboardUrl && dashboardToken && loadedIds.length) {
        await markDashboardOrdersLoaded(dashboardUrl, dashboardToken, loadedIds).catch(() => { /* best-effort: el dedup de DAC evita doble-envío el próximo run */ });
      }
    }

    await db.job
      .update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: (err as Error).message.slice(0, 500), finishedAt: new Date(), durationMs: Date.now() - startTime } })
      .catch(() => { /* best-effort */ });
  }
}
