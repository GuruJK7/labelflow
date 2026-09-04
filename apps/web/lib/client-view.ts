/**
 * Client portal — a shareable, login-less, read-only label view.
 *
 * A single unguessable token lets ONE client see ONLY the labels of a fixed
 * allow-list of stores (tenants), grouped by day. There is no account and no
 * session: access is gated entirely by the token, compared in constant time.
 *
 * Config (env, set on Render — never hardcoded, the token is a secret):
 *   CLIENT_VIEW_TOKEN        long URL-safe secret; the `[token]` in the URL
 *   CLIENT_VIEW_TENANT_IDS   comma-separated tenant ids the link may expose
 *
 * Privacy posture: the on-screen list is PII-minimized — it shows order #,
 * store, city, tracking guia, status and day, but NOT recipient name, phone,
 * email, address or amounts. Full recipient details live only inside the label
 * PDF, which the client legitimately needs to print and ship. If the token env
 * is unset the portal is effectively disabled: every candidate token fails
 * validation, so a forgotten secret can never accidentally allow access.
 *
 * Scoping is enforced in every query via `tenantId in CLIENT_VIEW_TENANT_IDS`,
 * so the link can never widen to a store outside the allow-list.
 */

import { createHash, timingSafeEqual } from 'crypto';
import { db } from '@/lib/db';
import { startOfDayUy } from '@/lib/uy-time';

export interface ClientViewStore {
  id: string;
  name: string;
  url: string | null;
}

export interface ClientViewLabel {
  id: string;
  storeId: string;
  orderName: string | null;
  dacGuia: string | null;
  /** Transportista que emitió la guía. NULL en las filas históricas = DAC. */
  carrier: string | null;
  city: string | null;
  department: string | null;
  status: string;
  createdAt: string; // ISO 8601
  hasPdf: boolean;
  // When the portal first served this label's PDF (or it was marked manually).
  // Null = still pending print. ISO 8601.
  printedAt: string | null;
}

/**
 * Permanent billing counter. Counts SHIPMENTS (labels with a DAC guía issued —
 * status CREATED or COMPLETED), NOT printable PDFs, so it is unaffected by the
 * PDF retention job that deletes old PDFs: the Label rows live forever, so these
 * numbers only ever go up. `total` is all-time; `month` is the current UY month.
 */
export interface ClientViewStoreCount {
  total: number;
  month: number;
}
export interface ClientViewCounts {
  byStore: Record<string, ClientViewStoreCount>;
  total: number; // all stores, all-time
  month: number; // all stores, current UY month
}

/** Statuses that represent a real, billable shipment (a DAC guía was issued). */
const BILLABLE_STATUSES = ['CREATED', 'COMPLETED'] as const;

/**
 * First instant of the current month in Uruguay local time, as a Date (UTC
 * under the hood). Uruguay is a fixed UTC-3 (no DST since 2015), so UY midnight
 * on the 1st == 03:00 UTC on the 1st. Using UY (not UTC) keeps the monthly
 * invoice boundary aligned with the operator's wall clock.
 */
function startOfMonthUY(): Date {
  const uyNow = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return new Date(Date.UTC(uyNow.getUTCFullYear(), uyNow.getUTCMonth(), 1, 3, 0, 0));
}

function getConfiguredToken(): string | null {
  const t = process.env.CLIENT_VIEW_TOKEN?.trim();
  return t && t.length > 0 ? t : null;
}

