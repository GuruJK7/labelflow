# LabelFlow — Estado Completo del Sistema
## Fecha: 27 marzo 2026

---

## 1. Que es LabelFlow

SaaS multi-tenant que automatiza la generacion de etiquetas de envio entre Shopify y DAC Uruguay.
Un operario de e-commerce que antes copiaba datos a mano entre Shopify y dac.com.uy, ahora configura sus credenciales en autoenvia.com y el sistema lo hace automaticamente cada 15 minutos.

**URL produccion:** https://autoenvia.com
**Dominio:** autoenvia.com (GoDaddy, nameservers Vercel)
**Repo:** https://github.com/GuruJK7/labelflow

---

## 2. Arquitectura

```
[Cliente]
    |
    v
[autoenvia.com] ← Vercel (Next.js 14)
    |                    |
    |            [Supabase PostgreSQL]
    |                    |
    |            [Upstash Redis]
    |                    |
    v                    v
[Worker] ← Render.com (Docker + Playwright)
    |
    |-- Login DAC (2Captcha para reCAPTCHA)
    |-- Llena formulario de envio
    |-- Extrae guia del cart
    |-- Marca pedido en Shopify (tag)
    |-- Envia email al cliente
    |
    v
[dac.com.uy] ← Chromium headless via Playwright
```

---

## 3. Stack Tecnologico

| Capa | Tecnologia | Version |
|------|-----------|---------|
| Frontend + API | Next.js (App Router) | 14.2.0 |
| UI | Tailwind CSS + custom dark theme | 3.x |
| Auth | NextAuth (Credentials + Google) | 4.24.0 |
| ORM | Prisma | 5.14.0+ |
| Base de datos | Supabase PostgreSQL | - |
| File storage | Supabase Storage | - |
| Cola | DB polling (fallback BullMQ) | - |
| Browser automation | Playwright (Chromium headless) | 1.50.0 |
| CAPTCHA solver | 2Captcha | API v2 |
| Billing | MercadoPago (PreApproval suscripciones) | SDK v2 |
| Email | Nodemailer (SMTP configurable) | 6.9.0 |
| Worker runtime | Node.js en Docker | 20+ |
| Web hosting | Vercel | Hobby plan |
| Worker hosting | Render.com | Starter $7/mes |
| Redis | Upstash | Free tier |
| Domain | GoDaddy | autoenvia.com |

---

## 4. Base de Datos (Prisma Schema)

### Modelos

**User** — Usuarios del SaaS (dueños de tienda)
- id, email, name, passwordHash, emailVerified, image
- Relacion: 1 User → 1 Tenant

**Tenant** — Una tienda Shopify = un tenant
- id, userId, name, slug
- Shopify: shopifyStoreUrl, shopifyToken (encriptado AES-256-GCM)
- DAC: dacUsername, dacPassword (encriptado)
- Email: emailHost, emailPort, emailUser, emailPass (encriptado), emailFrom, storeName
- Config: paymentThreshold (4000 UYU), cronSchedule, maxOrdersPerRun, isActive
- Billing: stripeCustomerId, stripeSubscriptionId, stripePriceId, subscriptionStatus, currentPeriodEnd
- Contadores: labelsThisMonth, labelsTotal, lastRunAt
- Compliance: signupIp, tosAcceptedAt

**Job** — Ejecucion del worker
- id, tenantId, bullJobId, type, status, trigger
- Metricas: totalOrders, successCount, failedCount, skippedCount, durationMs
- Estados: PENDING → RUNNING → COMPLETED/FAILED/PARTIAL
- Triggers: CRON, WEBHOOK, MANUAL, MCP

**Label** — Etiqueta de envio generada
- id, tenantId, jobId
- Shopify: shopifyOrderId, shopifyOrderName
- Cliente: customerName, customerEmail, customerPhone
- Envio: deliveryAddress, city, department, totalUyu, paymentType
- DAC: dacGuia (unique), pdfPath, pdfUrl
- Status: PENDING/CREATED/COMPLETED/FAILED/SKIPPED
- Email: emailSent, emailSentAt

