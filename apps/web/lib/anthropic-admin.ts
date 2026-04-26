/**
 * Anthropic Admin API client — pulls real spend data from
 * platform.claude.com/cost (the same numbers shown in the Console).
 *
 * Auth: X-Api-Key header with an *Admin* API key (sk-ant-admin-...).
 * The admin key is different from the regular API key — it's created at
 * Console → Settings → Admin API keys, and only the org owner can mint it.
 *
 * Configure in env:
 *   ANTHROPIC_ADMIN_API_KEY=sk-ant-admin-...
 *
 * If the env var is missing this module returns nulls everywhere so the
 * admin dashboard degrades gracefully (we still show address-resolver
 * costs from the local DB).
 */

const COST_ENDPOINT = 'https://api.anthropic.com/v1/organizations/cost_report';

/**
 * Anthropic charges in USD cents and returns amounts as strings (to avoid
 * float drift). We coerce to dollars only at display time.
 */
type AnthropicCostType = 'tokens' | 'web_search' | 'code_execution' | 'session_usage';

interface AnthropicCostResultRaw {
  amount: string; // USD cents, e.g. "46" → $0.46
  cost_type: AnthropicCostType;
  model?: string;
  service_tier?: string;
  token_type?: string;
  context_window?: string;
  workspace_id?: string;
  description?: string;
  currency: string;
}

interface AnthropicCostBucket {
  starting_at: string;
  ending_at: string;
  results: AnthropicCostResultRaw[];
}

interface AnthropicCostResponse {
  data: AnthropicCostBucket[];
  has_more: boolean;
  next_page?: string | null;
}

export interface AnthropicCostDailyPoint {
  date: string;            // YYYY-MM-DD (UTC, matching bucket start)
  tokensUsd: number;
  webSearchUsd: number;
  codeExecUsd: number;
  sessionUsd: number;
  totalUsd: number;
}

export interface AnthropicCostSummary {
  configured: boolean;        // false → admin key not set, callers should hide UI
  fetchedOk: boolean;         // false → api errored, last fetch failed
  errorMessage?: string;
  rangeStart: string;         // ISO
  rangeEnd: string;           // ISO
  daily: AnthropicCostDailyPoint[];
  totals: {
    tokensUsd: number;
    webSearchUsd: number;
    codeExecUsd: number;
    sessionUsd: number;
    totalUsd: number;
  };
}

/**
 * Fetch daily cost buckets for the last `days` days. Pagination is
 * handled internally — the endpoint only supports `bucket_width=1d` so
 * 30 days is at most a few hundred result rows.
 */
export async function fetchAnthropicCostReport(days: number = 30): Promise<AnthropicCostSummary> {
  const empty: AnthropicCostSummary = {
    configured: false,
    fetchedOk: false,
    rangeStart: '',
    rangeEnd: '',
    daily: [],
    totals: { tokensUsd: 0, webSearchUsd: 0, codeExecUsd: 0, sessionUsd: 0, totalUsd: 0 },
  };

  const adminKey = process.env.ANTHROPIC_ADMIN_API_KEY;
  if (!adminKey) return empty;

  // Anthropic expects RFC 3339; the bucket boundaries align to UTC midnight.
  const now = new Date();
  const endingAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const startingAt = new Date(endingAt);
  startingAt.setUTCDate(startingAt.getUTCDate() - days);

  const buckets: AnthropicCostBucket[] = [];
  let nextPage: string | null | undefined = undefined;

  try {
    do {
      const params = new URLSearchParams({
        starting_at: startingAt.toISOString(),
        ending_at: endingAt.toISOString(),
        bucket_width: '1d',
        limit: '1000',
      });
      if (nextPage) params.set('page', nextPage);

      const res = await fetch(`${COST_ENDPOINT}?${params.toString()}`, {
        headers: {
          'x-api-key': adminKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        // Cache busting — Next.js would happily memo this otherwise.
        cache: 'no-store',
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          ...empty,
          configured: true,
          fetchedOk: false,
          errorMessage: `Anthropic API ${res.status}: ${text.slice(0, 200)}`,
          rangeStart: startingAt.toISOString(),
          rangeEnd: endingAt.toISOString(),
        };
      }

      const json = (await res.json()) as AnthropicCostResponse;
      buckets.push(...(json.data ?? []));
      nextPage = json.has_more ? json.next_page : null;
    } while (nextPage);
  } catch (err) {
    return {
      ...empty,
      configured: true,
      fetchedOk: false,
      errorMessage: (err as Error).message,
      rangeStart: startingAt.toISOString(),
      rangeEnd: endingAt.toISOString(),
    };
  }

  // ── Aggregate buckets into daily points ──
  const daily = buckets
    .map((b) => {
      const point: AnthropicCostDailyPoint = {
        date: b.starting_at.slice(0, 10),
        tokensUsd: 0,
        webSearchUsd: 0,
        codeExecUsd: 0,
        sessionUsd: 0,
        totalUsd: 0,
      };
      for (const r of b.results) {
        const cents = parseFloat(r.amount);
        if (!Number.isFinite(cents)) continue;
        const usd = cents / 100;
        switch (r.cost_type) {
          case 'tokens': point.tokensUsd += usd; break;
          case 'web_search': point.webSearchUsd += usd; break;
          case 'code_execution': point.codeExecUsd += usd; break;
          case 'session_usage': point.sessionUsd += usd; break;
        }
      }
      point.totalUsd = round4(
        point.tokensUsd + point.webSearchUsd + point.codeExecUsd + point.sessionUsd,
      );
      point.tokensUsd = round4(point.tokensUsd);
      point.webSearchUsd = round4(point.webSearchUsd);
      point.codeExecUsd = round4(point.codeExecUsd);
      point.sessionUsd = round4(point.sessionUsd);
      return point;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const totals = daily.reduce(
    (acc, p) => ({
      tokensUsd: acc.tokensUsd + p.tokensUsd,
      webSearchUsd: acc.webSearchUsd + p.webSearchUsd,
      codeExecUsd: acc.codeExecUsd + p.codeExecUsd,
      sessionUsd: acc.sessionUsd + p.sessionUsd,
      totalUsd: acc.totalUsd + p.totalUsd,
    }),
    { tokensUsd: 0, webSearchUsd: 0, codeExecUsd: 0, sessionUsd: 0, totalUsd: 0 },
  );

  return {
    configured: true,
    fetchedOk: true,
    rangeStart: startingAt.toISOString(),
    rangeEnd: endingAt.toISOString(),
    daily,
    totals: {
      tokensUsd: round4(totals.tokensUsd),
      webSearchUsd: round4(totals.webSearchUsd),
      codeExecUsd: round4(totals.codeExecUsd),
      sessionUsd: round4(totals.sessionUsd),
      totalUsd: round4(totals.totalUsd),
    },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
