# Pagos — MercadoPago (principal) y Whop (segundo riel)

## 1. Veredicto sobre Whop (investigado 2026-09-01, fuentes oficiales salvo que se aclare)

**No reemplaza a MercadoPago para Uruguay. Sirve como segundo riel para clientes
de afuera que pagan en USD, o para tickets agregados grandes.**

| Concepto | Whop (docs.whop.com/fees) | MercadoPago UY |
|---|---|---|
| Tarjeta | 2,7 % + **USD 0,30 fijo**; +1,5 % internacional; +1 % conversión → **~5,2 % + 0,30** para tarjeta uruguaya | 5,99 % + IVA (22 %) = **7,31 %** al instante; 4,99 % + IVA = **6,09 %** a 21 días |
| Ticket USD 2 (un envío) | 0,30/2 = 15 % + 5,2 % = **20,2 %** | 7,31 % |
| Breakeven vs MP instante | Whop conviene **arriba de USD 14,22** | — |
| Breakeven vs MP 21 días | Whop conviene **arriba de ~USD 34** | — |
| Cripto | acepta btc/eth/usdt/ape, **convierte a USD**; el comerciante nunca recibe cripto. Payout *en* cripto: 5 % + USD 1 | no |
| Uruguay | en la grilla de payouts; riel local = "varies by country" (si cae wire: USD 23/retiro). **Sin adquirencia local**: tarjeta UY entra cross-border | nativo |
| `uyu` | está en el enum de `currency`; hay `settlement_currency` separado | UYU nativo |
| Chargeback | USD 15 ganes o pierdas; reservas escalonadas hasta 100 %/180 días; retención hasta 120 días si suspenden | reglas MP |
| Fiscal | **no emite CFE de DGI** — bloqueante para facturar a clientes uruguayos, más que el precio | integrado |
| One-time products | tope de **120 días de acceso** en Seller Terms — choca con "créditos sin vencimiento" si se venden como producto one-time | — |
| Prohibido | vender cripto como producto | — |

Dos cosas que **no** se pudieron cerrar: si Whop trata la tarjeta uruguaya como
"internacional" (es inferencia por falta de adquirencia local), y qué riel de
payout le toca a un banco uruguayo. Se resuelven con cuenta sandbox y una
consulta escrita a Whop antes de mover un peso.

**Estado de la cuenta de Adrian (visto 2026-09-01):** cuenta personal, saldo
USD 0,00, sin company/negocio creado. Para vender por Whop hay que crear una
company primero.

## 2. Contrato de retorno de Whop (verificado en la URL real)

Tras el checkout, Whop redirige a la URL del vendedor con:
`?receipt_id=pay_…&payment_id=pay_…&checkout_status=success&status=success&state_id=chs_…`

- `payment_id` = id del pago (`pay_…`) → **clave de idempotencia** del asiento: `whop:<payment_id>`.
- `state_id` = sesión de checkout (`chs_…`) creada por `POST /api/v1/checkout_configurations`.
- **La página de retorno no acredita nada.** Igual que con MP: sólo el webhook, y sólo después de reconsultar el pago.

## 3. Integración Whop en el wallet (diseño; no construido)

1. `POST /api/wallet/purchases` con `rail: 'whop'` → crea `CreditPurchase{status: PENDING, externalRef: purchase.id, rail}` y una checkout configuration en Whop con `metadata { purchaseId, accountId }` y `redirect_url = /billetera/compra/:id`. Usar header `Idempotency-Key: purchase.id` (Whop cachea 24 h, marca `Idempotent-Replayed`).
2. Webhook `POST /api/webhooks/whop`: firma **Standard Webhooks** — HMAC-SHA256 sobre `{webhook-id}.{webhook-timestamp}.{raw body}`, header `webhook-signature` (`v1,<base64>`). Fail-closed sin secreto. Dedupe por `webhook-id` en `WebhookReceipt(source='whop')` (Whop reintenta 12 veces, 30 s → 12 h).
3. El job **no confía en el payload**: `GET /api/v1/payments/{id}`; exige `status` pagado, monto y moneda de la compra, `metadata.purchaseId` coincidente. Si no → `FLAGGED`, alerta, no acredita.
4. Acreditación en una transacción con `WalletEntry.idemKey = whop:<payment_id>` (unique). Conflicto = ya acreditado, salir sin error.
5. `refund.*` / `dispute.*` → asiento negativo + `paidIn` baja (ver `funds.ts`: si no baja, un contracargo deja habilitado el gasto en bots para siempre).

**Ojo de diseño:** como el saldo se denomina en UYU y Whop liquida en USD, la
compra por Whop acredita al tipo de cambio cotizado en el checkout y guardado en
la compra — nunca el del momento del webhook (ese bug ya existió en AutoBoost).

## 4. MercadoPago (lo que ya está y hay que conservar)

- Preference (pago único), `external_reference = pkg|<purchaseId>`, webhook con `x-signature` HMAC fail-closed y reconsulta a `/v1/payments/{id}`, idempotencia por `mpPaymentId @unique`. Verificado: **no hay agujero de regalarse saldo**.
- Falta: `refunded`/`charged_back` (hoy sólo mira `approved`), y que el webhook escriba `WalletEntry` en el **mismo deploy** que el cutover del wallet.
