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
