# LabelFlow -- Complete System Context

## 1. System Overview

LabelFlow is a multi-tenant SaaS that automates shipping label generation between Shopify e-commerce stores and DAC Uruguay (a Uruguayan courier service that has no API). The system polls Shopify for paid unfulfilled orders, uses headless Chromium via Playwright to log into dac.com.uy and create shipments through their web forms, downloads the resulting PDF labels, uploads them to Supabase Storage, tags orders in Shopify as processed, and emails customers their tracking numbers. The product is sold as a monthly subscription via MercadoPago (Uruguay) with three tiers (Starter/Growth/Pro) and is marketed at autoenvia.com.

---

## 2. Architecture Diagram

```
                         +---------------------+
                         |   autoenvia.com     |
                         |   (Vercel)          |
                         |   Next.js 14        |
                         |   App Router        |
                         +--------+------------+
                                  |
                 +----------------+----------------+
                 |                |                 |
        +--------v----+  +-------v-------+  +------v--------+
        | Supabase    |  | Upstash       |  | MercadoPago   |
        | PostgreSQL  |  | Redis         |  | PreApproval   |
        | (Prisma)    |  | (BullMQ)      |  | Subscriptions |
        | + Storage   |  | Queue         |  | Webhooks      |
        +--------+----+  +-------+-------+  +---------------+
                 |                |
                 |     +----------v----------+
                 +---->|   Worker            |
                       |   (Railway/Docker)  |
                       |   DB Polling + cron |
                       |   Playwright        |
                       +----------+----------+
                                  |
                       +----------v----------+
                       |   dac.com.uy        |
                       |   (Chromium         |
                       |    headless)        |
                       +---------------------+

External integrations:
  - Shopify Admin API (REST, read/write orders)
  - 2Captcha (reCAPTCHA v2 solving for DAC login)
  - SMTP (configurable per-tenant, typically Gmail App Password)
  - Stripe (alternative billing, partially implemented)

Data flow:
  1. Trigger: Cron schedule, Shopify webhook, manual button, or MCP tool call
  2. Job record created in PostgreSQL (status=PENDING)
  3. Optionally enqueued to BullMQ via Redis (best-effort)
  4. Worker polls DB for PENDING jobs every 5 seconds
  5. Worker fetches Shopify orders, opens Chromium, creates DAC shipments
  6. PDF downloaded locally, uploaded to Supabase Storage
  7. Shopify order tagged "labelflow-procesado" + note with guia number
  8. Customer emailed with tracking info via tenant's SMTP
  9. Job updated with final counts (success/failed/skipped)
```

---

## 3. Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Frontend + API | Next.js 14 (App Router, TypeScript) | Full-stack React framework with API routes |
| UI | Tailwind CSS + shadcn-style components | Utility-first CSS, dark theme throughout |
| Icons | lucide-react | Consistent icon set |
| Auth | NextAuth v4 (Credentials + Google OAuth) | JWT sessions, 7-day expiry |
| Password hashing | bcryptjs (12 rounds) | Industry standard for credential storage |
| Database | PostgreSQL via Supabase | Managed Postgres with connection pooling |
| ORM | Prisma 5.14+ | Type-safe database queries, migrations |
| File storage | Supabase Storage (bucket: "labels") | PDF label storage with signed URLs |
| Queue | BullMQ + Upstash Redis | Job queue (with DB polling as fallback) |
| Browser automation | Playwright 1.50 (Chromium headless) | Automates DAC web forms |
| CAPTCHA solving | 2captcha-ts (2Captcha service) | Solves reCAPTCHA v2 on DAC login |
| Billing (primary) | MercadoPago (PreApproval subscriptions) | Uruguayan payment processor, UYU currency |
| Billing (secondary) | Stripe (Checkout + Portal + Webhooks) | International billing alternative |
| Email | Nodemailer (per-tenant SMTP config) | Sends tracking notifications to customers |
| Encryption | Node.js crypto (AES-256-GCM) | Encrypts sensitive credentials at rest |
| Validation | Zod | Schema validation for API inputs and config |
| Logging (worker) | pino | Structured JSON logging |
| MCP | Custom Streamable HTTP (JSON-RPC 2.0) | Claude Desktop integration for AI control |
| Monorepo | npm workspaces | apps/web + apps/worker + packages/shared |
| Deploy (web) | Vercel | Serverless Next.js hosting |
| Deploy (worker) | Railway (Docker) | Long-running worker with Playwright |
| Package manager | pnpm (recommended) / npm | Dependency management |

---

## 4. Infrastructure

| Service | Purpose | Notes |
|---------|---------|-------|
| Vercel | Web app hosting (autoenvia.com) | Next.js 14, serverless functions |
| Supabase | PostgreSQL database + file storage | Connection pooler required for serverless |
| Upstash | Redis (managed, serverless-compatible) | BullMQ queue backend |
| Railway | Worker hosting (Docker) | Runs Playwright Chromium container |
| MercadoPago | Subscription billing (UYU) | PreApproval API for recurring charges |
| Stripe | Alternative billing (USD) | Checkout Sessions + Customer Portal |
| 2Captcha | reCAPTCHA solving service | ~$3/1000 solves, used only when cookies expire |
| GoDaddy | Domain registration (autoenvia.com) | DNS pointed to Vercel |

