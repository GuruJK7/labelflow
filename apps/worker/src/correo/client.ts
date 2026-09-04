/**
 * Cliente del WebService de carga de envíos de Correo Uruguayo (AHIVA).
 *
 * Endpoints (del documento oficial "CARGA ENVIOS"):
 *   TEST → https://ahivatest.correo.com.uy/web/CargaMasivaServicev4
 *   PROD → https://ahiva.correo.com.uy/web/CargaMasivaServicev4
 *
 * Diferencia central con DAC: esto es una llamada HTTP sincrónica que devuelve
 * el número de seguimiento Y el PDF de la etiqueta en la misma respuesta. No
 * hay browser, ni captcha, ni geocoding, ni "guía huérfana" — o el servicio
 * responde con códigos de trazabilidad, o responde con un error explícito.
 */

import axios, { AxiosError } from 'axios';
import logger from '../logger';
import {
  buildEnvelope,
  el,
  elRequired,
  extractFault,
  pickAll,
  pickBoolean,
  pickNumber,
  pickText,
} from './soap';
import {
  CorreoError,
  type CargaMasivaResultado,
  type CorreoCredenciales,
  type DataContraReembolso,
  type DataEnvio,
  type DataLugarEntrega,
  type DataPaquete,
  type DataParametro,
  type DataRetiro,
  type EnvioResultado,
  type LocalidadCorreo,
} from './types';

export const CORREO_ENDPOINTS = {
  test: 'https://ahivatest.correo.com.uy/web/CargaMasivaServicev4',
  prod: 'https://ahiva.correo.com.uy/web/CargaMasivaServicev4',
} as const;

export type CorreoAmbiente = keyof typeof CORREO_ENDPOINTS;

/**
 * Catch-all interno de AHIVA. Llega con `esError=true` igual que un rechazo de
 * validación, pero su descripción es «Error interno : reintente el pedido»:
 * el servidor está diciendo que no sabe, no que rechazó.
 * Verificado en vivo contra ahivatest el 04-09-2026.
 */
const CODIGO_ERROR_INTERNO = 99;

/** Timeout por defecto. La carga masiva genera PDFs, así que es generoso. */
const DEFAULT_TIMEOUT_MS = 90_000;

/** Tope de respuesta: las etiquetas vienen en base64 y pueden pesar. */
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Serialización (el orden de los campos sigue el xs:sequence del WSDL)
// ---------------------------------------------------------------------------

function serializarPaquete(tag: string, p: DataPaquete): string {
  return (
    `<${tag}>` +
    el('almacenamiento', p.almacenamiento) +
    el('codigoBarrasCliente', p.codigoBarrasCliente) +
    el('empaque', p.empaque) +
    el('garantiaplus', p.garantiaplus) +
    el('motivodevolucion', p.motivodevolucion) +
    // `peso` no tiene minOccurs=0 en el XSD: va siempre.
    elRequired('peso', p.peso) +
    el('referencia', p.referencia) +
    el('responsableServEntrega', p.responsableServEntrega) +
    el('valordeclarado', p.valordeclarado) +
    `</${tag}>`
  );
}

function serializarDireccion(tag: string, d: DataLugarEntrega): string {
  return (
    `<${tag}>` +
    el('calle', d.calle) +
    el('departamento', d.departamento) +
    el('localidad', d.localidad) +
    el('manzana', d.manzana) +
    el('nroApto', d.nroApto) +
    el('nroPuerta', d.nroPuerta) +
    el('observacionesDireccion', d.observacionesDireccion) +
    el('oficinaCorreo', d.oficinaCorreo) +
    el('solar', d.solar) +
    `</${tag}>`
  );
}

function serializarContraReembolso(cr: DataContraReembolso): string {
  return (
    `<contraReembolsos>` +
    // `monto` es obligatorio en el XSD.
    elRequired('monto', cr.monto) +
    el('nroreferencia', cr.nroreferencia) +
    cr.paquetes.map((p) => serializarPaquete('paquetes', p)).join('') +
    el('responsableServContraReembolso', cr.responsableServContraReembolso) +
    `</contraReembolsos>`
  );
}

export function serializarEnvio(envio: DataEnvio): string {
  return (
    `<arg5>` +
    el('cedulaDestinatario', envio.cedulaDestinatario) +
    (envio.contraReembolsos ?? []).map(serializarContraReembolso).join('') +
    (envio.datosdevolucion ? serializarDireccion('datosdevolucion', envio.datosdevolucion) : '') +
    `<destinatario>` +
    el('celular', envio.destinatario.celular) +
    el('mail', envio.destinatario.mail) +
    el('nombre', envio.destinatario.nombre) +
    `</destinatario>` +
    (envio.facturasConformadas ?? [])
      .map(
        (fc) =>
          `<facturasConformadas>` +
          el('nroreferencia', fc.nroreferencia) +
          fc.paquetes.map((p) => serializarPaquete('paquetes', p)).join('') +
          `</facturasConformadas>`,
      )
      .join('') +
    serializarDireccion('lugarEntrega', envio.lugarEntrega) +
    (envio.paquetesSimples ?? []).map((p) => serializarPaquete('paquetesSimples', p)).join('') +
    // `soloDestinatario` es el único campo sin minOccurs=0 en dataEnvio.
    elRequired('soloDestinatario', envio.soloDestinatario) +
    `</arg5>`
  );
}

