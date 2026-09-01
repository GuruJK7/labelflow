# Decisiones — qué, por qué, cómo revertirlo

Registro exigido por la regla 3 del prompt maestro. Donde el prompt choca con lo
que ya está construido y verificado, gana lo verificado y se explica.

## D1 · El monedero se denomina en PLATA, no "1 Coin = 1 guía"
- **Prompt maestro:** 1 Coin = 1 guía; packs con precio fijo; bots con costo en Coins.
- **Decidido:** saldo en milésimos de UYU; el descuento por volumen se aplica **al consumir** (`periodTotalMilli`, monótona), no al comprar.
- **Por qué:** la revisión adversarial del 2026-09-01 mostró que "Coin = guía" + tramos abre dos fugas: (a) con rebates retroactivos, un depósito de 7.000 terminaba en 12.087 de saldo; (b) sin rebates, el sobrante de un pack barato compra bots al mismo precio en Coins que el pack caro → subsidio cruzado con COGS en USD. Con saldo en plata no hay conversión que arbitrar.
- **Cómo se ve para el cliente:** igual que Escalafy — "hacés N envíos por mes → te sale $X/mes". El simulador vive en `quote()`.
- **Revertir:** `tiers.ts` es puro; cambiar a packs fijos es reemplazar `periodTotalMilli` por lookup de pack. Los asientos no cambian.

## D2 · Se conservan los precios vigentes (20/17/15/12/10/7 UYU)
- No se inventan precios: el `[[COMPLETAR]]` de packs quedó vacío y **los precios reales ya existen** en `credit-packs.ts`. Se eliminan las cinco zonas muertas (43–49, 89–99, 201–249, 417–499, 701–999) con la regla "nunca más que el techo del tramo siguiente".
- **Revertir:** quitar el `min` en `periodTotalMilli`.

## D3 · Banco único en LabelFlow (Postgres de `web`), no en Supabase de AE/AB
- **Por qué:** el hecho facturable (la guía DAC) nace en el worker de LabelFlow; con el ledger en otra base hay un salto de red entre "hay guía" y "se cobró" (vuelve F1/F2 disfrazado). 2 de 3 jueces independientes.
- **Revertir:** el core es puro; la persistencia es un adaptador.

## D4 · Auth: NextAuth se queda (no Better Auth)
- Prompt: Better Auth "si no hay nada". Hay NextAuth con Google + email, reset de contraseña y verificación. Extender, no reescribir.

## D5 · Colas: se queda el polling en Postgres (no pg-boss)
- El worker ya reclama jobs con `FOR UPDATE SKIP LOCKED` y lease por tenant (`DacProcessingLease`). pg-boss sería una segunda cola sobre la misma base sin ganancia.

