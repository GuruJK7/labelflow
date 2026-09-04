import { describe, it, expect } from 'vitest';
import {
  esMailValido,
  normalizarCelular,
  normalizarDepartamento,
  resolverLocalidad,
  resolverPesoKg,
  stripAccentsUpper,
  validarDestinatario,
} from '../correo/mapper';

describe('correo/mapper — normalizarDepartamento', () => {
  it('pasa a MAYÚSCULA sin tilde, que es lo único que AHIVA acepta', () => {
    expect(normalizarDepartamento('Montevideo')).toBe('MONTEVIDEO');
    expect(normalizarDepartamento('Paysandú')).toBe('PAYSANDU');
    expect(normalizarDepartamento('San José')).toBe('SAN JOSE');
    expect(normalizarDepartamento('Río Negro')).toBe('RIO NEGRO');
    expect(normalizarDepartamento('Tacuarembó')).toBe('TACUAREMBO');
  });

  it('cubre los 19 departamentos', () => {
    const todos = [
      'Artigas', 'Canelones', 'Cerro Largo', 'Colonia', 'Durazno', 'Flores',
      'Florida', 'Lavalleja', 'Maldonado', 'Montevideo', 'Paysandú',
      'Río Negro', 'Rivera', 'Rocha', 'Salto', 'San José', 'Soriano',
      'Tacuarembó', 'Treinta y Tres',
    ];
    for (const d of todos) {
      expect(normalizarDepartamento(d), `falló: ${d}`).not.toBeNull();
    }
  });

  it('tolera espacios de más y el sufijo Department de Shopify', () => {
    expect(normalizarDepartamento('  cerro   largo ')).toBe('CERRO LARGO');
    expect(normalizarDepartamento('Treinta y Tres Department')).toBe('TREINTA Y TRES');
  });

  it('devuelve null ante algo que no es un departamento uruguayo', () => {
    // Preferimos revisión manual a emitir una guía a un destino inventado.
    expect(normalizarDepartamento('Buenos Aires')).toBeNull();
    expect(normalizarDepartamento('')).toBeNull();
    expect(normalizarDepartamento(null)).toBeNull();
    expect(normalizarDepartamento(undefined)).toBeNull();
  });
});

describe('correo/mapper — normalizarCelular', () => {
  it('acepta las formas que llegan de Shopify y devuelve 9 dígitos', () => {
    expect(normalizarCelular('+598 99 123 456')).toBe('099123456');
    expect(normalizarCelular('59899123456')).toBe('099123456');
    expect(normalizarCelular('00598 99 123 456')).toBe('099123456');
    expect(normalizarCelular('099123456')).toBe('099123456');
    expect(normalizarCelular('99123456')).toBe('099123456');
    expect(normalizarCelular('(099) 123-456')).toBe('099123456');
  });

  it('rechaza fijos: Correo pide un celular para avisar la entrega', () => {
    expect(normalizarCelular('24018672')).toBeNull(); // fijo de Montevideo
    expect(normalizarCelular('024018672')).toBeNull(); // fijo con 0 → 9 dígitos pero no 09
    expect(normalizarCelular('43382345')).toBeNull(); // fijo del interior
  });

  it('rechaza basura y vacíos', () => {
    expect(normalizarCelular('')).toBeNull();
    expect(normalizarCelular(null)).toBeNull();
    expect(normalizarCelular(undefined)).toBeNull();
    expect(normalizarCelular('n/a')).toBeNull();
    expect(normalizarCelular('-')).toBeNull();
    expect(normalizarCelular('0991234567890')).toBeNull(); // largo
    expect(normalizarCelular('0991')).toBeNull(); // corto
  });
});