function serializarRetiro(r: DataRetiro): string {
  return (
    `<arg6>` +
    el('contacto', r.contacto) +
    el('desde', r.desde) +
    el('direccion', r.direccion) +
    el('fecha', r.fecha.toISOString()) +
    el('hasta', r.hasta) +
    el('mail', r.mail) +
    el('telefono', r.telefono) +
    `</arg6>`
  );
}

/**
 * Arma el envelope completo de `cargaMasiva`.
 *
 * Se exporta aparte del transporte para poder testear el XML generado sin
 * tocar la red — que es exactamente lo que hace la suite de tests.
 */
export function construirCargaMasivaEnvelope(
  cred: CorreoCredenciales,
  parametros: DataParametro[],
  envios: DataEnvio[],
  retiro?: DataRetiro,
): string {
  const body =
    `<web:cargaMasiva>` +
    el('arg0', cred.user) +
    el('arg1', cred.password) +
    el('arg2', cred.cuenta) +
    el('arg3', cred.subcuenta) +
    parametros
      .map((p) => `<arg4>` + el('clave', p.clave) + el('valor', p.valor) + `</arg4>`)
      .join('') +
    envios.map(serializarEnvio).join('') +
    (retiro ? serializarRetiro(retiro) : '') +
    `</web:cargaMasiva>`;
  return buildEnvelope(body);
}

// ---------------------------------------------------------------------------
// Parseo de la respuesta
// ---------------------------------------------------------------------------

export function parsearCargaMasivaRespuesta(xml: string): CargaMasivaResultado {
  const ret = pickAll(xml, 'return')[0];
  if (ret === undefined) {
    throw new CorreoError('Respuesta de AHIVA sin elemento <return>', null, true);
  }

  const envios: EnvioResultado[] = pickAll(ret, 'envios').map((e) => {
    const codigos = pickAll(e, 'codigostrazabilidad').map((c) => c.trim()).filter(Boolean);
    const etiquetas = pickAll(e, 'etiquetasGeneradas')[0]?.trim();
    const remito = pickAll(e, 'remito')[0]?.trim();
    const costosXml = pickAll(e, 'costos')[0];
    return {
      codigostrazabilidad: codigos,
      etiquetasBase64: etiquetas || undefined,
      remitoBase64: remito || undefined,
      costos: costosXml
        ? {
            costoTotalRemitente: pickNumber(costosXml, 'costoTotal_remitente') ?? 0,
            costoTotalDestinatario: pickNumber(costosXml, 'costoTotal_destinatario') ?? 0,
          }
        : undefined,
    };
  });

  return {
    codigoRespuesta: pickNumber(ret, 'codigoRespuesta') ?? -1,
    descripcionRespuesta: pickText(ret, 'descripcionRespuesta') ?? '',
    esError: pickBoolean(ret, 'esError') ?? false,
    envios,
  };
}

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

async function postSoap(
  endpoint: string,
  envelope: string,
  soapAction: string,
  timeoutMs: number,
): Promise<string> {
  try {
    const res = await axios.post<string>(endpoint, envelope, {
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        SOAPAction: soapAction,
      },
      timeout: timeoutMs,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
      // Queremos ver el body del 500 para poder leer el Fault.
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(d) => d],
    });

    const body = typeof res.data === 'string' ? res.data : String(res.data);

    const fault = extractFault(body);
    if (fault) {
      // Un fault es una respuesta del negocio (credenciales/validación), no un
      // fallo de infraestructura: reintentar no cambia el resultado.
      throw new CorreoError(`AHIVA rechazó la solicitud: ${fault}`, null, false);
    }

    if (res.status < 200 || res.status >= 300) {
      throw new CorreoError(
        `AHIVA respondió HTTP ${res.status}`,
        res.status,
        res.status >= 500 || res.status === 429,
      );
    }

    return body;
  } catch (err) {
    if (err instanceof CorreoError) throw err;
    const ax = err as AxiosError;
    const esRed =
      ax.code === 'ECONNABORTED' ||
      ax.code === 'ETIMEDOUT' ||
      ax.code === 'ECONNRESET' ||
      ax.code === 'ENOTFOUND' ||
      ax.code === 'EAI_AGAIN';
    throw new CorreoError(
      `Fallo de red hablando con AHIVA: ${ax.code ?? ax.message}`,
      null,
      esRed,
    );
  }
}

