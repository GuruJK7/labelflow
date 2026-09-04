import { describe, it, expect } from 'vitest';
import { el, elRequired, escapeXml, extractFault, stripXmlControlChars } from '../correo/soap';
import {
  construirCargaMasivaEnvelope,
  parsearCargaMasivaRespuesta,
  serializarEnvio,
} from '../correo/client';
import type { DataEnvio } from '../correo/types';

const envioBase: DataEnvio = {
  soloDestinatario: false,
  destinatario: { nombre: 'Ana Pérez', mail: 'ana@gmail.com', celular: '099123456' },
  lugarEntrega: {
    departamento: 'MONTEVIDEO',
    localidad: 'Pocitos',
    calle: 'Juan Benito Blanco',
    nroPuerta: '992',
  },
  paquetesSimples: [{ peso: 1.5, responsableServEntrega: 'REMITENTE', referencia: 'Pedido #1234' }],
};

describe('correo/soap — escapado', () => {
  it('escapa los caracteres que romperían el envelope', () => {
    expect(escapeXml('Rivera & Propios')).toBe('Rivera &amp; Propios');
    expect(escapeXml('<script>')).toBe('&lt;script&gt;');
    expect(escapeXml(`comilla " y '`)).toBe('comilla &quot; y &apos;');
  });

  it('una dirección con & no rompe el XML generado', () => {
    // Caso real: "Av. Italia & Bulevar". Sin escapar, el servidor devuelve un
    // fault de parseo que no dice qué campo estaba mal.
    const xml = serializarEnvio({
      ...envioBase,
      lugarEntrega: { ...envioBase.lugarEntrega, calle: 'Av. Italia & Bulevar' },
    });
    expect(xml).toContain('Av. Italia &amp; Bulevar');
    expect(xml).not.toMatch(/Italia & Bul/);
  });

  it('saca caracteres de control ilegales en XML 1.0', () => {
    expect(stripXmlControlChars('abc\x00def')).toBe('abcdef');
    expect(stripXmlControlChars('a\x07b')).toBe('ab');
    // Tab y salto de línea son legales y se conservan.
    expect(stripXmlControlChars('a\tb\nc')).toBe('a\tb\nc');
  });
});

describe('correo/soap — serialización de elementos', () => {
  it('omite los opcionales vacíos', () => {
    expect(el('calle', undefined)).toBe('');
    expect(el('calle', null)).toBe('');
    expect(el('calle', '')).toBe('');
    expect(el('calle', '   ')).toBe('');
  });

  it('serializa el 0 numérico (empaque 0 = "no precisa", no es ausencia)', () => {
    expect(el('empaque', 0)).toBe('<empaque>0</empaque>');
  });

  it('elRequired emite el campo aunque sea falsy', () => {
    expect(elRequired('soloDestinatario', false)).toBe('<soloDestinatario>false</soloDestinatario>');
    expect(elRequired('peso', 0)).toBe('<peso>0</peso>');
  });

  it('no emite NaN/Infinity como valor numérico', () => {
    expect(el('peso', NaN)).toBe('');
    expect(elRequired('peso', Infinity)).toBe('<peso>0</peso>');
  });
});

describe('correo/client — orden del xs:sequence', () => {
  // JAXB rechaza el request si los elementos vienen desordenados, así que el
  // orden es parte del contrato, no una cuestión de estilo.
  it('dataEnvio respeta el orden del XSD y cierra con soloDestinatario', () => {
    const xml = serializarEnvio(envioBase);
    const orden = ['destinatario', 'lugarEntrega', 'paquetesSimples', 'soloDestinatario'];
    const posiciones = orden.map((t) => xml.indexOf(`<${t}>`));
    expect(posiciones.every((p) => p >= 0)).toBe(true);
    expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);
  });

  it('dataPaquete respeta el orden del XSD (peso antes de referencia)', () => {
    const xml = serializarEnvio(envioBase);
    expect(xml.indexOf('<peso>')).toBeLessThan(xml.indexOf('<referencia>'));
    expect(xml.indexOf('<referencia>')).toBeLessThan(xml.indexOf('<responsableServEntrega>'));
  });

  it('lugarEntrega respeta calle < departamento < localidad < nroPuerta', () => {
    const xml = serializarEnvio(envioBase);
    const p = ['<calle>', '<departamento>', '<localidad>', '<nroPuerta>'].map((t) => xml.indexOf(t));
    expect([...p].sort((a, b) => a - b)).toEqual(p);
  });
});

