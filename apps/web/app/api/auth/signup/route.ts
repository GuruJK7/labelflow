import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';

const signupSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(100),
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
            slug: email.split('@')[0] + '-' + Date.now().toString(36),
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
    console.error('Signup error:', (err as Error).message);
    return NextResponse.json(
      { error: 'Error interno del servidor' },
      { status: 500 }
    );
  }
}
