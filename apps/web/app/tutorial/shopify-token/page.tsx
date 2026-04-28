import Link from 'next/link';
import {
  ShieldCheck,
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Sparkles,
  KeyRound,
  Zap,
  CheckCircle2,
  Info,
} from 'lucide-react';
import { CopyButton } from './_components/CopyButton';
import {
  MockSettings,
  MockDevelopApps,
  MockCreateApp,
  MockChooseDashboard,
  MockAccessSection,
  MockScopePicker,
  MockTokenReveal,
} from './_components/Mocks';

/**
 * Public tutorial: how to generate a Shopify Admin API token for LabelFlow.
 *
 * Why this lives in /tutorial (public, no auth):
 *   Linked from the onboarding wizard's Shopify step. A user staring at
 *   "Pegá tu shpat_ token" can't sign in elsewhere to read this — the
 *   tutorial has to render in a fresh tab without bouncing through /login.
 *   The matching middleware allowlist entry is in apps/web/middleware.ts.
 *
 * What's verified vs. what's prose:
 *   Every URL fragment, button label, scope name and section header on this
 *   page was captured by driving Chrome through the live Shopify flow on
 *   2026-04-28 against the operator's KARBON store. The 10 required scopes
 *   match the canonical list in apps/web/app/api/v1/shopify-scopes/route.ts.
 *
 * If Shopify rolls a UI change:
 *   1. Re-run the flow against a real store.
 *   2. Update Mocks.tsx + the step copy here.
 *   3. Sync the scope list in this page AND in shopify-scopes/route.ts AND in
 *      onboarding/_components/ShopifyTutorial.tsx — they MUST stay aligned.
 */

const REQUIRED_SCOPES: { name: string; resource: string; why: string }[] = [
  {
    name: 'read_orders',
    resource: 'Orders',
    why: 'Leer los pedidos nuevos que necesitan envío.',
  },
  {
    name: 'write_orders',
    resource: 'Orders',
    why: 'Marcar pedidos como "Preparado" cuando el envío sale.',
  },
  {
    name: 'read_fulfillments',
    resource: 'Fulfillment services',
    why: 'Detectar pedidos que ya fueron despachados manualmente.',
  },
  {
    name: 'write_fulfillments',
    resource: 'Fulfillment services',
    why: 'Crear el fulfillment con el número de guía DAC.',
  },
  {
    name: 'read_products',
    resource: 'Products',
    why: 'Leer tipos de producto para filtros opcionales por categoría.',
  },
  {
    name: 'write_products',
    resource: 'Products',
    why: 'Actualizar metadata de producto cuando armás bultos especiales.',
  },
  {
    name: 'read_assigned_fulfillment_orders',
    resource: 'Assigned fulfillment',
    why: 'Leer fulfillment orders asignados a tu cuenta.',
  },
  {
    name: 'write_assigned_fulfillment_orders',
    resource: 'Assigned fulfillment',
    why: 'Aceptar/cerrar fulfillment orders desde LabelFlow.',
  },
  {
    name: 'read_merchant_managed_fulfillment_orders',
    resource: 'Merchant managed fulfillment',
    why: 'Leer fulfillment orders gestionados por el merchant.',
  },
  {
    name: 'write_merchant_managed_fulfillment_orders',
    resource: 'Merchant managed fulfillment',
    why: 'Crear/modificar fulfillment orders gestionados por el merchant.',
  },
];

const ALL_SCOPES_CSV = REQUIRED_SCOPES.map((s) => s.name).join(', ');

