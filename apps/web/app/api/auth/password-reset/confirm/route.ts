/**
 * POST /api/auth/password-reset/confirm
 *
 * Validates a password-reset token and updates the user's password hash.
 * The flow:
 *   1. Client posts { token, password }.
 *   2. We hash the token, look it up, check expiresAt + usedAt.
 *   3. In a transaction: update User.passwordHash + mark token used.
 *   4. Return success — the user can now log in with the new password.
 *
 * If the token is missing, expired, already used, or doesn't exist, we
 * return 400 with a generic message. The exact failure mode is logged
 * server-side for SRE but NOT exposed to the client.
 *
 * Password policy: minimum 8 characters. Matches the signup endpoint —
 * keeping the rules in two places is intentional belt-and-suspenders
 * (signup OR reset is a write path; both must enforce).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { findUserByResetToken } from '@/lib/password-reset';
import { writeAuditLog, extractAuditContext } from '@/lib/audit-log';

export const runtime = 'nodejs';

const confirmSchema = z.object({
  token: z.string().min(16).max(256),
  password: z.string().min(8).max(128),
});

export async function POST(req: Request) {
  let parsed: z.infer<typeof confirmSchema>;
  try {
    const body = await req.json();
    const result = confirmSchema.safeParse(body);
    if (!result.success) {
      return NextResponse.json(
        { error: 'Token o contraseña inválidos.' },
        { status: 400 },
      );
    }
    parsed = result.data;
  } catch {
    return NextResponse.json({ error: 'Body inválido.' }, { status: 400 });
  }

  // Validate token — null on missing/expired/used/unknown. We deliberately
  // collapse all those failure modes into one response so a stolen-token
  // attacker can't tell whether the token is "wrong" vs "expired".
  const validation = await findUserByResetToken(parsed.token);
  if (!validation) {
    return NextResponse.json(
      { error: 'El link expiró o no es válido. Pedí uno nuevo.' },
      { status: 400 },
    );
  }

  const passwordHash = await bcrypt.hash(parsed.password, 12);

  // Transaction: update password + mark token used atomically. If either
  // step fails, both are rolled back — never leaves the token row marked
  // used while the password didn't actually change (or vice versa).
  try {
    await db.$transaction([
      db.user.update({
        where: { id: validation.userId },
        data: { passwordHash },
      }),
      db.passwordResetToken.update({
        where: { id: validation.tokenId },
        data: { usedAt: new Date() },
      }),
      // Invalidate any OTHER unused tokens for this user — if an attacker
      // requested a reset and the user requested one too, only the most
      // recently-used (the legit one) succeeds. Belt-and-suspenders against
      // simultaneous-token race conditions.
      db.passwordResetToken.deleteMany({
        where: {
          userId: validation.userId,
          usedAt: null,
          id: { not: validation.tokenId },
        },
      }),
    ]);
  } catch {
    return NextResponse.json(
      { error: 'No se pudo actualizar la contraseña. Probá de nuevo.' },
      { status: 500 },
    );
  }

  // Audit — password change is the highest-impact action a user can take.
  // If they later say "someone changed my password without me", the audit
  // log + the requestIp on the original token row are the forensic trail.
  // Fire-and-forget; failure to write must not affect the success response.
  const ctx = extractAuditContext(req);
  void writeAuditLog({
    action: 'user.password.reset.confirmed',
    userId: validation.userId,
    entityType: 'PasswordResetToken',
    entityId: validation.tokenId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  return NextResponse.json({ ok: true });
}
