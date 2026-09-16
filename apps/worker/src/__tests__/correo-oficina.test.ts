/**
 * Tests de la elección de agencia y del adaptador de pedidos a Correo.
 *
 * Con entrega en agencia y contra entrega, elegir la sucursal equivocada es el
 * error más caro del flujo: nadie retira el paquete, vuelve al remitente, y la
 * tienda paga el flete de ida y el de vuelta sin haber cobrado la mercadería.
 * Por eso el foco de estos tests no es "elige bien cuando puede" sino
 * "NO elige cuando no puede", que es la parte que se rompe en silencio.
 *
 * El otro modo de falla cubierto acá es el teléfono: `cleanPhone()` del pipeline
 * de DAC rellena con `099000000`, que Correo acepta. Un envío en contra entrega
 * con un contacto inexistente no se retira nunca.
 */

import { describe, it, expect } from 'vitest';
import {
  oficinasDeDepartamento,
  resolverDepartamentoDestino,
  resolverOficinaEntrega,
} from '../correo/oficina';
import {
  celularDelPedido,
  contenidoDelPedido,
  montoAcobrar,
  nombreDelPedido,
  pedidoDesdeOrden,
} from '../correo/adapter';
import type { LocalidadCorreo } from '../correo/types';
import type { ShopifyOrder } from '../shopify/types';

/** Recorte del catálogo real de producción (verificado 2026-09-03). */
function of(
  nombre: string,
  ciudad: string,
  departamento: string,
  codigoPostal: string,
  codigoAHIVA: number,
): LocalidadCorreo {
  return { nombre, ciudad, departamento, codigoPostal, codigoAHIVA, direccion: '', siteCode: '', telefono: '' };
}

const CATALOGO: LocalidadCorreo[] = [
  // Montevideo tiene 17 oficinas en producción: es el departamento donde la
  // derivación automática puede equivocarse más feo.
  of('Ciudad Vieja', 'Montevideo', 'Montevideo', '11000', 712),
  of('Pocitos', 'Montevideo', 'Montevideo', '11300', 713),
  of('Cordón', 'Montevideo', 'Montevideo', '11200', 714),
  of('Aguada', 'Montevideo', 'Montevideo', '11800', 715),
  // El nombre real de producción que el 16-09 dejó dos pedidos a revisión:
  // el comerciante escribe "Tres Cruces" y el catálogo dice esto.
  of('Shopping Tres Cruces', 'Montevideo', 'Montevideo', '11800', 716),
  // Maldonado, 10 oficinas.
  of('Maldonado', 'Maldonado', 'Maldonado', '20000', 49010),
  of('Punta del Este', 'Punta del Este', 'Maldonado', '20100', 49011),
  of('Piriápolis', 'Piriapolis', 'Maldonado', '20200', 49012),
  // Flores tiene 2 en producción; acá se deja UNA para el caso "no hay nada que elegir".
  of('Trinidad', 'Trinidad', 'Flores', '85000', 49020),
  // El duplicado real de producción.
  of('Colonia Miguelete', 'Colonia Miguelete', 'Colonia', '70800', 48972),
  of('Colonia Miguelete', 'Colonia Miguelete', 'Colonia', '70800', 49238),
];

describe('resolverDepartamentoDestino', () => {
  it('el departamento declarado por la tienda gana', () => {
    expect(resolverDepartamentoDestino({ departamento: 'Maldonado', ciudad: 'Montevideo' })).toBe(
      'MALDONADO',
    );
  });

  it('sin departamento, lo deduce de la ciudad', () => {
    expect(resolverDepartamentoDestino({ ciudad: 'Punta del Este' })).toBe('MALDONADO');
  });

  it('sin departamento ni ciudad reconocible, lo deduce del código postal', () => {
    expect(resolverDepartamentoDestino({ zip: '20100' })).toBe('MALDONADO');
  });

  it('normaliza tildes y sufijos que manda Shopify', () => {
    expect(resolverDepartamentoDestino({ departamento: 'Paysandú' })).toBe('PAYSANDU');
    expect(resolverDepartamentoDestino({ departamento: 'Treinta y Tres Department' })).toBe(
      'TREINTA Y TRES',
    );
  });

  it('sin ninguna señal devuelve null en vez de adivinar', () => {
    expect(resolverDepartamentoDestino({})).toBeNull();
    expect(resolverDepartamentoDestino({ departamento: 'Buenos Aires' })).toBeNull();
  });
});