**RunLog** — Logs de ejecucion
- id, tenantId, jobId, level, message, meta (JSON)
- Niveles: INFO, WARN, ERROR, SUCCESS

### Enums
- SubscriptionStatus: INACTIVE, TRIALING, ACTIVE, PAST_DUE, CANCELED, PAUSED
- JobStatus: PENDING, RUNNING, COMPLETED, FAILED, PARTIAL
- JobTrigger: CRON, WEBHOOK, MANUAL, MCP
- LabelStatus: PENDING, CREATED, COMPLETED, FAILED, SKIPPED
- PaymentType: REMITENTE, DESTINATARIO

---

## 5. Flujo de Procesamiento de Pedidos

```
1. TRIGGER (cron cada 15 min, webhook, manual, o MCP)
   → Crea Job con status PENDING en DB

2. WORKER (Render, polling DB cada 5s)
   → Detecta Job PENDING
   → Marca como RUNNING

3. CARGAR CONFIG
   → Lee tenant de DB
   → Desencripta shopifyToken, dacPassword con AES-256-GCM

4. SHOPIFY API
   → GET /admin/api/2024-01/orders.json
   → Filtra: paid + unfulfilled + sin tag "labelflow-procesado"
   → Filtra: excluye orders que ya tienen Label en DB
   → Aplica limite maxOrdersPerRun

5. DAC LOGIN (una vez por job)
   → Intenta reutilizar cookies guardadas en RunLog
   → Si cookies expiraron: login completo con 2Captcha
   → Navega a /usuarios/login
   → Llena documento (RUT) + password
   → Resuelve reCAPTCHA via 2Captcha API (~60-90 segundos)
   → Guarda cookies nuevas en RunLog para proximos runs

6. POR CADA PEDIDO (secuencial):
   a) REGLA DE PAGO
      → total > $4.000 UYU = REMITENTE (tienda paga)
      → total <= $4.000 UYU = DESTINATARIO (cliente paga)

   b) FORMULARIO DAC (/envios/nuevo) — 4 PASOS
      Step 1: TipoServicio=Mostrador, TipoGuia=pago, TipoEnvio=Paquete, TipoEntrega=Domicilio
      Step 2: Origen (pre-llenado de la cuenta DAC)
      Step 3: Destino — NombreD, TelD, Correo_Destinatario, DirD, K_Estado, K_Ciudad, K_Barrio
      Step 4: Cantidad=1, K_Tipo_Empaque=1 (chico 20x20x20)
      → Click .btnAdd (Agregar)

   c) VERIFICAR ENVIO
      → Navegar a /envios/cart
      → Buscar guia con patron 88XXXXXXXXXX
      → Si no encuentra: usar PENDING-timestamp

   d) GUARDAR EN DB (upsert por tenantId+shopifyOrderId)

   e) MARCAR EN SHOPIFY (agregar tag "labelflow-procesado")
      → Si falla (403 por permisos): non-fatal, continua

   f) EMAIL AL CLIENTE (si SMTP configurado)

   g) ESPERAR 500ms antes del siguiente pedido

7. FINALIZAR
   → Guardar cookies DAC
   → Cerrar browser
   → Actualizar Job con resumen
   → Actualizar labelsThisMonth en Tenant
```

---

## 6. DAC Automation — Detalles Tecnicos

### URLs confirmadas
- Login: https://www.dac.com.uy/usuarios/login
- Nuevo envio: https://www.dac.com.uy/envios/nuevo
- Cart/historial: https://www.dac.com.uy/envios/cart
- Rastreo: https://www.dac.com.uy/envios/rastrear

