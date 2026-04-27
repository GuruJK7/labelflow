'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, AlertCircle, Mail, RefreshCw } from 'lucide-react';

/**
 * /verify-email
 *
 * Two roles:
 *
 *   1. **"Check your inbox" landing**, hit right after signup. The signup
 *      handler already issued a verification token and emailed the link;
 *      this page just communicates that and exposes a manual "Reenviar"
 *      button (rate-limited server-side to 3/hr).
 *
 *   2. **Post-verify outcome**, hit after the user clicks the link from
 *      their inbox. The GET handler at /api/auth/verify-email/[token]
 *      303-redirects here with `?status=ok|expired|invalid|used`.
 *
 * The page renders different states from the same component to keep the
 * URL stable across the whole flow.
 *
 * Why client-rendered: the resend button needs to call the JSON API and
 * show inline feedback. There's no SSR data here — `email` and `status`
 * come from the URL only.
 */

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailContent />
    </Suspense>
  );
}

type Status = 'pending' | 'ok' | 'expired' | 'invalid' | 'used';

function isStatus(v: string | null): v is Status {
  return v === 'ok' || v === 'expired' || v === 'invalid' || v === 'used';
}

function VerifyEmailContent() {
  const params = useSearchParams();
  const rawStatus = params.get('status');
  const status: Status = isStatus(rawStatus) ? rawStatus : 'pending';
  const email = params.get('email') ?? '';

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link href="/" className="inline-block">
            <h1 className="text-3xl font-bold text-white">
              Label<span className="text-cyan-400">Flow</span>
            </h1>
          </Link>
        </div>

        <div className="bg-zinc-900/50 border border-white/[0.08] rounded-xl p-8">
          {status === 'pending' && <PendingState email={email} />}
          {status === 'ok' && <OkState />}
          {status === 'expired' && <ExpiredState email={email} />}
          {status === 'invalid' && <InvalidState />}
          {status === 'used' && <UsedState />}
        </div>

        <p className="text-center text-xs text-zinc-600 mt-6">
          ¿Problemas?{' '}
          <a
            href="mailto:soporte@autoenvia.com"
            className="text-cyan-400 hover:text-cyan-300"
          >
            soporte@autoenvia.com
          </a>
        </p>
      </div>
    </div>
  );
}

/* ---------- States ---------- */

function PendingState({ email }: { email: string }) {
  return (
    <>
      <div className="flex justify-center mb-5">
        <div className="w-14 h-14 rounded-full bg-cyan-500/10 ring-1 ring-cyan-500/30 flex items-center justify-center">
          <Mail className="w-6 h-6 text-cyan-300" />
        </div>
      </div>
      <h2 className="text-xl font-semibold text-white text-center">
        Confirmá tu email
      </h2>
      <p className="text-sm text-zinc-400 text-center mt-2 leading-relaxed">
        Te mandamos un mail{email ? ' a ' : '.'}
        {email && (
          <span className="text-zinc-200 font-medium break-all">{email}</span>
        )}
        {email && '.'} Hacé click en el botón del mail para activar tu cuenta.
        El link expira en 24 horas.
      </p>

      <div className="mt-6 rounded-lg bg-zinc-900/60 border border-white/[0.06] px-4 py-3">
        <p className="text-xs text-zinc-400 leading-relaxed">
          <span className="text-zinc-200 font-medium">No lo encontrás?</span>{' '}
          Revisá la carpeta de spam o promociones. Algunos proveedores
          (Hotmail/Outlook) tardan hasta 5 minutos.
        </p>
      </div>

      <ResendBlock email={email} />

      <div className="mt-6 pt-6 border-t border-white/[0.06] text-center">
        <Link
          href="/login"
          className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Ya confirmé · Ir al login →
        </Link>
      </div>
    </>
  );
}

function OkState() {
  return (
    <>
      <div className="flex justify-center mb-5">
        <div className="w-14 h-14 rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/30 flex items-center justify-center">
          <CheckCircle2 className="w-7 h-7 text-emerald-400" />
        </div>
      </div>
      <h2 className="text-xl font-semibold text-white text-center">
        ¡Email confirmado!
      </h2>
      <p className="text-sm text-zinc-400 text-center mt-2">
        Ya está. Iniciá sesión y empezá a despachar pedidos en automático.
      </p>
      <Link
        href="/login"
        className="mt-6 w-full block text-center bg-cyan-500 hover:bg-cyan-400 text-white font-semibold py-3 rounded-lg transition-colors"
      >
        Ir al login
      </Link>
    </>
  );
}

