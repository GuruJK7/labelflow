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

/**
 * Remitente por defecto.
 *
 * 🔴 `autoenvia.com` NO está verificado en Resend (al 14-09-2026 el dominio no
 * tiene ni SPF ni DKIM). Por eso producción pisa esto con `RESEND_FROM` y manda
 * desde `labelflowsas.com` — que sí está verificado, pero es OTRA marca, y Gmail
 * lo castiga: un dominio desconocido mandando links a autoenvia.com.
 *
 * Este default queda apuntando al dominio correcto a propósito: el día que se
 * verifique `autoenvia.com` en Resend, alcanza con BORRAR `RESEND_FROM` de
 * Vercel y los mails salen bien, sin tocar código. `diagnosticoDeCorreo()` avisa
 * en /api/health mientras tanto.
 */
const DEFAULT_FROM = 'AutoEnvía <noreply@autoenvia.com>';

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
  /** A dónde contesta quien aprieta "Responder". Default: `RESEND_REPLY_TO`. */
  replyTo?: string;
  /**
   * Tag for Resend analytics — bucket by flow ("verify_email", "welcome",
   * "low_credits", etc.). Helps slice deliverability per use case later.
   */
  tag?: string;
}

/** El dominio que hay adentro de un "Nombre <mail@dominio>" o de un mail pelado. */
export function dominioDelRemitente(from: string): string | null {
  const m = from.match(/<([^>]+)>/);
  const mail = (m ? m[1] : from).trim();
  const i = mail.lastIndexOf('@');
  return i === -1 ? null : mail.slice(i + 1).toLowerCase();
}

export type DiagnosticoCorreo =
  | { status: 'ok'; remitente: string }
  | { status: 'degraded'; remitente: string | null; reason: string }
  | { status: 'not_configured' };

/**
 * Cómo está parado el correo saliente. NO manda nada: un health-check que
 * enviara un mail de prueba costaría un envío por cada ping.
 *
 * 🔴 La comprobación que importa es la última, y es la que faltaba: que el
 * dominio DESDE el que mandamos sea el mismo al que apunta la app. El 14-09-2026
 * el sitio era `autoenvia.com` y los mails salían de `labelflowsas.com`. Para
 * Gmail eso es un dominio desconocido mandando links a otro dominio —señal
 * clásica de phishing— y los filtra. Llegaban a buzones permisivos y se perdían
 * en Google Workspace, sin una sola línea de error en ningún lado.
 *
 * No devuelve nunca la clave ni nada sensible: sólo el remitente, que ya viaja
 * en la cabecera de cada mail que mandamos.
 */
export function diagnosticoDeCorreo(): DiagnosticoCorreo {
  if (!process.env.RESEND_API_KEY) return { status: 'not_configured' };

  const from = process.env.RESEND_FROM ?? DEFAULT_FROM;
  const dominioFrom = dominioDelRemitente(from);
  if (!dominioFrom) {
    return { status: 'degraded', remitente: from, reason: 'el remitente no tiene un dominio válido' };
  }

  const appUrl = process.env.NEXTAUTH_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '';
  let dominioApp: string | null = null;
  try {
    dominioApp = appUrl ? new URL(appUrl).hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    dominioApp = null;
  }

  // Se compara el dominio registrable, así `mail.autoenvia.com` cuenta como
  // propio: lo que penaliza Gmail es mandar desde OTRA marca, no desde un
  // subdominio de la misma.
  const raiz = (d: string) => d.split('.').slice(-2).join('.');
  if (dominioApp && raiz(dominioFrom) !== raiz(dominioApp)) {
    return {
      status: 'degraded',
      remitente: from,
      reason: `los mails salen de ${dominioFrom} pero la app es ${dominioApp}: Gmail lo trata como sospechoso`,
    };
  }

  return { status: 'ok', remitente: from };
}

/**
 * El dominio del destinatario, nunca la dirección.
 *
 * Es el único dato del receptor que se loguea, y es a propósito: con
 * "gmail.com" o "vittoriaco.com" alcanza para ver que TODOS los envíos a un
 * proveedor están rebotando —que es la falla que importa— sin guardar el mail
 * de nadie en los logs.
 */
function dominioDe(email: string): string {
  const i = email.lastIndexOf('@');
  return i === -1 ? 'sin-dominio' : email.slice(i + 1).toLowerCase();
}

/**
 * 🔴 Todo envío deja rastro, falle o no.
 *
 * Antes esta función devolvía el error prolijamente y NINGUNO de los dos que la
 * llaman lo miraba: el endpoint de reenvío contesta `{ok:true}` siempre (es
 * anti-enumeración, está bien) y el alta se lo traga para no tirar abajo el
 * registro. Resultado: si Resend rechazaba un envío, no quedaba una sola línea
 * en ningún lado. Pasó de verdad el 14-09-2026 — un mail que no llegaba y los
 * logs de Vercel mudos.
 *
 * Por eso el log vive ACÁ y no en los callers: es el único punto por donde pasa
 * todo el correo saliente, así que un caller nuevo no puede olvidarse.
 */
function logEnvio(opts: SendEmailOpts, res: SendResult): void {
  const base = { flujo: opts.tag ?? 'sin-tag', dominio: dominioDe(opts.to ?? '') };
  if (res.ok) {
    // El id es el que figura en resend.com/emails: permite cruzar un reclamo
    // concreto con su entrega sin tener que buscar por destinatario.
    console.info('[email] enviado', JSON.stringify({ ...base, id: res.id }));
    return;
  }
  // `no_api_key` es el caso esperado en preview y local: no es un incidente.
  const nivel = res.reason === 'no_api_key' ? console.warn : console.error;
  nivel(
    '[email] NO SE PUDO ENVIAR',
    JSON.stringify({ ...base, motivo: res.reason, detalle: res.message ?? null }),
  );
}

