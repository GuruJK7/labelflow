# LabelFlow Production Audit — 2026-04-21

Auditor: Claude Opus 4.7 (repo read-only, sin WebSearch/WebFetch disponibles en esta sesión — las verificaciones externas se marcan como "no ejecutables en esta sesión").

Alcance: apps/worker, apps/web/app/api/webhooks/shopify, mac-mini-bridge, prisma schema, tests. Se priorizaron F1–F6 del plan.

## Resumen ejecutivo

- Hallazgos críticos (bloqueantes de prod): **7**
- Hallazgos altos (fix antes de escalar): **9**
- Hallazgos medios: **7**
- Observaciones/gaps: **5**

Los críticos se concentran en tres familias:
1. **Autenticación del webhook Shopify mal configurada** (usa el access token como HMAC secret) → firmas nunca verifican contra lo que Shopify firma.
2. **Idempotencia del webhook y del job** rota — enqueue crea Job nuevo por cada retry de Shopify, sin dedup por `X-Shopify-Webhook-Id`, y el worker no claimea jobs atómicamente.
3. **Plaintext-vs-cifrado confundido en persistencia del token**: lo que se guarda en `Tenant.shopifyToken` se usa como API token (header `X-Shopify-Access-Token`) Y como secret HMAC del webhook — son dos valores distintos en el modelo de Shopify.

---

## Críticos

### C-1: Webhook Shopify verifica HMAC contra el access token, no contra el shared secret
- **Certeza**: CONFIRMADO
- **Archivos**:
  - `apps/web/app/api/webhooks/shopify/route.ts:47-55`
  - `apps/web/app/api/webhooks/shopify/checkouts/route.ts:69-81`
- **Evidencia**:
  ```ts
  const tenant = await db.tenant.findFirst({ where: { shopifyStoreUrl: shopDomain, ... },
    select: { id: true, shopifyToken: true } });
  ...
  const shopifySecret = decrypt(tenant.shopifyToken);
  if (!verifyHmac(body, hmacHeader, shopifySecret)) { return 401; }
  ```
  `tenant.shopifyToken` (schema.prisma:68, comentario "Encrypted AES-256") es usado en `apps/worker/src/shopify/client.ts:8` como `X-Shopify-Access-Token` (o sea, el API token per-shop). Shopify firma webhooks con el **App Client Secret** (o webhook-specific secret cuando los creás vía API), NO con el access token.
- **Impacto**:
  - Si el tenant configuró correctamente el webhook en el Shopify admin: la firma calculada en nuestro extremo NO va a matchear (salvo coincidencia absurda). Todo webhook devuelve 401 → nunca se procesan órdenes por webhook. Es consistente con que el flujo principal sea el polling/cron (`process-orders.job.ts`).
  - Si alguien lo "arregló" pegando el access token como webhook secret en Shopify: entonces **el access token está expuesto en firmas HMAC de webhooks y puede ser robado o rotado por error**, y el sistema acepta webhooks firmados con él — pero si el tenant rota el access token, los webhooks dejan de funcionar silenciosamente.
  - En Shopify Partner/Embedded Apps: el secret compartido es `SHOPIFY_API_SECRET` (app-level), UNO por app, no per-tenant.
- **Reproducción**: disparar un test webhook desde el dashboard de Shopify del tenant → cualquier payload → siempre 401 "Invalid signature".
- **Fix recomendado**:
  1. Agregar `SHOPIFY_API_SECRET` al env del proyecto (y `shopifyWebhookSecret` opcional por tenant para instancias custom).
  2. Verificar contra ese secret, no contra el access token:
     ```ts
     const secret = process.env.SHOPIFY_API_SECRET!;
     if (!verifyHmac(body, hmacHeader, secret)) return 401;
     // recién ACÁ, buscar tenant por shopDomain (post-HMAC, ver C-6).
     ```

### C-2: Tenant enumeration antes de validar HMAC
- **Certeza**: CONFIRMADO
- **Archivo**: `apps/web/app/api/webhooks/shopify/route.ts:37-55` (idem en `checkouts/route.ts:46-81`)
- **Evidencia**: se hace `db.tenant.findFirst({ where: { shopifyStoreUrl: shopDomain, isActive: true, subscriptionStatus: 'ACTIVE' }})` ANTES de verificar HMAC. Si el tenant no existe o no está activo, devuelve 200 inmediatamente; si existe, sigue. Un atacante con cualquier header `x-shopify-shop-domain` puede enumerar qué shops están registrados observando latencia (findFirst existe vs no-existe, más el decrypt que corre sólo en el caso existente).
- **Impacto**: leak de qué shops son clientes. No crítico para confidencialidad del cliente, pero habilita targeting.
- **Fix**: mover la validación HMAC a usar un secret app-level (ver C-1) y hacerla ANTES del lookup de tenant. Tras HMAC OK, buscar tenant; si no existe, loguear y devolver 200 (Shopify no debe retryear).

