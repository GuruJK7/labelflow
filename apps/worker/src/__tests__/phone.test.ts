import { describe, it, expect } from 'vitest';
import { resolveOrderPhone } from '../shopify/phone';
import type { ShopifyOrder } from '../shopify/types';

/**
 * Audit 2026-05-12 — contact-phone enrichment.
 *
 * The DAC label used to read ONLY shipping_address.phone, so any order whose
 * phone lived in a different Shopify field reached the courier with the
 * 099000000 placeholder. resolveOrderPhone() walks every known location so
 * the courier almost always has a real number to call.
 */

type PhoneInput = Pick<
  ShopifyOrder,
  'phone' | 'shipping_address' | 'billing_address' | 'customer'
>;

// Minimal shipping_address with only the fields resolveOrderPhone reads.
function shipping(phone: string | null): ShopifyOrder['shipping_address'] {
  return {
    first_name: 'Test',
    last_name: 'Cliente',
    phone: phone ?? '',
    address1: 'Calle 1234',
    address2: '',
    city: 'Montevideo',
    province: 'Montevideo',
    zip: '11000',
    country: 'UY',
  };
}

describe('resolveOrderPhone', () => {
  describe('priority order (shipping → billing → customer → order → saved)', () => {
    it('returns shipping_address.phone when present', () => {
      const order: PhoneInput = {
        phone: '099111111',
        shipping_address: shipping('099222222'),
        billing_address: { phone: '099333333' },
        customer: { phone: '099444444' },
      };
      expect(resolveOrderPhone(order)).toBe('099222222');
    });

    it('falls back to billing_address.phone when shipping is empty', () => {
      const order: PhoneInput = {
        phone: '099111111',
        shipping_address: shipping(''),
        billing_address: { phone: '099333333' },
        customer: { phone: '099444444' },
      };
      expect(resolveOrderPhone(order)).toBe('099333333');
    });

    it('falls back to customer.phone when shipping+billing empty', () => {
      const order: PhoneInput = {
        phone: '099111111',
        shipping_address: shipping(''),
        billing_address: { phone: '' },
        customer: { phone: '099444444' },
      };
      expect(resolveOrderPhone(order)).toBe('099444444');
    });

    it('falls back to top-level order.phone when shipping+billing+customer empty', () => {
      const order: PhoneInput = {
        phone: '099111111',
        shipping_address: shipping(''),
        billing_address: { phone: null },
        customer: { phone: null },
      };
      expect(resolveOrderPhone(order)).toBe('099111111');
    });

    it('falls back to customer.default_address.phone as last resort', () => {
      const order: PhoneInput = {
        phone: null,
        shipping_address: shipping(''),
        billing_address: { phone: null },
        customer: { phone: null, default_address: { phone: '099555555' } },
      };
      expect(resolveOrderPhone(order)).toBe('099555555');
    });
  });

  describe('skips junk values (< 6 digits) and keeps walking', () => {
    it('skips a too-short shipping phone and uses billing', () => {
      const order: PhoneInput = {
        phone: null,
        shipping_address: shipping('123'),
        billing_address: { phone: '099333333' },
      };
      expect(resolveOrderPhone(order)).toBe('099333333');
    });

    it('skips non-numeric junk like "n/a" or "-"', () => {
      const order: PhoneInput = {
        phone: '099111111',
        shipping_address: shipping('n/a'),
        billing_address: { phone: '-' },
      };
      expect(resolveOrderPhone(order)).toBe('099111111');
    });

    it('skips whitespace-only phone fields', () => {
      const order: PhoneInput = {
        phone: '099111111',
        shipping_address: shipping('   '),
      };
      expect(resolveOrderPhone(order)).toBe('099111111');
    });
  });

  describe('formatting preserved (cleanPhone handles digit-stripping later)', () => {
    it('keeps an international-formatted number, trimmed', () => {
      const order: PhoneInput = {
        phone: null,
        shipping_address: shipping('+598 99 837 343'),
      };
      expect(resolveOrderPhone(order)).toBe('+598 99 837 343');
    });

    it('trims surrounding whitespace', () => {
      const order: PhoneInput = {
        phone: null,
        shipping_address: shipping('  099222222  '),
      };
      expect(resolveOrderPhone(order)).toBe('099222222');
    });
  });

  describe('returns undefined when no usable number exists', () => {
    it('all fields empty/null → undefined (caller uses placeholder)', () => {
      const order: PhoneInput = {
        phone: null,
        shipping_address: shipping(''),
        billing_address: { phone: null },
        customer: { phone: null, default_address: { phone: null } },
      };
      expect(resolveOrderPhone(order)).toBeUndefined();
    });

    it('null shipping_address is safe', () => {
      const order: PhoneInput = {
        phone: null,
        shipping_address: null,
        billing_address: null,
        customer: null,
      };
      expect(resolveOrderPhone(order)).toBeUndefined();
    });

    it('completely bare order object is safe', () => {
      const order: PhoneInput = {
        phone: undefined,
        shipping_address: null,
      };
      expect(resolveOrderPhone(order)).toBeUndefined();
    });
  });

  describe('production-shaped cases', () => {
    it('#5387-style: phoneless shipping, but customer has the buyer number → courier can call', () => {
      // The exact gap that left #5387 with the 099000000 placeholder: the
      // delivery address had no phone, but the order-placer's number lived on
      // the customer record. The DAC courier should call THAT number.
      const order: PhoneInput = {
        phone: null,
        shipping_address: shipping(''),
        billing_address: { phone: '' },
        customer: { first_name: 'Buyer', phone: '098 765 432' },
      };
      expect(resolveOrderPhone(order)).toBe('098 765 432');
    });

    it('normal order: every field populated, shipping wins (no behaviour change)', () => {
      const order: PhoneInput = {
        phone: '099000001',
        shipping_address: shipping('099000002'),
        billing_address: { phone: '099000003' },
        customer: { phone: '099000004' },
      };
      expect(resolveOrderPhone(order)).toBe('099000002');
    });
  });
});
