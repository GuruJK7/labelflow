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
} from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * In-step tutorial for getting a Shopify Admin API token.
 *
 * The Shopify dev-app flow has ~7 clicks across 3 different admin screens
 * and uses jargon ("Admin API access", "scopes", "shpat_") that scares
 * off non-technical store owners. Without this tutorial, the support
 * load would dwarf any other onboarding step.
 *
 * Screenshots will be added in a follow-up — for now the text-only
 * version is detailed enough for someone who knows Shopify Admin to
 * get unstuck. Each scope is explained inline so the user understands
 * what they're approving (and so we can later cite this when explaining
 * why we don't ask for write_customers etc.).
 */

const REQUIRED_SCOPES = [
  {
    name: 'read_orders',
    why: 'Para leer los pedidos nuevos que necesitan envío.',
  },
  {
    name: 'write_orders',
    why: 'Para marcar pedidos como "Preparado" cuando el envío sale.',
  },
  {
    name: 'read_fulfillments',
    why: 'Para detectar pedidos ya despachados manualmente.',
  },
  {
    name: 'write_fulfillments',
    why: 'Para crear el fulfillment con el número de guía DAC.',
  },
  {
    name: 'read_products',
    why: 'Para leer tipos de producto (filtros opcionales por categoría).',
  },
] as const;

export function ShopifyTutorial() {
  const [expanded, setExpanded] = useState(false);
  const [copiedScope, setCopiedScope] = useState<string | null>(null);

  const copyAllScopes = () => {
    const all = REQUIRED_SCOPES.map((s) => s.name).join(', ');
    navigator.clipboard?.writeText(all).catch(() => {
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
              Vamos a crear una <strong className="text-zinc-200">app personalizada</strong> dentro
              de tu tienda Shopify. Es la forma oficial y segura — no te pide instalar
              nada en App Store ni compartir tu contraseña. Te toma ~3 minutos.
            </p>
          </div>

          {/* Step list */}
          <ol className="space-y-3 text-sm text-zinc-300">
            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                1
              </span>
              <div className="flex-1 leading-relaxed">
                Entrá al admin de Shopify y andá a{' '}
                <span className="text-zinc-100 font-medium">
                  Configuración → Apps y canales de venta
                </span>
                .
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                2
              </span>
              <div className="flex-1 leading-relaxed">
                Hacé clic en{' '}
                <span className="text-zinc-100 font-medium">Desarrollar apps</span> (arriba a la
                derecha) y aceptá los términos si es la primera vez. Después{' '}
                <span className="text-zinc-100 font-medium">Crear app</span>.
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                3
              </span>
              <div className="flex-1 leading-relaxed">
                Ponele un nombre — algo como{' '}
                <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs">
                  LabelFlow
                </code>{' '}
                — y elegí tu usuario como desarrollador de la app.
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                4
              </span>
              <div className="flex-1 leading-relaxed">
                Andá a la pestaña{' '}
                <span className="text-zinc-100 font-medium">
                  Configuración → Configurar permisos de Admin API
                </span>
                . Esto abre el listado de "scopes".
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                5
              </span>
              <div className="flex-1 space-y-2 leading-relaxed">
                <div>
                  Buscá y tildá <strong>solo</strong> estos 5 scopes (no actives ningún otro —
                  cuanto menos permisos otorgues, más seguro):
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
                      <Copy className="w-3 h-3" /> Copiar los 5 scopes
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
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                6
              </span>
              <div className="flex-1 leading-relaxed">
                Hacé clic en <span className="text-zinc-100 font-medium">Guardar</span>, y
                después <span className="text-zinc-100 font-medium">Instalar app</span>{' '}
                arriba a la derecha. Shopify te pedirá confirmar — aceptá.
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                7
              </span>
              <div className="flex-1 leading-relaxed">
                En la pestaña{' '}
                <span className="text-zinc-100 font-medium">Credenciales de la API</span>{' '}
                aparece el{' '}
                <span className="text-zinc-100 font-medium">
                  Token de acceso de Admin API
                </span>
                . Hacé clic en{' '}
                <span className="text-zinc-100 font-medium">Mostrar token una vez</span> y
                copialo —{' '}
                <strong className="text-amber-300">
                  Shopify NO te lo deja ver de nuevo
                </strong>
                . Empieza con{' '}
                <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
                  shpat_
                </code>
                .
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 text-emerald-300 text-xs font-semibold flex items-center justify-center">
                ✓
              </span>
              <div className="flex-1 leading-relaxed text-zinc-200">
                Pegalo abajo junto con la URL de tu tienda y le damos a{' '}
                <span className="text-zinc-100 font-medium">Verificar</span>. Si algo
                falla, revisá los scopes — es el problema más común.
              </div>
            </li>
          </ol>

          {/* Security footnote */}
          <div className="flex items-start gap-2 text-[11px] text-zinc-500 leading-relaxed bg-black/20 border border-white/[0.04] rounded-lg p-3 mt-4">
            <Shield className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0 mt-0.5" />
            <span>
              El token se guarda cifrado en nuestra base con AES-256. Si lo querés
              revocar, vas a la misma pantalla de "Apps personalizadas" en Shopify y
              hacés clic en{' '}
              <span className="text-zinc-300 font-medium">Desinstalar app</span> — ahí
              dejamos de tener acceso al instante.
            </span>
          </div>

          {/* Direct link */}
          <a
            href="https://help.shopify.com/en/manual/apps/app-types/custom-apps"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-cyan-300 transition-colors',
            )}
          >
            Documentación oficial de Shopify <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      )}
    </div>
  );
}
