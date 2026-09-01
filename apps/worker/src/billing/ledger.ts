/**
 * Ledger del wallet — la capa que junta el núcleo puro (tiers/settle/funds)
 * con la base de datos.
 *
 * FASE 1: MODO SOMBRA. Mientras `Wallet.authoritative = false`, este módulo
 * escribe los asientos (con `shadow = true`) pero NO mueve `balanceMilli`.
 * El cobro real sigue siendo `Tenant.shipmentCredits` vía deductCreditsAndStamp.
 * La sombra existe para medir la divergencia entre los dos antes del cutover
 * (ver docs/WALLET.md).
 *
 * CONTRATO DE CONCURRENCIA
 * ------------------------
 * Cada operación corre en una transacción que arranca con
 * `SELECT … FOR UPDATE` sobre la fila del wallet. Eso serializa todas las
 * escrituras del mismo wallet: los conteos y la suma que alimentan
 * computeSettlement se leen DESPUÉS de tomar el lock, así que ven el estado
 * que dejó la transacción anterior. Sin ese lock, dos envíos concurrentes
 * leerían el mismo `n` y emitirían dos liquidaciones para el mismo estado
 * (la segunda chocaría por idemKey y rompería la transacción entera, y con
 * ella el asiento del envío).
 *
 * El cliente se inyecta (`LedgerClient`) para que los tests corran contra un
 * adaptador en memoria que replica las unique constraints (P2002) y la
 * atomicidad de la transacción, sin Postgres.
 */

import {
  computeSettlement,
  assertPeriodInvariant,
  shipmentIdemKey,
  settlementIdemKey,
  periodOf,
  type Settlement,
} from './settle';

// ─── Tipos del cliente inyectable ────────────────────────────────────────────
// Subconjunto estructural de PrismaClient. El PrismaClient real lo satisface
// tal cual; el fake de tests también.

export interface LedgerWallet {
  id: string;
  userId: string;
  balanceMilli: bigint;
  authoritative: boolean;
}

export interface LedgerEntry {
  id: string;
  walletId: string;
  tenantId: string | null;
  deltaMilli: bigint;
  reason: string;
  idemKey: string;
  dacGuia: string | null;
  labelId: string | null;
  jobId: string | null;
  periodYm: string | null;
  unitPriceMilli: bigint | null;
  shadow: boolean;
}

export interface LedgerEntryCreate {
  walletId: string;
  tenantId: string | null;
  deltaMilli: bigint;
  reason: EntryReason;
  idemKey: string;
  dacGuia?: string | null;
  labelId?: string | null;
  jobId?: string | null;
  periodYm: string | null;
  unitPriceMilli?: bigint | null;
  shadow: boolean;
}

export interface LedgerEntryWhere {
  walletId: string;
  periodYm: string;
  reason: EntryReason | { in: EntryReason[] };
}

export interface LedgerTx {
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  wallet: {
    findUnique(args: { where: { id: string } }): Promise<LedgerWallet | null>;
    update(args: {
      where: { id: string };
      data: { balanceMilli: { increment: bigint } };
    }): Promise<unknown>;
  };
  walletEntry: {
    findUnique(args: { where: { idemKey: string } }): Promise<LedgerEntry | null>;
    create(args: { data: LedgerEntryCreate }): Promise<LedgerEntry>;
    count(args: { where: LedgerEntryWhere }): Promise<number>;
    aggregate(args: {
      where: LedgerEntryWhere;
      _sum: { deltaMilli: true };
    }): Promise<{ _sum: { deltaMilli: bigint | null } }>;
  };
}

/** Lo mínimo de Label que necesita el reparador (repairUnrecordedShipments). */
export interface LedgerLabel {
  id: string;
  tenantId: string;
  dacGuia: string | null;
  createdAt: Date;
}

