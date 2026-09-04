/**
 * Tests del contrareembolso y la oficina de devolución de Correo Uruguayo.
 *
 * El foco son los cuatro modos de falla que cuestan plata de verdad:
 *   1. el paquete duplicado en `paquetesSimples` Y en `contraReembolsos[].paquetes`
 *      → AHIVA factura dos piezas por una sola caja
 *   2. un monto fuera de tope tratado como "no es contrareembolso"
 *      → la mercadería se entrega y nadie la cobra
 *   3. una oficina de devolución casi-correcta
 *      → el paquete que no se pudo entregar vuelve a una sucursal equivocada
 *   4. el contrareembolso sin nº de referencia
 *      → Correo cobra pero no puede liquidarle la plata al remitente
 *
 * El último bloque reproduce, campo por campo, el envío real del tutorial del
 * portal AhíVA (contrareembolso $1990 + entrega en la oficina Ciudad Vieja +
 * devolución en AREVALO) y verifica el sobre SOAP que saldría por el cable.
 */

import { describe, it, expect } from 'vitest';
import {
  CORREO_COD_MONTO_MAX,
  estimarCargoCodUYU,
  esContrareembolso,
  planDeCodCorreo,
} from '../correo/cod';
import { construirEnvio, type PedidoParaCorreo } from '../correo/validate';
import { serializarEnvio } from '../correo/client';
import { CorreoEmpaque, type LocalidadCorreo } from '../correo/types';

/**
 * Catálogo con los datos REALES de las dos oficinas del tutorial, tal cual los
 * devuelve `obtenerLocalidadesCorreo()` de producción (verificado 2026-09-03).
 * Se usan los valores reales a propósito: la etiqueta del tutorial imprime
 * "MISIONES 1328 / CP 11000" y "35300 AREVALO Cerro Largo", que es exactamente
 * lo que hay acá — si el catálogo cambia, el test lo nota.
 */
const CATALOGO: LocalidadCorreo[] = [
  {
    nombre: 'Ciudad Vieja',
    ciudad: 'Montevideo',
    departamento: 'Montevideo',
    direccion: 'MISIONES 1328',
    codigoPostal: '11000',
    codigoAHIVA: 712,
    siteCode: 'VCC',
    telefono: '29160200 Int. 415/416',
  },
  {
    nombre: 'AREVALO',
    ciudad: 'Arevalo',
    departamento: 'Cerro Largo',
    direccion: 'Ruta 38 Km 35',
    codigoPostal: '35300',
    codigoAHIVA: 48905,
    siteCode: 'CKH',
    telefono: '4640-4826',
  },
];

function pedidoConCobro(over: Partial<PedidoParaCorreo> = {}): PedidoParaCorreo {
  return {
    referencia: 'AE-2001',
    nombre: 'Ana Pérez',
    mail: 'ana@ejemplo.com',
    celular: '099123456',
    oficinaCorreo: 'Ciudad Vieja',
    oficinaDevolucion: 'AREVALO',
    pesoKg: 2,
    contenido: 'Indumentaria',
    codAmount: 1990,
    ...over,
  };
}

describe('planDeCodCorreo — qué NO es contrareembolso', () => {
  // Todos estos son envíos normales, no errores: el pedido simplemente no lleva
  // cobro. Devolver un motivo acá mandaría a revisión a la mayoría del volumen.
  const noSonCod: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['cero', 0],
    ['negativo', -500],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['string', '1990'],
    ['redondea a cero', 0.4],
  ];

  for (const [caso, valor] of noSonCod) {
    it(`${caso} → no es contrareembolso y no genera motivo de rechazo`, () => {
      const plan = planDeCodCorreo({ codAmount: valor as number | null }, 'AE-1');
      expect(plan.esCod).toBe(false);
      expect(plan).not.toHaveProperty('motivo');
    });
  }
});

describe('planDeCodCorreo — sí es contrareembolso pero no se puede despachar', () => {
  it('un monto por encima del tope de Correo se rechaza con motivo, no se despacha sin cobro', () => {
    const plan = planDeCodCorreo({ codAmount: CORREO_COD_MONTO_MAX + 1 }, 'AE-1');
    expect(plan.esCod).toBe(false);
    // Este es EL test que evita el bug caro: sin `motivo`, el envío saldría como
    // un paquete simple y la mercadería se entregaría sin cobrar.
    expect(plan).toHaveProperty('motivo');
    expect('motivo' in plan && plan.motivo).toContain(String(CORREO_COD_MONTO_MAX));
  });

  it('el tope es inclusivo: exactamente $30.000 sí se despacha', () => {
    const plan = planDeCodCorreo({ codAmount: CORREO_COD_MONTO_MAX }, 'AE-1');
    expect(plan.esCod).toBe(true);
  });

  it('sin nº de referencia propia ni referencia de pedido, se rechaza con motivo', () => {
    const plan = planDeCodCorreo({ codAmount: 1990 }, '');
    expect(plan.esCod).toBe(false);
    expect('motivo' in plan && plan.motivo).toMatch(/referencia/i);
  });
});

