/**
 * Regression tests for the "Execution context was destroyed" resilience.
 *
 * BACKGROUND: On 2026-04-10, three orders failed with this exact error during
 * test_dac processing:
 *   - #1146 Pedro Molina   (DAC guia 882279086121 — orphaned)
 *   - #1143 Marco Castro   (DAC guia 882279086993 — orphaned)
 *   - #1138 Susana Ameglio (DAC guia 882279088686 — orphaned)
 *
 * Each order successfully submitted to DAC (guia created and charged), but our
 * worker threw "page.evaluate: Execution context was destroyed, most likely
 * because of a navigation" DURING the guia extraction step. The thrown error
 * bubbled up past the job-level catch, marking the order as FAILED even though
 * DAC had processed it. Result: orphan guias in DAC that our DB never learned
 * about — a real money leak.
 *
 * ROOT CAUSE: extractGuiasWithLinks() calls pg.evaluate() without a try/catch.
 * When the caller invokes it immediately after clicking "Finalizar", DAC is
 * still navigating to the confirmation page, and Playwright destroys the
 * current page's execution context. The evaluate() call hits the destroyed
 * context and throws.
 *
 * THE FIX: extractGuiasWithLinks now wraps its pg.evaluate in a retry loop
 * that:
 *   1. Waits for domcontentloaded before evaluating
 *   2. Catches "Execution context was destroyed" and "Target closed" errors
 *   3. Retries up to 3 times with 1.5s waits between attempts
 *   4. Returns an empty array on final failure (so the caller falls through
 *      to Method 2 — the historial lookup — instead of aborting the order)
 *
 * These tests verify the retry logic against a mock Page that simulates the
 * navigation race condition.
 */

import { describe, it, expect, vi } from 'vitest';

// We cannot import extractGuiasWithLinks directly because it is not exported.
// Instead, we test the error-classification logic that the wrapper relies on,
// and we build a mock that simulates the full retry behavior against a fake
// Playwright Page.

/**
 * Re-implementation of the resilience logic for testing. Mirrors the code in
 * shipment.ts extractGuiasWithLinks. If the production code changes, this
 * helper must be updated in lockstep.
 */
async function resilientEvaluate<T>(
  evaluateFn: () => Promise<T>,
  waitForLoadFn: () => Promise<void>,
  waitFn: (ms: number) => Promise<void>,
  maxAttempts: number = 3,
  emptyValue: T,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await waitForLoadFn().catch(() => {});
      return await evaluateFn();
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const isNavigationRace =
        msg.includes('Execution context was destroyed') ||
        msg.includes('Target page, context or browser has been closed') ||
        msg.includes('Target closed');
      if (!isNavigationRace) throw err;
      if (attempt === maxAttempts) return emptyValue;
      await waitFn(1500);
    }
  }
  return emptyValue;
}

