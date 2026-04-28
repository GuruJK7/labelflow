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
 *   - The full page at /tutorial/shopify-token with verified screenshots
 *     and a Claude Desktop automation prompt.
 *
 * The 10 required scopes here are the SAME list enforced runtime by
 * /api/v1/shopify-scopes/route.ts. They MUST stay in sync — if you add or
 * remove a scope, update both files plus the standalone tutorial page plus
 * the error message in /api/v1/onboarding/test-shopify/route.ts.
 *
 * The flow text was rewritten in 2026-04 after Shopify migrated "custom
 * apps" from `Apps y canales de venta → Desarrollar apps` to the new
 * Dev Dashboard at dev.shopify.com. The legacy-installation checkbox is
 * the single most common reason a token is rejected — call it out twice.
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
              de tu tienda Shopify usando el nuevo{' '}
              <strong className="text-zinc-200">Dev Dashboard</strong>. Es la
              forma oficial y segura — no te pide instalar nada en App Store ni
              compartir tu contraseña. Te toma ~3 minutos.
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
                Ver tutorial completo con capturas →
              </div>
              <div className="text-[11px] text-zinc-400">
                Página dedicada con screenshots de cada pantalla y un prompt
                para Claude Desktop.
              </div>
            </div>
            <ExternalLink className="w-3.5 h-3.5 text-zinc-500 group-hover:text-cyan-300 transition-colors flex-shrink-0" />
          </Link>

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
                <span className="text-zinc-100 font-medium">
                  Desarrollar apps en Dev Dashboard
                </span>
                . Vas a saltar a{' '}
                <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
                  dev.shopify.com
                </code>
                .
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                3
              </span>
              <div className="flex-1 leading-relaxed">
                Clic en <span className="text-zinc-100 font-medium">Crear app</span>{' '}
                y elegí <span className="text-zinc-100 font-medium">Empezar desde Dev Dashboard</span>{' '}
                (no la opción de Shopify CLI). Ponele un nombre — sugerimos{' '}
                <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs">
                  AutoEnvía
                </code>
                .
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                4
              </span>
              <div className="flex-1 leading-relaxed">
                En el editor de la versión, scrolleá hasta la sección{' '}
                <span className="text-zinc-100 font-medium">Acceso</span> y
                hacé clic en{' '}
                <span className="text-zinc-100 font-medium">
                  Seleccionar alcances
                </span>{' '}
                (a la derecha del label "Alcances").
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                5
              </span>
              <div className="flex-1 space-y-2 leading-relaxed">
                <div>
                  En el modal, buscá y tildá <strong>solo</strong> estos 10
                  alcances (cuanto menos permisos otorgues, más seguro):
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
                      <Copy className="w-3 h-3" /> Copiar los 10 alcances
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
                <div className="text-[11px] text-zinc-500 mt-2">
                  Cuando termines, clic en{' '}
                  <span className="text-zinc-300 font-medium">Listo</span>.
                </div>
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-amber-500/15 ring-1 ring-amber-500/40 text-amber-300 text-xs font-semibold flex items-center justify-center">
                6
              </span>
              <div className="flex-1 leading-relaxed">
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-100 leading-relaxed">
                    <strong>Crítico:</strong> volvé a la sección{' '}
                    <span className="text-amber-200 font-medium">Acceso</span> y{' '}
                    <strong>tildá el checkbox</strong>{' '}
                    <span className="text-amber-200 font-medium">
                      "Usar flujo de instalación heredado"
                    </span>
                    . Sin esto, Shopify NO te entrega un token{' '}
                    <code className="font-mono">shpat_</code>.
                  </div>
                </div>
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                7
              </span>
              <div className="flex-1 leading-relaxed">
                Hacé clic en{' '}
                <span className="text-zinc-100 font-medium">Publicar</span>{' '}
                (abajo a la derecha). Confirmá si te lo pide.
              </div>
            </li>

            <li className="flex gap-3">
              <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                8
              </span>
              <div className="flex-1 leading-relaxed">
                Andá a la pestaña{' '}
                <span className="text-zinc-100 font-medium">Configuración</span>{' '}
                de tu app, buscá{' '}
                <span className="text-zinc-100 font-medium">
                  Token de acceso de Admin API
                </span>{' '}
                y clic en{' '}
                <span className="text-zinc-100 font-medium">
                  Mostrar token una vez
                </span>
                . Copialo —{' '}
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
                <span className="text-zinc-100 font-medium">Verificar</span>. Si
                algo falla, revisá los alcances y el checkbox de "instalación
                heredada" — son los dos problemas más comunes.
              </div>
            </li>
          </ol>

          {/* Security footnote */}
          <div className="flex items-start gap-2 text-[11px] text-zinc-500 leading-relaxed bg-black/20 border border-white/[0.04] rounded-lg p-3 mt-4">
            <Shield className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0 mt-0.5" />
            <span>
              El token se guarda cifrado en nuestra base con AES-256. Si lo querés
              revocar, vas al Dev Dashboard, abrís tu app y hacés clic en{' '}
              <span className="text-zinc-300 font-medium">Eliminar app</span> —
              ahí dejamos de tener acceso al instante.
            </span>
          </div>

          {/* Direct link */}
          <a
            href="https://shopify.dev/docs/api/admin"
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
