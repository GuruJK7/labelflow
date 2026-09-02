import { describe, it, expect } from 'vitest';
import { etiquetaHtml } from '../self-delivery/label-html';
import { TRACKING_PREFIJO, esCodigoPropio } from '../self-delivery/tracking';

/**
 * La etiqueta de reparto propio es lo ÚNICO de este producto que termina
 * pegado en una caja, en la mano de alguien que no es el comerciante. Decía
 * "LabelFlow", que es la razón social; el nombre que el comerciante contrató,
 * el que está en la tienda y el del App Store es AutoEnvía.
 *
 * 🔴 EL PREFIJO `LF-` NO SE TOCA, y este test lo fija. Es un identificador
 * PERSISTIDO: vive en `Label.guia` de envíos ya despachados y `esCodigoPropio`
 * lo usa para distinguir un envío propio de uno de DAC. Renombrarlo a "AE-"
 * dejaría sin clasificar a todos los envíos viejos. La marca visible y el
 * prefijo del código son dos cosas distintas; sólo una es cosmética.
 */
const DATOS = {
  codigo: 'LF-3K7QP2XA',
  remitente: 'Kaia Store',
  destinatario: {
    nombre: 'Ramiro Dutra',
    direccion: 'Av. Roosevelt 1234',
    ciudad: 'Maldonado',
    departamento: 'Maldonado',
    telefono: '099111222',
  },
  pedido: { nombre: '#2141', fecha: new Date('2026-09-02T12:00:00Z') },
  cobrarUyu: null,
};

describe('marca de la etiqueta de reparto propio', () => {
  const html = etiquetaHtml(DATOS);

  it('la caja que recibe el cliente dice AutoEnvía', () => {
    expect(html).toContain('>AutoEnvía<');
  });

  it('no queda LabelFlow en el HTML que se imprime', () => {
    expect(html).not.toContain('LabelFlow');
  });

  it('el prefijo del código de seguimiento sigue siendo LF-', () => {
    expect(TRACKING_PREFIJO).toBe('LF-');
    expect(esCodigoPropio('LF-3K7QP2XA')).toBe(true);
    expect(esCodigoPropio('8821433423452')).toBe(false);
  });

  it('el código sigue saliendo impreso tal cual, con su prefijo', () => {
    expect(html).toContain('LF-3K7QP2XA');
  });
});
