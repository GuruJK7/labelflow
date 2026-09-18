/**
 * 🔴 POR QUÉ ESTE TEST. `/api/credit-packs/shopify-return` redirigía a
 * `?success=true` sin mirar si `settlePaidPurchase` había acreditado. En el
 * camino de falla el cargo ya está ACTIVE —o sea, Shopify YA le cobró al
 * comerciante— y la pantalla le decía «Pago acreditado» con el saldo intacto.
 * Plata cobrada, cero envíos, y un cartel verde.
 *
 * La ruta no tenía ningún test. Estos cubren los tres desenlaces con el cargo
 * ya cobrado:
 *   - acreditó            → success
 *   - no acreditó, PAID   → success (carrera benigna: el webhook llegó primero)
 *   - no acreditó, FAILED → error, y un console.error que se pueda alertar
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
const findUnique = vi.fn();
const updateMany = vi.fn();
const settlePaidPurchase = vi.fn();
const fetchChargeStatus = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    creditPurchase: {
      findFirst: (...a: unknown[]) => findFirst(...a),
      findUnique: (...a: unknown[]) => findUnique(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
    },
    tenant: { findUnique: vi.fn(async () => ({ id: 't1', shopifyStoreUrl: 'demo.myshopify.com', shopifyToken: 'shpat_x' })) },
  },
}));
vi.mock('@/lib/api-utils', () => ({ getAuthenticatedTenant: vi.fn(async () => ({ tenantId: 't1' })) }));
vi.mock('@/lib/shopify-access', () => ({ shopifyAccessForTenant: vi.fn(async () => 'shpat_x') }));
vi.mock('@/lib/credit-accrual', () => ({ settlePaidPurchase: (...a: unknown[]) => settlePaidPurchase(...a) }));
vi.mock('@/lib/shopify-billing', async () => {
  const real = await vi.importActual<typeof import('@/lib/shopify-billing')>('@/lib/shopify-billing');
  return { ...real, fetchChargeStatus: (...a: unknown[]) => fetchChargeStatus(...a) };
});

const { GET } = await import('@/app/api/credit-packs/shopify-return/route');

/** La URL a la que la ruta manda al comerciante. */
async function destinoDe(): Promise<string> {
  const req = { nextUrl: { searchParams: new URLSearchParams('purchase=p1') } } as never;
  const res = await GET(req);
  return res.headers.get('location') ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_APP_URL = 'https://autoenvia.com';
  findFirst.mockResolvedValue({ id: 'p1', status: 'PENDING', mpPreferenceId: 'gid://shopify/AppPurchaseOneTime/1', shipments: 100 });
  fetchChargeStatus.mockResolvedValue('ACTIVE'); // Shopify ya cobró
});

describe('retorno de Shopify con el cargo ACTIVE (plata ya cobrada)', () => {
  it('acreditó → éxito', async () => {
    settlePaidPurchase.mockResolvedValue({ credited: true });
    expect(await destinoDe()).toContain('success=true');
  });

  it('🔴 NO acreditó y la fila NO quedó PAID → error, nunca el cartel verde', async () => {
    // Éste es el caso de la fila barrida a FAILED por el reconcile.
    settlePaidPurchase.mockResolvedValue({ credited: false, reason: 'already_processed' });
    findUnique.mockResolvedValue({ status: 'FAILED' });

    const destino = await destinoDe();
    expect(destino).toContain('error=pago_sin_acreditar');
    expect(destino).not.toContain('success=true');
  });

  it('🔴 deja un console.error con el id del cargo, para poder alertar sobre cobros sin acreditar', async () => {
    settlePaidPurchase.mockResolvedValue({ credited: false, reason: 'already_processed' });
    findUnique.mockResolvedValue({ status: 'FAILED' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await destinoDe();

    expect(spy).toHaveBeenCalledTimes(1);
    const linea = String(spy.mock.calls[0][0]);
    expect(linea).toContain('COBRADO SIN ACREDITAR');
    expect(linea).toContain('gid://shopify/AppPurchaseOneTime/1');
    spy.mockRestore();
  });

  it('carrera benigna: no acreditó porque el webhook ya lo hizo (fila PAID) → éxito', async () => {
    settlePaidPurchase.mockResolvedValue({ credited: false, reason: 'already_processed' });
    findUnique.mockResolvedValue({ status: 'PAID' });
    expect(await destinoDe()).toContain('success=true');
  });

  it('un pago pegado a otra compra tampoco puede cantar éxito', async () => {
    settlePaidPurchase.mockResolvedValue({ credited: false, reason: 'duplicate_payment' });
    findUnique.mockResolvedValue({ status: 'PENDING' });
    expect(await destinoDe()).toContain('error=pago_sin_acreditar');
  });
});

describe('los otros desenlaces siguen igual', () => {
  it('la compra ya estaba PAID: corta antes de consultar a Shopify', async () => {
    findFirst.mockResolvedValue({ id: 'p1', status: 'PAID', mpPreferenceId: 'gid://x', shipments: 100 });
    expect(await destinoDe()).toContain('success=true');
    expect(fetchChargeStatus).not.toHaveBeenCalled();
  });

  it('el comerciante declinó el cargo → error=rechazado y la fila queda FAILED', async () => {
    fetchChargeStatus.mockResolvedValue('DECLINED');
    updateMany.mockResolvedValue({ count: 1 });
    expect(await destinoDe()).toContain('error=rechazado');
    expect(updateMany).toHaveBeenCalled();
  });

  it('todavía PENDING → pending, sin tocar la fila', async () => {
    fetchChargeStatus.mockResolvedValue('PENDING');
    expect(await destinoDe()).toContain('pending=true');
    expect(updateMany).not.toHaveBeenCalled();
  });
});