---

## 5. Database Schema

### Models

#### User
Authentication identity. One user has one tenant.
- `id` (String, cuid, PK)
- `email` (String, unique)
- `name` (String?)
- `passwordHash` (String?) -- bcrypt hash, null for OAuth users
- `emailVerified` (DateTime?)
- `image` (String?)
- `createdAt` / `updatedAt`
- Relations: accounts[], sessions[], tenant?

#### Account
OAuth provider accounts (Google).
- `id` (String, cuid, PK)
- `userId` -> User
- `type`, `provider`, `providerAccountId`
- OAuth tokens: `refresh_token`, `access_token`, `expires_at`, `token_type`, `scope`, `id_token`, `session_state`
- Unique: [provider, providerAccountId]

#### Session
NextAuth sessions (JWT strategy, so this table is mostly unused).
- `id`, `sessionToken` (unique), `userId` -> User, `expires`

#### Tenant
Core multi-tenant entity. One per user. Holds all configuration.
- `id` (String, cuid, PK)
- `userId` (String, unique) -> User
- `name`, `slug` (unique), `apiKey` (unique, hex-encoded 32 bytes)
- **Shopify config**: `shopifyStoreUrl`, `shopifyToken` (AES-256 encrypted)
- **DAC config**: `dacUsername`, `dacPassword` (AES-256 encrypted)
- **Email config**: `emailHost`, `emailPort` (default 587), `emailUser`, `emailPass` (encrypted), `emailFrom`, `storeName`
- **Processing config**: `paymentThreshold` (Float, default 4000 UYU), `cronSchedule` (String, default "*/15 * * * *"), `maxOrdersPerRun` (Int, default 20), `isActive` (Boolean, default false)
- **Billing** (reuses Stripe column names for MercadoPago too): `stripeCustomerId`, `stripeSubscriptionId` (prefixed "mp_sub_" for MercadoPago), `stripePriceId` (stores plan ID like "starter"), `subscriptionStatus` (enum), `currentPeriodEnd`
- **Usage**: `labelsThisMonth` (Int, default 0, reset on invoice.paid/payment approved), `labelsTotal` (Int), `lastRunAt`
- Indexes: slug, stripeCustomerId, apiKey

#### Job
Represents a single processing run.
- `id` (cuid, PK), `tenantId` -> Tenant
- `bullJobId` (String?, unique) -- BullMQ job ID if enqueued via Redis
- `type`: PROCESS_ORDERS | RETRY_FAILED
- `status`: PENDING | RUNNING | COMPLETED | FAILED | PARTIAL
- `trigger`: CRON | WEBHOOK | MANUAL | MCP
- `startedAt`, `finishedAt`, `durationMs`
- `totalOrders`, `successCount`, `failedCount`, `skippedCount`
- `errorMessage`
- Index: [tenantId, createdAt DESC]

#### Label
One record per Shopify order processed.
- `id` (cuid, PK), `tenantId` -> Tenant, `jobId` -> Job?
- `shopifyOrderId`, `shopifyOrderName` (e.g., "#1234")
- `customerName`, `customerEmail`, `customerPhone`
- `deliveryAddress`, `city`, `department`
- `totalUyu` (Float), `paymentType`: REMITENTE | DESTINATARIO
- `dacGuia` (String?, unique) -- DAC tracking number
- `pdfPath` (Supabase Storage path), `pdfUrl`
- `status`: PENDING | CREATED | COMPLETED | FAILED | SKIPPED
- `errorMessage`, `emailSent`, `emailSentAt`
- Unique: [tenantId, shopifyOrderId]
- Indexes: [tenantId, createdAt DESC], [dacGuia]

#### RunLog
Detailed log entries per job execution.
- `id` (cuid), `tenantId` -> Tenant, `jobId` -> Job?
- `level`: INFO | WARN | ERROR | SUCCESS
- `message` (String)
- `meta` (Json?) -- arbitrary structured data
- Also used for cookie storage (message="dac_cookies", meta=cookie array)
- Index: [tenantId, createdAt DESC]

### Enums
- `SubscriptionStatus`: INACTIVE, TRIALING, ACTIVE, PAST_DUE, CANCELED, PAUSED
- `JobType`: PROCESS_ORDERS, RETRY_FAILED
- `JobStatus`: PENDING, RUNNING, COMPLETED, FAILED, PARTIAL
- `JobTrigger`: CRON, WEBHOOK, MANUAL, MCP
- `LabelStatus`: PENDING, CREATED, COMPLETED, FAILED, SKIPPED
- `PaymentType`: REMITENTE, DESTINATARIO
- `LogLevel`: INFO, WARN, ERROR, SUCCESS

---

## 6. Authentication Flow

### Signup
1. User submits name/email/password to `POST /api/auth/signup`
2. Zod validates: name (1-100 chars), email (valid), password (8-100 chars)
3. Checks for existing user by email (returns 409 if exists)
4. Password hashed with bcryptjs (12 rounds)
5. User + Tenant created in a single Prisma create (nested)
6. Tenant gets: slug from email prefix + timestamp, apiKey from 32 random bytes hex
7. Redirects to `/login?registered=true`

### Login (Credentials)
1. User submits email/password to NextAuth credentials provider
2. Looks up user by email (lowercased)
3. Compares password against stored bcrypt hash
4. Returns user object {id, email, name}

