/**
 * Tests for finalizeRecoveredGuiaLabels() — the sweep that finalizes "recovered
 * orphan" labels stuck FAILED with a real guía but no PDF (2026-06-08 finding).
 *
 * The function must:
 *   - be a NO-OP unless the tenant is gated in (default OFF → byte-identical deploy),
 *   - for each stuck label, download the EXISTING guía's PDF (never re-submit),
 *     upload it, and flip the Label to COMPLETED,
 *   - skip PENDING- guías,
 *   - leave a Label untouched (still FAILED) on any download/upload failure, and
 *     never throw out of the sweep.
 *
 * Everything I/O is mocked: no DB, no DAC, no storage, no Shopify, no pino.
 * The real isStep3GeoTenantEnabled gate is exercised (only ../logger is mocked
 * so pino doesn't load).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── module mocks (hoisted) ──────────────────────────────────────────────────
vi.mock('../db', () => ({
  db: { label: { findMany: vi.fn(), update: vi.fn().mockResolvedValue({}) } },
}));
vi.mock('../dac/label', () => ({ downloadLabel: vi.fn() }));
vi.mock('../storage/upload', () => ({ uploadLabelPdf: vi.fn() }));
vi.mock('../shopify/fulfillment', () => ({
  fulfillOrderWithTracking: vi.fn().mockResolvedValue(undefined),
  ShopifyAlreadyFulfilledError: class ShopifyAlreadyFulfilledError extends Error {},
}));
vi.mock('../shopify/orders', () => ({ markOrderProcessed: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('fs', () => ({
  default: { existsSync: vi.fn(), readFileSync: vi.fn(), unlinkSync: vi.fn() },
}));

// ─── imports (after mocks) ───────────────────────────────────────────────────
import { finalizeRecoveredGuiaLabels } from '../dac/finalize-recovered-guias';
import { db } from '../db';
import { downloadLabel } from '../dac/label';
import { uploadLabelPdf } from '../storage/upload';
import { fulfillOrderWithTracking } from '../shopify/fulfillment';
import { markOrderProcessed } from '../shopify/orders';
import fs from 'fs';

const TENANT = 'cmpvjrj8j000112ak1fp6fm09';
const noopSlog: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() };

function baseOpts(enabledTenantsEnv: string | undefined) {
  return {
    page: {} as any,
    tenantId: TENANT,
    slog: noopSlog,
    tmpDir: '/tmp/labels',
    dacUsername: 'user',
    dacPassword: 'pass',
    shopifyClient: {} as any,
    enabledTenantsEnv,
  };
}

const stuckLabel = {
  id: 'L1',
  shopifyOrderId: '111222',
  shopifyOrderName: '#5500',
  dacGuia: '8821238402641',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('finalizeRecoveredGuiaLabels — gate (default OFF)', () => {
  it('no-op when env is undefined — never touches the DB', async () => {
    const r = await finalizeRecoveredGuiaLabels(baseOpts(undefined));
    expect(r).toEqual({ scanned: 0, finalized: 0, failed: 0 });
    expect(db.label.findMany).not.toHaveBeenCalled();
    expect(downloadLabel).not.toHaveBeenCalled();
  });

  it('no-op when the tenant is not in the list', async () => {
    const r = await finalizeRecoveredGuiaLabels(baseOpts('some-other-tenant'));
    expect(db.label.findMany).not.toHaveBeenCalled();
    expect(r.finalized).toBe(0);
  });
});

describe('finalizeRecoveredGuiaLabels — happy path (gated via "*")', () => {
  beforeEach(() => {
    (db.label.findMany as any).mockResolvedValue([stuckLabel]);
    (downloadLabel as any).mockResolvedValue('/tmp/labels/8821238402641.pdf');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(Buffer.from('%PDF-1.4'));
    (uploadLabelPdf as any).mockResolvedValue({ path: `${TENANT}/2026-06-08/L1.pdf`, error: null });
  });

  it('downloads the EXISTING guía PDF, uploads, and marks COMPLETED', async () => {
    const r = await finalizeRecoveredGuiaLabels(baseOpts('*'));

    // Downloads the existing guía — NOT a new DAC form submission.
    expect(downloadLabel).toHaveBeenCalledTimes(1);
    expect(downloadLabel).toHaveBeenCalledWith(
      expect.anything(),
      '8821238402641',
      '/tmp/labels',
      'user',
      'pass',
    );
    expect(uploadLabelPdf).toHaveBeenCalledWith(TENANT, 'L1', expect.any(Buffer));
    expect(db.label.update).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { pdfPath: `${TENANT}/2026-06-08/L1.pdf`, status: 'COMPLETED', errorMessage: null },
    });
    expect(r).toEqual({ scanned: 1, finalized: 1, failed: 0 });
  });

  it('best-effort fulfills + tags in Shopify after finalizing', async () => {
    await finalizeRecoveredGuiaLabels(baseOpts('*'));
    expect(fulfillOrderWithTracking).toHaveBeenCalledWith(expect.anything(), 111222, '8821238402641');
    expect(markOrderProcessed).toHaveBeenCalledWith(expect.anything(), 111222, '8821238402641');
  });

  it('a Shopify fulfill failure does NOT undo the finalization (best-effort)', async () => {
    (fulfillOrderWithTracking as any).mockRejectedValue(new Error('shopify down'));
    const r = await finalizeRecoveredGuiaLabels(baseOpts('*'));
    expect(db.label.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED' }) }),
    );
    expect(r.finalized).toBe(1);
  });
});

describe('finalizeRecoveredGuiaLabels — exclusions & failures leave the Label FAILED', () => {
  it('skips PENDING- guías (never a real shipment)', async () => {
    (db.label.findMany as any).mockResolvedValue([
      { ...stuckLabel, dacGuia: 'PENDING-1717000000' },
    ]);
    const r = await finalizeRecoveredGuiaLabels(baseOpts('*'));
    expect(r).toEqual({ scanned: 0, finalized: 0, failed: 0 });
    expect(downloadLabel).not.toHaveBeenCalled();
    expect(db.label.update).not.toHaveBeenCalled();
  });

  it('PDF not available yet (no file) → leaves FAILED, counts as failed', async () => {
    (db.label.findMany as any).mockResolvedValue([stuckLabel]);
    (downloadLabel as any).mockResolvedValue('/tmp/labels/8821238402641.pdf');
    (fs.existsSync as any).mockReturnValue(false);
    const r = await finalizeRecoveredGuiaLabels(baseOpts('*'));
    expect(db.label.update).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, finalized: 0, failed: 1 });
  });

  it('upload error → leaves FAILED, does NOT mark COMPLETED', async () => {
    (db.label.findMany as any).mockResolvedValue([stuckLabel]);
    (downloadLabel as any).mockResolvedValue('/tmp/labels/8821238402641.pdf');
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readFileSync as any).mockReturnValue(Buffer.from('%PDF'));
    (uploadLabelPdf as any).mockResolvedValue({ path: '', error: 'S3 timeout' });
    const r = await finalizeRecoveredGuiaLabels(baseOpts('*'));
    expect(db.label.update).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, finalized: 0, failed: 1 });
  });

  it('downloadLabel throwing does not crash the sweep', async () => {
    (db.label.findMany as any).mockResolvedValue([stuckLabel]);
    (downloadLabel as any).mockRejectedValue(new Error('DAC 500'));
    const r = await finalizeRecoveredGuiaLabels(baseOpts('*'));
    expect(db.label.update).not.toHaveBeenCalled();
    expect(r).toEqual({ scanned: 1, finalized: 0, failed: 1 });
  });
});
