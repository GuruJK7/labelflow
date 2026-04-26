// Tests para el modelo de credit packs y referidos.
// Run:  node --test apps/web/lib/__tests__/credit-packs.test.mjs
//
// Self-contained: re-implementa la lógica crítica desde el mismo spec que
// lib/credit-packs.ts y lib/referrals.ts. Si el TS drifta, este test pasa
// pero la app no se comporta según contrato — la mantención es manual.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// ── Spec replicado de lib/credit-packs.ts ──
const CREDIT_PACKS = {
  pack_10:   { id: 'pack_10',   shipments: 10,   pricePerShipmentUyu: 20, totalPriceUyu: 200  },
  pack_50:   { id: 'pack_50',   shipments: 50,   pricePerShipmentUyu: 17, totalPriceUyu: 850  },
  pack_100:  { id: 'pack_100',  shipments: 100,  pricePerShipmentUyu: 15, totalPriceUyu: 1500 },
  pack_250:  { id: 'pack_250',  shipments: 250,  pricePerShipmentUyu: 12, totalPriceUyu: 3000 },
  pack_500:  { id: 'pack_500',  shipments: 500,  pricePerShipmentUyu: 10, totalPriceUyu: 5000 },
  pack_1000: { id: 'pack_1000', shipments: 1000, pricePerShipmentUyu: 7,  totalPriceUyu: 7000 },
};
const REFERRAL_KICKBACK_RATE = 0.2;

function calcReferralKickback(shipments) {
  if (!Number.isFinite(shipments) || shipments <= 0) return 0;
  return Math.floor(shipments * REFERRAL_KICKBACK_RATE);
}

// ── Spec de lib/referrals.ts ──
const REFERRAL_CODE_REGEX = /^[A-Z0-9]{2,8}-[A-Z0-9]{4,8}$/;

function isValidReferralCodeShape(code) {
  if (!code) return false;
  return REFERRAL_CODE_REGEX.test(code);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex').slice(0, 16);
}

function buildReferralCookieValue(code, secret) {
  if (!isValidReferralCodeShape(code)) return null;
  return `${code}.${sign(code, secret)}`;
}

function readReferralCookieValue(value, secret) {
  if (!value) return null;
  const idx = value.lastIndexOf('.');
  if (idx <= 0) return null;
  const code = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  if (!isValidReferralCodeShape(code)) return null;
  if (sign(code, secret) !== sig) return null;
  return code;
}

// ──────────────────────────────────────────────
// Pack pricing
// ──────────────────────────────────────────────

test('credit-packs: cada pack tiene total = shipments * pricePerShipment', () => {
  for (const pack of Object.values(CREDIT_PACKS)) {
    assert.equal(
      pack.shipments * pack.pricePerShipmentUyu,
      pack.totalPriceUyu,
      `Pack ${pack.id}: ${pack.shipments} × ${pack.pricePerShipmentUyu} debería ser ${pack.totalPriceUyu}, no ${pack.shipments * pack.pricePerShipmentUyu}`,
    );
  }
});

test('credit-packs: precios decrecientes con tamaño (regla de negocio)', () => {
  const sorted = Object.values(CREDIT_PACKS).sort((a, b) => a.shipments - b.shipments);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].pricePerShipmentUyu <= sorted[i - 1].pricePerShipmentUyu,
      `Pack ${sorted[i].id} (${sorted[i].pricePerShipmentUyu}) debería ser ≤ ${sorted[i - 1].id} (${sorted[i - 1].pricePerShipmentUyu})`,
    );
  }
});

test('credit-packs: existen los 6 packs documentados', () => {
  const ids = Object.keys(CREDIT_PACKS).sort();
  assert.deepEqual(ids, ['pack_10', 'pack_100', 'pack_1000', 'pack_250', 'pack_50', 'pack_500']);
});

// ──────────────────────────────────────────────
// Referral kickback
// ──────────────────────────────────────────────