const CLAUDE_DESKTOP_PROMPT = `Sos un agente con acceso a Chrome MCP. Tu tarea es generar un token de Admin API de Shopify para el comercio del usuario y entregárselo al final, listo para pegarlo en LabelFlow.

REGLAS CRÍTICAS
- Verificá visualmente cada paso (screenshot) antes de hacer clic. No alucines.
- Nunca compartas el token en logs públicos: solo lo entregás al usuario al final, en un único bloque.
- Si una pantalla no coincide con esta guía, parate y avisá al usuario.

PRECONDICIÓN
- El usuario tiene sesión activa en https://admin.shopify.com con permisos de Owner/Staff con acceso a "Apps".
- Confirmá esto al inicio (screenshot del admin con la tienda visible).

FLUJO (10 PASOS)
1) Navegá a https://admin.shopify.com y entrá a la tienda objetivo.
2) En el sidebar izquierdo, abajo, hacé clic en "Configuración".
3) En el menú de Configuración, clic en "Apps y canales de venta".
4) Clic en el botón "Desarrollar apps en Dev Dashboard". Vas a saltar a dev.shopify.com.
5) En el Dev Dashboard, clic en "Crear app".
6) Seleccioná la opción "Empezar desde Dev Dashboard" (NO la de Shopify CLI).
7) Ingresá el nombre exacto: "AutoEnvía". Confirmá clic en "Crear".
8) En la pantalla de versión, scrolleá hasta la sección "Acceso":
   a) Clic en "Seleccionar alcances" (botón a la derecha del label "Alcances").
   b) En el modal, marcá EXACTAMENTE estos 10 alcances (usá el buscador):
      ${REQUIRED_SCOPES.map((s) => `- ${s.name}`).join('\n      ')}
   c) Clic en "Listo".
9) Volvé a la sección "Acceso" y TILDÁ el checkbox "Usar flujo de instalación heredado".
   ESTO ES OBLIGATORIO. Sin este tilde, Shopify NO genera un token shpat_.
10) Clic en "Publicar" (botón abajo a la derecha). Confirmá si pide confirmación.

OBTENCIÓN DEL TOKEN
- Una vez publicada la versión, andá a la pestaña "Configuración" de la app.
- Buscá la sección "Token de acceso de Admin API".
- Clic en "Mostrar token una vez". Capturá el token (empieza con "shpat_").
- Copiá el token al portapapeles del usuario y mostralo en pantalla en un bloque de código.

VALIDACIÓN
- El token DEBE empezar con "shpat_" y tener entre 30 y 80 caracteres.
- Si recibís cualquier otro formato, ALGO SALIÓ MAL: probablemente faltó el tilde de "instalación heredada". Avisá al usuario y pedile que vuelva al paso 9.

ENTREGA FINAL
- Mostrá al usuario:
  - URL de la tienda en formato "<slug>.myshopify.com" (ej: "karbon-store.myshopify.com")
  - Token shpat_...
- Recordale que Shopify NO muestra el token de nuevo y que ya quedó copiado al portapapeles.`;

