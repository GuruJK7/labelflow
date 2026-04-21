/**
 * Unit tests for the MVD street-range → barrio lookup.
 *
 * Every fixture id mentioned in `mvd-street-ranges.ts` MUST have a test case
 * here. If you add a new range, add the matching test first (TDD style).
 * If a range is removed, remove its test too — dangling tests hide regressions.
 */

import { describe, it, expect } from 'vitest';
import {
  mvdBarrioFromStreet,
  parseMvdAddress,
} from '../mvd-street-ranges';
import { VALID_MVD_BARRIOS } from '../ai-resolver';

// ─── parseMvdAddress ────────────────────────────────────────────────────

describe('parseMvdAddress — address prefix stripping + number extraction', () => {
  it('strips "Av."', () => {
    expect(parseMvdAddress('Av. Italia 4500')).toEqual({
      street: 'italia',
      number: 4500,
    });
  });

  it('strips "Avenida"', () => {
    expect(parseMvdAddress('Avenida Brasil 2500')).toEqual({
      street: 'brasil',
      number: 2500,
    });
  });

  it('strips "Bulevar"', () => {
    expect(parseMvdAddress('Bulevar Artigas 1300')).toEqual({
      street: 'artigas',
      number: 1300,
    });
  });

  it('strips "General"', () => {
    expect(parseMvdAddress('General Flores 2400')).toEqual({
      street: 'flores',
      number: 2400,
    });
  });

  it('strips "Rambla"', () => {
    expect(parseMvdAddress('Rambla Tomás Berreta 8000')).toEqual({
      street: 'tomas berreta',
      number: 8000,
    });
  });

  it('handles accents (normalization)', () => {
    expect(parseMvdAddress('Carlos María Ramírez 1500')).toEqual({
      street: 'carlos maria ramirez',
      number: 1500,
    });
  });

  it('handles "Av. de las Instrucciones"', () => {
    expect(parseMvdAddress('Av. de las Instrucciones 1500')).toEqual({
      street: 'de las instrucciones',
      number: 1500,
    });
  });

  it('keeps honorifics like "Don" (not stripped)', () => {
    expect(parseMvdAddress('Don Pedro de Mendoza 900')).toEqual({
      street: 'don pedro de mendoza',
      number: 900,
    });
  });

  it('returns null when no number present', () => {
    expect(parseMvdAddress('Av. Italia s/n')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parseMvdAddress('')).toBeNull();
    expect(parseMvdAddress(null)).toBeNull();
    expect(parseMvdAddress(undefined)).toBeNull();
  });

  it('strips trailing apartment noise ("esq.", "apto", etc.)', () => {
    expect(parseMvdAddress('Av. Italia 4500 esq. Av. Propios')?.street).toBe(
      'italia',
    );
    expect(parseMvdAddress('Colonia 1200 apto 5')?.street).toBe('colonia');
  });
});

// ─── mvdBarrioFromStreet — covers every fixture mentioned in the table ─

describe('mvdBarrioFromStreet — fixture-backed cases', () => {
  // Every test case here cites the fixture id. If any case fails, grep the
  // table for the fixture id to find the offending range.

  it.each([
    // Fixture ID, address1, expected barrio
    ['A01', 'Av. Brasil 2500',              'pocitos'],
    ['A02', 'Ellauri 1000',                 'punta carretas'],
    ['A03', 'Av. 18 de Julio 2000',         'cordon'],
    ['A04', 'Colonia 1200',                 'centro'],
    ['A05', 'Sarandí 700',                  'ciudad vieja'],
    ['A06', 'Arocena 1500',                 'carrasco'],
    ['A07', 'Av. Bolivia 1200',             'buceo'],
    ['A08', 'Av. Italia 4500',              'malvin'],
    ['A09', 'Av. Italia 2700',              'parque batlle'],
    ['A10', 'Bulevar Artigas 1300',         'parque rodo'],
    ['A11', 'Av. Agraciada 3900',           'prado'],
    ['A12', 'Av. Agraciada 2000',           'aguada'],
    ['A13', '8 de Octubre 3500',            'la blanqueada'],
    ['A14', 'Bulevar Artigas 1575',         'tres cruces'],
    ['A15', '8 de Octubre 4200',            'union'],
    ['A16', 'Carlos María Ramírez 1500',    'la teja'],
    ['A17', 'Av. de las Instrucciones 1500','peñarol'],
    ['A18', 'Av. Millán 4200',              'sayago'],
    ['A19', 'Gonzalo Ramírez 1400',         'palermo'],
    ['A20', 'General Flores 2400',          'goes'],
    ['E104','18 de Julio 1400',             'cordon'],
    ['E201','Av. Don Pedro de Mendoza 900', 'carrasco norte'],
    ['E204','Comodoro Coe 2100',            'pocitos'],
    ['F01', 'Guayaquí 2800',                'pocitos'],
    ['F04', 'Av. Italia 4500',              'malvin'],
    ['F08', 'Colonia 1200',                 'centro'],
    ['H04', 'Rambla Tomás Berreta 8000',    'carrasco'],
    ['I07', 'Rambla R. Fernández 12500',    'carrasco'],
  ])('%s: "%s" → %s', (_id, addr, expected) => {
    const r = mvdBarrioFromStreet(addr);
    expect(r, `${_id}: "${addr}" should match`).not.toBeNull();
    expect(r!.barrio).toBe(expected);
    // Every returned barrio MUST be a DAC canonical barrio name.
    expect(VALID_MVD_BARRIOS).toContain(expected);
  });
});

