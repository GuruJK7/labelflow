# Contrareembolso (COD) de DAC — estado y cómo terminarlo

> 01/09/2026 · rama `feat/dac-contrarreembolso`

## Qué es

DAC agregó una tercera opción en "Tipo de Guía": además de *Paga remitente* y
*Paga destinatario*, ahora existe **Contrareembolso**, donde DAC le **cobra la
mercadería** al destinatario y le gira la plata al remitente.

**No es lo mismo que "Paga destinatario"**, que sólo define quién paga el *flete*.
El código venía mezclando los dos conceptos (`schema.prisma` llamaba "COD" a
DESTINATARIO); ahora están separados.

## Los valores reales de DAC

Leídos del DOM en vivo de `dac.com.uy/envios/nuevo` el 01/09/2026, sin emitir
ninguna guía:

| campo | valor |
|---|---|
| `select[name="TipoGuia"]` | `1` Paga remitente · `4` Paga destinatario · **`6` Contrareembolso** |
| `input[name="CostoMercaderia"]` | el monto. `pattern="[0-9]*"` — **sólo dígitos**. Paso 4 del wizard |

⚠️ DAC lo escribe **"Contrareembolso"**, con una sola R.

Seleccionar el menú y leer el DOM **no crea nada**. Lo que emite la guía son los
botones **"Agregar"** y **"Finalizar envío"**.

## Lo que YA está hecho y verificado

| Capa | Archivo | Estado |
|---|---|---|
| Lógica pura | `apps/worker/src/dac/contrarreembolso.ts` | ✅ 18 tests |
| Copia web | `apps/web/lib/contrarreembolso.ts` | ✅ 8 tests |
| Modelo | `Label.codAmount Int?` en ambos schemas | ✅ sincronizados |
| Migración | `scripts/sql/cod-contrarreembolso.sql` | ⏳ **sin aplicar** |
| Anti-doble-cobro | `apps/web/lib/stuck-labels.ts` | ✅ un COD huérfano nunca se auto-reintenta |
| API | `GET /api/v1/orders?pago=cod\|REMITENTE\|DESTINATARIO` | ✅ |
| UI | filtro "Forma de cobro" + badge | ✅ |

**Suite: 2829 tests (+26), los mismos 4 archivos que ya fallaban antes.**

## Por qué NO se tocó el enum `PaymentType`

Hay tres lugares que hacen `paymentType === 'REMITENTE' ? a : b` y tratan
cualquier otro valor como DESTINATARIO. Uno —`stuck-labels.ts:85`— **no es
cosmético**: decide si un envío trabado se reintenta o se retiene. Un tercer valor
en el enum los habría roto en silencio.

Por eso el contrareembolso es un **campo aparte y nullable**: con `codAmount = null`
el sistema se comporta *exactamente* como antes.

## 🔴 Lo que FALTA: el paso que toca la automatización

Nada de lo anterior hace todavía que DAC emita una guía como contrareembolso. Para
eso hay que llenar el formulario, y eso vive en `apps/worker/src/dac/shipment.ts`,
**automatización Playwright intocable por regla del proyecto**: ~3.800 líneas,
**cero tests sobre el llenado de TipoGuia**, y un valor mal puesto emite guías
reales mal facturadas en la cuenta del cliente.

La lógica ya está resuelta y testeada afuera. El cambio es **una línea** en
`shipment.ts:2365`, donde hoy dice:

```ts
const payVal = paymentType === 'REMITENTE'
  ? DAC_SELECTORS.PAYMENT_VALUE_REMITENTE
  : DAC_SELECTORS.PAYMENT_VALUE_DESTINATARIO;
```

pasaría a:

```ts
import { planDeCod } from './contrarreembolso';
const cod = planDeCod({ codAmount: label.codAmount });
const payVal = cod.esCod
  ? cod.tipoGuia                                   // '6'
  : paymentType === 'REMITENTE'
    ? DAC_SELECTORS.PAYMENT_VALUE_REMITENTE
    : DAC_SELECTORS.PAYMENT_VALUE_DESTINATARIO;
```

y en el paso 4, antes de "Agregar":

```ts
if (cod.esCod) await page.fill('input[name="CostoMercaderia"]', cod.costoMercaderia);
```

`planDeCod` devuelve `esCod: false` ante cualquier valor dudoso, así que con
`codAmount = null` el `payVal` resultante es **idéntico al de hoy**.

## ⚠️ Antes de habilitarlo para un cliente real

1. **Aplicar la migración**: `psql "$DIRECT_URL" -f scripts/sql/cod-contrarreembolso.sql`.
   Nunca `db:push` (precedente en `wms-deploy.sql:34-36`).
2. 🔴 **Emitir UNA guía de prueba y verificar el importe.** Que `CostoMercaderia` sea
   el monto que DAC efectivamente cobra —y no sólo el valor declarado para seguro—
   **es una inferencia**: el campo ya existía para los tres tipos y nunca queda
   `required` en el HTML, así que valida el servidor de DAC. No se puede confirmar
   sin emitir una guía.
3. Definir de dónde sale el monto (¿total del pedido? ¿menos el envío?). Hoy **nada
   lo escribe**: `codAmount` sólo se puede cargar a mano.
