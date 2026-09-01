# Wallet unificado — ledger por envío

**Estado (2026-09-01): fase 1, MODO SOMBRA. No cobra. Tenant.shipmentCredits sigue mandando.**

Núcleo puro (sin DB): `apps/worker/src/billing/{tiers,settle,funds}.ts`.
Capa de DB: `apps/worker/src/billing/ledger.ts` (+ `ledger-prisma.ts`, `shadow.ts`).
Schema: `Wallet` y `WalletEntry` en `apps/web/prisma/schema.prisma`; DDL en
`apps/web/prisma/migrations/20260901180000_wallet_ledger/migration.sql` (🔴 escrito, NO aplicado).

## Qué hace la sombra

1. Cada job que persiste una guía DAC real en `Label.dacGuia` llama a
   `shadowRecordShipment()` justo después del upsert exitoso. Sitios (salen de
   `rg "dacGuia:\s*(result\.guia|rescued\.guia|…)"`, no de memoria):
   `jobs/process-orders.job.ts`, `jobs/process-dashboard-orders.job.ts`,
   `jobs/agent-bulk-upload.job.ts`, `dac/orphan-reconcile.ts`.
   Excluidos a propósito: `self-delivery/process.ts` (guías `LF-`, no pasan por DAC) y
   `jobs/test-dac.job.ts` (guías `TEST-`). `dac/shipment.ts` no se toca.
2. El hook está detrás de `WALLET_SHADOW=1` (default apagado), va envuelto en try/catch
   y **nunca rompe el job**. Si el ledger falla, queda un `wallet-shadow:` en el log y listo.
3. `recordShipment` corre en UNA transacción con `SELECT … FOR UPDATE` sobre el wallet:
   - inserta `WalletEntry(reason='shipment', delta=0, idemKey='ship:v1:<tenantId>:<guia>')`;
     si ya existe → no-op (`alreadyRecorded`).
   - recuenta `n` = envíos − reintegros del **wallet** en `periodYm`, lee el neto y
     emite UN asiento `settlement` con `delta = -periodTotal(n) − neto`.
   - **En sombra `balanceMilli` no se toca** y los asientos llevan `shadow=true`.
4. `recordRefundForShipment` emite `refund` (idempotente, `refund:v1:<tenantId>:<guia>`)
   y re-liquida **el período del envío original**, no el de hoy.
5. Invariante, por construcción y auto-reparable:
   `sum(delta WHERE reason IN (shipment,settlement,refund)) == -periodTotal(n)` por
   (wallet, período). `assertWalletInvariant()` es para el reconciliador.

Decisiones tomadas en esta fase (revisables antes del cutover):
- **El wallet es por USER** (`Wallet.userId @unique`). El volumen mensual `n` se cuenta
  por wallet, no por tenant: las tiendas de un mismo user ya comparten saldo hoy vía
  credit-holder, así que también comparten el descuento por volumen. El `tenantId` viaja
  en cada asiento de envío para poder desglosar por tienda.
- `WalletEntry.tenantId/labelId/jobId` **sin FK**: el libro sobrevive a que se borre una
  etiqueta o un tenant.
- Los UNIQUE parciales `(tenantId, dacGuia) WHERE reason='shipment'|'refund'` viven sólo
  en el SQL (Prisma no los expresa). El `idemKey` ya garantiza lo mismo.

## Cómo leer la divergencia vs Tenant.shipmentCredits

La sombra sólo ve envíos posteriores a prender `WALLET_SHADOW=1`, así que toda comparación
se limita a ese rango. Dos preguntas, dos queries.

**A. ¿El ledger vio los mismos envíos que Label?** (detecta hooks que no corrieron)