describe('correo/client — envelope de cargaMasiva', () => {
  it('mapea las credenciales a arg0..arg3 en orden', () => {
    const xml = construirCargaMasivaEnvelope(
      { user: 'u1', password: 'secreta', cuenta: 'C1', subcuenta: 'S1' },
      [{ clave: 'prioritario', valor: 'si' }],
      [envioBase],
    );
    expect(xml).toContain('<arg0>u1</arg0>');
    expect(xml).toContain('<arg1>secreta</arg1>');
    expect(xml).toContain('<arg2>C1</arg2>');
    expect(xml).toContain('<arg3>S1</arg3>');
    expect(xml.indexOf('<arg0>')).toBeLessThan(xml.indexOf('<arg4>'));
    expect(xml.indexOf('<arg4>')).toBeLessThan(xml.indexOf('<arg5>'));
  });

  it('omite cuenta/subcuenta en clientes contado', () => {
    const xml = construirCargaMasivaEnvelope({ user: 'u', password: 'p' }, [], [envioBase]);
    expect(xml).not.toContain('<arg2>');
    expect(xml).not.toContain('<arg3>');
  });

  it('produce un envelope SOAP 1.1 bien formado', () => {
    const xml = construirCargaMasivaEnvelope({ user: 'u', password: 'p' }, [], [envioBase]);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('xmlns:web="http://webservices/"');
    expect(xml.trim().endsWith('</soapenv:Envelope>')).toBe(true);
    // Etiquetas balanceadas de apertura/cierre para los tags que emitimos.
    const abiertas = (xml.match(/<arg5>/g) ?? []).length;
    const cerradas = (xml.match(/<\/arg5>/g) ?? []).length;
    expect(abiertas).toBe(cerradas);
  });

  it('un contra reembolso lleva sus paquetes adentro, no en paquetesSimples', () => {
    const xml = serializarEnvio({
      ...envioBase,
      paquetesSimples: undefined,
      contraReembolsos: [
        {
          monto: 2500,
          nroreferencia: '#1234',
          responsableServContraReembolso: 'REMITENTE',
          paquetes: [{ peso: 2, responsableServEntrega: 'DESTINATARIO' }],
        },
      ],
    });
    expect(xml).toContain('<contraReembolsos>');
    expect(xml).toContain('<monto>2500</monto>');
    expect(xml).toContain('<paquetes>');
    expect(xml).not.toContain('<paquetesSimples>');
  });
});

describe('correo/client — parseo de la respuesta', () => {
  const respuestaOk = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
    <ns2:cargaMasivaResponse xmlns:ns2="http://webservices/"><return>
      <codigoRespuesta>0</codigoRespuesta>
      <descripcionRespuesta>EXITO</descripcionRespuesta>
      <esError>false</esError>
      <envios>
        <codigostrazabilidad>PC123456789UY</codigostrazabilidad>
        <etiquetasGeneradas>JVBERi0xLjQK</etiquetasGeneradas>
        <costos><costoTotal_remitente>320</costoTotal_remitente><costoTotal_destinatario>0</costoTotal_destinatario></costos>
      </envios>
    </return></ns2:cargaMasivaResponse></soap:Body></soap:Envelope>`;

  it('extrae guía, etiqueta y costos ignorando los prefijos de namespace', () => {
    const r = parsearCargaMasivaRespuesta(respuestaOk);
    expect(r.esError).toBe(false);
    expect(r.codigoRespuesta).toBe(0);
    expect(r.descripcionRespuesta).toBe('EXITO');
    expect(r.envios).toHaveLength(1);
    expect(r.envios[0].codigostrazabilidad).toEqual(['PC123456789UY']);
    expect(r.envios[0].etiquetasBase64).toBe('JVBERi0xLjQK');
    expect(r.envios[0].costos?.costoTotalRemitente).toBe(320);
  });

  it('soporta varios paquetes en un mismo envío', () => {
    const dos = respuestaOk.replace(
      '<codigostrazabilidad>PC123456789UY</codigostrazabilidad>',
      '<codigostrazabilidad>PC1UY</codigostrazabilidad><codigostrazabilidad>PC2UY</codigostrazabilidad>',
    );
    expect(parsearCargaMasivaRespuesta(dos).envios[0].codigostrazabilidad).toEqual(['PC1UY', 'PC2UY']);
  });

  it('tira error si la respuesta no tiene <return>', () => {
    expect(() => parsearCargaMasivaRespuesta('<soap:Envelope/>')).toThrow(/sin elemento/i);
  });
});

describe('correo/soap — SOAP Fault', () => {
  it('detecta el fault y devuelve su descripción', () => {
    const fault = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
      <soap:Fault><faultcode>soap:Server</faultcode><faultstring>Usuario o password incorrecto</faultstring></soap:Fault>
    </soap:Body></soap:Envelope>`;
    expect(extractFault(fault)).toBe('Usuario o password incorrecto');
  });

  it('una respuesta normal no se confunde con un fault', () => {
    expect(extractFault('<return><esError>false</esError></return>')).toBeNull();
  });
});