## D6 · Shopify: OAuth público como camino principal; token manual como fallback
- Prompt: camino A (token) principal. Ya existe app pública (`417965080577`, distribución pública, `oauth-inicial` activa) y el flujo App Store (PR #3). El token manual queda plegado en Settings porque hay tenants vivos conectados así.

## D7 · Trial: 5 por tienda, atado a `shopDomain` (unique) — pero HOY son 10 por cuenta
- `Tenant.shipmentCredits @default(10)` y `REFEREE_BONUS_CREDITS=10`. Bajar a 5 es un cambio de política comercial: **se documenta, no se aplica** hasta que Adrian lo confirme (los clientes vivos ya vieron "10").

## D8 · Whop = segundo riel, nunca reemplazo de MercadoPago
- Ver `docs/PAGOS.md`. 2,7 % + USD 0,30 fijo: ~20 % efectivo sobre un ticket de USD 2. No emite CFE/DGI.

## D9 · Migraciones: se escriben y se prueban, NO se aplican a prod en el mismo turno
- CLAUDE.md: prod es solo lectura; lo irreversible se marca 🔴 y se ejecuta en otro turno con OK.

## D10 · `app/uninstalled` no toca `isActive`
- `isActive` es el flag de facturación que lee el scheduler; apagarlo cortaba todas las fuentes del cliente y nada lo revertía. Se limpia sólo el token.

## D11 · Identidad en el App Store: `shop.email` NO es identidad; una cuenta existente RECLAMA la tienda logueada
- **Antes (PR #3 v1):** `provisionFromShopify` hacía upsert de User por el email de contacto de la tienda. Si ese email ya era cliente, la tienda se le colgaba sola. Ese email lo edita el comerciante y Shopify no lo verifica: cualquiera podía meter una tienda ajena en la cuenta de un cliente, o la tienda del comerciante quedaba bajo la cuenta de la agencia que le administra el admin.
- **Decidido:** tienda nueva + email sin cuenta → se crea User + Tenant (`created`). Tienda nueva + email CON cuenta → no se escribe nada (`claim`): el token viaja cifrado (misma primitiva AES-256-GCM que `shopifyToken`) en la cookie `shopify_pending_install` (httpOnly, 600 s, path `/api/shopify`) y el dueño la reclama en `GET /api/shopify/claim` con sesión, dentro de una transacción que re-verifica que la tienda siga libre. Tienda ya vinculada al User de ese email → `existing` (refresca token). Vinculada a otro → `conflict`.
- **Por qué cookie y no tabla:** D9 — nada de migraciones a prod en este turno. La cookie cifrada+autenticada da lo mismo con TTL gratis y sin token suelto en la base.
- **Revertir:** si algún día se agrega tabla `PendingShopifyInstall`, `sealPendingInstall/openPendingInstall` se reemplazan por insert/select; el resto del flujo no cambia.

## D12 · El mail de "elegí tu contraseña" sale SÓLO en `created`; `/entry` no reinicia OAuth si la tienda ya está conectada
- **Antes:** el callback mandaba `issueAndSendPasswordResetEmail` en `created` y en `existing`, y como Shopify carga la App URL en cada apertura desde el admin, cada apertura borraba los tokens de reset vigentes y mandaba otro mail (saltando el rate limit de 5/h del endpoint).
- **Decidido:** mail sólo con `alta.kind === 'created'`. En `/entry`, si existe Tenant con `shopifyStoreUrl == shop` y `shopifyToken` no nulo → `/login?shopify=open` sin pasar por `authorize`. Una tienda desinstalada (token en null por `app/uninstalled`) sí vuelve a instalar.
- **Etiqueta:** que Shopify pegue a la App URL en cada apertura es conocimiento estable de la plataforma, no reconfirmado hoy en shopify.dev. Si fuera falso, D12 sigue siendo correcto (reinstalar tampoco debe mandar un reset).

## D13 · Orden de la rama dashboard, higiene de cookies y destinos públicos
- **Rama B (dashboard):** sesión → propiedad → `shop_mismatch` → `already_linked` **antes** del canje del `code` (como en main). Un `code` canjeado emite un token offline vivo; nada que pueda fallar por permisos corre después del canje. La rama A canjea primero porque sin token no se puede preguntar de quién es la tienda.
- **Cookies:** `/install` borra `FLOW_COOKIE`; `/entry` borra `TENANT_COOKIE`; el callback rechaza `FLOW=appstore` + `TENANT` a la vez con `bad_flow`. Sin esto, un "Instalar" del App Store abandonado secuestraba el "Conectar" del dashboard dentro de los 10 minutos.
- **Destinos:** en flujo App Store todo (éxito, `fail()`, `missing_scopes`) aterriza en `/login?shopify=<motivo>`; nunca en `/settings` (rebota sin sesión y pierde el motivo). El email nunca va en la query. Los textos viven en `lib/shopify-messages.ts` (compartido por `/settings` y `/login`). `LoginForm` honra `?next=`/`?callbackUrl=` sólo si es ruta relativa (`safeRelativePath`): sin eso, `/login` sería un open redirect.

## D14 · Tenant aprovisionado desde Shopify: `apiKey` aleatoria, `referralCode`, `tosAcceptedAt` en null, slug con hash
- `apiKey = randomBytes(32).hex` y `referralCode` como en signup, vía `lib/tenant-provision.ts` (helper compartido; signup lo usa también). `cuid()` no es criptográficamente aleatorio y `apiKey` es credencial de la API pública.
- `tosAcceptedAt` queda **null**: el comerciante autorizó la app en Shopify, no aceptó nuestros términos. Verificado por grep que ningún gate lo lee (sólo se setea en signup, `/api/v1/tenants`, `dac-tenant` y auth Google). La aceptación en el primer login está en PENDIENTES.md.
- Slug: handle ≤ 40 → `shop-<handle>`; > 40 → `shop-` + 31 primeros + `-` + sha256(handle)[0:8]. Antes se truncaba a 40 y dos tiendas con el mismo prefijo colisionaban en `shop_taken`. `existingByShop` y el insert van en la misma transacción; `P2002` → `conflict`.

<!-- D15 está tomado en la rama feat/wallet-ledger (cutover del ledger): acá se salta para no chocar en el merge. -->

## D16 · `/entry` no distingue token OAuth de token manual: el cortocircuito se queda, la migración es por Reconectar
- **Hallazgo (re-revisión de seguridad, bajo):** `/api/shopify/entry` corta el OAuth si el tenant ya tiene `shopifyToken` (D12), también cuando ese token lo pegó a mano un cliente viejo desde su custom app. Para ese cliente, "Instalar" desde el App Store termina en `/login?shopify=open` y Shopify nunca registra la instalación pública.
- **Decidido:** no se cambia el comportamiento. Distinguir el origen del token exige una columna nueva (`shopifyTokenSource` o similar) y eso es migración a prod: D9 lo prohíbe en el mismo turno. Reiniciar OAuth siempre que la tienda ya esté conectada volvería a abrir lo que D12 cerró (aprovisionar y mandar mail en cada apertura desde el admin).
- **Camino de migración:** Settings → **Reconectar**, que sí pasa por `/install` → OAuth → `/callback` rama B y reemplaza el token manual por uno público. Está en PENDIENTES.md como tarea por cliente.
- **Revertir:** cuando exista la columna de origen, `/entry` pasa a cortocircuitar sólo con `shopifyTokenSource = 'oauth'`; el test "tienda ya vinculada con token vigente" cambia el `where`.

## D17 · Reclamar una tienda no la deja activa: el banner de /settings la nombra
- El tenant activo vive en el JWT y sólo cambia con `POST /api/v1/tenants/switch` + `useSession().update({ tenantId })` desde el cliente (`TenantSwitcher`). Un redirect de `/api/shopify/claim` no puede hacer eso, y no se inventa un mecanismo nuevo por URL para un caso de borde.
- `/claim` redirige a `/settings?shopify=connected&shop=<handle>`; Settings valida el handle (`shopHandleFromParam`, misma forma que `normalizeShopDomain`) y muestra "La tienda <handle> quedó conectada como tienda nueva: elegila en el selector…". Lo que no pasa la validación no se muestra: el banner verde de "conectada" es el peor lugar para texto que venga de la URL.
- **Otros ajustes del mismo ciclo:** el tenant reclamado nace con `shipmentCredits = 0` (el bonus es por usuario, igual que `POST /api/v1/tenants`); `/callback` en `claim` va directo a `/claim` (si hay sesión reclama en el acto; sin sesión `/claim` manda a `/login?shopify=claim&next=…`); la cookie pendiente se cifra con el prefijo `pending-install:v1:` para que un `shopifyToken` cifrado con la misma clave no abra como cookie; `already_linked` tiene texto propio en el login.

## D18 · `shopifyStoreUrl` se compara y se guarda en minúsculas; índice único parcial escrito, no aplicado
- **Hallazgo (revisión de seguridad, medio):** el camino manual (`PUT /api/v1/settings`, onboarding) aceptaba `MiTienda.myshopify.com` y lo guardaba tal cual; todo el flujo del App Store compara con el dominio normalizado en minúsculas. Para ese cliente, "Instalar" desde el App Store no lo encontraba: `/entry` arrancaba OAuth y `provisionFromShopify` creaba una segunda cuenta o un segundo tenant para la misma tienda → el scheduler despachaba cada pedido dos veces. El webhook (Shopify manda el dominio en minúsculas) sólo le pegaba al nuevo.
- **Decidido (código, sin migración):** (a) los dos zod hacen `.transform((s) => s.toLowerCase())` después del regex: ningún camino nuevo guarda mayúsculas. (b) Todas las búsquedas por dominio del flujo usan `{ equals: shop, mode: 'insensitive' }` (Prisma sobre Postgres): `/entry`, `/install`, `/callback` rama B (`tomadaPorOtro`), `provisionFromShopify` (`existingByShop`), `/claim` (`tomada`), el webhook `api/webhooks/shopify` y el nuevo chequeo de `settings PUT`. `shop_mismatch` en el callback compara en minúsculas: Reconectar es el camino de migración de los tokens manuales (D16) y un dominio viejo con mayúsculas no puede bloquearlo. Los tests prueban la propiedad con una tabla en memoria que evalúa el `where` (`fakeTenantFindFirst`), no sólo la forma del objeto.
- **Decidido (base, D9):** `apps/web/prisma/migrations/20260901180000_tenant_shop_domain_lower/migration.sql` con el `UPDATE … lower()` y `CREATE UNIQUE INDEX IF NOT EXISTS "Tenant_shopifyStoreUrl_key" … WHERE "shopifyStoreUrl" IS NOT NULL`, precedidos del SELECT de duplicados. 🔴 Sin aplicar; el repo no usa `prisma migrate` (la carpeta no existía), se corre a mano. `schema.prisma` no cambia: Prisma no expresa índices parciales y un `@unique` haría que `db push` intente otro índice.
- **Lo que sigue sin cubrir hasta aplicar el índice:** la carrera reclamo-vs-"Conectar del dashboard" (rama B chequea `tomadaPorOtro` fuera de transacción). Ventana de milisegundos, requiere dos flujos a la vez sobre la misma tienda.
- **Revertir:** si el índice parcial molesta, `DROP INDEX "Tenant_shopifyStoreUrl_key"`; el código insensible sigue siendo correcto sin él.

## D19 · `/claim` pregunta en el GET y escribe en el POST; sin token CSRF propio porque la cookie es `lax`
- **Hallazgo (bajo):** desde d2b9968 el callback mandaba directo a `/claim`, y `/claim` con sesión escribía en el acto. Eso ataba el token offline de la tienda a la sesión que hubiera en el navegador: en una máquina compartida (agencia que "ayuda a instalar", empleado, dueño anterior) la tienda quedaba bajo la cuenta equivocada y el dueño real recibía `already_linked` para siempre. Es el escenario de D11 reabierto por sesión en vez de por email.
- **Decidido:** `GET /api/shopify/claim` con sesión y cookie válida devuelve una página HTML mínima (server-rendered desde la ruta, sin JS externo, estilos inline) que dice "¿Vincular `<shop>` a la cuenta `<email>`?" con `<form method="post" action="/api/shopify/claim">` y un enlace "Entrar con otra cuenta" a `/api/auth/signout?callbackUrl=<encoded /login?shopify=claim&next=/api/shopify/claim>` (NextAuth 4.24: el GET de signout guarda `callbackUrl` en su cookie y el POST del botón "Sign out" redirige ahí; verificado en `core/init.js` + `core/lib/callback-url.js`). `POST` hace lo que hacía el GET: sesión + cookie + transacción + webhooks + borrar cookie + redirect. GET sin sesión sigue mandando a `/login?shopify=claim&next=/api/shopify/claim` con la cookie intacta. Shop y email pasan por `escapeHtml` (`lib/html-escape.ts`).
- **Por qué no hace falta token anti-CSRF:** la cookie pendiente es `sameSite=lax` con `path=/api/shopify`. Un navegador no adjunta una cookie lax a un POST iniciado desde otro sitio (lax sólo la manda en navegaciones top-level con método seguro), así que un formulario ajeno que apunte al POST llega sin cookie → `claim_expired`, sin tocar la base. La cookie de sesión de NextAuth es lax también, así que ese POST llega además sin sesión. El único POST que trae las dos es el del formulario que servimos nosotros.
- **Revertir:** si se quisiera exigir re-autenticación real, el botón "Vincular" pasa a ir a `/api/auth/signout?callbackUrl=…` siempre; el POST no cambia.

## D20 · Log de `/claim` sin valores de fila; `already_yours` cuando la tienda ya es del mismo usuario
- **Log:** `console.error('[shopify/claim]', { shop, userId, name, code, message })` con `message` entero SÓLO si el error es `Prisma.PrismaClientKnownRequestError` (P-xxxx: nunca trae valores de fila); para cualquier otro (p.ej. `PrismaClientValidationError`, que vuelca los args del `create` con el token cifrado y la apiKey) va la primera línea de `String(message)` recortada a 200 chars. El test rechaza con un `Error` cuyo message contiene `shpat_pend_XXX` y el valor de la cookie, y afirma que el log no los contiene: prueba la propiedad, no la forma.
- **`already_yours`:** el `findFirst` de la transacción selecciona `userId`; si la tienda ya es de un tenant del usuario de la sesión (la conectó por Reconectar o con token manual mientras la cookie vivía), `/claim` redirige a `/settings?shopify=already_yours&shop=<handle>` y Settings muestra "La tienda <handle> ya está conectada a tu cuenta: elegila en el selector." (sin handle válido, el texto genérico del diccionario). Antes decía "conectada a OTRA cuenta, escribinos": un ticket de soporte por cada caso. No aplica al login: `/claim` siempre exige sesión.
- **Comentario corregido:** `/claim` y `provisionFromShopify` decían "índice único" hablando de `shopifyStoreUrl`; el único índice es el del `slug` (determinista, `shop-<handle>`), y el `findFirst` en transacción es la otra mitad de la protección. Ahora lo dicen así, y apuntan a D18 por el índice real. Además, `settings PUT` hace el mismo `findFirst({ shopifyStoreUrl insensitive, id: { not: tenantId } })` → 409 que ya hacía `/install`.

## D21 · `settings PUT` sólo chequea duplicados de tienda cuando el dominio CAMBIA
- **Hallazgo (revisión de seguridad, alto):** el chequeo de D20 (`findFirst({ shopifyStoreUrl insensitive, id: { not: tenantId } })` → 409) saltaba siempre que el body trajera `shopifyStoreUrl`, y "Guardar token" de `/settings` lo manda SIEMPRE con el valor que cargó del GET. Un tenant que comparte tienda con otro no podía rotar ni pegar un token nuevo: 409 "conectada a otra cuenta" sin haber tocado el dominio. Compartir tienda no es hipotético ni ilegítimo: `94a6282` (incidente Aura 2026-05-08) documenta a "Alex" y "Nueva tienda" sobre la misma tienda y el worker lo contempla con `sharedTenantIds` (`process-orders.job.ts`). Y `/install` y `/callback` ya les devolvían `already_linked` desde main: el token manual era el único camino que les quedaba y el PR lo cerraba.
- **Decidido:** antes del `findFirst`, `findUnique({ where: { id: tenantId }, select: { shopifyStoreUrl } })`; si `actual.toLowerCase() === input` (el zod ya bajó el input a minúsculas, D18) se salta el chequeo de duplicados y se sigue con el UPDATE (que normaliza el dominio viejo a minúsculas). Si el dominio cambia, el chequeo es el de D20. La UI no cambia: seguir mandando el dominio junto al token es lo que dispara la verificación del token contra Shopify (`shop.json`) antes de guardarlo; mandarlo sólo "si difiere" habría guardado tokens sin verificar.
- **Tests:** `settings-route-shop-domain.test.ts`: tienda compartida (tenant-1 `MiTienda.myshopify.com`, tenant-ajeno `mitienda.myshopify.com`) + PUT con el mismo dominio y token → 200, sin consultar duplicados, `shop.json` consultado, dominio en minúsculas y token cifrado; el mismo tenant cambiando a un dominio de un tercero → 409; a uno libre → 200 con consulta.
- **Tensión abierta con D18:** el índice único parcial de `20260901180000_tenant_shop_domain_lower` haría IMPOSIBLE compartir tienda a nivel base. Si el SELECT de duplicados del encabezado devuelve filas y son intencionales (Aura), el índice no se puede aplicar tal cual: o se decide que compartir tienda deja de ser válido (y se limpia a mano), o se descarta el `CREATE UNIQUE INDEX` y queda sólo el `UPDATE … lower()`. Decisión de Adrian, no del código; anotado en PENDIENTES.
- **Revertir:** borrar el `findUnique` y el `sinCambio`; el 409 vuelve a saltar en cada "Guardar token".
