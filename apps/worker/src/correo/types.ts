/**
 * Tipos del dominio del WebService de carga de envíos de Correo Uruguayo
 * (plataforma AHIVA, servicio `CargaMasivaServicev4`).
 *
 * Fuente: WSDL de producción — https://ahiva.correo.com.uy/web/CargaMasivaServicev4?wsdl
 * (esquema leído el 2026-08-01) + documentación oficial "CARGA ENVIOS"
 * publicada en correo.com.uy/servicios-web.
 *
 * NADA de este módulo se importa desde el flujo DAC. Es un carrier nuevo,
 * completamente aislado: si nadie importa `correo/`, el binario del worker
 * se comporta byte-idéntico a como venía.
 */

/** Departamentos tal cual los acepta AHIVA: MAYÚSCULA y SIN tilde. */
export const CORREO_DEPARTAMENTOS = [
  'ARTIGAS',
  'CANELONES',
  'CERRO LARGO',
  'COLONIA',
  'DURAZNO',
  'FLORES',
  'FLORIDA',
  'LAVALLEJA',
  'MALDONADO',
  'MONTEVIDEO',
  'PAYSANDU',
  'RIO NEGRO',
  'RIVERA',
  'ROCHA',
  'SALTO',
  'SAN JOSE',
  'SORIANO',
  'TACUAREMBO',
  'TREINTA Y TRES',
] as const;

export type CorreoDepartamento = (typeof CORREO_DEPARTAMENTOS)[number];

/**
 * Quién paga el servicio. Mapea 1:1 con nuestro `PaymentType` de Prisma, así
 * que la regla de negocio existente (`rules/payment.ts`, umbral en UYU) se
 * reusa sin traducción.
 */
export type ResponsablePago = 'REMITENTE' | 'DESTINATARIO';

/**
 * Código de empaque provisto por Correo. 0 = el cliente pone su propia caja.
 * Cualquier otro valor se factura aparte (ver Tarifas Ahíva).
 */
export enum CorreoEmpaque {
  NoPrecisa = 0,
  Tipo1_25x20x6 = 1,
  Tipo2_30x25x15 = 2,
  Tipo3_50x40x25 = 3,
}

/**
 * Días que la oficina destino conserva el paquete antes de devolverlo al
 * remitente. 10 es gratis; 20 tiene costo extra. Si se omite, AHIVA asume 10.
 */
export type CorreoAlmacenamiento = 10 | 20;

/** Límites duros que valida el servidor de AHIVA (documentados). */
export const CORREO_PESO_MIN_KG = 0;
export const CORREO_PESO_MAX_KG = 30;
/** El celular se valida como numérico de largo EXACTO 9. */
export const CORREO_CELULAR_LARGO = 9;

/** Datos de la persona que recibe. Los tres campos figuran en la etiqueta. */
export interface DataDestinatario {
  /** Se valida formato de mail. Obligatorio. */
  mail: string;
  /** Numérico, largo exacto 9 (ej. "099123456"). Obligatorio. */
  celular: string;
  nombre: string;
}

/**
 * Dirección de entrega. Dos modos excluyentes:
 *  - a domicilio → departamento + localidad + calle obligatorios
 *  - a oficina   → `oficinaCorreo` con un nombre de la lista de
 *                  `obtenerLocalidadesCorreo()`
 */
export interface DataLugarEntrega {
  calle?: string;
  /** MAYÚSCULA sin tilde. */
  departamento?: string;
  /** Localidad/ciudad. En Montevideo este campo es el BARRIO. */
  localidad?: string;
  manzana?: string;
  nroApto?: string;
  nroPuerta?: string;
  /** Notas para el cartero. */
  observacionesDireccion?: string;
  /** Nombre de la oficina de correo destino (entrega en sucursal). */
  oficinaCorreo?: string;
  solar?: string;
}

/** Dirección de devolución si no se puede entregar. Misma forma que la de entrega. */
export type DataDevolucion = DataLugarEntrega;

export interface DataPaquete {
  /** Kilogramos. Decimal, > 0 y < 30. Obligatorio. */
  peso: number;
  /** Obligatorio en la práctica: quién paga el servicio de entrega. */
  responsableServEntrega?: ResponsablePago;
  /** Descripción del contenido; se imprime en la etiqueta. */
  referencia?: string;
  empaque?: CorreoEmpaque;
  /** Obligatorio sólo en logística inversa. */
  motivodevolucion?: number;
  almacenamiento?: CorreoAlmacenamiento;
  /** Si se envía, REEMPLAZA a `referencia` en la etiqueta. */
  codigoBarrasCliente?: string;
  garantiaplus?: boolean;
  /** Exigido si `garantiaplus` es true. En pesos. */
  valordeclarado?: number;
}

