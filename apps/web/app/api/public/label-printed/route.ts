/**
 * POST /api/public/label-printed?token=<clientToken>
 * Body: { ids: string[], printed: boolean }
 *
 * Manual printed-state toggle for the client portal. The portal auto-stamps
 * printedAt whenever it serves a PDF (single or bulk), but the operator also
 * needs to correct the record by hand: mark a label printed without opening
 * its PDF, or clear the mark after a printer jam so the label shows as
 * pending again. Same auth model as the other public endpoints: portal token
 * -> tenant allow-list, ids outside the allow-list are silently ignored.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiError } from '@/lib/api-utils';
import {
  resolveClientToken,
  setClientViewLabelsPrinted,
} from '@/lib/client-view';

export const dynamic = 'force-dynamic';

const printedSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  printed: z.boolean(),
});

export async function POST(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token');
    const tenantIds = await resolveClientToken(token);
    if (!tenantIds) return apiError('No autorizado', 401);

    const body = await req.json().catch(() => null);
    const parsed = printedSchema.safeParse(body);
    if (!parsed.success) return apiError('Datos invalidos', 400);

    const updated = await setClientViewLabelsPrinted(
      parsed.data.ids,
      tenantIds,
      parsed.data.printed,
    );

    return NextResponse.json({ updated });
  } catch (err) {
    const error = err as Error;
    console.error('Portal label-printed error:', error.message);
    return apiError(`Error: ${error.message}`, 500);
  }
}