const STEPS: {
  n: number;
  title: string;
  body: React.ReactNode;
  mock: React.ReactNode;
  warn?: string;
}[] = [
  {
    n: 1,
    title: 'Entrá al admin de tu tienda',
    body: (
      <>
        Abrí{' '}
        <code className="text-cyan-300 bg-black/40 px-1.5 py-0.5 rounded text-xs font-mono">
          admin.shopify.com
        </code>{' '}
        y elegí la tienda con la que vas a usar LabelFlow. En el sidebar
        izquierdo, abajo, hacé clic en{' '}
        <span className="text-zinc-100 font-semibold">Configuración</span>{' '}
        (ícono de engranaje).
      </>
    ),
    mock: <MockSettings className="w-full h-auto" />,
  },
  {
    n: 2,
    title: 'Apps y canales de venta',
    body: (
      <>
        Dentro de Configuración, clic en{' '}
        <span className="text-zinc-100 font-semibold">
          Apps y canales de venta
        </span>{' '}
        en el menú lateral. Vas a llegar a la pantalla{' '}
        <em>Desarrollo de apps</em>. Buscá el botón{' '}
        <span className="text-zinc-100 font-semibold">
          Desarrollar apps en Dev Dashboard
        </span>{' '}
        y hacé clic.
      </>
    ),
    mock: <MockDevelopApps className="w-full h-auto" />,
  },
  {
    n: 3,
    title: 'Creá una app nueva',
    body: (
      <>
        Vas a saltar a{' '}
        <code className="text-cyan-300 bg-black/40 px-1.5 py-0.5 rounded text-xs font-mono">
          dev.shopify.com/dashboard
        </code>
        . Si es tu primera app, vas a ver un estado vacío con un botón grande{' '}
        <span className="text-zinc-100 font-semibold">+ Crear app</span>.
        Hacé clic.
      </>
    ),
    mock: <MockCreateApp className="w-full h-auto" />,
  },
  {
    n: 4,
    title: 'Empezar desde Dev Dashboard',
    body: (
      <>
        Shopify te ofrece dos caminos. Elegí{' '}
        <span className="text-zinc-100 font-semibold">
          Empezar desde Dev Dashboard
        </span>
        , no la opción de Shopify CLI (esa es para devs que quieren código
        local). Después ingresá un nombre de app — sugerimos{' '}
        <code className="text-cyan-300 bg-black/40 px-1.5 py-0.5 rounded text-xs font-mono">
          AutoEnvía
        </code>{' '}
        — y clic en <span className="text-zinc-100 font-semibold">Crear</span>.
      </>
    ),
    mock: <MockChooseDashboard className="w-full h-auto" />,
  },
  {
    n: 5,
    title: 'Configurá la sección "Acceso"',
    body: (
      <>
        Ya en el editor de la versión, scrolleá hasta la sección{' '}
        <span className="text-zinc-100 font-semibold">Acceso</span>. Vas a ver
        un campo de texto para los alcances y, a la derecha del label
        "Alcances", un botón{' '}
        <span className="text-zinc-100 font-semibold">
          Seleccionar alcances
        </span>
        . Hacé clic.
      </>
    ),
    mock: <MockAccessSection className="w-full h-auto" />,
    warn:
      'Mantené tildado el checkbox "Usar flujo de instalación heredado" — sin esto Shopify no genera un token shpat_, te obliga a un flujo OAuth que LabelFlow no soporta.',
  },
  {
    n: 6,
    title: 'Tildá los 10 alcances',
    body: (
      <>
        Se abre un modal con todos los recursos del Admin API. Usá el buscador
        para encontrar cada uno y tildalos exactamente. Cuando termines, clic
        en <span className="text-zinc-100 font-semibold">Listo</span>.
      </>
    ),
    mock: <MockScopePicker className="w-full h-auto" />,
  },
  {
    n: 7,
    title: 'Publicá la versión',
    body: (
      <>
        Volvé a verificar que el checkbox{' '}
        <span className="text-amber-300 font-semibold">
          Usar flujo de instalación heredado
        </span>{' '}
        esté tildado, y hacé clic en{' '}
        <span className="text-zinc-100 font-semibold">Publicar</span> abajo a
        la derecha. Shopify te puede pedir confirmar — aceptá.
      </>
    ),
    mock: <MockAccessSection className="w-full h-auto" />,
  },
  {
    n: 8,
    title: 'Copiá el token shpat_',
    body: (
      <>
        Andá a la pestaña{' '}
        <span className="text-zinc-100 font-semibold">Configuración</span> de
        tu app. En la sección{' '}
        <span className="text-zinc-100 font-semibold">
          Token de acceso de Admin API
        </span>{' '}
        vas a ver el botón{' '}
        <span className="text-zinc-100 font-semibold">
          Mostrar token una vez
        </span>
        . Hacé clic, copiá el token (empieza con{' '}
        <code className="text-cyan-300 bg-black/40 px-1.5 py-0.5 rounded text-xs font-mono">
          shpat_
        </code>
        ) y pegalo en LabelFlow.
      </>
    ),
    mock: <MockTokenReveal className="w-full h-auto" />,
    warn:
      'Shopify NO muestra el token de nuevo. Si lo perdés, tenés que crear una versión nueva y volver a publicar.',
  },
];

