'use client';

import { signIn } from 'next-auth/react';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * One-click Google OAuth button. Shared between /login and /signup so the
 * visual treatment stays identical — first-time visitors create an account,
 * returning users sign in. NextAuth handles the provisioning split inside
 * the `signIn` callback (apps/web/lib/auth.ts), which reads the signed
 * `lf_ref` referral cookie to attribute referee bonuses for OAuth signups.
 *
 * If `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` env vars are unset on Vercel,
 * the click reaches NextAuth which surfaces a 404-ish "OAuthSignin" error.
 * That's acceptable for now — the credentials path keeps working — but the
 * env vars MUST be set in production for this button to do anything.
 */
export function GoogleSignInButton({
  callbackUrl = '/onboarding',
  label,
}: {
  callbackUrl?: string;
  label?: string;
}) {
  const [loading, setLoading] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        setLoading(true);
        signIn('google', { callbackUrl });
      }}
      disabled={loading}
      className="w-full flex items-center justify-center gap-3 bg-white hover:bg-zinc-100 text-zinc-900 py-3 rounded-xl font-medium text-sm transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-black/30 ring-1 ring-white/10"
      aria-label={label ?? 'Continuar con Google'}
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        <>
          <GoogleLogo />
          <span>{label ?? 'Continuar con Google'}</span>
        </>
      )}
    </button>
  );
}

/** Official Google "G" multicolor mark. Inlined SVG (no external request). */
function GoogleLogo() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="w-4 h-4"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

/**
 * Visual divider between the OAuth button and the email/password form.
 * Centered "o" with horizontal lines on both sides — standard SaaS pattern.
 */
export function OrDivider({ label = 'o' }: { label?: string }) {
  return (
    <div
      className="flex items-center gap-3 my-5"
      role="separator"
      aria-label={`Separador: ${label}`}
    >
      <span className="flex-1 h-px bg-white/[0.08]" />
      <span className="text-[11px] text-zinc-500 uppercase tracking-wider font-medium">
        {label}
      </span>
      <span className="flex-1 h-px bg-white/[0.08]" />
    </div>
  );
}