### C-3: Webhook no deduplica por X-Shopify-Webhook-Id → retries crean Jobs duplicados
- **Certeza**: CONFIRMADO
- **Archivos**: `apps/web/app/api/webhooks/shopify/route.ts:57-63`, `apps/web/lib/queue.ts:9-66`
- **Evidencia**: el POST handler hace `await enqueueProcessOrders(tenant.id, 'WEBHOOK')`. `enqueueProcessOrders` hace `db.job.create(...)` — crea un nuevo Job cada llamada. No hay tabla `WebhookReceipt` ni `findUnique` por `x-shopify-webhook-id`. Shopify retryea agresivamente (hasta 48h con backoff) cuando la respuesta tarda >5s o devuelve non-2xx.
- **Impacto**:
  - Una misma orden puede generar N Jobs PENDING (uno por retry). Cada Job hace `findMany` de orders Shopify sin filtro por orderId → procesa todos los unfulfilled + dedup por `existingLabels` con `status: 'COMPLETED'`. El dedup protege contra doble guía EN ESTADO `COMPLETED`, pero si Job #1 creó la Label en `CREATED` (guia emitida, PDF no subido todavía), Job #2 re-procesa y el constraint `dacGuia @unique` tira, pero recién DESPUÉS de haber hecho un submit DAC adicional con el form re-llenado — riesgo de guía duplicada en DAC en la ventana entre guía emitida y Label `COMPLETED`.
  - Se ve esta ventana: en `process-orders.job.ts:129-143` el filtro excluye solamente `status: 'COMPLETED' AND dacGuia NOT LIKE 'PENDING-%'`. Un Label `status: 'CREATED'` (guía real, PDF no subido) NO se filtra → se reintenta.
- **Fix**:
  1. Tabla `ShopifyWebhookReceipt { id, webhookId @unique, topic, receivedAt }`. En el handler, `upsert` por `webhookId`; si ya existía, return 200 sin enqueue.
  2. Cambiar el filtro de `processedIds` a excluir también `CREATED` con `dacGuia NOT LIKE 'PENDING-%'`.

### C-4: Duplicate-guia risk: PENDING-${Date.now()} se persiste si el worker crashea tras submit DAC
- **Certeza**: CONFIRMADO
- **Archivos**:
  - `apps/worker/src/dac/shipment.ts:1940-1945` (asigna `guia = PENDING-${Date.now()}`)
  - `apps/worker/src/jobs/process-orders.job.ts:388-390, 416-447` (persiste Label después)
  - `apps/worker/src/jobs/reconcile.job.ts:1-157`
- **Evidencia**: el flujo es:
  1. `createShipment()` hace submit del form DAC (guía ya emitida en DAC).
  2. Intenta extraer guía del DOM. Si falla 3 veces, retorna `guia = "PENDING-${Date.now()}"`.
  3. Vuelve al job, recién allí `db.label.upsert({ dacGuia: result.guia, status: 'CREATED' })`.
  4. Si el proceso crashea/SIGKILL entre (1) y (3) → DAC tiene una guía real emitida, la DB no tiene Label → el próximo ciclo reprocesa la orden y genera OTRA guía DAC (duplicado → factura doble al tenant).
  5. Aun si no crashea, el Label persiste con `dacGuia = PENDING-1713...`. El reconcile.job.ts (docstring línea 7 promete "CREATED labels with PENDING guia → tries to find the real guia") NO LO IMPLEMENTA: solo hace retryable-error reset y stale-job cleanup. Los PENDING quedan para siempre.
- **Impacto**: guía fantasma en DAC cada vez que el OCR del DOM falla + crash posterior. Cuesta dinero al tenant por cada ocurrencia. El riesgo es proporcional al rate de `Execution context was destroyed` + OOM/SIGTERM por bucle de restart del browser cada 5 órdenes (`browser.ts:12`).
- **Reproducción**: en staging, `kill -9` el worker entre el click de Finalizar y el upsert del Label. Reiniciar → la orden se reprocesa, DAC genera nueva guía.
- **Fix**:
  1. Persistir una fila `PendingShipment { tenantId, shopifyOrderId, submitAttemptedAt }` ANTES del click Finalizar, con unique constraint `(tenantId, shopifyOrderId)`. En el próximo run, si existe, NO re-submit — marcar Label como `NEEDS_REVIEW` con "submit DAC emitted but guia extraction failed, inspect DAC historial manually".
  2. Implementar de verdad el step 2 que `reconcile.job.ts:7` promete: buscar en DAC historial la guía emitida hace X minutos sin match en DB.
  3. Envolver la secuencia en una transacción idempotente con retry seguro basada en un `idempotencyKey = sha256(tenantId + shopifyOrderId)` persistido ANTES del submit.