### Login (Google OAuth)
1. Redirects to Google consent screen
2. On callback, NextAuth signIn hook checks if user exists
3. If new user: creates User + Tenant automatically
4. If existing: links account

### Session (JWT)
- Strategy: JWT (not database sessions)
- MaxAge: 7 days
- JWT callback enriches token with: tenantId, tenantSlug, isActive, subscriptionStatus
- Session callback copies these to the session.user object
- All protected API routes call `getAuthenticatedTenant()` which reads session via `getServerSession()`

### Middleware
- File: `apps/web/middleware.ts`
- Public paths: /login, /signup, /onboarding, /api/auth, /api/webhooks, /api/v1/mcp, /_next, /favicon.ico, /
- Protected paths: /dashboard, /orders, /labels, /logs, /settings, /api/v1, /api/stripe, /api/mercadopago
- For protected API routes: returns 401 JSON
- For protected pages: redirects to /login?callbackUrl=...
- MCP endpoint uses its own Bearer token auth (tenant.apiKey), not NextAuth

---

## 7. Billing Flow

### MercadoPago (Primary -- Uruguay)

**Plans:**
| Plan | Price UYU | Price USD | Label Limit |
|------|-----------|-----------|-------------|
| Starter | $600/mo | ~$15/mo | 100/month |
| Growth | $1,400/mo | ~$35/mo | 500/month |
| Pro | $2,760/mo | ~$69/mo | Unlimited |

**Subscription Flow:**
1. User clicks plan on `/settings/billing`
2. Frontend redirects to `GET /api/mercadopago/checkout?plan=growth`
3. Server creates a PreApproval (recurring subscription) via MercadoPago SDK
   - `external_reference`: `{tenantId}|{planId}` (used to identify tenant on webhook)
   - `auto_recurring`: monthly, UYU currency
   - `back_url`: /settings/billing
4. User redirected to MercadoPago checkout (init_point URL)
5. User authorizes recurring payment on MercadoPago
6. MercadoPago sends webhook to `POST /api/webhooks/mercadopago`

**Webhook Handling (`/api/webhooks/mercadopago`):**
- Accepts both new-style JSON (`type: "subscription_preapproval"`) and legacy IPN (`topic=preapproval`)
- Fetches full preapproval from MercadoPago API
- Parses `external_reference` to get tenantId and planId
- Status mapping:
  - `authorized` -> ACTIVE, isActive=true, labelsThisMonth=0
  - `paused` -> PAST_DUE, isActive=false
  - `cancelled` -> CANCELED, isActive=false
  - `pending` -> no change (logged)
- Also handles `payment` notifications for recurring charges (extends period by 30 days)

**Subscription stored as:**
- `stripeSubscriptionId`: `mp_sub_{preapprovalId}` (prefixed to identify as MercadoPago)
- `stripeCustomerId`: MercadoPago payer_id
- `stripePriceId`: plan ID (e.g., "starter", "growth", "pro")

**Cancellation:**
- `POST /api/mercadopago/cancel`
- Extracts preapproval ID from stored subscription ID
- Calls MercadoPago PreApproval.update with status="cancelled"
- Sets tenant to CANCELED, isActive=false

### Stripe (Secondary -- International)

**Plans:**
| Plan | Stripe Price ID | Limit |
|------|-----------------|-------|
| Starter | STRIPE_PRICE_STARTER env var | 100/month |
| Growth | STRIPE_PRICE_GROWTH env var | 500/month |
| Pro | STRIPE_PRICE_PRO env var | Unlimited |

**Checkout Flow:**
1. `GET /api/stripe/checkout?plan=growth`
2. Creates or retrieves Stripe customer
3. Creates Checkout Session (subscription mode)
4. Redirects to Stripe-hosted checkout

**Webhook Events (POST /api/webhooks/stripe):**
- `checkout.session.completed`: Activates subscription
- `invoice.paid`: Renews period, resets labelsThisMonth to 0
- `invoice.payment_failed`: Sets PAST_DUE
- `customer.subscription.deleted`: Sets CANCELED, isActive=false
- `customer.subscription.updated`: Syncs status and price

**Portal:**
- `GET /api/stripe/portal` -> redirects to Stripe Customer Portal

---

## 8. Order Processing Flow

Step-by-step from trigger to completed label:

### 1. Trigger (one of four)
- **Cron**: Scheduler checks every minute, finds tenants whose cronSchedule matches, creates PENDING Job
- **Webhook**: Shopify `orders/paid` webhook -> verifies HMAC -> creates PENDING Job via `enqueueProcessOrders()`
- **Manual**: User clicks "Ejecutar ahora" on dashboard -> `POST /api/v1/jobs` -> creates PENDING Job
- **MCP**: Claude calls `process_pending_orders` tool -> creates PENDING Job

### 2. Job Creation
- Job record created in PostgreSQL with status=PENDING
- Optionally pushed to BullMQ via Redis (best-effort, serverless-safe)
- If Redis unavailable, job stays in DB only (worker polls DB as fallback)

### 3. Worker Picks Up Job
- Worker polls DB every 5 seconds for PENDING jobs (oldest first)
- Marks job as RUNNING with startedAt timestamp

