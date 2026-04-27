import { z } from 'zod';
import { db } from '@/lib/db';
import {
  getAuthenticatedTenant,
  apiError,
  apiSuccess,
} from '@/lib/api-utils';
import { encrypt } from '@/lib/encryption';

/**
 * POST /api/v1/onboarding/test-dac
 *
 * Saves DAC credentials during onboarding. We *don't* live-verify the
 * username/password against the DAC portal here — that portal has aggressive
 * anti-bot protection and the only reliable way to log in is the Playwright
 * flow that lives in the worker (apps/worker/src/services/dac.service.ts).
 * Spinning up a headless Chromium in a Vercel function would be slow + brittle
 * and fail on cold start.
 *
 * Instead, we:
 *   1. Validate format (non-empty, length bounds — DAC usernames are short
 *      strings, often the user's national ID; passwords up to 100 chars).
 *   2. Encrypt + store both fields.
 *   3. Mark the step as "saved" — the wizard moves on. The actual
 *      credential check happens when the worker tries to log in for the
 *      user's first real shipment, and the result surfaces via the aha
 *      moment modal (success) or a row in /logs (failure).
 *
 * The honest UX trade: telling the user "we'll confirm on first shipment"
 * is better than fake-verifying with a flaky probe that gives false negatives.
 */
const bodySchema = z.object({
  dacUsername: z.string().min(1, 'Usuario requerido').max(100),
  dacPassword: z.string().min(1, 'Contraseña requerida').max(200),
});

export async function POST(request: Request) {
  const auth = await getAuthenticatedTenant();
  if (!auth) return apiError('No autorizado', 401);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError('JSON inválido', 400);
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(
      parsed.error.errors[0]?.message ?? 'Datos inválidos',
      400,
    );
  }

  const { dacUsername, dacPassword } = parsed.data;

  await db.tenant.update({
    where: { id: auth.tenantId },
    data: {
      // Both fields are now encrypted at rest (HIGH-07 fix). Worker reads
      // them via decryptOrRaw() so legacy plaintext rows still work.
      dacUsername: encrypt(dacUsername),
      dacPassword: encrypt(dacPassword),
    },
  });

  // Invalidate any cached DAC session cookies belonging to a previous user.
  // Without this, the worker could ride a stale session for up to 4 h and
  // file shipments under the wrong account. Same logic as PUT /api/v1/settings.
  await db.runLog.deleteMany({
    where: { tenantId: auth.tenantId, message: 'dac_cookies' },
  });

  return apiSuccess({ ok: true });
}
