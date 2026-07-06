/**
 * Unit tests for the ENRICHED dashboard writeback (pushDashboardLabels).
 * Verifica el chunking (límite de body en Vercel), el shape del payload que
 * consume el receptor `/api/v1/orders/loaded` de AutoEnvía, la compat con `ids`,
 * la suma de `labeled`, y el trim de la URL + header de auth. axios mockeado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('axios', () => ({
  default: { post: vi.fn() },
}));

import axios from 'axios';
import { pushDashboardLabels, type DashboardLabelResult } from '../dashboard/orders';

const post = axios.post as unknown as ReturnType<typeof vi.fn>;

function mkResult(i: number): DashboardLabelResult {
  return {
    order_id: `uuid-${i}`,
    status: 'labeled',
    tracking: `GUIA-${i}`,
    pdf_base64: Buffer.from(`pdf-${i}`).toString('base64'),
    dac_account_used: '12345678',
  };
}

describe('pushDashboardLabels — enriched writeback', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: { labeled: 0 } });
  });

  it('no hace ningún POST y devuelve 0 con lista vacía', async () => {
    const n = await pushDashboardLabels('https://x.com', 'tok', []);
    expect(n).toBe(0);
    expect(post).not.toHaveBeenCalled();
  });

  it('manda un solo chunk cuando hay ≤8 resultados', async () => {
    post.mockResolvedValue({ data: { labeled: 3 } });
    const n = await pushDashboardLabels('https://app.autoenvia.com', 'tok', [mkResult(1), mkResult(2), mkResult(3)]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(n).toBe(3);
  });

  it('chunkea de a 8 (20 → 3 POSTs: 8+8+4) por el límite de body', async () => {
    post.mockResolvedValue({ data: { labeled: 1 } });
    const results = Array.from({ length: 20 }, (_, i) => mkResult(i));
    const n = await pushDashboardLabels('https://app.autoenvia.com', 'tok', results);
    expect(post).toHaveBeenCalledTimes(3);
    const sizes = post.mock.calls.map((c) => (c[1] as { results: unknown[] }).results.length);
    expect(sizes).toEqual([8, 8, 4]);
    expect(n).toBe(3); // 1 por chunk (mock), 3 chunks
  });

  it('el body lleva { results, ids } con el shape exacto del receptor', async () => {
    await pushDashboardLabels('https://app.autoenvia.com', 'tok', [mkResult(7)]);
    const body = post.mock.calls[0][1] as { results: DashboardLabelResult[]; ids: string[] };
    expect(body.ids).toEqual(['uuid-7']);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      order_id: 'uuid-7',
      status: 'labeled',
      tracking: 'GUIA-7',
      dac_account_used: '12345678',
    });
    expect(typeof body.results[0].pdf_base64).toBe('string');
  });

  it('trimea la barra final de la URL y manda el Bearer', async () => {
    await pushDashboardLabels('https://app.autoenvia.com/', 'mytoken', [mkResult(1)]);
    const [url, , cfg] = post.mock.calls[0] as [string, unknown, { headers: Record<string, string> }];
    expect(url).toBe('https://app.autoenvia.com/api/v1/orders/loaded');
    expect(cfg.headers.Authorization).toBe('Bearer mytoken');
  });

  it('suma los labeled de todos los chunks; tolera respuesta sin labeled (cae a updated)', async () => {
    post
      .mockResolvedValueOnce({ data: { labeled: 8 } })
      .mockResolvedValueOnce({ data: { updated: 5 } }); // receptor viejo devuelve `updated`
    const results = Array.from({ length: 12 }, (_, i) => mkResult(i));
    const n = await pushDashboardLabels('https://app.autoenvia.com', 'tok', results);
    expect(n).toBe(13);
  });
});