### 4. Load Tenant Config
- Fetches tenant from DB
- Decrypts shopifyToken and dacPassword using AES-256-GCM
- Validates both Shopify and DAC credentials are configured

### 5. Fetch Shopify Orders
- Creates Axios client with Shopify Admin API 2024-01
- Queries: `GET /orders.json?financial_status=paid&fulfillment_status=unfulfilled&status=open&limit=250`
- Filters out orders already tagged "labelflow-procesado" or with "LabelFlow-GUIA:" note
- Applies maxOrdersPerRun limit (excess counted as skipped)

### 6. DAC Browser Session
- Gets or creates Playwright Chromium page
- **Smart login**: tries saved cookies first (from RunLog, max 4 hours old)
  - If cookies work (navigates to form without redirect to login), skips CAPTCHA (~2s)
  - If cookies expired, does full login with CAPTCHA solving (~60-80s)
- Full login: navigates to dac.com.uy/usuarios/login, fills Documento/RUT + password, solves reCAPTCHA v2 via 2Captcha, submits, waits for redirect

### 7. Process Each Order (sequential, 500ms delay between)
For each order:

a. **Determine payment type** (rules/payment.ts):
   - If `total_price > paymentThreshold` (default 4000 UYU) -> REMITENTE (store pays shipping)
   - If `total_price <= paymentThreshold` -> DESTINATARIO (customer pays on delivery)
   - USD orders converted at approximate rate of 42 UYU/USD

b. **Validate shipping address**: Skip if no address1 (create FAILED label, add Shopify note)

c. **Create DAC shipment** (4-step form):
   - Navigate to `/envios/nuevo`
   - **Step 1** (Service Type): Set TipoServicio=Mostrador, TipoGuia based on payment type (1=Remitente, 4=Destinatario), TipoEnvio=Paquete, TipoEntrega=Domicilio -> click Siguiente
   - **Step 2** (Origin): Auto-filled from DAC account -> click Siguiente
   - **Step 3** (Recipient): Fill NombreD, TelD, Correo_Destinatario, DirD. Select K_Estado (department) with fuzzy matching, wait for K_Ciudad cascade load, select city with fuzzy matching, select K_Barrio -> click Siguiente
   - **Step 4** (Quantity): Set Cantidad=1 -> click Agregar (submit)
   - Extract guia number from page text using regex patterns
   - If not found on current page, check cart page

d. **Download PDF label**: Navigate to history/cart page, find download link, save via Playwright download event or direct URL fetch with cookies

e. **Upload to Supabase Storage**: Path `{tenantId}/{YYYY-MM-DD}/{labelId}.pdf`

f. **Create Label record** in DB with all order details, guia, status=COMPLETED

g. **Mark Shopify order**: Add tag "labelflow-procesado" + note "LabelFlow-GUIA: {guia} | {timestamp}"

h. **Send email notification**: If tenant has SMTP configured, sends HTML email with:
   - Customer name, order name, guia number
   - DAC tracking link
   - Product list
   - Payment notice (if DESTINATARIO: "El envio se paga al recibirlo")
   - Estimated delivery: 24-48 business hours

### 8. Job Completion
- Save DAC cookies for next run (stored in RunLog as JSON)
- Close browser
- Update Job record: status (COMPLETED/PARTIAL/FAILED), counts, durationMs
- Increment tenant.labelsThisMonth and labelsTotal

---

## 9. DAC Automation Details

### URLs
- Login: `https://www.dac.com.uy/usuarios/login`
- New Shipment: `https://www.dac.com.uy/envios/nuevo`
- History/Cart: `https://www.dac.com.uy/envios/cart`
- Tracking: `https://www.dac.com.uy/envios/rastrear`

### Login Selectors
- Username: `input[name="documento"]` (Documento or RUT number)
- Password: `input[name="password"]`
- Submit: `#btnLogin`
- Success indicator: `text=Bienvenido`

### reCAPTCHA
- Site key: `6LeKGrIaAAAAAANa6NZk_i6xkQD-c-_U3Bt-OffC`
- Type: reCAPTCHA v2
- Solved via 2Captcha service (CAPTCHA_API_KEY env var)
- Token injected into `#g-recaptcha-response` textarea
- Submitted via `window.LoginSend()` function

### Form Selectors (4-step single-page form)
**Step 1 - Service Type:**
- `select[name="TipoServicio"]` -> "0" (Mostrador)
- `[name="TipoGuia"]` -> "1" (Remitente) or "4" (Destinatario)
- `select[name="TipoEnvio"]` -> "1" (Paquete)
- `select[name="TipoEntrega"]` -> "2" (Domicilio)

**Step 2 - Origin:** Auto-filled from account, just click Siguiente

**Step 3 - Recipient:**
- `input[name="NombreD"]` - Full name
- `input[name="TelD"]` - Phone (cleaned to digits only, fallback "099000000")
- `input[name="RUT_Destinatario"]` - RUT (optional)
- `input[name="Correo_Destinatario"]` - Email (optional)
- `input[name="DirD"]` - Street address
- `select[name="K_Estado"]` - Department (fuzzy matched)
- `select[name="K_Ciudad"]` - City (cascading, loads after department selected, 1200ms wait)
- `select[name="K_Barrio"]` - Neighborhood (cascading, loads after city, 800ms wait)

