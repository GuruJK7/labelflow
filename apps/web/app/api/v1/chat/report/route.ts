import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

const REPORT_EMAIL = 'adrianspinellilemo@gmail.com';

export async function POST(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  let body: { type: string; summary: string; conversation: Array<{ role: string; content: string }> };
  try {
    body = await req.json();
  } catch {
    return apiError('Datos invalidos', 400);
  }

  const { type, summary, conversation } = body;
  if (!type || !summary) {
    return apiError('Tipo y resumen son requeridos', 400);
  }

  // Get tenant info for context
  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { name: true, shopifyStoreUrl: true, emailHost: true, emailUser: true, emailPass: true, emailFrom: true },
  });

  // Build email body
  const timestamp = new Date().toLocaleString('es-UY', { timeZone: 'America/Montevideo' });
  const typeLabel = type === 'bug' ? 'Bug Report' : type === 'feedback' ? 'Feedback' : 'Solicitud de ayuda';

  const conversationText = conversation
    .map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`)
    .join('\n\n');

  const emailHtml = `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; background: #111; color: #fafafa; padding: 24px; border-radius: 12px;">
      <div style="border-bottom: 1px solid #333; padding-bottom: 16px; margin-bottom: 16px;">
        <h1 style="color: #06b6d4; margin: 0; font-size: 18px;">${typeLabel} — LabelFlow</h1>
        <p style="color: #888; font-size: 12px; margin: 4px 0 0;">${timestamp}</p>
      </div>

      <div style="background: #1a1a1a; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
        <p style="color: #06b6d4; font-size: 11px; text-transform: uppercase; margin: 0 0 8px;">Tenant</p>
        <p style="margin: 0; font-size: 14px;">${tenant?.name ?? 'Desconocido'} (${tenant?.shopifyStoreUrl ?? 'sin tienda'})</p>
        <p style="color: #888; font-size: 12px; margin: 4px 0 0;">Tenant ID: ${auth.tenantId}</p>
      </div>

      <div style="background: #1a1a1a; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
        <p style="color: #06b6d4; font-size: 11px; text-transform: uppercase; margin: 0 0 8px;">Resumen</p>
        <p style="margin: 0; font-size: 14px; white-space: pre-wrap;">${summary}</p>
      </div>

      <div style="background: #1a1a1a; padding: 16px; border-radius: 8px;">
        <p style="color: #06b6d4; font-size: 11px; text-transform: uppercase; margin: 0 0 12px;">Conversacion completa</p>
        ${conversation
          .map(
            (m) => `
          <div style="margin-bottom: 12px; padding: 8px 12px; border-radius: 8px; background: ${m.role === 'user' ? '#0e7490' : '#222'};">
            <p style="color: ${m.role === 'user' ? '#67e8f9' : '#888'}; font-size: 10px; margin: 0 0 4px; text-transform: uppercase;">${m.role === 'user' ? 'Usuario' : 'Asistente'}</p>
            <p style="margin: 0; font-size: 13px; white-space: pre-wrap;">${m.content}</p>
          </div>`
          )
          .join('')}
      </div>
    </div>
  `;

  const emailText = `${typeLabel} — LabelFlow\n${timestamp}\n\nTenant: ${tenant?.name ?? 'Desconocido'} (${tenant?.shopifyStoreUrl ?? 'sin tienda'})\nTenant ID: ${auth.tenantId}\n\nResumen:\n${summary}\n\nConversacion:\n${conversationText}`;

  // Try sending via tenant's SMTP (if configured), otherwise use a simple fetch to a mail service
  try {
    // Use nodemailer dynamically
    const nodemailer = await import('nodemailer');

    // Use tenant's SMTP if available, otherwise try app-level SMTP
    const smtpHost = tenant?.emailHost ?? process.env.SMTP_HOST;
    const smtpUser = tenant?.emailUser ?? process.env.SMTP_USER;
    const smtpPass = tenant?.emailPass ?? process.env.SMTP_PASS;
    const smtpFrom = tenant?.emailFrom ?? smtpUser ?? 'noreply@autoenvia.com';

    if (!smtpHost || !smtpUser || !smtpPass) {
      // No SMTP — store report in DB as fallback
      await db.runLog.create({
        data: {
          tenantId: auth.tenantId,
          level: 'WARN',
          message: `[CHAT REPORT] ${typeLabel}: ${summary}`,
          meta: { type, summary, conversation: conversationText.slice(0, 5000) },
        },
      });
      return apiSuccess({ sent: false, stored: true, message: 'Reporte guardado. El equipo lo revisara.' });
    }

    // Decrypt password if encrypted
    let password = smtpPass;
    try {
      const { decryptIfPresent } = await import('@/lib/encryption');
      password = decryptIfPresent(smtpPass) ?? smtpPass;
    } catch {
      // Use as-is
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: 587,
      secure: false,
      auth: { user: smtpUser, pass: password },
    });

    await transporter.sendMail({
      from: `LabelFlow Support <${smtpFrom}>`,
      to: REPORT_EMAIL,
      subject: `[LabelFlow] ${typeLabel} — ${tenant?.name ?? auth.tenantId}`,
      text: emailText,
      html: emailHtml,
    });

    return apiSuccess({ sent: true, message: 'Reporte enviado al equipo.' });
  } catch (err) {
    // Email failed — store in DB as fallback
    await db.runLog.create({
      data: {
        tenantId: auth.tenantId,
        level: 'WARN',
        message: `[CHAT REPORT] ${typeLabel}: ${summary}`,
        meta: { type, summary, conversation: conversationText.slice(0, 5000), emailError: (err as Error).message },
      },
    });
    return apiSuccess({ sent: false, stored: true, message: 'Reporte guardado. El equipo lo revisara.' });
  }
}
