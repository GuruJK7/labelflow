/**
 * Tests de lib/departamentos.ts — la copia web de normalizarDepartamento() y el
 * discriminador de reparto propio.
 *
 * Correr:  npx vitest run --root apps/web
 *
 * Los casos de normalización son deliberadamente los MISMOS que los del worker
 * (apps/worker/src/__tests__/self-delivery-zone.test.ts): estos dos archivos
 * son una copia y la única defensa contra que diverjan en silencio es que los
 * dos suites cubran la misma tabla de entradas.
 *
 * Lo que tiene que quedar clavado:
 *   - la suciedad real de prod ("Paysandú", "Maldonado Department", vacíos,
 *     "Valencia") normaliza a lo que esperamos o a null, nunca a otro
 *     departamento,
 *   - el discriminador es UNIÓN: "LF-" solo alcanza, Maldonado solo alcanza.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizarDepartamento,
  esRepartoPropio,
  DEPARTAMENTOS_REPARTO_PROPIO,
} from '../departamentos';

describe('normalizarDepartamento', () => {
  it('devuelve la grafía canónica tal cual cuando ya viene canónica', () => {
    expect(normalizarDepartamento('Maldonado')).toBe('Maldonado');
    expect(normalizarDepartamento('Montevideo')).toBe('Montevideo');
    expect(normalizarDepartamento('Treinta y Tres')).toBe('Treinta y Tres');
  });

  it('saca tildes (el caso Paysandú/Paysandu que convive en prod)', () => {
    expect(normalizarDepartamento('Paysandú')).toBe('Paysandu');
    expect(normalizarDepartamento('Paysandu')).toBe('Paysandu');
    expect(normalizarDepartamento('Río Negro')).toBe('Rio Negro');
    expect(normalizarDepartamento('San José')).toBe('San Jose');
    expect(normalizarDepartamento('Tacuarembó')).toBe('Tacuarembo');
  });

  it('ignora mayúsculas y espacios de más', () => {
    expect(normalizarDepartamento('  MALDONADO  ')).toBe('Maldonado');
    expect(normalizarDepartamento('maldonado')).toBe('Maldonado');
    expect(normalizarDepartamento('CeRrO   LaRgO')).toBe('Cerro Largo');
  });

  it('tolera el sufijo "Department" que manda Shopify en inglés', () => {
    expect(normalizarDepartamento('Maldonado Department')).toBe('Maldonado');
    expect(normalizarDepartamento('Canelones Department')).toBe('Canelones');
  });

  it('tolera "Depto.", "Dpto" y "Departamento de"', () => {
    expect(normalizarDepartamento('Depto. Maldonado')).toBe('Maldonado');
    expect(normalizarDepartamento('Dpto Maldonado')).toBe('Maldonado');
    expect(normalizarDepartamento('Departamento de Maldonado')).toBe('Maldonado');
  });

  it('devuelve null para vacío, null, undefined y basura', () => {
    expect(normalizarDepartamento('')).toBeNull();
    expect(normalizarDepartamento('   ')).toBeNull();
    expect(normalizarDepartamento(null)).toBeNull();
    expect(normalizarDepartamento(undefined)).toBeNull();
    // "Valencia" existe de verdad en una fila de prod: no es un departamento
    // uruguayo y NO puede caer en ninguno por parecido.
    expect(normalizarDepartamento('Valencia')).toBeNull();
    expect(normalizarDepartamento('Buenos Aires')).toBeNull();
  });

  it('no hace match parcial: un texto que CONTIENE un departamento no cuenta', () => {
    expect(normalizarDepartamento('Punta del Este, Maldonado')).toBeNull();
    expect(normalizarDepartamento('Maldonado Shopping')).toBeNull();
  });
});

describe('esRepartoPropio', () => {
  it('es true por departamento, con la grafía que venga', () => {
    expect(esRepartoPropio({ dacGuia: 'AB123', department: 'Maldonado' })).toBe(true);
    expect(esRepartoPropio({ dacGuia: 'AB123', department: 'maldonado' })).toBe(true);
    expect(esRepartoPropio({ dacGuia: 'AB123', department: 'Maldonado Department' })).toBe(true);
  });

  it('es true por guía LF- aunque el departamento sea otro (unión, no intersección)', () => {
    expect(esRepartoPropio({ dacGuia: 'LF-000123', department: 'Rocha' })).toBe(true);
    expect(esRepartoPropio({ dacGuia: 'lf-000123', department: 'Rocha' })).toBe(true);
    expect(esRepartoPropio({ dacGuia: '  LF-9  ', department: null })).toBe(true);
  });

  it('es false para el resto del país', () => {
    expect(esRepartoPropio({ dacGuia: 'AB123', department: 'Montevideo' })).toBe(false);
    expect(esRepartoPropio({ dacGuia: 'AB123', department: 'Canelones' })).toBe(false);
    expect(esRepartoPropio({ dacGuia: 'AB123', department: 'Rocha' })).toBe(false);
  });

  it('es false (no rompe) cuando el departamento está vacío o no se reconoce', () => {
    expect(esRepartoPropio({ dacGuia: 'AB123', department: '' })).toBe(false);
    expect(esRepartoPropio({ dacGuia: null, department: null })).toBe(false);
    expect(esRepartoPropio({})).toBe(false);
    expect(esRepartoPropio({ dacGuia: 'AB123', department: 'Valencia' })).toBe(false);
  });

  it('una guía DAC que casualmente empieza con otra cosa no dispara el prefijo', () => {
    expect(esRepartoPropio({ dacGuia: 'LFX-1', department: 'Rocha' })).toBe(false);
    expect(esRepartoPropio({ dacGuia: 'ALF-1', department: 'Rocha' })).toBe(false);
  });

  it('acepta una lista de departamentos propios distinta al default', () => {
    expect(esRepartoPropio({ department: 'Rocha' }, ['Rocha', 'Maldonado'])).toBe(true);
    expect(esRepartoPropio({ department: 'Maldonado' }, ['Rocha'])).toBe(false);
    // La lista pasada también se normaliza.
    expect(esRepartoPropio({ department: 'San José' }, ['san jose'])).toBe(true);
    // Lista vacía = nada es reparto propio salvo la guía LF-.
    expect(esRepartoPropio({ department: 'Maldonado' }, [])).toBe(false);
    expect(esRepartoPropio({ dacGuia: 'LF-1', department: 'Maldonado' }, [])).toBe(true);
  });

  it('el default es exactamente Maldonado', () => {
    expect(DEPARTAMENTOS_REPARTO_PROPIO).toEqual(['Maldonado']);
  });
});
