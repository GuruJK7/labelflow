# Pendientes — datos que faltan y dónde conseguirlos

Cada `[[COMPLETAR]]` del prompt maestro que quedó vacío, con lo que **sí** se
pudo verificar y lo que sigue faltando. Nada de esto se inventó.

| Ítem | Estado | Dónde se consigue |
|---|---|---|
| `SHOPIFY_API_SECRET` en Vercel | **FALTA** — sin esto OAuth y webhooks están apagados (fail-closed) | Dev Dashboard → app `417965080577` → Configuración → Credenciales → ojo. `npx vercel env add SHOPIFY_API_SECRET production --scope gurujk7s-projects`. Sólo Adrian. |
| App URL de Shopify → `/api/shopify/entry` | **FALTA** — hacerlo **después** del deploy de PR #3 | Dev Dashboard → Versiones → Crear versión → URL de la app |
| Aceptación de términos en el primer login (tenants aprovisionados desde el App Store) | **FALTA** — `provisionFromShopify` y `/api/shopify/claim` dejan `tosAcceptedAt = null` a propósito (D14): el comerciante autorizó la app en Shopify, no aceptó nuestros términos. Hoy ningún gate lo exige (verificado por grep), así que entra igual. Hace falta un interstitial en el primer login (o en la página de set-password) que lo pida y setee `tosAcceptedAt` + `signupIp`. | Código: gate en `(dashboard)/layout` o en `/reset-password/[token]`; decisión de copy legal de Adrian |
| Revocar tokens de Shopify emitidos y descartados | **PARCIAL** — la rama dashboard ya no canjea el `code` si va a fallar (D13); la rama App Store canjea antes de saber de quién es la tienda, y en `conflict`/`shop_info_failed` el token queda emitido sin guardar. Shopify no expone revocación por API sin el token del comerciante; queda como está y se documenta. | — |
| Migración de clientes con token manual (custom app) al OAuth público | **PENDIENTE — a mano, por cliente** — `/api/shopify/entry` cortocircuita el OAuth si el tenant ya tiene `shopifyToken`, sin distinguir si ese token vino por OAuth o pegado a mano desde una custom app (D16: no hay flag de origen sin migración). Para esos clientes, apretar "Instalar" en el App Store NO registra la instalación pública en Shopify: cae en `/login?shopify=open`. Camino: el cliente entra a Settings → **Reconectar**, que sí pasa por OAuth y deja el token público. Cuando todos los tenants vivos estén reconectados, el cortocircuito puede quedarse tal cual. | Lista de tenants con token manual: `select slug from "Tenant" where "shopifyToken" is not null` cruzada con quién pasó por `/callback` (no hay columna: se sabe por el soporte). Adrian decide si se avisa por WhatsApp uno por uno. |
| Migración `20260901180000_tenant_shop_domain_lower` (dominios en minúsculas + índice único parcial sobre `Tenant.shopifyStoreUrl`) | **ESCRITA, 🔴 SIN APLICAR** (D9/D18) — `apps/web/prisma/migrations/20260901180000_tenant_shop_domain_lower/migration.sql`. El repo no usa `prisma migrate` (la carpeta no existía): se corre a mano sobre `DIRECT_URL` en otro turno. **Antes** correr el `SELECT … GROUP BY lower("shopifyStoreUrl") HAVING count(*) > 1` que está en el encabezado del archivo: si devuelve filas, el índice falla y hay que decidir qué tenant se queda con la tienda. El código ya compara insensible a mayúsculas, así que el UPDATE no cambia comportamiento; el índice sí cierra la carrera reclamo-vs-Conectar del dashboard. | Sólo Adrian, con el SELECT de duplicados en mano |
| Contacto de emergencia (App Store) | **FALTA** — mail + teléfono | Partners → Revisión App Store |
| Acceso a datos protegidos de clientes | **FALTA** — apretar *Solicitar*, **no** marcar "no usa datos" (usa nombre, dirección, teléfono) | Partners → Revisión App Store |
| Capturas 1600×900 (3–6), video o imagen 1600×900, tienda demo | **FALTA** — necesita la app funcionando con una dev store | Se hacen después de conectar una tienda de desarrollo |
| ¿Shopify le paga a una entidad uruguaya? | **NO DETERMINADO** — decide si se puede cobrar con Shopify Billing (0 % hasta USD 1M) | Partners → Pagos → Configurar método de pago (ver qué rieles ofrece a UY) |
| Costo real por guía DAC | **NO DOCUMENTADO en ningún repo** — cada cliente usa su propia cuenta DAC; el flete no pasa por LabelFlow | Contrato/cuenta DAC del cliente |
| Costo mensual real Render/Supabase(x2)/Vercel | **NO DOCUMENTADO** | Facturas de cada servicio |
| Tipo de cambio UYU/USD | Hardcodeado `44` en dos repos; no verificado | Decisión de Adrian; mover a `FxRate` editable |
| Migraciones `0001–0003` de autoenvia-dash aplicadas en Supabase `zgptruicwqswtodgzfkp` | **NO VERIFICADO** (sin acceso a esa base) | `select indexname from pg_indexes where indexname in ('ae_coin_ledger_mp_payment_uk','ae_coin_ledger_spend_order_uk','ab_tx_mp_uniq')` |
| Misma cuenta de MercadoPago en LabelFlow / AE / AB | **NO DETERMINADO** — decide si los payment ids pueden colisionar | `GET https://api.mercadopago.com/users/me` con cada token (no pasar tokens) |
| Login de DAC: ¿cédula, mail o usuario? | **NO DETERMINADO** — `DAC_INTEGRATION_PLAN.md` lo marca bloqueante | Sólo Adrian |
| Formato/prefijo de guía DAC (¿identifica la cuenta?) | **NO DETERMINADO** — decide si `Label.dacGuia @unique` global es bug (F11) | Ver una guía de otra tienda que no sea Aura (las de Aura arrancan en `88214`) |
| Pasarela COD en Shopify (nombre) | **NO DETERMINADO** | Admin de Shopify de un cliente |
| Peso/dimensiones por defecto DAC | **NO DETERMINADO** | Módulo DAC / Adrian |
| Link del Excel actual | `autoenvia-dash/api/excel/template` genera la plantilla; no hay link público | Activar el módulo |
| Whop: negocio/company creada | **NO** — la cuenta es sólo personal (sidebar "Personal", saldo $0,00) | whop.com → "+" → crear company |
| Whop: pago `pay_om9KjtKtvUhBiU` | La URL es el retorno post-checkout; el detalle no aparece en la página pública | Whop → Settings → Purchases |
| Repos `autoenvia-dash` y `autoboost` sin remote git | Respaldados en `~/proyectos/_backups/` (tar.gz) | Crear repos privados en GitHub (Adrian) |
