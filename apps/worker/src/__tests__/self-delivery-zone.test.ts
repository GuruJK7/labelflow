import { describe, it, expect } from 'vitest';
import { normalizarDepartamento, evaluarZonaRepartoPropio } from '../self-delivery/zone';

const MALDONADO = ['Maldonado'];

/** Azucar: evaluar con las 3 senales explicitas. */
const evaluar = (
  province: string | null,
  deptPorCiudad: string | null,
  deptPorZip: string | null,
  deps = MALDONADO,
) => evaluarZonaRepartoPropio({ province }, deps, deptPorCiudad, deptPorZip);

describe('normalizarDepartamento', () => {
  it('acepta la grafia canonica', () => {
    expect(normalizarDepartamento('Maldonado')).toBe('Maldonado');
    expect(normalizarDepartamento('Montevideo')).toBe('Montevideo');
  });

  it('tolera mayusculas, espacios y tildes', () => {
    expect(normalizarDepartamento('  MALDONADO  ')).toBe('Maldonado');
    expect(normalizarDepartamento('maldonado')).toBe('Maldonado');
    expect(normalizarDepartamento('Paysandú')).toBe('Paysandu');
    expect(normalizarDepartamento('Río Negro')).toBe('Rio Negro');
    expect(normalizarDepartamento('San José')).toBe('San Jose');
    expect(normalizarDepartamento('Tacuarembó')).toBe('Tacuarembo');
  });

  it('tolera como lo manda Shopify y como lo escribe la gente', () => {
    expect(normalizarDepartamento('Maldonado Department')).toBe('Maldonado');
    expect(normalizarDepartamento('Departamento de Maldonado')).toBe('Maldonado');
    expect(normalizarDepartamento('Depto. Maldonado')).toBe('Maldonado');
    expect(normalizarDepartamento('dpto maldonado')).toBe('Maldonado');
  });

  it('devuelve null para lo que no es un departamento', () => {
    expect(normalizarDepartamento(null)).toBeNull();
    expect(normalizarDepartamento(undefined)).toBeNull();
    expect(normalizarDepartamento('')).toBeNull();
    expect(normalizarDepartamento('   ')).toBeNull();
    expect(normalizarDepartamento('Buenos Aires')).toBeNull();
    expect(normalizarDepartamento('Punta del Este')).toBeNull(); // es ciudad, no depto
  });
});

describe('evaluarZonaRepartoPropio — saca de DAC', () => {
  it('las tres senales coinciden en Maldonado', () => {
    const v = evaluar('Maldonado', 'Maldonado', 'Maldonado');
    expect(v.esRepartoPropio).toBe(true);
    expect(v.departamento).toBe('Maldonado');
  });

  it('Punta del Este resuelve a Maldonado por ciudad', () => {
    // getDepartmentForCity('Punta del Este') = 'Maldonado' en uruguay-geo
    const v = evaluar(null, 'Maldonado', null);
    expect(v.esRepartoPropio).toBe(true);
    expect(v.motivo).toContain('la ciudad');
  });

  it('solo el codigo postal 20xxx alcanza', () => {
    const v = evaluar(null, null, 'Maldonado');
    expect(v.esRepartoPropio).toBe(true);
    expect(v.motivo).toContain('código postal');
  });

  it('solo la provincia alcanza cuando no hay nada mas', () => {
    const v = evaluar('Maldonado', null, null);
    expect(v.esRepartoPropio).toBe(true);
    expect(v.motivo).toContain('provincia');
  });

  it('ciudad y CP coinciden aunque la provincia venga vacia', () => {
    const v = evaluar('', 'Maldonado', 'Maldonado');
    expect(v.esRepartoPropio).toBe(true);
  });
});

describe('evaluarZonaRepartoPropio — ante la duda, DAC', () => {
  it('destino claramente en otro departamento', () => {
    const v = evaluar('Montevideo', 'Montevideo', 'Montevideo');
    expect(v.esRepartoPropio).toBe(false);
  });

  it('SEÑALES CONTRADICTORIAS: la ciudad dice Maldonado pero el CP dice Rocha', () => {
    // Este es el caso que justifica todo el sesgo: si nos equivocamos hacia
    // "reparto propio", el paquete no sale nunca.
    const v = evaluar(null, 'Maldonado', 'Rocha');
    expect(v.esRepartoPropio).toBe(false);
    expect(v.motivo).toContain('contradictorias');
  });

  it('la provincia dice Maldonado pero la ciudad resuelve a Canelones', () => {
    const v = evaluar('Maldonado', 'Canelones', null);
    expect(v.esRepartoPropio).toBe(false);
    expect(v.motivo).toContain('contradictorias');
  });

  it('no se pudo determinar el departamento', () => {
    const v = evaluar(null, null, null);
    expect(v.esRepartoPropio).toBe(false);
    expect(v.departamento).toBeNull();
    expect(v.motivo).toContain('no se pudo determinar');
  });

  it('una provincia basura no habilita reparto propio', () => {
    const v = evaluar('asdf', null, null);
    expect(v.esRepartoPropio).toBe(false);
  });

  it('sin departamentos configurados nunca saca de DAC', () => {
    const v = evaluar('Maldonado', 'Maldonado', 'Maldonado', []);
    expect(v.esRepartoPropio).toBe(false);
    expect(v.motivo).toContain('no hay departamentos');
  });

  it('una lista de departamentos con basura se ignora, no rompe', () => {
    const v = evaluar('Maldonado', 'Maldonado', null, ['no-existe']);
    expect(v.esRepartoPropio).toBe(false);
  });
});

describe('evaluarZonaRepartoPropio — otros departamentos configurables', () => {
  it('funciona con un departamento distinto de Maldonado', () => {
    const v = evaluar('Rocha', 'Rocha', null, ['Rocha']);
    expect(v.esRepartoPropio).toBe(true);
    expect(v.departamento).toBe('Rocha');
  });

  it('acepta varios departamentos a la vez', () => {
    const deps = ['Maldonado', 'Rocha'];
    expect(evaluar('Rocha', 'Rocha', null, deps).esRepartoPropio).toBe(true);
    expect(evaluar('Maldonado', 'Maldonado', null, deps).esRepartoPropio).toBe(true);
    expect(evaluar('Montevideo', 'Montevideo', null, deps).esRepartoPropio).toBe(false);
  });

  it('la config tolera tildes y variantes', () => {
    const v = evaluar('San José', 'San Jose', null, ['san josé']);
    expect(v.esRepartoPropio).toBe(true);
  });

  it('siempre reporta las senales para que el log sea auditable', () => {
    const v = evaluar('Maldonado', 'Maldonado', 'Rocha');
    expect(v.senales).toEqual({ porCiudad: 'Maldonado', porZip: 'Rocha', porProvince: 'Maldonado' });
  });
});
