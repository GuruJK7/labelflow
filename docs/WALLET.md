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

6. **Ventana at-most-once y su reparador.** El worker persiste `Label.dacGuia`
   (transacción 1) y recién después llama al hook (transacción 2). Un SIGTERM, deploy
   de Render o timeout entre las dos deja una guía real sin asiento, y nadie vuelve a
   llamar al hook porque el ciclo siguiente salta la orden (ya tiene guía).
   `repairUnrecordedShipments(client, { limit, tenantId?, since? })` en `ledger.ts`
   busca Labels con guía real (`isBillableGuia`) sin `WalletEntry(reason='shipment')`
   para `(tenantId, dacGuia)` y las asienta con `at = Label.createdAt`. Es idempotente
   (correrla dos veces no duplica) y **no está en ningún cron**: es el paso 0 del
   cutover (abajo) y se corre a mano. Sin `since` recorre toda la tabla Label paginada
   por `(createdAt, id)`; si algún día se programa, va con `since` acotado (48 h).
7. **`at` = momento del hecho.** Los 4 hooks pasan `at: label.createdAt`, así el
   período contable no depende de cuándo corrió el hook: una guía emitida el 30/09 a
   las 23:50 UY y recuperada por orphan-reconcile el 01/10 a las 00:20 cae en
   septiembre, y el backlog que repare el paso 0 se apila en el mes en que existió.
8. **Los fallos del hook son nivel `error`**, con `code` de Prisma cuando lo hay
   (`P2021` dice explícitamente "migración wallet_ledger no aplicada"). Sólo `P2002`
   queda en `warn`. Toda línea conserva el prefijo `wallet-shadow: no se pudo asentar`,
   que es lo que grepea el chequeo de humo. **Cada una de esas líneas es un envío que la
   sombra NO vio**: contarlas y restarlas antes de interpretar la divergencia.
9. La transacción del ledger corre con `{ maxWait: 5000, timeout: 15000 }` explícitos
   (`ledger-prisma.ts`). JK opera todas las tiendas desde un user → un solo wallet →
   con `WORKER_CONCURRENCY=2` dos jobs hacen cola en el `FOR UPDATE`; con el default
   de Prisma (2 s / 5 s) un pico de latencia Render↔DB vencía la transacción y el
   asiento se perdía en silencio.

Decisiones tomadas en esta fase (revisables antes del cutover):
- **El wallet es por USER** (`Wallet.userId @unique`). El volumen mensual `n` se cuenta
  por wallet, no por tenant: las tiendas de un mismo user ya comparten saldo hoy vía
  credit-holder, así que también comparten el descuento por volumen. El `tenantId` viaja
  en cada asiento de envío para poder desglosar por tienda.
- `WalletEntry.tenantId/labelId/jobId` **sin FK**: el libro sobrevive a que se borre una
  etiqueta o un tenant.
- Los UNIQUE parciales `(tenantId, dacGuia) WHERE reason='shipment'|'refund'` viven sólo
  en el SQL (Prisma no los expresa). El `idemKey` ya garantiza lo mismo.
- **D15 (docs/DECISIONES.md de esta rama): el cutover se hace sólo el día 1 del mes UY.**

## Cómo prender la sombra — orden ESTRICTO

Si se prende `WALLET_SHADOW=1` antes de aplicar el SQL no rompe nada, pero cada guía
deja un `error` `P2021` y el ledger queda vacío en silencio. El orden es:

1. **Aplicar el SQL** (`migration.sql`, idempotente) sobre `DIRECT_URL` con dry-run
   previo, en su propio turno (D9). Después chequear que el flujo `npm run db:push`
   no lo pisa: `prisma migrate diff --from-url $DIRECT_URL --to-schema-datamodel
   apps/web/prisma/schema.prisma --script` debe salir vacío (verificado en local con
   Prisma 5.22: `db push` no borra los índices parciales ni el CHECK).
2. **`npm run db:generate` + deploy** de web y worker con esta rama (el cliente Prisma
   del worker tiene que conocer `wallet`/`walletEntry`; con el cliente viejo el hook
   cae en un TypeError atrapado y también queda mudo).
3. **Recién ahí `WALLET_SHADOW=1`, en UN tenant chico** (no Aura). En Render el env var
   es por servicio, así que "un tenant" significa: prenderlo y mirar sólo ese tenant el
   primer día; el resto también asienta, pero el humo se lee en el chico.
4. **Chequeo de humo del primer día** (las dos cosas, no una):
   ```sql
   SELECT count(*) FROM "WalletEntry" WHERE reason = 'shipment';   -- tiene que ser > 0
   ```
   y en los logs del worker del día **cero** líneas con `wallet-shadow: no se pudo asentar`.
   Si aparece `P2021` → falta el paso 1. Si aparece `P2028` o `prepared statement` →
   ver la nota de pgbouncer abajo. Cualquier otro código → leer el `err` antes de seguir.
