'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Info,
  ExternalLink,
  Copy,
  Check,
  Shield,
  AlertTriangle,
  BookOpen,
} from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/cn';

/**
 * Inline dropdown tutorial inside the onboarding wizard.
 *
 * Two ways to read it:
 *   - This compact dropdown (collapsed by default, no extra route).
 *   - The full page at /tutorial/shopify-token with real screenshots, the
 *     copy-pasteable Python OAuth server, and a Claude Desktop prompt.
 *
 * The 10 required scopes here are the SAME list enforced runtime by
 * /api/v1/shopify-scopes/route.ts. They MUST stay in sync — if you add or
 * remove a scope, update both files plus the standalone tutorial page plus
 * the error message in /api/v1/onboarding/test-shopify/route.ts.
 *
 * Flow rewritten 2026-04-29 after verifying end-to-end against KARBON store
 * — twice, with two independent apps. Both tokens (shpat_f7f2... and
 * shpat_7004...) authenticated against live Admin API with all 10 scopes.
 * The second run surfaced two real-world traps now reflected in step 3:
 *   - Typo "callbac" (missing "k") in redirect_uri → invalid_request error.
 *   - Published versions are read-only — to fix anything, click "Versiones"
 *     in the sidebar and create a new version.
 *
 * The old "Mostrar token una vez" button doesn't exist in the new Dev
 * Dashboard — the only way to obtain a `shpat_*` is to complete an OAuth
 * `authorization_code` exchange. Documented here as 5 condensed phases
 * (the full breakdown lives in the standalone /tutorial/shopify-token page).
 */

const REQUIRED_SCOPES = [
  { name: 'read_orders', why: 'Leer los pedidos nuevos.' },
  { name: 'write_orders', why: 'Marcar pedidos como preparados.' },
  { name: 'read_fulfillments', why: 'Detectar envíos manuales.' },
  { name: 'write_fulfillments', why: 'Crear el fulfillment con la guía DAC.' },
  { name: 'read_products', why: 'Filtros opcionales por categoría.' },
  { name: 'write_products', why: 'Actualizar metadata de bultos especiales.' },
  {
    name: 'read_assigned_fulfillment_orders',
    why: 'Leer fulfillment orders asignados.',
  },
  {
    name: 'write_assigned_fulfillment_orders',
    why: 'Aceptar/cerrar fulfillment orders desde LabelFlow.',
  },
  {
    name: 'read_merchant_managed_fulfillment_orders',
    why: 'Leer fulfillment orders del merchant.',
  },
  {
    name: 'write_merchant_managed_fulfillment_orders',
    why: 'Crear/modificar fulfillment orders del merchant.',
  },
] as const;

const SCOPES_CSV = REQUIRED_SCOPES.map((s) => s.name).join(',');