export interface LedgerLabelFindManyArgs {
  where: {
    dacGuia: { not: null };
    tenantId?: string;
    createdAt?: { gte: Date };
  };
  select: { id: true; tenantId: true; dacGuia: true; createdAt: true };
  orderBy: Array<{ createdAt: 'asc' } | { id: 'asc' }>;
  take: number;
  /** Paginación por cursor (keyset): la fila del cursor se salta con skip: 1. */
  cursor?: { id: string };
  skip?: number;
}

export interface LedgerClient {
  tenant: {
    findUnique(args: {
      where: { id: string };
      select: { userId: true };
    }): Promise<{ userId: string } | null>;
  };
  wallet: {
    findUnique(args: { where: { userId: string } }): Promise<LedgerWallet | null>;
    create(args: { data: { userId: string } }): Promise<LedgerWallet>;
  };
  /** Sólo lectura: el ledger nunca escribe Label. */
  label: {
    findMany(args: LedgerLabelFindManyArgs): Promise<LedgerLabel[]>;
  };
  /** Lectura fuera de transacción, para filtrar en lote qué guías ya tienen asiento. */
  walletEntry: {
    findMany(args: {
      where: { idemKey: { in: string[] } };
      select: { idemKey: true };
    }): Promise<Array<{ idemKey: string }>>;
  };
  $transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T>;
}

export const ENTRY_REASONS = [
  'shipment',
  'settlement',
  'purchase',
  'refund',
  'chargeback',
  'grant',
  'smm',
  'adjust',
] as const;
export type EntryReason = (typeof ENTRY_REASONS)[number];

/** Motivos que suman en el neto del período (settle.ts + reintegros, que valen 0). */
const PERIOD_NET_REASONS: EntryReason[] = ['shipment', 'settlement', 'refund'];

// ─── Guías ───────────────────────────────────────────────────────────────────

/**
 * ¿Esta guía representa un envío DAC real y cobrable?
 *   PENDING-  placeholder mientras DAC no devolvió número
 *   TEST-     job de prueba de credenciales (test-dac)
 *   LF-       reparto propio (self-delivery): no pasa por DAC, no se factura acá
 */
export function isBillableGuia(dacGuia: string | null | undefined): dacGuia is string {
  if (!dacGuia) return false;
  const g = dacGuia.trim();
  if (!g) return false;
  return !g.startsWith('PENDING-') && !g.startsWith('TEST-') && !g.startsWith('LF-');
}

export function refundIdemKey(tenantId: string, dacGuia: string): string {
  const guia = dacGuia.trim();
  if (!tenantId) throw new Error('refundIdemKey: falta tenantId');
  if (!guia) throw new Error('refundIdemKey: falta la guía');
  return `refund:v1:${tenantId}:${guia}`;
}

/** Prisma P2002 = unique constraint. Se detecta por `code` y no por instanceof
 *  porque el cliente puede venir de otra copia del paquete (o del fake). */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'P2002'
  );
}

// ─── Wallet ──────────────────────────────────────────────────────────────────

/**
 * Wallet del user dueño del tenant. Se crea al primer uso.
 *
 * Sobre el credit-holder: el holder es "el tenant más viejo del mismo user"
 * (credit-holder.ts), o sea que `holder.userId === tenant.userId` por
 * definición. Ir al holder para leerle el userId sería dar la vuelta a la
 * manzana para llegar a la puerta de al lado; el wallet cuelga del userId y
 * ese ya está en el tenant.
 */
export async function getOrCreateWalletForTenant(
  client: LedgerClient,
  tenantId: string,
): Promise<LedgerWallet> {
  const tenant = await client.tenant.findUnique({
    where: { id: tenantId },
    select: { userId: true },
  });
  if (!tenant) throw new Error(`getOrCreateWalletForTenant: el tenant ${tenantId} no existe`);

  const existing = await client.wallet.findUnique({ where: { userId: tenant.userId } });
  if (existing) return existing;

  try {
    return await client.wallet.create({ data: { userId: tenant.userId } });
  } catch (err) {
    // Dos jobs del mismo user creando el wallet a la vez: uno gana, el otro
    // lo lee. Wallet.userId es @unique, así que no puede haber dos.
    if (!isUniqueViolation(err)) throw err;
    const raced = await client.wallet.findUnique({ where: { userId: tenant.userId } });
    if (!raced) throw err;
    return raced;
  }
}

