import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getAuthenticatedTenant, apiError } from '@/lib/api-utils';
import { getRedis } from '@/lib/redis';
import { contarEnVentanaFija } from '@/lib/rate-limit';
import { SYSTEM_PROMPT } from '@/lib/chat-system-prompt';

// Rate limiting constants
const RATE_LIMIT_MAX = 20;    // max requests per window
const RATE_LIMIT_TTL = 60;    // window size in seconds

/**
 * Redis-backed rate limiter (20 req / 60 s per tenant).
 *
 * Uses INCR + EXPIRE: atomic increment returns the new counter value, and
 * EXPIRE sets the TTL only on the first call in a window so it doesn't
 * reset on every request. Falls back to `true` (allow) when Redis is
 * unavailable — degraded rate-limiting is preferable to blocking all chat.
 *
 * This replaces the old module-level Map which didn't survive multiple
 * Vercel serverless instances (each instance had its own counter, so an
 * attacker with 20 Vercel instances could send 400 req/min per tenant).
 */
async function checkRateLimit(tenantId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) {
    // No Redis configured — degrade gracefully (allow request)
    return true;
  }

  const key = `chat:rl:${tenantId}`;
  try {
    // Pipeline sends INCR + EXPIRE in one round-trip so the key can never
    // be left with a count but no TTL. If the connection drops between two
    // separate commands the key would have no expiry and permanently block
    // the tenant — the pipeline failure mode is "both commands fail" instead.
    // Ventana fija: reintentar no corre el vencimiento. Ver lib/rate-limit.ts.
    const count = await contarEnVentanaFija(redis, key, RATE_LIMIT_TTL);
    return count <= RATE_LIMIT_MAX;
  } catch {
    // Redis error — fail open rather than blocking all chat
    return true;
  }
}

export async function POST(req: NextRequest) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  // Check subscription is active
  if (!auth.isActive) {
    return apiError('Suscripcion inactiva. Activa tu plan para usar el chat.', 403);
  }

  if (!await checkRateLimit(auth.tenantId)) {
    return apiError('Demasiados mensajes. Espera un momento antes de enviar otro.', 429);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return apiError('Chat no configurado. Contacta soporte.', 503);
  }

  let body: { messages: Array<{ role: string; content: string }> };
  try {
    body = await req.json();
  } catch {
    return apiError('Mensaje invalido', 400);
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return apiError('Mensajes requeridos', 400);
  }

  // Sanitize messages — only allow user/assistant roles, max 50 messages, 2000 chars each
  const messages = body.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-50)
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: String(m.content).slice(0, 2000),
    }));

  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    return apiError('El ultimo mensaje debe ser del usuario', 400);
  }

  try {
    const client = new Anthropic({ apiKey });

    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`));
            }
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          // Never expose internal error details to client
          console.error('Chat stream error:', (err as Error).message);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Error procesando la respuesta. Intenta de nuevo.' })}\n\n`));
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (err) {
    console.error('Chat API error:', (err as Error).message);
    return apiError('Error del asistente. Intenta de nuevo.', 500);
  }
}
