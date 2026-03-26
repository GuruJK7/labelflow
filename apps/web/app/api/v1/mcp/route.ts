import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { enqueueProcessOrders, isJobRunning } from '@/lib/queue';

/**
 * MCP endpoint — simplified Streamable HTTP transport.
 * Authenticates via Bearer token (tenant API key).
 * Supports 4 tools: process_pending_orders, get_daily_summary, get_order_status, list_recent_labels.
 */
export async function POST(req: NextRequest) {
  // Auth via API key
  const authHeader = req.headers.get('authorization');
  const apiKey = authHeader?.replace('Bearer ', '');

  if (!apiKey) {
    return NextResponse.json({ error: 'Missing Authorization header' }, { status: 401 });
  }

  const tenant = await db.tenant.findUnique({
    where: { apiKey },
    select: { id: true, isActive: true, subscriptionStatus: true },
  });

  if (!tenant) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }

  const body = await req.json();
  const { method, params } = body;

  // Handle MCP protocol methods
  if (method === 'initialize') {
    return NextResponse.json({
      jsonrpc: '2.0',
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'labelflow', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    });
  }

  if (method === 'tools/list') {
    return NextResponse.json({
      jsonrpc: '2.0',
      result: {
        tools: [
          {
            name: 'process_pending_orders',
            description: 'Procesa todos los pedidos pendientes de Shopify y genera etiquetas en DAC',
            inputSchema: { type: 'object', properties: {}, required: [] },
          },
          {
            name: 'get_daily_summary',
            description: 'Retorna el resumen de etiquetas generadas hoy',
            inputSchema: { type: 'object', properties: {}, required: [] },
          },
          {
            name: 'get_order_status',
            description: 'Busca el estado de un pedido por numero',
            inputSchema: {
              type: 'object',
              properties: { orderName: { type: 'string', description: 'Numero de pedido, ej: #1234' } },
              required: ['orderName'],
            },
          },
          {
            name: 'list_recent_labels',
            description: 'Lista las ultimas etiquetas generadas',
            inputSchema: {
              type: 'object',
              properties: { limit: { type: 'number', description: 'Cantidad (default 10, max 50)' } },
            },
          },
        ],
      },
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments ?? {};

    try {
      if (toolName === 'process_pending_orders') {
        if (!tenant.isActive || tenant.subscriptionStatus !== 'ACTIVE') {
          return mcpResult({ error: 'Plan inactivo. Activa tu suscripcion.' });
        }
        const running = await isJobRunning(tenant.id);
        if (running) {
          return mcpResult({ status: 'already_running', message: 'Ya hay un job en ejecucion.' });
        }
        const jobId = await enqueueProcessOrders(tenant.id, 'MCP');
        return mcpResult({ jobId, message: 'Job encolado exitosamente' });
      }

      if (toolName === 'get_daily_summary') {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [completed, failed, total] = await Promise.all([
          db.label.count({ where: { tenantId: tenant.id, status: 'COMPLETED', createdAt: { gte: today } } }),
          db.label.count({ where: { tenantId: tenant.id, status: 'FAILED', createdAt: { gte: today } } }),
          db.label.count({ where: { tenantId: tenant.id, createdAt: { gte: today } } }),
        ]);

        const lastRun = await db.job.findFirst({
          where: { tenantId: tenant.id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, status: true },
        });

        return mcpResult({
          labelsToday: total,
          successToday: completed,
          failedToday: failed,
          lastRunAt: lastRun?.createdAt?.toISOString() ?? null,
          lastRunStatus: lastRun?.status ?? null,
        });
      }

      if (toolName === 'get_order_status') {
        const orderName = args.orderName as string;
        const label = await db.label.findFirst({
          where: { tenantId: tenant.id, shopifyOrderName: { contains: orderName } },
          orderBy: { createdAt: 'desc' },
        });

        if (!label) return mcpResult({ status: 'not_found', orderName });
        return mcpResult({
          orderName: label.shopifyOrderName,
          status: label.status,
          dacGuia: label.dacGuia,
          paymentType: label.paymentType,
          customerName: label.customerName,
          city: label.city,
          createdAt: label.createdAt.toISOString(),
          emailSent: label.emailSent,
        });
      }

      if (toolName === 'list_recent_labels') {
        const limit = Math.min(Math.max(1, (args.limit as number) ?? 10), 50);
        const labels = await db.label.findMany({
          where: { tenantId: tenant.id },
          orderBy: { createdAt: 'desc' },
          take: limit,
          select: {
            shopifyOrderName: true,
            customerName: true,
            dacGuia: true,
            status: true,
            paymentType: true,
            totalUyu: true,
            createdAt: true,
          },
        });
        return mcpResult({ labels, count: labels.length });
      }

      return mcpResult({ error: `Tool not found: ${toolName}` });
    } catch (err) {
      return mcpResult({ error: (err as Error).message });
    }
  }

  return NextResponse.json({ error: 'Unknown method' }, { status: 400 });
}

function mcpResult(content: Record<string, unknown>) {
  return NextResponse.json({
    jsonrpc: '2.0',
    result: {
      content: [{ type: 'text', text: JSON.stringify(content, null, 2) }],
    },
  });
}
