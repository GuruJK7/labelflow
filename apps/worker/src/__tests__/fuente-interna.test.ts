/**
 * Fuente INTERNA: la traducción PedidoInterno → DashboardOrder.
 *
 * Funciones puras — sin DB, sin red, sin Playwright. Lo que se fija acá es el
 * contrato con el resto del pipeline: si esta traducción se desvía, el pedido
 * sale mal cargado en DAC y nadie se entera hasta que el paquete no llega.
 */
import { describe, it, expect } from 'vitest';
import { aDashboardOrder, direccionParaDac, type FilaPedidoInterno } from '../fuentes/interna';
import { toShopifyOrder, stableNumericId } from '../dashboard/adapter';
import { isPickupAtDacBranch } from '../dac/shipment';

function fila(overrides: Partial<FilaPedidoInterno> = {}): FilaPedidoInterno {
  return {
    id: 'cmu1phiyx0007mrvlu2e06tpi',
    nombre: 'Carla Pérez',
    telefono: '099887766',
    documento: '45123456',
    departamento: 'Maldonado',
    localidad: 'Punta del Este',
    direccion: 'Gorlero 1234 apto 302',
    agencia: null,
    referencia: 'Portón negro',
    items: [{ nombre: 'Perfume Oud', cantidad: 2, precio: 1500 }],
    totalUyu: 3000,
    contraEntrega: false,
    observaciones: 'Llamar antes',
    ...overrides,
  };
}

describe('aDashboardOrder — traducción básica', () => {
  it('mapea al destinatario y sus datos de contacto', () => {
    const o = aDashboardOrder(fila());
    expect(o.id).toBe('cmu1phiyx0007mrvlu2e06tpi');
    expect(o.address?.full_name).toBe('Carla Pérez');
    expect(o.address?.phone).toBe('099887766');
    expect(o.address?.department).toBe('Maldonado');
    expect(o.address?.address_line).toBe('Gorlero 1234 apto 302');
    expect(o.address?.reference).toBe('Portón negro');
    expect(o.dac_text).toBe('Llamar antes');
  });

  it('la cédula viaja como `document` (va al RUT del destinatario en DAC)', () => {
    expect(aDashboardOrder(fila()).address?.document).toBe('45123456');
    expect(aDashboardOrder(fila({ documento: null })).address?.document).toBeNull();
    // Un string vacío no es una cédula: tiene que llegar null, no ''.
    expect(aDashboardOrder(fila({ documento: '  ' })).address?.document).toBeNull();
  });

  it('la localidad va en `city` y también en `neighborhood`, que es lo que pide AHIVA', () => {
    const o = aDashboardOrder(fila());
    expect(o.address?.city).toBe('Punta del Este');
    expect(o.address?.neighborhood).toBe('Punta del Este');
  });

  it('🔴 la agencia elegida a mano viaja CRUDA en `pickup_office`, para que Correo la pueda matchear', () => {
    // Hasta el 16-09-2026 el nombre de la agencia sólo existía envuelto en
    // "Agencia DAC …" dentro de `address_line`, una convención que sólo DAC
    // entiende. Correo necesita el nombre pelado para compararlo contra el
    // catálogo de AHIVA; sin este campo `oficinaPreferida` llegaba en null y un
    // pedido a "Tres cruces" en Montevideo iba a revisión en cada corrida,
    // porque ese departamento tiene 17 oficinas y nada permitía desempatar.
    const o = aDashboardOrder(fila({ direccion: null, agencia: 'Tres cruces' }));
    expect(o.address?.pickup_office).toBe('Tres cruces');
    // Y el camino de DAC no cambia: sigue recibiendo su texto de siempre.
    expect(o.address?.address_line).toBe('Agencia DAC Tres cruces');
  });

  it('sin agencia, `pickup_office` viaja null (la fuente remota no cambia en nada)', () => {
    expect(aDashboardOrder(fila()).address?.pickup_office).toBeNull();
  });
});

describe('aDashboardOrder — ítems y precios', () => {
  it('el precio va EN PESOS, no en centavos: el total sale de multiplicar tal cual', () => {
    const o = aDashboardOrder(fila());
    const { order } = toShopifyOrder(o);
    // 2 × 1500 = 3000. Si alguien mandara centavos, acá saldría 300.000.
    expect(order.total_price).toBe('3000.00');
  });

  it('cantidad ausente, cero o basura cuenta como 1', () => {
    const o = aDashboardOrder(
      fila({ items: [{ nombre: 'X', precio: 100 }, { nombre: 'Y', cantidad: 0, precio: 50 }] }),
    );
    expect(o.items.map((i) => i.qty)).toEqual([1, 1]);
  });

  it('un ítem sin nombre no rompe el envío: queda "Artículo"', () => {
    const o = aDashboardOrder(fila({ items: [{ cantidad: 1, precio: 10 }] }));
    expect(o.items[0].name).toBe('Artículo');
  });

  it('items que no es un array no explota — queda sin ítems', () => {
    expect(aDashboardOrder(fila({ items: null })).items).toEqual([]);
    expect(aDashboardOrder(fila({ items: 'cualquier cosa' })).items).toEqual([]);
  });
});

