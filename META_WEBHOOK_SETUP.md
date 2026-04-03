# Configuracion de Webhook de WhatsApp (Meta)

Instrucciones para conectar el numero de WhatsApp de AutoEnvia con el modulo Recover.

---

## Pre-requisitos

- Cuenta en [Meta for Developers](https://developers.facebook.com/)
- App de Meta con producto WhatsApp configurado
- Numero de telefono verificado en Meta Business
- Variables de entorno configuradas (ver `.env.example`)

---

## Paso 1 — Variables de entorno

Agregar al archivo `.env` (Vercel + Render):

```env
WHATSAPP_API_TOKEN=          # Token permanente de la app de Meta
WHATSAPP_PHONE_NUMBER_ID=    # ID del numero (no el numero en si)
WHATSAPP_BUSINESS_ACCOUNT_ID=# WABA ID (en Meta Business Suite)
WHATSAPP_WEBHOOK_VERIFY_TOKEN=recover_wh_$(openssl rand -hex 16)
WHATSAPP_APP_SECRET=         # App Secret de Meta (Settings > Basic) — firma HMAC de webhooks POST
RECOVER_MERCADOPAGO_PLAN_ID= # ID del plan creado en MercadoPago
```

Para generar un `WHATSAPP_WEBHOOK_VERIFY_TOKEN` seguro:
```bash
openssl rand -hex 24
```

---

## Paso 2 — Obtener credenciales de Meta

1. Ir a [developers.facebook.com](https://developers.facebook.com/) → tu App
2. En el panel izquierdo: **WhatsApp** → **API Setup**
3. Copiar:
   - **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`
4. Para el **App Secret**:
   - Ir a **Settings** → **Basic** en tu App de Meta
   - Copiar el **App Secret** → `WHATSAPP_APP_SECRET`
   - Este valor firma todos los webhooks POST con HMAC-SHA256 (`X-Hub-Signature-256`)
5. Para el token permanente:
   - Ir a **System Users** en Meta Business Suite
   - Crear un System User con rol Admin
   - Generar token permanente con permisos `whatsapp_business_messaging`, `whatsapp_business_management`
   - Copiar el token → `WHATSAPP_API_TOKEN`

---

## Paso 3 — Obtener App Secret

1. En tu App de Meta: **Settings** → **Basic**
2. Copiar el valor de **App Secret**
3. Guardarlo en `WHATSAPP_APP_SECRET`

Este secret se usa para verificar la firma HMAC-SHA256 en cada webhook POST que Meta envia a `/api/webhooks/whatsapp`.

---

## Paso 3 — Configurar el webhook en Meta

1. Ir a tu App en Meta Developers → **WhatsApp** → **Configuration**
2. En la seccion **Webhook**, hacer click en **Edit**
3. Completar:
   - **Callback URL**: `https://autoenvia.com/api/webhooks/whatsapp`
   - **Verify Token**: el valor que pusiste en `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
4. Hacer click en **Verify and Save**

Si la verificacion es exitosa, Meta hara un GET a tu endpoint y retornara el challenge.

---

## Paso 4 — Suscribirse a los campos del webhook

Despues de verificar, en la misma pantalla:

1. En **Webhook fields**, activar:
   - `messages` (mensajes entrantes — para detectar opt-outs)
   - `message_status_updates` (para actualizar estado de mensajes enviados)
2. Hacer click en **Save**

---

## Paso 5 — Configurar el plan de suscripcion en MercadoPago

1. Ir a [MercadoPago Developers](https://www.mercadopago.com.uy/developers) → Subscriptions
2. Crear un nuevo plan de suscripcion:
   - Nombre: `AutoEnvia Recover`
   - Monto: `490 UYU` (o el precio que definas)
   - Frecuencia: mensual
3. Copiar el `id` del plan → `RECOVER_MERCADOPAGO_PLAN_ID`
4. Configurar el webhook de MercadoPago para que apunte a:
   - `https://autoenvia.com/api/recover/subscription-webhook`

---

## Paso 6 — Verificar que todo funcione

### Test de verificacion del webhook:
```bash
curl "https://autoenvia.com/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=TU_TOKEN&hub.challenge=test123"
# Debe retornar: test123
```

### Test de envio de mensaje (usando Meta API Explorer):
```bash
curl -X POST https://graph.facebook.com/v19.0/{PHONE_NUMBER_ID}/messages \
  -H "Authorization: Bearer {WHATSAPP_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "to": "598XXXXXXXXX",
    "type": "text",
    "text": { "body": "Test desde AutoEnvia Recover" }
  }'
```

---

## Flujo completo de recuperacion

```
1. Cliente abandona carrito en Shopify
   └─> Shopify envia webhook a /api/webhooks/shopify/checkouts

2. Sistema registra el carrito y programa un RecoverJob
   └─> Delay configurable (30min - 3h)

3. Worker detecta el job cuando llega el momento
   └─> Envia mensaje WhatsApp al cliente

4. Meta envia status update a /api/webhooks/whatsapp
   └─> Sistema actualiza estado (enviado, entregado, leido)

5. Si el cliente responde "STOP"
   └─> Sistema registra opt-out, cancela mensajes futuros

6. Si el cliente completa la compra
   └─> Shopify envia webhook checkouts/update con completed_at
   └─> Sistema cancela jobs pendientes y marca como RECOVERED
```

---

## Limites de la API de WhatsApp

| Limite | Valor |
|--------|-------|
| Mensajes por segundo | 80 msg/s (cuenta verificada) |
| Ventana de mensajes salientes | Solo a numeros que hayan iniciado conversacion en las ultimas 24h O usar templates aprobados |
| Costo por mensaje | Ver pricing de Meta (varia por pais) |

**Importante para MVP**: Los mensajes de texto libre (como los que envia Recover) solo se pueden enviar a usuarios que hayan iniciado una conversacion con el numero en las ultimas 24 horas, O si usas **Message Templates** aprobados por Meta. Para produccion real se recomienda migrar a Message Templates.

---

## Troubleshooting

| Error | Causa | Solucion |
|-------|-------|----------|
| Webhook verification failed | Token incorrecto | Verificar `WHATSAPP_WEBHOOK_VERIFY_TOKEN` en .env |
| 131030 (template error) | Mensaje libre bloqueado | El destinatario no inicio conversacion en 24h, usar template |
| 100 (invalid parameter) | Numero en formato incorrecto | Verificar que el numero este en E.164 (+598XXXXXXXX) |
| CONFIG_MISSING en logs | Variables de entorno faltantes | Verificar que WHATSAPP_API_TOKEN y WHATSAPP_PHONE_NUMBER_ID esten configurados |
