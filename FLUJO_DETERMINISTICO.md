# LabelFlow — Estrategias de Análisis Determinístico (Informe Completo)

> Documento generado 2026-04-21. Mapa completo del pipeline de clasificación y resolución de direcciones, desde recepción del webhook de Shopify hasta generación de la guía DAC.

---

## Índice

1. [Clasificación inicial de órdenes (GREEN/YELLOW/RED)](#1-clasificación-inicial-de-órdenes-green--yellow--red)
2. [Normalización y parsing de direcciones](#2-normalización-y-parsing-de-direcciones)
3. [Diccionarios y datos geográficos de Uruguay](#3-diccionarios-y-datos-geográficos-de-uruguay)
4. [Resolver determinístico de departamento](#4-resolver-determinístico-de-departamento)
5. [Resolver determinístico de barrio MVD](#5-resolver-determinístico-de-barrio-mvd)
6. [Resolver determinístico de ciudad](#6-resolver-determinístico-de-ciudad)
7. [Orden total de checks pre-IA](#7-orden-total-de-checks-pre-ia)
8. [YELLOW dispatcher — 3 estrategias de fallback](#8-yellow-dispatcher--3-estrategias-de-fallback)
9. [Flujo completo Webhook → Guía](#9-flujo-completo-webhook--guía)
10. [Sistema de confidence scoring](#10-sistema-de-confidence-scoring)
11. [Topología bridge desplegada](#11-topología-bridge-desplegada)
12. [Tabla resumen de ejecución determinística](#12-tabla-resumen-de-ejecución-determinística)
13. [Referencia rápida de archivos y líneas](#13-referencia-rápida-de-archivos-y-líneas)

---

## 1. Clasificación inicial de órdenes (GREEN / YELLOW / RED)

**Archivo:** `apps/worker/src/rules/order-classifier.ts` — función `classifyOrder()` (líneas 60-150)

Función pura y síncrona que corre **antes** de cualquier procesamiento. Decide el "zone" de la orden.

### RED (imposible de enviar) — líneas 68-96
Retorna inmediatamente con razones:
- `NO_SHIPPING_ADDRESS` — falta shipping_address
- `NO_ADDRESS1` — address1 ausente o < 3 caracteres
- `NO_CITY` — ciudad ausente
- `NON_UY_COUNTRY` — país distinto de UY

### YELLOW (enviable pero ambiguo) — líneas 99-140
Se detectan estas señales de ambigüedad:
- `UNKNOWN_CITY` — la ciudad no resuelve en `getDepartmentForCity()`
- `WEIRD_PHONE` — el teléfono no pasa `looksLikeUyPhone()` (7-13 dígitos limpios)
- `APT_IN_ADDRESS1` — address1 contiene marcadores de apto (`apto`, `apt.`, `piso`, `p.`, `apartamento`, `blq`, `casa`, `bis`, `ter`, `torre`) — lista en líneas 34-40
- `ADDRESS2_PRESENT` — address2 existe pero no es un marcador típico de apto
- `DEPT_MISMATCH` — el departamento derivado de la ciudad no coincide con el campo `province`

### GREEN (determinístico) — líneas 142-150
Todos los campos presentes, ciudad resuelve, teléfono válido, sin confusión de apto → `createShipment()` directo, sin IA.

### Funciones clave de detección
- **`looksLikeUyPhone()`** (49-55): quita no-dígitos, valida rango 7-13 dígitos. Cubre +598 internacional (11-12 dígitos) + 8-9 local.
- **`hasAptMarker()`** (44-47): check word-boundary case-insensitive contra 13 variaciones de marcadores de apto.
- **`getDepartmentForCity()`** (103): mapea ciudad → departamento desde `uruguay-geo.ts`.

---

## 2. Normalización y parsing de direcciones

**Archivo:** `apps/worker/src/dac/shipment.ts` — `mergeAddress()` líneas 294-499

Proceso en 3 fases sobre address1 + address2:

### Fase 1 — Extracción de patrón slash (líneas 509-525)
Detecta formato `puerta/apto`:
- Input: `"Luis a de Herrera 1183/204"`
- Regex: `/(\d+)\/(\d+)/`
- Output: address1=`"Luis a de Herrera 1183"`, extraObs contiene `"Apto 204"`

### Fase 2 — Procesamiento de address2 (líneas 540-598)
- **`isAddress2DuplicateOfDoor()`** (374-382): detecta si address2 es solo el número de puerta duplicado
- **`isLikelyAptNumber()`** (405-414): heurística de apartamento
  - Cero a la izquierda (`"002"`) = siempre apto
  - 1-2 dígitos = apto
  - 3+ dígitos sin cero = ambiguo
- Si es apto → se mueve a `extraObs`; sino → se agrega a address1 como número de puerta faltante

### Fase 3 — Post-procesamiento (líneas 436-473)
- **`stripTrailingAptPattern()`** (295-304): regex `/[\s,]+(?:apto|apt|apartamento|dpto|depto|dep|ap)\.?\s+(\S+)\s*$/i` — extrae apto embebido al final de address1
- **`stripTrailingPorteriaPattern()`** (313-320): `/[\s,]+porter[ií]a\s+(\S+)\s*$/i` — códigos de portería
- **`stripTrailingKnownPlaces()`** (349-364): iteración hasta 5 veces, quita segmentos separados por coma contra el set `KNOWN_PLACES` (53 entradas: barrios, ciudades, departamentos)

### Output estructurado
```typescript
{
  fullAddress: "Calle X 1234",           // calle + puerta
  extraObs: "Apto 204 | Porteria 3"     // apto, portería, referencias
}
```

---

## 3. Diccionarios y datos geográficos de Uruguay

| Archivo | Contenido | Uso |
|---|---|---|
| `apps/worker/src/dac/uruguay-geo.ts` | `CITY_TO_DEPARTMENT` — 530+ ciudades → 19 departamentos | Validación rápida y clasificación YELLOW/GREEN |
| `apps/worker/src/dac/dac-geo-map.json` | 700 ciudades DAC, 141 IDs de oficina, 89 barrios MVD | Validación contra dropdowns DAC |
| `apps/worker/src/dac/dac-dept-resolver.ts` | Prefijos ZIP, capitales, ciudades mayores | Resolución determinística de depto |
| `apps/worker/src/dac/duplicate-city-tiebreaker.ts` | 34 nombres duplicados con ranking por población | Desempate "La Paz", "Toledo", etc. |
| `apps/worker/src/dac/mvd-street-ranges.ts` | 20+ avenidas MVD con rangos → barrio | Saltarse IA en Montevideo |

### 3.1 Tabla ZIP → Departamento (dac-dept-resolver.ts, líneas 89-111)

19 prefijos de 2 dígitos, todos confirmados o oficiales:

```typescript
'11': 'Montevideo',      // CONFIRMADO
'15': 'Canelones',       // CONFIRMADO — costa este
'20': 'Maldonado',       // CONFIRMADO — Punta del Este
'27': 'Rocha',           // CONFIRMADO
'30': 'Lavalleja',       // OFICIAL
'33': 'Treinta y Tres',  // CONFIRMADO
'37': 'Cerro Largo',     // CONFIRMADO — Melo
'94': 'Florida',         // CONFIRMADO
'97': 'Durazno',         // OFICIAL
// ... 10 entradas más
```

### 3.2 Tabla de desempate (duplicate-city-tiebreaker.ts, líneas 43-79)

34 nombres de ciudades que aparecen en 2+ departamentos, rankeadas por población (INE 2011) + volumen de envíos:

```typescript
'la paz':        ['Canelones', 'Colonia'],      // Canelones ~20k >> Colonia ~500
'las piedras':   ['Canelones', 'Artigas'],      // Canelones ~70k >> Artigas ~1k
'toledo':        ['Canelones', 'Cerro Largo'],  // Canelones ~17k >> CL ~1k
'bella vista':   ['Paysandu', 'Maldonado'],
'castillos':     ['Rocha', 'Soriano'],
// ... 29 entradas más
```

### 3.3 Rangos de calles MVD (mvd-street-ranges.ts, líneas 73-200+)

Diseño conservador: solo avenidas de alto volumen con rangos verificados a mano.

```typescript
'brasil': [  // Av. Brasil (corredor Pocitos)
  { from: 1,    to: 499,  barrio: 'parque rodo' },
  { from: 500,  to: 3999, barrio: 'pocitos', note: 'A01: Av. Brasil 2500' },
],
'18 de julio': [  // Avenida principal MVP
  { from: 1,    to: 999,  barrio: 'centro' },
  { from: 1000, to: 2199, barrio: 'cordon' },
  { from: 2200, to: 3499, barrio: 'tres cruces' },
],
```

### 3.4 DAC Geo-Map JSON (dac-geo-map.json)

Pre-extraído de la UI de DAC:
- 700+ ciudades en 19 departamentos
- 141 IDs de oficina (`Oficina_destino`) para bulk XLSX
- 89 opciones de barrio MVD (dropdown `K_Barrio`)
- Estructura: `{ departments: { "10": { name: "Montevideo", cities: [...] } } }`

---

## 4. Resolver determinístico de departamento

**Archivo:** `apps/worker/src/dac/dac-dept-resolver.ts` — `resolveDepartmentDeterministic()` (líneas 353-479)

Aplica reglas **en orden**, cortando en la primera con confianza HIGH:

| # | Regla | Confianza | Detalle |
|---|---|---|---|
| 1 | **Prefijo ZIP** (357-377) | HIGH | Extrae primeros 2 dígitos → lookup. Saltea si el address contradice (ej. ZIP MVD pero address2 dice "Tacuarembó") |
| 2 | **Capitales departamentales** (380-388) | HIGH | Escanea address1/address2/orderNotes. Filtra `CAPITALS_COMMON_AS_STREETS` (223-241) al escanear address1 (artigas, rivera, florida, durazno → son calles comunes) |
| 3 | **Ciudades mayores no capitales** (391-399) | HIGH | 50+ entradas: Punta del Este, Young, Juan Lacaze, Carmelo, Nueva Palmira |
| 4 | **Tiebreaker ambiguo** (401-433) | MEDIUM | city="Montevideo" + address2="La Paz" → Canelones vía `preferredDeptFor()` |
| 5 | **Match exacto de ciudad** (435-459) | HIGH | Si la ciudad normalizada mapea a exactamente UN depto en DAC |
| 6 | **Campo province** (461-475) | MEDIUM | Último recurso — match directo contra nombres de depto DAC |

### Retorno
```typescript
{
  department: string,
  confidence: 'high' | 'medium' | 'low',
  matchedVia: string    // audit trail: 'zip-prefix', 'capital-in-address2', etc.
}
```

---

## 5. Resolver determinístico de barrio MVD

**Archivos:** `mvd-street-ranges.ts` + `ai-resolver.ts:666`

Función `mvdBarrioFromStreet(address1: string): StreetRangeHit | null`:

1. Normaliza nombre (quita "Av.", "Avenida", acentos, lowercase)
2. Extrae número de puerta con regex `/\d+/`
3. Lookup en `MVD_STREET_RANGES`
4. Retorna `{ barrio, matchedStreet, number, note }` o `null`

**Beneficio:** ahorra ~$0.002 + 7 segundos por orden MVD sobre avenidas canónicas.

**Diseño conservador** (líneas 20-43): solo las 20+ avenidas de alto volumen con rangos verificados contra órdenes reales. Gaps caen a la IA.

---

## 6. Resolver determinístico de ciudad

**Archivo:** `apps/worker/src/dac/dac-city-resolver.ts` — `resolveCityDeterministic()` (líneas 98-151)

### Regla 1 — Match exacto (109-118)
`canonicalizeCityName(dept, input.city)` — normaliza ciudad de Shopify (lowercase, quita acentos) y verifica si coincide con spelling canónico DAC.

Ejemplo: `"Colonia del Sacramento"` normalizado → matches `"Colonia Del Sacramento"` en dropdown DAC.

### Regla 2 — Scan en address2 (120-151)
Escanea address2 + city + address1 + orderNotes por cualquier ciudad canónica DAC en el departamento destino.

**Criterio de desempate:** elige el **match más largo** para evitar colisiones.
- Ejemplo: `"San José de Mayo"` > `"San José"` — gana el más largo.

---

## 7. Orden total de checks pre-IA

Todos los checks corren en cascada antes de invocar Claude. Cada uno intenta cerrar el caso con `$0`.

| # | Check | Archivo | Costo ahorrado |
|---|---|---|---|
| 1 | Prefijo ZIP | `dac-dept-resolver.ts` | $0 + 2-7s |
| 2 | Capital departamental en address | `dac-dept-resolver.ts` | $0.002 |
| 3 | Ciudad mayor no capital | `dac-dept-resolver.ts` | $0.002 |
| 4 | Tiebreaker ambiguo | `duplicate-city-tiebreaker.ts` | $0.002 en patrón frecuente |
| 5 | Barrio MVD por rango | `mvd-street-ranges.ts` | $0.002 + 7s |
| 6 | Match exacto ciudad interior | `dac-city-resolver.ts` | $0.002 |
| 7 | Scan address2 por ciudad conocida | `dac-city-resolver.ts` | $0.002 |
| 8 | **Cache por hash de address** | `ai-resolver.ts:641-656` | $0.002 en clientes repetidos |

### Sistema de cache por hash

El cache usa `inputHash` sobre la tupla:
```typescript
{
  city,
  address1: stripPrefixes(address1),
  address2: stripAptMarkers(address2),
  zip
}
```

Query a la tabla `AddressResolution` por `inputHash`. Si hay hit con `dacAccepted=true`, devuelve el resultado cacheado.

---

## 8. YELLOW dispatcher — 3 estrategias de fallback

**Archivo:** `apps/worker/src/agent/invoke-claude.ts`

Cuando el pipeline determinístico no alcanza HIGH confidence, `resolveAddressCorrection()` (líneas 593-617) dispara las estrategias en orden:

### Estrategia 1 — Tailscale Bridge ($0)
**`invokeClaudeViaBridge()` (líneas 438-501)**

- **Gatillo:** `LABELFLOW_BRIDGE_URL` + `LABELFLOW_BRIDGE_SECRET` seteadas
- **Flujo:**
  1. Build address context (403-423)
  2. POST a `/correct-address` con JSON body
  3. Header `x-labelflow-secret` para autenticación (constant-time compare)
  4. Timeout: `LABELFLOW_BRIDGE_TIMEOUT_MS` (default 120s)
- **Destino:** Mac Mini casero → spawn `claude -p --model haiku`
- **Costo:** $0 (usa Claude Max subscription)

### Estrategia 2 — Anthropic API ($0.002/call)
**`invokeClaudeViaAnthropicAPI()` (líneas 504-580)**

- **Gatillo:** `ANTHROPIC_API_KEY` seteada
- **Modelo:** `claude-haiku-4-5-20251001`, max_tokens=512
- **System prompt:** `CORRECTION_RULES` (427-435) + "responde solo JSON"
- **User message:** razones de clasificación + context JSON
- **Parse tolerante a fences:** strips ` ```json ` si está presente (línea 562)
- **Timeout:** `LABELFLOW_API_TIMEOUT_MS` (default 30s)
- **Costo:** ~$0.0008-0.002/call (Haiku: $1/$5 per 1M tokens in/out)

### Estrategia 3 — CLI local ($0)
**`invokeClaudeForAddressCorrection()` (líneas 259-392)**

- **Gatillo:** solo dev/Mac Mini con `CLAUDE_BIN` instalado
- **Flujo:**
  1. Escribe context JSON atómicamente a `/tmp/labelflow-addr-context.json` (permisos 0600)
  2. Spawn: `claude -p --model haiku --allowed-tools Read,Write --output-format json`
  3. Claude lee context, aplica correction rules, escribe JSON a `/tmp/labelflow-addr-result.json`
  4. Parse resultado
  5. Cleanup en `try/finally` con SIGTERM + SIGKILL
- **Timeout:** `ADDRESS_CORRECTION_TIMEOUT_MS` (default 90s)

### Semántica de outcomes (compartida)
- `resolved` → retorna override, **corta dispatcher**
- `unresolvable` (Claude rehusó, ej. ciudad fuera de Uruguay) → retorna null, **no quema próxima estrategia**
- `unavailable` (red/auth/5xx/timeout) → cae a la siguiente estrategia

### Estructura AddressOverride
```typescript
interface AddressOverride {
  address1?: string;        // calle + número limpio
  notes?: string;           // apto, piso, portería
  department?: string;      // depto corregido
  city?: string;            // ciudad corregida
  phone?: string;           // normalizado 8 dígitos
  recipientName?: string;   // opcional
}
```

---

## 9. Flujo completo Webhook → Guía

### Fase 1 — Webhook Shopify
**Archivo:** `apps/web/app/api/webhooks/shopify/route.ts` (líneas 22-64)

1. POST `orders/paid` desde Shopify
2. Verifica HMAC con `SHOPIFY_CLIENT_SECRET` (fix H-2 del 2026-04-19 — usa el app secret, no el per-shop access token)
3. Lookup de tenant por `shop` domain (después de verificar firma)
4. Encola `processOrdersJob(tenantId)`
5. Retorna 200 en <2s (Shopify requirement)

### Fase 2 — Job del worker
**Archivo:** `apps/worker/src/jobs/process-orders.job.ts`

1. **Load tenant config** (84-114): DAC username/password descifrados, Shopify token, rules
2. **Fetch órdenes unfulfilled** (119-126): Shopify API con sort direction
3. **Filtra órdenes procesadas** (129-143): skip las que tienen label COMPLETED + guía real (no PENDING-*)
4. **Filtro por product type** (147-178): si `allowedProductTypes` seteado
5. **Aplica `maxOrdersPerRun`** (192-197)
6. **`dacBrowser.getPage()` + `smartLogin()`** (199-254): usa cookies cacheadas hasta 4h para evitar reCAPTCHA v2 (solved via 2Captcha cuando hace falta, `CAPTCHA_API_KEY`)

### Fase 3 — Por cada orden (líneas 254-495)

#### 4a. Validar dirección (266-296)
- Verifica shipping_address + address1 presente
- Si falta: crea label FAILED, nota en Shopify, skip

#### 4b. Determinar payment type (308-352)
- Primero: rules engine nuevo (REMITENTE override)
- Fallback: legacy `determinePaymentType(threshold)` + consolidation window check

#### 4c. Check duplicate guía (355-367)
Si ya existe guía real de un run fallido anterior, **la reusa** en vez de re-submitear el form DAC. Previene envíos duplicados.

#### 4d. `createShipment()` (368-391)
Flujo Playwright completo. Retorna:
```typescript
{
  guia,
  trackingUrl?,
  screenshotPath?,
  paymentStatus?,
  paymentFailureReason?
}
```
Trackea guía en `usedGuias` set para prevenir reuso en mismo batch.

#### 4e. Save label record (416-451)
- Upsert `Label` con: shopifyOrderId, dacGuia, status=CREATED, paymentStatus
- `buildSafeLabelGeoFields()` garantiza city/dept no-null
- `mergeAddress()` para address1+address2

#### 4f. Download PDF (472-495)
- Solo si guía es real (no PENDING-*)
- URL: `https://www.dac.com.uy/envios/getPegote?CodigoRastreo={guia}`
- Retry hasta 4 veces con backoff: 5s / 15s / 30s / 60s (por indexing delay DAC)
- Upload a storage, label → COMPLETED
- Si guía es PENDING: skip PDF, label queda CREATED (reconciliación manual)

#### 4g. Fulfill Shopify (498+)
- Fulfillment line con DAC tracking URL
- Notification email al cliente

### Fase 4 — Dentro de `createShipment()`
**Archivo:** `apps/worker/src/dac/shipment.ts` (líneas 851-1200+)

Orden de resolución:
1. `resolveDepartmentDeterministic()` → si HIGH, skip IA
2. `mvdBarrioFromStreet()` si depto=Montevideo con buena señal
3. `resolveCityDeterministic()` para interior
4. Cache lookup por `inputHash`
5. `resolveAddressWithAI()` con web_search (solo si nada de arriba resolvió)
6. Validación final contra `VALID_MVD_BARRIOS` y `VALID_DEPARTMENTS`
7. Si IA retorna null o LOW → label marked con nota `manual_review_recommended`

---

## 10. Sistema de confidence scoring

**Archivo:** `apps/worker/src/dac/ai-resolver.ts` (líneas 175-198)

### AIResolverResult
```typescript
interface AIResolverResult {
  barrio: string | null;
  city: string;
  department: string;
  deliveryAddress: string;
  extraObservations: string;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  source: 'ai' | 'cache' | 'deterministic';
  inputHash: string;
  aiCostUsd?: number;
  webSearchRequests?: number;
  priorShipmentsUsed?: number;
}
```

### Niveles de confianza

| Nivel | Cuándo |
|---|---|
| **HIGH** | ZIP match exacto; capital en address unambigua; match exacto ciudad; barrio por rango hit; IA con señales claras (ZIP confirma ciudad, historial cliente) |
| **MEDIUM** | Ciudad ambigua con tiebreaker aplicado (La Paz → Canelones); province field confirmó depto; address2 matched ciudad conocida; IA resolvió pero con señales mildas |
| **LOW** | IA no pudo con certeza a pesar de web_search; contradicción multi-campo; sin señales claras; dirección descriptiva ("al lado del super") sin calle/número |

### Validación final (shipment.ts 1040-1110)
1. Pre-checks determinísticos
2. AI resolver solo si pre-checks no dieron HIGH
3. Verifica barrio contra `VALID_MVD_BARRIOS` (ai-resolver.ts 85-144)
4. Verifica depto contra `VALID_DEPARTMENTS` (62-82)
5. Canonicaliza city contra dropdown DAC
6. Store `confidence` en `Label.confidenceScore`
7. Si no HIGH → nota `manual_review_recommended`

---

## 11. Topología bridge desplegada

**Verificado 2026-04-19**

### Mac Mini
- Ubicación: casa del usuario
- Ejecuta: `mac-mini-bridge/bridge-server.mjs`
- Process manager: LaunchAgent `com.labelflow.claude-bridge`
- Puerto: `0.0.0.0:7777`
- Spawnea `claude -p` por request
- Auth: `X-Labelflow-Secret` header con constant-time compare (256-bit)

### Tailscale
- CLI instalada via `brew install tailscale` (no el cask — el kernel extension del GUI app tenía bugs)
- Start: `sudo brew services start tailscale`
- IP tailnet del Mac Mini: `100.100.160.118`

### Tailscale Funnel (expone públicamente)
- URL pública: `https://192.tail3972b9.ts.net`
- Pasos de habilitación:
  1. MagicDNS + HTTPS Certificates toggle en DNS admin panel
  2. `nodeAttrs` con `funnel` attr en ACL policy
  3. `sudo tailscale funnel --bg --https=443 http://localhost:7777`

### Worker Render
- Service: `srv-d72smcsg9agc73bpuatg` (Docker background worker)
- Dockerfile: `apps/worker/Dockerfile` (base `mcr.microsoft.com/playwright:v1.50.0-noble`)
- Env vars:
  - `LABELFLOW_BRIDGE_URL` — URL pública Funnel
  - `LABELFLOW_BRIDGE_SECRET` — token 256-bit
  - `LABELFLOW_BRIDGE_TIMEOUT_MS=120000`
  - `ANTHROPIC_API_KEY` — para fallback strategy 2

### E2E verificado
Desde Render Web Shell: POST a `/correct-address` con payload YELLOW de Solymar devolvió override correcto:
- `department: Canelones`
- apartment extraído a notes
- phone normalizado a 8 dígitos

---

## 12. Tabla resumen de ejecución determinística

| Stage | File | Function | Input | Output | Cost | Fallback |
|---|---|---|---|---|---|---|
| 1. Classification | `rules/order-classifier.ts` | `classifyOrder()` | ShopifyOrder | GREEN/YELLOW/RED | $0 | N/A |
| 2. Address Merge | `dac/shipment.ts` | `mergeAddress()` | address1, address2 | fullAddress, extraObs | $0 | N/A |
| 3. ZIP Prefix | `dac/dac-dept-resolver.ts` | rule 1 | zip | department, HIGH | $0 | Rule 2 |
| 4. Dept Capitals | `dac/dac-dept-resolver.ts` | rule 2 | city, addr1, addr2 | department, HIGH | $0 | Rule 3 |
| 5. Major Cities | `dac/dac-dept-resolver.ts` | rule 3 | city, address fields | department, HIGH | $0 | Rule 4 |
| 6. Ambiguous Tiebreak | `dac/dac-dept-resolver.ts` | rule 3.5 | city, address2 | department, MEDIUM | $0 | Rule 4 |
| 7. City Exact | `dac/dac-dept-resolver.ts` | rule 4 | city | department, HIGH | $0 | Rule 5 |
| 8. Province | `dac/dac-dept-resolver.ts` | rule 5 | province | department, MEDIUM | $0 | AI |
| 9. MVD Barrio Range | `dac/ai-resolver.ts` | `mvdBarrioFromStreet()` | address1 | barrio, HIGH | $0 | AI |
| 10. City Exact Interior | `dac/dac-city-resolver.ts` | `canonicalizeCityName()` | dept, city | city, HIGH | $0 | Scan |
| 11. Address Scan | `dac/dac-city-resolver.ts` | field scan | dept, address fields | city, MEDIUM | $0 | AI |
| 12. Cache Lookup | `dac/ai-resolver.ts` | inputHash check | address tuple | AIResolverResult | $0 | AI |
| 13. AI Resolution | `dac/ai-resolver.ts` | `resolveAddressWithAI()` | AIResolverInput | AIResolverResult | $0.002 | Manual |
| 14a. Bridge Strategy | `agent/invoke-claude.ts` | `invokeClaudeViaBridge()` | context | ClaudeAddressResult | $0 | Strategy 2 |
| 14b. API Strategy | `agent/invoke-claude.ts` | `invokeClaudeViaAnthropicAPI()` | context | ClaudeAddressResult | $0.002 | Strategy 3 |
| 14c. CLI Strategy | `agent/invoke-claude.ts` | `invokeClaudeForAddressCorrection()` | context JSON | AddressOverride | $0 | Return null |

---

## 13. Referencia rápida de archivos y líneas

| Tarea | Archivo | Líneas | Función |
|---|---|---|---|
| Clasificación orden | `rules/order-classifier.ts` | 60-150 | `classifyOrder()` |
| Merge address | `dac/shipment.ts` | 294-499 | `mergeAddress()` |
| ZIP → depto | `dac/dac-dept-resolver.ts` | 89-111, 357-377 | `ZIP_PREFIX_TO_DEPT`, rule 1 |
| Capitales depto | `dac/dac-dept-resolver.ts` | 128-147, 380-388 | `DEPT_CAPITALS`, rule 2 |
| Ciudades mayores | `dac/dac-dept-resolver.ts` | 150-208, 391-399 | `MAJOR_NON_CAPITAL_CITIES`, rule 3 |
| Duplicate cities | `dac/duplicate-city-tiebreaker.ts` | 43-96 | `DUPLICATE_CITY_TIEBREAKER` |
| MVD street ranges | `dac/mvd-street-ranges.ts` | 73-200+ | `MVD_STREET_RANGES` |
| MVD barrio lookup | `dac/ai-resolver.ts` | 651-703 | `mvdBarrioFromStreet()` |
| City exact | `dac/dac-city-resolver.ts` | 109-118 | `canonicalizeCityName()` |
| City address scan | `dac/dac-city-resolver.ts` | 120-151 | field scan |
| AI resolution | `dac/ai-resolver.ts` | 618-850 | `resolveAddressWithAI()` |
| Bridge dispatcher | `agent/invoke-claude.ts` | 438-501 | `invokeClaudeViaBridge()` |
| API dispatcher | `agent/invoke-claude.ts` | 504-580 | `invokeClaudeViaAnthropicAPI()` |
| CLI dispatcher | `agent/invoke-claude.ts` | 259-392 | `invokeClaudeForAddressCorrection()` |
| Dispatcher entry | `agent/invoke-claude.ts` | 593-617 | `resolveAddressCorrection()` |
| Main job loop | `jobs/process-orders.job.ts` | 53-500+ | `processOrdersJob()` |
| Shipment creation | `dac/shipment.ts` | 851-1200+ | `createShipment()` |
| PDF download | `dac/label.ts` | 22-100 | `downloadLabel()` |
| Shopify webhook | `apps/web/app/api/webhooks/shopify/route.ts` | 22-64 | HMAC + enqueue |

---

## Arquitectura general — resumen de una línea por archivo clave

| Archivo | Rol |
|---|---|
| `rules/order-classifier.ts` | GREEN/YELLOW/RED por completitud de campos |
| `dac/shipment.ts` | `mergeAddress()` + orquestación `createShipment()` |
| `dac/dac-dept-resolver.ts` | 6 reglas determinísticas para departamento |
| `dac/dac-city-resolver.ts` | Match exacto + scan address2 para ciudad |
| `dac/mvd-street-ranges.ts` | Barrio MVD por rango de numeración |
| `dac/duplicate-city-tiebreaker.ts` | Desempate por población de ciudades duplicadas |
| `dac/uruguay-geo.ts` | 530+ ciudades → 19 departamentos |
| `dac/ai-resolver.ts` | Cache + IA con web_search como fallback |
| `agent/invoke-claude.ts` | Dispatcher 3 estrategias: Bridge → API → CLI |
| `jobs/process-orders.job.ts` | Loop principal webhook → guía |

---

## Fixes de seguridad aplicados (2026-04-19)

| ID | Archivo | Fix |
|---|---|---|
| **C-1** | `apps/web/app/api/v1/chat/report/route.ts` | Admin tenant IDs movidos de array hardcoded a env var `ADMIN_TENANT_IDS` (comma-separated). Fallback a array vacío. |
| **H-1** | `apps/web/app/api/webhooks/mercadopago/route.ts` | Retorna 503 (no 500) cuando `MERCADOPAGO_WEBHOOK_SECRET` falta. |
| **H-2** | `apps/web/app/api/webhooks/shopify/route.ts` | HMAC verification usa `SHOPIFY_CLIENT_SECRET` (app API secret key), no el per-shop access token. Verificación antes del DB lookup. |
| **H-3** | `apps/worker/src/agent/invoke-claude.ts` | Credenciales DAC removidas del JSON en /tmp; ahora se pasan como env vars `DAC_USERNAME`/`DAC_PASSWORD` al proceso claude spawned. Cleanup en `try/finally`. Context file con permisos 0600. SKILL.md actualizado para leer credenciales de env. |

---

## Filosofía de diseño

1. **Determinismo primero, IA como último recurso** — cada orden pasa por 7-8 checks determinísticos antes de invocar Claude. La IA cuesta dinero y tiempo.

2. **Datos verificados a mano** — las tablas de ZIP, capitales, ciudades mayores, y rangos MVD están todas confirmadas contra órdenes reales. Diseño conservador: mejor `null` que un match incorrecto.

3. **Desempate por volumen poblacional** — cuando dos ciudades comparten nombre, la de mayor población gana (INE 2011 census).

4. **Cascada de 3 estrategias para resiliencia** — Bridge ($0, rápido) → API ($, always-on) → CLI ($0, dev). Si el Mac Mini se cae (corte de luz, internet), el worker sigue funcionando via Anthropic API.

5. **Audit trail exhaustivo** — cada resolución incluye `matchedVia` / `source` / `reasoning` / `confidence` para debug y reconciliación.

6. **Cache hash-based** — clientes recurrentes pagan $0 en resoluciones repetidas. Hash sobre tupla normalizada `{ city, address1 limpio, address2 limpio, zip }`.

7. **Manual review como última red** — si nada funciona, la label queda marcada con `manual_review_recommended` en vez de fallar silenciosamente.
