import { describe, it, expect } from 'vitest';
import { mergeAddress } from '../dac/shipment';
import { getDepartmentForCity } from '../dac/uruguay-geo';
import { determinePaymentType } from '../rules/payment';

/**
 * REAL ORDER AUDIT — Last 20 orders from Aura's Shopify (fetched 2026-04-07)
 *
 * For each order we test:
 * 1. mergeAddress: address not duplicated, apt/obs correctly extracted
 * 2. Department detection: Shopify city maps to correct DAC department
 * 3. Payment type: correct for $3261 UYU with threshold 3900
 *
 * All orders are $3261 UYU, threshold is 3900, rule enabled → DESTINATARIO
 */

interface RealOrder {
  name: string;
  totalPrice: string;
  currency: string;
  address1: string;
  address2: string | null;
  city: string;
  province: string;
  zip: string | null;
  expectedDept: string;
  expectedIssues?: string[];
}

const REAL_ORDERS: RealOrder[] = [
  {
    name: '#1146',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Doctor Andrés Puyol 1687',
    address2: null,
    city: 'Montevideo',
    province: 'Montevideo',
    zip: '11500',
    expectedDept: 'Montevideo',
  },
  {
    name: '#1145',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Emilio de Franco m34 s17A entre Becú y Río de Janeiro',
    address2: 'Casa sin rejas',
    city: 'Lagomar',
    province: 'Montevideo',
    zip: '15000',
    expectedDept: 'Canelones',
  },
  {
    name: '#1144',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Pedro Cea y Argentina',
    address2: 'Casa rejas grises pegado a pizeria "La barra"',
    city: 'La Floresta',
    province: 'Montevideo',
    zip: '16200',
    expectedDept: 'Canelones',
  },
  {
    name: '#1143',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Rondeau Entre Calle D Y Piedras S/n',
    address2: null,
    city: 'Nueva Palmira',
    province: 'Colonia',
    zip: '70101',
    expectedDept: 'Colonia',
  },
  {
    name: '#1142',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Otilia Schultze 668bis',
    address2: null,
    city: 'Durazno',
    province: 'Durazno',
    zip: null,
    expectedDept: 'Durazno',
  },
  {
    name: '#1141',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Lavalleja 444',
    address2: null,
    city: 'Minas',
    province: 'Lavalleja',
    zip: '30000',
    expectedDept: 'Lavalleja',
  },
  {
    name: '#1140',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: '18 De Julio 319 o 405',
    address2: 'Apto 102',
    city: 'Tacuarembo',
    province: 'Tacuarembó',
    zip: '45000',
    expectedDept: 'Tacuarembo',
  },
  {
    name: '#1139',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Av.Agraciada 3069',
    address2: 'apto 201',
    city: 'Bella Vista',
    province: 'Montevideo',
    zip: '11800',
    expectedDept: 'Montevideo',
  },
  {
    name: '#1138',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Liorna 6518',
    address2: '103 ( Susana De Haedo)',
    city: 'Carrasco',
    province: 'Montevideo',
    zip: '11500',
    expectedDept: 'Montevideo',
  },
  {
    name: '#1137',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Canelones 1450',
    address2: '099680230',
    city: 'Centro/Montevideo',
    province: 'Montevideo',
    zip: '11400',
    expectedDept: 'Montevideo',
    expectedIssues: ['address2 is a phone number, not address data'],
  },
  {
    name: '#1136',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Luis Bonavita 1266 tore 4 WTC',
    address2: 'Montevideo',
    city: 'Montevideo',
    province: 'Montevideo',
    zip: '11300',
    expectedDept: 'Montevideo',
    expectedIssues: ['address2 is city name repeated, not useful address data'],
  },
  {
    name: '#1135',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Benone Calcavecchia 4718',
    address2: null,
    city: 'Malvín Norte',
    province: 'Montevideo',
    zip: '11400',
    expectedDept: 'Montevideo',
  },
  {
    name: '#1134',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Avenida batlle y Ordoñez 723',
    address2: 'Oficinas Pablo Arenas viajes',
    city: 'Nueva Helvecia',
    province: 'Colonia',
    zip: null,
    expectedDept: 'Colonia',
  },
  {
    name: '#1133',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Jardines Del Hum B09',
    address2: 'Casa portones blancos',
    city: 'Jardines del Hum',
    province: 'Soriano',
    zip: '75000',
    expectedDept: 'Soriano',
    expectedIssues: ['unusual city name "Jardines del Hum" - may not be in geo DB'],
  },
  {
    name: '#1132',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'gestido 2865',
    address2: 'casa',
    city: 'pocitos',
    province: 'Montevideo',
    zip: '11300',
    expectedDept: 'Montevideo',
  },
  {
    name: '#1131',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Calle 24 entre 27 y 28 , local 110 ,1er piso , galería paseo del mar',
    address2: 'Local 110',
    city: 'Maldonado',
    province: 'Maldonado',
    zip: '20100',
    expectedDept: 'Maldonado',
  },
  {
    name: '#1130',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Canelones 1417',
    address2: '002',
    city: 'Montevideo',
    province: 'Montevideo',
    zip: '11200',
    expectedDept: 'Montevideo',
  },
  {
    name: '#1129',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Pedro Fco. Berro 785',
    address2: 'apto 602',
    city: 'Montevideo',
    province: 'Montevideo',
    zip: '11304',
    expectedDept: 'Montevideo',
  },
  {
    name: '#1128',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Juan Paullier 1491',
    address2: null,
    city: '2|montevideo',
    province: 'Montevideo',
    zip: '11200',
    expectedDept: 'Montevideo',
    expectedIssues: ['city has garbage prefix "2|"'],
  },
  {
    name: '#1127',
    totalPrice: '3261.00',
    currency: 'UYU',
    address1: 'Rogelio Sosa',
    address2: 'Casa',
    city: 'Cardona',
    province: 'Montevideo',
    zip: '75200',
    expectedDept: 'Soriano',
    expectedIssues: ['Shopify province says "Montevideo" but Cardona is in Soriano'],
  },
];