describe('resolverOficinaEntrega — cuando SÍ hay una sola respuesta', () => {
  it('un departamento con una sola oficina no tiene nada que elegir', () => {
    const r = resolverOficinaEntrega({ departamento: 'Flores', ciudad: 'Cualquier cosa' }, CATALOGO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oficina.nombre).toBe('Trinidad');
  });

  it('la ciudad que coincide con el nombre de una oficina la elige', () => {
    const r = resolverOficinaEntrega({ departamento: 'Maldonado', ciudad: 'Punta del Este' }, CATALOGO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oficina.nombre).toBe('Punta del Este');
  });

  it('matchea ignorando tildes, pero manda la grafía del catálogo', () => {
    const r = resolverOficinaEntrega({ departamento: 'Maldonado', ciudad: 'Piriapolis' }, CATALOGO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // El catálogo la escribe con tilde y AHIVA la identifica por texto exacto.
    expect(r.oficina.nombre).toBe('Piriápolis');
  });

  it('en Montevideo usa el barrio, que es la única señal que discrimina', () => {
    const r = resolverOficinaEntrega(
      { departamento: 'Montevideo', ciudad: 'Montevideo', barrio: 'Pocitos' },
      CATALOGO,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oficina.nombre).toBe('Pocitos');
  });
});

describe('resolverOficinaEntrega — cuando NO hay una sola respuesta, no elige', () => {
  it('Montevideo sin barrio va a revisión con la lista de candidatas', () => {
    const r = resolverOficinaEntrega({ departamento: 'Montevideo', ciudad: 'Montevideo' }, CATALOGO);
    // Éste es EL test del archivo: elegir "una razonable" acá manda al comprador
    // a retirar a un barrio que no es el suyo.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.candidatas).toContain('Pocitos');
    expect(r.candidatas.length).toBeGreaterThan(1);
    expect(r.motivo).toMatch(/no identifica ninguna/i);
  });

  it('una localidad de Maldonado que no es ninguna oficina va a revisión', () => {
    const r = resolverOficinaEntrega({ departamento: 'Maldonado', ciudad: 'Manantiales' }, CATALOGO);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.candidatas).toEqual(['Maldonado', 'Piriápolis', 'Punta del Este']);
  });

  it('sin departamento determinable no inventa nada', () => {
    const r = resolverOficinaEntrega({ ciudad: 'Ciudad Inexistente' }, CATALOGO);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toMatch(/no se pudo determinar el departamento/i);
  });

  it('sin catálogo no elige: sería adivinar un nombre que AHIVA valida por texto', () => {
    const r = resolverOficinaEntrega({ departamento: 'Maldonado', ciudad: 'Maldonado' }, []);
    expect(r.ok).toBe(false);
  });
});

