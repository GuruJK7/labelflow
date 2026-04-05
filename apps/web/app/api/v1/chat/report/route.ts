import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

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

  const typeLabel = type === 'bug' ? 'Bug Report' : type === 'feedback' ? 'Feedback' : 'Ayuda';

  const conversationText = conversation
    .map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`)
    .join('\n\n');

  // Store report in RunLog table
  await db.runLog.create({
    data: {
      tenantId: auth.tenantId,
      level: type === 'bug' ? 'ERROR' : 'INFO',
      message: `[${typeLabel.toUpperCase()}] ${summary.slice(0, 200)}`,
      meta: {
        reportType: type,
        summary,
        conversation: conversationText.slice(0, 8000),
        reportedAt: new Date().toISOString(),
      },
    },
  });

  return apiSuccess({ sent: true, message: 'Reporte enviado. Gracias!' });
}

// GET: list all reports
export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const reports = await db.runLog.findMany({
    where: {
      tenantId: auth.tenantId,
      message: { startsWith: '[' },
      OR: [
        { message: { contains: 'BUG REPORT' } },
        { message: { contains: 'FEEDBACK' } },
        { message: { contains: 'AYUDA' } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      level: true,
      message: true,
      meta: true,
      createdAt: true,
    },
  });

  return apiSuccess(reports);
}
