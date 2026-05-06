# Runbook: recovery de pedidos stuck por silent-reject de DAC (2026-05-06)

## Contexto

Antes del fix `5b3ae83`, cuando DAC redirigía a `/envios/nuevo` después
de Finalizar pero NO mostraba error, el worker:

1. Intentaba el "rescue" (buscar la guía en historial por nombre)
2. Si no la encontraba → eliminaba `PendingShipment` y marcaba la orden FAILED
3. **Próximo cron tick** → la orden se reintentaba → otra guía huérfana en DAC

Resultado: hasta hoy, varios clientes pueden tener **guías huérfanas en
DAC** que LabelFlow desconoce. DAC cobra por cada una.

El fix nuevo bloquea el reintento automático cuando rescue falla, pero
**no puede borrar las guías ya creadas** — eso es manual.

---

## Pedidos a verificar manualmente

```sql
-- Stuck orders that may have orphan guías in DAC. Run this query to refresh:
WITH rescue_failures AS (
  SELECT rl."jobId", rl."tenantId", rl."createdAt",
         rl.meta->>'orderName' AS order_name,
         rl.meta->>'recipientName' AS recipient
  FROM "RunLog" rl
  WHERE rl."createdAt" > NOW() - INTERVAL '14 days'
    AND rl.message ILIKE '%no historial row matched%true rejection%'
)
SELECT DISTINCT ON (rf.order_name)
  rf."createdAt"::timestamp(0) AS time,
  rf.order_name,
  rf.recipient,
  l.city, l."deliveryAddress", l.department,
  l.status, l."dacGuia"
FROM rescue_failures rf
LEFT JOIN "Label" l ON l."shopifyOrderName" = rf.order_name
  AND l."tenantId" = rf."tenantId"
WHERE l.status = 'NEEDS_REVIEW' AND l."dacGuia" IS NULL
ORDER BY rf.order_name, rf."createdAt" DESC;
```

### Lista actual (verificación manual requerida)

| Order | Cliente | Ciudad | Dirección |
|---|---|---|---|
| #11713 | Andreína Colmenares | Carrasco Norte | Av. Bolivia 2338, apto 102 |
| #11724 | Marcela Pascal | La Paloma | La Paloma (Rocha) |
| #11733 | Silvia Aranda | Dolores-Soriano | Asencio 1666 |
| #11746 | CLAUDIA GARCIA MENENDEZ | Pocitos | Av. Rivera 2966 esq. Rafael Pastoriza, apto 501 |
| #11748 | naza fernandez | San José | Antonio Costa 486 |

---

## Procedimiento por cada pedido

### Paso 1 — Verificar en DAC si existe guía huérfana

1. Entrar a `https://www.dac.com.uy/envios` (historial)
2. Buscar por nombre del cliente
3. **Importante**: revisá el historial de hoy y de los últimos 3 días
   — la guía huérfana puede estar en cualquier punto

### Paso 2A — La guía SÍ existe en DAC

Vinculala manualmente con SQL:

```sql
-- Replace <ORDER_NAME>, <DAC_GUIA>, <TENANT_ID>
BEGIN;

-- Verify the order exists and has no guía yet
SELECT id, status, "dacGuia"
FROM "Label"
WHERE "shopifyOrderName" = '<ORDER_NAME>' AND "tenantId" = '<TENANT_ID>';

-- Verify the guía isn't already attached to another order
SELECT id, "shopifyOrderName"
FROM "Label"
WHERE "dacGuia" = '<DAC_GUIA>';
-- Expected: 0 rows

-- Link the guía + mark COMPLETED + clear PendingShipment
UPDATE "Label"
SET
  "dacGuia"     = '<DAC_GUIA>',
  status        = 'COMPLETED',
  "errorMessage" = NULL,
  "updatedAt"   = NOW()
WHERE "shopifyOrderName" = '<ORDER_NAME>' AND "tenantId" = '<TENANT_ID>';

DELETE FROM "PendingShipment"
WHERE "shopifyOrderId" = (
  SELECT "shopifyOrderId" FROM "Label"
  WHERE "shopifyOrderName" = '<ORDER_NAME>' AND "tenantId" = '<TENANT_ID>'
)
AND "tenantId" = '<TENANT_ID>'
AND status = 'PENDING';

COMMIT;
```

Después: el worker descargará el PDF en el próximo cron tick y mandará
el email al cliente.

### Paso 2B — La guía NO existe en DAC (DAC sí rechazó)

1. Verificar la dirección con el cliente (Shopify → Pedido → Cliente)
2. Si la dirección está bien → es bug de DAC, contactar soporte DAC
3. Si la dirección está mal → corregirla en Shopify
4. Desbloquear con SQL:

```sql
-- Replace <ORDER_NAME>, <TENANT_ID>
BEGIN;

DELETE FROM "PendingShipment"
WHERE "shopifyOrderId" = (
  SELECT "shopifyOrderId" FROM "Label"
  WHERE "shopifyOrderName" = '<ORDER_NAME>' AND "tenantId" = '<TENANT_ID>'
)
AND "tenantId" = '<TENANT_ID>'
AND status = 'PENDING';

-- Reset Label so cron picks it up
UPDATE "Label"
SET status = 'PENDING', "errorMessage" = NULL, "updatedAt" = NOW()
WHERE "shopifyOrderName" = '<ORDER_NAME>' AND "tenantId" = '<TENANT_ID>';

COMMIT;
```

Próximo cron tick reintenta. Con el fix nuevo, si DAC rechaza otra vez,
queda parked SIN reintentar (no se duplica la guía huérfana).

---

## Después del fix `5b3ae83`

A partir de este deploy:
- Si DAC silently-rechaza Y rescue falla → la orden queda **parked**
  (no se reintenta automáticamente)
- El note de Shopify dice EXPLÍCITAMENTE "posible guía huérfana,
  verificar historial DAC primero"
- Operador sigue este mismo runbook para resolverla

---

## Auditoría posterior (recomendado)

Después de procesar los 5 stuck orders, correr esta query semanal:

```sql
-- Find any new "possible orphan guía" cases in the last 7 days
SELECT
  l."shopifyOrderName",
  l."customerName",
  l.city, l.department,
  l.status, l."errorMessage",
  l."createdAt"
FROM "Label" l
WHERE l.status = 'NEEDS_REVIEW'
  AND l."errorMessage" ILIKE '%posible guía huérfana%'
  AND l."createdAt" > NOW() - INTERVAL '7 days'
ORDER BY l."createdAt" DESC;
```

Si la lista crece, hay un patrón recurrente que vale la pena
investigar (DAC bug, dirección común, etc.).
