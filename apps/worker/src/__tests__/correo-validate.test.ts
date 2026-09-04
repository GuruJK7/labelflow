/**
 * Tests del pre-vuelo de Correo Uruguayo.
 *
 * El foco no es "el validador acepta lo válido" sino los tres modos de falla
 * que cuestan plata de verdad:
 *   1. despachar con un teléfono de relleno → el paquete llega sin contacto
 *   2. Montevideo sin barrio → rechazo silencioso (el mismo bug que KI-010 en DAC)
 *   3. nombre de sucursal casi-correcto → guía emitida a un destino que no existe
 */

import { describe, it, expect } from 'vitest';
import {
  buscarOficina,
  construirEnvio,
  esCelularPlaceholder,
  estimarTarifaUYU,
  type PedidoParaCorreo,
} from '../correo/validate';
import type { LocalidadCorreo } from '../correo/types';

const CATALOGO: LocalidadCorreo[] = [
  {
    nombre: 'Punta del Este',
    ciudad: 'Punta del Este',
    departamento: 'Maldonado',
    direccion: 'Calle 30 s/n',
    codigoPostal: '20100',
    codigoAHIVA: 49001,
    siteCode: 'PDE',
    telefono: '',
  },
  {
    nombre: 'Aigua',
    ciudad: 'Aigua',
    departamento: 'Maldonado',
    direccion: 'Av. Artigas 700',
    codigoPostal: '20500',
    codigoAHIVA: 49002,
    siteCode: 'AIG',
    telefono: '',
  },
  {
    nombre: 'Piriápolis',
    ciudad: 'Piriapolis',
    departamento: 'Maldonado',
    direccion: 'Av. Piria s/n',
    codigoPostal: '20200',
    codigoAHIVA: 49003,
    siteCode: 'PIR',
    telefono: '',
  },
];

/** Pedido mínimo válido a domicilio. Cada test rompe un solo campo. */
function pedidoBase(): PedidoParaCorreo {
  return {
    referencia: 'AE-1001',
    nombre: 'Ana Pérez',
    mail: 'ana@ejemplo.com',
    celular: '099123456',
    departamento: 'Maldonado',
    ciudad: 'San Carlos',
    calle: 'Treinta y Tres',
    nroPuerta: '903',
    pesoKg: 1.2,
    contenido: 'Ropa',
  };
}

describe('esCelularPlaceholder', () => {
  it('detecta el relleno 099000000 que mete cleanPhone()', () => {
    expect(esCelularPlaceholder('099000000')).toBe(true);
  });

  it('detecta la variante 090000000', () => {
    expect(esCelularPlaceholder('090000000')).toBe(true);
  });

  it('no marca un celular real', () => {
    expect(esCelularPlaceholder('099123456')).toBe(false);
    expect(esCelularPlaceholder('091234500')).toBe(false);
  });
});

describe('buscarOficina', () => {
  it('matchea exacto', () => {
    const r = buscarOficina('Punta del Este', CATALOGO);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.oficina.codigoAHIVA).toBe(49001);
  });

  it('matchea ignorando tildes y mayúsculas, pero devuelve el nombre canónico', () => {
    const r = buscarOficina('PIRIAPOLIS', CATALOGO);
    expect(r.ok).toBe(true);
    // Lo que se manda a AHIVA es la grafía del catálogo, con tilde.
    if (r.ok) expect(r.oficina.nombre).toBe('Piriápolis');
  });

  it('acepta "Aiguá" con tilde aunque el catálogo la escriba sin tilde', () => {
    const r = buscarOficina('Aiguá', CATALOGO);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.oficina.nombre).toBe('Aigua');
  });

  it('sugiere cuando no encuentra', () => {
    const r = buscarOficina('Punta', CATALOGO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.sugerencias.join()).toContain('Punta del Este');
  });

  it('no inventa una oficina que no existe', () => {
    const r = buscarOficina('Cabo Polonio', CATALOGO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.sugerencias).toEqual([]);
  });
});

describe('estimarTarifaUYU', () => {
  it('usa el tramo correcto en los bordes', () => {
    expect(estimarTarifaUYU(2)).toBe(195);
    expect(estimarTarifaUYU(2.01)).toBe(220);
    expect(estimarTarifaUYU(5)).toBe(220);
    expect(estimarTarifaUYU(29.9)).toBe(550);
  });

  it('devuelve null fuera de tabla', () => {
    expect(estimarTarifaUYU(31)).toBeNull();
  });
});