export default function ShopifyTokenTutorialPage() {
  return (
    <div className="min-h-screen bg-[#050505] text-zinc-200">
      {/* Top bar */}
      <header className="sticky top-0 z-10 backdrop-blur-md bg-black/60 border-b border-white/[0.05]">
        <div className="max-w-5xl mx-auto px-5 sm:px-8 py-4 flex items-center justify-between">
          <Link
            href="/onboarding"
            className="inline-flex items-center gap-2 text-xs text-zinc-400 hover:text-cyan-300 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Volver al onboarding
          </Link>
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            Guía oficial • Verificada el 28 abr 2026
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-5 sm:px-8 pt-12 pb-10">
        <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide font-semibold text-cyan-300 bg-cyan-500/10 border border-cyan-500/20 rounded-full px-3 py-1">
          <Sparkles className="w-3 h-3" />
          Tutorial Shopify
        </div>
        <h1 className="mt-4 text-3xl sm:text-4xl font-bold text-white leading-tight">
          Cómo generar tu token de Admin API en Shopify
        </h1>
        <p className="mt-4 text-base text-zinc-400 leading-relaxed max-w-3xl">
          LabelFlow usa el Admin API de Shopify para leer tus pedidos y crear
          fulfillments con el número de guía DAC. Para eso necesitás un token
          que empieza con{' '}
          <code className="text-cyan-300 bg-black/40 px-1.5 py-0.5 rounded text-sm font-mono">
            shpat_
          </code>
          . Esta guía te lleva paso a paso por el flujo nuevo de{' '}
          <span className="text-zinc-200 font-semibold">Dev Dashboard</span>{' '}
          (Shopify migró el flujo viejo de "Apps personalizadas" — esta es la
          versión 2026).
        </p>

        {/* Three pills */}
        <div className="grid sm:grid-cols-3 gap-3 mt-8">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <Zap className="w-5 h-5 text-cyan-400" />
            <div className="text-sm font-semibold text-white mt-2">
              ~3 minutos
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              Si seguís los pasos al pie de la letra.
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <KeyRound className="w-5 h-5 text-cyan-400" />
            <div className="text-sm font-semibold text-white mt-2">
              10 alcances
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              Solo los que LabelFlow necesita. Nada más.
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <ShieldCheck className="w-5 h-5 text-cyan-400" />
            <div className="text-sm font-semibold text-white mt-2">
              Cero riesgo
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              Es un app personalizado — no compartís tu password.
            </div>
          </div>
        </div>
      </section>

      {/* Claude Desktop prompt — promoted to top so power users can copy
          and run without scrolling through the manual steps. */}
      <section className="max-w-5xl mx-auto px-5 sm:px-8 pb-10">
        <div className="rounded-2xl border border-violet-500/25 bg-gradient-to-br from-violet-500/[0.08] via-violet-500/[0.03] to-transparent p-6 sm:p-8 shadow-lg shadow-violet-500/5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-wider font-bold text-violet-300">
                <Sparkles className="w-3 h-3" />
                Modo automático · Recomendado
              </div>
              <h2 className="text-xl sm:text-2xl font-semibold text-white mt-1.5">
                ¿Querés que Claude Desktop lo haga por vos?
              </h2>
              <p className="text-sm text-zinc-400 mt-2 max-w-3xl leading-relaxed">
                Si tenés{' '}
                <span className="text-zinc-200 font-medium">Claude Desktop</span>{' '}
                con la extensión de Chrome instalada, copiá este prompt y pegalo
                en una conversación nueva. Claude va a abrir tu Shopify,
                configurar la app, marcar los 10 alcances y entregarte el token
                al final — sin que toques nada.
              </p>
            </div>
            <CopyButton
              value={CLAUDE_DESKTOP_PROMPT}
              label="Copiar prompt"
              variant="pill"
            />
          </div>
          <pre className="mt-5 rounded-xl bg-black/70 border border-white/[0.06] p-4 sm:p-5 text-[11.5px] text-zinc-300 font-mono leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-[420px]">
            {CLAUDE_DESKTOP_PROMPT}
          </pre>
          <div className="mt-4 flex items-start gap-2 text-[11px] text-zinc-500 leading-relaxed">
            <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              Requiere Claude Desktop + extensión Chrome MCP activa, y sesión
              iniciada en{' '}
              <code className="text-zinc-400 font-mono">admin.shopify.com</code>{' '}
              de la tienda objetivo.{' '}
              <span className="text-zinc-400">
                ¿No tenés Claude Desktop? Seguí el paso a paso manual abajo.
              </span>
            </span>
          </div>
        </div>
      </section>

      {/* TL;DR scopes panel */}
      <section className="max-w-5xl mx-auto px-5 sm:px-8 pb-10">
        <div className="rounded-2xl border border-cyan-500/15 bg-gradient-to-br from-cyan-500/[0.04] to-transparent p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-wider font-bold text-cyan-300">
                Atajo
              </div>
              <h2 className="text-xl font-semibold text-white mt-1">
                Los 10 alcances que necesitás
              </h2>
              <p className="text-sm text-zinc-400 mt-1">
                Copialos y pegalos directamente en el campo "Alcances" del Dev
                Dashboard.
              </p>
            </div>
            <CopyButton
              value={ALL_SCOPES_CSV}
              label="Copiar los 10 alcances"
              variant="pill"
            />
          </div>
          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {REQUIRED_SCOPES.map((s) => (
              <div
                key={s.name}
                className="flex items-start gap-2 rounded-lg bg-black/40 border border-white/[0.04] px-3 py-2"
              >
                <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <code className="text-cyan-300 font-mono text-xs truncate">
                      {s.name}
                    </code>
                    <CopyButton
                      value={s.name}
                      variant="small"
                      label=""
                      ariaLabel={`Copiar ${s.name}`}
                    />
                  </div>
                  <div className="text-[11px] text-zinc-500 mt-0.5 truncate">
                    {s.resource} — {s.why}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Step-by-step (manual) */}
      <section className="max-w-5xl mx-auto px-5 sm:px-8 pb-12">
        <h2 className="text-2xl font-bold text-white mb-2">
          Paso a paso manual
        </h2>
        <p className="text-sm text-zinc-500 mb-8 max-w-3xl">
          Las imágenes son ilustraciones esquemáticas — los textos, botones,
          URLs y nombres de alcances coinciden palabra por palabra con el UI
          real de Shopify (verificado el 28 de abril de 2026).
        </p>
        <ol className="space-y-10">
          {STEPS.map((step) => (
            <li
              key={step.n}
              className="rounded-2xl border border-white/[0.06] bg-white/[0.015] overflow-hidden"
            >
              <div className="grid lg:grid-cols-2 gap-0">
                <div className="p-6 sm:p-8 flex flex-col justify-center">
                  <div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-wider font-bold text-cyan-300">
                    Paso {step.n}
                  </div>
                  <h3 className="text-xl font-semibold text-white mt-1">
                    {step.title}
                  </h3>
                  <p className="text-sm text-zinc-400 leading-relaxed mt-3">
                    {step.body}
                  </p>
                  {step.warn && (
                    <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2">
                      <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                      <span className="text-xs text-amber-200 leading-relaxed">
                        {step.warn}
                      </span>
                    </div>
                  )}
                </div>
                <div className="bg-black/40 border-t lg:border-t-0 lg:border-l border-white/[0.05] p-4 sm:p-6 flex items-center justify-center">
                  {step.mock}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Troubleshooting */}
      <section className="max-w-5xl mx-auto px-5 sm:px-8 pb-16">
        <h2 className="text-2xl font-bold text-white mb-6">
          Si algo falla
        </h2>
        <div className="grid md:grid-cols-2 gap-4">
          {[
            {
              q: 'El token no empieza con shpat_',
              a: 'Te olvidaste de tildar "Usar flujo de instalación heredado" antes de publicar. Volvé al paso 5, tildá el checkbox, y publicá una versión nueva.',
            },
            {
              q: 'LabelFlow dice "Token rechazado por Shopify"',
              a: 'Casi siempre es un alcance que falta. Volvé al modal "Seleccionar alcances", tildá los 10 que están arriba en esta página, y volvé a publicar.',
            },
            {
              q: 'No veo el botón "Desarrollar apps en Dev Dashboard"',
              a: 'Tu cuenta no tiene permisos para crear apps. Pedile al Owner de la tienda que te asigne el permiso "Develop apps" en Configuración → Usuarios y permisos.',
            },
            {
              q: 'Shopify ya no me muestra el token',
              a: 'Es por diseño — solo lo muestra una vez. Creá una versión nueva de la app (botón "Nueva versión"), volvé a publicar y vas a ver un token nuevo.',
            },
          ].map((item) => (
            <div
              key={item.q}
              className="rounded-xl border border-white/[0.06] bg-white/[0.015] p-5"
            >
              <div className="text-sm font-semibold text-white">{item.q}</div>
              <div className="text-xs text-zinc-400 mt-2 leading-relaxed">
                {item.a}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/[0.05] mt-12">
        <div className="max-w-5xl mx-auto px-5 sm:px-8 py-8 flex flex-wrap gap-4 items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            Tu token se guarda cifrado con AES-256 y nunca se loguea en texto
            plano.
          </div>
          <div className="flex gap-3 items-center">
            <a
              href="https://shopify.dev/docs/api/admin"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-cyan-300 transition-colors"
            >
              Docs oficiales <ExternalLink className="w-3 h-3" />
            </a>
            <Link
              href="/onboarding"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-cyan-300 hover:text-cyan-200"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Volver y pegar el token
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

export const metadata = {
  title: 'Cómo generar tu token de Shopify · LabelFlow',
  description:
    'Tutorial paso a paso para crear un token Admin API de Shopify (shpat_) y conectarlo a LabelFlow. Con ilustraciones de cada pantalla y prompt para Claude Desktop en modo automático.',
};