### C-5: Webhooks GDPR obligatorios de Shopify AUSENTES
- **Certeza**: CONFIRMADO (por ausencia: no hay rutas para los 3 topics GDPR en `apps/web/app/api/webhooks/shopify/`)
- **Archivos**: `apps/web/app/api/webhooks/shopify/` solo contiene `route.ts` (orders) y `checkouts/route.ts`.
- **Evidencia**: Shopify exige para toda App listada en App Store los 3 webhooks mandatory: `customers/data_request`, `customers/redact`, `shop/redact` (y `app/uninstalled` como best-practice). No existen esas rutas.
- **Verificación externa**: NO EJECUTABLE en esta sesión (sin WebSearch). Este requerimiento está vigente desde 2019 y no ha sido relajado (conocimiento previo del modelo, fecha de corte ene-2026). Recomendación: confirmar contra docs oficiales antes del listing.
- **Impacto**: rechazo inmediato del listing en Shopify App Store. Si la app es custom/private es opcional pero no hay compliance GDPR para data requests/redacts.
- **Fix**: crear las 3 rutas con HMAC correcto (ver C-1), implementar la lógica de borrado/export de datos del tenant.

### C-6: Dos procesos worker pueden reclamar el mismo Job (no atomic claim)
- **Certeza**: CONFIRMADO
- **Archivos**: `apps/worker/src/index.ts:43-73`, `apps/worker/src/jobs/process-orders.job.ts:62-68`, `.env.example:35` (`WORKER_CONCURRENCY=2`).
- **Evidencia**: `pollForJobs` hace `db.job.findFirst({ where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } })` sin `SELECT ... FOR UPDATE SKIP LOCKED`. Luego llama `processOrdersJob` que recién en la línea 64-67 hace `db.job.update({ status: 'RUNNING' })` — hay un gap entre el `findFirst` y el update donde otro worker puede leer lo mismo. Aunque hoy corra 1 replica, el env example dice `WORKER_CONCURRENCY=2`, y el diseño bulletin "run N workers" está implícito.
- **Impacto**: si corrés 2+ replicas Render, dos workers login simultáneamente en DAC con la misma cuenta (DAC rechaza segunda sesión o las colisionan), mismo `usedGuias` set in-memory distinto por proceso → NO garantiza "no reasignación" entre procesos, y en el peor caso DOS submits a DAC para la misma orden.
- **Fix**:
  ```sql
  -- claim atómico en una sola query
  UPDATE "Job" SET status='RUNNING', startedAt=now()
  WHERE id = (SELECT id FROM "Job" WHERE status='PENDING'
              ORDER BY createdAt FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING *;
  ```
  Y además, advisory lock por tenantId (`pg_try_advisory_lock(hashtext(tenantId))`) para serializar DAC sessions del mismo tenant entre procesos. El `usedGuias` in-memory es insuficiente: se debería consultar DB antes de cada submit.

### C-7: Timing attack en bridge server (length check anterior a timingSafeEqual)
- **Certeza**: CONFIRMADO
- **Archivo**: `mac-mini-bridge/bridge-server.mjs:49-57`
- **Evidencia**:
  ```js
  if (typeof header !== 'string' || header.length !== SECRET.length) return false;
  try { return timingSafeEqual(...); } ...
  ```
  El early return por length-mismatch leakea la longitud del secret. Low-severity por estar detrás de Tailscale, pero marcado CRÍTICO porque el flow es el camino hot de IA y el bridge tiene acceso a credenciales DAC vía spawn env.
- **Impacto**: con muchas pruebas un atacante en la tailnet puede deducir largo del secret. Combined con que el secret está en env vars del LaunchAgent (plist con permisos por defecto), el riesgo crece si la LAN es comprometida.
- **Fix**:
  ```js
  const a = Buffer.from(header || '', 'utf8');
  const b = Buffer.from(SECRET, 'utf8');
  // Pad al mismo largo para timingSafeEqual, luego comparar length adentro.
  if (a.length !== b.length) return timingSafeEqual(b, b) && false;
  return timingSafeEqual(a, b);
  ```
  Además, `inflight` es un contador no-atómico; check+increment tiene race (requires mutex/SharedArray). MAX_INFLIGHT=1 mitiga pero no elimina.

---

## Altos

### H-1: Hash de cache AI no incluye versión de diccionarios ni province
- **Certeza**: CONFIRMADO
- **Archivo**: `apps/worker/src/dac/ai-resolver.ts:389-397`
- **Evidencia**: `hashAddressInput` hashea `{ c: city, a1: address1, a2: address2, z: zip }`. NO incluye: `province`, versión de `mvd-street-ranges`, versión de `CITY_TO_DEPARTMENT`, versión del system prompt, `tenantId`.
- **Impacto**:
  1. Cambios a `mvd-street-ranges.ts` (hoy 548 LOC, activamente editado — ver git mtime) NO invalidan hits viejos con `dacAccepted=true`. El bug que arreglaste en el dict queda shadow-eado para clientes que ya resolvieron una vez.
  2. Dos órdenes con mismo `city/address1/address2/zip` pero diferentes `province` reciben la misma resolución (silencia correcciones cuando la customer explícitamente puso la province correcta).
  3. `AddressResolution.@@unique([tenantId, inputHash])` es multi-tenant pero ese tenantId ya está en la key compuesta; OK.
- **Fix**: agregar `v: DICT_VERSION` al JSON hasheado, bumpeando DICT_VERSION en cada edit de street-ranges o del system prompt. Incluir también `province` normalizado.