test('referral kickback: 20% floor para cada pack', () => {
  assert.equal(calcReferralKickback(10),   2);   // floor(2)
  assert.equal(calcReferralKickback(50),   10);  // floor(10)
  assert.equal(calcReferralKickback(100),  20);  // floor(20)
  assert.equal(calcReferralKickback(250),  50);  // floor(50)
  assert.equal(calcReferralKickback(500),  100); // floor(100)
  assert.equal(calcReferralKickback(1000), 200); // floor(200)
});

test('referral kickback: rechaza inputs inválidos', () => {
  assert.equal(calcReferralKickback(0), 0);
  assert.equal(calcReferralKickback(-5), 0);
  assert.equal(calcReferralKickback(NaN), 0);
  assert.equal(calcReferralKickback(Infinity), 0);
});

test('referral kickback: floor() para no fraccionar (defensa)', () => {
  // Si alguien crea un pack custom de 7 envíos: 0.2 * 7 = 1.4 → 1
  assert.equal(calcReferralKickback(7), 1);
  assert.equal(calcReferralKickback(11), 2); // 0.2 * 11 = 2.2 → 2
});

// ──────────────────────────────────────────────
// Cookie firmada de referido
// ──────────────────────────────────────────────

test('referral cookie: round-trip preserva el código', () => {
  const secret = 'test-secret-123';
  const code = 'JK7-A4F2';
  const cookie = buildReferralCookieValue(code, secret);
  assert.ok(cookie);
  assert.equal(readReferralCookieValue(cookie, secret), code);
});

test('referral cookie: rechaza firma inválida (tampering)', () => {
  const secret = 'test-secret-123';
  const code = 'JK7-A4F2';
  const cookie = buildReferralCookieValue(code, secret);
  // Tamper la firma
  const tampered = cookie.slice(0, -1) + 'X';
  assert.equal(readReferralCookieValue(tampered, secret), null);
});

test('referral cookie: rechaza secreto distinto (rotación)', () => {
  const cookie = buildReferralCookieValue('JK7-A4F2', 'secret-A');
  assert.equal(readReferralCookieValue(cookie, 'secret-B'), null);
});

test('referral cookie: rechaza códigos malformados', () => {
  assert.equal(buildReferralCookieValue('lowercase-bad', 'secret'), null);
  assert.equal(buildReferralCookieValue('123', 'secret'), null);
  assert.equal(buildReferralCookieValue('', 'secret'), null);
  assert.equal(buildReferralCookieValue(null, 'secret'), null);
});

test('referral cookie: rechaza valores vacíos o sin firma', () => {
  assert.equal(readReferralCookieValue(null, 'secret'), null);
  assert.equal(readReferralCookieValue('', 'secret'), null);
  assert.equal(readReferralCookieValue('JK7-A4F2', 'secret'), null); // sin .firma
});

// ──────────────────────────────────────────────
// Validación de forma del referral code
// ──────────────────────────────────────────────

test('referral code shape: acepta códigos canónicos', () => {
  assert.ok(isValidReferralCodeShape('JK7-A4F2'));
  assert.ok(isValidReferralCodeShape('AB-1234'));
  assert.ok(isValidReferralCodeShape('LUCHO-DEAD'));
});

test('referral code shape: rechaza inválidos', () => {
  assert.equal(isValidReferralCodeShape(''), false);
  assert.equal(isValidReferralCodeShape(null), false);
  assert.equal(isValidReferralCodeShape('jk7-a4f2'), false); // minúsculas
  assert.equal(isValidReferralCodeShape('JK7'), false);     // sin guion
  assert.equal(isValidReferralCodeShape('JK7-'), false);    // sufijo vacío
  assert.equal(isValidReferralCodeShape('-A4F2'), false);   // prefijo vacío
  assert.equal(isValidReferralCodeShape('JK7@A4F2'), false); // no alfanumérico
});
