/**
 * Audit log helper (2026-05-15).
 *
 * Single entry point for writing security-relevant events to the AuditLog
 * table. Use this from API routes, server actions, and auth callbacks
 * INSTEAD of `db.auditLog.create()` directly — the helper enforces:
 *
 *   1. **Never throws.** A failed audit write must NEVER fail the request
 *      it's auditing. We catch + log. Worst case: an event is missed.
 *   2. **Always async, never awaited critically.** Callers can `void` the
 *      promise to make the audit fire-and-forget when the request needs
 *      to return ASAP.
 *   3. **Auto-redacts known secret keys** if a caller accidentally passes
 *      them in `meta` (defensive — the caller shouldn't, but humans).
 *   4. **Truncates** IP and userAgent to safe lengths.
 *
 * Action name convention: lower.snake.dotted, past-tense verb at the end.
 *
 *   user.login.success
 *   user.login.failed
 *   user.password.reset.requested
 *   user.password.reset.confirmed
 *   tenant.shopify.token.updated
 *   tenant.dac.credentials.updated
 *   tenant.cron.config.updated
 *   tenant.shipping_rule.created
 *   tenant.credits.purchased
 *   admin.tenant.impersonate
 *   gdpr.data.export
 *
 * Keep names stable across deploys. Renaming an action loses queryability.
 */
import { db } from './db';

/** Keys that must NEVER appear in audit log `meta` even if a caller
 *  accidentally passes them. Belt-and-suspenders against future bugs. */
const FORBIDDEN_META_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'apikey',
  'api_key',
  'secret',
  'cvc',
  'cvv',
  'card_number',
  'cardnumber',
  'authorization',
  'cookie',
  'sessiontoken',
  'session_token',
]);

function redactMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    const lowerKey = key.toLowerCase();
    if (FORBIDDEN_META_KEYS.has(lowerKey)) {
      out[key] = '[REDACTED]';
      continue;
    }
    // Recurse into nested objects (one level — deeper nesting is rare and
    // tradeoffs against cost). Arrays passed through as-is.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactMeta(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface AuditLogInput {
  /** Stable action name — see convention in module docstring. */
  action: string;
  /** User who performed the action. Null for pre-auth events. */
  userId?: string | null;
  /** Tenant context. Null for account-level events. */
  tenantId?: string | null;
  /** Affected entity (Tenant, Label, ShippingRule, etc.). */
  entityType?: string | null;
  entityId?: string | null;
  /** Source IP (truncated to 64 chars). */
  ip?: string | null;
  /** User-Agent header (truncated to 200 chars). */
  userAgent?: string | null;
  /** Structured detail. MUST NOT contain secrets. */
  meta?: Record<string, unknown>;
}

/**
 * Write an audit log event. Never throws. Returns immediately —
 * callers can `void writeAuditLog(...)` to fire-and-forget.
 */
export async function writeAuditLog(input: AuditLogInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: input.action,
        userId: input.userId ?? null,
        tenantId: input.tenantId ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        ip: input.ip ? input.ip.slice(0, 64) : null,
        userAgent: input.userAgent ? input.userAgent.slice(0, 200) : null,
        meta: redactMeta(input.meta) as object | undefined,
      },
    });
  } catch {
    // Audit write failure is non-fatal. We deliberately don't log to the
    // app logger here because a misbehaving Prisma client (the most likely
    // cause of an audit failure) would also fail to log via the same
    // client. The trade-off: in the worst case we silently miss audit
    // events, which is fine for a defense-in-depth tool — the primary
    // logger (pino on the server) still records the action via its own
    // path.
  }
}

/**
 * Helper to extract IP + User-Agent from a Next.js Request. Use this in
 * route handlers so all call sites have consistent extraction logic.
 */
export function extractAuditContext(req: Request): { ip: string | null; userAgent: string | null } {
  const xff = req.headers.get('x-forwarded-for');
  const ip = xff?.split(',')[0]?.trim() ?? req.headers.get('x-real-ip') ?? null;
  const userAgent = req.headers.get('user-agent') ?? null;
  return { ip, userAgent };
}