/** Primera sentencia de toda transacción del ledger. Ver contrato arriba. */
async function lockWallet(tx: LedgerTx, walletId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Wallet" WHERE "id" = ${walletId} FOR UPDATE`;
}

// ─── Liquidación ─────────────────────────────────────────────────────────────

export interface PeriodSnapshot {
  billableShipments: number;
  netMilli: bigint;
}

async function readPeriod(tx: LedgerTx, walletId: string, periodYm: string): Promise<PeriodSnapshot> {
  const [shipments, refunds, agg] = await Promise.all([
    tx.walletEntry.count({ where: { walletId, periodYm, reason: 'shipment' } }),
    tx.walletEntry.count({ where: { walletId, periodYm, reason: 'refund' } }),
    tx.walletEntry.aggregate({
      where: { walletId, periodYm, reason: { in: PERIOD_NET_REASONS } },
      _sum: { deltaMilli: true },
    }),
  ]);
  return {
    billableShipments: shipments - refunds,
    netMilli: agg._sum.deltaMilli ?? 0n,
  };
}

export interface SettleResult extends Settlement {
  /** id del asiento 'settlement' emitido, o null si el delta fue 0. */
  entryId: string | null;
}

/**
 * Clave de la próxima liquidación del período. Arranca en la cantidad de
 * liquidaciones previas y, si esa clave ya existe, avanza hasta encontrar
 * una libre.
 *
 * POR QUÉ NO ALCANZA CON `count`: si alguna vez falta un asiento (borrado a
 * mano, restore parcial), count queda por debajo del último seq y la clave
 * candidata CHOCA. Dentro de una transacción Postgres un P2002 aborta la
 * transacción entera — incluido el asiento del envío — y el ledger dejaría
 * de registrar ese wallet PARA SIEMPRE, en silencio. El chequeo previo con
 * findUnique cuesta una lectura por índice en el caso normal y evita ese
 * modo de falla. Corre bajo el lock del wallet, así que es determinista.
 */
async function nextSettlementKey(tx: LedgerTx, walletId: string, periodYm: string): Promise<string> {
  const base = await tx.walletEntry.count({ where: { walletId, periodYm, reason: 'settlement' } });
  for (let seq = base; seq < base + 100_000; seq++) {
    const key = settlementIdemKey(walletId, periodYm, seq);
    if (!(await tx.walletEntry.findUnique({ where: { idemKey: key } }))) return key;
  }
  throw new Error(`nextSettlementKey: sin clave libre para ${walletId}/${periodYm}; el ledger está corrupto`);
}

/**
 * Recalcula el período y emite UN asiento 'settlement' con la diferencia.
 * Debe correr con el lock del wallet tomado.
 */
async function settlePeriod(
  tx: LedgerTx,
  walletId: string,
  periodYm: string,
  authoritative: boolean,
): Promise<SettleResult> {
  const snap = await readPeriod(tx, walletId, periodYm);
  const s = computeSettlement({
    billableShipments: snap.billableShipments,
    recordedNetMilli: snap.netMilli,
  });
  if (s.deltaMilli === 0n) return { ...s, entryId: null };

  const idemKey = await nextSettlementKey(tx, walletId, periodYm);
  const entry = await tx.walletEntry.create({
    data: {
      walletId,
      tenantId: null,
      deltaMilli: s.deltaMilli,
      reason: 'settlement',
      idemKey,
      periodYm,
      unitPriceMilli: s.effectiveUnitMilli,
      shadow: !authoritative,
    },
  });

  // En sombra el saldo NO se toca: Tenant.shipmentCredits sigue mandando.
  if (authoritative) {
    await tx.wallet.update({
      where: { id: walletId },
      data: { balanceMilli: { increment: s.deltaMilli } },
    });
  }
  return { ...s, entryId: entry.id };
}