### Selectores confirmados (del DOM real)
```
LOGIN:
  #documento          → Campo RUT (NOT email)
  #password           → Campo password
  #btnLogin           → Boton login (type="button", NO submit)

FORMULARIO:
  select[name="TipoServicio"]   → 0=Mostrador, 1=Levante
  select[name="TipoEntrega"]    → 1=Agencia, 2=Domicilio
  input[name="TipoGuia"]        → Tipo pago (hidden, set via JS)
  select[name="TipoEnvio"]      → 1=Paquete, 2=Carta, 3=Sobre
  input[name="NombreD"]         → Nombre destinatario
  input[name="TelD"]            → Telefono destinatario
  input[type="email"]           → Email destinatario
  #DirD                         → Direccion destinatario
  select[name="K_Estado"]       → Departamento (1-19)
  select[name="K_Ciudad"]       → Ciudad (dinamico segun depto)
  select[name="K_Barrio"]       → Barrio (dinamico segun ciudad)
  input[name="Cantidad"]        → Cantidad bultos (default 1)
  select[name="K_Tipo_Empaque"] → Tamano (1=2kg 20x20x20)
  .btnAdd                       → Boton "Agregar" (agrega al cart)
  .btnSave                      → Boton "Finalizar envio"

FORM ACTION: /envios/SaveGuias (POST)
```

### reCAPTCHA
- DAC usa Google reCAPTCHA v2 en el login
- Se resuelve via 2Captcha API ($2.99/1000 resoluciones)
- Tiempo promedio: 60-90 segundos por resolucion
- Cookie persistence evita re-resolver en runs consecutivos

### Patron de guias DAC
- 12+ digitos empezando con 88 (ej: 882276654210)
- Se extraen del cart page (/envios/cart) despues del submit

---

## 7. PROBLEMAS ACTUALES (al 27 marzo 18:30 UY)

### PROBLEMA 1: Telefono no se llenaba
- **Causa:** Selector `TelefonoD` no existia, el campo real es `TelD`
- **Fix:** Commit `603b3b1` — agrega `input[name="TelD"]` como primer selector
- **Estado:** Fix pusheado, deploy manual en Render en progreso

### PROBLEMA 2: Boton Agregar invisible
- **Causa:** Sin telefono, DAC no permite avanzar de Step 3 a Step 4 donde Agregar es visible
- **Fix:** Mismo commit — al llenar TelD, el form avanza correctamente a Step 4
- **Estado:** Mismo deploy

### PROBLEMA 3: Guia falsa
- **Causa:** Regex `(\d{12,})` matcheaba cualquier numero largo del HTML (cookies, tracking IDs)
- **Fix:** Mismo commit — ahora navega al cart y busca solo numeros con patron `88\d{10,}`
- **Estado:** Mismo deploy

### PROBLEMA 4: Shopify 403 al agregar tag
- **Causa:** Token solo tiene `read_orders`, falta `write_orders`
- **Fix parcial:** Commit `7c420d8` — error non-fatal (no bloquea el envio)
- **Fix definitivo:** Actualizar permisos del token en Shopify Admin
- **Estado:** Fix parcial deployado, permisos pendientes del usuario

### PROBLEMA 5: Render no auto-deploya
- **Causa:** Auto-deploy estaba en "On Commit" pero no triggereaba
- **Fix:** Deploy manual desde Render Dashboard
- **Estado:** Deploy manual en progreso

---

## 8. Paginas del Dashboard

| Ruta | Pagina | Auth |
|------|--------|------|
| `/` | Landing page (venta) | Publica |
| `/login` | Login | Publica |
| `/signup` | Registro (con checkbox ToS) | Publica |
| `/onboarding` | Wizard 3 pasos post-registro | Auth |
| `/dashboard` | Home — stats, jobs, conexiones | Auth |
| `/orders` | Tabla de pedidos procesados | Auth |
| `/labels` | Historial de etiquetas | Auth |
| `/logs` | Logs de ejecucion en tiempo real | Auth |
| `/settings` | Config Shopify + DAC + Email + Reglas | Auth |
| `/settings/billing` | Planes MercadoPago, cancelar | Auth |
| `/terminos` | Terminos de Servicio | Publica |
| `/privacidad` | Politica de Privacidad (Ley 18.331) | Publica |

