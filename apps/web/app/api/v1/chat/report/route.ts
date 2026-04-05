import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getAuthenticatedTenant, apiError, apiSuccess } from '@/lib/api-utils';

// Admin tenant IDs that can see ALL reports
const ADMIN_TENANT_IDS = [
  'cmn86ab6i0003do10kx8s8cwh', // AutoEnvia Test
  'cmndmk0wl0005603cdhx2b4jo', // Luciano
  'cmneod7nv0001oew5vnk5dsas', // Manuel
  'cmnexjjt700015feh428w52ms', // Leandro
];

const ALLOWED_TYPES = ['bug', 'feedback', 'help'];

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

  // Server-side validation
  if (!type || !ALLOWED_TYPES.includes(type)) {
    return apiError('Tipo invalido. Debe ser: bug, feedback, o help', 400);
  }
  if (!summary || typeof summary !== 'string') {
    return apiError('Resumen requerido', 400);
  }

  const safeSummary = summary.slice(0, 500);
  const safeConversation = Array.isArray(conversation)
    ? conversation
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-30)
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))
    : [];

  const conversationText = safeConversation
    .map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`)
    .join('\n\n');

  const typeLabel = type === 'bug' ? 'BUG REPORT' : type === 'feedback' ? 'FEEDBACK' : 'AYUDA';

  // Get tenant name for context
  const tenant = await db.tenant.findUnique({
    where: { id: auth.tenantId },
    select: { name: true, shopifyStoreUrl: true },
  });

  await db.runLog.create({
    data: {
      tenantId: auth.tenantId,
      level: type === 'bug' ? 'ERROR' : 'INFO',
      message: `[${typeLabel}] ${safeSummary.slice(0, 200)}`,
      meta: {
        kind: 'chat_report',
        reportType: type,
        summary: safeSummary,
        conversation: conversationText.slice(0, 8000),
        tenantName: tenant?.name ?? 'Desconocido',
        shopifyStore: tenant?.shopifyStoreUrl ?? null,
        reportedAt: new Date().toISOString(),
      },
    },
  });

  return apiSuccess({ sent: true, message: 'Reporte enviado. Gracias!' });
}

// GET: list reports (admins see ALL, regular tenants see their own)
export async function GET() {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  const isAdmin = ADMIN_TENANT_IDS.includes(auth.tenantId);

  const reports = await db.runLog.findMany({
    where: {
      // Admins see all reports, regular users see only their own
      ...(isAdmin ? {} : { tenantId: auth.tenantId }),
      message: { startsWith: '[' },
      OR: [
        { message: { contains: 'BUG REPORT' } },
        { message: { contains: 'FEEDBACK' } },
        { message: { contains: 'AYUDA' } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      tenantId: true,
      level: true,
      message: true,
      meta: true,
      createdAt: true,
    },
  });

  return apiSuccess(reports);
}