describe('construirEnvio — camino feliz', () => {
  it('arma un envío a domicilio con el flete a cargo del destinatario', () => {
    const r = construirEnvio(pedidoBase());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envio.lugarEntrega.departamento).toBe('MALDONADO');
    expect(r.envio.lugarEntrega.localidad).toBe('San Carlos');
    expect(r.envio.destinatario.celular).toBe('099123456');
    expect(r.envio.paquetesSimples?.[0].peso).toBe(1.2);
    expect(r.envio.paquetesSimples?.[0].responsableServEntrega).toBe('DESTINATARIO');
    // 10 días es el almacenamiento gratis; mandarlo explícito evita depender
    // del default del servidor.
    expect(r.envio.paquetesSimples?.[0].almacenamiento).toBe(10);
    expect(r.envio.soloDestinatario).toBe(false);
  });

  it('arma un envío a sucursal y descarta los campos de domicilio', () => {
    const r = construirEnvio(
      { ...pedidoBase(), oficinaCorreo: 'punta del este' },
      CATALOGO,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envio.lugarEntrega.oficinaCorreo).toBe('Punta del Este');
    expect(r.envio.lugarEntrega.calle).toBeUndefined();
    expect(r.envio.lugarEntrega.departamento).toBeUndefined();
  });

  it('normaliza el celular con prefijo internacional', () => {
    const r = construirEnvio({ ...pedidoBase(), celular: '+598 99 123 456' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envio.destinatario.celular).toBe('099123456');
  });

  it('toma el peso de gramos cuando no hay pesoKg', () => {
    const r = construirEnvio({ ...pedidoBase(), pesoKg: null, gramos: 2500 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envio.paquetesSimples?.[0].peso).toBe(2.5);
  });

  it('cae al peso por defecto de la tienda y avisa', () => {
    const r = construirEnvio({
      ...pedidoBase(),
      pesoKg: null,
      gramos: 0,
      pesoDefaultKg: 0.5,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envio.paquetesSimples?.[0].peso).toBe(0.5);
    expect(r.avisos.join()).toContain('default de la tienda');
  });
});

describe('construirEnvio — lo que NO tiene que dejar pasar', () => {
  it('rechaza el celular de relleno aunque sea formalmente válido', () => {
    const r = construirEnvio({ ...pedidoBase(), celular: '099000000' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join()).toContain('relleno');
  });

  it('rechaza Montevideo sin barrio', () => {
    const r = construirEnvio({
      ...pedidoBase(),
      departamento: 'Montevideo',
      ciudad: 'Montevideo',
      barrio: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join()).toContain('barrio');
  });

  it('acepta Montevideo cuando viene el barrio, y manda el barrio como localidad', () => {
    const r = construirEnvio({
      ...pedidoBase(),
      departamento: 'Montevideo',
      ciudad: 'Montevideo',
      barrio: 'Pocitos',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.envio.lugarEntrega.localidad).toBe('Pocitos');
  });

  it('rechaza un peso de 30 kg o más', () => {
    const r = construirEnvio({ ...pedidoBase(), pesoKg: 30 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join()).toContain('30');
  });

  it('rechaza una sucursal inexistente en vez de mandarla igual', () => {
    const r = construirEnvio({ ...pedidoBase(), oficinaCorreo: 'Punta Ballena' }, CATALOGO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join()).toContain('no existe en el catálogo');
  });

  it('rechaza retiro en sucursal si no se pasó el catálogo (no adivina)', () => {
    const r = construirEnvio({ ...pedidoBase(), oficinaCorreo: 'Punta del Este' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join()).toContain('catálogo');
  });

  it('rechaza un departamento que no es uruguayo', () => {
    const r = construirEnvio({ ...pedidoBase(), departamento: 'Buenos Aires' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.motivos.join()).toContain('Departamento no reconocido');
  });

  it('junta TODOS los motivos de una pasada, no corta en el primero', () => {
    const r = construirEnvio({
      referencia: '',
      nombre: '',
      mail: 'no-es-mail',
      celular: '123',
      departamento: 'Narnia',
      calle: '',
      pesoKg: 99,
      contenido: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // referencia, nombre, mail, celular, departamento, calle, peso = 7
      expect(r.motivos.length).toBeGreaterThanOrEqual(7);
    }
  });

  it('nunca devuelve ok:true con motivos cargados', () => {
    const casos: PedidoParaCorreo[] = [
      { ...pedidoBase(), mail: '' },
      { ...pedidoBase(), calle: '' },
      { ...pedidoBase(), pesoKg: 0, gramos: 0 },
      { ...pedidoBase(), nombre: '  ' },
    ];
    for (const c of casos) {
      const r = construirEnvio(c, CATALOGO);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.motivos.length).toBeGreaterThan(0);
    }
  });
});

describe('oficinas con nombre repetido en el catálogo real', () => {
  /**
   * Caso verificado contra producción el 2026-08-28: "Colonia Miguelete"
   * aparece dos veces, mismo departamento y mismo CP, con direcciones y
   * códigos AHIVA distintos. Como `oficinaCorreo` viaja como texto, elegir en
   * silencio una de las dos es adivinar a qué mostrador llega el paquete.
   */
  const CON_DUPLICADO: LocalidadCorreo[] = [
    ...CATALOGO,
    {
      nombre: 'Colonia Miguelete',
      ciudad: 'Colonia Miguelete',
      departamento: 'Colonia',
      direccion: 'José G. Artigas s/n',
      codigoPostal: '70800',
      codigoAHIVA: 48972,
      siteCode: 'CM1',
      telefono: '',
    },
    {
      nombre: 'Colonia Miguelete',
      ciudad: 'Colonia Miguelete',
      departamento: 'Colonia',
      direccion: 'Gral. Fructuoso Rivera 364',
      codigoPostal: '70800',
      codigoAHIVA: 49238,
      siteCode: 'CM2',
      telefono: '',
    },
  ];

  it('reporta cuántas oficinas comparten el nombre', () => {
    const r = buscarOficina('Colonia Miguelete', CON_DUPLICADO);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.duplicadas).toBe(2);
  });

  it('marca 1 cuando el nombre es único', () => {
    const r = buscarOficina('Punta del Este', CON_DUPLICADO);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.duplicadas).toBe(1);
  });

  it('deja pasar el envío pero avisa de la ambigüedad', () => {
    const r = construirEnvio(
      { ...pedidoBase(), oficinaCorreo: 'Colonia Miguelete' },
      CON_DUPLICADO,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envio.lugarEntrega.oficinaCorreo).toBe('Colonia Miguelete');
    expect(r.avisos.join()).toContain('2 oficinas llamadas');
  });

  it('no avisa de ambigüedad cuando no la hay', () => {
    const r = construirEnvio(
      { ...pedidoBase(), oficinaCorreo: 'Punta del Este' },
      CON_DUPLICADO,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.avisos.join()).not.toContain('oficinas llamadas');
  });
});
