import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '@/lib/db';

const signupSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(100),
  tosAccepted: z.literal(true, {
    errorMap: () => ({ message: 'Debes aceptar los Terminos de Servicio y la Politica de Privacidad' }),
  }),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const parsed = signupSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Datos invalidos', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { name, email, password } = parsed.data;

    // Capture IP for legal compliance (Ley 18.331)
    const signupIp =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      'unknown';

    // Check if user exists
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return NextResponse.json(
        { error: 'Ya existe una cuenta con ese email' },
        { status: 409 }
      );
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user + tenant in transaction
    const user = await db.user.create({
      data: {
        email,
        name,
        passwordHash,
        tenant: {
          create: {
            name: name,
            slug: email.split('@')[0].replace(/[^a-z0-9]/gi, '-').toLowerCase() + '-' + Date.now().toString(36),
            apiKey: crypto.randomBytes(32).toString('hex'),
            signupIp,
            tosAcceptedAt: new Date(),
          },
        },
      },
      include: { tenant: true },
    });

    return NextResponse.json(
      { data: { userId: user.id, tenantId: user.tenant?.id } },
      { status: 201 }
    );
  } catch (err) {
    // Do not log error details to prevent info leakage
    return NextResponse.json(
      { error: 'Error interno del servidor' },
      { status: 500 }
    );
  }
}
