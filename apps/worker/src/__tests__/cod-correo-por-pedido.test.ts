import { describe, it, expect } from 'vitest';
import { pedidoDesdeOrden } from '../correo/adapter';
import { planDeCodCorreo, CORREO_COD_MONTO_MAX } from '../correo/cod';
import type { ShopifyOrder } from '../shopify/types';
import type { LocalidadCorreo } from '../correo/types';

/**
 * COBRO POR PEDIDO EN CORREO URUGUAYO.
 *
 * El cobro es del PEDIDO, no de la tienda: fuera de Maldonado el envío puede ir
 * por DAC o por Correo —lo elige el cliente— y en los dos casos sólo se cobra si
 * ESE pedido viene marcado a cobrar.
 *
 * QUÉ ESTABA MAL. La fuente panel no manda `financial_status`, así que
 * `yaEstaCobrado` devolvía false para TODOS sus pedidos, y el monto salía de
 * `montoAcobrar`, o sea del TOTAL. Con el cobro prendido, una tienda del panel
 * despachaba contra reembolso hasta los pedidos ya pagos — y por el importe
 * equivocado. El comentario de `payment-state.ts` («la fuente panel no manda el
 * campo porque sus pedidos son contra entrega por definición») describía un
 * mundo que dejó de existir cuando DEPO empezó a mandar las dos clases.
 */
const CATALOGO: LocalidadCorreo[] = [
  {
    nombre: 'Salto', ciudad: 'Salto', departamento: 'Salto', direccion: 'Uruguay 1234',
    codigoPostal: '50000', codigoAHIVA: 1, siteCode: 'SAL', telefono: '4732',
  },
];

const CFG_COBRA = { pesoDefaultKg: 0.3, oficinaDevolucion: null, contraEntrega: true };
const CFG_NO_COBRA = { pesoDefaultKg: 0.3, oficinaDevolucion: null, contraEntrega: false };

/** Pedido con dirección válida y total 990, para que el total y el monto por pedido no se confundan. */
const pedido = (o: Partial<ShopifyOrder> = {}): ShopifyOrder =>
  ({
    id: 1, name: '#1', email: 'a@b.com', total_price: '990', currency: 'UYU', tags: '',
    line_items: [], note: null, note_attributes: null,
    shipping_address: {
      first_name: 'Ana', last_name: 'P', phone: '099111222', address1: 'Uruguay 1',
      address2: '', city: 'Salto', province: 'Salto', zip: '50000', country: 'Uruguay',
    },
    ...o,
  }) as ShopifyOrder;

describe('cuando la fuente decide por pedido (panel / DEPO)', () => {
  it('cobra el monto DEL PEDIDO, no el total', () => {
    const r = pedidoDesdeOrden(pedido(), CATALOGO, CFG_COBRA as never, {
      codPorPedido: { monto: 1990 },
    });
    expect(r.ok).toBe(true);
    // 1990 es lo que marcó la marca; 990 es el total. Gana el pedido.
    if (r.ok) expect(r.pedido.codAmount).toBe(1990);
  });

  it('🔴 un pedido SIN cobro se despacha SIN cobro — no cae al total', () => {
    // Éste es el que se cobraba de más: sin `codPorPedido`, el panel no manda
    // `financial_status`, así que el pedido parecía impago y salía por $990.
    const r = pedidoDesdeOrden(pedido(), CATALOGO, CFG_COBRA as never, {
      codPorPedido: { monto: null },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pedido.codAmount).toBeNull();
  });

  it('con el interruptor de la tienda apagado no cobra, aunque la fuente mande monto', () => {
    const r = pedidoDesdeOrden(pedido(), CATALOGO, CFG_NO_COBRA as never, {
      codPorPedido: { monto: 1990 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pedido.codAmount).toBeNull();
  });

  it('el monto del pedido gana sobre `financial_status`', () => {
    // La fuente que sabe por pedido es la autoridad: si dice que se cobra, se
    // cobra, sin importar qué diga un campo que esa fuente no llena.
    const r = pedidoDesdeOrden(pedido({ financial_status: 'paid' }), CATALOGO, CFG_COBRA as never, {
      codPorPedido: { monto: 1990 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pedido.codAmount).toBe(1990);
  });
});

describe('cuando la fuente NO decide por pedido (Shopify) no cambia nada', () => {
  it('el pedido impago sigue cobrándose por el total', () => {
    const r = pedidoDesdeOrden(pedido({ financial_status: 'pending' }), CATALOGO, CFG_COBRA as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pedido.codAmount).toBe(990);
  });

  it('el pedido ya pagado sigue saliendo sin cobro', () => {
    const r = pedidoDesdeOrden(pedido({ financial_status: 'paid' }), CATALOGO, CFG_COBRA as never);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pedido.codAmount).toBeNull();
  });
});

describe('el tope de Correo es MUY distinto al de DAC', () => {
  it('un monto que DAC acepta puede no entrar en Correo, y va a revisión con motivo', () => {
    // DEPO deja cargar hasta 500.000 y DAC los acepta; Correo corta en 30.000.
    // Lo importante es que NO se despache en silencio sin cobrar: devuelve
    // `esCod:false` CON motivo, que es lo que manda el pedido a revisión.
    const plan = planDeCodCorreo({ codAmount: 50_000, nroReferencia: 'MAN-1' });
    expect(plan.esCod).toBe(false);
    expect('motivo' in plan && plan.motivo).toContain(String(CORREO_COD_MONTO_MAX));
  });

  it('dentro del tope sale como contrareembolso', () => {
    const plan = planDeCodCorreo({ codAmount: 1990, nroReferencia: 'MAN-1' });
    expect(plan.esCod).toBe(true);
    if (plan.esCod) expect(plan.monto).toBe(1990);
  });
});
