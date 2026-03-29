# LabelFlow -- Complete System Context

## 1. What is LabelFlow

LabelFlow is a multi-tenant SaaS that automates shipping label generation between Shopify e-commerce stores and DAC Uruguay, a Uruguayan courier service that has no public API. The system polls Shopify for paid unfulfilled orders, uses headless Chromium via Playwright to log into dac.com.uy and create shipments through their web forms, then extracts tracking numbers, uploads PDF labels to Supabase Storage, tags orders in Shopify, and emails customers their tracking info. The product is sold as a monthly subscription via MercadoPago (Uruguay) with three tiers (Starter/Growth/Pro) and is marketed at autoenvia.com.

---

## 2. Live URLs

| URL | Purpose |
|-----|---------|
| `https://autoenvia.com` | Production landing page |
| `https://autoenvia.com/login` | Login (email+password or Google OAuth) |
| `https://autoenvia.com/signup` | Registration (with ToS checkbox) |
| `https://autoenvia.com/onboarding` | 3-step wizard: Shopify, DAC, Plan selection |
| `https://autoenvia.com/dashboard` | Main dashboard: stats, trigger button, recent jobs |
| `https://autoenvia.com/orders` | Processed orders table with search/filter/pagination |
| `https://autoenvia.com/labels` | Label history grouped by date |
| `https://autoenvia.com/logs` | Job execution logs with expandable viewer |
| `https://autoenvia.com/settings` | Configuration: Shopify, DAC, Email, rules, schedule, API key |
| `https://autoenvia.com/settings/billing` | Subscription plans, MercadoPago checkout, cancel |
| `https://autoenvia.com/terminos` | Terms of Service (public) |
| `https://autoenvia.com/privacidad` | Privacy Policy per Ley 18.331 (public) |
| `https://autoenvia.com/api/v1/mcp` | MCP endpoint for Claude Desktop |

**Domain:** autoenvia.com (GoDaddy, nameservers pointed to Vercel)

---

## 3. Architecture Diagram

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
                       |   (Render/Docker)   |
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

## 4. Tech Stack

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| Frontend + API | Next.js (App Router, TypeScript) | 14.2.x | Full-stack React framework with API routes |
| UI framework | Tailwind CSS | 3.4.x | Utility-first CSS, custom dark theme throughout |
| Class merging | clsx + tailwind-merge | 2.1 / 2.3 | Conditional class composition |
| Icons | lucide-react | 0.376.x | Consistent icon set |
| Auth | NextAuth.js (Credentials + Google OAuth) | 4.24.x | JWT sessions, 7-day expiry |
| Password hashing | bcryptjs | 2.4.3 | 12 salt rounds |
| Database | PostgreSQL via Supabase | managed | Hosted Postgres with connection pooler |
| ORM | Prisma | 5.14.x | Type-safe queries, schema migrations |
| File storage | Supabase Storage (bucket: "labels") | managed | PDF label storage with 1-hour signed URLs |
| Job queue | BullMQ + Upstash Redis | 5.7.x | Best-effort queue (DB polling as primary) |
| Browser automation | Playwright (Chromium headless) | 1.50.0 | Automates DAC web form submission |
| CAPTCHA solving | 2captcha-ts | 2.4.x | Solves reCAPTCHA v2 on DAC login page |
| Billing (primary) | MercadoPago (PreApproval subscriptions) | SDK 2.12.x | Uruguayan payment processor, UYU currency |
| Billing (secondary) | Stripe (Checkout + Portal + Webhooks) | 15.5.x | International billing alternative (USD) |
| Email | Nodemailer | 6.9.x | Per-tenant SMTP for customer notifications |
| Encryption | Node.js crypto (AES-256-GCM) | native | Encrypts credentials at rest |
| Input validation | Zod | 3.23.x | Schema validation for API inputs and config |
| Worker logging | pino | 9.1.x | Structured JSON logging |
| MCP | Custom Streamable HTTP (JSON-RPC 2.0) | custom | Claude Desktop integration (4 tools) |
| Monorepo | npm workspaces | native | apps/web + apps/worker + packages/shared |
| Deploy (web) | Vercel | Hobby plan | Serverless Next.js hosting |
| Deploy (worker) | Render.com | Starter $7/mo | Docker container with Playwright |
| Package manager | npm (pnpm recommended) | native | Dependency management |
| Language | TypeScript | 5.4.x | Type safety across all packages |
| Cron scheduling | node-cron | 3.0.x | Per-tenant cron schedule evaluation |

---

## 5. Infrastructure

| Service | Purpose | Plan | Cost | URL / Notes |
|---------|---------|------|------|-------------|
| Vercel | Web app hosting (autoenvia.com) | Hobby | Free | Next.js 14, serverless functions |
| Render.com | Worker hosting (Docker + Playwright) | Starter | $7/mo | Long-running container, auto-deploy from repo |
| Supabase | PostgreSQL database + file storage | Free | Free | Connection pooler required for serverless |
| Upstash | Redis (managed, serverless-compatible) | Free | Free | BullMQ queue backend |
| MercadoPago | Subscription billing (UYU) | Commission | ~3.5% + IVA | PreApproval API for recurring charges |
| Stripe | Alternative billing (USD) | Standard | ~2.9% + $0.30 | Checkout Sessions + Customer Portal |
| 2Captcha | reCAPTCHA solving service | Pay-per-use | ~$3/1000 solves | Used only when cookies expire |
| GoDaddy | Domain registration (autoenvia.com) | Domain | ~$12/year | DNS pointed to Vercel nameservers |
| Gmail (SMTP) | Email notifications | Per-tenant | Free | Requires App Password for each tenant |
| **TOTAL** | | | **~$8/mo + domain** | |

---

## 6. Monorepo Structure