/** Mercadería a cobrar al destinatario (contra reembolso / COD). */
export interface DataContraReembolso {
  /** Valor total de la mercadería. Obligatorio. */
  monto: number;
  /** Nro de factura o referencia de control del remitente. Obligatorio. */
  nroreferencia: string;
  /** Quién paga el COSTO del servicio de contra reembolso. */
  responsableServContraReembolso?: ResponsablePago;
  /** Los paquetes que llevan la mercadería a cobrar. */
  paquetes: DataPaquete[];
}

export interface DataFacturaConformada {
  nroreferencia: string;
  paquetes: DataPaquete[];
}

/**
 * Un envío = el conjunto de paquetes que van de un remitente a un mismo
 * destinatario/lugar de entrega.
 *
 * Regla de asociación (documentada): `paquetesSimples` son SÓLO los paquetes
 * SIN mercadería a cobrar. Los que sí llevan cobro van dentro de
 * `contraReembolsos[].paquetes`. No se duplican.
 */
export interface DataEnvio {
  /** Único campo sin `minOccurs=0` en el XSD: siempre se serializa. */
  soloDestinatario: boolean;
  /** Obligatorio sólo si `soloDestinatario` es true. Sin puntos ni guiones. */
  cedulaDestinatario?: string;
  destinatario: DataDestinatario;
  lugarEntrega: DataLugarEntrega;
  datosdevolucion?: DataDevolucion;
  paquetesSimples?: DataPaquete[];
  contraReembolsos?: DataContraReembolso[];
  facturasConformadas?: DataFacturaConformada[];
}

/** Parámetros de la invocación: prioritario / inversa / ceibal. */
export interface DataParametro {
  clave: 'prioritario' | 'inversa' | 'ceibal';
  valor: 'si' | 'no';
}

/** Agendado de recolección. Exclusivo de clientes crédito. */
export interface DataRetiro {
  fecha: Date;
  /** Hora (entero). */
  desde: number;
  hasta: number;
  contacto: string;
  direccion: string;
  telefono: string;
  mail: string;
}

/** Credenciales del cliente en AHIVA. `cuenta`/`subcuenta` sólo para crédito. */
export interface CorreoCredenciales {
  user: string;
  password: string;
  cuenta?: string;
  subcuenta?: string;
}

/** Desglose de costos que devuelve AHIVA por envío. */
export interface DataCostos {
  costoTotalRemitente: number;
  costoTotalDestinatario: number;
}

/** Un envío ya procesado por AHIVA. */
export interface EnvioResultado {
  /** Uno por paquete. Es el nº de seguimiento. */
  codigostrazabilidad: string[];
  /** PDF de las etiquetas, en base64, tal cual lo devuelve el servicio. */
  etiquetasBase64?: string;
  remitoBase64?: string;
  costos?: DataCostos;
}

/** Respuesta completa de `cargaMasiva`. */
export interface CargaMasivaResultado {
  codigoRespuesta: number;
  descripcionRespuesta: string;
  esError: boolean;
  envios: EnvioResultado[];
}

/** Una oficina de correo, de `obtenerLocalidadesCorreo`. */
export interface LocalidadCorreo {
  nombre: string;
  ciudad: string;
  departamento: string;
  direccion: string;
  codigoPostal: string;
  codigoAHIVA: number;
  siteCode: string;
  telefono: string;
}

/**
 * Error tipado del carrier. Se distingue `retryable` para que el job pueda
 * decidir entre reintentar (red / 5xx) y mandar a NEEDS_REVIEW (datos malos),
 * sin parsear strings.
 */
export class CorreoError extends Error {
  constructor(
    message: string,
    readonly codigo: number | null,
    readonly retryable: boolean,
    /**
     * `true` SÓLO cuando AHIVA contestó explícitamente que no aceptó el envío.
     * Es la única prueba de que NO se creó nada del otro lado.
     *
     * 🔴 NO derivar esto de `retryable`. Son dos preguntas distintas:
     * `retryable` responde "¿conviene reintentar?" y esto responde "¿puedo
     * afirmar que no se creó nada?". Un corte de red mientras AHIVA devuelve la
     * etiqueta no es reintentable Y TAMPOCO prueba que el envío no exista —
     * confundirlos borra el marcador de idempotencia y emite una segunda guía
     * con un segundo cobro al comprador.
     *
     * Ante la duda va en `false`: un marcador que sobra cuesta una revisión a
     * mano; uno que falta cuesta cobrarle dos veces a una persona real.
     */
    readonly esRechazoDeNegocio: boolean = false,
  ) {
    super(message);
    this.name = 'CorreoError';
  }
}