---

## 9. APIs

| Endpoint | Metodo | Auth | Funcion |
|----------|--------|------|---------|
| `/api/auth/[...nextauth]` | * | - | NextAuth handlers |
| `/api/auth/signup` | POST | - | Registro con bcrypt |
| `/api/v1/orders` | GET | JWT | Pedidos paginados del tenant |
| `/api/v1/labels/[id]` | GET | JWT | Detalle label + signed PDF URL |
| `/api/v1/jobs` | GET/POST | JWT | Listar/crear jobs |
| `/api/v1/settings` | GET/PUT | JWT | Config tenant (encripta sensibles) |
| `/api/v1/mcp` | POST | Bearer | MCP server (4 tools) |
| `/api/mercadopago/checkout` | GET | JWT | Crear suscripcion PreApproval |
| `/api/mercadopago/cancel` | POST | JWT | Cancelar suscripcion |
| `/api/webhooks/mercadopago` | POST | Firma HMAC | IPN pagos/suscripciones |
| `/api/webhooks/shopify` | POST | HMAC-SHA256 | Order paid trigger |
| `/api/webhooks/stripe` | POST | Stripe sig | Billing events (legacy) |

---

## 10. Variables de Entorno

### Vercel (web)
```
DATABASE_URL          → Supabase PostgreSQL connection string
DIRECT_URL            → Same (for Prisma migrations)
NEXTAUTH_SECRET       → JWT signing secret
NEXTAUTH_URL          → https://autoenvia.com
NEXT_PUBLIC_APP_URL   → https://autoenvia.com
ENCRYPTION_KEY        → 32-byte hex for AES-256-GCM
APP_NAME              → AutoEnvia
UPSTASH_REDIS_REST_URL    → Upstash REST endpoint
UPSTASH_REDIS_REST_TOKEN  → Upstash REST token
REDIS_URL             → rediss://...@upstash (for BullMQ)
MERCADOPAGO_ACCESS_TOKEN      → APP_USR-... (production)
NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY → APP_USR-... (public)
MERCADOPAGO_WEBHOOK_SECRET    → HMAC secret for webhooks
```

### Render (worker)
```
DATABASE_URL          → Same Supabase connection
ENCRYPTION_KEY        → Same 32-byte hex
REDIS_URL             → Same rediss://...@upstash
WORKER_CONCURRENCY    → 2
PLAYWRIGHT_HEADLESS   → true
LABELS_TMP_DIR        → /tmp/labelflow
CAPTCHA_API_KEY       → 2Captcha API key
NEXT_PUBLIC_SUPABASE_URL → Supabase URL (for storage)
SUPABASE_STORAGE_BUCKET  → labels
```

---

## 11. Seguridad

- **Credenciales:** AES-256-GCM (iv:tag:ciphertext hex format)
- **Tenant isolation:** Toda query incluye tenantId en WHERE
- **Auth:** NextAuth JWT sessions, middleware protege rutas
- **Webhooks:** HMAC verification (Shopify, MercadoPago)
- **MCP:** Bearer token auth (apiKey 64-char hex)
- **Passwords:** bcrypt hash en DB
- **PDFs:** Signed URLs con expiracion (Supabase Storage)
- **Logs:** maskEmail(), maskToken() para datos sensibles
- **Legal:** ToS + Privacy Policy (Ley 18.331, Ley 17.250 Uruguay)
- **Signup:** IP registrada + ToS acceptance timestamp

---

## 12. Servicios y Costos

