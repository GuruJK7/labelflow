/**
 * Adaptador EN MEMORIA del subconjunto de Prisma que usa el ledger.
 *
 * Por qué un fake y no `vi.mock` de Prisma con respuestas enlatadas: lo que
 * hay que probar del ledger es justamente lo que un mock enlatado no puede
 * fallar — que las UNIQUE constraints rechacen el segundo asiento (P2002),
 * que una transacción que explota no deje mitad de sus filas, y que 1000
 * llamadas concurrentes converjan al invariante. Este fake replica esas tres
 * propiedades del Postgres real y nada más:
 *
 *   - UNIQUE Wallet.userId, UNIQUE WalletEntry.idemKey, y los dos índices
 *     parciales (tenantId, dacGuia) WHERE reason IN ('shipment' | 'refund')
 *     de la migración → lanzan `{ code: 'P2002' }` como Prisma.
 *   - $transaction: atómica (snapshot + rollback si el callback lanza) y
 *     SERIALIZADA con un mutex. El ledger real toma `SELECT … FOR UPDATE`
 *     sobre el wallet como primera sentencia; el mutex es el equivalente
 *     conservador (serializa todo, no sólo por wallet).
 *   - `failNextCreates`: inyecta fallas de escritura para probar que un
 *     job que reintenta no duplica asientos.
 */

import type {
  LedgerClient,
  LedgerTx,
  LedgerWallet,
  LedgerEntry,
  LedgerEntryCreate,
  LedgerEntryWhere,
} from '../../billing/ledger';

export class FakeP2002 extends Error {
  readonly code = 'P2002';
  constructor(readonly meta: { target: string[] }) {
    super(`Unique constraint failed on the fields: (${meta.target.join(',')})`);
  }
}

type FullWallet = LedgerWallet;

let seq = 0;
const nextId = (p: string) => `${p}_${(++seq).toString(36).padStart(6, '0')}`;

export class FakeLedgerDb implements LedgerClient, LedgerTx {
  tenants = new Map<string, { userId: string }>();
  wallets: FullWallet[] = [];
  entries: LedgerEntry[] = [];
  /** Cuántos `walletEntry.create` siguientes deben fallar (simula caída de DB). */
  failNextCreates = 0;
  transactionsRun = 0;

  private mutex: Promise<void> = Promise.resolve();

  seedTenant(id: string, userId: string): void {
    this.tenants.set(id, { userId });
  }

  private matches(e: LedgerEntry, w: LedgerEntryWhere): boolean {
    if (e.walletId !== w.walletId || e.periodYm !== w.periodYm) return false;
    return typeof w.reason === 'string' ? e.reason === w.reason : w.reason.in.includes(e.reason as never);
  }

  tenant = {
    findUnique: async (args: { where: { id: string }; select: { userId: true } }) => {
      const t = this.tenants.get(args.where.id);
      return t ? { userId: t.userId } : null;
    },
  };

  wallet = {
    findUnique: async (args: { where: { id: string } } | { where: { userId: string } }) => {
      const w = args.where as { id?: string; userId?: string };
      const found = this.wallets.find((x) => (w.id ? x.id === w.id : x.userId === w.userId));
      return found ? { ...found } : null;
    },
    create: async (args: { data: { userId: string } }) => {
      if (this.wallets.some((x) => x.userId === args.data.userId)) {
        throw new FakeP2002({ target: ['userId'] });
      }
      const w: FullWallet = { id: nextId('w'), userId: args.data.userId, balanceMilli: 0n, authoritative: false };
      this.wallets.push(w);
      return { ...w };
    },
    update: async (args: { where: { id: string }; data: { balanceMilli: { increment: bigint } } }) => {
      const w = this.wallets.find((x) => x.id === args.where.id);
      if (!w) throw new Error('Record to update not found');
      w.balanceMilli += args.data.balanceMilli.increment;
      return { ...w };
    },
  };

  walletEntry = {
    findUnique: async (args: { where: { idemKey: string } }) => {
      const e = this.entries.find((x) => x.idemKey === args.where.idemKey);
      return e ? { ...e } : null;
    },
    create: async (args: { data: LedgerEntryCreate }) => {
      if (this.failNextCreates > 0) {
        this.failNextCreates -= 1;
        throw new Error('simulated: connection reset by peer');
      }
      const d = args.data;
      if (this.entries.some((x) => x.idemKey === d.idemKey)) {
        throw new FakeP2002({ target: ['idemKey'] });
      }
      if ((d.reason === 'shipment' || d.reason === 'refund') && d.tenantId && d.dacGuia) {
        if (
          this.entries.some(
            (x) => x.reason === d.reason && x.tenantId === d.tenantId && x.dacGuia === d.dacGuia,
          )
        ) {
          throw new FakeP2002({ target: ['tenantId', 'dacGuia'] });
        }
      }
      const e: LedgerEntry = {
        id: nextId('e'),
        walletId: d.walletId,
        tenantId: d.tenantId,
        deltaMilli: d.deltaMilli,
        reason: d.reason,
        idemKey: d.idemKey,
        dacGuia: d.dacGuia ?? null,
        labelId: d.labelId ?? null,
        jobId: d.jobId ?? null,
        periodYm: d.periodYm,
        unitPriceMilli: d.unitPriceMilli ?? null,
        shadow: d.shadow,
      };
      this.entries.push(e);
      return { ...e };
    },
    count: async (args: { where: LedgerEntryWhere }) =>
      this.entries.filter((e) => this.matches(e, args.where)).length,
    aggregate: async (args: { where: LedgerEntryWhere; _sum: { deltaMilli: true } }) => {
      const hits = this.entries.filter((e) => this.matches(e, args.where));
      return {
        _sum: { deltaMilli: hits.length ? hits.reduce((a, e) => a + e.deltaMilli, 0n) : null },
      };
    },
  };

  async $queryRaw(_query: TemplateStringsArray, ..._values: unknown[]): Promise<unknown> {
    return [];
  }

  async $transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.mutex;
    this.mutex = new Promise<void>((r) => (release = r));
    await prev;
    this.transactionsRun += 1;
    const snapWallets = this.wallets.map((w) => ({ ...w }));
    const snapEntries = this.entries.slice();
    try {
      return await fn(this);
    } catch (err) {
      this.wallets = snapWallets;
      this.entries = snapEntries;
      throw err;
    } finally {
      release();
    }
  }

  // ── helpers de aserción ──
  entriesOf(walletId: string, reason?: string): LedgerEntry[] {
    return this.entries.filter((e) => e.walletId === walletId && (!reason || e.reason === reason));
  }
  netOf(walletId: string, periodYm: string): bigint {
    return this.entries
      .filter((e) => e.walletId === walletId && e.periodYm === periodYm && ['shipment', 'settlement', 'refund'].includes(e.reason))
      .reduce((a, e) => a + e.deltaMilli, 0n);
  }
  setAuthoritative(walletId: string, value: boolean): void {
    const w = this.wallets.find((x) => x.id === walletId);
    if (!w) throw new Error('wallet not found');
    w.authoritative = value;
  }
}