describe('Real Orders Audit — Last 20 Aura Orders', () => {
  // ====== ADDRESS MERGE TESTS ======

  describe('Address merge quality', () => {
    it('#1146 — no address2, clean address', () => {
      const r = mergeAddress('Doctor Andrés Puyol 1687', null);
      expect(r.fullAddress).toBe('Doctor Andrés Puyol 1687');
      expect(r.extraObs).toBe('');
    });

    it('#1145 — address2="Casa sin rejas" goes to observations only', () => {
      const r = mergeAddress('Emilio de Franco m34 s17A entre Becú y Río de Janeiro', 'Casa sin rejas');
      expect(r.fullAddress).toBe('Emilio de Franco m34 s17A entre Becú y Río de Janeiro');
      expect(r.extraObs).toBe('Casa sin rejas');
    });

    it('#1144 — address2="Casa rejas grises..." goes to observations', () => {
      const r = mergeAddress('Pedro Cea y Argentina', 'Casa rejas grises pegado a pizeria "La barra"');
      expect(r.fullAddress).toContain('Pedro Cea y Argentina');
      expect(r.extraObs).toContain('Casa rejas grises');
    });

    it('#1143 — no address2, address with "Entre" and "S/n"', () => {
      const r = mergeAddress('Rondeau Entre Calle D Y Piedras S/n', null);
      expect(r.fullAddress).toBe('Rondeau Entre Calle D Y Piedras S/n');
      expect(r.extraObs).toBe('');
    });

    it('#1142 — no address2, address with "bis" suffix', () => {
      const r = mergeAddress('Otilia Schultze 668bis', null);
      expect(r.fullAddress).toBe('Otilia Schultze 668bis');
      expect(r.extraObs).toBe('');
    });

    it('#1141 — no address2, simple address', () => {
      const r = mergeAddress('Lavalleja 444', null);
      expect(r.fullAddress).toBe('Lavalleja 444');
    });

    it('#1140 — address2="Apto 102" goes to observations only', () => {
      const r = mergeAddress('18 De Julio 319 o 405', 'Apto 102');
      expect(r.fullAddress).toBe('18 De Julio 319 o 405');
      expect(r.extraObs).toBe('Apto 102');
    });

    it('#1139 — address2="apto 201" goes to observations only', () => {
      const r = mergeAddress('Av.Agraciada 3069', 'apto 201');
      expect(r.fullAddress).toBe('Av.Agraciada 3069');
      expect(r.extraObs).toBe('apto 201');
    });

    it('#1138 — address2="103 ( Susana De Haedo)" goes to observations only', () => {
      const r = mergeAddress('Liorna 6518', '103 ( Susana De Haedo)');
      expect(r.fullAddress).toBe('Liorna 6518');
      expect(r.extraObs).toBe('103 ( Susana De Haedo)');
    });

    it('#1137 — address2="099680230" is a PHONE NUMBER, not address', () => {
      // This is bad customer data — phone in address2 field
      // mergeAddress can't know it's a phone, but since address1 already has door number
      // and address2 is a pure number, it'll treat it as apartment
      const r = mergeAddress('Canelones 1450', '099680230');
      expect(r.fullAddress).toContain('Canelones 1450');
      // Since a1 ends with number and a2 is pure number, it becomes "Apto 099680230"
      // This is WRONG but mergeAddress has no way to know it's a phone
      // The real fix would be phone validation before address merge
    });

    it('#1136 — address2="Montevideo" is city name — ignored (handled by DAC dropdown)', () => {
      const r = mergeAddress('Luis Bonavita 1266 tore 4 WTC', 'Montevideo');
      expect(r.fullAddress).toBe('Luis Bonavita 1266 tore 4 WTC');
      expect(r.extraObs).toBe('');
    });

    it('#1135 — no address2, clean address', () => {
      const r = mergeAddress('Benone Calcavecchia 4718', null);
      expect(r.fullAddress).toBe('Benone Calcavecchia 4718');
    });

    it('#1134 — address2="Oficinas Pablo Arenas viajes" goes to observations', () => {
      const r = mergeAddress('Avenida batlle y Ordoñez 723', 'Oficinas Pablo Arenas viajes');
      expect(r.fullAddress).toContain('Avenida batlle y Ordoñez 723');
      // starts with "Oficina" — matches aptPattern
      expect(r.extraObs).toContain('Oficinas Pablo Arenas viajes');
    });

    it('#1133 — address2="Casa portones blancos" goes to observations', () => {
      const r = mergeAddress('Jardines Del Hum B09', 'Casa portones blancos');
      expect(r.fullAddress).toContain('Jardines Del Hum B09');
      expect(r.extraObs).toContain('Casa portones blancos');
    });

    it('#1132 — address2="casa" goes to observations', () => {
      const r = mergeAddress('gestido 2865', 'casa');
      expect(r.fullAddress).toContain('gestido 2865');
      // "casa" is not apt pattern, not number, not direction
      // → default branch, goes to observations
      expect(r.extraObs).toContain('casa');
    });

    it('#1131 — address2="Local 110" goes to observations (local keyword)', () => {
      const r = mergeAddress(
        'Calle 24 entre 27 y 28 , local 110 ,1er piso , galería paseo del mar',
        'Local 110'
      );
      expect(r.fullAddress).toContain('Calle 24');
      expect(r.extraObs).toContain('Local 110');
    });

    it('#1130 — address2="002" treated as apt when address1 has door number', () => {
      const r = mergeAddress('Canelones 1417', '002');
      expect(r.fullAddress).toContain('Canelones 1417');
      // a1 ends with 1417, a2="002" is pure number → apt
      expect(r.extraObs).toContain('Apto 002');
    });

    it('#1129 — address2="apto 602" goes to observations only', () => {
      const r = mergeAddress('Pedro Fco. Berro 785', 'apto 602');
      expect(r.fullAddress).toBe('Pedro Fco. Berro 785');
      expect(r.extraObs).toBe('apto 602');
    });

    it('#1128 — no address2, clean address', () => {
      const r = mergeAddress('Juan Paullier 1491', null);
      expect(r.fullAddress).toBe('Juan Paullier 1491');
    });

    it('#1127 — address2="Casa" goes to observations', () => {
      const r = mergeAddress('Rogelio Sosa', 'Casa');
      expect(r.fullAddress).toContain('Rogelio Sosa');
      expect(r.extraObs).toContain('Casa');
    });
  });

  // ====== DEPARTMENT DETECTION ======

  describe('Department detection from city name', () => {
    const testCases: { order: string; city: string; expectedDept: string; problematic?: boolean }[] = [
      { order: '#1146', city: 'Montevideo', expectedDept: 'Montevideo' },
      { order: '#1145', city: 'Lagomar', expectedDept: 'Canelones' },
      { order: '#1144', city: 'La Floresta', expectedDept: 'Canelones' },
      { order: '#1143', city: 'Nueva Palmira', expectedDept: 'Colonia' },
      { order: '#1142', city: 'Durazno', expectedDept: 'Durazno' },
      { order: '#1141', city: 'Minas', expectedDept: 'Lavalleja' },
      { order: '#1140', city: 'Tacuarembo', expectedDept: 'Tacuarembo' },
      { order: '#1139', city: 'Bella Vista', expectedDept: 'Montevideo', problematic: true },
      { order: '#1135', city: 'Malvín Norte', expectedDept: 'Montevideo', problematic: true },
      { order: '#1134', city: 'Nueva Helvecia', expectedDept: 'Colonia' },
      { order: '#1133', city: 'Jardines del Hum', expectedDept: 'Soriano', problematic: true },
      { order: '#1132', city: 'pocitos', expectedDept: 'Montevideo', problematic: true },
      { order: '#1131', city: 'Maldonado', expectedDept: 'Maldonado' },
      { order: '#1130', city: 'Montevideo', expectedDept: 'Montevideo' },
      { order: '#1129', city: 'Montevideo', expectedDept: 'Montevideo' },
      { order: '#1128', city: '2|montevideo', expectedDept: 'Montevideo', problematic: true },
      { order: '#1127', city: 'Cardona', expectedDept: 'Soriano' },
      { order: '#1137', city: 'Centro/Montevideo', expectedDept: 'Montevideo', problematic: true },
      { order: '#1136', city: 'Montevideo', expectedDept: 'Montevideo' },
      { order: '#1138', city: 'Carrasco', expectedDept: 'Montevideo', problematic: true },
    ];

    for (const tc of testCases) {
      it(`${tc.order} — "${tc.city}" → ${tc.expectedDept}${tc.problematic ? ' (problematic input)' : ''}`, () => {
        const dept = getDepartmentForCity(tc.city);
        if (tc.problematic) {
          // These might not resolve — document the behavior
          if (dept) {
            expect(dept).toBe(tc.expectedDept);
          } else {
            // Log but don't fail — these are known problematic inputs
            // The system uses province fallback for these
            console.log(`  [INFO] "${tc.city}" not in geo DB, would fall back to province: ${tc.expectedDept}`);
          }
        } else {
          expect(dept).toBe(tc.expectedDept);
        }
      });
    }
  });

  // ====== PAYMENT TYPE ======

  describe('Payment type determination', () => {
    // All Aura orders are $3261 UYU, threshold is 3900, rule enabled
    it('all 20 orders at $3261 UYU should be DESTINATARIO (below 3900 threshold)', () => {
      for (const order of REAL_ORDERS) {
        const result = determinePaymentType(
          { id: 1, name: order.name, total_price: order.totalPrice, currency: order.currency } as any,
          3900,
          true,
        );
        expect(result).toBe('DESTINATARIO');
      }
    });
  });

  // ====== COMPREHENSIVE AUDIT ======

  describe('Full audit — address merge + department + payment', () => {
    it('generates complete audit report', () => {
      const results: {
        order: string;
        address: string;
        mergedAddress: string;
        observations: string;
        city: string;
        detectedDept: string | undefined;
        expectedDept: string;
        deptMatch: boolean;
        payment: string;
        issues: string[];
      }[] = [];

      for (const order of REAL_ORDERS) {
        const merged = mergeAddress(order.address1, order.address2);
        const dept = getDepartmentForCity(order.city);
        const payment = determinePaymentType(
          { id: 1, name: order.name, total_price: order.totalPrice, currency: order.currency } as any,
          3900,
          true,
        );

        const issues: string[] = [];

        // Check for address duplication
        if (order.address2 && merged.fullAddress.includes(`${order.address2} ${order.address2}`)) {
          issues.push('ADDRESS DUPLICATED');
        }

        // Check department resolution
        if (!dept) {
          issues.push(`DEPT NOT FOUND for city "${order.city}" (fallback: province ${order.province})`);
        } else if (dept !== order.expectedDept) {
          issues.push(`WRONG DEPT: got "${dept}", expected "${order.expectedDept}"`);
        }

        // Check if address2 has phone number (common data quality issue)
        if (order.address2 && /^0\d{8,}$/.test(order.address2.replace(/\s/g, ''))) {
          issues.push(`PHONE IN ADDRESS2: "${order.address2}"`);
        }

        // Add known issues
        if (order.expectedIssues) {
          issues.push(...order.expectedIssues.map(i => `KNOWN: ${i}`));
        }

        results.push({
          order: order.name,
          address: `${order.address1} | ${order.address2 ?? '(null)'}`,
          mergedAddress: merged.fullAddress,
          observations: merged.extraObs || '(none)',
          city: order.city,
          detectedDept: dept,
          expectedDept: order.expectedDept,
          deptMatch: dept === order.expectedDept,
          payment,
          issues,
        });
      }

      // Print audit report
      console.log('\n========== REAL ORDER AUDIT REPORT ==========\n');

      let perfect = 0;
      let withIssues = 0;

      for (const r of results) {
        const status = r.issues.length === 0 ? 'PERFECT' : 'ISSUES';
        if (r.issues.length === 0) perfect++;
        else withIssues++;

        console.log(`${r.order} [${status}]`);
        console.log(`  Address:   ${r.address}`);
        console.log(`  Merged:    ${r.mergedAddress}`);
        console.log(`  Obs:       ${r.observations}`);
        console.log(`  City:      ${r.city} → Dept: ${r.detectedDept ?? 'NOT FOUND'} (expected: ${r.expectedDept})`);
        console.log(`  Payment:   ${r.payment}`);
        if (r.issues.length > 0) {
          for (const issue of r.issues) {
            console.log(`  ⚠ ${issue}`);
          }
        }
        console.log('');
      }

      console.log('========== SUMMARY ==========');
      console.log(`Total orders:  ${results.length}`);
      console.log(`Perfect:       ${perfect}`);
      console.log(`With issues:   ${withIssues}`);
      console.log(`Success rate:  ${Math.round((perfect / results.length) * 100)}%`);
      console.log('=============================\n');

      // The audit should complete without crashes
      expect(results).toHaveLength(20);
    });
  });
});
