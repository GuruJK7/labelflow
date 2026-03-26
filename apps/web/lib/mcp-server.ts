import { db } from './db';
import { enqueueProcessOrders, isJobRunning } from './queue';

/**
 * MCP Server for LabelFlow.
 *
 * Exposes 4 tools via Streamable HTTP transport:
 *   1. process_pending_orders — Trigger order processing
 *   2. get_daily_summary — Get today's stats
 *   3. get_order_status — Lookup a specific order
 *   4. list_recent_labels — List latest labels
 *
 * Auth: Bearer token (tenant.apiKey) in Authorization header.
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'process_pending_orders',
    description:
      'Procesa todos los pedidos pendientes de Shopify y genera etiquetas en DAC',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_daily_summary',
    description: 'Retorna el resumen de etiquetas generadas hoy',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_order_status',
    description: 'Busca el estado de procesamiento de un pedido por numero',
    inputSchema: {
      type: 'object',
      properties: {
        orderName: {
          type: 'string',
          description: 'Numero de pedido, ej: #1234',
        },
      },
      required: ['orderName'],
    },
  },
  {
    name: 'list_recent_labels',
    description: 'Lista las ultimas etiquetas generadas',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Cantidad (default 10, max 50)',
        },
      },
      required: [],
    },
  },
];

export const MCP_SERVER_INFO = {
  protocolVersion: '2024-11-05',
  serverInfo: { name: 'labelflow', version: '1.0.0' },
  capabilities: { tools: {} },
};

// ────────────────────────────────────────────
// Tool handlers
// ────────────────────────────────────────────

export async function handleProcessPendingOrders(tenantId: string) {
  const running = await isJobRunning(tenantId);
  if (running) {
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'already_running', message: 'Ya hay un job en ejecucion' }) }] };
  }

  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { isActive: true, subscriptionStatus: true },
  });

  if (!tenant?.isActive || tenant.subscriptionStatus !== 'ACTIVE') {
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'inactive', message: 'Tenant no activo. Activa tu suscripcion.' }) }] };
  }

  const job = await db.job.create({
    data: { tenantId, trigger: 'MCP', status: 'PENDING' },
  });

  await enqueueProcessOrders(tenantId, 'MCP');

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ status: 'enqueued', jobId: job.id, message: 'Job encolado para procesamiento' }),
    }],
  };
}

export async function handleGetDailySummary(tenantId: string) {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [labelsToday, successToday, failedToday, tenant] = await Promise.all([
    db.label.count({ where: { tenantId, createdAt: { gte: todayStart } } }),
    db.label.count({ where: { tenantId, createdAt: { gte: todayStart }, status: 'COMPLETED' } }),
    db.label.count({ where: { tenantId, createdAt: { gte: todayStart }, status: 'FAILED' } }),
    db.tenant.findUnique({ where: { id: tenantId }, select: { lastRunAt: true, labelsThisMonth: true } }),
  ]);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        labelsToday,
        successToday,
        failedToday,
        labelsThisMonth: tenant?.labelsThisMonth ?? 0,
        lastRunAt: tenant?.lastRunAt?.toISOString() ?? null,
      }),
    }],
  };
}

export async function handleGetOrderStatus(tenantId: string, orderName: string) {
  const label = await db.label.findFirst({
    where: { tenantId, shopifyOrderName: { contains: orderName.replace('#', '') } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      shopifyOrderName: true,
      customerName: true,
      dacGuia: true,
      status: true,
      paymentType: true,
      totalUyu: true,
      city: true,
      emailSent: true,
      pdfPath: true,
      createdAt: true,
      errorMessage: true,
    },
  });

  if (!label) {
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'not_found', orderName }) }] };
  }

  return { content: [{ type: 'text', text: JSON.stringify(label) }] };
}

export async function handleListRecentLabels(tenantId: string, limit: number = 10) {
  const safeLimit = Math.min(Math.max(limit, 1), 50);

  const labels = await db.label.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: safeLimit,
    select: {
      id: true,
      shopifyOrderName: true,
      customerName: true,
      dacGuia: true,
      status: true,
      paymentType: true,
      totalUyu: true,
      city: true,
      emailSent: true,
      createdAt: true,
    },
  });

  return { content: [{ type: 'text', text: JSON.stringify({ labels, count: labels.length }) }] };
}

/**
 * Route MCP tool calls to their handlers.
 */
export async function handleToolCall(
  tenantId: string,
  toolName: string,
  args: Record<string, unknown>
) {
  switch (toolName) {
    case 'process_pending_orders':
      return handleProcessPendingOrders(tenantId);
    case 'get_daily_summary':
      return handleGetDailySummary(tenantId);
    case 'get_order_status':
      return handleGetOrderStatus(tenantId, (args.orderName as string) ?? '');
    case 'list_recent_labels':
      return handleListRecentLabels(tenantId, (args.limit as number) ?? 10);
    default:
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${toolName}` }) }] };
  }
}