**Step 4 - Quantity:**
- `input[name="Cantidad"]` -> "1"

**Navigation:**
- Next: `a:has-text("Siguiente")`
- Submit: `button:has-text("Agregar")`

### Fuzzy Matching for Dropdowns
The `findBestOptionMatch()` function uses 4 strategies in order:
1. Exact match (case-insensitive, accent-insensitive via NFD normalization)
2. Option text contains search text
3. Search text contains option text (for longer addresses)
4. Word-level match (any word > 2 chars matches)

### Cookie Persistence
- After successful login, cookies are saved to RunLog (tenantId-scoped)
- On next run, cookies loaded if < 4 hours old
- Cookie login skips CAPTCHA entirely (saves ~60s per run)
- Cookies filtered to dac.com.uy domain only

### Guia Extraction
After form submission, the guia number is extracted using regex patterns:
- `guia:\s*(\d{6,})`
- `tracking:\s*(\d{6,})`
- `numero:\s*(\d{6,})`
- `envio:\s*(\d{6,})`
- `DAC[-:]\s*(\d{6,})`
- If not found on current page, checks cart page
- Fallback: `PENDING-{timestamp}`

### Selector Update Tool
Run `npm run probe-dac` in apps/worker to:
- Open visible Chrome (not headless)
- Navigate through dac.com.uy pages
- Take screenshots of each screen
- Log all input/select elements with their id/name
- Screenshots saved to `./dac-screenshots/`
- Update `src/dac/selectors.ts` with findings

---

## 10. Worker Architecture

### Entry Point (src/index.ts)
- Loads config via Zod schema validation
- Starts infinite polling loop (5 second interval)
- Each cycle: queries for oldest PENDING job, marks RUNNING, calls processOrdersJob()
- Graceful shutdown on SIGTERM/SIGINT: closes browser, disconnects DB

### Config (src/config.ts)
Validated with Zod from environment variables:
- `DATABASE_URL` (required)
- `REDIS_URL` (required)
- `ENCRYPTION_KEY` (required, 32 bytes hex)
- `WORKER_CONCURRENCY` (default 2)
- `PLAYWRIGHT_HEADLESS` (default true)
- `LABELS_TMP_DIR` (default /tmp/labelflow)
- `CAPTCHA_API_KEY` (optional)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (optional)
- `SUPABASE_STORAGE_BUCKET` (default "labels")

### Job Processing Mode
**Primary**: DB polling (every 5 seconds, queries for PENDING jobs)
**Secondary**: BullMQ consumer (if Redis available)
The web app creates Job records in DB first, then best-effort enqueues to BullMQ. The worker always checks DB, so jobs are never lost even if Redis is down.

### Scheduler (src/jobs/scheduler.ts)
- Uses node-cron to check every minute
- Queries all active tenants with complete config (Shopify + DAC credentials)
- Parses each tenant's cronSchedule to determine if it should run now
- Checks for existing PENDING/RUNNING jobs (prevents duplicate runs)
- Creates Job + enqueues to BullMQ

### Docker Deployment
```dockerfile
FROM mcr.microsoft.com/playwright:v1.50.0-noble
# Playwright browsers pre-installed in base image
# Prisma client generated at build time
# Runs: node dist/index.js
```

### Logging
- Uses pino for structured JSON logging
- Levels: debug, info, warn, error
- RunLog entries also written to DB for UI display

---

## 11. API Reference

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET/POST | `/api/auth/[...nextauth]` | Public | NextAuth handler (login, callback, session) |
| POST | `/api/auth/signup` | Public | Create account + tenant |

**POST /api/auth/signup**
- Body: `{ name: string, email: string, password: string }`
- Validation: name 1-100, email valid, password 8-100
- Returns: `{ data: { userId, tenantId } }` (201) or error (400/409/500)

### Protected API (v1)

All require NextAuth session (cookie-based).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/settings` | Get tenant configuration (secrets returned as booleans) |
| PUT | `/api/v1/settings` | Update tenant configuration (encrypts sensitive fields) |
| GET | `/api/v1/jobs` | List last 20 jobs |
| POST | `/api/v1/jobs` | Trigger manual job (checks active subscription + plan limit + no running job) |
| GET | `/api/v1/orders?page=1&limit=20&status=all` | List labels with pagination |
| GET | `/api/v1/labels/{id}` | Get single label with signed PDF URL |

**PUT /api/v1/settings** (validated fields):
- `shopifyStoreUrl`: regex for `*.myshopify.com`
- `shopifyToken`: encrypted before storage, Shopify connection verified
- `dacUsername`, `dacPassword`: dacPassword encrypted
- `emailHost`, `emailPort` (1-65535), `emailUser`, `emailPass` (encrypted), `emailFrom`
- `storeName` (max 100)
- `paymentThreshold` (0-1000000)
- `cronSchedule`: valid cron, minimum 15-minute interval
- `maxOrdersPerRun` (1-50)

### Billing

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/stripe/checkout?plan=X` | Session | Redirect to Stripe Checkout |
| GET | `/api/stripe/portal` | Session | Redirect to Stripe Customer Portal |
| GET | `/api/mercadopago/checkout?plan=X` | Session | Create MercadoPago PreApproval, redirect |
| POST | `/api/mercadopago/cancel` | Session | Cancel MercadoPago subscription |