```
labelflow/
  .env.example                    # Template for all environment variables
  .gitignore                      # node_modules, .next, .env, .vercel, pdfs, screenshots
  package.json                    # Monorepo root (npm workspaces: apps/*, packages/*)
  README.md                       # Setup guide, architecture overview, troubleshooting
  STATUS.md                       # Current system state, known issues, deployment history
  CONTEXT.md                      # This file

  apps/
    web/                          # Next.js 14 web application (deployed to Vercel)
      .vercel/project.json        # Vercel project config
      vercel.json                 # Build: "prisma generate && next build"
      next.config.js              # Next.js configuration
      tailwind.config.ts          # Tailwind theme (dark mode, custom colors)
      tsconfig.json               # TypeScript config
      postcss.config.js           # PostCSS for Tailwind
      package.json                # next, next-auth, prisma, stripe, mercadopago, etc.

      prisma/
        schema.prisma             # Database schema: User, Account, Session, Tenant, Job, Label, RunLog + 7 enums

      middleware.ts                # Route protection: public vs protected paths, JWT check via getToken()

      lib/
        auth.ts                   # NextAuth config: Credentials + Google providers, JWT callbacks enriching tenantId/slug/isActive/subscriptionStatus
        db.ts                     # Prisma client singleton (globalThis pattern for dev HMR)
        encryption.ts             # AES-256-GCM encrypt/decrypt (iv:tag:ciphertext hex format)
        queue.ts                  # enqueueProcessOrders() + isJobRunning(): creates Job in DB, best-effort BullMQ push
        stripe.ts                 # Stripe client singleton + PLAN_PRICE_MAP (starter/growth/pro limits)
        mercadopago.ts            # MercadoPago client: PreApproval, Payment, Preference clients + PLANS config (UYU prices)
        supabase.ts               # Supabase admin client: getSignedUrl() (1hr expiry), uploadPdf()
        api-utils.ts              # getAuthenticatedTenant() from session, apiError(), apiSuccess() response helpers
        cn.ts                     # Tailwind class merge: clsx + twMerge
        log-messages.ts           # RunLog -> user-facing display messages mapping (step-based, hides internal logs)

      app/
        layout.tsx                # Root layout: html lang="es", dark class
        globals.css               # Tailwind imports + custom dark theme styles + feed panel animations
        page.tsx                  # Landing page: hero, how-it-works, pricing (3 plans), FAQ, footer

        (auth)/
          login/page.tsx          # Login form: email + password, signIn via NextAuth, link to signup
          signup/page.tsx         # Signup form: name, email, password, ToS checkbox -> POST /api/auth/signup

        onboarding/
          page.tsx                # 3-step wizard: Step 1 (Shopify URL + token), Step 2 (DAC RUT + password), Step 3 (plan selection via MercadoPago)

        (dashboard)/
          layout.tsx              # Dashboard shell: Sidebar + main content area (lg:ml-60)
          dashboard/page.tsx      # Stats cards (today/month/rate/lastRun), trigger button with order count, recent jobs table, live JobFeedPanel
          orders/page.tsx         # Labels list with search, status filter, pagination, expandable row details
          labels/page.tsx         # PDF label gallery grouped by date
          logs/page.tsx           # Job execution history with expandable log viewer per job
          settings/
            page.tsx              # Config panels: Shopify, DAC, Email, payment rules, cron schedule, API key (MCP)
            billing/page.tsx      # Subscription plans display, MercadoPago checkout redirect, cancel button

        terminos/page.tsx         # Terms of Service (Spanish, references Ley 17.250)
        privacidad/page.tsx       # Privacy Policy (Spanish, references Ley 18.331 Uruguay data protection)
        home/page.tsx             # Alternative home route

        api/
          auth/
            [...nextauth]/route.ts    # NextAuth catch-all handler (GET + POST)
            signup/route.ts           # POST: Zod validate, bcrypt hash, create User+Tenant, capture IP for compliance

          v1/
            settings/route.ts         # GET: tenant config (secrets as booleans). PUT: Zod validate, encrypt sensitive fields, verify Shopify connection
            jobs/route.ts             # GET: last 20 jobs. POST: check active sub + plan limit + no running job, then enqueue
            jobs/[id]/logs/route.ts   # GET: logs for specific job (unused, logs route used instead)
            orders/route.ts           # GET: labels with pagination (page, limit, status filter)
            labels/[id]/route.ts      # GET: single label with signed PDF URL from Supabase
            logs/route.ts             # GET: RunLog entries by jobId/since, plus latest job summary
            mcp/route.ts              # POST: JSON-RPC 2.0 MCP server with Bearer token auth (4 tools)

          webhooks/
            shopify/route.ts          # POST: HMAC-SHA256 verification, orders/paid -> enqueueProcessOrders(WEBHOOK)
            stripe/route.ts           # POST: Stripe signature verification, handles 5 subscription events
            mercadopago/route.ts      # POST/GET: HMAC signature verification, handles preapproval + payment notifications

          stripe/
            checkout/route.ts         # GET: create/get Stripe customer, create Checkout Session, redirect
            portal/route.ts           # GET: create Stripe Customer Portal session, redirect

          mercadopago/
            checkout/route.ts         # GET: create PreApproval subscription (UYU), redirect to init_point
            cancel/route.ts           # POST: cancel PreApproval via API, set tenant CANCELED

      components/
        layout/
          Sidebar.tsx             # Collapsible sidebar: Dashboard, Pedidos, Etiquetas, Logs, Configuracion, Billing, Logout
        JobFeedPanel.tsx          # Real-time job execution feed: polls /api/v1/logs every 2s, filters via log-messages.ts, auto-scroll, elapsed timer

      hooks/
        useJobFeed.ts             # Hook: polls logs API, deduplicates by ID, tracks isRunning state

    worker/                       # Background worker (deployed to Render as Docker container)
      Dockerfile                  # FROM mcr.microsoft.com/playwright:v1.50.0-noble, prisma generate, tsc, CMD node dist/index.js
      package.json                # playwright, bullmq, 2captcha-ts, nodemailer, pino, axios, node-cron, zod
      tsconfig.json               # TypeScript config
      prisma/
        schema.prisma             # Same schema as web app (copied)

      src/
        index.ts                  # Entry point: Zod config validation, infinite DB polling loop (5s interval), graceful SIGTERM/SIGINT shutdown
        config.ts                 # Zod schema for env vars: DATABASE_URL, REDIS_URL, ENCRYPTION_KEY, WORKER_CONCURRENCY, PLAYWRIGHT_HEADLESS, LABELS_TMP_DIR, CAPTCHA_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_STORAGE_BUCKET
        db.ts                     # Prisma client (no singleton pattern, worker is long-lived)
        encryption.ts             # AES-256-GCM decrypt only (matches web app format: iv:tag:ciphertext)
        logger.ts                 # pino logger + createStepLogger() that writes to both console AND RunLog DB table
        utils.ts                  # maskEmail, cleanPhone (fallback "099000000"), sleep, maskToken, formatDuration

        jobs/
          process-orders.job.ts   # Main orchestrator: load tenant, decrypt creds, fetch Shopify orders, filter already-processed, login DAC, process each order sequentially (500ms delay), save cookies, update job/tenant counters. Retry wrapper (2 attempts per order). Uses upsert for label records to handle retries of FAILED labels.
          scheduler.ts            # node-cron checking every minute: finds active tenants, parses cronSchedule, checks for existing PENDING/RUNNING jobs, creates Job + enqueues to BullMQ

        dac/
          auth.ts                 # smartLogin (try cookies first, fall back to full CAPTCHA login), loginDac (fill form, solve reCAPTCHA via 2Captcha, inject token, submit via window.LoginSend()), tryLoginWithCookies, ensureLoggedIn, isLoggedIn
          browser.ts              # DacBrowserManager class: Playwright Chromium singleton, getPage(), saveCookies() to RunLog DB, loadCookies() from RunLog (max 4 hours old), close(), screenshot()
          selectors.ts            # All CSS selectors and URLs for dac.com.uy: LOGIN (documento, password, #btnLogin), STEP 1 (TipoServicio, TipoGuia, TipoEnvio, TipoEntrega), STEP 3 (NombreD, TelD, Correo_Destinatario, DirD, K_Estado, K_Ciudad, K_Barrio), STEP 4 (Cantidad), NAV (Siguiente, Agregar)
          shipment.ts             # createShipment(): 4-step form automation. Includes fuzzy matching for department/city dropdowns (normalize NFD, exact/contains/reverse/word match). Forces Step 4 visible (bypasses silent JS validation). Sets fake lat/lng for geocoding bypass. Clicks Agregar, handles address validation modal, clicks Finalizar envio. Extracts guia via regex /\b88\d{10,}\b/ from current page then historial. Fills Observaciones with address2 + order notes.
          label.ts                # downloadLabel(): navigate to history page, try download selectors, fallback to PDF URL fetch with cookies via axios
          steps.ts                # DAC_STEPS constants for structured logging: 36 unique step identifiers (login:*, nav:*, step1-4:*, submit:*)
          types.ts                # DacShipmentResult (guia, screenshotPath), DacCredentials (username, password)

        shopify/
          client.ts               # createShopifyClient(): Axios instance for Shopify Admin API 2024-01, monitors X-Shopify-Shop-Api-Call-Limit header (warns at 80%)
          orders.ts               # getUnfulfilledOrders (paid+unfulfilled+open, filters out "labelflow-procesado" tag and "LabelFlow-GUIA:" notes), addOrderTag, addOrderNote, markOrderProcessed (tag + note with guia + timestamp)
          types.ts                # ShopifyOrder interface: id, name, email, total_price, currency, tags, shipping_address (first_name, last_name, phone, address1, address2, city, province, zip, country), line_items, note, note_attributes

        notifier/
          email.ts                # sendShipmentNotification(): creates nodemailer transporter per-tenant, sends HTML email with guia + tracking link
          templates.ts            # buildShipmentEmailHtml(): branded HTML email with cyan theme, product table, payment notice (DESTINATARIO shows "paga al recibirlo"), tracking button, 24-48h estimate. buildSubject(): "Tu pedido #X esta en camino (Guia DAC: Y)"

        rules/
          payment.ts              # determinePaymentType(): total > threshold -> REMITENTE (store pays), else DESTINATARIO (customer pays COD). USD orders converted at 42 UYU/USD.

        storage/
          upload.ts               # uploadLabelPdf(): uploads Buffer to Supabase Storage at path {tenantId}/{YYYY-MM-DD}/{labelId}.pdf with upsert

  packages/
    shared/                       # Shared types and utilities (npm workspace)
      package.json
      tsconfig.json
      src/
        index.ts                  # Re-exports all types and utils
        types/
          tenant.ts               # SubscriptionStatus, PlanTier, PLAN_LIMITS (100/500/999999), PLAN_PRICES (15/35/69 USD), TenantPublicConfig interface
          job.ts                  # JobStatus, JobTrigger, JobType, JobResult, JobSummary interfaces
          label.ts                # LabelStatus, PaymentType, LabelSummary interface
        utils/
          format.ts               # formatUYU (Intl es-UY), formatUSD (Intl en-US), maskEmail, maskToken, cleanPhone, formatDuration, sleep
```

---

## 7. Database Schema

### Prisma Configuration
- Provider: `postgresql`
- URL: `env("DATABASE_URL")` (Supabase pooler for serverless)
- Direct URL: `env("DIRECT_URL")` (for migrations)

### Models

#### User
Authentication identity. One user has exactly one tenant.
| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | String | @id @default(cuid()) | Primary key |
| email | String | @unique | Lowercased on input |
| name | String? | | Display name |
| passwordHash | String? | | bcrypt hash (12 rounds); null for OAuth users |
| emailVerified | DateTime? | | Set on OAuth signup |
| image | String? | | OAuth avatar URL |
| createdAt | DateTime | @default(now()) | |
| updatedAt | DateTime | @updatedAt | |
| accounts | Account[] | | OAuth provider links |
| sessions | Session[] | | NextAuth sessions (unused with JWT strategy) |
| tenant | Tenant? | | One-to-one |