describe('mvdBarrioFromStreet — returns null on unknowns', () => {
  it('unknown street name → null', () => {
    expect(mvdBarrioFromStreet('Calle Inventada 1234')).toBeNull();
  });

  it('known street but number outside all ranges → null', () => {
    // Av. Brasil only encoded up to 3999; 99999 falls outside
    expect(mvdBarrioFromStreet('Av. Brasil 99999')).toBeNull();
  });

  it('empty / malformed input → null', () => {
    expect(mvdBarrioFromStreet('')).toBeNull();
    expect(mvdBarrioFromStreet(null)).toBeNull();
    expect(mvdBarrioFromStreet(undefined)).toBeNull();
    expect(mvdBarrioFromStreet('random text')).toBeNull();
  });
});

describe('mvdBarrioFromStreet — range boundary behavior', () => {
  it('boundaries are inclusive on both ends', () => {
    // 8 de Octubre 4000 is the first number in the "unión" range (4000–4999)
    expect(mvdBarrioFromStreet('8 de Octubre 4000')?.barrio).toBe('union');
    expect(mvdBarrioFromStreet('8 de Octubre 3999')?.barrio).toBe(
      'la blanqueada',
    );
    expect(mvdBarrioFromStreet('8 de Octubre 4999')?.barrio).toBe('union');
    expect(mvdBarrioFromStreet('8 de Octubre 5000')?.barrio).toBe(
      'villa española',
    );
  });

  it('Av. Italia spans parque batlle → malvin → punta gorda → carrasco', () => {
    expect(mvdBarrioFromStreet('Av. Italia 3000')?.barrio).toBe('parque batlle');
    expect(mvdBarrioFromStreet('Av. Italia 4500')?.barrio).toBe('malvin');
    expect(mvdBarrioFromStreet('Av. Italia 6000')?.barrio).toBe('punta gorda');
    expect(mvdBarrioFromStreet('Av. Italia 8500')?.barrio).toBe('carrasco');
  });

  it('Bulevar Artigas: Parque Rodó → Tres Cruces → La Blanqueada', () => {
    expect(mvdBarrioFromStreet('Bulevar Artigas 1000')?.barrio).toBe(
      'parque rodo',
    );
    expect(mvdBarrioFromStreet('Bulevar Artigas 1400')?.barrio).toBe(
      'tres cruces',
    );
    expect(mvdBarrioFromStreet('Bulevar Artigas 1800')?.barrio).toBe(
      'la blanqueada',
    );
  });
});

// ─── Fase 2B extensions (no fixture ID, but must have test coverage) ───
//
// The +20 streets added in Fase 2B are NOT exercised by any fixture in
// resolver-fixtures.json. Without these unit tests, a regression in any
// one of the ranges below would silently pass CI. One probe per range is
// enough — boundary behavior is already covered by the existing
// "range boundary behavior" block.