### Webhooks

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/webhooks/shopify` | HMAC (X-Shopify-Hmac-SHA256) | Shopify orders/paid event |
| POST | `/api/webhooks/stripe` | Stripe signature | Stripe subscription events |
| POST/GET | `/api/webhooks/mercadopago` | None (MercadoPago IPN) | Subscription + payment notifications |

### MCP Endpoint

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/v1/mcp` | Bearer token (tenant.apiKey) | JSON-RPC 2.0 MCP server |

**MCP Methods:**
- `initialize` -> server info + capabilities
- `tools/list` -> 4 available tools
- `tools/call` -> execute a tool

**MCP Tools:**
1. `process_pending_orders` - Enqueue processing job (checks active subscription, no running job)
2. `get_daily_summary` - Labels today (completed/failed/total), labelsThisMonth, lastRunAt
3. `get_order_status` - Search label by order name (partial match)
4. `list_recent_labels` - Latest labels (limit 1-50, default 10)

---

## 12. Environment Variables

### Root (.env)
```
DATABASE_URL              # PostgreSQL connection string (with pooler for serverless)
DIRECT_URL                # Direct PostgreSQL connection (for migrations)
NEXT_PUBLIC_SUPABASE_URL  # Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY  # Supabase anonymous key
SUPABASE_SERVICE_ROLE_KEY # Supabase admin key (server-side only)
SUPABASE_STORAGE_BUCKET   # Storage bucket name (default: "labels")
NEXTAUTH_URL              # App base URL (http://localhost:3000)
NEXTAUTH_SECRET           # NextAuth JWT signing secret (openssl rand -base64 32)
AUTH_GOOGLE_ID            # Google OAuth client ID (optional)
AUTH_GOOGLE_SECRET        # Google OAuth client secret (optional)
REDIS_URL                 # Upstash Redis connection string
STRIPE_SECRET_KEY         # Stripe API secret key
STRIPE_WEBHOOK_SECRET     # Stripe webhook signing secret
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY  # Stripe public key
STRIPE_PRICE_STARTER      # Stripe Price ID for Starter plan
STRIPE_PRICE_GROWTH       # Stripe Price ID for Growth plan
STRIPE_PRICE_PRO          # Stripe Price ID for Pro plan
ENCRYPTION_KEY            # 32-byte hex key for AES-256-GCM (openssl rand -hex 32)
NEXT_PUBLIC_APP_URL       # Public app URL (https://autoenvia.com)
APP_NAME                  # App display name (LabelFlow)
MCP_SECRET                # MCP server secret (openssl rand -base64 32)
MERCADOPAGO_ACCESS_TOKEN  # MercadoPago API access token
```

### Worker-specific
```
WORKER_CONCURRENCY        # Max parallel jobs (default: 2)
PLAYWRIGHT_HEADLESS       # "true" or "false" (default: true)
LABELS_TMP_DIR            # Temp directory for PDFs (default: /tmp/labelflow)
CAPTCHA_API_KEY           # 2Captcha API key for reCAPTCHA solving
LOG_LEVEL                 # pino log level (default: info)
```

---

## 13. File Structure

