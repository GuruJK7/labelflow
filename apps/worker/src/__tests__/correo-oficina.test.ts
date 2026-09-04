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

  it('si la oficina pedida es de otro departamento, se respeta pero se deja dicho', () => {
    const r = resolverOficinaEntrega(
      { departamento: 'Maldonado', ciudad: 'Maldonado' },
      CATALOGO,
      { oficinaPreferida: 'Pocitos' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.motivoEleccion).toMatch(/NO es el departamento del destino/);
  });

  it('una oficina pedida que no existe se rechaza con sugerencias', () => {
    const r = resolverOficinaEntrega({ departamento: 'Maldonado' }, CATALOGO, {
      oficinaPreferida: 'Punta del Est',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.candidatas.join(' ')).toMatch(/Punta del Este/);
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
    expect(r.candidatas).toEqual(['Aguada', 'Ciudad Vieja', 'Cordón', 'Pocitos']);
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