/**
 * Sends a transactional email via Resend.
 *
 * Returns a discriminated `{ ok }` result instead of throwing — every caller
 * in this app is in a hot path where we don't want one downed dep to take
 * down a signup or a billing webhook. Todo envío queda logueado (ver `logEnvio`).
 */
export async function sendSystemEmail(opts: SendEmailOpts): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Soft-fail: signup MUST keep working if email is misconfigured. The
    // user can still log in with their password; verification just doesn't
    // gate them. The verification gate itself is env-flag-controlled
    // (`EMAIL_VERIFICATION_REQUIRED`) for exactly this scenario.
    const r: SendResult = { ok: false, reason: 'no_api_key' };
    logEnvio(opts, r);
    return r;
  }

  if (!opts.to || !opts.subject) {
    const r: SendResult = { ok: false, reason: 'invalid_args', message: 'missing to/subject' };
    logEnvio(opts, r);
    return r;
  }

  const from = opts.from ?? process.env.RESEND_FROM ?? DEFAULT_FROM;

  // 🔴 Un "noreply@" sin Reply-To es una pared: el comerciante que contesta
  // pidiendo ayuda —y contestan, es lo primero que hace cualquiera— le escribe
  // a un buzón que nadie lee, y se queda esperando. Con `RESEND_REPLY_TO`
  // puesto, esa respuesta cae donde hay alguien. Sin la variable el
  // comportamiento es exactamente el de antes.
  const replyTo = opts.replyTo ?? process.env.RESEND_REPLY_TO;

  // Resend payload — see https://resend.com/docs/api-reference/emails/send-email
  const payload: Record<string, unknown> = {
    from,
    to: [opts.to],
    subject: opts.subject,
    html: opts.html,
  };
  if (opts.text) payload.text = opts.text;
  if (replyTo) payload.reply_to = replyTo;
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
      const r: SendResult = { ok: false, reason: 'http_error', message: detail };
      logEnvio(opts, r);
      return r;
    }

    const data = (await res.json()) as { id?: string };
    const r: SendResult = { ok: true, id: data.id ?? 'unknown' };
    logEnvio(opts, r);
    return r;
  } catch (err) {
    const r: SendResult = {
      ok: false,
      reason: 'network_error',
      message: err instanceof Error ? err.message : 'fetch failed',
    };
    logEnvio(opts, r);
    return r;
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
                <span style="font-size:18px;font-weight:700;color:#111827;letter-spacing:-0.01em;">Auto<span style="color:#06b6d4;">Envía</span></span>
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
                AutoEnvía · Automatización Shopify → DAC para Uruguay<br/>
                por LabelFlow SAS · <a href="https://autoenvia.com" style="color:#06b6d4;text-decoration:none;">autoenvia.com</a>
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
    title: 'Confirmá tu email para activar AutoEnvía',
    body: `<p style="margin:0 0 12px;">Hola <strong>${safeName}</strong>,</p>
<p style="margin:0 0 12px;">Gracias por crear una cuenta en AutoEnvía. Para empezar a despachar pedidos de Shopify hacia DAC sin escribir guías a mano, confirmá que este email es tuyo:</p>`,
    cta: { href: verifyUrl, label: 'Confirmar mi email' },
  });

  const text = `Hola ${safeName},

Gracias por crear una cuenta en AutoEnvía. Confirmá tu email entrando a este link:

${verifyUrl}

El link expira en 24 horas. Si no fuiste vos, podés ignorar este mensaje.

— AutoEnvía (por LabelFlow SAS) / autoenvia.com`;

  return {
    subject: 'Confirmá tu email — AutoEnvía',
    html,
    text,
  };
}

/**
 * Renders the "reset your password" template (2026-05-15).
 *
 * SECURITY copy:
 *   - Mentions explicit 1-hour expiry so users don't wait.
 *   - Mentions "if you didn't request this, ignore" so phishing victims
 *     have a clear no-op path.
 *   - Does NOT include the requestIp in the email — IP geolocation is
 *     useful for the SRE side, noisy/scary for legitimate users.
 */
export function renderPasswordResetEmail(opts: { name: string; resetUrl: string }): {
  subject: string;
  html: string;
  text: string;
} {
  const { name, resetUrl } = opts;
  const safeName = (name || 'Hola').slice(0, 80);

  const html = emailShell({
    title: 'Cambiá tu contraseña de AutoEnvía',
    body: `<p style="margin:0 0 12px;">Hola <strong>${safeName}</strong>,</p>
<p style="margin:0 0 12px;">Recibimos un pedido para restablecer la contraseña de tu cuenta en AutoEnvía. Si fuiste vos, hacé clic en el botón de abajo para elegir una nueva contraseña:</p>
<p style="margin:0 0 12px;font-size:13px;color:#666;">El link expira en <strong>1 hora</strong>. Si no fuiste vos, podés ignorar este mensaje — tu contraseña actual no cambia hasta que alguien complete el formulario.</p>`,
    cta: { href: resetUrl, label: 'Elegir nueva contraseña' },
  });

  const text = `Hola ${safeName},

Recibimos un pedido para restablecer tu contraseña en AutoEnvía.

Si fuiste vos, entrá a este link para elegir una nueva contraseña:

${resetUrl}

El link expira en 1 hora. Si no fuiste vos, podés ignorar este mensaje — tu contraseña actual no cambia hasta que alguien complete el formulario.

— AutoEnvía (por LabelFlow SAS) / autoenvia.com`;

  return {
    subject: 'Restablecer contraseña — AutoEnvía',
    html,
    text,
  };
}