// ─── Envío ───────────────────────────────────────────────────────────────────

export interface RecordShipmentInput {
  tenantId: string;
  dacGuia: string;
  labelId?: string | null;
  jobId?: string | null;
  /** Momento del hecho. Define el período contable. Default: ahora. */
  at?: Date;
}

export type RecordShipmentResult =
  | { recorded: false; alreadyRecorded: false; reason: 'not_billable' }
  | { recorded: false; alreadyRecorded: true; walletId: string; periodYm: string | null }
  | {
      recorded: true;
      alreadyRecorded: false;
      walletId: string;
      entryId: string;
      periodYm: string;
      settlement: SettleResult;
    };

/**
 * Asienta un envío facturable. Idempotente por (tenantId, guía): la segunda
 * llamada con la misma guía es un no-op que devuelve `alreadyRecorded`.
 * Nunca lanza por P2002.
 */
export async function recordShipment(
  client: LedgerClient,
  input: RecordShipmentInput,
): Promise<RecordShipmentResult> {
  if (!isBillableGuia(input.dacGuia)) {
    return { recorded: false, alreadyRecorded: false, reason: 'not_billable' };
  }
  const guia = input.dacGuia.trim();
  const idemKey = shipmentIdemKey(input.tenantId, guia);
  const periodYm = periodOf(input.at ?? new Date());
  const wallet = await getOrCreateWalletForTenant(client, input.tenantId);

  try {
    return await client.$transaction(async (tx) => {
      await lockWallet(tx, wallet.id);

      const existing = await tx.walletEntry.findUnique({ where: { idemKey } });
      if (existing) {
        return {
          recorded: false as const,
          alreadyRecorded: true as const,
          walletId: wallet.id,
          periodYm: existing.periodYm,
        };
      }

      // Se relee bajo el lock: el cutover puede haber pasado entre el
      // getOrCreate y acá, y un asiento con `shadow` mal marcado es ruido
      // en la reconciliación.
      const locked = await tx.wallet.findUnique({ where: { id: wallet.id } });
      const authoritative = locked?.authoritative ?? wallet.authoritative;

      const entry = await tx.walletEntry.create({
        data: {
          walletId: wallet.id,
          tenantId: input.tenantId,
          deltaMilli: 0n,
          reason: 'shipment',
          idemKey,
          dacGuia: guia,
          labelId: input.labelId ?? null,
          jobId: input.jobId ?? null,
          periodYm,
          shadow: !authoritative,
        },
      });

      const settlement = await settlePeriod(tx, wallet.id, periodYm, authoritative);
      return {
        recorded: true as const,
        alreadyRecorded: false as const,
        walletId: wallet.id,
        entryId: entry.id,
        periodYm,
        settlement,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Con el lock esto no debería pasar (el findUnique de arriba lo
      // atrapa antes); queda como red por si alguien escribe sin lock.
      return { recorded: false, alreadyRecorded: true, walletId: wallet.id, periodYm };
    }
    throw err;
  }
}

// ─── Reintegro ───────────────────────────────────────────────────────────────

export interface RecordRefundInput {
  tenantId: string;
  dacGuia: string;
}

export type RecordRefundResult =
  | { refunded: false; alreadyRecorded: false; reason: 'not_billable' | 'no_shipment' }
  | { refunded: false; alreadyRecorded: true; walletId: string }
  | { refunded: true; alreadyRecorded: false; walletId: string; entryId: string; periodYm: string; settlement: SettleResult };

/**
 * Reintegra un envío ya asentado: emite un 'refund' (delta 0, idempotente) y
 * re-liquida EL PERÍODO DEL ENVÍO ORIGINAL (no el de hoy): un reintegro en
 * octubre de una guía de septiembre corrige septiembre. La plata vuelve por
 * el settlement, exactamente lo que ese período recalcula — nunca un precio
 * de lista viejo.
 */
export async function recordRefundForShipment(
  client: LedgerClient,
  input: RecordRefundInput,
): Promise<RecordRefundResult> {
  if (!isBillableGuia(input.dacGuia)) {
    return { refunded: false, alreadyRecorded: false, reason: 'not_billable' };
  }
  const guia = input.dacGuia.trim();
  const shipKey = shipmentIdemKey(input.tenantId, guia);
  const refundKey = refundIdemKey(input.tenantId, guia);
  const wallet = await getOrCreateWalletForTenant(client, input.tenantId);

  try {
    return await client.$transaction(async (tx) => {
      await lockWallet(tx, wallet.id);

      const shipment = await tx.walletEntry.findUnique({ where: { idemKey: shipKey } });
      if (!shipment || !shipment.periodYm) {
        return { refunded: false as const, alreadyRecorded: false as const, reason: 'no_shipment' as const };
      }
      const existing = await tx.walletEntry.findUnique({ where: { idemKey: refundKey } });
      if (existing) {
        return { refunded: false as const, alreadyRecorded: true as const, walletId: wallet.id };
      }

      const locked = await tx.wallet.findUnique({ where: { id: wallet.id } });
      const authoritative = locked?.authoritative ?? wallet.authoritative;
      const periodYm = shipment.periodYm;

      const entry = await tx.walletEntry.create({
        data: {
          walletId: wallet.id,
          tenantId: input.tenantId,
          deltaMilli: 0n,
          reason: 'refund',
          idemKey: refundKey,
          dacGuia: guia,
          labelId: shipment.labelId,
          jobId: shipment.jobId,
          periodYm,
          shadow: !authoritative,
        },
      });
      const settlement = await settlePeriod(tx, wallet.id, periodYm, authoritative);
      return {
        refunded: true as const,
        alreadyRecorded: false as const,
        walletId: wallet.id,
        entryId: entry.id,
        periodYm,
        settlement,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { refunded: false, alreadyRecorded: true, walletId: wallet.id };
    }
    throw err;
  }
}

// ─── Reparación Label → ledger ───────────────────────────────────────────────

export interface RepairUnrecordedOptions {
  /** Máximo de envíos a ASENTAR en esta corrida (no de filas leídas). Default 100. */
  limit?: number;
  /** Acotar a un tenant (usa el índice (tenantId, createdAt) de Label). */
  tenantId?: string;
  /** Sólo Labels creadas desde esta fecha. Sin esto recorre toda la tabla. */
  since?: Date;
  /** Tamaño de página de lectura de Label. Default 500. */
  pageSize?: number;
}

export interface RepairUnrecordedReport {
  /** Labels leídas (con dacGuia no nulo, antes de filtrar placeholders). */
  scanned: number;
  /** Envíos asentados en esta corrida. */
  repaired: number;
  /** Guías reales que ya tenían asiento (o lo ganaron en una carrera). */
  alreadyRecorded: number;
  /** PENDING-/TEST-/LF-: no facturables, se saltan. */
  notBillable: number;
  /** true si se recorrió todo el rango; false si cortó por `limit`. */
  exhausted: boolean;
  /** ids de Label reparadas, para el log. */
  repairedLabelIds: string[];
}

/**
 * Cierra la ventana at-most-once entre `Label.dacGuia` y el hook de sombra.
 *
 * El worker persiste la guía (transacción 1) y recién después llama al hook
 * (transacción 2). Un SIGTERM, deploy o timeout entre las dos deja una guía
 * real sin asiento, y nadie vuelve a llamar al hook porque el ciclo siguiente
 * salta la orden (ya tiene guía). Esta función busca Labels con guía real
 * (isBillableGuia) sin `WalletEntry(reason='shipment')` para (tenantId, guía)
 * y las asienta con `at = label.createdAt`, así el período contable es el del
 * hecho y no el del día en que se repara.
 *
 * Idempotente por construcción: recordShipment ya es no-op si la guía existe,
 * y acá además se filtra en lote por idemKey para no abrir una transacción
 * por cada guía ya asentada. Correrla dos veces no duplica nada.
 *
 * NO está programada en ningún cron. Es el paso 0 del cutover (docs/WALLET.md)
 * y se corre a mano: sin `since` recorre TODA la tabla Label paginada por
 * (createdAt, id), lo cual está bien para una corrida puntual y no para cada
 * ciclo. Si algún día se programa, va con `since` acotado (p.ej. 48 h) para
 * que la lectura sea barata.
 */
export async function repairUnrecordedShipments(
  client: LedgerClient,
  options: RepairUnrecordedOptions = {},
): Promise<RepairUnrecordedReport> {
  const limit = options.limit ?? 100;
  const pageSize = Math.max(1, options.pageSize ?? 500);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`repairUnrecordedShipments: limit debe ser un entero >= 1, recibió ${limit}`);
  }

  const report: RepairUnrecordedReport = {
    scanned: 0,
    repaired: 0,
    alreadyRecorded: 0,
    notBillable: 0,
    exhausted: false,
    repairedLabelIds: [],
  };

  const where: LedgerLabelFindManyArgs['where'] = { dacGuia: { not: null } };
  if (options.tenantId) where.tenantId = options.tenantId;
  if (options.since) where.createdAt = { gte: options.since };

  let cursor: string | undefined;
  for (;;) {
    const page = await client.label.findMany({
      where,
      select: { id: true, tenantId: true, dacGuia: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) {
      report.exhausted = true;
      break;
    }
    report.scanned += page.length;
    cursor = page[page.length - 1].id;

    const billable = page.filter((l) => isBillableGuia(l.dacGuia));
    report.notBillable += page.length - billable.length;

    if (billable.length > 0) {
      const keys = billable.map((l) => shipmentIdemKey(l.tenantId, l.dacGuia as string));
      const existing = new Set(
        (
          await client.walletEntry.findMany({
            where: { idemKey: { in: keys } },
            select: { idemKey: true },
          })
        ).map((e) => e.idemKey),
      );

      for (let i = 0; i < billable.length; i++) {
        if (existing.has(keys[i])) {
          report.alreadyRecorded += 1;
          continue;
        }
        const label = billable[i];
        const r = await recordShipment(client, {
          tenantId: label.tenantId,
          dacGuia: label.dacGuia as string,
          labelId: label.id,
          jobId: null,
          at: label.createdAt,
        });
        if (r.recorded) {
          report.repaired += 1;
          report.repairedLabelIds.push(label.id);
          if (report.repaired >= limit) return report; // exhausted queda en false
        } else {
          // alreadyRecorded (carrera con un hook) o not_billable (imposible acá).
          report.alreadyRecorded += 1;
        }
      }
    }

    if (page.length < pageSize) {
      report.exhausted = true;
      break;
    }
  }
  return report;
}

// ─── Reconciliación ──────────────────────────────────────────────────────────

export interface InvariantReport extends PeriodSnapshot {
  walletId: string;
  periodYm: string;
}

/**
 * Verifica que el período cierre: suma(shipment+settlement+refund) == -periodTotal(n).
 * Lanza si no. Para el reconciliador; si falla en prod el ledger está
 * corrupto y hay que frenar el cutover, no seguir.
 */
export async function assertWalletInvariant(
  client: LedgerClient,
  walletId: string,
  periodYm: string,
): Promise<InvariantReport> {
  const snap = await client.$transaction(async (tx) => {
    await lockWallet(tx, walletId);
    return readPeriod(tx, walletId, periodYm);
  });
  assertPeriodInvariant(snap.billableShipments, snap.netMilli);
  return { walletId, periodYm, ...snap };
}