describe('planDeCodCorreo — valores que viajan', () => {
  it('el monto se redondea a entero: AHIVA y el portal no manejan centavos', () => {
    const plan = planDeCodCorreo({ codAmount: 1990.6 }, 'AE-1');
    expect(plan.esCod && plan.monto).toBe(1991);
  });

  it('sin nroReferencia propia usa la referencia del pedido', () => {
    const plan = planDeCodCorreo({ codAmount: 1990 }, 'AE-2001');
    expect(plan.esCod && plan.nroreferencia).toBe('AE-2001');
  });

  it('la nroReferencia propia le gana a la del pedido', () => {
    const plan = planDeCodCorreo({ codAmount: 1990, nroReferencia: 'FC-A-1234' }, 'AE-2001');
    expect(plan.esCod && plan.nroreferencia).toBe('FC-A-1234');
  });

  it('el servicio de contrareembolso lo paga el destinatario por default', () => {
    const plan = planDeCodCorreo({ codAmount: 1990 }, 'AE-1');
    expect(plan.esCod && plan.responsableServContraReembolso).toBe('DESTINATARIO');
  });

  it('se puede pedir que lo pague el remitente', () => {
    const plan = planDeCodCorreo({ codAmount: 1990, pagaServicioCod: 'REMITENTE' }, 'AE-1');
    expect(plan.esCod && plan.responsableServContraReembolso).toBe('REMITENTE');
  });

  it('esContrareembolso responde lo mismo que el plan', () => {
    expect(esContrareembolso({ codAmount: 1990 }, 'AE-1')).toBe(true);
    expect(esContrareembolso({ codAmount: null }, 'AE-1')).toBe(false);
    expect(esContrareembolso({ codAmount: 999_999 }, 'AE-1')).toBe(false);
  });

  it('el cargo estimado sigue el tarifario: $111 + 1% del valor', () => {
    expect(estimarCargoCodUYU(1990)).toBe(131); // 111 + 19.9 → 130.9 → 131
    expect(estimarCargoCodUYU(0)).toBeNull();
    expect(estimarCargoCodUYU(CORREO_COD_MONTO_MAX + 1)).toBeNull();
  });
});

describe('construirEnvio — el paquete va en UNA sola lista', () => {
  it('con cobro: el paquete vive en contraReembolsos y paquetesSimples queda vacío', () => {
    const r = construirEnvio(pedidoConCobro(), CATALOGO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.envio.contraReembolsos).toHaveLength(1);
    expect(r.envio.contraReembolsos?.[0].paquetes).toHaveLength(1);
    expect(r.envio.contraReembolsos?.[0].monto).toBe(1990);
    // El bug caro: si el paquete aparece también acá, AHIVA factura dos piezas.
    expect(r.envio.paquetesSimples).toBeUndefined();
  });

  it('sin cobro: sigue saliendo como paquete simple, sin contraReembolsos', () => {
    const r = construirEnvio(pedidoConCobro({ codAmount: null }), CATALOGO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.envio.paquetesSimples).toHaveLength(1);
    expect(r.envio.contraReembolsos).toBeUndefined();
  });

  it('el peso, el empaque y el almacenamiento del paquete no cambian por llevar cobro', () => {
    const conCobro = construirEnvio(pedidoConCobro(), CATALOGO);
    const sinCobro = construirEnvio(pedidoConCobro({ codAmount: null }), CATALOGO);
    if (!conCobro.ok || !sinCobro.ok) throw new Error('ambos tenían que construir');

    expect(conCobro.envio.contraReembolsos?.[0].paquetes[0]).toEqual(
      sinCobro.envio.paquetesSimples?.[0],
    );
  });

  it('un monto fuera de tope NO se despacha: el envío entero va a revisión', () => {
    const r = construirEnvio(pedidoConCobro({ codAmount: 45_000 }), CATALOGO);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivos.join(' ')).toMatch(/no cobra en destino más de/i);
  });
});

describe('construirEnvio — oficina de devolución', () => {
  it('la oficina de devolución se valida contra el catálogo y viaja en datosdevolucion', () => {
    const r = construirEnvio(pedidoConCobro(), CATALOGO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envio.datosdevolucion).toEqual({ oficinaCorreo: 'AREVALO' });
  });

  it('una oficina de devolución que no existe rechaza el envío y sugiere', () => {
    const r = construirEnvio(pedidoConCobro({ oficinaDevolucion: 'Arevalos' }), CATALOGO);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.motivos.join(' ')).toMatch(/oficina de devolución "Arevalos" no existe/i);
  });

  it('se manda la grafía del catálogo, no la que escribió el operador', () => {
    const r = construirEnvio(pedidoConCobro({ oficinaDevolucion: 'arévalo' }), CATALOGO);
    // "arévalo" normaliza a AREVALO (sin tilde, mayúscula): matchea el catálogo.
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envio.datosdevolucion?.oficinaCorreo).toBe('AREVALO');
    expect(r.avisos.join(' ')).toMatch(/devolución normalizada/i);
  });

  it('sin oficina de devolución el envío sale igual, pero con aviso', () => {
    const r = construirEnvio(pedidoConCobro({ oficinaDevolucion: null }), CATALOGO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envio.datosdevolucion).toBeUndefined();
    expect(r.avisos.join(' ')).toMatch(/Sin oficina de devolución/i);
  });
});