### H-2: AddressResolution no tiene TTL / expiresAt
- **Certeza**: CONFIRMADO
- **Archivo**: `apps/web/prisma/schema.prisma:653-696`
- **Evidencia**: no hay campo `expiresAt`; solo `createdAt`/`updatedAt`. El único check de staleness es `dacAccepted !== false` en el lookup (`ai-resolver.ts:1020`).
- **Impacto**: una resolución buena en 2025 (cuando X avenida era parte de barrio A) sigue usándose en 2027 aunque cambie la cartografía o los ranges.
- **Fix**: agregar `expiresAt DateTime?`, set default a 180 días. En lookup, filtrar `OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]`.

### H-3: `looksLikeUyPhone` acepta longitudes inválidas
- **Certeza**: CONFIRMADO
- **Archivo**: `apps/worker/src/rules/order-classifier.ts:49-55`
- **Evidencia**:
  ```ts
  return digits.length >= 7 && digits.length <= 13;
  ```
  Un teléfono móvil UY tiene 9 dígitos (09X XXX XXX), fijo Montevideo 8 dígitos (2X XX XX XX), fijo interior 8 (4X XX XX XX), +598 local 11 (sin 0 inicial), 00598 prefix 13. El rango 7-13 acepta:
  - 7 dígitos: inválido en UY salvo fijos muy viejos (raro hoy).
  - 10 dígitos: no existe formato UY (entre fijo con +598 = 11 y local sin code = 8 o 9).
- **Verificación externa**: rangos UY (Ursec/ANTEL) — NO EJECUTABLE en sesión (sin WebSearch). Este conocimiento es público y sólido, pero recomiendo confirmar.
- **Impacto**: clasifica como WEIRD_PHONE=false órdenes con teléfonos inválidos; DAC después los rechaza o los mete a "destinatario incontactable".
- **Fix**:
  ```ts
  const d = raw.replace(/\D/g, '');
  // Móvil local: 09XXXXXXX (9), Fijo: 2XXXXXXX/4XXXXXXX (8),
  // +598 móvil: 5989XXXXXXXX (12), +598 fijo: 598XXXXXXXX (11).
  // 00598 prefix: 005989... (14), 00598... (13).
  return [8, 9, 11, 12, 13, 14].includes(d.length) &&
         (d.startsWith('0') || d.startsWith('598') || d.startsWith('00598') || /^[0-9]/.test(d));
  ```

### H-4: `hasAptMarker` tiene falsos positivos
- **Certeza**: CONFIRMADO
- **Archivo**: `apps/worker/src/rules/order-classifier.ts:34-47`
- **Evidencia**: `APT_MARKERS` incluye `' bis'`, `' ter'`, `'casa '`, `'torre '`, `'block '`, `'cs '`, `'p.'`, `'p '`. Prueba mentales:
  - `"Rivera 2345 bis"` → contains ' bis' → APT_IN_ADDRESS1 = true (falso positivo; `bis` en UY es modificador de número de puerta legítimo).
  - `"Av. Brasil Ter"` → contains ' ter' → true (Ter = "Terrace" o "Tercero" de número, no apartamento).
  - `"Torres de Carrasco 1500"` → no contains 'torre ' (mayúscula y con 's'), el lower-casing hace match con `'torre '` → true (el edificio se llama Torres, no es marker de apto).
  - `"Casa Blanca 234"` → contains `'casa '` → true (barrio Casa Blanca de Paysandú).
  - `"Dr. P. Russo 5678"` → `'p.'` en el nombre → true.
- **Impacto**: órdenes GREEN clasificadas como YELLOW → se disparan calls al AI sin necesidad → costo.
- **Fix**: requerir contexto. `apto`/`apt`/`piso` deben ir precedidos por comma o número: `/\b(apto|apt|apartamento|piso|dpto|depto)\b\s*[\d.]/i`. Quitar `' bis'`/`' ter'` del set; son modifiers de número.

### H-5: `stripTrailingKnownPlaces` tiene 53 entradas vs ~540 en CITY_TO_DEPARTMENT
- **Certeza**: CONFIRMADO
- **Archivos**: `apps/worker/src/dac/shipment.ts:335-347` (53 entries), `apps/worker/src/dac/uruguay-geo.ts:15+` (~540 entries, contado con grep).
- **Evidencia**: ver el set `KNOWN_PLACES_FOR_STRIP` con 53 nombres vs la tabla canónica. Cualquier ciudad/barrio fuera de ese set NO se strippea del final de `address1` → queda duplicada en el delivery address y potencialmente confunde al courier.
- **Impacto**: direcciones "Calle X 1234, Las Toscas" donde "Las Toscas" no está en el set → `deliveryAddress = "Calle X 1234, Las Toscas"` + `city = "Las Toscas"`. El courier lee dos veces la localidad. En UY es menor porque los carteros ignoran redundancia, pero si el nombre es ambiguo (e.g. "Centro") se podría imprimir "Calle X 1234, Centro" y el centro de qué dept queda ambiguo.
- **Riesgo especial "Pocitos 1234"**: si la address1 es literalmente `"Pocitos 1234"` (raro pero posible — customer usa barrio como calle), `stripTrailingKnownPlaces` requiere coma, así que NO aplica aquí y la dirección se preserva. Pero si es `"Algún Calle 567, Pocitos"`, `Pocitos` se strippea porque está en KNOWN_PLACES → `"Algún Calle 567"`. OK. El riesgo es el opuesto: `"Avenida Hondo 234, Punta del Diablo"` ("Punta del Diablo" no está en el set 53) → no se strippea.
- **Fix**: importar `CITY_TO_DEPARTMENT` keys como `KNOWN_PLACES_FOR_STRIP`. Mantener guard contra strippear cuando el segmento es la ÚNICA cosa after un número (e.g. evitar convertir "Calle 1234, Sauce" en "Calle 1234" if "Sauce" es calle legítima — cross-check contra street presence).