#### Account
OAuth provider accounts (Google).
| Field | Type | Constraints | Notes |
|-------|------|-------------|-------|
| id | String | @id @default(cuid()) | |
| userId | String | FK -> User | Cascade delete |
| type | String | | "oauth" |
| provider | String | | "google" |
| providerAccountId | String | | Google user ID |
| refresh_token | String? | | |
| access_token | String? | | |
| expires_at | Int? | | |
| token_type | String? | | |
| scope | String? | | |
| id_token | String? | | |
| session_state | String? | | |
| @@unique | | [provider, providerAccountId] | |

#### Session
NextAuth sessions (JWT strategy means this table is mostly unused).
| Field | Type | Constraints |
|-------|------|-------------|
| id | String | @id @default(cuid()) |
| sessionToken | String | @unique |
| userId | String | FK -> User (cascade) |
| expires | DateTime | |

#### Tenant
Core multi-tenant entity. One per user. Holds ALL configuration.
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| id | String | cuid() | Primary key |
| userId | String | @unique | FK -> User, one-to-one |
| name | String | | Tenant display name |
| slug | String | @unique | URL-friendly identifier |
| apiKey | String | @unique, cuid() | MCP Bearer token (64-char hex on creation) |
| createdAt | DateTime | now() | |
| updatedAt | DateTime | @updatedAt | |
| **Shopify** | | | |
| shopifyStoreUrl | String? | | e.g., "mitienda.myshopify.com" |
| shopifyToken | String? | | AES-256-GCM encrypted |
| **DAC** | | | |
| dacUsername | String? | | Documento/RUT number |
| dacPassword | String? | | AES-256-GCM encrypted |
| **Email (SMTP)** | | | |
| emailHost | String? | | e.g., "smtp.gmail.com" |
| emailPort | Int? | 587 | |
| emailUser | String? | | e.g., "user@gmail.com" |
| emailPass | String? | | AES-256-GCM encrypted |
| emailFrom | String? | | From address |
| storeName | String? | | Brand name for emails |
| **Processing Config** | | | |
| paymentThreshold | Float | 4000 | UYU. Above = REMITENTE, below = DESTINATARIO |
| cronSchedule | String | "*/15 * * * *" | Minimum 15-minute interval enforced |
| maxOrdersPerRun | Int | 20 | Range 1-50 |
| isActive | Boolean | false | Must be true + ACTIVE subscription to process |
| **Billing** | | | |
| stripeCustomerId | String? | @unique | MercadoPago payer_id or Stripe customer ID |
| stripeSubscriptionId | String? | @unique | Prefixed "mp_sub_" for MercadoPago |
| stripePriceId | String? | | Plan ID: "starter", "growth", "pro" |
| subscriptionStatus | SubscriptionStatus | INACTIVE | |
| currentPeriodEnd | DateTime? | | Next payment date |
| **Legal** | | | |
| signupIp | String? | | X-Forwarded-For at registration (Ley 18.331) |
| tosAcceptedAt | DateTime? | | Timestamp of ToS acceptance |
| **Usage Counters** | | | |
| labelsThisMonth | Int | 0 | Reset on subscription payment |
| labelsTotal | Int | 0 | Lifetime total |
| lastRunAt | DateTime? | | Last job completion |
| **Indexes** | | | slug, stripeCustomerId, apiKey |

#### Job
Represents a single processing run.
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| id | String | cuid() | Primary key |
| tenantId | String | | FK -> Tenant |
| bullJobId | String? | @unique | BullMQ job ID if enqueued via Redis |
| type | JobType | PROCESS_ORDERS | |
| status | JobStatus | PENDING | PENDING -> RUNNING -> COMPLETED/FAILED/PARTIAL |
| trigger | JobTrigger | CRON | How the job was initiated |
| startedAt | DateTime? | | Set when worker picks up |
| finishedAt | DateTime? | | Set on completion |
| durationMs | Int? | | Total processing time |
| totalOrders | Int | 0 | Orders attempted |
| successCount | Int | 0 | Labels successfully created |
| failedCount | Int | 0 | Orders that failed |
| skippedCount | Int | 0 | Orders over limit |
| errorMessage | String? | | Fatal error if status=FAILED |
| createdAt | DateTime | now() | |
| **Index** | | | [tenantId, createdAt DESC] |

#### Label
One record per Shopify order processed.
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| id | String | cuid() | Primary key |
| tenantId | String | | FK -> Tenant |
| jobId | String? | | FK -> Job |
| shopifyOrderId | String | | Shopify order numeric ID |
| shopifyOrderName | String | | e.g., "#1234" |
| customerName | String | | |
| customerEmail | String? | | |
| customerPhone | String? | | |
| deliveryAddress | String | | |
| city | String | | |
| department | String | | Province/department |
| totalUyu | Float | | Order total in UYU |
| paymentType | PaymentType | | REMITENTE or DESTINATARIO |
| dacGuia | String? | @unique | DAC tracking number (12+ digits starting with 88) or "PENDING-{timestamp}" |
| pdfPath | String? | | Supabase Storage path: {tenantId}/{date}/{labelId}.pdf |
| pdfUrl | String? | | Signed URL (generated on demand, 1hr expiry) |
| status | LabelStatus | PENDING | |
| errorMessage | String? | | |
| emailSent | Boolean | false | |
| emailSentAt | DateTime? | | |
| createdAt | DateTime | now() | |
| updatedAt | DateTime | @updatedAt | |
| **Unique** | | | [tenantId, shopifyOrderId] |
| **Indexes** | | | [tenantId, createdAt DESC], [dacGuia] |

#### RunLog
Detailed log entries per job execution. Also used for cookie storage.
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| id | String | cuid() | |
| tenantId | String | | FK -> Tenant |
| jobId | String? | | FK -> Job |
| level | LogLevel | INFO | |
| message | String | | Step identifier or "dac_cookies" for cookie storage |
| meta | Json? | | Arbitrary data: step name, order details, or cookie array |
| createdAt | DateTime | now() | |
| **Index** | | | [tenantId, createdAt DESC] |

### Enums

| Enum | Values |
|------|--------|
| SubscriptionStatus | INACTIVE, TRIALING, ACTIVE, PAST_DUE, CANCELED, PAUSED |
| JobType | PROCESS_ORDERS, RETRY_FAILED |
| JobStatus | PENDING, RUNNING, COMPLETED, FAILED, PARTIAL |
| JobTrigger | CRON, WEBHOOK, MANUAL, MCP |
| LabelStatus | PENDING, CREATED, COMPLETED, FAILED, SKIPPED |
| PaymentType | REMITENTE, DESTINATARIO |
| LogLevel | INFO, WARN, ERROR, SUCCESS |

---

## 8. Authentication

### Signup Flow
1. User submits name, email, password, tosAccepted to `POST /api/auth/signup`
2. Zod validates: name 1-100, email valid, password 8-100, tosAccepted must be `true`
3. Checks for existing user by email (returns 409 if exists)
4. Password hashed with bcryptjs (12 rounds)
5. User + Tenant created in a single Prisma nested create
6. Tenant gets: slug from email prefix + base36 timestamp, apiKey from 32 random bytes hex
7. Captures `signupIp` from X-Forwarded-For and `tosAcceptedAt` for legal compliance
8. Returns 201 with userId and tenantId

### Login (Credentials)
1. User submits email + password to NextAuth credentials provider
2. Looks up user by email (lowercased)
3. Compares password against stored bcrypt hash
4. Returns user object {id, email, name}

### Login (Google OAuth)
1. Redirects to Google consent screen (if AUTH_GOOGLE_ID configured)
2. On callback, signIn hook checks if user exists by email
3. If new: creates User + Tenant automatically (emailVerified set to now())
4. If existing: links Account record

### Session (JWT Strategy)
- Strategy: JWT (not database sessions)
- MaxAge: 7 days
- JWT callback enriches token with: tenantId, tenantSlug, isActive, subscriptionStatus (queried from DB on each token refresh)
- Session callback copies these fields to session.user object
- All protected API routes call `getAuthenticatedTenant()` which reads session via `getServerSession(authOptions)`

### Middleware (`apps/web/middleware.ts`)
- **Public paths** (no auth): /login, /signup, /onboarding, /terminos, /privacidad, /api/auth, /api/webhooks, /api/v1/mcp, /_next, /favicon.ico, / (root)
- **Protected paths** (require JWT): /dashboard, /orders, /labels, /logs, /settings, /api/v1, /api/stripe, /api/mercadopago
- For protected API routes: returns 401 JSON `{ error: "Unauthorized" }`
- For protected pages: redirects to `/login?callbackUrl={path}`
- MCP endpoint (`/api/v1/mcp`) uses its own Bearer token auth (tenant.apiKey), not NextAuth
- Matcher: `/((?!_next/static|_next/image|favicon.ico).*)`

---

## 9. Billing

### MercadoPago (Primary -- Uruguay)