```sql
-- Envíos reales por tenant y mes: Label vs ledger en sombra. Sólo filas que difieren.
WITH lbl AS (
  SELECT "tenantId",
         to_char("updatedAt" AT TIME ZONE 'America/Montevideo', 'YYYY-MM') AS ym,
         count(*) AS labels
  FROM "Label"
  WHERE "dacGuia" IS NOT NULL
    AND "dacGuia" NOT LIKE 'PENDING-%' AND "dacGuia" NOT LIKE 'TEST-%' AND "dacGuia" NOT LIKE 'LF-%'
    AND "updatedAt" >= :shadow_desde        -- momento en que se prendió WALLET_SHADOW
  GROUP BY 1, 2
), led AS (
  SELECT "tenantId", "periodYm" AS ym,
         count(*) FILTER (WHERE reason = 'shipment') - count(*) FILTER (WHERE reason = 'refund') AS billable
  FROM "WalletEntry"
  WHERE reason IN ('shipment', 'refund')
  GROUP BY 1, 2
)
SELECT coalesce(lbl."tenantId", led."tenantId") AS tenant,
       coalesce(lbl.ym, led.ym)                 AS ym,
       lbl.labels, led.billable
FROM lbl FULL JOIN led ON led."tenantId" = lbl."tenantId" AND led.ym = lbl.ym
WHERE lbl.labels IS DISTINCT FROM led.billable
ORDER BY 2 DESC, 1;
```
Ojo: `Label.updatedAt` es aproximación (la fila se toca también por PDF/email). Para
afinar, cruzar por guía: `SELECT l."dacGuia" FROM "Label" l LEFT JOIN "WalletEntry" e ON
e."tenantId" = l."tenantId" AND e."dacGuia" = l."dacGuia" AND e.reason='shipment' WHERE
e.id IS NULL AND l."dacGuia" NOT LIKE 'PENDING-%' AND l."updatedAt" >= :shadow_desde`.

**B. ¿Cuánto cobró el contador vs cuánto cobraría el wallet?** (por user, por mes)

```sql
-- Plata que el ledger dice que vale el mes vs créditos que descontó el contador.
-- El contador cobra en ENVÍOS (creditsConsumed), no en plata: para comparar hay que
-- multiplicar por el precio del pack que usó cada cliente, que no está en la base.
-- Por eso esta query devuelve las dos unidades lado a lado y la conversión se hace
-- a mano con el pack de cada uno (apps/web/lib/credit-packs.ts).
SELECT w."userId",
       e."periodYm",
       -sum(e."deltaMilli") / 1000.0                          AS ledger_uyu,
       count(*) FILTER (WHERE e.reason = 'shipment')          AS ledger_envios,
       count(*) FILTER (WHERE e.reason = 'refund')            AS ledger_reintegros,
       (SELECT sum(t."creditsConsumed") FROM "Tenant" t WHERE t."userId" = w."userId") AS contador_creditos_lifetime
FROM "WalletEntry" e
JOIN "Wallet" w ON w.id = e."walletId"
WHERE e.reason IN ('shipment', 'settlement', 'refund')
GROUP BY 1, 2
ORDER BY 2 DESC, 1;
```
`creditsConsumed` es lifetime y no se puede cortar por mes; la lectura útil es la
**variación** entre dos snapshots de la query (día 1 y día 30) contra `ledger_envios`.
Si el contador movió más créditos que envíos vio el ledger → doble cobro (catch + reconcile);
si movió menos → cobro cero (job cerrado antes de cobrar, guías recuperadas). Los dos
casos ya están verificados en el código; la sombra los cuantifica.

Chequeo de integridad del ledger (correr antes de mirar cualquier divergencia):
```sql
-- Períodos cuyo neto no cierra. Debe devolver 0 filas; si no, NO avanzar al cutover.
SELECT "walletId", "periodYm", sum("deltaMilli") AS neto,
       count(*) FILTER (WHERE reason='shipment') - count(*) FILTER (WHERE reason='refund') AS n
FROM "WalletEntry" WHERE reason IN ('shipment','settlement','refund')
GROUP BY 1, 2;
-- y comparar `neto` con -periodTotalMilli(n) (tiers.ts) desde el reconciliador,
-- o directo: assertWalletInvariant(client, walletId, periodYm).
```

## Orden de cutover (NO es parte de esta fase)

1. **Webhook de MercadoPago → `WalletEntry(reason='purchase')` en el MISMO deploy** que
   flipea el primer wallet a `authoritative=true`. Si el webhook sigue acreditando
   `shipmentCredits` después del cutover, cada compra posterior desaparece del wallet.
   Mismo deploy también para `refund`/`chargeback` (bajan `paidInMilli`, ver funds.ts).
2. **Cutover por USER, no por tenant**, con el despacho de TODOS sus tenants pausado:
   - saldo inicial = un asiento `grant`/`adjust` con el equivalente en plata del
     `shipmentCredits` + `referralBonusCredits` remanente (cómo valuarlo es decisión
     pendiente: precio del pack comprado vs precio de lista);
   - `Wallet.authoritative=true`, `cutoverAt=now()`;
   - reanudar despacho; el worker sigue llamando `deductCreditsAndStamp` hasta que se
     retire en un deploy posterior, cuando todos los users estén cortados.
3. Users chicos primero, **Aura último** (es el volumen; cualquier bug se ve ahí más caro).
4. Retirar `deductCreditsAndStamp` y los 7 call-sites recién cuando `Wallet.authoritative`
   sea true para todos y la query A dé 0 filas dos meses seguidos.