### H-6: `mergeAddress` slash handling — casos no cubiertos
- **Certeza**: CONFIRMADO (por lectura de código)
- **Archivo**: `apps/worker/src/dac/shipment.ts:509-525`
- **Evidencia**: regex `(\d+)\s*\/\s*(\d+)\s*$/`. Cubre:
  - `"Herrera 1183/204"` → cleaned="Herrera 1183", obs="Apto 204". OK.
  - `"Herrera 1183 / 204"` → match (los `\s*` lo permiten). OK.
  No cubre:
  - `"Herrera 1183/B"` → letter after slash, regex exige `\d+` → no match → fullAddress="Herrera 1183/B" (apto letra queda pegado).
  - `"Herrera 1183-204"` → guión en vez de slash → no match.
  - `"Ruta 5 km 23/45"` → **match incorrecto** (extrae "45" como apto y deja "Ruta 5 km 23"). Bug: km nomenclature usa slash como rango.
- **Fix**:
  1. Aceptar letter: `(\d+)\s*\/\s*([\dA-Za-z]{1,4})\s*$/`.
  2. Guard contra `Ruta`/`km`: `if (/\bruta\b|\bkm\b/i.test(a1)) return { fullAddress: a1, extraObs: '' };` antes del slash-match.
  3. Aceptar guión como alternativa: `(\d+)\s*[\/-]\s*(\d+)`.

### H-7: `usedGuias` in-memory no protege entre procesos/ni persiste a reconcile
- **Certeza**: CONFIRMADO
- **Archivo**: `apps/worker/src/jobs/process-orders.job.ts:219-227`
- **Evidencia**:
  ```ts
  const existingGuias = await db.label.findMany({ where: { tenantId, dacGuia: { not: null } }, select: { dacGuia: true } });
  const usedGuias = new Set<string>(existingGuias.map(l => l.dacGuia!).filter(g => !g.startsWith('PENDING-')));
  ```
  Se hace UNA VEZ al inicio del job. Si otro proceso (reconcile, otro worker, manual retry) inserta un Label con guía mientras este job corre, `usedGuias` queda stale → puede elegir una guía ya asignada en `pickHighestGuia`. El DB unique constraint en `dacGuia` te salva del corrupt write, pero el submit DAC YA ocurrió → duplicate guía en DAC.
- **Fix**: consultar `db.label.findUnique({ where: { dacGuia: candidate }})` ANTES de aceptarla, dentro de una transacción que también haga el upsert del Label.

### H-8: Credenciales DAC pasadas en env vars al spawn son heredadas por cualquier child
- **Certeza**: CONFIRMADO
- **Archivos**: `apps/worker/src/agent/invoke-claude.ts:154-159` (spawn con DAC creds en env), `mac-mini-bridge/bridge-server.mjs:108` (spawn con `{ ...process.env }`).
- **Evidencia**:
  ```ts
  env: { ...process.env, DAC_USERNAME: ..., DAC_PASSWORD: tenant.dacPassword }
  ```
  Cualquier subproceso lanzado por Claude CLI hereda esas env vars. En el bridge, `process.env` del LaunchAgent incluye `LABELFLOW_BRIDGE_SECRET`, que ahora viaja a Claude CLI y todo lo que spawn dentro (Bash tool de la skill) puede leer via `printenv`.
- **Impacto**: un prompt-injection en la skill podría extraer DAC password + bridge secret. La skill tiene `allowed-tools` limitado a Read/Write/Bash — pero Bash puede `env`.
- **Fix**: filtrar env vars al spawn. Pasar sólo las necesarias:
  ```ts
  env: { PATH: process.env.PATH, HOME: process.env.HOME, DAC_USERNAME, DAC_PASSWORD }
  ```
  Y preferentemente NO pasar DAC creds a Haiku (el resolver de dirección no necesita loguearse a DAC — eso lo hace el worker después). Inspeccionando `invoke-claude.ts:259-392` (address correction), NO usa creds DAC; el que sí es `invokeClaudeForYellow` (línea 77), que hoy no se usa (diseño actual: Claude sólo corrige dirección, el worker hace el submit). Considerar borrar el path legacy.