function ExpiredState({ email }: { email: string }) {
  return (
    <>
      <div className="flex justify-center mb-5">
        <div className="w-14 h-14 rounded-full bg-amber-500/10 ring-1 ring-amber-500/30 flex items-center justify-center">
          <AlertCircle className="w-6 h-6 text-amber-400" />
        </div>
      </div>
      <h2 className="text-xl font-semibold text-white text-center">
        Este link expiró
      </h2>
      <p className="text-sm text-zinc-400 text-center mt-2">
        Los links de confirmación duran 24 horas. Pedí uno nuevo y te lo
        mandamos al toque.
      </p>
      <ResendBlock email={email} />
    </>
  );
}

function InvalidState() {
  return (
    <>
      <div className="flex justify-center mb-5">
        <div className="w-14 h-14 rounded-full bg-red-500/10 ring-1 ring-red-500/30 flex items-center justify-center">
          <AlertCircle className="w-6 h-6 text-red-400" />
        </div>
      </div>
      <h2 className="text-xl font-semibold text-white text-center">
        Link inválido
      </h2>
      <p className="text-sm text-zinc-400 text-center mt-2">
        Este link no existe o ya fue reemplazado por uno más nuevo. Revisá
        si tenés un mail más reciente, o pedí otro desde la página de login.
      </p>
      <Link
        href="/login"
        className="mt-6 w-full block text-center bg-cyan-500 hover:bg-cyan-400 text-white font-semibold py-3 rounded-lg transition-colors"
      >
        Ir al login
      </Link>
    </>
  );
}

function UsedState() {
  return (
    <>
      <div className="flex justify-center mb-5">
        <div className="w-14 h-14 rounded-full bg-emerald-500/10 ring-1 ring-emerald-500/30 flex items-center justify-center">
          <CheckCircle2 className="w-6 h-6 text-emerald-400" />
        </div>
      </div>
      <h2 className="text-xl font-semibold text-white text-center">
        Tu email ya estaba confirmado
      </h2>
      <p className="text-sm text-zinc-400 text-center mt-2">
        No pasa nada. Tu cuenta ya está activa — entrá con tu email y
        contraseña.
      </p>
      <Link
        href="/login"
        className="mt-6 w-full block text-center bg-cyan-500 hover:bg-cyan-400 text-white font-semibold py-3 rounded-lg transition-colors"
      >
        Ir al login
      </Link>
    </>
  );
}

/* ---------- Resend button ---------- */

function ResendBlock({ email: initialEmail }: { email: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error' | 'rate'>('idle');
  const [error, setError] = useState<string>('');

  // 60-second cool-down after a successful resend so the button doesn't
  // turn into a "spam yourself" UX. The server-side rate-limit (3/hr)
  // is the actual security boundary; this is just a usability touch.
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    if (state === 'sending' || cooldown > 0) return;

    if (!email || !/^.+@.+\..+$/.test(email)) {
      setState('error');
      setError('Ingresá un email válido');
      return;
    }

    setState('sending');
    setError('');
    try {
      const res = await fetch('/api/auth/verify-email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.toLowerCase() }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        setState('rate');
        setError(
          (data as { error?: string }).error ??
            'Demasiados intentos — esperá un rato.',
        );
        return;
      }

      if (!res.ok) {
        setState('error');
        setError(
          (data as { error?: string }).error ?? 'Error al reenviar',
        );
        return;
      }

      setState('sent');
      setCooldown(60);
    } catch {
      setState('error');
      setError('Error de conexión. Probá de nuevo.');
    }
  }

  return (
    <form onSubmit={handleResend} className="mt-6 space-y-3">
      {!initialEmail && (
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="tu@email.com"
          required
          className="w-full bg-zinc-900 border border-white/[0.08] text-white placeholder:text-zinc-600 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
        />
      )}

      <button
        type="submit"
        disabled={state === 'sending' || cooldown > 0}
        className="w-full inline-flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed text-zinc-100 font-medium py-2.5 rounded-lg transition-colors text-sm"
      >
        <RefreshCw
          className={`w-4 h-4 ${state === 'sending' ? 'animate-spin' : ''}`}
        />
        {cooldown > 0
          ? `Reenviar en ${cooldown}s`
          : state === 'sending'
          ? 'Enviando…'
          : state === 'sent'
          ? 'Reenviado · revisá tu inbox'
          : 'Reenviar email de confirmación'}
      </button>

      {state === 'sent' && cooldown > 0 && (
        <p className="text-xs text-emerald-400 text-center">
          Listo. Si no llega en 5 min, revisá spam.
        </p>
      )}
      {(state === 'error' || state === 'rate') && error && (
        <p className="text-xs text-red-400 text-center">{error}</p>
      )}
    </form>
  );
}