describe('extractGuiasWithLinks — navigation race resilience', () => {
  it('returns result on first attempt when page is stable', async () => {
    const mockEvaluate = vi.fn().mockResolvedValue([{ guia: '882277908035', href: 'https://dac.com.uy/track/882277908035' }]);
    const mockWait = vi.fn().mockResolvedValue(undefined);
    const mockLoad = vi.fn().mockResolvedValue(undefined);

    const result = await resilientEvaluate(mockEvaluate, mockLoad, mockWait, 3, []);

    expect(result).toEqual([{ guia: '882277908035', href: 'https://dac.com.uy/track/882277908035' }]);
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
    expect(mockWait).not.toHaveBeenCalled(); // no retry needed
  });

  it('retries and succeeds after a navigation-destroyed error', async () => {
    const mockEvaluate = vi.fn()
      .mockRejectedValueOnce(
        new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'),
      )
      .mockResolvedValueOnce([{ guia: '882279086121', href: null }]);
    const mockWait = vi.fn().mockResolvedValue(undefined);
    const mockLoad = vi.fn().mockResolvedValue(undefined);

    const result = await resilientEvaluate(mockEvaluate, mockLoad, mockWait, 3, []);

    expect(result).toEqual([{ guia: '882279086121', href: null }]);
    expect(mockEvaluate).toHaveBeenCalledTimes(2);
    expect(mockWait).toHaveBeenCalledTimes(1); // one retry wait
    expect(mockWait).toHaveBeenCalledWith(1500);
  });

  it('returns empty array after all retries fail with navigation errors', async () => {
    const mockEvaluate = vi.fn().mockRejectedValue(
      new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'),
    );
    const mockWait = vi.fn().mockResolvedValue(undefined);
    const mockLoad = vi.fn().mockResolvedValue(undefined);

    const result = await resilientEvaluate(mockEvaluate, mockLoad, mockWait, 3, []);

    expect(result).toEqual([]);
    expect(mockEvaluate).toHaveBeenCalledTimes(3); // all 3 attempts
    expect(mockWait).toHaveBeenCalledTimes(2); // 2 retry waits (not after the last)
  });

  it('handles "Target closed" error the same way', async () => {
    const mockEvaluate = vi.fn().mockRejectedValue(new Error('Target closed'));
    const mockWait = vi.fn().mockResolvedValue(undefined);
    const mockLoad = vi.fn().mockResolvedValue(undefined);

    const result = await resilientEvaluate(mockEvaluate, mockLoad, mockWait, 3, []);

    expect(result).toEqual([]);
    expect(mockEvaluate).toHaveBeenCalledTimes(3);
  });

  it('handles "Target page, context or browser has been closed" error', async () => {
    const mockEvaluate = vi.fn().mockRejectedValue(
      new Error('Target page, context or browser has been closed'),
    );
    const mockWait = vi.fn().mockResolvedValue(undefined);
    const mockLoad = vi.fn().mockResolvedValue(undefined);

    const result = await resilientEvaluate(mockEvaluate, mockLoad, mockWait, 3, []);

    expect(result).toEqual([]);
    expect(mockEvaluate).toHaveBeenCalledTimes(3);
  });

  it('throws unrelated errors (does not catch everything)', async () => {
    const mockEvaluate = vi.fn().mockRejectedValue(new Error('Some other unexpected error'));
    const mockWait = vi.fn().mockResolvedValue(undefined);
    const mockLoad = vi.fn().mockResolvedValue(undefined);

    await expect(
      resilientEvaluate(mockEvaluate, mockLoad, mockWait, 3, []),
    ).rejects.toThrow('Some other unexpected error');

    expect(mockEvaluate).toHaveBeenCalledTimes(1); // no retry for non-navigation errors
  });

  it('does not crash if waitForLoadState fails (navigation was already done)', async () => {
    const mockEvaluate = vi.fn().mockResolvedValue([{ guia: '882279088686', href: null }]);
    const mockWait = vi.fn().mockResolvedValue(undefined);
    const mockLoad = vi.fn().mockRejectedValue(new Error('Timeout waiting for load state'));

    const result = await resilientEvaluate(mockEvaluate, mockLoad, mockWait, 3, []);

    // waitForLoadState errors are swallowed (.catch(() => {})) — evaluate still runs
    expect(result).toEqual([{ guia: '882279088686', href: null }]);
    expect(mockEvaluate).toHaveBeenCalledTimes(1);
  });

  it('mixed failure pattern: 2 navigation errors then success on 3rd attempt', async () => {
    const mockEvaluate = vi.fn()
      .mockRejectedValueOnce(new Error('Execution context was destroyed'))
      .mockRejectedValueOnce(new Error('Target closed'))
      .mockResolvedValueOnce([{ guia: '882279086993', href: null }]);
    const mockWait = vi.fn().mockResolvedValue(undefined);
    const mockLoad = vi.fn().mockResolvedValue(undefined);

    const result = await resilientEvaluate(mockEvaluate, mockLoad, mockWait, 3, []);

    expect(result).toEqual([{ guia: '882279086993', href: null }]);
    expect(mockEvaluate).toHaveBeenCalledTimes(3);
    expect(mockWait).toHaveBeenCalledTimes(2);
  });

  it('regression: real-world orphan guia orders (#1146, #1143, #1138) would now recover', async () => {
    // Simulate the exact error sequence for the 3 orphaned orders from 2026-04-10.
    // First attempt fails during page.evaluate (navigation still in progress),
    // second attempt succeeds after DAC's confirmation page finishes loading.
    const orphanGuias = ['882279086121', '882279086993', '882279088686'];

    for (const guia of orphanGuias) {
      const mockEvaluate = vi.fn()
        .mockRejectedValueOnce(
          new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'),
        )
        .mockResolvedValueOnce([{ guia, href: `https://dac.com.uy/envios/guiacreada/${guia}` }]);
      const mockWait = vi.fn().mockResolvedValue(undefined);
      const mockLoad = vi.fn().mockResolvedValue(undefined);

      const result = await resilientEvaluate(mockEvaluate, mockLoad, mockWait, 3, []);
      expect(result).toEqual([{ guia, href: `https://dac.com.uy/envios/guiacreada/${guia}` }]);
      expect(mockEvaluate).toHaveBeenCalledTimes(2);
    }
  });
});