### H-9: Cookies DAC se guardan como RunLog, sin cifrar, con retención infinita
- **Certeza**: CONFIRMADO
- **Archivo**: `apps/worker/src/dac/browser.ts:100-127, 133-160`
- **Evidencia**: `db.runLog.create({ data: { message: 'dac_cookies', meta: cookies }})`. `RunLog` no tiene TTL ni cleanup. El meta JSON incluye session cookies DAC (auth tokens de 4h). Se loguean en la misma tabla de auditoría que consultan los admins del dashboard.
- **Impacto**: cualquier lectura bulk de RunLog (que hoy se hace en `process-orders.job.ts:70-74` — `where: { message: { contains: 'maxOrdersOverride' }}` hace un full scan — más la UI del dashboard si muestra logs) expone cookies recientes. Las cookies vencidas (>4h) se ignoran al leer pero NO se borran.
- **Fix**:
  1. Campo dedicado `Tenant.dacCookies String? // Encrypted`, o tabla `DacSession { tenantId, cookies, expiresAt }`.
  2. Cifrar con `ENCRYPTION_KEY` (ya disponible).
  3. Cron de cleanup > 4h.

---

## Medios

### M-1: Reconcile step 2 (PENDING guia recovery) documentado pero no implementado
- **Certeza**: CONFIRMADO
- **Archivo**: `apps/worker/src/jobs/reconcile.job.ts:7, 113-132`
- **Evidencia**: docstring línea 7 dice *"CREATED labels with PENDING guia → tries to find the real guia in DAC historial"*. El código solo tiene step 1 (retryable errors) y step 3 (stale RUNNING jobs marcados como FAILED). Step 2 no existe.
- **Fix**: implementar. Query `Label.findMany({ where: { dacGuia: { startsWith: 'PENDING-' }, status: 'CREATED' }})`, para cada uno login DAC y buscar en historial por destino + fecha.

### M-2: Retry count de reconcile usa full-text scan sobre RunLog.message
- **Certeza**: CONFIRMADO
- **Archivo**: `apps/worker/src/jobs/reconcile.job.ts:75-80`
- **Evidencia**: `db.runLog.count({ where: { tenantId, message: { contains: 'auto-retry:...' }}})`. `RunLog.message` es un String sin index para text search → seq scan. Con decenas de miles de RunLog rows, se degrada.
- **Fix**: agregar `Label.autoRetryCount Int @default(0)` en schema. Incrementar en upsert de la rama de reconcile.

### M-3: Bridge inflight counter tiene race
- **Certeza**: CONFIRMADO
- **Archivo**: `mac-mini-bridge/bridge-server.mjs:178-208`
- **Evidencia**: `if (inflight >= MAX_INFLIGHT) return 429;` seguido MUCHO después (tras readBody + JSON.parse) por `inflight++`. Dos requests casi-simultáneos pueden pasar el check antes de que ninguna haya incrementado. Sin mutex.
- **Impacto**: MAX_INFLIGHT=1 sigue cumpliéndose "casi siempre" pero no garantizado. Bajo load podés tener 2 spawns Claude paralelos → consume doble CUPO de la subscription + colisión en paths `/tmp/labelflow-bridge-ctx-*` (ya usan `randomUUID`, al menos eso OK).
- **Fix**: check+increment atómico al principio, decrement en finally. Un `Promise` queue (p-limit o mutex simple) también sirve.

### M-4: TOCTOU entre classifyOrder + processOrder: la clasificación YELLOW dispara AI spend pero luego resolveAddressCorrection puede ser llamado más de una vez
- **Certeza**: PROBABLE
- **Archivo**: `apps/worker/src/jobs/process-orders.job.ts` (no llama a classify directamente en la ruta principal, sólo en bulk) + `ai-resolver.ts:1300+`
- **Evidencia**: el budget cap por tenant (`aiResolverDailyLimit=100`, `aiResolverDailyUsed`) se chequea sin lock, por lo que dos órdenes concurrentes del mismo tenant pueden pasar la gate ambas cuando `used == limit-1`. Además, el increment de `aiResolverDailyUsed` ocurre después del call (ver líneas ~1640-1657 — increment en el bloque de `aiCostUsd`). Gap lock-free = budget spillover.
- **Impacto**: tenant puede exceder su cap diario por unos pocos calls bajo concurrencia. No crítico pero puede sorprender en billing si hacés pay-as-you-go.
- **Fix**: `UPDATE Tenant SET aiResolverDailyUsed = aiResolverDailyUsed + 1 WHERE id = X AND aiResolverDailyUsed < aiResolverDailyLimit RETURNING aiResolverDailyUsed;` antes del call. Si rowcount=0 → over quota.

### M-5: No hay circuit breaker ni global budget cap para Anthropic API
- **Certeza**: CONFIRMADO
- **Archivo**: `apps/worker/src/dac/ai-resolver.ts:1414-1487`
- **Evidencia**: solo cap per-tenant (100/día default) y retry with exponential backoff hasta 4 intentos. No hay cap organizacional ni circuit breaker que corte cuando Anthropic 5xx persiste.
- **Fix**: variable `ANTHROPIC_DAILY_BUDGET_USD`. Trackear spend global en tabla. Breaker que abra por N min ante X fallas consecutivas.

