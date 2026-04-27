/**
 * Transactional email wrapper around Resend.
 *
 * Why Resend: 3 000 free sends/mo and a 100-line setup. The whole reason this
 * file exists (instead of one-off `fetch` calls in route handlers) is so the
 * verification flow degrades GRACEFULLY when `RESEND_API_KEY` is missing —
 * preview deploys, fresh local checkouts and ad-hoc CI runs would otherwise
 * 500 on `/signup`. We return `{ ok: false, reason: 'no_api_key' }` and let
 * the caller decide whether to swallow it (signup) or surface it to the user
 * (a manual "resend" click should at least say "email is disabled").
 *
 * No external SDK on purpose — `fetch` keeps the bundle small and avoids
 * pulling Node-only deps into Edge code paths if a route is later flipped
 * to `edge` runtime.
 *
 * SECURITY:
 *   - We never log the recipient address or token. The body of the email
 *     contains the verification link which IS the secret — anything that
 *     logs it gets tagged with [redacted].
 *   - We never throw. Email is best-effort; signup must not 500 because
 *     Resend is briefly unavailable.
 */

const RESEND_API = 'https://api.resend.com/emails';

/** Default sender — verified at the Resend dashboard for autoenvia.com. */
const DEFAULT_FROM = 'LabelFlow <noreply@autoenvia.com>';

export type SendResult =
  | { ok: true; id: string }
  | {
      ok: false;
      /**
       * Coarse reason buckets so callers can branch without parsing strings.
       *  - `no_api_key`   → infra not wired up (preview / local). Soft-fail.
       *  - `http_error`   → Resend returned non-2xx. Includes message.
       *  - `network_error`→ fetch threw. Includes message.
       *  - `invalid_args` → caller passed empty `to` or `subject`.
       */
      reason: 'no_api_key' | 'http_error' | 'network_error' | 'invalid_args';
      message?: string;
    };

export interface SendEmailOpts {
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text fallback. Resend will auto-derive one if omitted. */
  text?: string;
  /** Override the default sender. Must be a verified Resend identity. */
  from?: string;
  /**
   * Tag for Resend analytics — bucket by flow ("verify_email", "welcome",
   * "low_credits", etc.). Helps slice deliverability per use case later.
   */
  tag?: string;
}

/**
 * Sends a transactional email via Resend.
 *
 * Returns a discriminated `{ ok }` result instead of throwing — every caller
 * in this app is in a hot path where we don't want one downed dep to take
 * down a signup or a billing webhook.
 */
export async function sendSystemEmail(opts: SendEmailOpts): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Soft-fail: signup MUST keep working if email is misconfigured. The
    // user can still log in with their password; verification just doesn't
    // gate them. The verification gate itself is env-flag-controlled
    // (`EMAIL_VERIFICATION_REQUIRED`) for exactly this scenario.
    return { ok: false, reason: 'no_api_key' };
  }

  if (!opts.to || !opts.subject) {
    return { ok: false, reason: 'invalid_args', message: 'missing to/subject' };
  }

  const from = opts.from ?? process.env.RESEND_FROM ?? DEFAULT_FROM;

  // Resend payload — see https://resend.com/docs/api-reference/emails/send-email
  const payload: Record<string, unknown> = {
    from,
    to: [opts.to],
    subject: opts.subject,
    html: opts.html,
  };
  if (opts.text) payload.text = opts.text;
  if (opts.tag) payload.tags = [{ name: 'flow', value: opts.tag }];

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      // 8 s — Resend p99 is ~1.5 s, so this catches genuinely degraded
      // delivery. We'd rather skip the email than block signup for 30 s.
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      // Resend returns `{ name, message, statusCode }`. We don't echo the
      // recipient back — it'd already be in our DB log via the caller.
      let detail = `${res.status}`;
      try {
        const data = (await res.json()) as { message?: string };
        if (data?.message) detail = `${res.status}: ${data.message}`;
      } catch {
        /* body wasn't JSON — keep the status code */
      }
      return { ok: false, reason: 'http_error', message: detail };
    }

    const data = (await res.json()) as { id?: string };
    return { ok: true, id: data.id ?? 'unknown' };
  } catch (err) {
    return {
      ok: false,
      reason: 'network_error',
      message: err instanceof Error ? err.message : 'fetch failed',
    };
  }
}

/**
 * Email-templating helpers. Inline styles only — Gmail/Outlook strip
 * <style> tags and <link> stylesheets; nothing about our brand colors is
 * worth rendering broken in 30 % of inboxes.
 *
 * The brand palette mirrors the dashboard (`#06b6d4` cyan accent on a
 * near-black background), but we soften it for email since most clients
 * default to a white background and pure-black panels look intrusive.
 */
function emailShell(opts: { title: string; body: string; cta?: { href: string; label: string } }): string {
  const { title, body, cta } = opts;
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f5;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:24px 32px;border-bottom:1px solid #f4f4f5;">
                <span style="font-size:18px;font-weight:700;color:#111827;letter-spacing:-0.01em;">Label<span style="color:#06b6d4;">Flow</span></span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-size:22px;font-weight:600;line-height:1.3;color:#111827;">${title}</h1>
                <div style="font-size:15px;line-height:1.6;color:#374151;">${body}</div>
                ${
                  cta
                    ? `<div style="margin:32px 0 8px;"><a href="${cta.href}" style="display:inline-block;background:#06b6d4;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:8px;">${cta.label}</a></div>
                       <p style="margin:24px 0 0;font-size:13px;color:#6b7280;line-height:1.5;">Si el botón no funciona, copiá y pegá este link en tu navegador:<br/><span style="word-break:break-all;color:#374151;">${cta.href}</span></p>`
                    : ''
                }
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background:#fafafa;border-top:1px solid #f4f4f5;font-size:12px;color:#9ca3af;line-height:1.5;">
                LabelFlow · Automatización Shopify → DAC para Uruguay<br/>
                <a href="https://autoenvia.com" style="color:#06b6d4;text-decoration:none;">autoenvia.com</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Renders the "verify your email" template. Caller passes the full link
 * (origin already resolved server-side) so this file stays free of any
 * env / request-scope coupling and is trivial to unit-test.
 */
export function renderVerificationEmail(opts: { name: string; verifyUrl: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const { name, verifyUrl } = opts;
  const safeName = (name || 'Hola').slice(0, 80);

  const html = emailShell({
    title: 'Confirmá tu email para activar LabelFlow',
    body: `<p style="margin:0 0 12px;">Hola <strong>${safeName}</strong>,</p>
<p style="margin:0 0 12px;">Gracias por crear una cuenta en LabelFlow. Para empezar a despachar pedidos de Shopify hacia DAC sin escribir guías a mano, confirmá que este email es tuyo:</p>`,
    cta: { href: verifyUrl, label: 'Confirmar mi email' },
  });

  const text = `Hola ${safeName},

Gracias por crear una cuenta en LabelFlow. Confirmá tu email entrando a este link:

${verifyUrl}

El link expira en 24 horas. Si no fuiste vos, podés ignorar este mensaje.

— LabelFlow / autoenvia.com`;

  return {
    subject: 'Confirmá tu email — LabelFlow',
    html,
    text,
  };
}