export function getClientViewTenantIds(): string[] {
  return (process.env.CLIENT_VIEW_TENANT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function isClientViewConfigured(): boolean {
  return getConfiguredToken() !== null && getClientViewTenantIds().length > 0;
}

/**
 * Rolling window (in days) of labels the portal renders. We deliberately do NOT
 * load "the most recent N labels": two busy stores can create >2000 labels in
 * under a month, so a fixed `take` silently drops the OLDEST days — which made
 * the on-screen total stick at the cap and the day count come up short, and hid
 * those days' labels from printing. A date window instead shows EVERY label in
 * the window, so the totals and day count are always complete, while the read
 * stays bounded: it rides the @@index([tenantId, createdAt desc]) and the
 * `take` in loadClientView is only a safety backstop. Override on Render with
 * CLIENT_VIEW_WINDOW_DAYS (default 90) to widen/narrow the history shown.
 */
export function getClientViewWindowDays(): number {
  const n = Number(process.env.CLIENT_VIEW_WINDOW_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90;
}

/**
 * Constant-time token check for the LEGACY single-token (env) portal. Returns
 * false when unconfigured so a missing secret never accidentally allows access.
 * Both sides are hashed first, which sidesteps the equal-length requirement of
 * timingSafeEqual and avoids leaking the secret's length through timing.
 */
export function isValidClientToken(candidate: string | undefined | null): boolean {
  const expected = getConfiguredToken();
  if (!expected) return false;
  if (!candidate || typeof candidate !== 'string') return false;
  const a = createHash('sha256').update(candidate).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Resolve a portal token to the EXACT set of stores it may expose, or null when
 * the token matches nothing (the caller then renders the normal 404/401, so
 * existence never leaks).
 *
 * Two sources, checked in order:
 *   1. The legacy single token (env CLIENT_VIEW_TOKEN -> CLIENT_VIEW_TENANT_IDS),
 *      compared in constant time. This keeps the existing shared link working
 *      with zero config change.
 *   2. Per-link tokens stored in the `client_portal_tokens` table — a
 *      `(token_hash, tenant_ids)` row, looked up by the sha256 hash of the
 *      candidate (the plaintext token is never stored, so a DB read can't reveal
 *      a usable token). This is how additional, store-scoped links are added
 *      WITHOUT touching env vars: insert one row and the link works.
 *
 * Any failure of the DB lookup (table missing, transient error) is treated as
 * "no match" -> the portal stays fail-closed.
 */
export async function resolveClientToken(
  candidate: string | undefined | null,
): Promise<string[] | null> {
  if (!candidate || typeof candidate !== 'string') return null;

  // 1) Legacy env token (constant-time).
  const expected = getConfiguredToken();
  if (expected) {
    const a = createHash('sha256').update(candidate).digest();
    const b = createHash('sha256').update(expected).digest();
    if (timingSafeEqual(a, b)) {
      const ids = getClientViewTenantIds();
      if (ids.length > 0) return ids;
    }
  }

  // 2) Per-link token rows (lookup by sha256 hash — never store the plaintext).
  try {
    const hash = createHash('sha256').update(candidate).digest('hex');
    const rows = await db.$queryRaw<Array<{ tenant_ids: string }>>`
      SELECT tenant_ids FROM client_portal_tokens WHERE token_hash = ${hash} LIMIT 1
    `;
    const raw = rows[0]?.tenant_ids;
    if (raw) {
      const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length > 0) return ids;
    }
  } catch {
    // Table not present yet / transient DB error -> fail closed (no access).
  }

  return null;
}

/** "vi0zry-r1.myshopify.com" -> "vi0zry-r1" (fallback label when unnamed). */
function storeLabelFromUrl(url: string | null): string {
  if (!url) return 'Tienda';
  return url.replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/i, '') || 'Tienda';
}

/**
 * Loads the allow-listed stores plus their created (downloadable) labels.
 * Strictly scoped to CLIENT_VIEW_TENANT_IDS. Store names fall back to the
 * myshopify subdomain when a store is still the default "Nueva tienda" or
 * has no name, so the two stores are always distinguishable in the selector.
 */
export async function loadClientView(tenantIds: string[]): Promise<{
  stores: ClientViewStore[];
  labels: ClientViewLabel[];
  counts: ClientViewCounts;
  splitZonas: boolean;
}> {
  const emptyCounts: ClientViewCounts = { byStore: {}, total: 0, month: 0 };
  if (tenantIds.length === 0)
    return { stores: [], labels: [], counts: emptyCounts, splitZonas: false };

  // Rolling window: show every (downloadable) label created in the last N days,
  // not a fixed "most recent 2000" — see getClientViewWindowDays() for why.
  const since = new Date(
    Date.now() - getClientViewWindowDays() * 24 * 60 * 60 * 1000,
  );
  const monthStart = startOfMonthUY();

  const [tenants, rows, totalByStore, monthByStore] = await Promise.all([
    db.tenant.findMany({
      where: { id: { in: tenantIds } },
      select: {
        id: true,
        name: true,
        shopifyStoreUrl: true,
        portalSplitZonas: true,
      },
    }),
    db.label.findMany({
      where: {
        tenantId: { in: tenantIds },
        pdfPath: { not: null },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      // Safety backstop only; the date window above is the real bound.
      take: 50000,
      select: {
        id: true,
        tenantId: true,
        shopifyOrderName: true,
        dacGuia: true,
        carrier: true,
        city: true,
        department: true,
        status: true,
        createdAt: true,
        pdfPath: true,
        printedAt: true,
      },
    }),
    // Permanent billing counter (all-time): shipments with a DAC guía. Counts
    // rows, not PDFs, so PDF retention never lowers it. This is a COUNT
    // aggregate over the tenantId index (bounded output, one row per store) —
    // fine at this scale; denormalize into a Tenant counter column if it ever
    // gets heavy.
    db.label.groupBy({
      by: ['tenantId'],
      where: { tenantId: { in: tenantIds }, status: { in: [...BILLABLE_STATUSES] } },
      _count: true,
    }),
    // Same, scoped to the current UY month (for monthly invoicing).
    db.label.groupBy({
      by: ['tenantId'],
      where: {
        tenantId: { in: tenantIds },
        status: { in: [...BILLABLE_STATUSES] },
        createdAt: { gte: monthStart },
      },
      _count: true,
    }),
  ]);

  const stores: ClientViewStore[] = tenants.map((t) => {
    const trimmed = (t.name ?? '').trim();
    const isDefault =
      trimmed.length === 0 || trimmed.toLowerCase() === 'nueva tienda';
    return {
      id: t.id,
      name: isDefault ? storeLabelFromUrl(t.shopifyStoreUrl) : trimmed,
      url: t.shopifyStoreUrl ?? null,
    };
  });

  const labels: ClientViewLabel[] = rows.map((r) => ({
    id: r.id,
    storeId: r.tenantId,
    orderName: r.shopifyOrderName,
    dacGuia: r.dacGuia,
    carrier: r.carrier,
    city: r.city,
    department: r.department,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    hasPdf: !!r.pdfPath,
    printedAt: r.printedAt ? r.printedAt.toISOString() : null,
  }));

  const totalMap = new Map(totalByStore.map((g) => [g.tenantId, g._count]));
  const monthMap = new Map(monthByStore.map((g) => [g.tenantId, g._count]));
  const byStore: Record<string, ClientViewStoreCount> = {};
  let total = 0;
  let month = 0;
  for (const id of tenantIds) {
    const t = totalMap.get(id) ?? 0;
    const m = monthMap.get(id) ?? 0;
    byStore[id] = { total: t, month: m };
    total += t;
    month += m;
  }

  // El corte por zonas es UNA vista del portal, y el portal puede mostrar
  // varias tiendas a la vez: alcanza con que UNA de las tiendas del link lo
  // tenga prendido para que el día se muestre partido. Con el default (false
  // en los 4 tenants que ya tienen portal) el portal se comporta EXACTAMENTE
  // como antes de la feature: un solo grupo por día, mismo orden, mismos
  // botones.
  const splitZonas = tenants.some((t) => t.portalSplitZonas === true);

  return { stores, labels, counts: { byStore, total, month }, splitZonas };
}

/**
 * Used by the PDF endpoint: confirms a label id belongs to an allow-listed
 * store and returns its storage path, or null otherwise. Callers 404 on null
 * so the response never reveals whether the id exists for some other tenant.
 */
export async function getClientViewLabelPdfPath(
  labelId: string,
  tenantIds: string[],
): Promise<string | null> {
  if (tenantIds.length === 0) return null;
  const label = await db.label.findFirst({
    where: { id: labelId, tenantId: { in: tenantIds } },
    select: { pdfPath: true },
  });
  return label?.pdfPath ?? null;
}

/**
 * Auto-mark: stamps printedAt on the given labels the FIRST time their PDF is
 * served by the portal (single download or bulk print/download). Only fills
 * null values so the original first-print time is never overwritten, and only
 * within the caller's tenant allow-list. Best-effort by design: callers must
 * never fail a PDF response because the stamp failed.
 *
 * `stampPackSeq` (bulk only) additionally records the PHYSICAL STACK ORDER.
 * Two things make that meaningful, and both are why this is opt-in instead of
 * always-on:
 *
 *   - The caller must be the bulk endpoint, whose `ids` are the labels that
 *     actually made it into the merged PDF, IN MERGE ORDER. That merged file is
 *     what comes out of the printer, so the position in `ids` IS the position
 *     in the stack. The single-PDF endpoint passes one id at a time with no
 *     relation to any stack, so stamping there would write a meaningless
 *     `packSeq = 1` on every label the client ever downloaded one by one.
 *   - Unlike printedAt, a reprint OVERWRITES packSeq: the old stack no longer
 *     exists physically, so keeping its order would describe a pile of paper
 *     that is already in the bin. That is also why the packSeq update is NOT
 *     filtered by `printedAt: null`.
 *
 * ── SEMÁNTICA DE LA NUMERACIÓN ──────────────────────────────────────────────
 * `packSeq` NO arranca en 1 en cada impresión: arranca en
 * `max(packSeq) del MISMO día local uruguayo de ESE tenant + 1` (0 si el día
 * todavía no tiene ninguno). Es decir, numera contra la PILA DEL DÍA, no
 * contra el PDF que se acaba de mandar a imprimir. Consecuencias, que son el
 * punto:
 *
 *   - Imprimir por grupos deja de intercalar. Maldonado (8 etiquetas) sale
 *     1..8 y después "Todo Uruguay" (52) sale 9..60. Con el índice del array
 *     los dos grupos arrancaban en 1 y `?zona=todas` los mezclaba por
 *     createdAt, que es un orden que no existe en ninguna mesa.
 *   - Una reimpresión parcial se va AL FINAL, que es donde queda el papel:
 *     el operador reimprime 3 etiquetas y las apoya arriba/al final de la
 *     pila, no las vuelve a intercalar en el medio.
 *   - El corte es el día LOCAL uruguayo (startOfDayUy), el mismo con el que el
 *     export arma `?date=`, así que la numeración y la tanda exportada hablan
 *     del mismo conjunto de etiquetas.
 *   - Cada (tenant, día) numera aparte: dos tiendas del mismo link no se pisan
 *     los números, porque el export es por tenant.
 *
 * Concurrencia: dos impresiones bulk simultáneas del mismo día pueden leer el
 * mismo máximo y empatar. No se serializa a propósito (sería un lock sobre un
 * día entero para un caso que en la práctica es un operador con un navegador);
 * el empate lo desempata el `createdAt asc` del export.
 *
 * The WMS export (lib/wms-export.ts) orders by `packSeq asc nulls last,
 * createdAt asc`, so DEPO's pack_seq matches the operator's actual stack.
 */
export async function markClientViewLabelsPrinted(
  ids: string[],
  tenantIds: string[],
  opts: { stampPackSeq?: boolean } = {},
): Promise<void> {
  if (ids.length === 0 || tenantIds.length === 0) return;
  await db.label.updateMany({
    where: {
      id: { in: ids },
      tenantId: { in: tenantIds },
      printedAt: null,
    },
    data: { printedAt: new Date() },
  });

  if (!opts.stampPackSeq) return;

  // Deduped, order preserved: `packSeq` must be a position, not a coin flip
  // between two indexes of the same id.
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    orderedIds.push(id);
  }

  // Qué tenant y qué día es cada etiqueta. También filtra: un id que no está
  // en el allow-list (o no existe) no consume un número de la pila.
  const rows = await db.label.findMany({
    where: { id: { in: orderedIds }, tenantId: { in: tenantIds } },
    select: { id: true, tenantId: true, createdAt: true },
  });
  const metaById = new Map(rows.map((r) => [r.id, r]));

  // Un grupo por (tenant, día local UY): cada uno numera contra su propio día.
  interface DayGroup {
    tenantId: string;
    gte: Date;
    lt: Date;
    next: number;
  }
  const groups = new Map<string, DayGroup>();
  for (const r of rows) {
    const gte = startOfDayUy(r.createdAt);
    const key = `${r.tenantId}|${gte.getTime()}`;
    if (groups.has(key)) continue;
    groups.set(key, {
      tenantId: r.tenantId,
      gte,
      lt: new Date(gte.getTime() + 24 * 60 * 60 * 1000),
      next: 1,
    });
  }
  if (groups.size === 0) return;

  // max(packSeq) del día → desde dónde sigue la numeración.
  const keys = Array.from(groups.keys());
  const maxes = await Promise.all(
    keys.map((k) => {
      const g = groups.get(k)!;
      return db.label.aggregate({
        where: {
          tenantId: g.tenantId,
          createdAt: { gte: g.gte, lt: g.lt },
        },
        _max: { packSeq: true },
      });
    }),
  );
  keys.forEach((k, i) => {
    groups.get(k)!.next = (maxes[i]?._max?.packSeq ?? 0) + 1;
  });

  // One statement per label (the value differs per row) but a single round
  // trip and a single transaction: a half-written stack order would be worse
  // than none.
  const updates = [];
  for (const id of orderedIds) {
    const meta = metaById.get(id);
    if (!meta) continue;
    const gte = startOfDayUy(meta.createdAt);
    const group = groups.get(`${meta.tenantId}|${gte.getTime()}`)!;
    updates.push(
      db.label.updateMany({
        where: { id, tenantId: { in: tenantIds } },
        data: { packSeq: group.next },
      }),
    );
    group.next += 1;
  }
  if (updates.length === 0) return;
  await db.$transaction(updates);
}

/**
 * Manual toggle from the portal UI: force the printed state on (stamp now) or
 * off (clear it, e.g. the printer jammed and the label must show as pending
 * again). Scoped to the tenant allow-list; returns how many rows changed.
 */
export async function setClientViewLabelsPrinted(
  ids: string[],
  tenantIds: string[],
  printed: boolean,
): Promise<number> {
  if (ids.length === 0 || tenantIds.length === 0) return 0;
  const res = await db.label.updateMany({
    where: { id: { in: ids }, tenantId: { in: tenantIds } },
    data: { printedAt: printed ? new Date() : null },
  });
  return res.count;
}

/**
 * Batch variant for bulk printing. Given a list of label ids, returns only the
 * ones that both belong to an allow-listed store AND have a stored PDF, as
 * { id, pdfPath } pairs. Ids outside the allow-list, without a PDF, duplicated,
 * or simply non-existent are silently dropped — the bulk endpoint never reveals
 * which ids it rejected. Output preserves the input order so the merged PDF
 * comes out in the same order the client selected on screen.
 */
export async function getClientViewLabelPdfPaths(
  ids: string[],
  tenantIds: string[],
): Promise<{ id: string; pdfPath: string }[]> {
  if (tenantIds.length === 0 || ids.length === 0) return [];

  const rows = await db.label.findMany({
    where: {
      id: { in: ids },
      tenantId: { in: tenantIds },
      pdfPath: { not: null },
    },
    select: { id: true, pdfPath: true },
  });

  const byId = new Map(rows.map((r) => [r.id, r.pdfPath as string]));
  const seen = new Set<string>();
  const ordered: { id: string; pdfPath: string }[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const pdfPath = byId.get(id);
    if (pdfPath) {
      seen.add(id);
      ordered.push({ id, pdfPath });
    }
  }
  return ordered;
}
