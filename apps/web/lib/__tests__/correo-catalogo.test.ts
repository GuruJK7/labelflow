import { describe, it, expect } from 'vitest';
import { normalizarNombreOficina, verificarOficina } from '../correo-catalogo';

/**
 * La razón de ser de este módulo es que la web NO acepte un nombre de oficina
 * que el worker después va a rechazar. Si las dos normalizaciones se separan,
 * el comerciante guarda algo que la pantalla da por bueno y que después manda
 * el 100% de sus envíos a revisión. Estos tests fijan esa equivalencia.
 *
 * Nombres reales del catálogo de producción (196 oficinas, verificado 04-09-2026).
 */
const CATALOGO = ['Ciudad Vieja', 'Aguada', 'Belvedere', 'Piriápolis', 'Pan de Azucar', 'Salto', 'Tacuarembo'];

describe('normalizarNombreOficina', () => {
  it('saca tildes, pasa a mayúscula y colapsa espacios', () => {
    expect(normalizarNombreOficina('Piriápolis')).toBe('PIRIAPOLIS');
    expect(normalizarNombreOficina('  ciudad   vieja ')).toBe('CIUDAD VIEJA');
  });
});

describe('verificarOficina', () => {
  it('acepta el nombre exacto y devuelve el canónico del catálogo', () => {
    expect(verificarOficina('Ciudad Vieja', CATALOGO)).toEqual({ ok: true, nombre: 'Ciudad Vieja' });
  });

  it('acepta con tilde y sin tilde, y devuelve SIEMPRE la grafía de Correo', () => {
    // AHIVA identifica la sucursal por el texto exacto: guardar "Piriapolis"
    // sin tilde haría que el worker no la encuentre.
    expect(verificarOficina('piriapolis', CATALOGO)).toEqual({ ok: true, nombre: 'Piriápolis' });
    expect(verificarOficina('PAN DE AZUCAR', CATALOGO)).toEqual({ ok: true, nombre: 'Pan de Azucar' });
  });

  it('rechaza un nombre que no existe y sugiere los parecidos', () => {
    const r = verificarOficina('Ciudad', CATALOGO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.sugerencias).toContain('Ciudad Vieja');
  });

  it('rechaza sin sugerencias cuando no se parece a nada', () => {
    const r = verificarOficina('Sucursal Inventada', CATALOGO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.sugerencias).toEqual([]);
  });
});

/**
 * La Ñ es el único punto donde esta normalización se aparta de la del worker.
 * Estos tests fijan la asimetría y, sobre todo, fijan la propiedad que la hace
 * segura: lo que sale es SIEMPRE el nombre canónico del catálogo.
 */
describe('la Ñ y el nombre canónico', () => {
  const CON_N = ['Bañado de Medina', 'Cañas', 'Salto'];

  it('acepta el nombre escrito sin ñ y devuelve la grafía de Correo', () => {
    expect(verificarOficina('Canas', CON_N)).toEqual({ ok: true, nombre: 'Cañas' });
    expect(verificarOficina('BANADO DE MEDINA', CON_N)).toEqual({ ok: true, nombre: 'Bañado de Medina' });
  });

  it('lo que se guarda es siempre el canónico, nunca lo que tipeó el usuario', () => {
    const r = verificarOficina('  cañas  ', CON_N);
    expect(r).toEqual({ ok: true, nombre: 'Cañas' });
  });
});