### M-6: Scheduler timezone mixing (potencial off-by-one en borde de año)
- **Certeza**: HIPÓTESIS (código sugiere el bug pero el caso es raro)
- **Archivo**: `apps/worker/src/jobs/scheduler.ts:122`
- **Evidencia**:
  ```ts
  const todayKey = `${nowForReset.getUTCFullYear()}-${tzNow.month}-${tzNow.date}`;
  ```
  Usa UTC year + UY month + UY date. En 2025-01-01 00:30 UY = 2025-01-01 03:30 UTC → todo 2025-01-01, consistente. Pero si por algún corrimiento DST (Uruguay no lo aplica hoy, pero lo aplicó hasta 2015) o fallo de Intl, podría desincronizarse.
- **Impacto**: reset diario de quota podría correr dos veces o ninguna en el cambio de año.
- **Fix**: construir el date key 100% desde `tzNow`:
  ```ts
  const todayKey = `${tzNow.year}-${tzNow.month}-${tzNow.date}`;
  ```
  (agregar `year` al return de `toTimezone`).

### M-7: `new Date()` en código de negocio es local-server time (UTC en Render)
- **Certeza**: PROBABLE
- **Archivos**: ~28 archivos (ver grep). Ejemplos:
  - `process-orders.job.ts:217`: `tmpDir = path.join(..., new Date().toISOString().split('T')[0])` → directorio por "día UTC" no por día UY. Una orden procesada 2026-04-21 23:30 UY (= 02:30 UTC 22) escribe en carpeta `2026-04-22`.
  - `process-orders.job.ts:334-345`: ventanas de consolidation usan `Date.now()` — OK si la ventana es un offset (30 min), independiente de timezone.
  - `reconcile.job.ts:116`: `new Date(Date.now() - STALE_JOB_THRESHOLD_MS)` — OK.
- **Impacto**: logs/carpetas por "día" no coinciden con la percepción operador UY. Es cosmético pero dificulta auditoría. El cutoff de 14hs de DAC (mencionado en el prompt de auditoría) NO ESTÁ implementado en ningún lado del código — búsqueda vacía.
- **Fix**: usar `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo', year, month, day })` para fecha humana. Si hay cutoff DAC, implementarlo en scheduler.

---

## Observaciones / gaps

### O-1: Sin observabilidad de GREEN/YELLOW/RED por tenant
- No existe dashboard de classify ratios. La función `classifyOrders` devuelve un summary per-batch pero no se persiste ni expone.
- Sugerido: tabla `ClassifierMetric { tenantId, dayYmd, green, yellow, red }` actualizada por job.

### O-2: Sin alerta de saldo 2Captcha bajo
- `apps/worker/src/dac/auth.ts:11-29`: `solver.recaptcha(...)` no chequea saldo. Cuando 2Captcha se queda sin crédito, los logins empiezan a fallar sin aviso previo.
- Sugerido: call periódico a `solver.balance()` desde reconcile; alertar <$5.

### O-3: Credenciales en logs
- `apps/worker/src/dac/auth.ts:77,78`: `page.fill(LOGIN_USER_INPUT, username)` se loguea sólo con `slog.info` (no creds). OK.
- `agent/invoke-claude.ts:307-309`: el prompt no loguea creds. OK.
- NO encontré leaks obvios de DAC password en logs. Mantener auditoría.

### O-4: Test coverage — ausencias notables
Ver sección "Gaps de tests" más abajo.

### O-5: INE 2011 vs 2023
- `duplicate-city-tiebreaker.ts:19` cita "INE Uruguay 2011 census". El censo 2023 (publicado 2023-2024) tiene datos actualizados. Verificación externa NO EJECUTABLE en esta sesión. Recomiendo revisar al menos los 5 desempates más invertibles:
  - `la paz`: Canelones vs Colonia — sigue correcto con altísima probabilidad.
  - `bella vista`: Paysandú vs Maldonado — Maldonado creció fuerte con turismo post-2011.
  - `castillos`: Rocha vs Soriano — Rocha sigue siendo la principal.
  - `la pedrera`: Rocha — sigue correcto (balneario).
  - `cerro chato`: T y T — correcto.
- HIPÓTESIS: quizás 1-2 desempates se invierten con 2023. No bloqueante.

---

## Gaps de tests

Tests existentes (15 archivos, 71 describes): cubren mergeAddress, classifier básico, payment, shipping-rules, sanitizers, address-override, reconcile, thousand-tests (fuzz), real-orders-audit.

Tests FALTANTES con pseudocódigo:

1. **Webhook HMAC con secret correcto** (`route.ts`)
   ```ts
   it('rejects webhook when HMAC computed with access token (regression)', async () => {
     const body = '{}'; const secret = 'shopify-app-secret';
     const accessToken = 'shpat_xxxxxxxx';
     const hmac = crypto.createHmac('sha256', accessToken).update(body).digest('base64');
     const res = await POST(new Request(...)); expect(res.status).toBe(401);
   });
   ```

