/**
 * De una planilla a pedidos: el mapeo de columnas.
 *
 * Lo que se cuida acá es que la importación no falle por cómo alguien escribió
 * un encabezado. Es el primer contacto del comerciante con el producto: si le
 * dice "no reconozco tu archivo" sin más, no vuelve.
 */
import { describe, it, expect } from 'vitest';
import { filasAPedidos, campoDeEncabezado, normalizarEncabezado, EJEMPLO_PLANTILLA } from '../importar-excel';
import { normalizarPedido } from '../pedido-interno';

describe('normalizarEncabezado', () => {
  it('saca tildes, mayúsculas y puntuación', () => {
    expect(normalizarEncabezado('Teléfono')).toBe('telefono');
    expect(normalizarEncabezado('  DIRECCIÓN DE ENVÍO ')).toBe('direccion de envio');
    expect(normalizarEncabezado('Talle / Color')).toBe('talle color');
  });
});

describe('campoDeEncabezado', () => {
  it('reconoce cómo escribe la gente cada columna', () => {
    expect(campoDeEncabezado('Teléfono')).toBe('telefono');
    expect(campoDeEncabezado('Celular')).toBe('telefono');
    expect(campoDeEncabezado('Cédula')).toBe('documento');
    expect(campoDeEncabezado('Destino')).toBe('departamento');
    expect(campoDeEncabezado('Dirección de envío')).toBe('direccion');
    expect(campoDeEncabezado('Forma de pago')).toBe('formaDePago');
    expect(campoDeEncabezado('Talle / Color')).toBe('variante');
  });

  it('una columna que no conocemos devuelve null, no adivina', () => {
    expect(campoDeEncabezado('Vendedor')).toBeNull();
    expect(campoDeEncabezado('')).toBeNull();
  });
});

describe('filasAPedidos', () => {
  const FILA = {
    Fecha: '03/09/2026',
    Nombre: 'Carla Pérez',
    'Teléfono': '099 887 766',
    'Cédula': '4512345',
    Departamento: 'Maldonado',
    'Dirección': 'Gorlero 1234',
    Producto: 'Perfume',
    'Talle / Color': '100ml',
    Cantidad: 2,
    Precio: 1390,
    'Forma de pago': 'Contra entrega',
  };

  it('mapea una fila completa', () => {
    const r = filasAPedidos([FILA]);
    expect(r.filas).toHaveLength(1);
    expect(r.columnasFaltantes).toEqual([]);
    const p = r.filas[0].pedido;
    expect(p.nombre).toBe('Carla Pérez');
    expect(p.departamento).toBe('Maldonado');
    expect(p.documento).toBe('4512345');
  });

  it('el talle/color se pega al nombre del producto', () => {
    // No hay columna de variante en el pedido: es parte de lo que dice la etiqueta.
    const p = filasAPedidos([FILA]).filas[0].pedido;
    expect((p.items as Array<{ nombre: string }>)[0].nombre).toBe('Perfume 100ml');
  });

  it('el número de fila coincide con el que ve en Excel', () => {
    // Fila 1 es el encabezado, así que el primer pedido es la fila 2.
    const r = filasAPedidos([FILA, { ...FILA, Nombre: 'Otro' }]);
    expect(r.filas.map((f) => f.fila)).toEqual([2, 3]);
  });

  it('saltea las filas vacías que Excel deja al final', () => {
    const vacia = Object.fromEntries(Object.keys(FILA).map((k) => [k, '']));
    const r = filasAPedidos([FILA, vacia, vacia]);
    expect(r.filas).toHaveLength(1);
  });

  it('avisa qué columnas no entendió, sin romper', () => {
    const r = filasAPedidos([{ ...FILA, Vendedor: 'Jose', 'Nº interno': 7 }]);
    expect(r.filas).toHaveLength(1);
    expect(r.columnasIgnoradas).toContain('Vendedor');
  });

  it('avisa qué columnas importantes faltan', () => {
    const r = filasAPedidos([{ Nombre: 'Carla', 'Dirección': 'X' }]);
    expect(r.columnasFaltantes).toContain('telefono');
    expect(r.columnasFaltantes).toContain('departamento');
    expect(r.columnasFaltantes).toContain('producto');
  });

  it('un archivo vacío no explota', () => {
    const r = filasAPedidos([]);
    expect(r.filas).toEqual([]);
    expect(r.columnasFaltantes.length).toBeGreaterThan(0);
  });
});

describe('el recorrido completo: planilla → pedido válido', () => {
  it('las dos filas de la plantilla de ejemplo pasan la validación', () => {
    // Si esto fallara, estaríamos ofreciendo para descargar una plantilla que
    // nuestro propio validador rechaza.
    const r = filasAPedidos(EJEMPLO_PLANTILLA);
    expect(r.filas).toHaveLength(2);
    for (const f of r.filas) {
      const v = normalizarPedido(f.pedido);
      expect(v.ok, `fila ${f.fila}: ${v.ok ? '' : v.errores.join(', ')}`).toBe(true);
    }
  });

  it('la fila con agencia y sin dirección es válida (la retira él)', () => {
    const v = normalizarPedido(filasAPedidos(EJEMPLO_PLANTILLA).filas[1].pedido);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.pedido.agencia).toBe('Tres Cruces');
    expect(v.pedido.direccion).toBeNull();
  });

  it('"Contra entrega" en la planilla prende el cobro al entregar', () => {
    const v = normalizarPedido(filasAPedidos(EJEMPLO_PLANTILLA).filas[0].pedido);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.pedido.contraEntrega).toBe(true);
    expect(v.pedido.totalUyu).toBe(1390);
  });

  it('"Transferencia" NO prende el cobro al entregar', () => {
    const v = normalizarPedido(filasAPedidos(EJEMPLO_PLANTILLA).filas[1].pedido);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.pedido.contraEntrega).toBe(false);
  });

  it('🔴 un precio escrito "1.390" llega como 1390, no como 1,39', () => {
    const r = filasAPedidos([{ ...EJEMPLO_PLANTILLA[0], Precio: '1.390' }]);
    const v = normalizarPedido(r.filas[0].pedido);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.pedido.totalUyu).toBe(1390);
  });

  it('una fila con el departamento mal se rechaza sola, sin frenar a las buenas', () => {
    const rota = { ...EJEMPLO_PLANTILLA[0], Departamento: 'Maldonaldo' };
    const r = filasAPedidos([EJEMPLO_PLANTILLA[0], rota, EJEMPLO_PLANTILLA[1]]);
    const validas = r.filas.filter((f) => normalizarPedido(f.pedido).ok);
    expect(validas).toHaveLength(2);
  });
});