describe('aDashboardOrder — contra entrega', () => {
  it('sin contra entrega no manda monto (el envío sale como flete común)', () => {
    expect(aDashboardOrder(fila({ contraEntrega: false })).cod_amount).toBeNull();
  });

  it('con contra entrega manda el total redondeado', () => {
    expect(aDashboardOrder(fila({ contraEntrega: true, totalUyu: 3490.4 })).cod_amount).toBe(3490);
  });

  it('contra entrega con total 0 manda null, no 0', () => {
    // planDeCod descarta el 0 igual, pero mandar null deja el motivo claro en
    // vez de hacer pasar por "cobro de $0" algo que es un pedido sin precio.
    expect(aDashboardOrder(fila({ contraEntrega: true, totalUyu: 0 })).cod_amount).toBeNull();
  });
});

describe('direccionParaDac — retiro en agencia', () => {
  it('sin agencia usa la dirección tal cual', () => {
    expect(direccionParaDac({ direccion: 'Gorlero 1234', agencia: null })).toBe('Gorlero 1234');
  });

  it('con agencia escribe la forma que DAC ya sabe leer', () => {
    const d = direccionParaDac({ direccion: null, agencia: 'Pinamar' });
    expect(d).toBe('Agencia DAC Pinamar');
    // Esto es lo que de verdad importa: que el pipeline lo tome como retiro en
    // sucursal (TipoEntrega=Agencia) y no como entrega a domicilio.
    expect(isPickupAtDacBranch(d, null, null)).toBe(true);
  });

  it('un texto que DAC ya reconoce se deja intacto', () => {
    // "Sucursal Dac Buceo" matchea /\bsucursal\s+(de\s+)?dac\b/: no se toca.
    expect(direccionParaDac({ direccion: null, agencia: 'Sucursal Dac Buceo' })).toBe('Sucursal Dac Buceo');
  });

  it('🔴 "Agencia Pocitos" NO lo reconoce DAC por sí solo — hay que normalizarlo', () => {
    // Este es el caso que hace falta cuidar: decir "agencia" no alcanza, el
    // patrón real exige "agencia DAC". Dejarlo crudo mandaría el paquete a
    // domicilio, a una calle llamada "Agencia Pocitos".
    expect(isPickupAtDacBranch('Agencia Pocitos', null, null)).toBe(false);
    const d = direccionParaDac({ direccion: null, agencia: 'Agencia Pocitos' });
    expect(d).toBe('Agencia DAC Pocitos');
    expect(isPickupAtDacBranch(d, null, null)).toBe(true);
  });

  it('cualquier nombre de agencia termina siendo reconocido como retiro', () => {
    for (const nombre of ['Pinamar', 'Agencia Pocitos', 'Sucursal Tres Cruces', 'Ciudad Del Plata']) {
      const d = direccionParaDac({ direccion: null, agencia: nombre });
      expect(isPickupAtDacBranch(d, null, null), `falló con "${nombre}"`).toBe(true);
    }
  });

  it('la agencia gana sobre la dirección: si eligió retirar, retira', () => {
    expect(direccionParaDac({ direccion: 'Gorlero 1234', agencia: 'Maldonado' })).toBe('Agencia DAC Maldonado');
  });

  it('sin dirección ni agencia devuelve null — ese pedido no se puede despachar', () => {
    expect(direccionParaDac({ direccion: null, agencia: null })).toBeNull();
    expect(direccionParaDac({ direccion: '   ', agencia: '  ' })).toBeNull();
  });
});

describe('identidad del pedido — la que usa el dedup de DAC', () => {
  it('el id del pedido sobrevive hasta la clave de dedup', () => {
    const o = aDashboardOrder(fila());
    const { order, dashboardId } = toShopifyOrder(o);
    expect(dashboardId).toBe('cmu1phiyx0007mrvlu2e06tpi');
    // `Label.shopifyOrderId` se guarda como String(order.id): es el mismo hash
    // que después usa la fuente para atar el pedido con su etiqueta.
    expect(String(order.id)).toBe(String(stableNumericId('cmu1phiyx0007mrvlu2e06tpi')));
  });

  it('dos pedidos distintos no colisionan', () => {
    const a = toShopifyOrder(aDashboardOrder(fila({ id: 'pedido-uno' })));
    const b = toShopifyOrder(aDashboardOrder(fila({ id: 'pedido-dos' })));
    expect(a.order.id).not.toBe(b.order.id);
  });
});

describe('el pedido traducido sobrevive al adaptador de DAC', () => {
  it('llega con dirección, departamento y teléfono — los tres que exige createShipment', () => {
    const { order, override } = toShopifyOrder(aDashboardOrder(fila()));
    const addr = order.shipping_address!;
    expect(addr.address1).toBe('Gorlero 1234 apto 302');
    expect(addr.province).toBe('Maldonado');
    expect(addr.phone).toBe('099887766');
    expect(override.recipientName).toBe('Carla Pérez');
  });

  it('un departamento con tilde llega a DAC sin tilde', () => {
    const { order } = toShopifyOrder(aDashboardOrder(fila({ departamento: 'Paysandú' })));
    expect(order.shipping_address!.province).toBe('Paysandu');
  });
});
