# Self-serve v1 — spec cerrada (rama `feat/selfserve-v1`)

> 2026-09-02 · base `origin/main` = `4203850` (Merge PR #10 shopify-expiring-tokens).
> Decisiones de Adrian: D30–D34 en `docs/DECISIONES.md`. No se discuten; acá se
> traducen a archivos, endpoints, textos y tests.
>
> Todo lo que sigue se re-derivó leyendo el código de `main` en el worktree
> (`/Users/Work/proyectos/_wt-labelflow-selfserve`). Las referencias `archivo:línea`
> son de ese commit. Donde algo NO se pudo verificar se dice en voz alta.

## 0. Reglas que no se negocian

- Repo canónico intocable; se trabaja sólo en el worktree.
- `apps/worker/src/dac/shipment.ts` no se toca. `schema.prisma` no se toca. Cero migraciones:
  todo va sobre columnas existentes. Lo que pida columna nueva va a §12 con el SQL propuesto.
- Nada de `sudo` / `rm -rf` / `killall` / `pkill`. Nunca imprimir `.env*`. Nunca loguear tokens.
- Gates por área (última línea de cada uno al reporte):
  - `npx tsc --noEmit -p apps/web` → exit 0
  - `<worktree>/node_modules/.bin/vitest run --root apps/web` (baseline: tomar la cifra real en la
    primera corrida; conté 35 archivos `lib/__tests__/*.test.ts`; los 3 `.mjs` no corren en vitest)
  - `cd apps/web && NODE_OPTIONS=--max-old-space-size=2048 npx next build` al final de cada área
  - El worker **no se toca** en esta spec (verificado: todo lo que hace falta ya existe del lado
    del worker). Si igual se toca, gate worker: tsc + vitest (68 archivos / 2805+).
- Commits atómicos en español (el POR QUÉ), push sólo de `feat/selfserve-v1`. Cada área termina con push.
- UI: español rioplatense, voseo, tildes, **sin emojis**, un solo acento cyan, tarjetas glass,
  componentes que ya existen (`glass`, `inputClass`, `labelClass`, lucide, `cn()`).

## 1. Hechos verificados que cambian el diseño (léase antes de tocar nada)

| # | Hecho | Dónde | Consecuencia |
|---|---|---|---|
| H1 | El default `shipmentCredits @default(10)` es lo que regala hoy los créditos en 4 altas; ninguna pasa el valor explícito. | `schema.prisma` Tenant (`shipmentCredits Int @default(10)`), `signup/route.ts:263-295`, `lib/auth.ts:359-372` y `383-412`, `lib/shopify-provision.ts:189-207`, `provisioning/dac-tenant/route.ts:160-170` | D31: setear `TRIAL_SHIPMENTS` explícito en los creates de cuenta nueva. |
| H2 | `REFEREE_BONUS_CREDITS = 10` está duplicado (`signup/route.ts:252`, `lib/auth.ts:17`) y el copy "10 envíos gratis" está en 7 archivos (lista en §3.4). | grep | Un solo módulo de constantes; copy derivado de la constante. |
| H3 | El gate del dashboard exige Shopify **y** DAC (`(dashboard)/layout.tsx:90-96`) y `onboarding/complete` rechaza sin Shopify (`complete/route.ts:55`). La fuente "AutoEnvía Dashboard" (Excel) no cuenta como conexión. El worker sí la soporta (`scheduler.ts:361-408`). | | Definir "tienda conectada" = Shopify **o** Dashboard en un solo helper y usarlo en los dos lugares. |
| H4 | `(dashboard)/layout.tsx:105-113` "backfillea" `onboardingComplete=true` sin prender `isActive`. Con el wizard obligatorio (D33) eso dejaría cuentas nuevas "completas" pero inactivas para siempre. | | Backfill sólo si `isActive` ya es true (legacy); si no, al wizard. |
| H5 | `POST /api/v1/jobs/test-dac` es **sólo del tenant admin** (`ADMIN_TENANT_ID` hardcodeado, `jobs/test-dac/route.ts:7-15`). El único "test" de DAC disponible para un usuario es `POST /api/v1/onboarding/test-dac`, que **no verifica contra DAC** (formato + cifrado). | | El paso 3 no puede prometer verificación en vivo. Copy honesto: "lo confirmamos en tu primer envío". |
| H6 | REMITENTE **no se carga automático**: el worker deja una nota en el pedido de Shopify y marca el Label NEEDS_REVIEW (`process-orders.job.ts:852-865`). `determinePaymentType` con umbral ≤ 0 devuelve DESTINATARIO (`rules/payment.ts:42-45`), así que "siempre paga la tienda" no existe. | | Copy de "quién paga el envío" tiene que decirlo. No ofrecer "siempre remitente". |
| H7 | Contrareembolso **existe en main**: `Tenant.codEnabled`, `Label.codAmount`, `planDeCod`/`TipoGuia` en `shipment.ts` (11 referencias), `process-orders.job.ts:808-810`. Pero `codEnabled` no está en `updateSchema` ni en el GET de `/api/v1/settings` ni en ninguna UI. El SQL `scripts/sql/cod-contrarreembolso.sql` dice "NO APLICADO" (01/09). | | Exponerlo como toggle (columna existente). Precondición de deploy: verificar la columna en prod (§12). |
| H8 | `cronSchedule` acepta `0 * * * *` (`settings/route.ts:32-40`: el mínimo 15 sólo aplica a `*/N`). El scheduler evalúa los 5 campos con TZ del tenant (`scheduler.ts:48-70`). La UI de "Programación automática" **deriva** el cron de los slots (`settings/page.tsx:207-214`) y sin slots escribe `0 0 31 2 *` (nunca). | | El "modo" del paso 5 escribe `cronSchedule` directo. Los slots quedan como función de admin. |
| H9 | Webhook `orders/paid` exige `Tenant.isActive` (`webhooks/shopify/route.ts:49-55`) y se registra sólo en OAuth/claim (`callback/route.ts:234`, `:274`). Token manual = sin webhook. | | "Inmediato" es honesto sólo para tiendas conectadas con el botón; el cron de 15 min cubre el resto. |
| H10 | El scheduler crea el job de Excel con `type: 'PROCESS_DASHBOARD_ORDERS'` directo en DB (`scheduler.ts:403-405`) y el poller del worker lo rutea por tipo (`worker/src/index.ts:153-155`), sin filtrar por trigger. `POST /api/v1/jobs` sólo encola `PROCESS_ORDERS` (`lib/queue.ts:9-21`). | | "Procesar ahora" para tenants Excel = mismo endpoint, tipo distinto, sin tocar el worker. |
| H11 | No existe función exportada de acreditación: MP acredita inline (`webhooks/mercadopago/route.ts:373-380`) y el kickback está en el mismo archivo (`:456-530`). `CreditPurchase.mpPaymentId` y `mpExternalRef` son `@unique`. | | Extraer a `lib/credit-accrual.ts`; Whop reutiliza las columnas con prefijo `whop:` / `whop|`. |
| H12 | `apps/web/lib/admin.ts` ya tiene `ADMIN_EMAILS` (fallback `ADMIN_EMAIL`), `getAdminSession()` hace una query a `User`. `(dashboard)/layout.tsx` ya trae `tenant.user.email`. | | `isAdminEmail(email)` puro, sin query extra en el layout. |
| H13 | `/api/v1/control/overview` lista los tenants del **user logueado** (`control/overview/route.ts:38-44`). "Control de Adrian" = sus propios tenants; métricas globales están en `/admin`. | | Alcance: no se amplía Control. Se agrega `/admin` al menú de admin. |
| H14 | La rama B del callback OAuth vuelve siempre a `/settings?shopify=connected` (`callback/route.ts:276`). | | `install` acepta `next` (validado con `safeRelativePath`) para volver al wizard. |
| H15 | El cliente del dashboard (worker) hace `GET {url}/api/v1/orders?status=confirmed&limit=N` con `Authorization: Bearer <token>` (`worker/src/dashboard/orders.ts:43-56`). | | Se puede probar la conexión Excel desde la web con `limit=1`, igual que `test-shopify`. |
| H16 | El referido recibe `referralBonusCredits` (pool aparte) y el TopBar linkea a `/settings/referrals` cuando hay bonus (`TopBar.tsx:98-116`). | | `/settings/referrals` no va al menú del usuario, pero sigue accesible. |

## 2. Mapa de áreas, orden y commits

| Área | Qué | Commit sugerido (uno o más) |
|---|---|---|
| A | `TRIAL_SHIPMENTS = 5` y altas (D31) | `feat(creditos): 5 envíos de prueba por cuenta, explícitos en cada alta (D31)` |
| B | Roles, menú y gates por rol (D32) | `feat(roles): menú y páginas por rol con ADMIN_EMAILS (D32)` |
| C | Onboarding derivado de datos, 6 pasos (D33) | `feat(onboarding): wizard obligatorio con estado derivado de la base (D33)` |
| D | Parámetros: Configuración reorganizada + `codEnabled` + modo de procesamiento | `feat(config): parámetros explicados, modo de procesamiento y contrareembolso (D33)` |
| E | Compra: acreditación compartida, selector de volumen, Whop (D34) | `refactor(pagos): acreditación de packs en lib compartida` · `feat(pagos): selector de volumen y Whop (D34)` |
| F | Dashboard por rol (D32) | `feat(dashboard): vista de usuario con saldo y procesar ahora (D32)` |

Orden: A → B → C → D → E → F. C y D se pueden hacer juntas (D es el paso 4 de C). Cada área: gates + push.
Además, en el primer commit: `docs: D30–D34` ya están en `DECISIONES.md` (este commit).

---

## 3. Área A — `TRIAL_SHIPMENTS` y altas (D31)

### 3.1 Archivo nuevo `apps/web/lib/trial.ts`

```ts
/** Envíos gratis por CUENTA nueva (D31). Se acreditan una sola vez al tenant holder
 *  (el primero del user). NO es el default del schema (que sigue en 10 y no se toca):
 *  por eso cada create de cuenta nueva lo pasa explícito. */
export const TRIAL_SHIPMENTS = 5;
/** Bono extra por entrar con link de referido (pool `referralBonusCredits`, aparte).
 *  Movido de signup/route.ts y lib/auth.ts sin cambiar el valor. D31 no lo toca. */
export const REFEREE_BONUS_CREDITS = 10;
```

### 3.2 Dónde se setea `shipmentCredits: TRIAL_SHIPMENTS` (y dónde NO)

| Alta | Archivo:líneas | Acción |
|---|---|---|
| Signup público (email) | `app/api/auth/signup/route.ts:263-295` (`tenants.create[0]`) | agregar `shipmentCredits: TRIAL_SHIPMENTS`; reemplazar la const local `REFEREE_BONUS_CREDITS` (L252) por el import |
| Google OAuth, user nuevo | `lib/auth.ts:383-412` | agregar `shipmentCredits: TRIAL_SHIPMENTS`; borrar L17 y usar el import |
| Google OAuth, user huérfano sin tenant | `lib/auth.ts:359-372` | ídem (es su primer tenant → holder) |
| App Store `created` | `lib/shopify-provision.ts:189-207` | agregar `shipmentCredits: TRIAL_SHIPMENTS` en el tenant anidado. Sólo en `created`: `existing` (L175-179) refresca token, `claim` no crea, `conflict` no crea |
| Reclamo (`/api/shopify/claim`) | `claim/route.ts:207-223` | **sin cambio**: ya es `0` |
| Tienda adicional (`POST /api/v1/tenants`) | `tenants/route.ts:106-114` | **sin cambio**: ya es `0` |
| Provisioning admin (`/api/provisioning/dac-tenant`) | `dac-tenant/route.ts:160-170` | **sin cambio** (queda en el default 10): es un alta manual de Adrian para clientes AutoEnvía, fuera de D31. Anotado en §12. |

Dominio ya vinculado a otro tenant: `provisionFromShopify` devuelve `conflict` (L169-174) y `claim` devuelve `conflict`/`already_yours` (L200-204) sin crear nada → "nunca acredita" ya se cumple; el test lo fija (§3.5).

### 3.3 Limpieza de constantes

- `lib/credit-packs.ts:99-104`: borrar `WELCOME_BONUS_SHIPMENTS` (grep: nadie lo importa) y actualizar el comentario de cabecera (L8-9) a "ver lib/trial.ts". `label: '10 envíos'` del pack se queda (es el pack, no el trial).

### 3.4 Copy que dice "10" y pasa a `TRIAL_SHIPMENTS`

| Archivo:línea | Texto hoy | Texto nuevo |
|---|---|---|
| `app/(auth)/signup/page.tsx:21` (metadata) | "Sin tarjeta: 10 envíos de regalo para empezar." | "Sin tarjeta: 5 envíos de regalo para empezar." (metadata es string estático; escribir el número y dejar comentario `// = TRIAL_SHIPMENTS`) |
| `app/(auth)/signup/SignupForm.tsx:170` y `:346` | "10 envíos gratis para empezar" / "10 envíos gratis" | `{TRIAL_SHIPMENTS} envíos gratis para empezar` / `{TRIAL_SHIPMENTS} envíos gratis` |
| `SignupForm.tsx:180` | "+10 envíos extra" (referido) | `+{REFEREE_BONUS_CREDITS} envíos extra` (mismo valor) |
| `app/onboarding/page.tsx:549-553` | "10 envíos gratis" | se reescribe entero en el paso 6 (§5.8) |
| `components/onboarding/AhaMomentModal.tsx:81` | "10 envíos gratis" | `{TRIAL_SHIPMENTS} envíos gratis` |
| `app/(dashboard)/settings/referrals/page.tsx:58` y `:213` | "Te regalan 10 envíos gratis…" / "encima de los 10 universales = 20 totales" | `Te regalan ${TRIAL_SHIPMENTS} envíos gratis…` / `encima de los ${TRIAL_SHIPMENTS} universales = ${TRIAL_SHIPMENTS + REFEREE_BONUS_CREDITS} totales` |
| `SignupForm.tsx:22` (comentario) | "el bono de 10 envíos coincide con el default" | "el bono sale de lib/trial.ts (5); el default del schema (10) ya no rige" |

### 3.5 Tests (área A)

- `lib/__tests__/trial.test.ts` (nuevo): `TRIAL_SHIPMENTS === 5`; `REFEREE_BONUS_CREDITS === 10`; y un test que lee `apps/web/prisma/schema.prisma` y afirma que el default sigue en 10 **y** que es distinto de `TRIAL_SHIPMENTS` (documenta que el explícito es obligatorio).
- `lib/__tests__/signup-route.test.ts`: en el caso feliz, `user.create.mock.calls[0][0].data.tenants.create[0].shipmentCredits === 5`; en el de referido, además `referralBonusCredits === 10`.
- `lib/__tests__/shopify-provision.test.ts`: en `created`, el tenant anidado lleva `shipmentCredits: 5`; en `existing`/`claim`/`conflict` no hay `create` de tenant.
- `lib/__tests__/shopify-claim-route.test.ts`: ya fija `shipmentCredits: 0` (L380) — no cambia.
- Google OAuth (`lib/auth.ts`): no hay harness de NextAuth en la suite; se cubre con un test de "greppeo estructural" mínimo: `auth.ts` contiene `shipmentCredits: TRIAL_SHIPMENTS` exactamente 2 veces. (Es débil, pero mejor que nada; decirlo en el reporte.)

---

## 4. Área B — Roles y menú (D32)

### 4.1 Mecanismo

- Existe: `ADMIN_EMAILS` (lista separada por comas; fallback `ADMIN_EMAIL`) en `lib/admin.ts:16-24`. No es secreto. Lista vacía = nadie es admin.
- `lib/admin.ts` — agregar:
  ```ts
  export function isAdminEmail(email: string | null | undefined): boolean // lower-case, trim; false si lista vacía
  export async function requireAdminOrNotFound(): Promise<AdminSession> // getAdminSession() ?? notFound()
  ```
  `getAdminSession()` pasa a usar `isAdminEmail`. `admin/layout.tsx` pasa a `requireAdminOrNotFound()`.
- `components/layout/RoleProvider.tsx` (nuevo, `'use client'`): `RoleProvider({ isAdmin, children })` + `useIsAdmin(): boolean` (React context; default `false`).
- `(dashboard)/layout.tsx`: `const isAdmin = isAdminEmail(tenant.user?.email)` (el select ya trae `user.email`, cero queries nuevas) → `<Sidebar isAdmin={isAdmin} />` y `<RoleProvider isAdmin={isAdmin}>{children}</RoleProvider>`.

### 4.2 Menú (`components/layout/Sidebar.tsx`)

`navSections` pasa a `navSectionsFor(isAdmin)`:

- **Usuario normal** (exactamente esto, D32):
  - Principal: `/dashboard` Dashboard · `/labels` Etiquetas
  - Sistema: `/settings` Configuración
  - Sin secciones "Soon" (META ADS / RECOVER no se muestran).
- **Admin** (todo lo de hoy, más `/admin`):
  - Principal: Dashboard, Control, Pedidos, Etiquetas
  - META ADS y RECOVER como hoy (flags)
  - Sistema: Reportes, Configuración, Reglas de envío, **Comprar envíos** (`/settings/billing`, renombrado de "Envíos"), Referidos, **Admin** (`/admin`, icono `Shield`)
- Props: `Sidebar({ isAdmin }: { isAdmin: boolean })`. El resto (colapsable, drawer mobile, logout) no cambia.

### 4.3 Páginas ocultas → 404 server-side para no-admin

Mismo patrón que `admin/layout.tsx` (3 líneas cada uno):
- `app/(dashboard)/control/layout.tsx` (nuevo)
- `app/(dashboard)/orders/layout.tsx` (nuevo)
- `app/(dashboard)/reports/layout.tsx` (nuevo)

No se gatean: `/settings/referrals` (H16: el pill del TopBar lleva ahí), `/settings/shipping-rules` y `/settings/billing` (son parte de "Configuración" para el usuario), `/ads` y `/recover` (ya cerrados por flag en prod). APIs `/api/v1/control/*`: para el usuario no cambian (filtran por ownership); para el admin alcanzan además todos los tenants activos, vía `lib/control-scope.ts` (D32, revisión 2026-09-02).

### 4.4 Configuración para el usuario (estructura; el contenido en §6)

`app/(dashboard)/settings/_components/SettingsNav.tsx` (nuevo): barra de 5 entradas arriba de `/settings`, `/settings/shipping-rules` y `/settings/billing`:
`Tiendas` (`/settings#tiendas`) · `DAC` (`/settings#dac`) · `Reglas de envío` (`/settings/shipping-rules`) · `Parámetros` (`/settings#parametros`) · `Comprar envíos` (`/settings/billing`).
Activa por `pathname` + hash. Se renderiza para todos (admin incluido).

### 4.5 Tests (área B)

- `lib/__tests__/admin.test.ts` (nuevo): `isAdminEmail` con lista vacía → false; con `ADMIN_EMAILS="A@x.com, b@y.com"` → `a@x.com` true, `c@z.com` false; fallback `ADMIN_EMAIL`; `null`/`''` → false. Restaurar `process.env` en `afterEach`.
- `lib/__tests__/sidebar-nav.test.ts` (nuevo): exportar `navSectionsFor` desde `components/layout/nav.ts` (puro, sin React) y afirmar: no-admin = `[/dashboard, /labels]` + `[/settings]`; admin incluye `/control`, `/orders`, `/admin`, `/settings/billing` con label "Comprar envíos".

---

## 5. Área C — Onboarding paso a paso (D33)

### 5.1 Estado derivado (sin columnas nuevas) — `apps/web/lib/onboarding-state.ts` (puro)

```ts
export interface OnboardingRow {
  shopifyStoreUrl: string | null; shopifyToken: string | null;
  dashboardSourceEnabled: boolean; dashboardUrl: string | null; dashboardToken: string | null;
  dacUsername: string | null; dacPassword: string | null;
  onboardingComplete: boolean; cronSchedule: string | null;
}
export type StoreKind = 'shopify' | 'dashboard' | null;
export function storeConnection(r: OnboardingRow): { kind: StoreKind; shopify: boolean; dashboard: boolean }
//  shopify   = !!shopifyStoreUrl && !!shopifyToken
//  dashboard = dashboardSourceEnabled && !!dashboardUrl && !!dashboardToken
//  kind      = shopify ? 'shopify' : dashboard ? 'dashboard' : null   (si hay las dos, 'shopify')
export function hasDac(r: OnboardingRow): boolean  // !!dacUsername && !!dacPassword
export const CRON_INMEDIATO = '*/15 * * * *';
export const CRON_CADA_HORA = '0 * * * *';
export type ProcessingMode = 'inmediato' | 'cada_hora' | 'personalizado';
export function processingModeFromCron(cron: string | null | undefined): ProcessingMode
//  '*/15 * * * *' → 'inmediato' · '0 * * * *' → 'cada_hora' · cualquier otra cosa (incl. null) → 'personalizado'
export function cronForMode(mode: 'inmediato' | 'cada_hora'): string
export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6;
export function deriveOnboarding(r: OnboardingRow): {
  store: ReturnType<typeof storeConnection>; dac: boolean; mode: ProcessingMode;
  complete: boolean; currentStep: OnboardingStep;
}
//  complete            → 6
//  !store && !dac      → 1  (bienvenida)
//  !store              → 2
//  !dac                → 3
//  else                → 4  (parámetros: sin estado propio, es revisión; 5 y 6 se alcanzan avanzando)
```

Regla de gate compartida: **conectado** = `storeConnection(r).kind !== null && hasDac(r)`.

### 5.2 Gates que cambian

- `(dashboard)/layout.tsx`:
  - `select` agrega `dashboardSourceEnabled`, `dashboardUrl`, `dashboardToken`, `isActive`.
  - L90-96 → `if (!(storeConnection(tenant).kind && hasDac(tenant))) redirect('/onboarding')`.
  - L105-113 → `if (!tenant.onboardingComplete) { if (tenant.isActive) { backfill como hoy } else redirect('/onboarding') }` (H4).
- `app/onboarding/layout.tsx`: exigir sesión: `if (!auth) redirect('/login?callbackUrl=%2Fonboarding')`. Verificado quién llega a `/onboarding`: `GoogleSignInButton` (post-auth), `auth.ts pages.newUser`, `TenantSwitcher`, el layout del dashboard y dos links del tutorial público (`tutorial/shopify-token/page.tsx:777,1181` — sin sesión pasan por login y vuelven; correcto). `/onboarding` se queda en `publicPaths` del middleware (evita doble redirect; el layout es el gate).
- `app/onboarding/page.tsx` → **server component**: `getAuthenticatedTenant()`; `db.tenant.findUnique` con los campos de `OnboardingRow` + `user.emailVerified` + `paymentRuleEnabled/paymentThreshold/fulfillMode/skuInObservations/codEnabled/emailHost/emailUser/emailPass/allowedProductTypes/consolidateConsecutiveOrders/consolidationWindowMinutes`; saldo del holder (`getCreditHolderTenantId`); `if (derived.complete) redirect('/dashboard')`; renderiza `<OnboardingWizard initial={state} />`. El JSX actual de `page.tsx` se mueve a `app/onboarding/_components/OnboardingWizard.tsx` (`'use client'`).

### 5.3 Endpoints

#### `GET /api/v1/onboarding/state` (nuevo)
- Auth: `getAuthenticatedTenant` → 401 `{ error: 'No autorizado' }`.
- 200 `{ data: OnboardingState }`:
```ts
interface OnboardingState {
  currentStep: 1|2|3|4|5|6;
  store: { kind: 'shopify'|'dashboard'|null; shopifyConnected: boolean; shopifyStoreUrl: string|null;
           dashboardConnected: boolean; dashboardUrl: string|null };
  dac: { connected: boolean; username: string|null };          // username = decryptOrRaw(dacUsername)
  processingMode: 'inmediato'|'cada_hora'|'personalizado'; cronSchedule: string;
  onboardingComplete: boolean; isActive: boolean; emailVerified: boolean;
  trialShipments: number;                                        // TRIAL_SHIPMENTS
  balance: { shipmentCredits: number; referralBonusCredits: number; total: number }; // del holder
  params: { paymentRuleEnabled: boolean; paymentThreshold: number; fulfillMode: 'off'|'on'|'always';
            skuInObservations: boolean; codEnabled: boolean; emailConfigured: boolean;
            allowedProductTypes: string[]|null; consolidateConsecutiveOrders: boolean;
            consolidationWindowMinutes: number; shippingRulesCount: number };
}
```
- Nunca devuelve tokens ni contraseñas (misma regla que `GET /api/v1/settings`).

#### `POST /api/v1/onboarding/test-dashboard` (nuevo, espejo de `test-shopify`)
- Body zod: `{ dashboardUrl: z.string().url().refine(https y host que no sea localhost/IP literal), dashboardToken: z.string().min(8).max(512) }`.
- Prueba `GET ${url.replace(/\/$/, '')}/api/v1/orders?status=confirmed&limit=1` con `Authorization: Bearer <token>`, `AbortSignal.timeout(8000)` (H15).
  - 401/403 → 422 `{ error: 'El dashboard rechazó el token. Copialo de nuevo desde la página de tu cliente.' }`
  - otro `!ok` → 422 `{ error: 'El dashboard respondió <status>. Verificá la URL.' }`
  - timeout → 422 `{ error: 'El dashboard tardó demasiado en responder. Probá de nuevo.' }`
- OK → `db.tenant.update({ dashboardUrl, dashboardToken: encrypt(token), dashboardSourceEnabled: true })` → 200 `{ data: { ok: true, ordersSeen: number|null } }` (`orders.length` de la respuesta o null).
- El token va sólo a la URL que escribió el usuario, nunca al log.

#### `POST /api/v1/onboarding/complete` (modificado)
- `select` agrega `dashboardSourceEnabled/dashboardUrl/dashboardToken`.
- L55 → `if (!storeConnection(tenant).kind) return apiError('Falta conectar una tienda (Shopify o Dashboard con Excel)', 422)`.
- Resto igual: DAC (422), email verificado (422 `email_not_verified`, D26), idempotente, setea `onboardingComplete`, `onboardingCompletedAt`, `isActive: true`.

#### `POST /api/v1/jobs` (modificado, H10)
- Después de los gates (`checkRunGate`, `checkPlanLimit`, `isJobRunning`): leer `shopifyStoreUrl/shopifyToken/dashboardSourceEnabled/dashboardUrl/dashboardToken` del tenant originante.
- `kind = storeConnection(...)`: `'shopify'` → como hoy (`warmShopifyToken` + `enqueueProcessOrders(id,'MANUAL')`); `'dashboard'` → `enqueueProcessOrders(id, 'MANUAL', { type: 'PROCESS_DASHBOARD_ORDERS' })` **sin** `warmShopifyToken`; `null` → 422 `{ error: 'Conectá una tienda antes de procesar' }`.
- Respuesta 202 igual + `type`.
- `lib/queue.ts`: `enqueueProcessOrders(tenantId, trigger, opts?: { type?: 'PROCESS_ORDERS' | 'PROCESS_DASHBOARD_ORDERS' })`. Para `PROCESS_DASHBOARD_ORDERS` **no** se pushea a BullMQ (la cola `labelflow:process-orders` es del procesador Shopify; el poller de DB del worker rutea por tipo, `index.ts:153`). Firma retrocompatible.
- Verificar antes de implementar: `isJobRunning` (`lib/queue.ts`) es agnóstica del tipo — leerla; si filtra por tipo, agregar el tipo al chequeo.

#### `GET /api/shopify/install?shop=…&next=/onboarding` (modificado, H14)
- `next` → `safeRelativePath(next)` (`lib/safe-next.ts:14`); si válido, cookie `shopify_oauth_next` (httpOnly, `sameSite: 'lax'`, `maxAge: STATE_TTL_SECONDS`, path `/`).
- `callback/route.ts:276` (rama B): destino = cookie válida ? `${next}?shopify=connected${webhookWarning}` : `/settings?shopify=connected${webhookWarning}`; `limpiar()` borra también esa cookie. Rama A (App Store) no cambia.
- El wizard lee `?shopify=connected|already_linked|bad_shop|misconfigured` y `&webhooks=partial|failed` y muestra el mensaje correspondiente (§5.5).

### 5.4 Wizard: reglas generales

- Componente `OnboardingWizard` (client). Estado inicial = `initial` del server; después de cada guardado exitoso refresca con `GET /api/v1/onboarding/state` y salta al `currentStep` derivado **salvo** que el usuario esté en 4/5/6 (ahí manda el click "Continuar").
- Barra de progreso: 6 pasos con título y tiempo estimado; hecho = check; actual = cyan; pendiente = gris. Se puede volver a un paso hecho (para editar), nunca saltar a uno pendiente.
- Sin botón "saltar". Sin emojis. Footer de confianza (reemplaza el "🔒"): "Tus credenciales se guardan cifradas (AES-256). Sólo el automatizador las usa para iniciar sesión."
- Analytics: `track('onboarding_step_completed', { step: 'tienda'|'dac'|'parametros'|'modo', step_number })`, `onboarding_step_failed` con `error_code`, `onboarding_completed` con `total_time_seconds` (eventos ya existentes en `lib/analytics.ts`; no se agregan nombres).

### 5.5 Paso 1 — Bienvenida (2 min de lectura)

Título: **Vamos a dejar tus envíos en automático**
Subtítulo: "Son 5 pasos cortos. Cuando termines, cada pedido pago de tu tienda va a salir solo con su guía de DAC y su etiqueta lista para imprimir."

Checklist (una sola columna, con tiempo estimado por paso, el estado de cada uno sale de `state`):
1. Conectar tu tienda — 2 min — "Shopify con un botón, o tu Dashboard con Excel."
2. Tu cuenta de DAC — 1 min — "Usuario y contraseña con los que entrás a dac.com.uy."
3. Cómo querés que se procesen los pedidos — 3 min — "Quién paga el envío, envío gratis, qué productos, aviso al cliente."
4. Cada cuánto — 30 seg — "Al instante o una vez por hora."
5. Listo — "Te regalamos {TRIAL_SHIPMENTS} envíos para probar. Procesás el primero ahí mismo."

Botón: **Empezar** → paso 2.
Nota al pie: "Necesitás una cuenta de DAC activa. Si todavía no tenés, la pedís en dac.com.uy y volvés cuando la tengas: lo que cargues acá queda guardado."

### 5.6 Paso 2 — Conectar tu tienda (2 min)

Título: **Conectá tu tienda**
Texto: "Elegí de dónde salen tus pedidos. Podés cambiarlo después desde Configuración."

**Opción A — "Instalar la app de Shopify"** (tarjeta principal)
- Texto: "Te lleva a Shopify para que autorices la app. Volvés conectado, sin copiar tokens. Los pedidos pagos entran al instante."
- Input "Tu tienda" (placeholder `mitienda.myshopify.com`; se limpia `https://` y `/`) + botón **Conectar con Shopify** → `window.location.href = /api/shopify/install?shop=<dominio>&next=/onboarding`.
- Si `NEXT_PUBLIC_SHOPIFY_APP_STORE_URL` está definida: link secundario "o instalala desde el App Store de Shopify" (abre esa URL). Si no está, no se muestra nada.
- Retornos (`?shopify=`): `connected` → toast "Tienda conectada." (+ si `webhooks=partial|failed`: "Shopify no confirmó el aviso instantáneo; los pedidos igual entran cada 15 minutos."); `already_linked` → "Esa tienda ya está conectada a otra cuenta. Escribinos y lo resolvemos."; `bad_shop` → "El dominio no parece de Shopify. Tiene que terminar en .myshopify.com."; `misconfigured` → "La conexión con Shopify no está disponible ahora. Probá más tarde o usá el token manual."
- `<details>` "Conectar a mano con un token (método viejo)": el formulario actual (URL + Admin API token → `POST /api/v1/onboarding/test-shopify`, `ShopifyTutorial` como hoy). Texto: "Sólo si ya tenés una app privada creada. Con este método los pedidos entran cada 15 minutos, no al instante."

**Opción B — "Dashboard con Excel"** (tarjeta secundaria)
- Texto: "Si no vendés por Shopify: cargás tus pedidos en el Dashboard de AutoEnvía (desde un Excel) y nosotros los levantamos de ahí."
- Inputs: "URL del dashboard" (default `https://autoenvia-dash.vercel.app`) y "API token" (password; "Lo encontrás en la página de tu cliente, sección API.").
- Botón **Probar y guardar** → `POST /api/v1/onboarding/test-dashboard`. OK: "Conectado. Vimos tu dashboard y está listo para leer pedidos confirmados."
- Nota: "Con esta opción los pedidos se procesan según el modo que elijas en el paso 4 (cada 15 minutos o cada hora); no hay aviso instantáneo."

Estado "hecho": tarjeta verde con el dominio / la URL y botón "Cambiar". **Continuar** habilitado sólo si `state.store.kind !== null`.

### 5.7 Paso 3 — Tu cuenta de DAC (1 min)

Título: **Tu cuenta de DAC**
Texto: "Con estos datos el automatizador entra a dac.com.uy y carga cada envío como lo harías vos. Se guardan cifrados."
Inputs: "Usuario" (`dacUsername`, máx 100) · "Contraseña" (`dacPassword`, máx 200). Tutorial `DacTutorial` como hoy.
Botón **Guardar** → `POST /api/v1/onboarding/test-dac` (existente: formato + cifrado + borra cookies `dac_cookies`).
Aviso honesto (H5): "No podemos probar el ingreso a DAC desde acá (su portal bloquea pruebas automáticas). Lo confirmamos en tu primer envío: si el usuario o la contraseña están mal, lo vas a ver en el Dashboard con el motivo."
Estado hecho: "Cuenta DAC guardada: {username}" + "Cambiar". **Continuar**.

### 5.8 Paso 4 — Parámetros de envío (3 min)

Ver §6 (Área D) para cada parámetro: es el **mismo componente** que la sección "Parámetros" de Configuración (`ParametrosForm`), montado dentro del wizard con `compact`. Todos tienen default seguro; el usuario puede seguir sin tocar nada. Guardado por bloque (`PUT /api/v1/settings`) y reglas de envío por `POST /api/v1/shipping-rules`.
Botón **Continuar** (no exige guardar). Texto de cabecera: "Todo esto tiene un valor por defecto que funciona. Cambiá sólo lo que necesites; podés volver desde Configuración cuando quieras."

### 5.9 Paso 5 — Modo de procesamiento (30 seg)

Título: **Cada cuánto procesamos tus pedidos**
Dos tarjetas (radio):
- **Inmediato** (recomendado) — "Apenas un pedido queda pago, lo procesamos. Además revisamos la tienda cada 15 minutos por si algo se escapó." Nota condicional: si `store.kind === 'dashboard'` o Shopify por token manual (no lo sabemos con certeza; usar `state.store.kind`): "Con tu forma de conexión, el aviso instantáneo no está disponible: los pedidos entran en la revisión de cada 15 minutos." Escribe `cronSchedule = '*/15 * * * *'`.
- **Cada hora** — "Juntamos lo que entró y lo procesamos en punto, una vez por hora (por ejemplo 10:00, 11:00, 12:00). Útil si preferís revisar antes de que salgan." Escribe `cronSchedule = '0 * * * *'`.
- Si `processingMode === 'personalizado'` (cron raro heredado): tercera tarjeta no seleccionable "Horario personalizado (configurado por soporte)" y aviso "Si elegís una opción de arriba, reemplaza ese horario."
Botón **Guardar y continuar** → `PUT /api/v1/settings { cronSchedule }` (pasa la validación actual, H8).

### 5.10 Paso 6 — Listo

Título: **Todo listo**
Bloque cyan: "**{TRIAL_SHIPMENTS} envíos gratis** — Te los acreditamos para que pruebes el flujo completo. No vencen. Cuando los uses, comprás envíos y seguís sin pausas." Debajo, el saldo real: "Saldo disponible: {balance.total} envíos" (si `total < TRIAL_SHIPMENTS` porque es una tienda adicional/reclamada: "Tu saldo es compartido entre todas tus tiendas.").
Resumen: tienda (`kind` + dominio/URL), DAC (usuario), modo (Inmediato / Cada hora).
Si `!emailVerified`: banner "Confirmá tu email para activar la cuenta. Te mandamos un link al registrarte." + botón "Reenviar" (`/verify-email?email=…`, como hoy); el botón principal deshabilitado.
Botón principal **Activar y procesar ahora** → `POST /api/v1/onboarding/complete`; si 200 → `POST /api/v1/jobs` con `{}`; si 202 → `track('onboarding_completed')` → `window.location.href = '/dashboard?job=<jobId>'`; si el job falla con 403/409/422 igual se navega a `/dashboard` mostrando el mensaje (la cuenta ya quedó activa).
Botón secundario **Activar sin procesar** → sólo `complete` → `/dashboard`.
Lista de "qué pasa ahora": "Cada pedido pago genera su guía en DAC." · "La etiqueta queda lista para imprimir en Etiquetas." · "Si algo falla, lo ves en el Dashboard con el motivo."

Al completar, la tienda aparece en Control como hoy (lista tenants del user; H13).

### 5.11 Tests (área C)

- `lib/__tests__/onboarding-state.test.ts` (nuevo, puro): `storeConnection` (sólo Shopify; sólo dashboard; ambas → shopify; dashboard con `enabled=false` → null; url sin token → null); `hasDac`; `processingModeFromCron` (los 2 crons, `'0 0 31 2 *'` → personalizado, null → personalizado); `cronForMode`; `deriveOnboarding` para las 5 combinaciones (nada → 1; sólo dac → 2; sólo tienda → 3; ambas → 4; complete → 6).
- `lib/__tests__/onboarding-state-route.test.ts` (nuevo): 401; 200 con el shape exacto; no incluye `shopifyToken`/`dacPassword`/`dashboardToken` en el JSON (assert `JSON.stringify(body)` no contiene `enc:`).
- `lib/__tests__/onboarding-test-dashboard-route.test.ts` (nuevo): 401; URL http → 400; 401 del dashboard → 422 sin `update`; 200 → `update` con `dashboardSourceEnabled: true` y token cifrado (mock `fetch` con `vi.stubGlobal`, como `onboarding-test-shopify-route.test.ts`).
- `lib/__tests__/onboarding-complete-route.test.ts` (extender): dashboard-only + DAC + email → 200 y `isActive: true`; sin ninguna tienda → 422 "Falta conectar una tienda".
- `lib/__tests__/jobs-route.test.ts` (nuevo): tenant Excel → `job.create` con `type: 'PROCESS_DASHBOARD_ORDERS'`, `trigger: 'MANUAL'`, sin `warmShopifyToken`; tenant Shopify → `PROCESS_ORDERS`; sin tienda → 422.
- `lib/__tests__/shopify-install-route.test.ts` (extender): `next=/onboarding` setea la cookie; `next=https://evil` no la setea.
- `lib/__tests__/shopify-callback-route.test.ts` (extender): rama B con cookie `next` → redirect a `/onboarding?shopify=connected`; sin cookie → `/settings?...`.

---

## 6. Área D — Parámetros (paso 4 y Configuración > Parámetros)

### 6.1 Cambios de API (`app/api/v1/settings/route.ts`)

- `updateSchema` (L8-65): agregar `codEnabled: z.boolean().optional()`.
- `PUT` (L262-290): `if (input.codEnabled !== undefined) data.codEnabled = input.codEnabled`.
- `GET` `select` (L73-117) + respuesta (L171-218): agregar `codEnabled`.
- Sin otros cambios de contrato. `cronSchedule` ya acepta los dos modos.

### 6.2 Componente `app/(dashboard)/settings/_components/ParametrosForm.tsx` (nuevo, client)

Se usa en `/settings#parametros` y en el paso 4 del wizard (`compact`). Cada bloque: título, "qué hace", "para quién", "ejemplo", control, botón Guardar del bloque (`PUT /api/v1/settings`), `InlineMessage`. Orden y textos completos:

**1. Cómo se procesan (modo)** — mismo control que el paso 5 (§5.9). Sólo en Configuración (en el wizard es el paso 5).

**2. Quién paga el envío** (`paymentRuleEnabled`, `paymentThreshold`)
- Qué hace: "Define si el envío lo paga tu cliente al recibir (DAC lo cobra en la puerta) o lo pagás vos."
- Para quién: "Para tiendas que absorben el envío en compras grandes."
- Ejemplo: "Con umbral $4.000: un pedido de $5.200 lo pagás vos; uno de $2.900 lo paga el cliente."
- Control: toggle "Yo pago el envío cuando el pedido supera un monto" + input "Monto (UYU)" (mín 1; el 0 no vale, H6: si el usuario pone 0 el botón se deshabilita con "Poné un monto mayor a 0").
- Aviso fijo (H6): "Los envíos que te tocan pagar a vos **no se cargan solos**: te dejamos una nota en el pedido de Shopify con el monto y lo cargás vos en DAC. Los que paga el cliente salen automáticos."
- Default: apagado (todos los envíos los paga el cliente al recibir).

**3. Envío gratis por reglas** (ShippingRule; link a `/settings/shipping-rules`)
- Qué hace: "Reglas que marcan un pedido como 'lo paga la tienda'. Gana la primera que coincide."
- Tres atajos (crean la regla con `POST /api/v1/shipping-rules`, mismos presets que `shipping-rules/page.tsx:77+`):
  - "Envío gratis a partir de $___" → `THRESHOLD_TOTAL {minTotalUyu}` — Ejemplo: "Con $3.000, un pedido de $3.500 sale gratis para el cliente."
  - "Envío gratis a partir de ___ productos" → `ITEM_COUNT {minItems}` — Ejemplo: "Con 3, un pedido de 3 o más ítems sale gratis."
  - "Envío gratis para clientes con la etiqueta ___ en Shopify" → `CUSTOMER_TAG {tag}` — Ejemplo: "Etiqueta 'vip': marcás al cliente en Shopify y sus envíos salen gratis." (aviso: "Sólo tiendas Shopify. Si conectaste con la app pública, las etiquetas del cliente no llegan: usá etiquetas del pedido." — D27/PENDIENTES `read_customers`.)
- Muestra `shippingRulesCount` reglas activas y "Ver todas las reglas".
- Mismo aviso de carga manual que el bloque 2 (es REMITENTE).

**4. Pedidos seguidos del mismo cliente** (`consolidateConsecutiveOrders`, `consolidationWindowMinutes`)
- Qué hace: "Si el mismo cliente compra dos veces en pocos minutos, el segundo envío lo pagás vos (para no cobrarle dos envíos)."
- Ejemplo: "Ventana de 30 minutos: compra a las 10:00 y otra vez a las 10:20 → el segundo va como pagado por la tienda."
- Control: toggle + minutos (1–1440). Default apagado / 30.

**5. Qué productos se envían** (`allowedProductTypes` + `POST /api/v1/products/scan`)
- Qué hace: "Elegí qué tipos de producto se despachan con DAC. Lo que no está en la lista se ignora (no se crea guía ni se gasta un envío)."
- Para quién: "Tiendas que venden también productos digitales, retiros en local o cosas que mandan por otro lado."
- Ejemplo: "Marcás 'Remeras' y 'Buzos'; un pedido de 'Gift card' no se procesa."
- Control: botón "Buscar tipos en mi tienda" (scan, sólo Shopify) + checkboxes. Vacío = se envía todo. Nota: "Se compara contra el título, el tipo y el proveedor del producto. No hay filtro por SKU exacto (ver §6.4)."

**6. Marcar como Preparado en Shopify** (`fulfillMode`)
- Qué hace: "Después de crear la guía, marcamos el pedido como Preparado en Shopify (y le agregamos la guía)."
- Opciones: "No" (`off`) · "Sí, si el pedido lo permite" (`on`, default) · "Siempre" (`always`: "fuerza Preparado aunque el pedido tenga partes sin enviar").
- Sólo aplica a Shopify; para Excel se muestra deshabilitado con "No aplica al Dashboard con Excel".

**7. SKU en la guía** (`skuInObservations`)
- Qué hace: "Escribe los SKU del pedido en 'Observaciones' de la guía de DAC, para armar el paquete mirando la etiqueta."
- Ejemplo: "SKU: REM-M-AZUL x2, BUZ-L-NEG x1".
- Control: toggle. Default apagado.

**8. Contrareembolso** (`codEnabled`) — H7
- Qué hace: "DAC le cobra al cliente el valor de la compra al entregar y te lo gira. La guía sale como 'Contrareembolso' con el total del pedido."
- Para quién: "Tiendas que venden contra entrega."
- Ejemplo: "Pedido de $2.500: DAC cobra $2.500 en la puerta y te los transfiere."
- Aviso: "Se aplica a **todos** los pedidos de la tienda mientras esté prendido; no hay selección por pedido. El monto es el total del pedido en Shopify, redondeado."
- Control: toggle. Default apagado.
- Precondición de deploy en §12 (columna en prod).

**9. Aviso al cliente por email** (`emailHost/emailPort/emailUser/emailPass/emailFrom/storeName`)
- Qué hace: "Cuando sale la guía, le mandamos un email a tu cliente con el número de seguimiento, desde tu propia casilla."
- Para quién: "Tiendas que quieren avisar sin depender de Shopify."
- Ejemplo: "Gmail: servidor smtp.gmail.com, puerto 587, tu usuario y una contraseña de aplicación."
- Control: campos SMTP + "Nombre de la tienda" (`storeName`). Apagado = dejar vacío (no hay toggle aparte; H: `process-orders.job.ts:1149-1151` sólo manda si host+user+pass).

**10. Orden de procesamiento** (`orderSortDirection`) — "Más antiguos primero" (default) / "Más recientes primero". Una línea de explicación: "Qué pedidos salen primero cuando hay varios pendientes."

### 6.3 Configuración (`settings/page.tsx`) reorganizada

- Anclas: `#tiendas` (Shopify + Dashboard con Excel, como hoy pero con el mismo copy de §5.6 y el botón "Conectar con Shopify" con `next=/settings`), `#dac`, `#parametros` (`ParametrosForm`).
- **Sólo admin** (`useIsAdmin()`): "Programación automática" (slots), "Reparto propio", "Impresión", "API Key (MCP)", "Test DAC". Para el usuario esas secciones no se renderizan.
- Título: "Configuración" · subtítulo "Tu tienda, tu cuenta de DAC y cómo se procesan los pedidos".

### 6.4 Parámetros que NO existen en el producto (no se inventan)

| Pedido en D33 | Estado en main | Por qué no se muestra / cómo se muestra |
|---|---|---|
| Filtro por SKU exacto | No existe. `allowedProductTypes` matchea título/tipo/proveedor; `skuInObservations` sólo escribe el SKU. | Se ofrece el filtro por tipo de producto con la aclaración; nada de "SKU" en el control. |
| "Siempre lo paga la tienda" | No existe: umbral ≤ 0 = DESTINATARIO por seguridad (`payment.ts:42-45`); umbral 1 sería un hack. | No se ofrece. Quien lo quiera usa una regla `THRESHOLD_TOTAL` con monto 1 desde Reglas de envío (documentado ahí, no en el wizard). |
| Pago automático de REMITENTE con tarjeta (Plexo) | Retirado el 2026-04-22; campos `paymentAuto*` quedan en schema sin UI (`settings/page.tsx:140-143`). | No se toca. |
| Contrareembolso por pedido / por monto distinto al total | Sólo por tienda, monto = total Shopify. | Se muestra como está, con el aviso. |
| Notificación al cliente por WhatsApp | No existe (los bots de WhatsApp son otro producto). | No se menciona. |
| Horarios personalizados (slots) | Existe, sólo admin en esta versión. | En el wizard no; en Configuración sólo admin. |
| Peso/dimensiones por defecto de la guía | No documentado en ningún repo (PENDIENTES.md). | No se menciona. |
| Elegir transportista (Correo Uruguayo) | No está en main (rama aparte). | No se menciona. |
| Reparto propio (Maldonado) | Existe, feature de un cliente. | Sólo admin. |

### 6.5 Tests (área D)

- `lib/__tests__/settings-route-cod.test.ts` (nuevo): `PUT { codEnabled: true }` → `update.data.codEnabled === true`; `PUT { codEnabled: 'si' }` → 400; `PUT { cronSchedule: '0 * * * *' }` → 200; `PUT { cronSchedule: '*/5 * * * *' }` → 400 (ya vale hoy; fija el contrato del modo).
- `lib/__tests__/settings-route-get-shape.test.ts` (nuevo): el GET incluye `codEnabled` y no incluye `dacPassword`/`shopifyToken`/`dashboardToken`/`emailPass`/`paymentCardCvc` (sólo los `*Set`).

---

## 7. Área E — Compra de envíos (D34)

### 7.1 `apps/web/lib/credit-accrual.ts` (nuevo) — la MISMA función para MP y Whop (H11)

Extraído de `webhooks/mercadopago/route.ts:313-449` y `:456-530` **sin cambiar semántica**:

```ts
export type PaymentRail = 'mercadopago' | 'whop';
export interface SettleInput { purchaseId: string; externalPaymentId: string; rail: PaymentRail }
export type SettleResult =
  | { credited: true; holderTenantId: string; shipments: number; firstPaidPack: boolean }
  | { credited: false; reason: 'not_found' | 'already_processed' | 'duplicate_payment' };
export async function settlePaidPurchase(i: SettleInput): Promise<SettleResult>
export async function failPendingPurchase(purchaseId: string): Promise<void>          // PENDING → FAILED
export async function refundPaidPurchase(purchaseId: string): Promise<{ refunded: boolean; debited: number }> // PAID → REFUNDED + débito clamp
export async function accrueReferralKickback(refereeTenantId: string, sourcePurchaseId: string, shipments: number): Promise<void> // movida tal cual
```
`settlePaidPurchase`: `findUnique` → `not_found`; `priorPaidCount` (excluye la propia); `updateMany({ id, status: 'PENDING' }, { status: 'PAID', mpPaymentId: externalPaymentId, paidAt })` → `count 0` = `already_processed`; **P2002 en ese update** (otro purchase ya tiene ese `mpPaymentId`) = `duplicate_payment` (se atrapa, no se acredita); holder = `getCreditHolderTenantId(purchase.tenantId)`; `tenant.update({ shipmentCredits +shipments, creditsPurchased +shipments })`; `trackServer(purchase.tenantId, 'subscription_activated', { plan: packId, amount_uyu, rail })` sólo si `priorPaidCount === 0`; `accrueReferralKickback`. Logs con prefijo `[${rail}]`, nunca el body.

`webhooks/mercadopago/route.ts`: `handleCreditPackPayment` queda como router de estados → `settlePaidPurchase({ rail: 'mercadopago', externalPaymentId: paymentId })` / `failPendingPurchase` / `refundPaidPurchase`. Se borran las funciones locales. Comportamiento observable idéntico.

### 7.2 Selector de volumen (`lib/credit-packs.ts` + `settings/billing/page.tsx`)

```ts
export const VOLUME_PRESETS = [10, 25, 50, 100, 250, 500, 1000] as const;
export interface VolumeQuote {
  monthlyShipments: number; pack: CreditPack; quantity: number;      // quantity > 1 sólo si n > 1000
  pricePerShipmentUyu: number; totalPriceUyu: number; tierLabel: string;
  savingsVsBaseUyu: number;                                          // (pack.shipments*qty*20) - total
}
export function quoteForVolume(n: number): VolumeQuote   // n entero 1..100000, si no RangeError
export function tierLabelFor(n: number): string
```
Reglas: `pack` = el pack más chico con `shipments >= n`; si `n > 1000` → `pack_1000` y `quantity = ceil(n/1000)`. `pricePerShipmentUyu = pack.pricePerShipmentUyu`; `totalPriceUyu = pack.totalPriceUyu * quantity`. `tierLabelFor`: `<50` "Hasta 49 envíos por mes" · `50–99` "Desde 50 envíos por mes" · `100–249` · `250–499` · `500–999` · `≥1000` "Desde 1000 envíos por mes" (mismos cortes y precios que `apps/worker/src/billing/tiers.ts:52-59`; no se importa el worker — apps separadas, mismo motivo que `lib/contrarreembolso.ts`). Aritmética entera; sin floats.

UI en `settings/billing/page.tsx`, arriba de la grilla:
- Título: **¿Cuántos envíos hacés por mes?**
- Presets como chips (10 · 25 · 50 · 100 · 250 · 500 · 1000) + input numérico "otro".
- Resultado (glass): "Precio por envío: **${pricePerShipmentUyu} UYU** · {tierLabel}" · "Total: **${totalPriceUyu} UYU** por {pack.label}{quantity>1 ? ` × ${quantity}` : ''}" · "Ahorrás ${savingsVsBaseUyu} frente a comprar de a 10" (si > 0).
- Botones: **Pagar con MercadoPago** → `handleBuy(pack.id)` (existente: `/api/credit-packs/checkout?pack=`); **Pagar con Whop** → sólo si `pack.id ∈ whopPacks` → `window.location.href = /api/credit-packs/whop-checkout?pack=<id>`. Si `quantity > 1`: aviso "Se compra de a un pack; repetí la compra {quantity} veces o escribinos."
- La grilla de 6 packs queda abajo bajo "Todos los packs" (cada tarjeta suma el botón Whop si aplica).
- Copy fijo bajo el selector: "Los envíos no vencen y se comparten entre todas tus tiendas. Cada guía creada en DAC descuenta un envío."

### 7.3 `GET /api/credit-packs/me` (modificado)

Agrega `balance.referralBonusCredits`, `balance.total` (holder: `shipmentCredits + referralBonusCredits`) y `whopPacks: string[]` (ids de pack con URL en `WHOP_CHECKOUT_URLS`; las URLs no se mandan al cliente).

### 7.4 `GET /api/credit-packs/whop-checkout?pack=<id>` (nuevo)

- Sesión (401). `getPack` (400 como MP). `WHOP_CHECKOUT_URLS` = JSON `{ "pack_100": "https://whop.com/checkout/..." }` leído **server-side** (`lib/whop.ts: getWhopCheckoutUrls(): Record<string,string>`; JSON inválido → `{}` + `console.error` una vez). Sin URL para el pack → 404 `{ error: 'Pago con Whop no disponible para este pack' }`.
- Crea `CreditPurchase { tenantId, packId, shipments, pricePerShipmentUyu, totalPriceUyu, status: 'PENDING', mpExternalRef: 'whop|<tmp>' → 'whop|<purchaseId>' }` (dos pasos como `checkout/route.ts:57-76`; `mpPreferenceId` null).
- 302 a la URL tal cual (no se le agregan parámetros: no está verificado que los links de Whop acepten metadata — §12).

### 7.5 `POST /api/webhooks/whop` (nuevo) — contrato exacto

1. `rawBody = await req.text()`.
2. Secret `WHOP_WEBHOOK_SECRET`; si falta → **503** `{ error: 'Service not configured' }` (fail-closed, igual que MP).
3. Headers `webhook-id`, `webhook-timestamp`, `webhook-signature`; falta alguno → **401** `{ error: 'Invalid signature' }`.
4. Timestamp entero en segundos; `|now/1000 − ts| > 300` → 401.
5. Clave HMAC: si el secret empieza con `whsec_` → `Buffer.from(secret.slice(6), 'base64')`; si no → `Buffer.from(secret, 'utf8')`. (Standard Webhooks: el secret viene base64 con prefijo; se aceptan los dos formatos.)
6. `expected = base64(HMAC-SHA256(key, `${id}.${ts}.${rawBody}`))`. El header puede traer varias firmas separadas por espacio, cada una `v1,<base64>`; válido si **alguna** coincide con `crypto.timingSafeEqual` (comparando buffers de igual longitud; longitudes distintas = no coincide). Ninguna → 401.
7. `JSON.parse(rawBody)` inválido → **400**.
8. Dedupe de entrega: `webhookReceipt.create({ source: 'whop', topic: <eventType || 'unknown'>, webhookId: <webhook-id> })`; P2002 → **200** `{ ok: true, duplicate: true }`.
9. `eventType = body.type ?? body.action ?? body.event` (string). Sólo `payment.succeeded` (aceptar también `payment_succeeded`) acredita. `payment.refunded` / `refund.created` / `dispute.created` → `refundPaidPurchase` del purchase resuelto por `mpPaymentId = 'whop:<pay_id>'`. Cualquier otro → 200 `{ ok: true, ignored: true }`.
10. `paymentId = body.data?.id` (string, prefijo `pay_`); si falta → 200 `{ ok: true, flagged: true }` + `console.warn('[whop] evento sin payment id', { webhookId, eventType })`.
11. Resolver el purchase, **fail-closed**, en este orden:
    1. `data.metadata.purchaseId` → `creditPurchase.findFirst({ id, mpExternalRef: { startsWith: 'whop|' }, status: 'PENDING' })`.
    2. si no: usuario por `data.metadata.userId` → `user.findUnique({ id })`; si no: email = `(data.user?.email ?? data.user_email ?? data.email)` en minúsculas → `user.findUnique({ email })`.
    3. con usuario: `pending = creditPurchase.findMany({ tenant: { userId }, mpExternalRef: { startsWith: 'whop|' }, status: 'PENDING', createdAt: { gte: now − 24h } })`; si `data.metadata.packId` está → filtrar por `packId`; si queda **exactamente uno** → ése; si 0 o >1 → **no se acredita**: 200 `{ ok: true, flagged: true }` + `console.warn('[whop] compra no resuelta', { webhookId, paymentId, candidates: n })` (queda para acreditar a mano).
11b. **Producto, fail-closed** (revisión 2026-09-02): los links de checkout son públicos, así que el pack NO lo decide la compra PENDING sino el evento. `rules = getWhopPlanRules()` (`WHOP_PLAN_IDS`, JSON `{packId: plan_id}` o `{packId: {planId, minUsd}}`); `payloadPlanIds = [data.plan_id, data.plan.id, data.product_id, data.product.id]` (los que existan); `checkWhopPlanForPack({ packId: purchase.packId, payloadPlanIds, amount: data.final_amount ?? data.amount ?? data.total, currency: data.currency, rules })`. Falla (`no_rules` · `pack_not_mapped` · `plan_missing` · `plan_mismatch` · con `minUsd`: `amount_missing` · `currency_mismatch` (≠ USD) · `amount_below_min`) → 200 `{ ok: true, flagged: true, reason }` + `console.warn('[whop] plan no coincide con la compra — no se acredita', { webhookId, paymentId, purchaseId, packId, reason, payloadPlanIds })`. Aplica también cuando la compra vino por `metadata.purchaseId`.
12. `settlePaidPurchase({ purchaseId, externalPaymentId: 'whop:' + paymentId, rail: 'whop' })` → 200 `{ received: true, credited, reason? }`.
13. Logs: sólo `webhookId`, `eventType`, `paymentId`, `purchaseId`, `holderTenantId`, `shipments`. **Nunca** `rawBody`, ni email, ni headers.
14. `GET` → 200 `{ ok: true }` (paridad con MP).
- `middleware.ts`: `/api/webhooks` ya es público (L28). Nada que tocar.
- Idempotencia por pago: `mpPaymentId @unique` con el valor `whop:<pay_id>` (segunda entrega → `already_processed` o `duplicate_payment`). Por entrega: `WebhookReceipt`.

### 7.6 Variables de entorno (Vercel; ninguna es `NEXT_PUBLIC_`)

| Var | Uso | Si falta |
|---|---|---|
| `WHOP_CHECKOUT_URLS` | JSON `{packId: url}` | botones Whop ocultos; endpoint 404 |
| `WHOP_WEBHOOK_SECRET` | firma | webhook 503 (fail-closed) |
| `WHOP_PLAN_IDS` | JSON `{packId: plan_id}` o `{packId: {planId, minUsd}}` | ningún pago de Whop acredita (200 `flagged`, `reason: no_rules`) |
| `ADMIN_EMAILS` | roles | nadie es admin (menú de usuario para todos, /control /orders /reports /admin → 404) |
| `NEXT_PUBLIC_SHOPIFY_APP_STORE_URL` (opcional) | link "instalar desde el App Store" | link oculto |

### 7.7 Tests (área E)

- `lib/__tests__/credit-accrual.test.ts` (nuevo, mocks de `db` como en `onboarding-complete-route.test.ts`): PENDING → PAID acredita al holder (no al tenant de compra) con `shipmentCredits` y `creditsPurchased`; segunda llamada → `already_processed` sin `tenant.update`; P2002 en `updateMany` → `duplicate_payment`; `firstPaidPack` true sólo si `priorPaidCount 0` y dispara `trackServer` una vez; kickback: referido → `$transaction` con `floor(0.2*n)` al holder del referidor, self-referral (mismo userId) no acredita, P2002 → skip; `refundPaidPurchase` clamp al saldo.
- `lib/__tests__/mercadopago-webhook-route.test.ts` (nuevo, mínimo): `approved` llama `settlePaidPurchase` con `rail: 'mercadopago'`; `rejected` → `failPendingPurchase`; `refunded` → `refundPaidPurchase`. (Hoy no hay test del webhook MP; el refactor lo necesita.)
- `lib/__tests__/credit-packs-volume.test.ts` (nuevo): `quoteForVolume` para 1, 10, 11, 49, 50, 99, 100, 249, 250, 499, 500, 999, 1000, 1001, 2500 (pack, cantidad, total, tramo); `0`/`-1`/`1.5`/`1e9` → RangeError; invariante: `pricePerShipmentUyu(n)` no crece con `n`; tabla de precios `20/17/15/12/10/7` igual a `CREDIT_PACKS`.
- `lib/__tests__/whop-webhook-route.test.ts` (nuevo): sin secret → 503 y no toca `db`; firma válida (calcular HMAC en el test con secret `whsec_` base64 y con secret plano) → 200 y `settlePaidPurchase` llamado con `whop:pay_x`; firma inválida → 401; timestamp a 6 min → 401; header con dos firmas, la segunda válida → 200; `webhook-id` repetido (P2002 en receipt) → 200 `duplicate: true` sin acreditar; evento `membership.went_valid` → 200 `ignored`; sin usuario resoluble → 200 `flagged` sin acreditar; dos PENDING sin `packId` → `flagged`; `console.*` nunca recibe el body (spy sobre `console.warn/info/error` y assert que ningún argumento contiene el email ni el raw body).
- `lib/__tests__/whop-checkout-route.test.ts` (nuevo): sin `WHOP_CHECKOUT_URLS` → 404; pack inválido → 400; OK → `creditPurchase.create` con `mpExternalRef` `whop|…` y redirect 302 a la URL del env.
- `lib/__tests__/credit-packs-me-route.test.ts` (nuevo): `whopPacks` refleja el env; la respuesta no contiene la URL.

---

## 8. Área F — Dashboard por rol (D32)

`app/(dashboard)/dashboard/page.tsx` con `useIsAdmin()`:

- **Usuario normal**:
  - Tarjetas: "Envíos hoy" (`labelsToday`), "Este mes" (`labelsThisMonth`), "Tasa de éxito" (`successRate`) — las tres ya vienen de `GET /api/v1/settings` (`settings/route.ts:131-168`) — y **"Envíos disponibles"** (`balance.total` de `GET /api/credit-packs/me`, §7.3) con link a `/settings/billing`. Reemplaza "Último run" (queda en el panel de admin).
  - Un solo botón **Procesar ahora** (`POST /api/v1/jobs` con `{}` → usa `maxOrdersPerRun`); sin chips 1/3/5/10/20.
  - Bloque "Cómo se procesan": "Inmediato — cada pedido pago y cada 15 minutos" / "Cada hora, en punto" (de `processingModeFromCron(cronSchedule)`) + link "Cambiar en Configuración". Reemplaza "Horarios automáticos".
  - Conexiones: Shopify **o** "Dashboard con Excel" según `kind`, DAC, Email.
  - `JobFeedPanel`, `ShipmentInsights` y "Últimas ejecuciones" se quedan.
  - Se ocultan: controles inline de Orden / Preparado / Productos (viven en Configuración > Parámetros), "Recuperar envíos sin completar", scopes faltantes (sólo admin).
  - Si llega `?job=<id>` desde el wizard: abre `JobFeedPanel` con ese job y muestra "Estamos procesando tu primer pedido."
- **Admin**: la página de hoy tal cual (+ la tarjeta de saldo no hace falta: está en el TopBar).

`app/(dashboard)/labels/page.tsx`: botón **Imprimir todas** en la cabecera → selecciona todas las etiquetas listadas con PDF (`allWithPdf`, L72) y llama `handleBulk('print')`. Si hay más de 50 (tope del bulk, `labels/bulk/route.ts:8`), imprime las primeras 50 y avisa "Se imprimen de a 50. Repetí para las siguientes."

Tests (área F): `lib/__tests__/dashboard-role-view.test.ts` — extraer a `app/(dashboard)/dashboard/_lib/view.ts` la función pura `dashboardCardsFor({ isAdmin, stats, balance })` y `processingSummary(cron)`; afirmar las 4 tarjetas del usuario y las 4 del admin, y los textos del modo.

---

## 9. Textos de decisiones (ya escritos en `docs/DECISIONES.md`, D30–D34)

Ver el archivo. D30 lleva la nota de riesgo de Shopify Billing (Adrian lo asume).

## 10. Orden de implementación y checklist de cierre por área

1. Área A → gates → `git push -u origin feat/selfserve-v1`.
2. Área B → gates (incluye `next build`) → push.
3. Áreas C + D → gates → push. Antes de empezar: leer `lib/queue.ts` entero (`isJobRunning`) y `lib/shopify-access.ts` (`warmShopifyToken` no debe lanzar sin token; si lanza, no llamarla para `kind !== 'shopify'`).
4. Área E → primero el refactor de `credit-accrual` con su test **antes** de tocar el webhook de MP (commit aparte) → después selector + Whop → gates → push.
5. Área F → gates → push.
6. Reporte final: commits, archivos, líneas exactas de los gates, lo no hecho y por qué.

## 11. Resumen de archivos

**Nuevos**: `lib/trial.ts` · `lib/onboarding-state.ts` · `lib/credit-accrual.ts` · `lib/whop.ts` · `components/layout/RoleProvider.tsx` · `components/layout/nav.ts` · `app/onboarding/_components/OnboardingWizard.tsx` · `app/(dashboard)/settings/_components/{SettingsNav,ParametrosForm}.tsx` · `app/(dashboard)/{control,orders,reports}/layout.tsx` · `app/api/v1/onboarding/{state,test-dashboard}/route.ts` · `app/api/credit-packs/whop-checkout/route.ts` · `app/api/webhooks/whop/route.ts` · `app/(dashboard)/dashboard/_lib/view.ts` · tests de §3.5, §4.5, §5.11, §6.5, §7.7, §8.

**Modificados**: `lib/admin.ts` · `lib/auth.ts` · `lib/shopify-provision.ts` · `lib/credit-packs.ts` · `lib/queue.ts` · `app/api/auth/signup/route.ts` · `app/api/v1/onboarding/complete/route.ts` · `app/api/v1/jobs/route.ts` · `app/api/v1/settings/route.ts` · `app/api/shopify/install/route.ts` · `app/api/shopify/callback/route.ts` · `app/api/credit-packs/me/route.ts` · `app/api/webhooks/mercadopago/route.ts` · `app/(dashboard)/layout.tsx` · `app/(dashboard)/admin/layout.tsx` · `app/onboarding/{layout,page}.tsx` · `app/(dashboard)/{dashboard,labels,settings,settings/billing,settings/referrals}/page.tsx` · `components/layout/Sidebar.tsx` · `components/onboarding/AhaMomentModal.tsx` · `app/(auth)/signup/{page,SignupForm}.tsx` · `docs/DECISIONES.md` · `PENDIENTES.md`.

**No se tocan**: `apps/worker/**`, `apps/web/prisma/schema.prisma`, `apps/worker/src/dac/shipment.ts`, migraciones.

## 12. PENDIENTES, riesgos y lo que no se hace (agregar a `PENDIENTES.md` en el último commit)

| Ítem | Estado / qué hacer |
|---|---|
| **Columna `Tenant.codEnabled` en prod** (H7) | **Verificado 2026-09-02: está** (`information_schema` sobre `DIRECT_URL`: `Tenant.codEnabled boolean DEFAULT false`, `Label.codAmount integer`). Lo que NO está verificado es que el worker de Render corra `df13204`; por eso la UI del contrareembolso está detrás de `COD_FEATURE_ENABLED` (default apagada → "Próximamente", PUT `codEnabled: true` → 422). Ver PENDIENTES.md. |
| **Límite de pedidos con Dashboard con Excel** | `process-dashboard-orders.job.ts` no lee `maxOrdersOverride`: `POST /api/v1/jobs` responde 422 si un tenant de Excel pide `maxOrders`/`testMode` y el Dashboard no ofrece los chips. Soporte en el worker: otro turno. |
| `shipmentCredits @default(10)` en el schema | No se toca (regla). Toda alta nueva pasa `TRIAL_SHIPMENTS` explícito; una alta futura que lo olvide regala 10. SQL propuesto para otro turno: `ALTER TABLE "Tenant" ALTER COLUMN "shipmentCredits" SET DEFAULT 5;` + cambiar el `@default` en los dos schemas. |
| `provisioning/dac-tenant` sigue regalando 10 | Fuera de D31 (alta manual de Adrian). Decidir si pasa a 5. |
| Whop: metadata en links de checkout | **No verificado** que un link estático acepte `metadata` o `?params`. Por eso el webhook resuelve por `purchaseId` → `userId` → email + único PENDING de 24 h, y **no acredita** si hay ambigüedad (log `[whop] compra no resuelta`). Camino para cerrarlo: crear checkout configurations por API con `metadata { purchaseId }` (PAGOS.md §3.1). |
| Whop: shape del payload (`type`, `data.id`, `data.user.email`) | Inferido de docs de memoria; los tests fijan el contrato que asumimos. Antes de prender el riel: un pago de prueba y comparar con el log (sin body). Ajustar los `??` de §7.5 pasos 9-11 al shape real. |
| Whop: moneda | Los packs son UYU; Whop cobra en USD. El precio del checkout en Whop lo fija Adrian a mano por pack; no hay FX. Desde la revisión 2026-09-02 el webhook **sí** exige que el plan pagado sea el del pack (`WHOP_PLAN_IDS`, §7.5 paso 11b) y, si la regla trae `minUsd`, monto en USD ≥ piso. La unidad de `final_amount` (dólares vs centavos) no está verificada: poner `minUsd` después del primer pago real. |
| Shopify Billing API | D30: la app es gratis en el App Store y se cobra afuera. Shopify exige Billing API para cobros de apps; Adrian lo asume. |
| Tenants legacy con `onboardingComplete=false` e `isActive=false` | Con H4 van al wizard (2 clicks) y al completar quedan `isActive=true`. Si alguno estaba pausado a propósito, se reactiva. Listar antes del deploy: `SELECT id, slug FROM "Tenant" WHERE "onboardingComplete"=false AND "isActive"=false AND "dacUsername" IS NOT NULL;` |
| Webhook instantáneo con token manual (H9) | No hay registro de webhooks fuera de OAuth/claim. El copy lo dice. Camino: botón "Reconectar con Shopify". |
| `read_customers` (D27) | Reglas `CUSTOMER_TAG` no matchean en tenants del App Store. Aviso en §6.2 bloque 3. |
| Test de DAC en vivo (H5) | No existe para usuarios. Circuit breaker de login fallido sigue en PENDIENTES (D26). |
| Google OAuth sin test de ruta | Se cubre con el test estructural de §3.5; un harness de NextAuth es otro turno. |