describe('el envío real del tutorial de AhíVA, campo por campo', () => {
  /**
   * Reproduce la carga del portal:
   *   paso 2 → celular 091205055, nombre "Diego Fraschini", entrega sólo a
   *            destinatario = No
   *   paso 3 → peso "De 0 a 2 Kilos" (el portal manda 2.0), empaque "Ya tengo
   *            empaque" (= 0), entrega paga el destinatario, 10 días de
   *            almacenamiento, mercadería a cobrar en destino = Sí,
   *            contrarrembolso lo paga el destinatario, referencia "1",
   *            moneda $, valor total 1990
   *   paso 4 → entrega en Oficina CORREO URUGUAYO, Montevideo, Ciudad Vieja
   *   paso 5 → oficina de devolución AREVALO
   */
  const tutorial: PedidoParaCorreo = {
    referencia: 'AE-TUTORIAL',
    nombre: 'Diego Fraschini',
    mail: 'diego@ejemplo.com',
    celular: '091205055',
    oficinaCorreo: 'Ciudad Vieja',
    oficinaDevolucion: 'AREVALO',
    pesoKg: 2,
    empaque: CorreoEmpaque.NoPrecisa,
    almacenamiento: 10,
    pagaFlete: 'DESTINATARIO',
    codAmount: 1990,
    codReferencia: '1',
    pagaServicioCod: 'DESTINATARIO',
    contenido: 'Indumentaria',
  };

  it('construye el envío completo sin motivos de rechazo', () => {
    const r = construirEnvio(tutorial, CATALOGO);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.envio.soloDestinatario).toBe(false);
    expect(r.envio.destinatario).toEqual({
      nombre: 'Diego Fraschini',
      mail: 'diego@ejemplo.com',
      celular: '091205055',
    });
    // Entrega en sucursal: sólo viaja la oficina, sin departamento ni calle —
    // los completa AHIVA desde su propio catálogo (en el portal, Calle/CP/
    // Teléfono se autocompletan y quedan de sólo lectura).
    expect(r.envio.lugarEntrega).toEqual({ oficinaCorreo: 'Ciudad Vieja' });
    expect(r.envio.datosdevolucion).toEqual({ oficinaCorreo: 'AREVALO' });

    const cr = r.envio.contraReembolsos?.[0];
    expect(cr?.monto).toBe(1990);
    expect(cr?.nroreferencia).toBe('1');
    expect(cr?.responsableServContraReembolso).toBe('DESTINATARIO');
    expect(cr?.paquetes[0]).toEqual({
      peso: 2,
      responsableServEntrega: 'DESTINATARIO',
      referencia: 'Indumentaria',
      empaque: 0,
      almacenamiento: 10,
    });
  });

  it('el sobre SOAP lleva el cobro y la devolución, y no duplica el paquete', () => {
    const r = construirEnvio(tutorial, CATALOGO);
    if (!r.ok) throw new Error('el envío del tutorial tenía que construir');

    const xml = serializarEnvio(r.envio);

    expect(xml).toContain('<contraReembolsos>');
    expect(xml).toContain('<monto>1990</monto>');
    expect(xml).toContain('<nroreferencia>1</nroreferencia>');
    expect(xml).toContain('<responsableServContraReembolso>DESTINATARIO</responsableServContraReembolso>');
    expect(xml).toContain('<datosdevolucion><oficinaCorreo>AREVALO</oficinaCorreo></datosdevolucion>');
    expect(xml).toContain('<oficinaCorreo>Ciudad Vieja</oficinaCorreo>');
    expect(xml).toContain('<soloDestinatario>false</soloDestinatario>');

    // Una sola pieza en el sobre entero.
    expect(xml).not.toContain('<paquetesSimples>');
    expect(xml.match(/<paquetes>/g) ?? []).toHaveLength(1);
  });

  it('el orden de los elementos respeta la secuencia alfabética del XSD de dataEnvio', () => {
    const r = construirEnvio(tutorial, CATALOGO);
    if (!r.ok) throw new Error('el envío del tutorial tenía que construir');

    const xml = serializarEnvio(r.envio);
    // El XSD de AHIVA declara dataEnvio como xs:sequence en orden alfabético.
    // Mandarlos desordenados es un rechazo de parseo, no un error de negocio.
    const orden = ['contraReembolsos', 'datosdevolucion', 'destinatario', 'lugarEntrega', 'soloDestinatario'];
    const posiciones = orden.map((t) => xml.indexOf(`<${t}>`));
    expect(posiciones).toEqual([...posiciones].sort((a, b) => a - b));
    expect(posiciones.every((p) => p >= 0)).toBe(true);
  });
});
