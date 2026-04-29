import type { ReactNode } from 'react';
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
  Terminal as TerminalIcon,
} from 'lucide-react';
import { CopyButton } from './_components/CopyButton';
import {
  Step01AdminHome,
  Step02SettingsSidebar,
  Step03AppsSection,
  Step04DevelopAppsLanding,
  Step05DevDashboardEmpty,
  Step06CreateAppForm,
  Step07VersionFormTop,
  Step08AccessoComplete,
  Step09ScopePicker,
  Step10PublishButton,
  Step10PublishModal,
  Step11VersionsPublished,
  Step12CredentialsTab,
} from './_components/Mocks';

/**
 * Public tutorial: how to obtain a Shopify Admin API token via the new
 * Dev Dashboard flow (2026 edition).
 *
 * Why this flow and not the old "paste shpat_ from the app config":
 *   Shopify deprecated the legacy "Apps personalizadas" UI for new stores.
 *   The Dev Dashboard does NOT have a "Mostrar token una vez" button — the
 *   only way to obtain a `shpat_*` is to complete an OAuth `authorization_code`
 *   exchange. We document that exchange via a tiny local Python server that
 *   intercepts the callback and trades the code for a token.
 *
 * Verified end-to-end on 2026-04-29 against the operator's KARBON store
 * (cfzf6b-dk.myshopify.com) — TWICE, with two independent apps in the same
 * Dev Dashboard. Both tokens (shpat_f7f2... and shpat_7004...) authenticated
 * against the live Admin API and granted all 10 scopes the LabelFlow worker
 * requires. The second run surfaced two real-world traps now documented:
 *   - Typo "callbac" (missing trailing "k") in the redirect_uri field →
 *     "Oauth error invalid_request: The redirect_uri is not whitelisted".
 *     Step 4 warning is now explicit about the trailing k.
 *   - Published versions are read-only. To change anything (a typo, a
 *     missing scope), open sidebar "Versiones" and click "Crear versión" —
 *     this opens a fresh editor pre-filled with the current config. Step 5
 *     and the troubleshooting list both call this out.
 *
 * If Shopify rolls a UI change:
 *   1. Re-run the flow against a real store.
 *   2. Re-take affected screenshots, redact, place in `public/tutorial/shopify/`.
 *   3. Update step copy here AND in `ShopifyTutorial.tsx` AND in the playbook
 *      at `13_Wiki/playbooks/playbook.shopify-api-token-setup.md`.
 *   4. Sync the scope list with `apps/web/app/api/v1/shopify-scopes/route.ts`.
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

const ALL_SCOPES_CSV = REQUIRED_SCOPES.map((s) => s.name).join(',');

const PYTHON_SERVER = `#!/usr/bin/env python3
"""Shopify OAuth Token Capturer — listens on localhost:3456"""
import http.server, urllib.parse, urllib.request, json, os

PORT = 3456
REDIRECT_URI = "http://localhost:3456/callback"

# 👇 PEGÁ TUS CREDENCIALES (Fase 6) — formato "client_id": "client_secret"
APPS = {
    "TU_CLIENT_ID_AQUI": "shpss_TU_CLIENT_SECRET_AQUI",
}

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(p.query)
        if p.path == "/callback" and "code" in q:
            code, shop = q["code"][0], q.get("shop", ["?"])[0]
            for cid, cs in APPS.items():
                try:
                    r = urllib.request.urlopen(urllib.request.Request(
                        f"https://{shop}/admin/oauth/access_token",
                        data=json.dumps({"client_id": cid, "client_secret": cs, "code": code}).encode(),
                        headers={"Content-Type": "application/json"}))
                    tok = json.loads(r.read()).get("access_token")
                    if tok:
                        out = os.path.expanduser("~/Desktop/shopify_tokens.json")
                        d = json.load(open(out)) if os.path.exists(out) else {}
                        d[shop] = tok
                        json.dump(d, open(out, "w"), indent=2)
                        self.send_response(200); self.send_header("Content-Type","text/html"); self.end_headers()
                        self.wfile.write(f"<h1 style='color:#0f0;background:#000;padding:40px;font-family:monospace'>✅ TOKEN: {tok}<br>SHOP: {shop}<br>Saved to ~/Desktop/shopify_tokens.json</h1>".encode())
                        print(f"\\n✅ {shop}\\n   {tok}\\n"); return
                except: continue
            self.send_response(500); self.end_headers()
            self.wfile.write(b"No matching app credentials")
        else:
            self.send_response(200); self.end_headers()
            self.wfile.write(b"Server up. Listening on port 3456.")
    def log_message(self, *a): pass

print(f"Listening on http://localhost:{PORT}")
http.server.HTTPServer(("localhost", PORT), H).serve_forever()
`;

const OAUTH_URL_TEMPLATE = `https://{TU_TIENDA}.myshopify.com/admin/oauth/authorize?client_id={CLIENT_ID}&scope=${ALL_SCOPES_CSV}&redirect_uri=http://localhost:3456/callback&state=labelflow`;

const CLAUDE_DESKTOP_PROMPT = `Sos un agente con acceso a Chrome MCP. Tu tarea es generar un token Admin API de Shopify para el comercio del usuario y entregárselo al final, listo para pegar en LabelFlow.

REGLAS CRÍTICAS
- Verificá visualmente cada paso antes de hacer clic. No alucines.
- Nunca compartas el Client Secret ni el token en logs públicos.
- Si una pantalla no coincide con esta guía, parate y avisá al usuario.

PRECONDICIÓN
- El usuario tiene sesión activa en https://shopify.dev/dashboard con la org de la tienda.
- Tiene Python 3 disponible (verificalo con \`python3 --version\` antes de seguir).

FLUJO COMPLETO

1) CREAR APP
   - Navegá a https://shopify.dev/dashboard
   - Click "Crear app" → "Empezar desde Dev Dashboard"
   - Nombre: "AutoEnvía" (sin espacios; tilde aceptada)
   - Click "Crear"

2) CONFIGURAR ACCESO
   En la sección "Acceso", pegá esta línea exacta en "Alcances":
   ${ALL_SCOPES_CSV}

3) CONFIGURAR URL
   - "URL de la app": https://example.com (placeholder)
   - "URLs de redireccionamiento": http://localhost:3456/callback
   - TILDÁ "Usar flujo de instalación heredado" — sin esto el OAuth falla

4) PUBLICAR
   - Click "Publicar" arriba a la derecha
   - En el modal: nombre "v1" (opcional) → click "Publicar" → esperá a que quede "Activa"

5) CAPTURAR CREDENCIALES
   - Sidebar app → "Configuración" → sección "Credenciales"
   - Copiá el "ID de cliente" (32 chars hex)
   - Click 👁️ junto al "Secreto" → copialo (empieza con shpss_)

6) ARMAR Y EJECUTAR EL SERVER LOCAL
   - Crear ~/Desktop/shopify_oauth.py con el script Python (ver tutorial)
   - Editar el dict APPS con: { "<CLIENT_ID>": "shpss_<CLIENT_SECRET>" }
   - Ejecutar: python3 ~/Desktop/shopify_oauth.py
   - Debe imprimir "Listening on http://localhost:3456"

7) DISPARAR OAUTH
   En una pestaña nueva del navegador (logueado en Shopify), pegá:
   https://<TU_SLUG>.myshopify.com/admin/oauth/authorize?client_id=<CLIENT_ID>&scope=${ALL_SCOPES_CSV}&redirect_uri=http://localhost:3456/callback&state=labelflow

   Reemplazá <TU_SLUG> con el slug del store (parte antes de .myshopify.com)
   y <CLIENT_ID> con el de paso 5.

8) APROBAR INSTALACIÓN
   - Aparece pantalla "Instalar app" con la lista de permisos
   - Click "Instalar" (botón verde abajo a la derecha)
   - Shopify redirige a localhost:3456/callback?code=...
   - El server intercepta, intercambia el code por token
   - Aparece página verde con "✅ TOKEN: shpat_..."

9) VERIFICAR
   El token queda guardado en ~/Desktop/shopify_tokens.json. Verificá scopes:
   curl -s -H "X-Shopify-Access-Token: shpat_..." \\
     "https://<SHOP>/admin/oauth/access_scopes.json"

10) ENTREGAR
   - Mostrá al usuario:
     - URL de tienda: <SLUG>.myshopify.com
     - Token: shpat_...
   - Recordá que debe pegarlo en /onboarding o /settings de LabelFlow
   - Sugerile rotar el Client Secret en Configuración (no afecta al token ya generado)

VALIDACIÓN
- El token DEBE empezar con "shpat_" (35-40 chars total).
- Si recibís cualquier otro formato, ALGO SALIÓ MAL. Lo más probable:
  • redirect_uri http://localhost:3456/callback no estaba registrado en la app
  • el checkbox "Usar flujo de instalación heredado" no estaba tildado
  • el server local no estaba corriendo cuando hiciste el OAuth flow`;

type Step = {
  n: number;
  title: string;
  body: ReactNode;
  visual: ReactNode;
  warn?: string;
};

const STEPS: Step[] = [
  {
    n: 1,
    title: 'Entrá al Dev Dashboard de Shopify',
    body: (
      <>
        Abrí{' '}
        <code className="text-cyan-300 bg-black/40 px-1.5 py-0.5 rounded text-xs font-mono">
          shopify.dev/dashboard
        </code>{' '}
        y logueate con la cuenta Shopify de tu tienda. Si tu cuenta tiene
        varias organizaciones, asegurate de elegir la que contiene la tienda
        para la que vas a generar el token (selector arriba a la derecha).
      </>
    ),
    visual: <Step05DevDashboardEmpty className="w-full h-auto" />,
  },
  {
    n: 2,
    title: 'Crear una app nueva',
    body: (
      <>
        Hacé clic en el botón{' '}
        <span className="text-zinc-100 font-semibold">Crear app</span>{' '}
        (esquina superior derecha). En la pantalla siguiente, elegí{' '}
        <span className="text-zinc-100 font-semibold">
          Empezar desde Dev Dashboard
        </span>{' '}
        (NO la opción de Shopify CLI — esa es para devs con{' '}
        <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
          npm
        </code>
        ).
      </>
    ),
    visual: <Step06CreateAppForm className="w-full h-auto" />,
    warn:
      'Nombre de la app: solo letras, números, puntos, guiones y underscore. Sugerimos "AutoEnvía". NO uses espacios — Shopify los rechaza.',
  },
  {
    n: 3,
    title: 'Pegar los 10 alcances en el campo "Alcances"',
    body: (
      <>
        En el editor de la primera versión, scrolleá a la sección{' '}
        <span className="text-zinc-100 font-semibold">Acceso</span>. En el
        campo <span className="text-zinc-100 font-semibold">Alcances</span>{' '}
        (NO "Alcances opcionales") pegá los 10 separados por comas. Usá el
        botón "Copiar los 10 alcances" del bloque amarillo arriba.
      </>
    ),
    visual: <Step08AccessoComplete className="w-full h-auto" />,
    warn:
      'Si abrís el modal "Seleccionar alcances" en lugar de pegar directo, OJO: la lista está virtualizada — los scopes que no entran en el viewport quedan SIN tildar aunque clickees "Listo". Mejor pegar el CSV directo.',
  },
  {
    n: 4,
    title: 'Configurar la URL de redirección y publicar',
    body: (
      <>
        Más abajo en el form:
        <ol className="mt-3 space-y-2 text-zinc-300 list-decimal pl-5">
          <li>
            Campo{' '}
            <span className="text-zinc-100 font-semibold">URL de la app</span>:
            dejá{' '}
            <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
              https://example.com
            </code>{' '}
            (es un placeholder que Shopify exige pero no usamos).
          </li>
          <li>
            Campo{' '}
            <span className="text-zinc-100 font-semibold">
              URLs de redireccionamiento
            </span>
            : escribí{' '}
            <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
              http://localhost:3456/callback
            </code>
            .
          </li>
          <li>
            <span className="text-amber-300 font-semibold">
              TILDÁ el checkbox{' '}
              <em>"Usar flujo de instalación heredado"</em>
            </span>{' '}
            (sin esto el OAuth falla con HTTP 500).
          </li>
        </ol>
      </>
    ),
    visual: <Step10PublishButton className="w-full h-auto" />,
    warn:
      'El "redirect_uri" tiene que coincidir BYTE-A-BYTE con el del server Python. Errores reales que vimos en producción: (a) typo "callbac" sin la "k" final → falla con "Oauth error invalid_request: The redirect_uri is not whitelisted"; (b) "127.0.0.1" en lugar de "localhost" → no matchea; (c) espacios pegados o slash final extra. El valor correcto exacto es: http://localhost:3456/callback (con "k" al final, sin slash). Triple-checkeá antes de Publicar.',
  },
  {
    n: 5,
    title: 'Publicar la versión',
    body: (
      <>
        Click <span className="text-zinc-100 font-semibold">Publicar</span>{' '}
        (arriba a la derecha del editor). Aparece un modal{' '}
        <em>"¿Publicar esta versión nueva?"</em> con campos opcionales (Nombre,
        Mensaje). Podés ponerle{' '}
        <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
          v1
        </code>{' '}
        en Nombre o dejarlo vacío. Click{' '}
        <span className="text-zinc-100 font-semibold">Publicar</span> en el
        modal y esperá ~5 segundos. La versión queda con badge verde{' '}
        <span className="text-emerald-300 font-semibold">Activa</span>.
      </>
    ),
    visual: <Step10PublishModal className="w-full h-auto" />,
    warn:
      'Una vez publicada, la versión queda READ-ONLY. Si después necesitás cambiar algo (alcances, redirect_uri, checkbox), NO podés editar la actual — click sidebar "Versiones" → botón "Crear versión" (te abre un editor pre-cargado con la config actual). Modificás lo que haga falta → "Publicar". La nueva queda Activa, la vieja pasa a histórico. Nadie pierde tokens en el medio.',
  },
  {
    n: 6,
    title: 'Capturar Client ID + Client Secret',
    body: (
      <>
        En el sidebar de la app, click{' '}
        <span className="text-zinc-100 font-semibold">Configuración</span>{' '}
        (último ítem, debajo de "Versiones"). En la sección{' '}
        <span className="text-zinc-100 font-semibold">Credenciales</span>:
        <ol className="mt-3 space-y-2 text-zinc-300 list-decimal pl-5">
          <li>
            Copiá el{' '}
            <span className="text-zinc-100 font-semibold">ID de cliente</span>{' '}
            (32 caracteres hex, ej:{' '}
            <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
              29116d0f...62f0
            </code>
            ).
          </li>
          <li>
            Click el icono 👁️ junto a{' '}
            <span className="text-zinc-100 font-semibold">Secreto</span> para
            revelarlo. Copialo (empieza con{' '}
            <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
              shpss_
            </code>
            ).
          </li>
        </ol>
        Tenelos a mano para el paso siguiente.
      </>
    ),
    visual: <Step12CredentialsTab className="w-full h-auto" />,
    warn:
      'NO compartas el Client Secret. Si por error lo pegás en algún lado, rotarlo desde el botón "Rotar" de esa misma sección lo invalida (los tokens shpat_ ya generados siguen funcionando — la rotación solo afecta nuevos OAuth flows).',
  },
  {
    n: 7,
    title: 'Crear y ejecutar el server OAuth local',
    body: (
      <>
        Creá el archivo{' '}
        <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
          ~/Desktop/shopify_oauth.py
        </code>{' '}
        con el script de abajo (botón "Copiar script" a la derecha).
        <br />
        <br />
        Editá la sección{' '}
        <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
          APPS
        </code>{' '}
        reemplazando los placeholders con el Client ID y Client Secret de tu
        app (paso 6). Ejecutá:
        <pre className="mt-3 rounded-lg bg-black/70 border border-white/[0.06] p-3 text-xs text-zinc-300 font-mono overflow-x-auto">
          python3 ~/Desktop/shopify_oauth.py
        </pre>
        Debe imprimir{' '}
        <code className="text-emerald-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
          Listening on http://localhost:3456
        </code>
        . <span className="text-zinc-400">Dejalo corriendo en esa terminal.</span>
      </>
    ),
    visual: (
      <div className="w-full h-auto p-4 sm:p-6 bg-black/60 border border-white/[0.06] rounded-lg">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide font-semibold text-emerald-300">
            <TerminalIcon className="w-3.5 h-3.5" />
            shopify_oauth.py
          </div>
          <CopyButton
            value={PYTHON_SERVER}
            label="Copiar script"
            ariaLabel="Copiar el script Python al portapapeles"
            variant="small"
          />
        </div>
        <pre className="rounded-md bg-black/80 p-3 text-[10.5px] leading-relaxed text-zinc-300 font-mono overflow-x-auto max-h-[420px]">
          {PYTHON_SERVER}
        </pre>
      </div>
    ),
    warn:
      'Si dice "Address already in use", matá el server previo: lsof -ti:3456 | xargs kill -9 y reintentá.',
  },
  {
    n: 8,
    title: 'Disparar el flujo OAuth',
    body: (
      <>
        En una pestaña nueva del navegador (donde estás logueado en Shopify),
        pegá esta URL reemplazando los placeholders:
        <pre className="mt-3 rounded-lg bg-black/70 border border-white/[0.06] p-3 text-[10.5px] leading-relaxed text-zinc-300 font-mono overflow-x-auto whitespace-pre-wrap break-all">
          {OAUTH_URL_TEMPLATE}
        </pre>
        <ul className="mt-3 space-y-1 text-zinc-300 text-sm list-disc pl-5">
          <li>
            <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
              {'{TU_TIENDA}'}
            </code>{' '}
            → el slug myshopify (parte antes de{' '}
            <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
              .myshopify.com
            </code>
            ).
          </li>
          <li>
            <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
              {'{CLIENT_ID}'}
            </code>{' '}
            → el ID de cliente del paso 6.
          </li>
        </ul>
      </>
    ),
    visual: <Step07VersionFormTop className="w-full h-auto" />,
  },
  {
    n: 9,
    title: 'Aprobar la instalación',
    body: (
      <>
        Shopify te muestra una pantalla{' '}
        <span className="text-zinc-100 font-semibold">Instalar app</span> con:
        <ul className="mt-3 space-y-1 text-zinc-300 text-sm list-disc pl-5">
          <li>
            Aviso amarillo "Esta app aún no se ha revisado" (es esperable —
            las apps personalizadas no pasan por el App Store).
          </li>
          <li>
            Lista de permisos que pediste (los 10 scopes traducidos por
            Shopify a categorías como "Ver y editar datos de la tienda").
          </li>
          <li>
            Botón verde{' '}
            <span className="text-zinc-100 font-semibold">Instalar</span> abajo
            a la derecha.
          </li>
        </ul>
        Click <span className="text-zinc-100 font-semibold">Instalar</span>.
        Shopify redirige a{' '}
        <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
          localhost:3456/callback?code=...
        </code>
        . Tu server intercepta el código, lo intercambia por el token y muestra
        una página verde con{' '}
        <code className="text-emerald-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
          ✅ TOKEN: shpat_...
        </code>
        .
      </>
    ),
    visual: <Step09ScopePicker className="w-full h-auto" />,
    warn:
      'Si te aparece "Oauth error invalid_request: The redirect_uri is not whitelisted" (pantalla blanca con ícono de Shopify): el redirect_uri no está registrado o tiene un typo. Causa #1 vista en producción: faltaba la "k" final de "callback". Volvé al Dev Dashboard → sidebar "Versiones" → "Crear versión" → corregí el campo "URLs de redireccionamiento" a exactamente "http://localhost:3456/callback" → Publicá → reintentá el paso 8.',
  },
  {
    n: 10,
    title: 'Verificar el token',
    body: (
      <>
        El token quedó guardado en{' '}
        <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
          ~/Desktop/shopify_tokens.json
        </code>
        . Antes de pegarlo en LabelFlow, confirmá que tiene los 10 scopes:
        <pre className="mt-3 rounded-lg bg-black/70 border border-white/[0.06] p-3 text-[10.5px] leading-relaxed text-zinc-300 font-mono overflow-x-auto whitespace-pre-wrap">
{`TOKEN="shpat_TU_TOKEN"
DOMAIN="xxxxxx-xx.myshopify.com"
curl -s -H "X-Shopify-Access-Token: $TOKEN" \\
  "https://$DOMAIN/admin/oauth/access_scopes.json" | \\
  python3 -c "import sys,json; print(sorted(s['handle'] for s in json.load(sys.stdin)['access_scopes']))"`}
        </pre>
        Esperás ver los 10 scopes listados. Si falta alguno, volvé al paso 3
        y verificá el campo Alcances.
      </>
    ),
    visual: <Step11VersionsPublished className="w-full h-auto" />,
  },
  {
    n: 11,
    title: 'Pegar el token en LabelFlow',
    body: (
      <>
        Volvé al onboarding (o a Configuración → Shopify) de LabelFlow:
        <ul className="mt-3 space-y-1 text-zinc-300 text-sm list-disc pl-5">
          <li>
            <span className="text-zinc-100 font-semibold">URL de tienda</span>:{' '}
            <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
              xxxxxx-xx.myshopify.com
            </code>{' '}
            (sin{' '}
            <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
              https://
            </code>
            ).
          </li>
          <li>
            <span className="text-zinc-100 font-semibold">Token</span>:{' '}
            <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
              shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
            </code>
          </li>
        </ul>
        Click <span className="text-zinc-100 font-semibold">Verificar</span>.
        LabelFlow valida contra Shopify y guarda el token cifrado AES-256.
        ¡Listo!
      </>
    ),
    visual: (
      <div className="w-full h-auto p-6 bg-gradient-to-br from-emerald-500/10 to-transparent border border-emerald-500/20 rounded-lg flex items-center justify-center min-h-[300px]">
        <div className="text-center">
          <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto" />
          <div className="mt-4 text-lg font-semibold text-white">
            Tienda conectada
          </div>
          <div className="mt-2 text-xs text-zinc-400 max-w-xs">
            Tu token queda cifrado en LabelFlow con AES-256. El worker empieza
            a procesar pedidos automáticamente.
          </div>
        </div>
      </div>
    ),
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
            Verificado end-to-end · 29 abr 2026
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-5xl mx-auto px-5 sm:px-8 pt-12 pb-10">
        <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-wide font-semibold text-cyan-300 bg-cyan-500/10 border border-cyan-500/20 rounded-full px-3 py-1">
          <Sparkles className="w-3 h-3" />
          Tutorial Shopify · Dev Dashboard 2026
        </div>
        <h1 className="mt-4 text-3xl sm:text-4xl font-bold text-white leading-tight">
          Cómo generar tu token Admin API de Shopify
        </h1>
        <p className="mt-4 text-base text-zinc-400 leading-relaxed max-w-3xl">
          LabelFlow usa el Admin API de Shopify para leer tus pedidos y crear
          fulfillments con el número de guía DAC. Para eso necesitás un token{' '}
          <code className="text-cyan-300 bg-black/40 px-1.5 py-0.5 rounded text-sm font-mono">
            shpat_*
          </code>
          . Shopify rediseñó el flujo para tiendas nuevas — el botón viejo
          "Mostrar token una vez" ya no existe. La forma actual: completar un
          OAuth standard local con un mini server Python que captura el token.
          Toma{' '}
          <span className="text-zinc-200 font-semibold">~6 minutos</span>.
        </p>

        {/* Three pills */}
        <div className="grid sm:grid-cols-3 gap-3 mt-8">
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <Zap className="w-5 h-5 text-cyan-400" />
            <div className="text-sm font-semibold text-white mt-2">
              ~6 minutos
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
              Mínimos necesarios para que LabelFlow funcione. Nada más.
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <ShieldCheck className="w-5 h-5 text-cyan-400" />
            <div className="text-sm font-semibold text-white mt-2">
              Token permanente
            </div>
            <div className="text-xs text-zinc-500 mt-1">
              No expira. Se invalida si borrás la app del Dev Dashboard.
            </div>
          </div>
        </div>
      </section>

      {/* Pre-requisites */}
      <section className="max-w-5xl mx-auto px-5 sm:px-8 pb-10">
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <h2 className="text-base font-semibold text-amber-100">
                Antes de empezar — pre-requisitos
              </h2>
              <ul className="mt-3 space-y-1.5 text-sm text-zinc-300">
                <li>
                  Cuenta Shopify con permiso de{' '}
                  <span className="text-zinc-100 font-medium">Owner</span> o{' '}
                  <span className="text-zinc-100 font-medium">
                    Staff con acceso a Apps
                  </span>{' '}
                  en la tienda.
                </li>
                <li>
                  Mac o Linux con Python 3 (
                  <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
                    python3 --version
                  </code>{' '}
                  debe responder).
                </li>
                <li>
                  El dominio{' '}
                  <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
                    .myshopify.com
                  </code>{' '}
                  de tu tienda (formato:{' '}
                  <code className="text-cyan-300 bg-black/40 px-1 py-0.5 rounded text-xs font-mono">
                    xxxxxx-xx.myshopify.com
                  </code>
                  ).
                </li>
                <li>
                  Una terminal con permiso para correr scripts locales (Mac:
                  Terminal.app o iTerm).
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Claude Desktop prompt */}
      <section className="max-w-5xl mx-auto px-5 sm:px-8 pb-10">
        <div className="rounded-2xl border border-violet-500/25 bg-gradient-to-br from-violet-500/[0.08] via-violet-500/[0.03] to-transparent p-6 sm:p-8 shadow-lg shadow-violet-500/5">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-wider font-bold text-violet-300">
                <Sparkles className="w-3 h-3" />
                Modo automático · Recomendado para devs
              </div>
              <h2 className="text-xl sm:text-2xl font-semibold text-white mt-1.5">
                ¿Querés que Claude Desktop lo haga por vos?
              </h2>
              <p className="text-sm text-zinc-400 mt-2 max-w-3xl leading-relaxed">
                Si tenés{' '}
                <span className="text-zinc-200 font-medium">Claude Desktop</span>{' '}
                con la extensión de Chrome instalada, copiá este prompt y pegalo
                en una conversación nueva. Claude va a abrir tu Shopify, crear
                la app, configurar los 10 alcances + redirect_uri, publicar,
                arrancar el server local y entregarte el token al final.
              </p>
            </div>
            <CopyButton
              value={CLAUDE_DESKTOP_PROMPT}
              label="Copiar prompt"
              ariaLabel="Copiar el prompt de Claude Desktop al portapapeles"
              variant="pill"
            />
          </div>
          <pre className="mt-5 rounded-xl bg-black/70 border border-white/[0.06] p-4 sm:p-5 text-[11.5px] text-zinc-300 font-mono leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-[420px]">
            {CLAUDE_DESKTOP_PROMPT}
          </pre>
          <div className="mt-4 flex items-start gap-2 text-[11px] text-zinc-500 leading-relaxed">
            <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              Requiere Claude Desktop + extensión Chrome MCP activa, sesión
              iniciada en{' '}
              <code className="text-zinc-400 font-mono">shopify.dev/dashboard</code>
              {' '}y Python 3 disponible.{' '}
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
                Copialos como CSV y pegalos directo en el campo "Alcances" del
                Dev Dashboard (paso 3). Es más rápido que el modal.
              </p>
            </div>
            <CopyButton
              value={ALL_SCOPES_CSV}
              label="Copiar los 10 alcances (CSV)"
              ariaLabel="Copiar los 10 alcances separados por comas al portapapeles"
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
          Cada captura fue tomada el 29 de abril de 2026 contra una tienda
          Shopify real (datos sensibles tachados). Si Shopify cambia algo del
          UI, el flujo lógico sigue siendo el mismo — solo cambia el lugar de
          algún botón.
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
                  <div className="text-sm text-zinc-400 leading-relaxed mt-3">
                    {step.body}
                  </div>
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
                  {step.visual}
                </div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Troubleshooting */}
      <section className="max-w-5xl mx-auto px-5 sm:px-8 pb-16">
        <h2 className="text-2xl font-bold text-white mb-6">Si algo falla</h2>
        <div className="grid md:grid-cols-2 gap-4">
          {[
            {
              q: '"Oauth error invalid_request: The redirect_uri is not whitelisted" (paso 8)',
              a: 'El redirect_uri pedido no coincide con ninguno registrado en la app. Causa #1 real: typo "callbac" sin la "k" final. Sidebar "Versiones" → "Crear versión" → corregí el campo a exactamente "http://localhost:3456/callback" → Publicá → reintentá el paso 8.',
            },
            {
              q: 'No me deja editar la versión publicada',
              a: 'Las versiones publicadas son read-only por diseño. Sidebar "Versiones" → botón "Crear versión" — te abre un editor pre-cargado con la config actual. Modificás lo que necesites y "Publicás". La vieja pasa a histórico, la nueva queda Activa.',
            },
            {
              q: '"Address already in use" al correr el server (paso 7)',
              a: 'Hay un server previo escuchando en el puerto 3456. Matalo con: lsof -ti:3456 | xargs kill -9 — después reintentá python3 ~/Desktop/shopify_oauth.py.',
            },
            {
              q: 'El token NO empieza con shpat_',
              a: 'El intercambio falló. Verificá que el dict APPS del script Python tenga el par correcto Client ID + Secret (sin espacios al copiar). Si rotaste el secret después de copiar, regeneralo y volvé a editar el script.',
            },
            {
              q: 'LabelFlow dice "Token rechazado por Shopify"',
              a: 'Casi siempre falta algún scope. Corré el curl de verificación del paso 10 y compará contra los 10 que LabelFlow requiere. Si falta alguno, pegá el CSV completo en el paso 3, creá una versión nueva, y publicá.',
            },
            {
              q: 'Tengo varios tokens generados para la misma tienda',
              a: 'Pasa cuando creás varias apps en el Dev Dashboard. Todos los tokens generados siguen siendo válidos hasta que desinstales/elimines la app que los emitió. Pegá en LabelFlow el último que generaste; si querés limpiar los viejos, eliminá las apps no usadas en el Dev Dashboard.',
            },
            {
              q: 'El selector de tiendas en Shopify aparece vacío',
              a: 'Tu cuenta no está en la organización correcta del Dev Dashboard. Cambiá de org desde el selector arriba a la derecha y reintentá desde el paso 1.',
            },
            {
              q: 'No tengo permiso para crear apps',
              a: 'Pedile al Owner de la tienda Shopify que te asigne el permiso "Develop apps" en Settings → Users and permissions, o que cree el token él directamente.',
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
              href="https://shopify.dev/docs/api/usage/authentication"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-cyan-300 transition-colors"
            >
              Docs OAuth oficiales <ExternalLink className="w-3 h-3" />
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
    'Tutorial paso a paso para obtener un token Admin API de Shopify (shpat_) usando el flujo nuevo del Dev Dashboard 2026. Con capturas reales y prompt para Claude Desktop.',
};