describe('correo/mapper — resolverPesoKg', () => {
  it('usa el peso real de Shopify cuando existe', () => {
    expect(resolverPesoKg(1500, 2)).toEqual({ pesoKg: 1.5 });
  });

  it('cae al default de la tienda cuando Shopify no trae peso', () => {
    // Es el caso NORMAL hoy: DAC nunca pidió peso, así que las tiendas
    // conectadas no lo tienen cargado.
    expect(resolverPesoKg(0, 0.5)).toEqual({ pesoKg: 0.5 });
    expect(resolverPesoKg(null, 1)).toEqual({ pesoKg: 1 });
    expect(resolverPesoKg(undefined, 1)).toEqual({ pesoKg: 1 });
  });

  it('sin peso ni default va a revisión en vez de inventar un número', () => {
    const r = resolverPesoKg(null, null);
    expect(r).toHaveProperty('error');
  });

  it('respeta el tope de 30 kg de Correo', () => {
    expect(resolverPesoKg(30_000, null)).toHaveProperty('error');
    expect(resolverPesoKg(35_000, null)).toHaveProperty('error');
    expect(resolverPesoKg(29_000, null)).toEqual({ pesoKg: 29 });
  });

  it('REGRESIÓN: 29.999 kg no puede colarse y salir redondeado a 30', () => {
    // El redondeo a 2 decimales ocurre ANTES de validar el tope; si se
    // valida primero, este caso pasa el filtro y se envía como 30 — el
    // valor exacto que AHIVA rechaza.
    const r = resolverPesoKg(29_999, null);
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('30');
  });

  it('redondea a 2 decimales', () => {
    expect(resolverPesoKg(1333, null)).toEqual({ pesoKg: 1.33 });
  });
});

describe('correo/mapper — resolverLocalidad', () => {
  it('en Montevideo la localidad es el BARRIO', () => {
    expect(resolverLocalidad('MONTEVIDEO', 'Montevideo', 'Pocitos')).toBe('Pocitos');
  });

  it('Montevideo sin barrio va a revisión (causa #1 de rechazo en DAC)', () => {
    expect(resolverLocalidad('MONTEVIDEO', 'Montevideo', null)).toBeNull();
    expect(resolverLocalidad('MONTEVIDEO', 'Montevideo', '  ')).toBeNull();
  });

  it('en el interior la localidad es la ciudad', () => {
    expect(resolverLocalidad('CANELONES', 'Las Piedras', null)).toBe('Las Piedras');
    expect(resolverLocalidad('MALDONADO', 'Punta del Este', 'ignorado')).toBe('Punta del Este');
  });

  it('interior sin ciudad devuelve null', () => {
    expect(resolverLocalidad('SALTO', '', null)).toBeNull();
  });
});

describe('correo/mapper — esMailValido', () => {
  it('acepta mails normales', () => {
    expect(esMailValido('juan@gmail.com')).toBe(true);
    expect(esMailValido('a.b+c@sub.dominio.uy')).toBe(true);
  });

  it('rechaza lo que AHIVA rechazaría', () => {
    expect(esMailValido('')).toBe(false);
    expect(esMailValido(null)).toBe(false);
    expect(esMailValido('sin-arroba')).toBe(false);
    expect(esMailValido('a@b')).toBe(false); // sin punto en el dominio
    expect(esMailValido('con espacio@x.com')).toBe(false);
    expect(esMailValido(`${'a'.repeat(250)}@x.com`)).toBe(false);
  });
});

describe('correo/mapper — validarDestinatario', () => {
  it('acepta un destinatario completo y normaliza el celular', () => {
    const r = validarDestinatario({
      nombre: '  Ana Pérez ',
      mail: 'ana@gmail.com',
      celular: '+598 99 123 456',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.nombre).toBe('Ana Pérez');
      expect(r.celular).toBe('099123456');
    }
  });

  it('da un motivo legible por un humano, no un fault opaco', () => {
    const sinCel = validarDestinatario({ nombre: 'Ana', mail: 'a@b.com', celular: '24018672' });
    expect(sinCel.ok).toBe(false);
    if (!sinCel.ok) expect(sinCel.motivo).toMatch(/celular/i);

    const sinMail = validarDestinatario({ nombre: 'Ana', mail: '', celular: '099123456' });
    expect(sinMail.ok).toBe(false);
    if (!sinMail.ok) expect(sinMail.motivo).toMatch(/email/i);

    const sinNombre = validarDestinatario({ nombre: '', mail: 'a@b.com', celular: '099123456' });
    expect(sinNombre.ok).toBe(false);
    if (!sinNombre.ok) expect(sinNombre.motivo).toMatch(/nombre/i);
  });
});

describe('correo/mapper — stripAccentsUpper', () => {
  it('saca diacríticos combinados', () => {
    expect(stripAccentsUpper('Paysandú')).toBe('PAYSANDU');
    expect(stripAccentsUpper('Ñandú')).toBe('ÑANDU'); // la eñe NO es un acento
  });
});