export function ShopifyTutorial() {
  const [expanded, setExpanded] = useState(false);
  const [copiedScope, setCopiedScope] = useState<string | null>(null);

  const copyAllScopes = () => {
    navigator.clipboard?.writeText(SCOPES_CSV).catch(() => {
      // Clipboard may be denied (insecure context); the user can still
      // copy each scope individually from the list below.
    });
    setCopiedScope('__all__');
    setTimeout(() => setCopiedScope(null), 1500);
  };

  return (
    <div className="mt-5 rounded-xl border border-cyan-500/15 bg-cyan-500/[0.04] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-cyan-500/[0.04] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Info className="w-4 h-4 text-cyan-400 flex-shrink-0" />
          <span className="text-sm font-medium text-white">
            ¿Cómo obtener el token? (paso a paso)
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-zinc-500 flex-shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-zinc-500 flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-4 text-sm text-zinc-300">
          {/* Quick context */}
          <div className="bg-zinc-900/40 border border-white/[0.04] rounded-lg p-3">
            <p className="text-xs text-zinc-400 leading-relaxed">
              Vamos a crear una{' '}
              <strong className="text-zinc-200">app personalizada</strong> en
              el{' '}
              <strong className="text-zinc-200">
                Dev Dashboard de Shopify
              </strong>{' '}
              y completar un OAuth local para obtener un token{' '}
              <code className="font-mono">shpat_*</code> permanente. Toma ~6
              minutos. Necesitás{' '}
              <code className="font-mono">python3</code> instalado en tu Mac/Linux.
            </p>
          </div>

          {/* Link to full standalone tutorial */}
          <Link
            href="/tutorial/shopify-token"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3 rounded-lg border border-cyan-500/25 bg-cyan-500/[0.06] hover:bg-cyan-500/[0.1] px-3 py-2.5 transition-colors group"
          >
            <BookOpen className="w-4 h-4 text-cyan-300 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-semibold text-white">
                Ver tutorial completo + script Python + prompt Claude →
              </div>
              <div className="text-[11px] text-zinc-400">
                Página dedicada con capturas reales, el server OAuth listo
                para copiar y un prompt automático.
              </div>
            </div>
            <ExternalLink className="w-3.5 h-3.5 text-zinc-500 group-hover:text-cyan-300 transition-colors flex-shrink-0" />
          </Link>

          {/* Step list — 5 condensed phases */}
          <ol className="space-y-3 text-sm text-zinc-300">
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                1
              </span>
              <div className="flex-1 leading-relaxed">
                Andá a{' '}
                <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
                  shopify.dev/dashboard
                </code>{' '}
                → click{' '}
                <span className="text-zinc-100 font-medium">Crear app</span> →{' '}
                <span className="text-zinc-100 font-medium">
                  Empezar desde Dev Dashboard
                </span>
                . Nombre sugerido:{' '}
                <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs">
                  AutoEnvía
                </code>
                .
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                2
              </span>
              <div className="flex-1 space-y-2 leading-relaxed">
                <div>
                  En la sección{' '}
                  <span className="text-zinc-100 font-medium">Acceso</span>,
                  pegá los 10 alcances en el campo{' '}
                  <span className="text-zinc-100 font-medium">Alcances</span>{' '}
                  (separados por coma):
                </div>
                <button
                  type="button"
                  onClick={copyAllScopes}
                  className="inline-flex items-center gap-1.5 text-[11px] font-medium text-cyan-300 hover:text-cyan-200 bg-black/30 border border-cyan-500/20 rounded-md px-2 py-1"
                >
                  {copiedScope === '__all__' ? (
                    <>
                      <Check className="w-3 h-3" /> Copiados
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" /> Copiar los 10 alcances (CSV)
                    </>
                  )}
                </button>
                <ul className="space-y-1.5 mt-2">
                  {REQUIRED_SCOPES.map((s) => (
                    <li
                      key={s.name}
                      className="flex items-start gap-2 text-xs leading-relaxed"
                    >
                      <code className="text-cyan-300 bg-black/40 px-1.5 py-0.5 rounded font-mono flex-shrink-0">
                        {s.name}
                      </code>
                      <span className="text-zinc-500">— {s.why}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-500/15 ring-1 ring-amber-500/40 text-amber-300 text-xs font-semibold flex items-center justify-center">
                3
              </span>
              <div className="flex-1 leading-relaxed">
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-100 leading-relaxed space-y-1.5">
                    <div>
                      <strong>Crítico:</strong> en el mismo form, verificá:
                    </div>
                    <ul className="space-y-1 list-disc pl-4">
                      <li>
                        <span className="text-amber-200 font-medium">
                          URLs de redireccionamiento
                        </span>{' '}
                        ={' '}
                        <code className="font-mono">
                          http://localhost:3456/callback
                        </code>{' '}
                        <span className="text-amber-300/80">
                          (con la "k" final — el typo "callbac" hace que el
                          OAuth falle con "invalid_request: redirect_uri is
                          not whitelisted")
                        </span>
                      </li>
                      <li>
                        Checkbox{' '}
                        <span className="text-amber-200 font-medium">
                          "Usar flujo de instalación heredado"
                        </span>{' '}
                        TILDADO
                      </li>
                    </ul>
                    <div>
                      Click{' '}
                      <span className="text-amber-200 font-medium">
                        Publicar
                      </span>
                      . Si después necesitás cambiar algo, no podés editar la
                      versión activa: click sidebar "Versiones" → "Crear
                      versión" para abrir un editor pre-cargado.
                    </div>
                  </div>
                </div>
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                4
              </span>
              <div className="flex-1 leading-relaxed">
                Andá a la pestaña{' '}
                <span className="text-zinc-100 font-medium">Configuración</span>{' '}
                de tu app, copiá el{' '}
                <span className="text-zinc-100 font-medium">ID de cliente</span>{' '}
                y revelá/copiá el{' '}
                <span className="text-zinc-100 font-medium">Secreto</span>{' '}
                (empieza con{' '}
                <code className="font-mono">shpss_</code>). Pegalos en el dict{' '}
                <code className="font-mono">APPS</code> del script Python (lo
                tenés en el tutorial completo) y arrancalo:
                <pre className="mt-2 rounded-md bg-black/60 border border-white/[0.04] p-2 text-[10.5px] text-zinc-300 font-mono overflow-x-auto">
                  python3 ~/Desktop/shopify_oauth.py
                </pre>
                Debe imprimir{' '}
                <code className="font-mono text-emerald-300">
                  Listening on http://localhost:3456
                </code>
                .
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                5
              </span>
              <div className="flex-1 leading-relaxed">
                Pegá esta URL en una pestaña nueva (cambiando{' '}
                <code className="font-mono">{'{SLUG}'}</code> por tu shop slug y{' '}
                <code className="font-mono">{'{CLIENT_ID}'}</code>):
                <pre className="mt-2 rounded-md bg-black/60 border border-white/[0.04] p-2 text-[10px] text-zinc-300 font-mono overflow-x-auto whitespace-pre-wrap break-all">
                  https://{'{SLUG}'}.myshopify.com/admin/oauth/authorize?client_id={'{CLIENT_ID}'}&scope={SCOPES_CSV}&redirect_uri=http://localhost:3456/callback&state=labelflow
                </pre>
                Aprobá la instalación → tu server captura el code → te entrega
                el{' '}
                <code className="font-mono text-emerald-300">shpat_*</code>{' '}
                guardado en{' '}
                <code className="font-mono">~/Desktop/shopify_tokens.json</code>
                .
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center justify-center">
                ✓
              </span>
              <div className="flex-1 leading-relaxed text-zinc-200">
                Pegá el{' '}
                <code className="font-mono">shpat_*</code> abajo junto con la
                URL de tu tienda y le damos a{' '}
                <span className="text-zinc-100 font-medium">Verificar</span>.
              </div>
            </li>
          </ol>

          {/* Security footnote */}
          <div className="flex items-start gap-2 text-[11px] text-zinc-500 leading-relaxed bg-black/20 border border-white/[0.04] rounded-lg p-3 mt-4">
            <Shield className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0 mt-0.5" />
            <span>
              El token se guarda cifrado en nuestra base con AES-256. Si lo
              querés revocar, andá al Dev Dashboard, abrí tu app y hacé clic en{' '}
              <span className="text-zinc-300 font-medium">Eliminar app</span> —
              el token se invalida al instante.
            </span>
          </div>

          {/* Direct link */}
          <a
            href="https://shopify.dev/docs/api/usage/authentication"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-cyan-300 transition-colors',
            )}
          >
            Documentación oficial de Shopify OAuth{' '}
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}
    </div>
  );
}