5. Nota **pgbouncer**: `DATABASE_URL` de prod va por el pooler de Supabase (puerto 6543,
   `?pgbouncer=true`). Con ese flag Prisma fija la conexión durante la transacción
   interactiva, así que el `FOR UPDATE` y las lecturas siguientes van por la misma
   conexión de servidor. De memoria eso está soportado en Prisma 5 — **no se verificó
   contra Supavisor**; se verifica en el primer tenant con el chequeo de humo (si el
   lock no viajara con la transacción, la sombra registraría menos que Label y el
   síntoma serían líneas `no se pudo asentar` o divergencia en la query A).

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
Lo que devuelva esa query es exactamente lo que `repairUnrecordedShipments` repara.

**A'. Divergencia ESPERADA: guía real sin PDF.** El contador (`deductCreditsAndStamp`)
cobra sólo si el PDF subió (`pdfUploaded` → `successCount++`); la sombra asienta apenas
existe la guía (hecho facturable = guía persistida, decisión D). Una guía cuyo
`downloadLabel`/`uploadLabelPdf` falló dos veces aparece como "la sombra cobró de más"
cuando es diferencia de definición. Separar ese balde antes de leer B:

```sql
-- Guías reales que la sombra asentó y el contador NO descontó (sin PDF).
-- Son asientos CORRECTOS por definición; no cuentan como divergencia.
SELECT l."tenantId", l."dacGuia", l."createdAt", e."periodYm"
FROM "Label" l
JOIN "WalletEntry" e
  ON e."tenantId" = l."tenantId" AND e."dacGuia" = l."dacGuia" AND e.reason = 'shipment'
WHERE l."dacGuia" NOT LIKE 'PENDING-%' AND l."dacGuia" NOT LIKE 'TEST-%' AND l."dacGuia" NOT LIKE 'LF-%'
  AND l."pdfPath" IS NULL
  AND l."updatedAt" >= :shadow_desde
ORDER BY l."createdAt";
```
Si más adelante el PDF se recupera (reconcile lo reintenta), la fila sale sola de este
balde y el contador la cobra: la diferencia es temporal, no estructural.

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

## Test contra Postgres real (opt-in)

El fake en memoria serializa todas las transacciones con un mutex y su `$queryRaw` es
un no-op: el test de 1000 operaciones no puede fallar por un bug de locking. Dos redes:

- `billing-ledger.test.ts › contrato de lock` espía cada `$transaction` y afirma que la
  **primera** sentencia es `SELECT "id" FROM "Wallet" WHERE "id" = $1 FOR UPDATE` sobre el
  wallet correcto. Corre siempre.
- `billing-ledger.pg.test.ts` corre los escenarios A–I (dos `PrismaClient` = dos
  workers, crash intra-transacción, índice parcial real, 120 concurrentes, reparador)
  contra un Postgres de verdad. **Se salta si no está `LEDGER_PG_URL`.** Trunca tablas,
  así que sólo acepta hosts locales (`LEDGER_PG_ALLOW_REMOTE=1` para otro host; nunca
  prod). Cómo armar la base y correrlo está en el encabezado del archivo.

## Orden de cutover (NO es parte de esta fase)

0. **Reparar la ventana at-most-once ANTES de flipear nada** — y repetirlo el mismo
   día del cutover, después de pausar el despacho del user:
   ```ts
   // desde apps/worker (ts-node), con DATABASE_URL del worker:
   import { db } from './src/db';
   import { prismaLedgerClient } from './src/billing/ledger-prisma';
   import { repairUnrecordedShipments } from './src/billing/ledger';
   const r = await repairUnrecordedShipments(prismaLedgerClient(db), { limit: 1000 });
   console.log(r); // repaired > 0 la primera vez; 0 en la segunda corrida = listo
   ```
   Correrla hasta que `repaired = 0` y `exhausted = true`. Después la query A tiene que
   dar 0 filas para el rango de la sombra. Si no da 0, hay un write-site de
   `Label.dacGuia` sin hook: buscarlo, no flipear.
1. **Sólo el día 1 del mes UY** (D15). El período del cutover arranca en `n = 0`; un
   cutover a mitad de mes cobra sólo el costo marginal de un mes ya pagado en créditos.
2. **Webhook de MercadoPago → `WalletEntry(reason='purchase')` en el MISMO deploy** que
   flipea el primer wallet a `authoritative=true`. Si el webhook sigue acreditando
   `shipmentCredits` después del cutover, cada compra posterior desaparece del wallet.
   Mismo deploy también para `refund`/`chargeback` (bajan `paidInMilli`, ver funds.ts).
3. **Cutover por USER, no por tenant**, con el despacho de TODOS sus tenants pausado:
   - saldo inicial = un asiento `grant`/`adjust` con el equivalente en plata del
     `shipmentCredits` + `referralBonusCredits` remanente (cómo valuarlo es decisión
     pendiente: precio del pack comprado vs precio de lista);
   - `Wallet.authoritative=true`, `cutoverAt=now()`;
   - reanudar despacho; el worker sigue llamando `deductCreditsAndStamp` hasta que se
     retire en un deploy posterior, cuando todos los users estén cortados.
4. Users chicos primero, **Aura último** (es el volumen; cualquier bug se ve ahí más caro).
5. Retirar `deductCreditsAndStamp` y los 7 call-sites recién cuando `Wallet.authoritative`
   sea true para todos y la query A dé 0 filas dos meses seguidos.