```
labelflow/
  .env.example              # Template for environment variables
  .gitignore
  package.json              # Monorepo root (npm workspaces)
  README.md                 # Setup and architecture overview

  apps/
    web/                    # Next.js 14 web application
      .vercel/project.json  # Vercel project config
      vercel.json           # Vercel build config (prisma generate + next build)
      next.config.js
      tailwind.config.ts
      tsconfig.json
      package.json          # Dependencies: next, next-auth, prisma, stripe, mercadopago, etc.

      prisma/
        schema.prisma       # Database schema (User, Tenant, Job, Label, RunLog + enums)

      middleware.ts          # Route protection (public vs protected paths)

      lib/
        auth.ts             # NextAuth config (Credentials + Google providers, JWT callbacks)
        db.ts               # Prisma client singleton
        encryption.ts       # AES-256-GCM encrypt/decrypt for credentials
        queue.ts            # Job creation + BullMQ enqueue (best-effort)
        stripe.ts           # Stripe client + plan configuration
        mercadopago.ts       # MercadoPago client + plan configuration
        supabase.ts         # Supabase admin client for Storage (signed URLs, PDF upload)
        mcp-server.ts       # MCP tool definitions + handlers
        api-utils.ts        # getAuthenticatedTenant(), apiError(), apiSuccess()
        cn.ts               # Tailwind class merge utility

      app/
        layout.tsx          # Root layout (html lang="es", dark class)
        globals.css         # Tailwind imports + custom styles
        page.tsx            # Landing page (/)

        (auth)/
          login/page.tsx    # Login form (email + password, signIn via NextAuth)
          signup/page.tsx   # Signup form (name, email, password -> POST /api/auth/signup)

        onboarding/
          page.tsx          # 3-step onboarding wizard (Shopify -> DAC -> Plan)

        (dashboard)/
          layout.tsx        # Dashboard layout with Sidebar
          dashboard/page.tsx  # Main dashboard: stats cards, trigger button, recent jobs table
          orders/page.tsx   # Labels list with search, filter, pagination, expanded details
          labels/page.tsx   # PDF label gallery grouped by date
          logs/page.tsx     # Job execution history with expandable log viewer
          settings/
            page.tsx        # Configuration: Shopify, DAC, Email, payment rules, schedule, API key
            billing/page.tsx  # Subscription plans, MercadoPago checkout, cancel

        api/
          auth/
            [...nextauth]/route.ts  # NextAuth catch-all handler
            signup/route.ts         # User registration endpoint
          v1/
            settings/route.ts       # GET/PUT tenant settings
            jobs/route.ts           # GET jobs list, POST trigger manual job
            orders/route.ts         # GET labels with pagination
            labels/[id]/route.ts    # GET single label with signed PDF URL
            mcp/route.ts            # MCP JSON-RPC endpoint (Bearer token auth)
          webhooks/
            shopify/route.ts        # Shopify orders/paid webhook (HMAC verified)
            stripe/route.ts         # Stripe subscription webhook (signature verified)
            mercadopago/route.ts    # MercadoPago subscription + payment webhook
          stripe/
            checkout/route.ts       # Create Stripe Checkout Session
            portal/route.ts         # Redirect to Stripe Customer Portal
          mercadopago/
            checkout/route.ts       # Create MercadoPago PreApproval subscription
            cancel/route.ts         # Cancel MercadoPago subscription

        home/page.tsx       # Alternative home route

      components/
        layout/
          Sidebar.tsx       # Collapsible sidebar navigation (desktop + mobile)

    worker/                 # Background worker (Playwright + job processing)
      Dockerfile            # Based on mcr.microsoft.com/playwright:v1.50.0-noble
      package.json          # Dependencies: playwright, bullmq, 2captcha-ts, nodemailer, pino
      tsconfig.json
      prisma/
        schema.prisma       # Same schema as web app (shared)

      src/
        index.ts            # Entry point: polling loop, graceful shutdown
        config.ts           # Zod-validated configuration from env vars
        db.ts               # Prisma client
        encryption.ts       # AES-256-GCM decrypt (matches web app's encrypt)
        logger.ts           # pino structured logger
        utils.ts            # maskEmail, cleanPhone, sleep, maskToken, formatDuration

        jobs/
          process-orders.job.ts  # Main job: Shopify -> DAC -> PDF -> email flow
          scheduler.ts           # Cron-based tenant scheduler (node-cron)

        dac/
          auth.ts           # smartLogin (cookies -> CAPTCHA), loginDac, ensureLoggedIn
          browser.ts        # DacBrowserManager: page lifecycle, cookie save/load, screenshots
          selectors.ts      # CSS selectors and URLs for dac.com.uy
          shipment.ts       # createShipment: 4-step form automation with fuzzy matching
          label.ts          # downloadLabel: PDF download from DAC history page
          types.ts          # DacShipmentResult, DacCredentials interfaces

        shopify/
          client.ts         # Axios client factory with rate limit monitoring
          orders.ts         # getUnfulfilledOrders, addOrderTag, addOrderNote, markOrderProcessed
          types.ts          # ShopifyOrder interface

        notifier/
          email.ts          # sendShipmentNotification via nodemailer
          templates.ts      # HTML email template + subject builder

        rules/
          payment.ts        # determinePaymentType (threshold-based, with USD conversion)

        storage/
          upload.ts         # uploadLabelPdf to Supabase Storage

  packages/
    shared/                 # Shared types and utilities
      src/
        index.ts            # Re-exports all types and utils
        types/
          tenant.ts         # SubscriptionStatus, PlanTier, PLAN_LIMITS, PLAN_PRICES, TenantPublicConfig
          job.ts            # JobStatus, JobTrigger, JobType, JobResult, JobSummary
          label.ts          # LabelStatus, PaymentType, LabelSummary
        utils/
          format.ts         # formatUYU, formatUSD, maskEmail, maskToken, cleanPhone, formatDuration, sleep
```

---

## 14. Security

### Credential Encryption
- Algorithm: AES-256-GCM (authenticated encryption)
- Key: 32-byte hex string from ENCRYPTION_KEY env var
- Format: `{iv_hex}:{auth_tag_hex}:{ciphertext_hex}`
- Encrypted fields: shopifyToken, dacPassword, emailPass
- Same ENCRYPTION_KEY must be shared between web and worker
- Settings API never returns encrypted values (returns boolean flags like `shopifyTokenSet: true`)

### Authentication
- Passwords: bcryptjs with 12 salt rounds
- Sessions: JWT with 7-day expiry, NEXTAUTH_SECRET for signing
- API routes: session-based via `getServerSession()`
- MCP endpoint: Bearer token (tenant.apiKey, 64-char hex)
- Shopify webhook: HMAC-SHA256 verification using tenant's Shopify token
- Stripe webhook: signature verification using STRIPE_WEBHOOK_SECRET
- MercadoPago webhook: no signature verification (relies on fetching full object from API)

### Tenant Isolation
- Every database query includes `tenantId` in WHERE clause
- `getAuthenticatedTenant()` extracts tenantId from JWT session
- Labels have unique constraint on [tenantId, shopifyOrderId]
- Supabase Storage paths namespaced by tenantId: `{tenantId}/{date}/{labelId}.pdf`
- MCP API key is unique per tenant

