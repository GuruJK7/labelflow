/**
 * O-2 (2026-04-21 audit): 2Captcha balance probe with low-balance alert.
 *
 * Without this, the first warning we get about a depleted 2Captcha wallet
 * is "DAC login failed — Error solving CAPTCHA: ERROR_ZERO_BALANCE" on
 * whichever tenant hits the fresh-login path first after the balance runs
 * out. That tenant's cron job fails silently (only reconcile sees it),
 * and by the time ops notices, every tenant that needed a new cookie
 * during the gap has fallen behind.
 *
 * This helper polls 2Captcha's balance endpoint and logs at ERROR level
 * if the wallet is below the configured threshold. Called once per day
 * from the scheduler's daily guard — we don't poll more often because
 * 2Captcha rate-limits balance checks and once per day is enough warning
 * to top up a payment-gated external service.
 *
 * Expected call site: scheduler.ts daily guard (runs at 00:xx UY).
 */
import { Solver } from '2captcha-ts';
import logger from '../logger';

// $5 gives us roughly 1000–2000 reCAPTCHA v2 solves at current prices,
// which covers ~30 days of normal operation across all tenants. Alerting
// at $5 leaves plenty of runway to act before the wallet actually hits
// zero.
const LOW_BALANCE_USD_THRESHOLD = 5;

export async function probeCaptchaBalance(): Promise<{
  balance: number | null;
  ok: boolean;
  reason?: string;
}> {
  const apiKey = process.env.CAPTCHA_API_KEY;
  if (!apiKey) {
    logger.warn('[CaptchaBalance] CAPTCHA_API_KEY not set — cannot probe 2Captcha balance');
    return { balance: null, ok: false, reason: 'no_api_key' };
  }

  try {
    const solver = new Solver(apiKey);
    // 2captcha-ts exposes `balance()` → Promise<number> in USD.
    const balance = await solver.balance();

    if (balance < LOW_BALANCE_USD_THRESHOLD) {
      logger.error(
        {
          balanceUsd: balance,
          thresholdUsd: LOW_BALANCE_USD_THRESHOLD,
        },
        '[CaptchaBalance] 2Captcha balance below threshold — TOP UP SOON to avoid login failures',
      );
      return { balance, ok: false, reason: 'below_threshold' };
    }

    logger.info({ balanceUsd: balance }, '[CaptchaBalance] 2Captcha balance OK');
    return { balance, ok: true };
  } catch (err) {
    // Balance endpoint failure is not a fatal error — it just means we
    // have no visibility for today. Log and move on; the next day's
    // probe may succeed.
    logger.warn(
      { error: (err as Error).message },
      '[CaptchaBalance] Balance probe failed',
    );
    return { balance: null, ok: false, reason: 'probe_failed' };
  }
}