describe('mvdBarrioFromStreet — Fase 2B extensions', () => {
  it.each([
    // Luis A. de Herrera — three segments
    ['Av. Luis A. de Herrera 1500',  'parque batlle'],
    ['Av. Luis A. de Herrera 2000',  'tres cruces'],
    ['Av. Luis A. de Herrera 3500',  'la blanqueada'],
    // alias "de Herrera" (same ranges)
    ['Av. de Herrera 2000',          'tres cruces'],

    // Constituyente — S through Cordón → Parque Rodó → Pocitos
    ['Constituyente 1000',           'cordon'],
    ['Constituyente 2000',           'parque rodo'],
    ['Constituyente 3000',           'pocitos'],

    // Fernández Crespo — Reducto → Goes → La Blanqueada
    ['Daniel Fernández Crespo 1000', 'reducto'],
    ['Daniel Fernández Crespo 2000', 'goes'],
    ['Daniel Fernández Crespo 3500', 'la blanqueada'],

    // Batlle y Ordóñez — Goes → Unión → Flor de Maroñas
    ['Bvar. Batlle y Ordóñez 1500',  'goes'],
    ['Bvar. Batlle y Ordóñez 3000',  'union'],
    ['Bvar. Batlle y Ordóñez 5000',  'flor de maronas'],

    // San Martín — Goes → Unión (distinct from K05 which uses plain "san martin")
    ['Av. San Martín 1500',          'goes'],
    ['Av. San Martín 3000',          'union'],

    // Camino Maldonado (+ "maldonado" alias)
    ['Camino Maldonado 2000',        'union'],
    ['Camino Maldonado 4000',        'maronas'],
    ['Camino Maldonado 7000',        'manga'],

    // Camino Carrasco — Punta Gorda → Carrasco → Carrasco Norte
    ['Camino Carrasco 1500',         'punta gorda'],
    ['Camino Carrasco 4000',         'carrasco'],
    ['Camino Carrasco 7000',         'carrasco norte'],

    // España (Bvar.) — Parque Rodó → Pocitos → Punta Carretas
    ['Bvar. España 1000',            'parque rodo'],
    ['Bvar. España 2500',            'pocitos'],
    ['Bvar. España 4000',            'punta carretas'],

    // 21 de Setiembre (+ septiembre spelling)
    ['21 de Setiembre 1500',         'pocitos'],
    ['21 de Setiembre 3000',         'punta carretas'],
    ['21 de Septiembre 3000',        'punta carretas'],

    // Gestido
    ['Gestido 1500',                 'pocitos'],
    ['Gestido 3000',                 'punta carretas'],

    // Luis Piera
    ['Dr. Luis Piera 1000',          'parque rodo'],
    ['Dr. Luis Piera 2500',          'palermo'],

    // Libertador
    ['Av. Libertador 1000',          'parque batlle'],
    ['Av. Libertador 3000',          'tres cruces'],

    // Downtown grid streets
    ['Canelones 500',                'ciudad vieja'],
    ['Canelones 1500',               'centro'],
    ['Canelones 2500',               'cordon'],
    ['Mercedes 1000',                'centro'],
    ['Mercedes 2000',                'cordon'],
    ['Mercedes 3000',                'parque rodo'],
    ['San José 500',                 'ciudad vieja'],
    ['San José 1500',                'centro'],
    ['Paraguay 500',                 'ciudad vieja'],
    ['Paraguay 1500',                'centro'],
    ['Paraguay 2500',                'aguada'],
    ['Río Negro 500',                'ciudad vieja'],
    ['Río Negro 1500',               'centro'],
    ['Río Branco 500',               'ciudad vieja'],
    ['Río Branco 1500',              'centro'],
    ['Ejido 1000',                   'centro'],
    ['Ejido 2000',                   'cordon'],

    // Cubo del Norte
    ['Cubo del Norte 1000',          'aguada'],
    ['Cubo del Norte 3000',          'reducto'],

    // Colorado — Goes → La Comercial → La Figurita
    ['Colorado 500',                 'goes'],
    ['Colorado 1500',                'la comercial'],
    ['Colorado 2500',                'la figurita'],

    // Centenario — Aires Puros → Casavalle
    ['Cno. Centenario 1500',         'aires puros'],
    ['Cno. Centenario 3000',         'casavalle'],
  ])('"%s" → %s', (addr, expected) => {
    const r = mvdBarrioFromStreet(addr);
    expect(r, `"${addr}" should match`).not.toBeNull();
    expect(r!.barrio).toBe(expected);
    expect(VALID_MVD_BARRIOS).toContain(expected);
  });
});

// ─── Rambla O'Higgins split (GAP 2 — supports F03) ────────────────────

describe('mvdBarrioFromStreet — Rambla O\'Higgins split', () => {
  it('western stretch (<14000) → punta gorda', () => {
    expect(mvdBarrioFromStreet("Rambla O'Higgins 10000")?.barrio).toBe(
      'punta gorda',
    );
    expect(mvdBarrioFromStreet("Rambla O'Higgins 13999")?.barrio).toBe(
      'punta gorda',
    );
  });

  it('eastern stretch (14000+) → carrasco (F03 contract)', () => {
    expect(mvdBarrioFromStreet("Rambla O'Higgins 14000")?.barrio).toBe(
      'carrasco',
    );
    expect(mvdBarrioFromStreet("Rambla O'Higgins 14500")?.barrio).toBe(
      'carrasco',
    );
    expect(mvdBarrioFromStreet("Rambla O'Higgins 19000")?.barrio).toBe(
      'carrasco',
    );
  });

  it('apostrophe-free spelling also works (normalized to "o higgins")', () => {
    expect(mvdBarrioFromStreet('Rambla OHiggins 14500')?.barrio).toBe(
      'carrasco',
    );
  });
});
