# Arquitectura — LabelFlow SaaS (AutoEnvía + AutoBoost + Coins)

> Fase 0 del prompt maestro. Todo lo de abajo está **verificado leyendo código**
> el 2026-09-01, no inferido del portal público. Donde dice *inferido* es inferido.

## 1. Stack real detectado

| Capa | Qué hay de verdad | Dónde |
|---|---|---|
| Web | Next.js 14 (App Router), TypeScript, NextAuth (no Better Auth) | `apps/web` |
| Worker | Node + Playwright, polling de jobs en Postgres (`FOR UPDATE SKIP LOCKED`), sin BullMQ ni pg-boss | `apps/worker/src/index.ts`, `jobs/scheduler.ts` |
| DB | Postgres (Supabase `ysqnrzqcklkywauzkylg`) vía Prisma; **sin RLS** — el aislamiento multi-tenant es 100 % código | `apps/web/prisma/schema.prisma` |
| Colas | Tabla `Job` + scheduler `setInterval` 60 s con cron por tenant (default `*/15`) | `apps/worker/src/jobs/scheduler.ts` |
| Hosting | Vercel (`web`, team `gurujk7s-projects`) + Render (worker) + Mac mini bridge (Claude CLI) | `labelflow-ops/runbook.md` |
| Pagos | MercadoPago Preference (pago único) + webhook HMAC fail-closed; suscripción legacy en wind-down | `apps/web/app/api/webhooks/mercadopago/route.ts` |
| Email | Resend (`lib/resend.ts` en los otros repos; en web, `lib/password-reset.ts` envía) | |
| Tests | Vitest en worker (2638) y en web (51, config nueva); `next build` como gate | |

**Otros dos sistemas, otra base:** `autoenvia-dash` y `autoboost` (`~/proyectos/`) viven en Supabase `zgptruicwqswtodgzfkp`, comparten `auth.users`, y tienen **ledgers propios** (`ae_*` coins en USD; `ab_*` credits en USD fraccionario). No hay FK ni transacción posible cruzando bases: hay que elegir un banco.

## 2. Módulos reutilizables (no reescribir)

| Módulo del prompt maestro | Ya existe como | Estado |
|---|---|---|
| `CarrierAdapter.createShipment` (DAC) | `apps/worker/src/dac/shipment.ts` (Playwright) | **Intocable** por CLAUDE.md. Se envuelve, no se toca. Punto exacto de "guía real": `markSubmitResolved` (`:4074`). |
| PDF de etiqueta | `apps/web/app/api/public/label-pdf`, `cliente/[token]/ClientPortal.tsx`, pdf-lib | Vivo en prod con multi-tienda, "Imprimir día", marcado automático. |
| Fulfillment Shopify | `apps/worker` (fulfillment orders API) | Vivo. |
| Conexión Shopify por token | `app/tutorial/shopify-token`, `api/v1/settings` | Vivo; queda como fallback plegado en Settings. |
| Conexión Shopify OAuth | `api/shopify/{install,callback,uninstalled,entry}`, `lib/shopify-oauth.ts` | **Nuevo 2026-09-01.** PR #2 mergeado; PR #3 (App Store) abierto. App pública creada: org LabelFlow SAS, id `417965080577`. |
| "Excel que simula Shopify" | `autoenvia-dash`: `api/excel/*` + `api/v1/orders` con token por cliente | Construido, **no activado** (faltan migraciones 0001–0003 y env de MP). Sin remote git. |
| AutoBoost | `autoboost`: catálogo de buythefollows.com ×5, ledger `ab_*`, checkout MP | Vivo en `autoboost.labelflowsas.com`. |
| Créditos LabelFlow | `Tenant.shipmentCredits` + `CreditPurchase` (packs 20/17/15/12/10/7 UYU) | Vivo, **pero es un contador, no un ledger**: `deductCreditsAndStamp(tenantId, N)` no sabe qué envíos cobra (F1/F2/F10). |
| Núcleo de facturación nuevo | `apps/worker/src/billing/{tiers,settle,funds}.ts` | **Nuevo, puro, sin llamadores.** 48 tests. Tarifa monótona, liquidación por diferencia, guard de fondos para bots. |

## 3. Esquema actual (lo que importa para extender)

`User` → `Tenant[]` (multi-tienda desde 2026-05; el **credit-holder** es el tenant más viejo) → `Job`, `Label`(`dacGuia @unique` global — 🔴 debería ser `@@unique([tenantId, dacGuia])`), `PendingShipment` (mutex anti doble guía), `ShippingRule` (5 tipos), `CreditPurchase`, `ReferralCreditAccrual`, `WebhookReceipt`, `PasswordResetToken`.

## 4. Plan de extensión (orden real, con lo ya hecho tachado mentalmente)

1. ~~OAuth Shopify + app pública~~ → hecho, falta `SHOPIFY_API_SECRET` y App URL → `/api/shopify/entry`.
2. **Ledger por envío en LabelFlow** (`Wallet`, `WalletEntry` con `idemKey = ship:v1:<tenantId>:<guia>`), colgado en `markSubmitResolved`. Mata F1/F2/F5/F10 y hace real "el reintento no descuenta". Migración aditiva; `Tenant.shipmentCredits` sobrevive como caché hasta el cutover.
3. Webhook MP → escribe `WalletEntry` en el **mismo deploy** que el cutover (si no, el cliente paga y queda trabado).
4. Signup público (hoy bloqueado por `ALLOW_PUBLIC_SIGNUP`) + trial 5 por tienda atado a `shopDomain`.
5. Unificar AutoBoost: consume del mismo wallet por API con `idemKey smm:<orderId>`, sólo contra `paidIn` (ver `funds.ts`).
6. Whop como segundo riel (USD / internacional), ver `docs/PAGOS.md`.