/**
 * Pre-admite envíos en AHIVA y devuelve códigos de trazabilidad + etiquetas.
 *
 * NUNCA loguea `password` ni el contenido del envelope (lleva credenciales y
 * datos personales del destinatario).
 */
export async function cargaMasiva(opts: {
  ambiente: CorreoAmbiente;
  credenciales: CorreoCredenciales;
  envios: DataEnvio[];
  parametros?: DataParametro[];
  retiro?: DataRetiro;
  timeoutMs?: number;
}): Promise<CargaMasivaResultado> {
  const endpoint = CORREO_ENDPOINTS[opts.ambiente];
  const envelope = construirCargaMasivaEnvelope(
    opts.credenciales,
    opts.parametros ?? [],
    opts.envios,
    opts.retiro,
  );

  logger.info(
    {
      ambiente: opts.ambiente,
      envios: opts.envios.length,
      usuario: opts.credenciales.user,
      cuenta: opts.credenciales.cuenta ?? null,
    },
    '[correo] cargaMasiva →',
  );

  const body = await postSoap(endpoint, envelope, '', opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const resultado = parsearCargaMasivaRespuesta(body);

  logger.info(
    {
      ambiente: opts.ambiente,
      codigoRespuesta: resultado.codigoRespuesta,
      esError: resultado.esError,
      guias: resultado.envios.flatMap((e) => e.codigostrazabilidad).length,
    },
    '[correo] cargaMasiva ←',
  );

  if (resultado.esError) {
    // 🔴 `esError` NO alcanza para afirmar que no se creó nada.
    //
    // Verificado en vivo contra ahivatest el 04-09-2026: AHIVA devuelve
    // `codigoRespuesta=99` con `esError=true` y la descripción textual
    // «Error interno : reintente el pedido». O sea que su catch-all interno
    // viaja por el MISMO campo que un rechazo de validación — y el servidor
    // pide explícitamente reintentar, que es lo contrario de "no creé nada".
    // Tratarlo como rechazo probado borraba el marcador de idempotencia y la
    // corrida siguiente emitía una segunda guía con un segundo cobro.
    //
    // Por eso 99 es reintentable y NO es rechazo probado. Si aparece otro
    // código con semántica de "error interno", va acá: el catálogo de códigos
    // de AHIVA no está publicado, así que sólo se puede ir agregando lo que se
    // observe. Ante un código desconocido, el default sigue siendo "sí es
    // rechazo", que es lo que hace utilizable el transportista; el freno duro
    // contra el doble cobro es la guía ya persistida en el Label.
    const esInterno = resultado.codigoRespuesta === CODIGO_ERROR_INTERNO;
    throw new CorreoError(
      `AHIVA devolvió error ${resultado.codigoRespuesta}: ${resultado.descripcionRespuesta}`,
      resultado.codigoRespuesta,
      esInterno,
      !esInterno,
    );
  }

  return resultado;
}

/**
 * Lista las oficinas de correo. No requiere credenciales — verificado en vivo
 * contra producción el 2026-08-01 (devolvió 195 oficinas).
 *
 * Se usa para dos cosas: validar el `oficinaCorreo` de una entrega en sucursal,
 * y alimentar el selector de puntos de retiro.
 */
/**
 * Un campo de texto del catálogo, con los "null"/"undefined" literales tratados
 * como vacío. Correo los manda así en vez de omitir el elemento.
 */
function textoOVacio(v: string | undefined): string {
  const t = (v ?? '').trim();
  return /^(null|undefined)$/i.test(t) ? '' : t;
}

export async function obtenerLocalidadesCorreo(
  ambiente: CorreoAmbiente = 'prod',
  timeoutMs = 30_000,
): Promise<LocalidadCorreo[]> {
  const envelope = buildEnvelope('<web:obtenerLocalidadesCorreo/>');
  const body = await postSoap(CORREO_ENDPOINTS[ambiente], envelope, '', timeoutMs);

  return pickAll(body, 'return').map((r) => ({
    nombre: pickText(r, 'nombre') ?? '',
    ciudad: pickText(r, 'ciudad') ?? '',
    departamento: pickText(r, 'departamento') ?? '',
    // El catálogo devuelve la CADENA "null" cuando no tiene el dato: verificado
    // el 04-09-2026 contra producción, en "Cainsa" (Artigas) y "Centro Cercania
    // ( Joaquín Suarez)" (Canelones). Sin sanear acá, ese texto viaja hasta la
    // pantalla del comerciante como «Retira en Cainsa — null».
    direccion: textoOVacio(pickText(r, 'direccion')),
    codigoPostal: (pickText(r, 'codigoPostal') ?? '').trim(),
    codigoAHIVA: Number(pickText(r, 'codigoAHIVA') ?? 0),
    siteCode: pickText(r, 'siteCode') ?? '',
    telefono: textoOVacio(pickText(r, 'telefono')),
  }));
}
