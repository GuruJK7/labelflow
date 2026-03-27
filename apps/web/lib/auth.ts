import { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import GoogleProvider from 'next-auth/providers/google';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from './db';

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Email',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        try {
          if (!credentials?.email || !credentials?.password) return null;

          const user = await db.user.findUnique({
            where: { email: credentials.email.toLowerCase() },
          });

          if (!user || !user.passwordHash) return null;

          const valid = await bcrypt.compare(credentials.password, user.passwordHash);
          if (!valid) return null;

          return { id: user.id, email: user.email, name: user.name };
        } catch {
          return null;
        }
      },
    }),
    ...(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET
      ? [
          GoogleProvider({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
          }),
        ]
      : []),
  ],
  session: { strategy: 'jwt', maxAge: 7 * 24 * 60 * 60 }, // 7 days instead of 30
  pages: {
    signIn: '/login',
    newUser: '/onboarding',
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      if (token.id) {
        const tenant = await db.tenant.findUnique({
          where: { userId: token.id as string },
          select: { id: true, slug: true, isActive: true, subscriptionStatus: true },
        });
        if (tenant) {
          token.tenantId = tenant.id;
          token.tenantSlug = tenant.slug;
          token.isActive = tenant.isActive;
          token.subscriptionStatus = tenant.subscriptionStatus;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as Record<string, unknown>).id = token.id;
        (session.user as Record<string, unknown>).tenantId = token.tenantId;
        (session.user as Record<string, unknown>).tenantSlug = token.tenantSlug;
        (session.user as Record<string, unknown>).isActive = token.isActive;
        (session.user as Record<string, unknown>).subscriptionStatus = token.subscriptionStatus;
      }
      return session;
    },
    async signIn({ user, account }) {
      if (account?.provider === 'google' && user.email) {
        const existing = await db.user.findUnique({ where: { email: user.email } });
        if (!existing) {
          const newUser = await db.user.create({
            data: {
              email: user.email,
              name: user.name,
              image: user.image,
              emailVerified: new Date(),
            },
          });
          // Create tenant for OAuth users too
          const slug = user.email.split('@')[0].replace(/[^a-z0-9]/gi, '-').toLowerCase();
          await db.tenant.create({
            data: {
              userId: newUser.id,
              name: user.name ?? slug,
              slug: `${slug}-${Date.now()}`,
              apiKey: crypto.randomBytes(32).toString('hex'),
            },
          });
        }
      }
      return true;
    },
  },
};

export function requireTenantId(session: Record<string, unknown>): string {
  const tenantId = (session.user as Record<string, unknown>)?.tenantId as string | undefined;
  if (!tenantId) {
    throw new Error('NO_TENANT');
  }
  return tenantId;
}