| Servicio | Plan | Costo | Funcion |
|----------|------|-------|---------|
| Vercel | Hobby | Gratis | Web hosting |
| Render | Starter | $7/mes | Worker Docker |
| Supabase | Free | Gratis | PostgreSQL + Storage |
| Upstash | Free | Gratis | Redis |
| 2Captcha | Pay-per-use | ~$3/1000 | CAPTCHA solving |
| GoDaddy | Domain | ~$12/ano | autoenvia.com |
| MercadoPago | Comision | ~3.5% + IVA | Billing |
| **TOTAL** | | **~$8/mes + dominio** | |

---

## 13. Estructura de Archivos

```
labelflow/
├── apps/
│   ├── web/                          # Next.js 14 (Vercel)
│   │   ├── app/
│   │   │   ├── (auth)/login, signup
│   │   │   ├── (dashboard)/dashboard, orders, labels, logs, settings, billing
│   │   │   ├── onboarding/
│   │   │   ├── terminos/, privacidad/
│   │   │   ├── api/auth, v1/*, webhooks/*, mercadopago/*
│   │   │   └── page.tsx (landing)
│   │   ├── components/layout/Sidebar.tsx
│   │   ├── lib/
│   │   │   ├── auth.ts, db.ts, cn.ts, api-utils.ts
│   │   │   ├── encryption.ts (AES-256-GCM)
│   │   │   ├── queue.ts (BullMQ + DB fallback)
│   │   │   ├── mercadopago.ts (PreApproval client)
│   │   │   ├── stripe.ts (legacy)
│   │   │   ├── supabase.ts (Storage)
│   │   │   └── mcp-server.ts (4 tools)
│   │   ├── prisma/schema.prisma
│   │   └── middleware.ts
│   │
│   └── worker/                       # Docker en Render
│       ├── src/
│       │   ├── index.ts (DB polling consumer)
│       │   ├── config.ts (Zod validation)
│       │   ├── db.ts, encryption.ts, logger.ts, utils.ts
│       │   ├── dac/
│       │   │   ├── auth.ts (login + 2Captcha + cookie persistence)
│       │   │   ├── browser.ts (Playwright singleton)
│       │   │   ├── shipment.ts (form automation 4 steps)
│       │   │   ├── label.ts (PDF download)
│       │   │   ├── selectors.ts (ALL CSS selectors)
│       │   │   └── types.ts
│       │   ├── shopify/client.ts, orders.ts, types.ts
│       │   ├── jobs/process-orders.job.ts, scheduler.ts
│       │   ├── notifier/email.ts, templates.ts
│       │   ├── rules/payment.ts
│       │   └── storage/upload.ts
│       ├── Dockerfile
│       └── prisma/ (copy of web schema)
│
├── packages/shared/ (types + utils)
├── CONTEXT.md
├── STATUS.md (este archivo)
└── README.md
```

---

## 14. Historial de Envios Reales en DAC

### Batch 1 (27 marzo, 07:33-07:47) — 14 envios exitosos
Creados con codigo anterior (antes de los bugs de upsert).
Todos aparecen en dac.com.uy/envios con Remitente: Luciano, Oficina: Internet.

### Batch 2 (27 marzo, 11:32) — 1 envio exitoso
Maria Jose Mancilla, guia 882276712621, Maldonado.

### Batch 3 (27 marzo, 13:16-13:36) — 12 envios exitosos
Desde Betina Rodriguez hasta Fabiana Perez Frederico.

### Post-13:36 — 0 envios nuevos
El codigo cambio (DOM inspection, submit strategies) y rompio el flujo.
El boton Agregar quedaba invisible y el submit no funcionaba.

---

## 15. Que falta para produccion

1. **Deploy del fix de telefono/submit/guia** (en progreso en Render)
2. **Verificar 1 envio real** que aparezca en DAC con hora actual
3. **Actualizar permisos Shopify** a write_orders (usuario debe hacerlo)
4. **Configurar SMTP** para emails al cliente (opcional)
5. **Primer cliente real** que pague via MercadoPago
6. **Monitorear** saldo 2Captcha y renovar cuando baje