2. **Webhook idempotency** via `X-Shopify-Webhook-Id` — dos POST mismo webhook id → un solo Job.

3. **PENDING guia recovery** — simular crash entre submit y persistence; reiniciar; asegurar NO segundo submit.

4. **Atomic job claim** — 10 procesos polling concurrentes + 10 jobs PENDING → cada job procesado exactamente una vez.

5. **`looksLikeUyPhone` table-driven**:
   ```ts
   it.each([
     ['099123456', true], ['24005000', true], ['+59899123456', true],
     ['1234567', false], ['99123456', false], ['123456789012345', false],
   ])('%s -> %s', (raw, expected) => expect(looksLikeUyPhone(raw)).toBe(expected));
   ```

6. **`hasAptMarker` false positives**:
   ```ts
   it.each(['Casa Blanca 234', 'Torres de Carrasco 1500', 'Rivera 2345 bis',
            'Av. Brasil Ter', 'Dr. P. Russo 5678'])('no false positive: %s',
     s => expect(hasAptMarker(s)).toBe(false));
   ```

7. **`mergeAddress` slash edge cases**:
   - `"Herrera 1183/B"` → no debe extraer "B" como door; esperado `"Herrera 1183"` + `"Apto B"`.
   - `"Ruta 5 km 23/45"` → NO debe extraer "45"; esperado fullAddress sin split.
   - `"Herrera 1183-204"` → guión no-regex; decidir semantics.

8. **`stripTrailingKnownPlaces` coverage** — probar las ~540 entries de `CITY_TO_DEPARTMENT`, no sólo las 53 hardcoded.

9. **Cache hash versioning** — cambiar DICT_VERSION debe invalidar hits previos (una vez se implemente el fix H-1).

10. **Bridge concurrency** — 5 POSTs paralelos; espera exactamente 1 200 y 4 429s.

11. **Bridge auth length leak** — N requests con headers de distintos largos; sus latencias no correlacionan con el largo (stat test).

12. **Shopify 429 handling** — mock axios 429 con `Retry-After`; worker respetarla y reintentar.

13. **Reconcile step 2** — Label con `PENDING-*` guia + DAC historial con una guía emitida reciente → reconcile la matchea y upgrade a real guia.

14. **Timezone** — scheduler.ts en UTC midnight vs UY midnight; quota reset ocurre 1 sola vez por día UY.

15. **AddressResolution TTL** — inserto resolution con `expiresAt` en el pasado → lookup ignora; re-resolve dispara nuevo call.

---

## Verificaciones externas ejecutadas

**Ninguna** — WebSearch y WebFetch no estaban disponibles en esta sesión (aparecen como deferred tools que requieren schemas sólo post-fetch, pero la instrucción del auditor exige verificación contra docs oficiales).

Items que requieren confirmación externa:
- [PENDIENTE] Shopify mandatory GDPR webhooks (C-5): confirmar lista actual 2026 y si `app/uninstalled` es mandatory o recommended.
- [PENDIENTE] Shopify HMAC secret fuente oficial (C-1): confirmar que es el app secret y no el access token. (Conocimiento previo: sí, es el shared secret de la app.)
- [PENDIENTE] Uruguay phone ranges (H-3): confirmar rangos móviles Ursec.
- [PENDIENTE] INE Uruguay censo 2023 (O-5): verificar 5 desempates invertibles.
- [PENDIENTE] Anthropic rate limits y headers (ai-resolver retry logic asume 429/529 semantics — correcto per conocimiento previo).
- [PENDIENTE] 2Captcha API para balance check (O-2).

---

## Lo que NO pude auditar

1. **Prompt del system prompt** de ai-resolver — no leí el SYSTEM_PROMPT completo (está entre las líneas 500-750 del archivo). Podría tener rules inconsistentes o leakear info cross-tenant.
2. **Flujo Plexo completo** — `payment.ts` tiene 790 LOC; leí sólo el entry point en shipment.ts. Riesgo de que `paymentCardCvc` quede en memoria entre requests o se loguee en algún error path.
3. **DAC selectors actuality** — `selectors.ts` depende de DOM DAC; si DAC cambió selectores desde 2026-04, Playwright falla silenciosamente. No tengo modo de verificar contra site live.
4. **Supabase Storage config** — `uploadLabelPdf` usado pero no revisé permisos del bucket (RLS? signed URLs TTL?).
5. **MercadoPago webhook HMAC** — `apps/web/app/api/webhooks/mercadopago/route.ts` y `recover/subscription-webhook/route.ts` — no los audité, pero grep encuentra señales de verify signature; podrían tener bugs similares a C-1 (secret fuente distinto).
6. **Render deployment config** — no hay `render.yaml` visible; no pude verificar concurrency real, health checks, restart policy ni env var scope.
7. **Test de multi-tenant isolation** — no verifiqué que queries siempre filtren por `tenantId` en la web UI (solo en worker).
