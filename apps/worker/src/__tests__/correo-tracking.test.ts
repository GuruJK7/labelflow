/**
 * Tests del seguimiento público de Correo.
 *
 * El contrato se sondeó en vivo el 2026-08-28 con códigos inexistentes. Lo que
 * más importa cubrir es que un envío real NO se dé por inexistente: el servicio
 * contesta HTTP 200 siempre, así que "no encontrado" es un estado del body, no
 * un status code, y confundirlos haría que un envío despachado figure como
 * inexistente.
 */

import { describe, it, expect } from 'vitest';
import {
  esCodigoTrazabilidadValido,
  parsearSeguimiento,
  urlSeguimientoComprador,
} from '../correo/tracking';

describe('esCodigoTrazabilidadValido', () => {
  it('acepta la forma S10 que emite Correo', () => {
    expect(esCodigoTrazabilidadValido('PC123456789UY')).toBe(true);
    expect(esCodigoTrazabilidadValido('PE987654321UY')).toBe(true);
    expect(esCodigoTrazabilidadValido('pc123456789uy')).toBe(true);
  });

  it('rechaza una guía DAC (numérica, arranca en 88)', () => {
    expect(esCodigoTrazabilidadValido('8821454658847')).toBe(false);
  });

  it('rechaza una etiqueta de reparto propio', () => {
    expect(esCodigoTrazabilidadValido('LF-000123')).toBe(false);
  });

  it('rechaza largos que no son 13', () => {
    expect(esCodigoTrazabilidadValido('PC12345678UY')).toBe(false);
    expect(esCodigoTrazabilidadValido('PC1234567890UY')).toBe(false);
  });
});

describe('parsearSeguimiento', () => {
  it('lee la respuesta real de un código inexistente (capturada en vivo)', () => {
    const body = [
      {
        idNacional: 'PC000000000UY',
        eventos: [],
        estado: 'NOT_FOUND',
        codigoEtapaEntrega: 'SIN_EVENTOS',
      },
    ];
    const s = parsearSeguimiento('PC000000000UY', body);
    expect(s.encontrado).toBe(false);
    expect(s.estado).toBe('NOT_FOUND');
    expect(s.codigoEtapaEntrega).toBe('SIN_EVENTOS');
    expect(s.eventos).toEqual([]);
  });

  it('trata cualquier estado que no sea NOT_FOUND como envío existente', () => {
    // Un estado que no conocemos NO puede leerse como "no existe": daría por
    // inexistente un envío que sí se despachó y se facturó.
    const s = parsearSeguimiento('PC123456789UY', [
      { estado: 'UN_ESTADO_NUEVO', codigoEtapaEntrega: 'ALGO', eventos: [] },
    ]);
    expect(s.encontrado).toBe(true);
    expect(s.estado).toBe('UN_ESTADO_NUEVO');
  });

  it('conserva los eventos con campos que no modelamos', () => {
    const s = parsearSeguimiento('PC123456789UY', [
      {
        estado: 'EN_CURSO',
        codigoEtapaEntrega: 'EN_TRANSITO',
        eventos: [{ fecha: '2026-08-28', descripcion: 'Admitido', oficinaRara: 'X', otro: 42 }],
      },
    ]);
    expect(s.eventos).toHaveLength(1);
    expect(s.eventos[0].oficinaRara).toBe('X');
    expect(s.eventos[0].otro).toBe(42);
  });

  it('no explota con un body vacío, nulo o de forma inesperada', () => {
    for (const body of [[], null, undefined, {}, 'texto suelto']) {
      const s = parsearSeguimiento('PC123456789UY', body);
      expect(s.estado).toBe('DESCONOCIDO');
      expect(s.eventos).toEqual([]);
      // El crudo se conserva siempre, para poder diagnosticar después.
      expect(s.crudo).toEqual(body);
    }
  });

  it('acepta también un objeto suelto en vez del array', () => {
    const s = parsearSeguimiento('PC123456789UY', {
      estado: 'NOT_FOUND',
      codigoEtapaEntrega: 'SIN_EVENTOS',
      eventos: [],
    });
    expect(s.encontrado).toBe(false);
  });
});

describe('urlSeguimientoComprador', () => {
  it('arma el link que se le manda al comprador', () => {
    expect(urlSeguimientoComprador('PC123456789UY')).toBe(
      'https://ahiva.correo.com.uy/servicioConsultaTntIps-web/?pieza=PC123456789UY',
    );
  });

  it('escapa lo que le metan', () => {
    expect(urlSeguimientoComprador('a b&c')).toContain('a%20b%26c');
  });
});