**Plans:**
| Plan | Price UYU/mo | Price USD equiv | Label Limit |
|------|-------------|-----------------|-------------|
| Starter | $600 | ~$15 | 100/month |
| Growth | $1,400 | ~$35 | 500/month |
| Pro | $2,760 | ~$69 | Unlimited (999999) |

**Subscription Flow:**
1. User clicks plan on `/settings/billing` or `/onboarding` step 3
2. Frontend calls `GET /api/mercadopago/checkout?plan=growth`
3. Server creates a PreApproval (recurring subscription) via MercadoPago SDK:
   - `reason`: "LabelFlow Growth - 500 etiquetas/mes"
   - `auto_recurring`: monthly, UYU currency, transaction_amount from PLANS config
   - `back_url`: /settings/billing
   - `external_reference`: `{tenantId}|{planId}` (parsed on webhook to identify tenant)
   - `payer_email`: user's email
4. User redirected to MercadoPago checkout (init_point URL)
5. User authorizes recurring payment on MercadoPago
6. MercadoPago sends webhook to `POST /api/webhooks/mercadopago`

**Webhook Handling (`/api/webhooks/mercadopago`):**
- HMAC signature verification via x-signature header (SHA-256)
- Accepts both new-style JSON (`type: "subscription_preapproval"`) and legacy IPN (`topic=preapproval`)
- Fetches full preapproval object from MercadoPago API
- Parses `external_reference` to extract tenantId and planId
- Status mapping:
  - `authorized` -> ACTIVE, isActive=true, labelsThisMonth=0, currentPeriodEnd from next_payment_date
  - `paused` -> PAST_DUE, isActive=false
  - `cancelled` -> CANCELED, isActive=false, stripeSubscriptionId=null
  - `pending` -> no change (logged)
- Payment notifications (recurring charge): extends period by 30 days, resets labelsThisMonth to 0

**Subscription stored as:**
- `stripeSubscriptionId`: `mp_sub_{preapprovalId}` (prefixed to identify as MercadoPago)
- `stripeCustomerId`: MercadoPago payer_id
- `stripePriceId`: plan ID (e.g., "starter", "growth", "pro")

**Cancellation (`POST /api/mercadopago/cancel`):**
- Extracts preapproval ID from stored subscription ID (strips "mp_sub_" prefix)
- Calls MercadoPago PreApproval.update with status="cancelled"
- Sets tenant to CANCELED, isActive=false, stripeSubscriptionId=null

### Stripe (Secondary -- International)

**Plans:**
| Plan | Env Var | Limit |
|------|---------|-------|
| Starter | STRIPE_PRICE_STARTER | 100/month |
| Growth | STRIPE_PRICE_GROWTH | 500/month |
| Pro | STRIPE_PRICE_PRO | Unlimited |

**Checkout:** `GET /api/stripe/checkout?plan=X` -> creates/gets Stripe customer, creates Checkout Session (subscription mode), redirects.

**Portal:** `GET /api/stripe/portal` -> creates Customer Portal session, redirects.

**Webhook Events (POST /api/webhooks/stripe):**
- `checkout.session.completed`: Activates subscription, sets ACTIVE
- `invoice.paid`: Renews period, resets labelsThisMonth to 0
- `invoice.payment_failed`: Sets PAST_DUE
- `customer.subscription.deleted`: Sets CANCELED, isActive=false
- `customer.subscription.updated`: Syncs status, price, period end

---

## 10. Order Processing Flow

### Step-by-step from trigger to completed label

**Timing estimates:**
- Cookie login (no CAPTCHA): ~2-5 seconds
- Full login with CAPTCHA: ~60-90 seconds
- Per order (form fill + submit): ~10-15 seconds
- PDF download + upload: ~5-10 seconds
- Total for 10 orders (with cookie login): ~3-5 minutes
- Total for 10 orders (with fresh login): ~4-6 minutes

### 1. Trigger (one of four)
- **Cron**: Worker scheduler checks every minute, finds tenants whose cronSchedule matches current time, verifies no PENDING/RUNNING jobs exist, creates Job + enqueues
- **Webhook**: Shopify `orders/paid` webhook -> HMAC-SHA256 verification -> `enqueueProcessOrders(tenantId, 'WEBHOOK')`
- **Manual**: User clicks "Ejecutar ahora" on dashboard -> `POST /api/v1/jobs` (checks active subscription + plan limit + no running job)
- **MCP**: Claude calls `process_pending_orders` tool -> creates Job via `enqueueProcessOrders(tenantId, 'MCP')`

### 2. Job Creation
- Job record created in PostgreSQL with status=PENDING
- Best-effort push to BullMQ via Redis (creates IORedis connection, enqueues, closes connection for serverless safety)
- If Redis unavailable, job stays in DB only (worker polls DB as fallback)
- Manual jobs can include `testMode` flag (processes but does not tag in Shopify) and `maxOrders` override (stored in RunLog meta)

### 3. Worker Picks Up Job
- Worker polls DB every 5 seconds (`findFirst where status=PENDING, orderBy createdAt asc`)
- Marks job as RUNNING with startedAt timestamp
- Checks for maxOrdersOverride in RunLog meta

### 4. Load Tenant Config
- Fetches full tenant from DB
- Decrypts shopifyToken and dacPassword using AES-256-GCM
- Validates both Shopify and DAC credentials are configured (fails fast if missing)

### 5. Fetch Shopify Orders
- Creates Axios client for Shopify Admin API 2024-01
- Queries: `GET /orders.json?financial_status=paid&fulfillment_status=unfulfilled&status=open&limit=250`
- Filters out orders with tag "labelflow-procesado" or note containing "LabelFlow-GUIA:"
- Filters out orders with existing CREATED/COMPLETED labels in DB (allows retry of FAILED)
- Applies maxOrdersPerRun limit (override from UI takes priority over tenant default)
- Excess orders counted as skipped