### Input Validation
- Zod schemas on signup (name, email, password lengths)
- Zod schema on settings update (shopifyStoreUrl regex, cronSchedule regex with minimum interval, port range, etc.)
- Shopify token verified by actually calling Shopify API before saving
- All API responses use consistent error format

### Rate Limiting
- Shopify: monitors X-Shopify-Shop-Api-Call-Limit header, warns at 80%
- DAC: 500ms delay between orders, max 20 orders per run (configurable 1-50)
- Cron schedule: minimum 15-minute interval enforced via validation
- Jobs: only one PENDING/RUNNING job per tenant at a time

---

## 15. Deployment

### Web (Vercel)
```bash
cd apps/web
npx vercel deploy --prod
```
- Build command (vercel.json): `npx prisma generate --schema=prisma/schema.prisma && next build`
- Install command: `npm install`
- Framework: nextjs
- postinstall script runs `prisma generate`
- Environment variables set in Vercel dashboard
- DATABASE_URL must use Supabase connection pooler URL for serverless

### Worker (Railway)
1. Create Railway project
2. Point to `apps/worker/Dockerfile` or connect repo
3. Set all worker environment variables
4. Docker base image: `mcr.microsoft.com/playwright:v1.50.0-noble` (includes Chromium)
5. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (browsers already in image)
6. CMD: `node dist/index.js`
7. Railway auto-deploys on push

### Database Migrations
```bash
# Generate Prisma client
npx prisma generate --schema=apps/web/prisma/schema.prisma

# Push schema changes (development)
npx prisma db push --schema=apps/web/prisma/schema.prisma

# Create migration (production)
npx prisma migrate dev --schema=apps/web/prisma/schema.prisma

# Open Prisma Studio
npx prisma studio --schema=apps/web/prisma/schema.prisma
```

### Webhook Configuration

**Shopify:**
- URL: `https://autoenvia.com/api/webhooks/shopify`
- Event: `Order payment` (orders/paid)
- Format: JSON

**Stripe:**
- URL: `https://autoenvia.com/api/webhooks/stripe`
- Events: checkout.session.completed, invoice.paid, invoice.payment_failed, customer.subscription.deleted, customer.subscription.updated

**MercadoPago:**
- URL: `https://autoenvia.com/api/webhooks/mercadopago`
- Events: subscription_preapproval, payment (configured in MercadoPago dashboard)

---

## 16. Common Issues and Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| DAC login fails | Credentials wrong or changed | Verify RUT + password at dac.com.uy manually |
| "Selector not found" | DAC changed their UI | Run `npm run probe-dac` and update selectors.ts |
| Shopify 429 | Rate limit exceeded | Lower maxOrdersPerRun in settings |
| Order skipped (no address) | Customer has no shipping address | Automatic skip, note added to Shopify order |
| PDF not downloaded | DAC session expired mid-run | Worker re-logs in automatically via ensureLoggedIn() |
| Email not sent | Bad SMTP credentials | Verify app password (Gmail requires App Password, not account password) |
| Job stuck in RUNNING | Worker crashed | Restart worker; job will not auto-retry (create new manual job) |
| Stripe webhook fails | Wrong STRIPE_WEBHOOK_SECRET | Re-copy from Stripe dashboard |
| MercadoPago webhook ignores | external_reference not set | Check PreApproval creation includes tenantId in external_reference |
| DB connection refused | Supabase needs pooler | Use connection string with `?pgbouncer=true` or the pooler URL |
| Build fails on Vercel | Prisma client not generated | vercel.json runs prisma generate before next build |
| Worker can't decrypt | ENCRYPTION_KEY mismatch | Must be the same 32-byte hex key on both web and worker |
| CAPTCHA solving slow | 2Captcha queue busy | Normal: takes 20-60 seconds. Cookie persistence reduces frequency |
| City/Department not matched | Accent differences in Shopify vs DAC | Fuzzy matching normalizes accents (NFD); update Shopify province if needed |
| Guia shows "PENDING-..." | DAC didn't show guia on page | May need to check cart page; guia extracted retroactively |
| labelsThisMonth not resetting | No payment webhook received | Manually reset in DB or ensure webhook URL is correct |
| "Already running" error | Previous job did not complete | Check job status in /logs; if stuck, update status to FAILED in DB |

---

## 17. Services and Accounts

| Service | Purpose | Required Credentials |
|---------|---------|---------------------|
| Supabase | PostgreSQL + Storage | DATABASE_URL, DIRECT_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY |
| Upstash | Redis for BullMQ | REDIS_URL |
| Vercel | Web hosting | Vercel account + project linked |
| Railway | Worker hosting | Railway account + Dockerfile deploy |
| MercadoPago | Subscription billing (UYU) | MERCADOPAGO_ACCESS_TOKEN |
| Stripe | Alternative billing (USD) | STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, 3 price IDs |
| 2Captcha | reCAPTCHA solving | CAPTCHA_API_KEY |
| Google Cloud | OAuth provider (optional) | AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET |
| GoDaddy | Domain (autoenvia.com) | DNS management |
| Gmail/SMTP | Email notifications | Per-tenant: emailHost, emailUser, emailPass (App Password) |
| Shopify | E-commerce platform | Per-tenant: store URL + Admin API token |
| DAC Uruguay | Courier service | Per-tenant: Documento/RUT + password |

**No actual secrets are stored in this file. All credentials are in environment variables.**