describe('resolverOficinaEntrega — oficina pedida explícitamente', () => {
  it('una elección humana explícita gana sobre la derivación', () => {
    const r = resolverOficinaEntrega(
      { departamento: 'Montevideo', ciudad: 'Montevideo' },
      CATALOGO,
      { oficinaPreferida: 'Ciudad Vieja' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oficina.nombre).toBe('Ciudad Vieja');
  });

  it('si la oficina pedida es EXACTA pero de otro departamento, ya no se respeta: a revisión', () => {
    // Hasta el 16-09-2026 esto devolvía ok:true con "NO es el departamento del
    // destino" en el motivo, y el pedido salía igual a Pocitos, Montevideo.
    const r = resolverOficinaEntrega(
      { departamento: 'Maldonado', ciudad: 'Maldonado' },
      CATALOGO,
      { oficinaPreferida: 'Pocitos' },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toMatch(/"Pocitos" es una agencia de Montevideo, no de Maldonado/);
    expect(r.candidatas).toEqual(['Pocitos (Montevideo)']);
  });

  // --- nombre parcial: se elige SÓLO si hay una única oficina posible ---------
  //
  // 16-09-2026, producción: AE-cmu481nl y AE-cmu4hek1 quedaron "a revisión" con
  // «La oficina pedida "Tres Cruces" no existe en el catálogo — agencias
  // posibles: Shopping Tres Cruces (Montevideo)». El selector tenía la única
  // respuesta en la mano y la rechazó igual. La regla del archivo es "elegir
  // sólo cuando hay una sola respuesta posible": una sola oficina cuyo nombre
  // contenga lo pedido ES una sola respuesta posible.

  it('el caso real de producción: "Tres Cruces" elige "Shopping Tres Cruces"', () => {
    const r = resolverOficinaEntrega(
      { departamento: 'Montevideo', ciudad: 'Montevideo' },
      CATALOGO,
      { oficinaPreferida: 'Tres Cruces' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oficina.nombre).toBe('Shopping Tres Cruces');
    // El motivo deja claro que no fue un match exacto, para que se vea en el runlog.
    expect(r.motivoEleccion).toMatch(/Tres Cruces/);
    expect(r.motivoEleccion).toMatch(/Shopping Tres Cruces/);
  });

  it('la grafía del comerciante no importa: "tres cruces" también', () => {
    const r = resolverOficinaEntrega({ departamento: 'Montevideo' }, CATALOGO, {
      oficinaPreferida: 'tres cruces',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oficina.nombre).toBe('Shopping Tres Cruces');
  });

  it('un nombre truncado que sólo puede ser una oficina también la elige', () => {
    const r = resolverOficinaEntrega({ departamento: 'Maldonado' }, CATALOGO, {
      oficinaPreferida: 'Punta del Est',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oficina.nombre).toBe('Punta del Este');
  });

  it('un nombre parcial que matchea VARIAS oficinas va a revisión con sugerencias', () => {
    // "Colonia" está contenido en las dos "Colonia Miguelete": no hay una sola respuesta.
    const r = resolverOficinaEntrega({ departamento: 'Colonia' }, CATALOGO, {
      oficinaPreferida: 'Colonia',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toMatch(/no existe en el catálogo/);
    expect(r.candidatas.join(' ')).toMatch(/Colonia Miguelete/);
  });

  it('un nombre parcial que sólo existe en OTRO departamento no se elige', () => {
    // Elección explícita exacta de otro departamento se respeta (test de arriba);
    // pero un parcial es evidencia más débil: cruzar de departamento con eso es
    // exactamente el error de los dos fletes.
    const r = resolverOficinaEntrega({ departamento: 'Maldonado' }, CATALOGO, {
      oficinaPreferida: 'Pocit',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.candidatas.join(' ')).toMatch(/Pocitos \(Montevideo\)/);
  });

  it('sin departamento determinable, el parcial vale contra todo el catálogo si es único', () => {
    const r = resolverOficinaEntrega({}, CATALOGO, { oficinaPreferida: 'Tres Cruces' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oficina.nombre).toBe('Shopping Tres Cruces');
  });

  it('un pedido de menos de 4 letras no elige por parcial: matchea por ruido', () => {
    // "Tr" sólo está en "Shopping Tres Cruces" dentro de Montevideo, pero nadie
    // pide una agencia con dos letras: es un dato roto, no una intención.
    const r = resolverOficinaEntrega({ departamento: 'Montevideo' }, CATALOGO, {
      oficinaPreferida: 'Tr',
    });
    expect(r.ok).toBe(false);
  });

  it('un nombre que no se parece a ninguna oficina se rechaza sin sugerencias', () => {
    const r = resolverOficinaEntrega({ departamento: 'Maldonado' }, CATALOGO, {
      oficinaPreferida: 'Sucursal Inventada',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toMatch(/no existe en el catálogo/);
    expect(r.candidatas).toHaveLength(0);
  });

  it('el nombre duplicado de producción no se resuelve en silencio', () => {
    // "Colonia Miguelete" existe dos veces con códigos AHIVA distintos. Como el
    // campo viaja como texto, elegir una sería adivinar qué sucursal recibe.
    const r = resolverOficinaEntrega({ departamento: 'Colonia' }, CATALOGO, {
      oficinaPreferida: 'Colonia Miguelete',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toMatch(/2 oficinas llamadas/);
  });
});

/**
 * Regresión 16-09-2026: la agencia pedida coincide EXACTA con una oficina de
 * OTRO departamento.
 *
 * Antes se aceptaba ("se respeta la elección; si alguien pidió esa sucursal a
 * mano, sabe algo que el geo no sabe") y sólo se anotaba la discrepancia en el
 * motivo. Una prueba diferencial de 980 casos contra el resolvedor de DEPO
 * (`wms-mvp/src/lib/correo/oficinas.ts`, que ya buscaba la exacta dentro del
 * departamento) mostró que con el catálogo real de producción (196 oficinas)
 * eso mandaba el paquete a 100+ km del comprador. Los cuatro casos de abajo
 * son nombres REALES del catálogo, con su departamento real.
 *
 * Lo que se pide: la exacta se busca primero en el departamento del destino;
 * si sólo existe en otro, se rechaza diciendo dónde está, con esa lista como
 * candidatas. Sin departamento del destino, la exacta global sigue valiendo.
 */
const CATALOGO_HOMONIMOS: LocalidadCorreo[] = [
  ...CATALOGO,
  // Los cuatro pares reales (nombre exacto en un departamento + lo que el
  // departamento del destino sí tiene), tal cual están en producción.
  of('Cerro', 'Montevideo', 'Montevideo', '12800', 47633),
  of('Cerro de las Cuentas', 'Cerro de las Cuentas', 'Cerro Largo', '36200', 49317),
  of('Melo', 'Melo', 'Cerro Largo', '37000', 115),
  of('Minas', 'Minas', 'Lavalleja', '30000', 120),
  of('Minas de Corrales', 'Minas de Corrales', 'Rivera', '41100', 121),
  of('Rivera', 'Rivera', 'Rivera', '40000', 185),
  of('Colón', 'Montevideo', 'Montevideo', '12500', 47642),
  of('Colón - Centro de Cercanía', 'Colon', 'Lavalleja', '30000', 49328),
  of('La Paz', 'La Paz', 'Canelones', '15900', 47660),
  // Sí: el catálogo real lleva DOS espacios en este nombre.
  of('La Paz  CP', 'La Paz', 'Colonia', '70200', 49255),
  of('Colonia', 'Colonia del Sacramento', 'Colonia', '70000', 52),
];

describe('oficina pedida EXACTA pero de otro departamento (casos reales del catálogo)', () => {
  const casos: Array<{ destino: string; pedida: string; oficinaDe: string; candidata: string }> = [
    { destino: 'Cerro Largo', pedida: 'Cerro', oficinaDe: 'Montevideo', candidata: 'Cerro (Montevideo)' },
    { destino: 'Rivera', pedida: 'Minas', oficinaDe: 'Lavalleja', candidata: 'Minas (Lavalleja)' },
    { destino: 'Lavalleja', pedida: 'Colón', oficinaDe: 'Montevideo', candidata: 'Colón (Montevideo)' },
    { destino: 'Colonia', pedida: 'La Paz', oficinaDe: 'Canelones', candidata: 'La Paz (Canelones)' },
  ];

  for (const c of casos) {
    it(`${c.destino} + "${c.pedida}" NO va a ${c.oficinaDe}: a revisión, con la agencia y su departamento`, () => {
      const r = resolverOficinaEntrega({ departamento: c.destino }, CATALOGO_HOMONIMOS, {
        oficinaPreferida: c.pedida,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.motivo).toBe(
        `"${c.pedida}" es una agencia de ${c.oficinaDe}, no de ${c.destino}: elegí una del departamento del destino.`,
      );
      expect(r.candidatas).toEqual([c.candidata]);
    });
  }

  it('tampoco se desliza al parcial del departamento del destino: la exacta ajena frena antes', () => {
    // Rivera tiene "Minas de Corrales" y Lavalleja tiene "Colón - Centro de
    // Cercanía": si el rechazo no cortara ANTES del paso 0b, el parcial único
    // los elegiría. Puede que sea la agencia correcta, puede que no: con una
    // exacta en otro departamento la intención es ambigua, y ambiguo = revisión.
    const rivera = resolverOficinaEntrega({ departamento: 'Rivera' }, CATALOGO_HOMONIMOS, {
      oficinaPreferida: 'Minas',
    });
    expect(rivera.ok).toBe(false);
    const lavalleja = resolverOficinaEntrega({ departamento: 'Lavalleja' }, CATALOGO_HOMONIMOS, {
      oficinaPreferida: 'Colon',
    });
    expect(lavalleja.ok).toBe(false);
  });

  it('la grafía no cambia el veredicto: "colon" y "LA PAZ" también se rechazan', () => {
    const a = resolverOficinaEntrega({ departamento: 'Lavalleja' }, CATALOGO_HOMONIMOS, {
      oficinaPreferida: 'colon',
    });
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.candidatas).toEqual(['Colón (Montevideo)']);
    const b = resolverOficinaEntrega({ departamento: 'Colonia' }, CATALOGO_HOMONIMOS, {
      oficinaPreferida: 'LA PAZ',
    });
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.candidatas).toEqual(['La Paz (Canelones)']);
  });

  it('la misma exacta en el MISMO departamento se sigue eligiendo', () => {
    const casosOk: Array<[string, string]> = [
      ['Montevideo', 'Cerro'],
      ['Lavalleja', 'Minas'],
      ['Montevideo', 'Colón'],
      ['Canelones', 'La Paz'],
    ];
    for (const [destino, pedida] of casosOk) {
      const r = resolverOficinaEntrega({ departamento: destino }, CATALOGO_HOMONIMOS, {
        oficinaPreferida: pedida,
      });
      expect(r.ok, `${destino} + ${pedida}`).toBe(true);
      if (!r.ok) return;
      expect(r.oficina.nombre).toBe(pedida);
      expect(r.oficina.departamento).toBe(destino);
      expect(r.motivoEleccion).toBe(`Oficina pedida explícitamente: ${pedida}.`);
    }
  });

  it('el departamento puede venir inferido (ciudad/CP), no sólo declarado', () => {
    // "Melo" es de Cerro Largo para uruguay-geo; el CP 37000 lo corrobora.
    const r = resolverOficinaEntrega({ ciudad: 'Melo', zip: '37000' }, CATALOGO_HOMONIMOS, {
      oficinaPreferida: 'Cerro',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.candidatas).toEqual(['Cerro (Montevideo)']);
  });

  it('sin departamento del destino, la exacta vale en todo el catálogo (como antes)', () => {
    for (const pedida of ['Cerro', 'Minas', 'Colón', 'La Paz']) {
      const r = resolverOficinaEntrega({}, CATALOGO_HOMONIMOS, { oficinaPreferida: pedida });
      expect(r.ok, pedida).toBe(true);
      if (!r.ok) return;
      expect(r.oficina.nombre).toBe(pedida);
    }
  });

  it('sin departamento, el duplicado exacto sigue siendo ambiguo, no se elige', () => {
    const r = resolverOficinaEntrega({}, CATALOGO_HOMONIMOS, { oficinaPreferida: 'Colonia Miguelete' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toMatch(/2 oficinas llamadas/);
  });

  it('un departamento sin ninguna oficina de Correo igual rechaza la exacta ajena, con el nombre normalizado', () => {
    // Durazno no está en este recorte del catálogo: no hay grafía "bonita" que
    // tomar prestada, así que el motivo usa la forma normalizada.
    const r = resolverOficinaEntrega({ departamento: 'Durazno' }, CATALOGO_HOMONIMOS, {
      oficinaPreferida: 'Cerro',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivo).toMatch(/no de DURAZNO/);
    expect(r.candidatas).toEqual(['Cerro (Montevideo)']);
  });
});

describe('oficinasDeDepartamento', () => {
  it('filtra por departamento ignorando la grafía del catálogo', () => {
    expect(oficinasDeDepartamento('MALDONADO', CATALOGO).map((o) => o.nombre)).toEqual([
      'Maldonado',
      'Punta del Este',
      'Piriápolis',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Adaptador
// ---------------------------------------------------------------------------

function orden(over: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: 1042,
    name: '#1042',
    email: 'ana@ejemplo.com',
    total_price: '1990.00',
    currency: 'UYU',
    tags: '',
    phone: null,
    shipping_address: {
      first_name: 'Ana',
      last_name: 'Pérez',
      phone: '099123456',
      address1: 'Rambla 123',
      address2: '',
      city: 'Punta del Este',
      province: 'Maldonado',
      zip: '20100',
      country: 'Uruguay',
    },
    line_items: [{ title: 'Parche Kinoki x30', quantity: 1, price: '1990.00', product_id: null }],
    note: null,
    note_attributes: null,
    ...over,
  };
}

describe('celularDelPedido — nunca el relleno 099000000', () => {
  it('toma el de la dirección de envío cuando sirve', () => {
    expect(celularDelPedido(orden())).toBe('099123456');
  });

  it('cae al teléfono del pedido si el de envío está vacío', () => {
    const o = orden({ phone: '+598 91 205 055' });
    o.shipping_address!.phone = '';
    expect(celularDelPedido(o)).toBe('091205055');
  });

  it('cae al de la cuenta del cliente, que suele ser el mejor cargado', () => {
    const o = orden({ customer: { phone: '59899888777' } });
    o.shipping_address!.phone = '';
    expect(celularDelPedido(o)).toBe('099888777');
  });

  it('un fijo no es un celular: Correo avisa la llegada por SMS', () => {
    const o = orden();
    o.shipping_address!.phone = '42223333';
    expect(celularDelPedido(o)).toBeNull();
  });

  it('sin ningún teléfono usable devuelve null, no un relleno', () => {
    const o = orden();
    o.shipping_address!.phone = '';
    expect(celularDelPedido(o)).toBeNull();
  });
});

describe('pedidoDesdeOrden', () => {
  const cfg = { pesoDefaultKg: 1, oficinaDevolucion: 'Maldonado', contraEntrega: true };

  it('arma el pedido completo con agencia derivada del destino', () => {
    const r = pedidoDesdeOrden(orden(), CATALOGO, cfg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.pedido.oficinaCorreo).toBe('Punta del Este');
    expect(r.pedido.oficinaDevolucion).toBe('Maldonado');
    expect(r.pedido.referencia).toBe('#1042');
    expect(r.pedido.nombre).toBe('Ana Pérez');
    expect(r.pedido.celular).toBe('099123456');
    expect(r.pedido.codAmount).toBe(1990);
    expect(r.pedido.codReferencia).toBe('#1042');
    expect(r.pedido.contenido).toBe('Parche Kinoki x30');
  });

  it('sin contra entrega no se carga monto a cobrar', () => {
    const r = pedidoDesdeOrden(orden(), CATALOGO, { ...cfg, contraEntrega: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pedido.codAmount).toBeNull();
  });

  it('un destino ambiguo devuelve las candidatas para elegir a mano', () => {
    const o = orden();
    o.shipping_address!.city = 'Montevideo';
    o.shipping_address!.province = 'Montevideo';
    o.shipping_address!.zip = '';
    const r = pedidoDesdeOrden(o, CATALOGO, cfg);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.candidatas.length).toBeGreaterThan(1);
  });

  it('el barrio que trae el panel resuelve lo que Shopify deja ambiguo', () => {
    const o = orden();
    o.shipping_address!.city = 'Montevideo';
    o.shipping_address!.province = 'Montevideo';
    const r = pedidoDesdeOrden(o, CATALOGO, cfg, { barrio: 'Cordón' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pedido.oficinaCorreo).toBe('Cordón');
  });

  it('junta TODOS los motivos, no corta en el primero', () => {
    const o = orden({ email: '' });
    o.shipping_address!.phone = '';
    o.shipping_address!.first_name = '';
    o.shipping_address!.last_name = '';
    const r = pedidoDesdeOrden(o, CATALOGO, cfg);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivos.length).toBeGreaterThanOrEqual(2);
  });

  it('un pedido sin dirección de envío no llega a consultar el catálogo', () => {
    const r = pedidoDesdeOrden(orden({ shipping_address: null }), CATALOGO, cfg);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivos[0]).toMatch(/no tiene dirección de envío/i);
  });
});

describe('helpers del adaptador', () => {
  it('el contenido resume varios ítems sin desbordar la etiqueta', () => {
    const o = orden({
      line_items: [
        { title: 'Parche Kinoki x30', quantity: 1, price: '1', product_id: null },
        { title: 'Otro producto', quantity: 1, price: '1', product_id: null },
      ],
    });
    expect(contenidoDelPedido(o)).toBe('Parche Kinoki x30 +1');
  });

  it('el contenido se corta si es larguísimo', () => {
    const o = orden({
      line_items: [{ title: 'x'.repeat(200), quantity: 1, price: '1', product_id: null }],
    });
    expect(contenidoDelPedido(o).length).toBeLessThanOrEqual(60);
  });

  it('el nombre cae a la cuenta del cliente si el envío no lo trae', () => {
    const o = orden({ customer: { first_name: 'Diego', last_name: 'Fraschini' } });
    o.shipping_address!.first_name = '';
    o.shipping_address!.last_name = '';
    expect(nombreDelPedido(o)).toBe('Diego Fraschini');
  });

  it('el monto a cobrar redondea, y un total ilegible es un ERROR, no "sin cobro"', () => {
    expect(montoAcobrar(orden({ total_price: '1990.60' }))).toEqual({ monto: 1991 });
    // Devolver null acá haría que el pedido salga sin cobro: la mercadería se
    // entrega y no se cobra nunca. Tiene que ser un motivo de rechazo.
    expect(montoAcobrar(orden({ total_price: '0.00' }))).toHaveProperty('error');
    expect(montoAcobrar(orden({ total_price: 'no-es-un-numero' }))).toHaveProperty('error');
  });

  it('una tienda que factura en dólares no despacha contra entrega', () => {
    // "45.00" USD cobrado como $45 uruguayos es ~43 veces menos de lo que vale.
    const r = montoAcobrar(orden({ total_price: '45.00', currency: 'USD' }));
    expect(r).toHaveProperty('error');
    expect('error' in r && r.error).toMatch(/USD/);
  });

  it('un pedido en dólares con contra entrega va a revisión, no sale sin cobro', () => {
    const r = pedidoDesdeOrden(orden({ currency: 'USD' }), CATALOGO, {
      pesoDefaultKg: 1,
      oficinaDevolucion: 'Maldonado',
      contraEntrega: true,
    });
    expect(r.ok).toBe(false);
  });
});

describe('el código postal sale del catálogo de Correo, no de las tablas de DAC', () => {
  // Regresión del error más caro que encontró la revisión: la versión anterior
  // infería el barrio con getBarriosFromZip/getBarriosFromStreet de dac/, que
  // (a) contradicen el CP que Correo le asigna a sus propias oficinas y
  // (b) devuelven LISTAS — "Rambla 123" da los nueve barrios de la costa, así
  // que quedarse con el primero mandaba el paquete a la punta opuesta.
  it('el CP del destino elige la oficina cuando identifica una sola', () => {
    const r = resolverOficinaEntrega(
      { departamento: 'Montevideo', ciudad: 'Montevideo', zip: '11300' },
      CATALOGO,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.oficina.nombre).toBe('Pocitos');
    expect(r.motivoEleccion).toMatch(/código postal 11300/);
  });

  it('la calle ya NO decide nada: una rambla no elige agencia', () => {
    const r = resolverOficinaEntrega(
      { departamento: 'Montevideo', ciudad: 'Montevideo', calle: 'Rambla 123' },
      CATALOGO,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.candidatas.length).toBeGreaterThan(1);
  });

  it('un CP que no es de ninguna oficina del departamento no elige', () => {
    const r = resolverOficinaEntrega(
      { departamento: 'Montevideo', ciudad: 'Montevideo', zip: '11999' },
      CATALOGO,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Sin acotar: se devuelven todas las de Montevideo para elegir a mano.
    expect(r.candidatas).toEqual(['Aguada', 'Ciudad Vieja', 'Cordón', 'Pocitos', 'Shopping Tres Cruces']);
  });

  it('un barrio declarado que no es ninguna oficina NO se pisa con otra señal', () => {
    // El comprador declaró Malvín Norte (que no tiene oficina) y su CP tampoco
    // identifica una. Antes, una tabla de barrios de DAC podía elegir Pocitos.
    const r = resolverOficinaEntrega(
      { departamento: 'Montevideo', ciudad: 'Montevideo', barrio: 'Malvín Norte', calle: 'Rambla 123' },
      CATALOGO,
    );
    expect(r.ok).toBe(false);
  });
});

/**
 * Regresión: ciudades homónimas en departamentos distintos.
 *
 * Uruguay tiene "Colón" en Montevideo Y en Lavalleja, y "La Paz" en Canelones Y
 * en Colonia — con oficina de Correo en las dos puntas. Cuando la fuente no
 * declara departamento (el panel manda `province: ''` si el pedido no lo trae),
 * resolver por la ciudad sola mandaba el paquete al departamento equivocado.
 * En contra entrega eso es flete de ida, flete de vuelta y mercadería sin cobrar.
 *
 * El criterio es el mismo que ya usa DAC en `shipment.ts`: el CP corrobora, no
 * es un fallback. Si contradice a la ciudad, no se elige nada.
 */
describe('homónimos entre departamentos (sin departamento declarado)', () => {
  it('el CP que contradice a la ciudad manda a revisión en vez de elegir', () => {
    // Colón existe en Montevideo y en Lavalleja; el CP 30000 es de Lavalleja.
    expect(resolverDepartamentoDestino({ ciudad: 'Colon', zip: '30000' })).toBeNull();
    expect(resolverDepartamentoDestino({ ciudad: 'La Paz', zip: '70200' })).toBeNull();
  });

  it('una ciudad sin homónimo y sin CP sigue resolviendo', () => {
    expect(resolverDepartamentoDestino({ ciudad: 'Trinidad', zip: null })).toBe('FLORES');
  });

  it('el departamento declarado sigue ganando aunque el CP diga otra cosa', () => {
    // Una elección explícita de la tienda no se discute: sabe algo que el geo no.
    expect(resolverDepartamentoDestino({ departamento: 'Lavalleja', ciudad: 'Colon', zip: '11000' })).toBe(
      'LAVALLEJA',
    );
  });

  it('ciudad y CP que coinciden resuelven normal', () => {
    expect(resolverDepartamentoDestino({ ciudad: 'Piriapolis', zip: '20200' })).toBe('MALDONADO');
  });
});