### 6. DAC Browser Session
- Gets or creates Playwright Chromium page (singleton DacBrowserManager)
- **Smart login** (`smartLogin()`):
  1. Try saved cookies from RunLog (max 4 hours old)
  2. If cookies work (navigates to /envios/nuevo without redirect to /login): skip CAPTCHA (~2s)
  3. If cookies expired: full login with CAPTCHA:
     - Navigate to `https://www.dac.com.uy/usuarios/login`
     - Fill `input[name="documento"]` with RUT + `input[name="password"]`
     - Solve reCAPTCHA v2 via 2Captcha API (sitekey: `6LeKGrIaAAAAAANa6NZk_i6xkQD-c-_U3Bt-OffC`)
     - Inject token into `#g-recaptcha-response` textarea
     - Submit via `window.LoginSend()` JavaScript function
     - Wait for redirect to /envios/**
  4. Save cookies to RunLog for next run

### 7. Process Each Order (sequential, 500ms delay between)

For each order (with retry wrapper, max 2 attempts):

**a) Determine payment type** (`rules/payment.ts`):
- If `total_price > paymentThreshold` (default 4000 UYU) -> REMITENTE (store pays shipping)
- If `total_price <= paymentThreshold` -> DESTINATARIO (customer pays on delivery)
- USD orders converted at approximate rate of 42 UYU/USD

**b) Validate shipping address**: Skip if no address1 (upsert FAILED label, add Shopify note)

**c) Create DAC shipment** (`dac/shipment.ts`, 4-step form):
- Navigate to `https://www.dac.com.uy/envios/nuevo`
- **Step 1** (Service Type):
  - TipoServicio = "0" (Mostrador)
  - TipoGuia = "1" (Remitente) or "4" (Destinatario) based on payment type
  - TipoEnvio = "1" (Paquete)
  - TipoEntrega = "2" (Domicilio)
  - Click Siguiente
- **Step 2** (Origin): Auto-filled from DAC account -> Click Siguiente
- **Step 3** (Recipient):
  - Fill NombreD (full name from shipping_address)
  - Fill TelD (phone, cleaned to digits, fallback "099000000")
  - Fill Correo_Destinatario (email, optional)
  - Fill DirD (address1)
  - Select K_Estado (department) using fuzzy matching
  - Wait 1500ms for K_Ciudad cascade load
  - Select K_Ciudad (city) using fuzzy matching
  - Select K_Barrio (first available option)
  - **Bypass**: Skip Siguiente click (silent JS validation bug), force `#cargaEnvios` fieldset visible, set fake lat/lng for geocoding bypass
- **Step 4** (Package):
  - Set K_Tipo_Empaque = "1" (Hasta 2Kg 20x20x20) via Choices.js UI
  - Set Cantidad = "1"
  - Click `.btnAdd` (Agregar) button
  - Handle address validation modal if it appears
  - Retry Agregar if cart item not detected
  - Fill Observaciones textarea (address2 + order notes)
  - Click Finalizar envio button
- **Extract guia**: regex `/\b88\d{10,}\b/` on current page, then on `/envios` historial page, fallback `PENDING-{timestamp}`

**d) Download PDF label** (`dac/label.ts`):
- Navigate to history/cart page
- Try download selectors: `a:has-text("Descargar"), a[href*="etiqueta"], a[href*=".pdf"]`
- Fallback: find PDF link in page, fetch with cookies via axios
- Save to tmp dir

**e) Upload to Supabase Storage**: Path `{tenantId}/{YYYY-MM-DD}/{labelId}.pdf` with upsert

**f) Upsert Label record** in DB (by tenantId+shopifyOrderId unique constraint) with all order details, guia, status=CREATED then COMPLETED after PDF upload

**g) Mark Shopify order** (skip in testMode):
- Add tag "labelflow-procesado"
- Add note "LabelFlow-GUIA: {guia} | {ISO timestamp}"
- Non-fatal if fails (403 from insufficient permissions)

**h) Send email notification** (if tenant has SMTP configured):
- HTML email via nodemailer with branded template
- Subject: "Tu pedido #X esta en camino (Guia DAC: Y)"
- Content: customer name, order name, guia number, DAC tracking link, product list, payment notice (DESTINATARIO: "El envio se paga al recibirlo"), estimated delivery 24-48 business hours
- Update label record: emailSent=true, emailSentAt

### 8. Job Completion
- Save DAC cookies for next run (stored in RunLog as JSON)
- Close browser
- Update Job record: status (COMPLETED if failedCount=0, PARTIAL if both success and failed, FAILED if all failed), counts, durationMs
- Increment tenant.labelsThisMonth and labelsTotal
- Update tenant.lastRunAt

---

## 11. DAC Automation Details

### URLs
| URL | Purpose |
|-----|---------|
| `https://www.dac.com.uy/usuarios/login` | Login page |
| `https://www.dac.com.uy/envios/nuevo` | New shipment form |
| `https://www.dac.com.uy/envios/cart` | Cart / history page |
| `https://www.dac.com.uy/envios` | Shipment history |
| `https://www.dac.com.uy/envios/rastrear` | Public tracking page |

### Login Selectors
| Selector | Purpose |
|----------|---------|
| `input[name="documento"]` | Username field (Documento or RUT number, NOT email) |
| `input[name="password"]` | Password field |
| `#btnLogin` | Login button (type="button", NOT submit) |
| `text=Bienvenido` | Success indicator after login |

### reCAPTCHA
- Site key: `6LeKGrIaAAAAAANa6NZk_i6xkQD-c-_U3Bt-OffC`
- Type: reCAPTCHA v2
- Solved via 2Captcha service (CAPTCHA_API_KEY env var)
- Token injected into `#g-recaptcha-response` textarea
- Also injected into all `textarea[name="g-recaptcha-response"]` elements
- Submitted via `window.LoginSend()` function (NOT form submit)
- Average solve time: 60-90 seconds
- Cookie persistence reduces frequency (saves ~60s per run for up to 4 hours)

### Form Selectors (4-step single-page form)

**Step 1 - Service Type:**
| Selector | Values | Notes |
|----------|--------|-------|
| `select[name="TipoServicio"]` | "0" = Mostrador, "1" = Levante | |
| `[name="TipoGuia"]` | "1" = Remitente, "4" = Destinatario | May be select or hidden input |
| `select[name="TipoEnvio"]` | "1" = Paquete | |
| `select[name="TipoEntrega"]` | "2" = Domicilio | |

**Step 2 - Origin:** Auto-filled from DAC account, just click Siguiente

**Step 3 - Recipient:**
| Selector | Purpose | Notes |
|----------|---------|-------|
| `input[name="NombreD"]` | Full name | |
| `input[name="TelD"]` | Phone | Cleaned to digits, fallback "099000000" |
| `input[name="RUT_Destinatario"]` | RUT | Optional |
| `input[name="Correo_Destinatario"]` | Email | Optional |
| `input[name="DirD"]` | Street address | Also tried via `#DirD` |
| `select[name="K_Estado"]` | Department (1-19) | Fuzzy matched |
| `select[name="K_Ciudad"]` | City | Cascading, loads after department (1500ms wait) |
| `select[name="K_Barrio"]` | Neighborhood | Cascading, loads after city (800ms wait) |

**Step 4 - Quantity/Package:**
| Selector | Values | Notes |
|----------|--------|-------|
| `select[name="K_Tipo_Empaque"]` | "1" = Hasta 2Kg 20x20x20 | Set via Choices.js UI |
| `input[name="Cantidad"]` | "1" | Default |

**Navigation:**
| Selector | Purpose |
|----------|---------|
| `a:has-text("Siguiente")` | Advance to next step |
| `button:has-text("Agregar")` or `.btnAdd` | Submit (add to cart) |
| `button:has-text("Finalizar")` or `.btnSave` | Finalize shipment |

### Fuzzy Matching for Dropdowns
The `findBestOptionMatch()` function uses 4 strategies in order:
1. **Exact match**: case-insensitive, accent-insensitive via NFD normalization + diacritic removal
2. **Contains match**: option text contains search text
3. **Reverse contains**: search text contains option text (for longer addresses)
4. **Word match**: any word > 2 chars from search matches any word from option

### Cookie Persistence
- After successful login, cookies saved to RunLog (tenantId-scoped, message="dac_cookies")
- On next run, cookies loaded if < 4 hours old
- Cookie login navigates to /envios/nuevo to test if session is valid
- If redirected to /login: cookies expired, proceed to full login
- Cookies filtered to dac.com.uy domain only

### Known Workarounds
1. **Silent validation bypass**: Step 3's Siguiente button has silent JS validation that blocks even with all fields filled. Workaround: force `#cargaEnvios` fieldset visible via DOM manipulation.
2. **Geocoding bypass**: DAC requires geocoded address (lat/lng). Workaround: set fake coordinates (-34.4565, -57.4506) for Juan Lacaze area.
3. **Address validation modal**: After Agregar, DAC may show "No ha seleccionado una direccion validada" modal. Workaround: dismiss modal, item is still in cart.
4. **Choices.js dropdown**: K_Tipo_Empaque uses Choices.js library, native selectOption doesn't work. Workaround: set hidden select value + click through Choices.js UI.

### Guia Extraction
After form submission, guia number extracted using regex `/\b88\d{10,}\b/`:
1. Search current page text (confirmation page)
2. If not found, navigate to `/envios` historial and search there (take last match = most recent)
3. Fallback: `PENDING-{timestamp}`

### Selector Update Tool
Run `npm run probe-dac` in apps/worker to open visible Chrome, navigate dac.com.uy, take screenshots, log all inputs/selects. Screenshots saved to `./dac-screenshots/`.

---

## 12. Worker Architecture

### Entry Point (`src/index.ts`)
- Loads config via Zod schema validation (exits with error details if invalid)
- Starts infinite polling loop with 5-second interval
- Each cycle: `findFirst where status=PENDING, orderBy createdAt asc`
- If job found: marks RUNNING, calls `processOrdersJob(tenantId, jobId)`
- Graceful shutdown on SIGTERM/SIGINT: closes browser, disconnects Prisma

### Config (`src/config.ts`)
Validated with Zod from environment variables:
| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| DATABASE_URL | Yes | | PostgreSQL connection string |
| REDIS_URL | Yes | | Upstash Redis URL |
| ENCRYPTION_KEY | Yes | | 32-byte hex, must match web app |
| WORKER_CONCURRENCY | No | 2 | Currently not used (single poll loop) |
| PLAYWRIGHT_HEADLESS | No | "true" | Set "false" for debugging |
| LABELS_TMP_DIR | No | /tmp/labelflow | Temp storage for PDFs before upload |
| CAPTCHA_API_KEY | No | | 2Captcha API key (required for DAC login) |
| SUPABASE_URL | No | | From NEXT_PUBLIC_SUPABASE_URL |
| SUPABASE_SERVICE_ROLE_KEY | No | | For Storage uploads |
| SUPABASE_STORAGE_BUCKET | No | "labels" | Bucket name |

### Job Processing Mode
- **Primary**: DB polling every 5 seconds, queries for PENDING jobs
- **Secondary**: BullMQ consumer via Redis (if available, used by scheduler)
- The web app creates Job records in DB first, then best-effort enqueues to BullMQ. The worker always checks DB, so jobs are never lost even if Redis is down.

### Scheduler (`src/jobs/scheduler.ts`)
- Uses node-cron to check every minute
- Queries all active tenants with complete config (Shopify + DAC credentials, isActive=true, subscriptionStatus=ACTIVE)
- Parses each tenant's cronSchedule minute field:
  - `*` -> runs every minute
  - `*/N` -> runs when current minute is divisible by N
  - Specific minute -> exact match
- Checks for existing PENDING/RUNNING jobs (prevents duplicate runs)
- Creates Job in DB + enqueues to BullMQ

### Retry Logic
- Each order gets up to 2 attempts (MAX_RETRIES_PER_ORDER = 2)
- 2-second delay between retries
- Label records use upsert (by tenantId+shopifyOrderId) to handle retries of previously FAILED labels
- If a job-level error occurs (e.g., DAC login fails), the entire job fails without retrying

### Docker Deployment
```dockerfile
FROM mcr.microsoft.com/playwright:v1.50.0-noble
# Playwright browsers (Chromium) pre-installed in base image
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 avoids re-downloading
# Prisma client generated at build time
# TypeScript compiled with --skipLibCheck (allows build despite type issues)
# CMD: node dist/index.js
```

### Logging
- **Console**: pino structured JSON logging (level from LOG_LEVEL env, default "info")
- **DB**: `createStepLogger()` writes to both pino AND RunLog table
- Each micro-step has a unique identifier (36 constants in `dac/steps.ts`)
- DB write failures are caught and ignored (never crash the worker)
- Sensitive data masked: `maskEmail()`, `maskToken()`

---

## 13. API Reference

### Auth

| Method | Path | Auth | Body/Params | Response |
|--------|------|------|-------------|----------|
| GET/POST | `/api/auth/[...nextauth]` | Public | NextAuth protocol | NextAuth handlers |
| POST | `/api/auth/signup` | Public | `{ name, email, password, tosAccepted: true }` | 201: `{ data: { userId, tenantId } }` or 400/409/500 |

**Signup validation:**
- name: string, 1-100 chars
- email: valid email format
- password: string, 8-100 chars
- tosAccepted: must be literal `true`

### Protected API (v1)

All require NextAuth session (cookie-based JWT).

| Method | Path | Body/Params | Response |
|--------|------|-------------|----------|
| GET | `/api/v1/settings` | | Tenant config (secrets as booleans: shopifyTokenSet, dacPasswordSet, emailPassSet) |
| PUT | `/api/v1/settings` | Partial update object | `{ data: { message } }` |
| GET | `/api/v1/jobs` | | Last 20 jobs (id, status, trigger, counts, timing) |
| POST | `/api/v1/jobs` | `{ testMode?: bool, maxOrders?: 1-50 }` | 202: `{ data: { jobId, maxOrders, message } }` |
| GET | `/api/v1/orders?page=1&limit=20&status=all` | Query params | Paginated labels with meta (total, page, limit, hasNext) |
| GET | `/api/v1/labels/{id}` | | Single label with signed PDF URL |
| GET | `/api/v1/logs?jobId=X&since=ISO&limit=200` | Query params | `{ data: { logs, activeJob } }` |

**PUT /api/v1/settings validated fields:**
- `shopifyStoreUrl`: regex `^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$`
- `shopifyToken`: encrypted before storage; Shopify connection verified by calling `/admin/api/2024-01/shop.json`
- `dacUsername`, `dacPassword`: dacPassword encrypted
- `emailHost`, `emailPort` (1-65535), `emailUser`, `emailPass` (encrypted), `emailFrom`
- `storeName` (max 100)
- `paymentThreshold` (0-1000000)
- `cronSchedule`: valid 5-field cron, minimum 15-minute interval enforced
- `maxOrdersPerRun` (1-50)

**POST /api/v1/jobs guards:**
- Tenant must have isActive=true AND subscriptionStatus=ACTIVE
- labelsThisMonth must be below plan limit
- No existing PENDING/RUNNING job

### Billing

| Method | Path | Auth | Params | Response |
|--------|------|------|--------|----------|
| GET | `/api/stripe/checkout?plan=X` | Session | plan: starter/growth/pro | Redirect to Stripe Checkout |
| GET | `/api/stripe/portal` | Session | | Redirect to Stripe Customer Portal |
| GET | `/api/mercadopago/checkout?plan=X` | Session | plan: starter/growth/pro | Redirect to MercadoPago PreApproval |
| POST | `/api/mercadopago/cancel` | Session | | `{ success, message }` |

### Webhooks

| Method | Path | Auth | Trigger |
|--------|------|------|---------|
| POST | `/api/webhooks/shopify` | HMAC-SHA256 (X-Shopify-Hmac-SHA256, secret = tenant's Shopify token) | orders/paid event |
| POST | `/api/webhooks/stripe` | Stripe signature (stripe-signature header, STRIPE_WEBHOOK_SECRET) | 5 subscription events |
| POST/GET | `/api/webhooks/mercadopago` | HMAC signature (x-signature header, MERCADOPAGO_WEBHOOK_SECRET) | subscription_preapproval + payment |

### MCP Endpoint

| Method | Path | Auth |
|--------|------|------|
| POST | `/api/v1/mcp` | Bearer token (tenant.apiKey, 64-char hex) |

**JSON-RPC 2.0 Methods:**
- `initialize` -> server info (name: "labelflow", version: "1.0.0") + capabilities
- `tools/list` -> 4 available tools
- `tools/call` -> execute a tool

**MCP Tools:**
| Tool | Input | Output |
|------|-------|--------|
| `process_pending_orders` | none | `{ jobId, message }` or error (inactive plan, already running) |
| `get_daily_summary` | none | `{ labelsToday, successToday, failedToday, lastRunAt, lastRunStatus }` |
| `get_order_status` | `{ orderName: "#1234" }` | Label details (status, guia, customer, city) or not_found |
| `list_recent_labels` | `{ limit?: 1-50 }` | `{ labels: [...], count }` |

**Claude Desktop config:**
```json
{
  "mcpServers": {
    "labelflow": {
      "url": "https://autoenvia.com/api/v1/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

---

## 14. Dashboard Pages

### Landing Page (`/`)
- Public, no auth
- Hero section with CTA "Empezar gratis 14 dias"
- How it works (3 steps: connect, detect, labels)
- Pricing section (3 plans in USD)
- FAQ section (5 questions about DAC automation, notifications, etc.)
- Footer with links to Terms and Privacy

### Login (`/login`)
- Email + password form
- signIn via NextAuth credentials provider
- Google OAuth button (if configured)
- Link to signup
- Redirects to /dashboard on success

### Signup (`/signup`)
- Name, email, password fields
- ToS acceptance checkbox (links to /terminos and /privacidad)
- POST to /api/auth/signup
- Redirects to /login?registered=true on success

### Onboarding (`/onboarding`)
- 3-step wizard with progress bar
- Step 1: Shopify store URL + Admin API token (with instructions)
- Step 2: DAC Documento/RUT + password
- Step 3: Plan selection (3 cards, redirects to MercadoPago)
- "Saltar por ahora" skip button at top
- Each step saves via PUT /api/v1/settings

### Dashboard (`/dashboard`)
- Stats cards: labels today, labels this month, success rate, last run time
- Connection status indicators (Shopify, DAC, Email)
- "Ejecutar ahora" trigger button with order count selector (1-50)
- Recent jobs table (last 20: status, trigger, counts, duration)
- Live **JobFeedPanel** when a job is running
- Calls: GET /api/v1/settings (stats), GET /api/v1/jobs, POST /api/v1/jobs (trigger)

### Orders (`/orders`)
- Table of processed labels with columns: order name, customer, guia, status, payment type, city, date
- Search filter, status filter (all/completed/failed/skipped)
- Pagination (page/limit)
- Expandable row with full details
- Calls: GET /api/v1/orders

### Labels (`/labels`)
- PDF label gallery grouped by date
- Download links via signed URLs
- Calls: GET /api/v1/orders, GET /api/v1/labels/{id}

### Logs (`/logs`)
- Job execution history
- Expandable log viewer per job
- Calls: GET /api/v1/jobs, GET /api/v1/logs

### Settings (`/settings`)
- Shopify config: store URL + token (verified on save)
- DAC config: username + password
- Email config: host, port, user, password, from address, store name
- Payment rules: threshold amount (UYU)
- Schedule: cron expression (default */15 * * * *, min 15 min)
- Max orders per run (1-50)
- API Key display (for MCP integration)
- Calls: GET/PUT /api/v1/settings

### Billing (`/settings/billing`)
- Current plan display with usage
- 3 plan cards (Starter/Growth/Pro)
- MercadoPago checkout redirect
- Cancel subscription button
- Stripe portal link (if Stripe subscription)
- Calls: GET /api/v1/settings, GET /api/mercadopago/checkout, POST /api/mercadopago/cancel

---

## 15. Feed Panel

### How JobFeedPanel Works

**Component:** `components/JobFeedPanel.tsx`
- Receives `jobId` and `onClose` props
- Uses `useJobFeed(jobId)` hook to poll logs
- Filters logs through `getDisplayMessage()` from `lib/log-messages.ts`
- Only shows logs that have a mapped display message (hides internal debug logs)
- Auto-scrolls to bottom on new logs
- Shows elapsed timer, success/failure counts
- Terminal-style UI with blinking cursor when running

**Hook:** `hooks/useJobFeed.ts`
- Polls `GET /api/v1/logs?jobId=X&since=LAST&limit=50` every 2 seconds
- Deduplicates logs by ID (prevents duplicates on re-fetch)
- Tracks `isRunning` state from job status (PENDING or RUNNING)
- Resets state when jobId changes

**Log Messages:** `lib/log-messages.ts`
- Maps RunLog entries (by `meta.step` field) to user-friendly Spanish messages with emojis
- 17 mapped step messages covering: DAC login, Shopify fetch, per-order progress (form fill, guia extraction), DB/email operations, job completion
- ERROR level logs always shown (prefixed with X emoji)
- All other logs without a mapped step are hidden from the feed

---

## 16. Environment Variables

### Web App (Vercel)
| Variable | Required | Description |
|----------|----------|-------------|
| DATABASE_URL | Yes | Supabase PostgreSQL connection string (must use pooler URL for serverless) |
| DIRECT_URL | Yes | Direct PostgreSQL connection (for Prisma migrations) |
| NEXTAUTH_SECRET | Yes | JWT signing secret (openssl rand -base64 32) |
| NEXTAUTH_URL | Yes | App base URL (https://autoenvia.com) |
| NEXT_PUBLIC_APP_URL | Yes | Public app URL (https://autoenvia.com) |
| ENCRYPTION_KEY | Yes | 32-byte hex for AES-256-GCM (openssl rand -hex 32) |
| APP_NAME | No | Display name (default: "LabelFlow") |
| NEXT_PUBLIC_SUPABASE_URL | Yes | Supabase project URL |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | Yes | Supabase anonymous key |
| SUPABASE_SERVICE_ROLE_KEY | Yes | Supabase admin key (server-side only, for Storage) |
| SUPABASE_STORAGE_BUCKET | No | Storage bucket name (default: "labels") |
| REDIS_URL | No | Upstash Redis connection string (for BullMQ best-effort) |
| UPSTASH_REDIS_REST_URL | No | Upstash REST endpoint (alternative Redis access) |
| UPSTASH_REDIS_REST_TOKEN | No | Upstash REST token |
| MERCADOPAGO_ACCESS_TOKEN | Yes* | MercadoPago API access token (APP_USR-...) |
| NEXT_PUBLIC_MERCADOPAGO_PUBLIC_KEY | No | MercadoPago public key |
| MERCADOPAGO_WEBHOOK_SECRET | Yes* | HMAC secret for webhook signature verification |
| STRIPE_SECRET_KEY | No | Stripe API secret key |
| STRIPE_WEBHOOK_SECRET | No | Stripe webhook signing secret |
| NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY | No | Stripe public key |
| STRIPE_PRICE_STARTER | No | Stripe Price ID for Starter plan |
| STRIPE_PRICE_GROWTH | No | Stripe Price ID for Growth plan |
| STRIPE_PRICE_PRO | No | Stripe Price ID for Pro plan |
| AUTH_GOOGLE_ID | No | Google OAuth client ID |
| AUTH_GOOGLE_SECRET | No | Google OAuth client secret |
| MCP_SECRET | No | MCP server secret (currently unused, API key used instead) |

*Required for billing to work

### Worker (Render)
| Variable | Required | Description |
|----------|----------|-------------|
| DATABASE_URL | Yes | Same Supabase connection string |
| REDIS_URL | Yes | Same Upstash Redis URL |
| ENCRYPTION_KEY | Yes | Same 32-byte hex key (MUST match web app) |
| WORKER_CONCURRENCY | No | Max parallel jobs (default: 2, currently single-threaded) |
| PLAYWRIGHT_HEADLESS | No | "true" or "false" (default: "true") |
| LABELS_TMP_DIR | No | Temp directory for PDFs (default: /tmp/labelflow) |
| CAPTCHA_API_KEY | Yes* | 2Captcha API key for reCAPTCHA solving |
| NEXT_PUBLIC_SUPABASE_URL | Yes | Supabase URL (for Storage uploads) |
| SUPABASE_SERVICE_ROLE_KEY | Yes | Supabase admin key (for Storage uploads) |
| SUPABASE_STORAGE_BUCKET | No | Bucket name (default: "labels") |
| LOG_LEVEL | No | pino log level (default: "info") |
| NODE_ENV | No | Set to "production" in Docker |

*Required for DAC login (cookies bypass CAPTCHA for up to 4 hours)

---

## 17. Security Measures

### Credential Encryption
- **Algorithm**: AES-256-GCM (authenticated encryption with integrity verification)
- **Key**: 32-byte hex string from ENCRYPTION_KEY env var (shared between web and worker)
- **Format**: `{iv_hex}:{auth_tag_hex}:{ciphertext_hex}` (colon-separated)
- **IV**: 16 random bytes per encryption (never reused)
- **Auth tag**: 16 bytes for integrity verification
- **Encrypted fields**: shopifyToken, dacPassword, emailPass
- **Settings API**: never returns encrypted values (returns boolean flags like `shopifyTokenSet: true`)

### Authentication
- **Passwords**: bcryptjs with 12 salt rounds
- **Sessions**: JWT with 7-day expiry, signed with NEXTAUTH_SECRET
- **API routes**: session-based via `getServerSession()` -> `getAuthenticatedTenant()`
- **MCP endpoint**: Bearer token (tenant.apiKey, 64-char hex, unique per tenant)
- **Shopify webhook**: HMAC-SHA256 verification using tenant's decrypted Shopify token as secret, timing-safe comparison
- **Stripe webhook**: signature verification using STRIPE_WEBHOOK_SECRET via Stripe SDK
- **MercadoPago webhook**: HMAC-SHA256 signature verification (x-signature header with ts and v1 components)

### Tenant Isolation
- Every database query includes `tenantId` in WHERE clause
- `getAuthenticatedTenant()` extracts tenantId from JWT session (cannot be spoofed)
- Labels have unique constraint on [tenantId, shopifyOrderId]
- Supabase Storage paths namespaced by tenantId: `{tenantId}/{date}/{labelId}.pdf`
- MCP API key is unique per tenant, looked up directly from DB
- Cookies stored per-tenant in RunLog (filtered by tenantId)

### Input Validation
- Zod schemas on signup (name/email/password lengths, tosAccepted literal)
- Zod schemas on settings update (shopifyStoreUrl regex, cronSchedule with minimum interval, port range 1-65535, maxOrdersPerRun 1-50, paymentThreshold 0-1000000)
- Shopify token verified by actually calling Shopify API before saving
- All API responses use consistent format: `{ error }` or `{ data, meta? }`

### Rate Limiting
- **Shopify**: monitors X-Shopify-Shop-Api-Call-Limit header, warns at 80% usage
- **DAC**: 500ms delay between orders, max 20 orders per run (configurable 1-50)
- **Cron schedule**: minimum 15-minute interval enforced via Zod validation
- **Jobs**: only one PENDING/RUNNING job per tenant at a time (checked before creation)

### XSS Prevention
- Email templates use `escapeHtml()` function for all dynamic content
- Next.js React components auto-escape by default

### Logging Safety
- `maskEmail()`: shows only first 2 chars of local part
- `maskToken()`: shows only first 6 chars
- RunLog DB writes are fire-and-forget (caught errors, never crash worker)

---

## 18. Legal Compliance

### Uruguayan Law
- **Ley 18.331** (Data Protection): Privacy Policy at /privacidad, covers personal data handling, user rights, URCDP registration intent
- **Ley 17.250** (Consumer Protection): Terms of Service at /terminos, covers service description, limitations, cancellation rights
- **Signup IP capture**: X-Forwarded-For stored in tenant.signupIp for compliance
- **ToS acceptance timestamp**: stored in tenant.tosAcceptedAt with checkbox requirement
- **URCDP**: Unidad Reguladora y de Control de Datos Personales (Uruguay's data protection authority)

### Data Handling
- Credentials encrypted at rest (AES-256-GCM)
- Signed URLs for PDF access (1-hour expiry)
- No actual credentials stored in code or documentation
- Environment variables for all secrets

---

## 19. Known Limitations

| Limitation | Impact | Workaround |
|-----------|--------|------------|
| GPS coordinates hardcoded | DAC requires geocoded addresses; fake lat/lng (-34.4565, -57.4506) set for all orders | Could integrate geocoding API in future |
| Cron scheduler simplified | Only parses minute field of cron expression (*, */N, specific minute); ignores hour/day fields | Works for common intervals (every 15/30/60 min) |
| Shopify tag 403 | Some tokens lack write_orders permission | Error is non-fatal; user must update Shopify app permissions |
| Step 3 silent validation | DAC's Siguiente button has JS validation that blocks even with valid data | Force Step 4 fieldset visible via DOM manipulation |
| Choices.js dropdown | K_Tipo_Empaque uses Choices.js, native select doesn't work | Dual approach: set hidden select + click Choices.js UI |
| Address validation modal | DAC shows modal after Agregar for unvalidated addresses | Dismiss modal automatically; item is still added to cart |
| No real-time WebSocket | Job feed uses 2-second polling, not real-time push | Acceptable for current scale |
| Single worker thread | Only one order processed at a time (sequential) | 500ms delay between orders is intentional for DAC rate limiting |
| Cookie expiry | DAC cookies expire after ~4 hours | Automatic re-login with CAPTCHA when cookies expire |
| CAPTCHA cost | Each full login costs ~$0.003 (2Captcha) | Cookie persistence minimizes frequency |
| No PDF download for all guias | Some guias show as PENDING-timestamp | Can be extracted retroactively from DAC history |
| USD conversion approximate | Uses fixed rate of 42 UYU/USD | Should integrate real-time exchange rate API |
| MercadoPago webhook no replay | If webhook fails, no automatic retry from MercadoPago | Manual DB update if subscription activation missed |
| Scheduler uses BullMQ only | Scheduler enqueues to BullMQ but DB polling is primary | Both paths create Job in DB, so no jobs are lost |

---

## 20. Scalability

### Current Limits
- **Orders per run**: configurable 1-50 (default 20)
- **Concurrent jobs**: 1 per tenant (enforced by isJobRunning check)
- **Worker instances**: 1 Docker container on Render
- **Database connections**: Supabase free tier (limited pool)
- **Redis**: Upstash free tier (limited commands/day)
- **Storage**: Supabase free tier (1GB)
- **CAPTCHA**: pay-per-use (no limit)

### How to Scale
- **More tenants**: Add more worker instances (each polls DB independently)
- **More orders**: Increase maxOrdersPerRun (up to 50) and reduce cronSchedule interval
- **Faster processing**: Run multiple worker containers with different DB polling offsets
- **Database**: Upgrade Supabase plan for more connections and storage
- **Redis**: Upgrade Upstash plan or use dedicated Redis
- **Multi-region**: Deploy worker closer to dac.com.uy servers (South America)
- **Browser pool**: Implement Playwright browser pool for parallel order processing (currently sequential)

---

## 21. Common Issues and Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| DAC login fails | Credentials wrong or DAC changed UI | Verify RUT + password at dac.com.uy manually; run `npm run probe-dac` |
| "Selector not found" | DAC changed their HTML/CSS | Run `npm run probe-dac`, update `src/dac/selectors.ts` |
| Shopify 429 | Rate limit exceeded | Lower maxOrdersPerRun in settings |
| Order skipped (no address) | Customer has no shipping address | Automatic skip, FAILED label + Shopify note |
| PDF not downloaded | DAC session expired mid-run | Worker re-logs in automatically via `ensureLoggedIn()` |
| Email not sent | Bad SMTP credentials | Verify Gmail App Password (not account password) |
| Job stuck in RUNNING | Worker crashed mid-job | Restart worker; manually update job status to FAILED in DB; create new manual job |
| Stripe webhook fails | Wrong STRIPE_WEBHOOK_SECRET | Re-copy secret from Stripe dashboard |
| MercadoPago webhook ignores | external_reference not parsed | Check PreApproval creation includes `{tenantId}|{planId}` format |
| DB connection refused | Supabase needs pooler for serverless | Use connection string with pooler URL (port 6543) |
| Build fails on Vercel | Prisma client not generated | vercel.json runs `prisma generate` before `next build` |
| Worker can't decrypt | ENCRYPTION_KEY mismatch between web and worker | Must be the exact same 32-byte hex key |
| CAPTCHA solving slow (>90s) | 2Captcha queue busy | Normal variation; cookie persistence reduces frequency |
| City/Department not matched | Accent differences between Shopify and DAC | Fuzzy matching normalizes accents via NFD; update Shopify province spelling if needed |
| Guia shows "PENDING-..." | DAC didn't show guia in expected location | Check history page; guia may be extracted on next run |
| labelsThisMonth not resetting | No payment webhook received | Manually reset in DB or ensure MercadoPago webhook URL is correct |
| "Already running" error | Previous job did not complete | Check job status in /logs; if stuck, update status to FAILED in DB |
| Phone field not filled | Old selector "TelefonoD" vs correct "TelD" | Fixed in current code; field is `input[name="TelD"]` |
| Agregar button invisible | Step 3 validation blocking Step 4 | Fixed: force `#cargaEnvios` visible via DOM manipulation |
| Duplicate labels | Race condition on concurrent triggers | Unique constraint on [tenantId, shopifyOrderId] + isJobRunning() check |
| Render not auto-deploying | Auto-deploy setting not triggered | Manual deploy from Render dashboard; verify repo connection |

---

## 22. Deployment Guide

### Web (Vercel)

```bash
# From repository root
cd apps/web

# Deploy to production
npx vercel deploy --prod

# Or link and deploy
npx vercel link  # first time
npx vercel --prod
```

**Vercel Configuration (`vercel.json`):**
```json
{
  "buildCommand": "npx prisma generate --schema=prisma/schema.prisma && next build",
  "installCommand": "npm install",
  "framework": "nextjs"
}
```

**Setup Steps:**
1. Create Vercel project, link to repo (root: `apps/web`)
2. Set ALL web environment variables in Vercel dashboard
3. Ensure DATABASE_URL uses Supabase connection **pooler** URL (port 6543, `?pgbouncer=true`)
4. Deploy; `postinstall` script runs `prisma generate`

### Worker (Render)

```bash
# Worker deploys via Docker from apps/worker/Dockerfile
```

**Setup Steps:**
1. Create Render Web Service (or Background Worker)
2. Point to repository, set Docker context to `apps/worker`
3. Set Dockerfile path: `apps/worker/Dockerfile`
4. Set ALL worker environment variables
5. Docker base image includes Chromium (`mcr.microsoft.com/playwright:v1.50.0-noble`)
6. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (browsers already in image)
7. Start command: `node dist/index.js`
8. Deploy; Render auto-deploys on push (if configured)

### Database Migrations

```bash
# Generate Prisma client (required before build)
npx prisma generate --schema=apps/web/prisma/schema.prisma

# Push schema changes (development, no migration history)
npx prisma db push --schema=apps/web/prisma/schema.prisma

# Create migration (production, with migration history)
npx prisma migrate dev --schema=apps/web/prisma/schema.prisma

# Open Prisma Studio (database GUI)
npx prisma studio --schema=apps/web/prisma/schema.prisma
```

### Webhook Configuration

**Shopify:**
- Admin > Settings > Notifications > Webhooks
- URL: `https://autoenvia.com/api/webhooks/shopify`
- Event: `Order payment` (orders/paid)
- Format: JSON

**Stripe:**
- Stripe Dashboard > Developers > Webhooks
- URL: `https://autoenvia.com/api/webhooks/stripe`
- Events: checkout.session.completed, invoice.paid, invoice.payment_failed, customer.subscription.deleted, customer.subscription.updated

**MercadoPago:**
- MercadoPago Dashboard > Your Application > Webhooks
- URL: `https://autoenvia.com/api/webhooks/mercadopago`
- Events: subscription_preapproval, payment

---

## 23. Services and Accounts

| Service | Purpose | Required Credentials |
|---------|---------|---------------------|
| Supabase | PostgreSQL + Storage | DATABASE_URL, DIRECT_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY |
| Upstash | Redis for BullMQ | REDIS_URL |
| Vercel | Web hosting | Vercel account + project linked to repo |
| Render.com | Worker hosting | Render account + Dockerfile deploy |
| MercadoPago | Subscription billing (UYU) | MERCADOPAGO_ACCESS_TOKEN, MERCADOPAGO_WEBHOOK_SECRET |
| Stripe | Alternative billing (USD) | STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, 3 price IDs |
| 2Captcha | reCAPTCHA solving | CAPTCHA_API_KEY |
| Google Cloud | OAuth provider (optional) | AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET |
| GoDaddy | Domain (autoenvia.com) | DNS management access |
| Gmail/SMTP | Email notifications | Per-tenant: emailHost, emailUser, emailPass (Gmail App Password) |
| Shopify | E-commerce platform | Per-tenant: store URL + Admin API token (read_orders, write_orders scopes) |
| DAC Uruguay | Courier service | Per-tenant: Documento/RUT + password for dac.com.uy |

**No actual secrets are stored in this file. All credentials are in environment variables.**

---

## 24. Cost Breakdown

| Service | Plan | Monthly Cost | Notes |
|---------|------|-------------|-------|
| Vercel | Hobby | $0 | Free tier, serverless functions |
| Render.com | Starter | $7 | Docker container for worker |
| Supabase | Free | $0 | 500MB DB, 1GB storage, 2GB transfer |
| Upstash | Free | $0 | 10K commands/day |
| 2Captcha | Pay-per-use | ~$0.50-3 | ~$0.003/solve, depends on login frequency |
| GoDaddy | Domain | ~$1 | ~$12/year for .com |
| MercadoPago | Commission | ~3.5% + IVA | Deducted from subscription payments |
| Stripe | Commission | ~2.9% + $0.30 | If international billing used |
| **Infrastructure Total** | | **~$8-11/mo** | Before payment processor commissions |

**Revenue per customer:**
- Starter: $15/mo -> ~$14.50 after MercadoPago fees
- Growth: $35/mo -> ~$33.80 after fees
- Pro: $69/mo -> ~$66.60 after fees

**Break-even**: 1 Starter customer covers infrastructure costs.
