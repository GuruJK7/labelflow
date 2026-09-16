/**
 * Validación de un pedido de la carga propia.
 *
 * Funciones puras. Lo que se fija acá es lo que separa una planilla de Excel de
 * un envío real: si esto afloja, la fila entra a la base y revienta en DAC media
 * hora después, sin nadie mirando.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizarPedido,
  destinoLegible,
  parsearPrecio,
  parsearTelefono,
  parsearFecha,
  esContraEntrega,
} from '../pedido-interno';

const BASE = {
  nombre: 'Carla Pérez',
  telefono: '099 887 766',
  departamento: 'Maldonado',
  direccion: 'Gorlero 1234',
  items: [{ nombre: 'Perfume', cantidad: 2, precio: 1500 }],
};

describe('parsearPrecio — la trampa de los miles', () => {
  it('🔴 "1.390" en Uruguay son MIL TRESCIENTOS NOVENTA, no uno con treinta y nueve', () => {
    // Si el punto se tomara como decimal, el contrareembolso saldría por $1 y lo
    // descubriría el cartero en la puerta del comprador.
    expect(parsearPrecio('1.390')).toBe(1390);
    expect(parsearPrecio('12.500')).toBe(12500);
  });

  it('la coma siempre es decimal', () => {
    expect(parsearPrecio('1390,50')).toBe(1390.5);
    expect(parsearPrecio('1.390,50')).toBe(1390.5);
  });

  it('un punto que NO separa miles sí es decimal', () => {
    expect(parsearPrecio('1390.5')).toBe(1390.5);
    expect(parsearPrecio('99.99')).toBe(99.99);
  });

  it('se banca el signo y los espacios que mete la gente', () => {
    expect(parsearPrecio('$ 1.390')).toBe(1390);
    expect(parsearPrecio(' UYU 890 ')).toBe(890);
  });

  it('un número de Excel pasa tal cual', () => {
    expect(parsearPrecio(3490)).toBe(3490);
    expect(parsearPrecio(0)).toBe(0);
  });

  it('lo que no es precio devuelve null (no 0: 0 sería un cobro de $0)', () => {
    expect(parsearPrecio('gratis')).toBeNull();
    expect(parsearPrecio('')).toBeNull();
    expect(parsearPrecio(null)).toBeNull();
    expect(parsearPrecio(-5)).toBeNull();
  });
});

describe('parsearTelefono', () => {
  it('acepta cualquier grafía y conserva la original', () => {
    expect(parsearTelefono('099 887 766')).toBe('099 887 766');
    expect(parsearTelefono('+598 99 887 766')).toBe('+598 99 887 766');
  });
  it('rechaza lo que es muy corto para ser un teléfono', () => {
    expect(parsearTelefono('0998')).toBeNull();
    expect(parsearTelefono('')).toBeNull();
  });
});

describe('parsearFecha', () => {
  it('dd/mm/aaaa se lee como acá, no como en EEUU', () => {
    const f = parsearFecha('03/09/2026')!;
    expect(f.getDate()).toBe(3);
    expect(f.getMonth()).toBe(8); // septiembre
    expect(f.getFullYear()).toBe(2026);
  });
  it('dos dígitos de año se toman como 20xx', () => {
    expect(parsearFecha('03/09/26')!.getFullYear()).toBe(2026);
  });
  it('una fecha de Excel (Date) pasa tal cual', () => {
    const d = new Date(2026, 0, 15);
    expect(parsearFecha(d)).toBe(d);
  });
  it('lo ilegible devuelve null', () => {
    expect(parsearFecha('cuando sea')).toBeNull();
    expect(parsearFecha(null)).toBeNull();
  });
});

describe('esContraEntrega', () => {
  it('reconoce las formas en que la gente lo escribe', () => {
    for (const v of ['contra entrega', 'Contraentrega', 'CONTRA REEMBOLSO', 'COD', 'a cobrar', 'Efectivo al recibir']) {
      expect(esContraEntrega(v), `falló con "${v}"`).toBe(true);
    }
  });
  it('un pago ya hecho no es contra entrega', () => {
    for (const v of ['transferencia', 'Mercado Pago', 'pagado', '', null]) {
      expect(esContraEntrega(v), `falló con "${v}"`).toBe(false);
    }
  });
});

describe('normalizarPedido', () => {
  it('un pedido completo pasa y calcula el total', () => {
    const r = normalizarPedido(BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pedido.nombre).toBe('Carla Pérez');
    expect(r.pedido.departamento).toBe('Maldonado');
    expect(r.pedido.totalUyu).toBe(3000); // 2 × 1500
  });

  it('normaliza el departamento como lo escriba', () => {
    expect((normalizarPedido({ ...BASE, departamento: 'PAYSANDÚ' }) as { pedido: { departamento: string } }).pedido.departamento).toBe('Paysandu');
    expect((normalizarPedido({ ...BASE, departamento: 'san jose' }) as { pedido: { departamento: string } }).pedido.departamento).toBe('San Jose');
  });

  it('un departamento inventado se rechaza con su nombre en el mensaje', () => {
    const r = normalizarPedido({ ...BASE, departamento: 'Maldonaldo' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.some((e) => e.includes('Maldonaldo'))).toBe(true);
  });

  it('con agencia no hace falta dirección: lo retira él', () => {
    // Sigue valiendo lo de siempre —la dirección NO es obligatoria si retira en
    // una agencia— pero desde el 16-09-2026 la localidad sí: es lo único que
    // permite saber a cuál de las agencias del departamento va. Ver el bloque
    // "no dejar cargar un pedido que después no se va a poder despachar".
    const r = normalizarPedido({ ...BASE, direccion: null, agencia: 'Tres Cruces', localidad: 'Montevideo' });
    expect(r.ok).toBe(true);
  });

  it('sin dirección NI agencia se rechaza', () => {
    const r = normalizarPedido({ ...BASE, direccion: null, agencia: null });
    expect(r.ok).toBe(false);
  });

  it('devuelve TODOS los errores juntos, no el primero', () => {
    // Quien está corrigiendo 50 filas no quiere descubrirlos de a uno.
    const r = normalizarPedido({ nombre: null, telefono: null, departamento: null, direccion: null, items: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.length).toBeGreaterThanOrEqual(4);
  });

  it('un pedido sin productos no se despacha', () => {
    const r = normalizarPedido({ ...BASE, items: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.some((e) => e.includes('producto'))).toBe(true);
  });

  it('el precio con punto de miles sobrevive hasta el total', () => {
    // El recorrido completo de la trampa: si se rompiera acá, el pedido entraría
    // con total 1,39 y el contrareembolso saldría por $1.
    const r = normalizarPedido({ ...BASE, items: [{ nombre: 'Kit', cantidad: 1, precio: '1.390' }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pedido.totalUyu).toBe(1390);
  });

  it('el teléfono corto avisa que parece un error de tipeo', () => {
    const r = normalizarPedido({ ...BASE, telefono: '0998' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.some((e) => e.toLowerCase().includes('corto'))).toBe(true);
  });
});

describe('destinoLegible — cómo se muestra el destino', () => {
  it('sin agencia muestra la dirección', () => {
    expect(destinoLegible({ direccion: 'Gorlero 1234', agencia: null })).toBe('Gorlero 1234');
  });

  it('con agencia le antepone la palabra', () => {
    expect(destinoLegible({ direccion: null, agencia: 'Tres Cruces' })).toBe('Agencia Tres Cruces');
  });

  it('no la repite si el comerciante ya la escribió', () => {
    // Antes mostraba "Agencia Agencia Pocitos".
    expect(destinoLegible({ direccion: null, agencia: 'Agencia Pocitos' })).toBe('Agencia Pocitos');
    expect(destinoLegible({ direccion: null, agencia: 'Sucursal Buceo' })).toBe('Sucursal Buceo');
  });

  it('la agencia gana sobre la dirección', () => {
    expect(destinoLegible({ direccion: 'Gorlero 1234', agencia: 'Maldonado' })).toBe('Agencia Maldonado');
  });
});

describe('🔴 no dejar cargar un pedido que después no se va a poder despachar', () => {
  // El caso real que los originó (16-09-2026): un pedido con "Retira en una
  // agencia: Tres cruces" en Montevideo se guardó sin localidad y quedó
  // rebotando en cada corrida — "Correo tiene 17 oficinas en MONTEVIDEO y el
  // destino (sin localidad) no identifica ninguna" — sin ningún lugar donde
  // corregirlo. Ahora se frena en el formulario, con alguien mirando.

  it('agencia SIN localidad se rechaza: no se sabe a cuál de las agencias del departamento va', () => {
    const r = normalizarPedido({
      ...BASE,
      direccion: undefined,
      agencia: 'Tres cruces',
      departamento: 'Montevideo',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.some((e) => e.toLowerCase().includes('localidad'))).toBe(true);
  });

  it('agencia CON localidad pasa', () => {
    const r = normalizarPedido({
      ...BASE,
      direccion: undefined,
      agencia: 'Tres cruces',
      localidad: 'Montevideo',
      departamento: 'Montevideo',
    });
    expect(r.ok).toBe(true);
  });

  it('a domicilio NO exige localidad: ese camino nunca necesitó desempatar una agencia', () => {
    const r = normalizarPedido({ ...BASE, localidad: undefined });
    expect(r.ok).toBe(true);
  });

  it('🔴 "cobrar al entregar" con total $0 se rechaza: el repartidor no cobraría nada', () => {
    // `parsearItems` convierte un precio ilegible en 0 en silencio, así que un
    // "$1.390" mal tipeado llegaba hasta el cartero y la tienda entregaba gratis.
    const r = normalizarPedido({
      ...BASE,
      contraEntrega: true,
      items: [{ nombre: 'Perfume', cantidad: 1, precio: 'gratis' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.some((e) => e.includes('$ 0'))).toBe(true);
  });

  it('total $0 SIN contrareembolso sigue pasando: ya te lo pagaron, no hay nada que cobrar', () => {
    const r = normalizarPedido({
      ...BASE,
      contraEntrega: false,
      items: [{ nombre: 'Regalo', cantidad: 1, precio: 0 }],
    });
    expect(r.ok).toBe(true);
  });
});
