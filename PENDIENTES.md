# Pendientes — datos que faltan y dónde conseguirlos

Cada `[[COMPLETAR]]` del prompt maestro que quedó vacío, con lo que **sí** se
pudo verificar y lo que sigue faltando. Nada de esto se inventó.

| Ítem | Estado | Dónde se consigue |
|---|---|---|
| `SHOPIFY_API_SECRET` en Vercel | **FALTA** — sin esto OAuth y webhooks están apagados (fail-closed) | Dev Dashboard → app `417965080577` → Configuración → Credenciales → ojo. `npx vercel env add SHOPIFY_API_SECRET production --scope gurujk7s-projects`. Sólo Adrian. |
| App URL de Shopify → `/api/shopify/entry` | **FALTA** — hacerlo **después** del deploy de PR #3 | Dev Dashboard → Versiones → Crear versión → URL de la app |
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
