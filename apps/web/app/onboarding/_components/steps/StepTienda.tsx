'use client';

import { useState, type FormEvent } from 'react';
import { ShoppingBag, FileSpreadsheet, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { OnboardingState } from '@/lib/onboarding-state';
import { SHOPIFY_OAUTH_MESSAGES } from '@/lib/shopify-messages';
import { ShopifyTutorial } from '../ShopifyTutorial';
import { puedeConectarShopifyAMano } from '@/lib/shopify-manual';
import { StepCard, StepHeader, PrimaryButton, SecondaryButton, Notice, DoneCard, StepFooter, inputClass, labelClass } from '../wizard-ui';

/**
 * Paso 2 — De dónde salen tus pedidos. Tres caminos:
 *   A) Shopify: el botón lleva al OAuth (`/api/shopify/install?next=/onboarding`)
 *      y vuelve acá con `?shopify=connected`; el token manual queda plegado.
 *   B) Carga propia: un botón y listo (`POST /api/v1/onboarding/usar-fuente-interna`).
 *      Los pedidos se cargan a mano o por Excel desde /pedidos.
 *   C) Panel externo: URL + API token, probados con la misma llamada que hace
 *      el worker (`POST /api/v1/onboarding/test-dashboard`).
 *
 * 🔴 (B) va ANTES que (C) en pantalla a propósito. Hasta el 14-09-2026 las
 * únicas dos opciones exigían algo de afuera —una tienda de Shopify, o el panel
 * de otro sistema con su token— y la tarjeta que decía "Dashboard con Excel" no
 * importaba ningún Excel: pedía la URL de un panel ajeno. Quien no tenía ninguno
 * de los dos quedaba sin salida, y se nota en la base: ninguna cuenta orgánica
 * llegó jamás a completar el alta.
 */
export interface OAuthReturn {
  motivo: string;
  webhooks: string | null;
}

export function StepTienda({
  state,
  esAdmin = false,
  oauthReturn,
  onSaved,
  onFailed,
  onContinue,
  onBack,
}: {
  state: OnboardingState;
  /** Un admin ve el alta manual aunque la env var esté apagada. */
  esAdmin?: boolean;
  oauthReturn: OAuthReturn | null;
  onSaved: () => Promise<void>;
  onFailed: (code: string | number) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const connected = state.store.kind !== null;
  const [editing, setEditing] = useState(!connected);
  const [busy, setBusy] = useState<'' | 'shopify-token' | 'dashboard' | 'interna'>('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');

  // Requisito 2.3.1: un comerciante NO puede ver el alta manual. Un admin sí.
  const manualOk = puedeConectarShopifyAMano(esAdmin);

  const [shopDomain, setShopDomain] = useState(state.store.shopifyStoreUrl ?? '');
  const [manualToken, setManualToken] = useState('');
  const [dashUrl, setDashUrl] = useState(state.store.dashboardUrl ?? 'https://autoenvia-dash.vercel.app');
  const [dashToken, setDashToken] = useState('');

  const appStoreUrl = process.env.NEXT_PUBLIC_SHOPIFY_APP_STORE_URL;

  function cleanDomain(v: string) {
    return v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }

  function goShopify() {
    const shop = cleanDomain(shopDomain);
    if (!shop) {
      setError('Escribí el dominio de tu tienda (termina en .myshopify.com).');
      return;
    }
    window.location.href = `/api/shopify/install?shop=${encodeURIComponent(shop)}&next=${encodeURIComponent('/onboarding')}`;
  }

  async function saveManualToken(e: FormEvent) {
    e.preventDefault();
    setError('');
    setOk('');
    const shop = cleanDomain(shopDomain);
    if (!shop || !manualToken.trim()) {
      setError('Completá el dominio y el token.');
      return;
    }
    setBusy('shopify-token');
    try {
      const res = await fetch('/api/v1/onboarding/test-shopify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopifyStoreUrl: shop, shopifyToken: manualToken.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onFailed(res.status);
        setError(data.error ?? 'No se pudo verificar Shopify');
        return;
      }
      setOk(`Conectado${data.data?.shopName ? ` a ${data.data.shopName}` : ''}.`);
      setManualToken('');
      setEditing(false);
      await onSaved();
    } catch {
      onFailed('network');
      setError('Error de conexión. Probá de nuevo.');
    } finally {
      setBusy('');
    }
  }

  /**
   * Elegir la carga propia. No hay nada que probar ni que pedirle al usuario:
   * es justamente la opción para quien no tiene ningún sistema que conectar.
   */
  async function usarFuenteInterna() {
    setError('');
    setOk('');
    setBusy('interna');
    try {
      const res = await fetch('/api/v1/onboarding/usar-fuente-interna', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onFailed(res.status);
        setError(data.error ?? 'No se pudo activar la carga de pedidos');
        return;
      }
      setOk('Listo. Vas a cargar tus pedidos desde la sección Pedidos, a mano o con un Excel.');
      setEditing(false);
      await onSaved();
    } catch {
      onFailed('network');
      setError('Error de conexión. Probá de nuevo.');
    } finally {
      setBusy('');
    }
  }

  async function saveDashboard(e: FormEvent) {
    e.preventDefault();
    setError('');
    setOk('');
    if (!dashUrl.trim() || !dashToken.trim()) {
      setError('Completá la URL y el API token del dashboard.');
      return;
    }
    setBusy('dashboard');
    try {
      const res = await fetch('/api/v1/onboarding/test-dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardUrl: dashUrl.trim(), dashboardToken: dashToken.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        onFailed(res.status);
        setError(data.error ?? 'No se pudo conectar al dashboard');
        return;
      }
      setOk('Conectado. Vimos tu dashboard y está listo para leer pedidos confirmados.');
      setDashToken('');
      setEditing(false);
      await onSaved();
    } catch {
      onFailed('network');
      setError('Error de conexión. Probá de nuevo.');
    } finally {
      setBusy('');
    }
  }

  const oauthNotice = oauthReturn ? oauthMessage(oauthReturn) : null;

  return (
    <StepCard>
      <StepHeader
        icon={ShoppingBag}
        title="Conectá tu tienda"
        estimate="2 min"
        text="Elegí de dónde salen tus pedidos. Podés cambiarlo después desde Configuración."
      />

      <div className="space-y-3 mb-5">
        {oauthNotice && <Notice kind={oauthNotice.ok ? 'ok' : 'warn'}>{oauthNotice.text}</Notice>}
        {ok && <Notice kind="ok">{ok}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
      </div>

      {connected && !editing ? (
        <DoneCard
          title={
            state.store.kind === 'shopify'
              ? 'Tienda Shopify conectada'
              : state.store.kind === 'interna'
                ? 'Vas a cargar los pedidos acá'
                : 'Panel externo conectado'
          }
          detail={
            state.store.kind === 'shopify'
              ? state.store.shopifyStoreUrl
              : state.store.kind === 'interna'
                ? 'A mano o importando un Excel, desde Pedidos'
                : state.store.dashboardUrl
          }
          onChange={() => setEditing(true)}
        />
      ) : (
        <div className="space-y-4">
          {/* Opción A — Shopify */}
          <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/[0.04] p-5">
            <div className="flex items-center gap-2 mb-1">
              <ShoppingBag className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-white">Instalar la app de Shopify</h3>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed mb-4">
              Te lleva a Shopify para que autorices la app. Volvés conectado, sin copiar tokens. Los pedidos pagos entran al instante.
            </p>
            {/* Requisito 2.3.1: no se puede pedir el dominio .myshopify.com a mano. */}
            {manualOk && (
              <>
                <label className={labelClass}>Tu tienda</label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    value={shopDomain}
                    onChange={(e) => setShopDomain(e.target.value)}
                    className={inputClass}
                    placeholder="mitienda.myshopify.com"
                    autoComplete="off"
                  />
                  <PrimaryButton onClick={goShopify} className="sm:w-auto whitespace-nowrap" arrow={false}>
                    Conectar con Shopify
                  </PrimaryButton>
                </div>
                <p className="text-[11px] text-zinc-500 mt-1.5">El dominio que termina en .myshopify.com, no el dominio personalizado.</p>
              </>
            )}
            {/* Con el camino manual apagado (2.3.1), instalar desde el App Store
                deja de ser una alternativa y pasa a ser EL camino, así que sube
                de link chiquito a botón principal. Si todavía no hay URL de App
                Store —la app no está publicada— se dice qué hacer en vez de
                dejar la tarjeta muda. */}
            {appStoreUrl ? (
              <a
                href={appStoreUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={
                  manualOk
                    ? 'inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 mt-3'
                    : 'inline-flex items-center justify-center gap-2 w-full sm:w-auto bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2.5 rounded-lg text-xs font-medium transition-colors'
                }
              >
                <span>
                  {manualOk
                    ? 'o instalala desde el App Store de Shopify'
                    : 'Instalar desde el App Store de Shopify'}
                </span>{' '}
                <ExternalLink className="w-3 h-3" />
              </a>
            ) : (
              !manualOk && (
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  <span>Buscá </span>
                  <span className="text-zinc-300">AutoEnvía</span>
                  <span> en el App Store de Shopify e instalala desde ahí. Shopify te trae de vuelta acá ya conectado.</span>
                </p>
              )
            )}

            {/* Requisito 2.3.1: pegar un Admin API token empuja a crear una app privada. */}
            {manualOk && (
            <details className="mt-4 pt-3 border-t border-white/[0.06]">
              <summary className="text-[11px] text-zinc-500 cursor-pointer hover:text-zinc-300">
                Conectar a mano con un token (método viejo)
              </summary>
              <div className="pt-3 space-y-3">
                <p className="text-[11px] text-zinc-500 leading-relaxed">
                  Sólo si ya tenés una app privada creada. Con este método los pedidos entran cada 15 minutos, no al instante.
                </p>
                <ShopifyTutorial />
                <form onSubmit={saveManualToken} className="space-y-3">
                  <div>
                    <label className={labelClass}>Admin API Access Token</label>
                    <input
                      type="password"
                      value={manualToken}
                      onChange={(e) => setManualToken(e.target.value)}
                      className={inputClass}
                      placeholder="shpat_xxxxxxxxxxxxxxxxx"
                      autoComplete="off"
                    />
                  </div>
                  <PrimaryButton type="submit" busy={busy === 'shopify-token'} busyLabel="Verificando con Shopify…" arrow={false} className="w-full sm:w-auto">
                    Verificar y guardar
                  </PrimaryButton>
                </form>
              </div>
            </details>
            )}
          </div>

          {/* Opción B — Dashboard con Excel */}
          {/* Opción B — Carga propia. Va ANTES del panel externo a propósito: es
              la única que no depende de tener otra cosa andando, así que es la
              respuesta para quien no vende por Shopify. */}
          <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/[0.04] p-5">
            <div className="flex items-center gap-2 mb-1">
              <FileSpreadsheet className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-white">Cargar los pedidos acá</h3>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed mb-4">
              Si no vendés por Shopify. Cargás cada pedido a mano o importás un Excel, dentro de AutoEnvía. No hace falta conectar nada.
            </p>
            <PrimaryButton
              type="button"
              onClick={usarFuenteInterna}
              busy={busy === 'interna'}
              busyLabel="Activando…"
              arrow={false}
              className="w-full sm:w-auto"
            >
              Usar esta opción
            </PrimaryButton>
            <p className="text-[11px] text-zinc-500 mt-3 leading-relaxed">
              <span>Después vas a tener una sección </span>
              <span className="text-zinc-400">Pedidos</span>
              <span> para cargarlos y despacharlos cuando quieras.</span>
            </p>
          </div>

          {/* Opción C — panel externo (DEPO, VentaFlow, el panel de tu proveedor) */}
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-5">
            <div className="flex items-center gap-2 mb-1">
              <FileSpreadsheet className="w-4 h-4 text-zinc-300" />
              <h3 className="text-sm font-semibold text-white">Conectar un panel que ya usás</h3>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed mb-4">
              Si tus pedidos ya viven en otro sistema (VentaFlow, el panel de tu depósito): nos das su dirección y su token, y los levantamos de ahí.
            </p>
            <form onSubmit={saveDashboard} className="space-y-3">
              <div>
                <label className={labelClass}>URL del dashboard</label>
                <input value={dashUrl} onChange={(e) => setDashUrl(e.target.value)} className={inputClass} placeholder="https://autoenvia-dash.vercel.app" autoComplete="off" />
              </div>
              <div>
                <label className={labelClass}>API token</label>
                <input type="password" value={dashToken} onChange={(e) => setDashToken(e.target.value)} className={inputClass} placeholder="ae_xxxxxxxx" autoComplete="off" />
                <p className="text-[11px] text-zinc-500 mt-1">Lo encontrás en la página de tu cliente, sección API.</p>
              </div>
              <PrimaryButton type="submit" busy={busy === 'dashboard'} busyLabel="Probando la conexión…" arrow={false} className="w-full sm:w-auto">
                Probar y guardar
              </PrimaryButton>
            </form>
            <p className="text-[11px] text-zinc-500 mt-3 leading-relaxed">
              Con esta opción los pedidos se procesan según el modo que elijas más adelante (cada 15 minutos o cada hora); no hay aviso instantáneo.
            </p>
          </div>

          {connected && (
            <button type="button" onClick={() => setEditing(false)} className="text-xs text-zinc-500 hover:text-zinc-300 underline underline-offset-2">
              Dejar la tienda que ya está conectada
            </button>
          )}
        </div>
      )}

      <StepFooter>
        <SecondaryButton onClick={onBack} back>
          Atrás
        </SecondaryButton>
        <PrimaryButton onClick={onContinue} disabled={!connected} className={cn(!connected && 'opacity-50')}>
          Continuar
        </PrimaryButton>
      </StepFooter>
    </StepCard>
  );
}

function oauthMessage(r: OAuthReturn): { ok: boolean; text: string } {
  if (r.motivo === 'connected') {
    const base = 'Tienda conectada.';
    return {
      ok: true,
      text: r.webhooks ? `${base} Shopify no confirmó el aviso instantáneo; los pedidos igual entran cada 15 minutos.` : base,
    };
  }
  if (r.motivo === 'misconfigured') {
    return { ok: false, text: 'La conexión con Shopify no está disponible ahora. Probá más tarde o usá el token manual.' };
  }
  return SHOPIFY_OAUTH_MESSAGES[r.motivo] ?? { ok: false, text: `No pudimos conectar (${r.motivo}).` };
}
