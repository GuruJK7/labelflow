/**
 * Mínimo de SOAP necesario para hablar con AHIVA — sin dependencias nuevas.
 *
 * Por qué a mano y no una librería: el servicio expone DOS operaciones con un
 * esquema chico y estable (document/literal wrapped, JAX-WS). Un cliente SOAP
 * genérico traería parsing de WSDL en runtime y varios MB de dependencias para
 * resolver algo que son ~150 líneas. `axios` ya está en el worker, así que el
 * costo de este módulo es cero deps nuevas (ver .claude/rules/performance.md).
 *
 * El orden de los elementos NO es cosmético: el XSD los declara dentro de un
 * `xs:sequence`, así que JAXB rechaza el request si vienen desordenados. Cada
 * builder de acá respeta el orden exacto del WSDL de producción.
 */

/** Namespace destino del servicio (targetNamespace del WSDL). */
export const CORREO_NS = 'http://webservices/';

/**
 * Escapa texto para insertarlo como contenido de un elemento XML.
 *
 * Crítico para direcciones reales: un `&` en "Rivera & Propios" o un `<` suelto
 * rompen el envelope entero y el servidor devuelve un fault de parseo que no
 * dice nada útil. Escapamos también comillas para poder reusar la función si
 * alguna vez hace falta un atributo.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Quita caracteres de control que son ilegales en XML 1.0 aunque estén
 * escapados. Shopify deja pasar cosas raras en notas y direcciones; si uno de
 * estos llega al envelope, el servidor corta la conexión sin explicación.
 */
export function stripXmlControlChars(value: string): string {
  // Permitidos: \t (09), \n (0A), \r (0D). El resto de C0 y el DEL se van.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/** Serializa un elemento simple. Devuelve '' si el valor es null/undefined/''. */
export function el(name: string, value: string | number | boolean | undefined | null): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    const clean = stripXmlControlChars(value).trim();
    if (clean === '') return '';
    return `<${name}>${escapeXml(clean)}</${name}>`;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return `<${name}>${value}</${name}>`;
  }
  return `<${name}>${value ? 'true' : 'false'}</${name}>`;
}

/**
 * Serializa un elemento que SIEMPRE debe aparecer, incluso vacío o en cero.
 * Se usa para los campos sin `minOccurs="0"` en el XSD (`soloDestinatario`,
 * `peso`, `monto`): omitirlos es un error de validación del lado del servidor.
 */
export function elRequired(name: string, value: string | number | boolean): string {
  if (typeof value === 'boolean') return `<${name}>${value ? 'true' : 'false'}</${name}>`;
  if (typeof value === 'number') return `<${name}>${Number.isFinite(value) ? value : 0}</${name}>`;
  return `<${name}>${escapeXml(stripXmlControlChars(value))}</${name}>`;
}

/** Envuelve un cuerpo ya serializado en un Envelope SOAP 1.1. */
export function buildEnvelope(bodyXml: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="${CORREO_NS}">` +
    `<soapenv:Header/>` +
    `<soapenv:Body>${bodyXml}</soapenv:Body>` +
    `</soapenv:Envelope>`
  );
}

/**
 * Extrae el contenido de la PRIMERA aparición de un tag, ignorando prefijos de
 * namespace (`<ns2:foo>` matchea con `foo`). Devuelve null si no está.
 */
export function pickTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`);
  const m = re.exec(xml);
  return m ? m[1] : null;
}

/** Extrae TODAS las apariciones de un tag al mismo nivel. */
export function pickAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Deshace el escapado XML de un valor de texto. */
export function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Texto de un tag simple, ya des-escapado y trimeado. */
export function pickText(xml: string, tag: string): string | undefined {
  const raw = pickTag(xml, tag);
  if (raw === null) return undefined;
  return unescapeXml(raw).trim();
}

export function pickNumber(xml: string, tag: string): number | undefined {
  const t = pickText(xml, tag);
  if (t === undefined || t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

export function pickBoolean(xml: string, tag: string): boolean | undefined {
  const t = pickText(xml, tag);
  if (t === undefined) return undefined;
  return t.toLowerCase() === 'true';
}

/**
 * Detecta un SOAP Fault y devuelve su mensaje.
 *
 * Un fault es la forma en que AHIVA reporta credenciales inválidas y errores de
 * validación, y viene con HTTP 500 — por eso hay que mirarlo ANTES de tratar el
 * status code como un fallo de red reintentable.
 */
export function extractFault(xml: string): string | null {
  if (!/<(?:\w+:)?Fault[\s>]/.test(xml)) return null;
  const faultstring = pickText(xml, 'faultstring');
  const message = pickText(xml, 'message');
  return faultstring || message || 'SOAP Fault sin descripción';
}
