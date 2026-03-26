# LabelFlow -- Shopify x DAC Uruguay

SaaS multi-tenant que automatiza la generacion de etiquetas de envio entre Shopify y DAC Uruguay.

## Arquitectura

```
                    +------------------+
                    |   autoenvia.com  |
                    |   (Vercel)       |
                    |   Next.js 14     |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
     +--------v---+  +------v------+  +----v--------+
     | Supabase   |  | Upstash     |  | Stripe      |
     | PostgreSQL |  | Redis       |  | Billing     |
     | + Storage  |  | BullMQ      |  | Webhooks    |
     +--------+---+  +------+------+  +-------------+
              |              |
              |     +--------v---------+
              +---->|   Worker         |
                    |   (Railway)      |
                    |   BullMQ consumer|
                    |   + Playwright   |
                    +--------+---------+
                             |
                    +--------v---------+
                    |   dac.com.uy     |
                    |   (Chromium      |
                    |    headless)     |
                    +------------------+
```

**Flujo:**
1. Shopify webhook o cron trigger -> Worker recibe job via BullMQ
2. Worker consulta Shopify API por pedidos pendientes
3. Worker abre Chromium headless, logea en DAC, crea envios
4. Descarga PDF etiqueta, sube a Supabase Storage
5. Marca pedido en Shopify con tag "labelflow-procesado"
6. Envia email al cliente con numero de guia

## Stack

| Componente | Tecnologia |
|-----------|-----------|
| Frontend + API | Next.js 14 (App Router, TypeScript) |
| UI | Tailwind CSS + shadcn/ui |
| Auth | NextAuth v5 (Credentials + Google) |
| Database | Supabase PostgreSQL + Prisma ORM |
| File storage | Supabase Storage |
| Queue | BullMQ + Upstash Redis |
| Browser automation | Playwright (Chromium headless) |
| Billing | Stripe (Checkout + Portal + Webhooks) |
| Email | Nodemailer (SMTP configurable) |
| MCP | @modelcontextprotocol/sdk (Streamable HTTP) |
| Deploy web | Vercel |
| Deploy worker | Railway (Docker) |

## Setup local (10 pasos)

```bash
# 1. Clonar
git clone <repo-url> labelflow && cd labelflow

# 2. Instalar dependencias
npm install -g pnpm
pnpm install

# 3. Copiar variables de entorno
cp .env.example .env
cp apps/web/.env.example apps/web/.env
cp apps/worker/.env.example apps/worker/.env

# 4. Configurar Supabase
# - Crear proyecto en supabase.com
# - Copiar DATABASE_URL, SUPABASE_URL, keys al .env

# 5. Generar ENCRYPTION_KEY y NEXTAUTH_SECRET
openssl rand -hex 32   # ENCRYPTION_KEY
openssl rand -base64 32  # NEXTAUTH_SECRET

# 6. Crear tablas
cd apps/web && npx prisma db push && cd ../..

# 7. Configurar Redis (Upstash)
# - Crear DB en upstash.com
# - Copiar REDIS_URL y UPSTASH_* al .env

# 8. Instalar Playwright browsers
cd apps/worker && npx playwright install chromium && cd ../..

# 9. Levantar en desarrollo
pnpm dev  # o desde cada app:
# Terminal 1: cd apps/web && npm run dev
# Terminal 2: cd apps/worker && npm run dev

# 10. Abrir http://localhost:3000
```

## Primer run con DRY_RUN

Setear `DRY_RUN=true` en `apps/worker/.env`. El worker:
- Conecta a Shopify y lista pedidos pendientes
- Loguea que haria con cada uno (tipo de pago, datos del cliente)
- NO abre browser, NO crea envios en DAC, NO modifica Shopify

## Actualizar selectores de DAC

```bash
cd apps/worker
npm run probe-dac
```

Esto abre Chrome visible, navega a dac.com.uy, toma screenshots de cada pantalla y loguea todos los inputs/selects con sus id/name. Los screenshots quedan en `./dac-screenshots/`. Actualiza `src/dac/selectors.ts` con los selectores reales.

## Deploy a produccion

### Vercel (web)
```bash
cd apps/web
npx vercel deploy --prod
```

### Railway (worker)
1. Crear proyecto en Railway
2. Conectar repo o subir Dockerfile de `apps/worker/`
3. Agregar variables de entorno
4. Deploy automatico

## Configurar Stripe

1. Crear 3 productos en Stripe Dashboard:
   - Starter: $15/mes, 100 etiquetas
   - Growth: $35/mes, 500 etiquetas
   - Pro: $69/mes, ilimitado

2. Copiar los Price IDs al `.env`:
   ```
   STRIPE_PRICE_STARTER=price_xxx
   STRIPE_PRICE_GROWTH=price_xxx
   STRIPE_PRICE_PRO=price_xxx
   ```

3. Configurar webhook en Stripe:
   - URL: `https://autoenvia.com/api/webhooks/stripe`
   - Eventos: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `customer.subscription.updated`

## Configurar Shopify webhook

En tu admin de Shopify:
1. Configuracion > Notificaciones > Webhooks
2. Crear webhook:
   - Evento: `Order payment`
   - URL: `https://autoenvia.com/api/webhooks/shopify`
   - Formato: JSON

## Guia MCP (Claude Desktop)

Agregar a tu `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "labelflow": {
      "url": "https://autoenvia.com/api/v1/mcp",
      "headers": {
        "Authorization": "Bearer TU_API_KEY"
      }
    }
  }
}
```

Tu API key esta en: Dashboard > Configuracion > API Key (MCP)

Tools disponibles:
- `process_pending_orders` - Procesar pedidos pendientes
- `get_daily_summary` - Resumen del dia
- `get_order_status` - Estado de un pedido
- `list_recent_labels` - Ultimas etiquetas

## Troubleshooting

| Error | Causa | Solucion |
|-------|-------|----------|
| Login DAC falla | Credenciales incorrectas | Verificar RUT y password en dac.com.uy |
| Selector no encontrado | DAC cambio su UI | Correr `npm run probe-dac` y actualizar selectores |
| Shopify 429 | Rate limit excedido | Bajar `MAX_ORDERS_PER_RUN` |
| Pedido sin direccion | Cliente no cargo direccion | Se salta automaticamente, nota en Shopify |
| PDF no descarga | Session expirada en DAC | El worker re-loginea automaticamente |
| Email no envia | Credenciales SMTP incorrectas | Verificar app password de Gmail |
| Job stuck RUNNING | Worker crasheo | Reiniciar worker, el job se reintenta |
| Stripe webhook falla | Secret incorrecto | Verificar `STRIPE_WEBHOOK_SECRET` |
| DB connection refused | Supabase sin pooler | Usar connection string con pooler |
| Build falla | Types incorrectos | Correr `npx prisma generate` antes de build |
