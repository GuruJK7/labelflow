/**
 * Normalización y validación de datos ANTES de llamar a AHIVA.
 *
 * Filosofía: AHIVA valida del lado del servidor y devuelve un fault genérico.
 * Un fault cuesta una llamada de red y no dice qué campo estaba mal. Así que
 * validamos acá, con mensajes accionables, y sólo llamamos al servicio cuando
 * el envío tiene chance real de entrar. Todo lo que no pasa se manda a
 * NEEDS_REVIEW con el motivo exacto — el mismo contrato que ya usa DAC.
 *
 * Este módulo es puro (sin I/O) para poder testearlo exhaustivamente.
 */

import {
  CORREO_DEPARTAMENTOS,
  CORREO_CELULAR_LARGO,
  CORREO_PESO_MAX_KG,
  CORREO_PESO_MIN_KG,
  type CorreoDepartamento,
} from './types';

/**
 * Saca tildes/diacríticos y pasa a mayúscula, PRESERVANDO la eñe.
 *
 * La ñ no es una vocal acentuada: es una letra propia del alfabeto español y
 * en NFD se descompone en `n` + tilde combinante, así que un strip ingenuo la
 * convierte en `N`. Ningún departamento uruguayo lleva ñ, con lo cual hoy el
 * resultado sería el mismo — pero esta función es de uso general y en cuanto se
 * aplique a barrios o calles ("Peñarol", "Cañada", "Nuñez") el strip ingenuo
 * corrompe el dato. Se protege la eñe antes de descomponer y se restaura.
 */
export function stripAccentsUpper(value: string): string {
  // U+0001 no puede aparecer en texto real (stripXmlControlChars ya lo filtra).
  const SENTINELA = '\u0001';
  return value
    .replace(/[ñÑ]/g, SENTINELA)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .split(SENTINELA)
    .join('Ñ')
    .trim();
}

/**
 * Alias que manda Shopify en `province` y que no matchean por normalización
 * directa. Shopify usa los nombres ISO de Uruguay, que en general coinciden,
 * pero estas variantes aparecen en datos reales del panel.
 */
const DEPARTAMENTO_ALIASES: Record<string, CorreoDepartamento> = {
  MONTEVIDEO: 'MONTEVIDEO',
  MVD: 'MONTEVIDEO',
  CANELONES: 'CANELONES',
  'CERRO LARGO': 'CERRO LARGO',
  'TREINTA Y TRES': 'TREINTA Y TRES',
  'TREINTA Y TRES DEPARTMENT': 'TREINTA Y TRES',
  'RIO NEGRO': 'RIO NEGRO',
  'SAN JOSE': 'SAN JOSE',
  PAYSANDU: 'PAYSANDU',
  TACUAREMBO: 'TACUAREMBO',
};

/**
 * Convierte el departamento a la grafía EXACTA que acepta AHIVA:
 * MAYÚSCULA y SIN tilde. Devuelve null si no es un departamento uruguayo
 * reconocible — en ese caso el envío NO se manda (mejor revisar que emitir
 * una guía a un destino equivocado).
 */
export function normalizarDepartamento(raw: string | null | undefined): CorreoDepartamento | null {
  if (!raw) return null;
  const norm = stripAccentsUpper(raw).replace(/\s+/g, ' ');
  if (!norm) return null;

  const alias = DEPARTAMENTO_ALIASES[norm];
  if (alias) return alias;

  const exact = CORREO_DEPARTAMENTOS.find((d) => d === norm);
  if (exact) return exact;

  // Shopify a veces sufija " Department" en direcciones cargadas en inglés.
  const sinSufijo = norm.replace(/\s+DEPARTMENT$/, '');
  const porSufijo = CORREO_DEPARTAMENTOS.find((d) => d === sinSufijo);
  return porSufijo ?? null;
}

/**
 * Normaliza un celular uruguayo al formato que exige AHIVA: numérico de largo
 * EXACTO 9, empezando en 0 (ej. "099123456").
 *
 * Acepta las formas que llegan de Shopify: "+598 99 123 456", "59899123456",
 * "099123456", "99123456". Rechaza fijos: Correo pide un celular para avisar
 * la entrega, y un fijo de 8 dígitos con un 0 adelante pasaría el chequeo de
 * largo pero no serviría para nada.
 *
 * Devuelve null si no se puede derivar un celular válido.
 */
export function normalizarCelular(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  // Prefijo internacional de Uruguay, con o sin 00 delante.
  if (digits.startsWith('00598')) digits = digits.slice(5);
  else if (digits.startsWith('598')) digits = digits.slice(3);

  // Sin el 0 de trunk: los móviles uruguayos son 9XXXXXXX (8 dígitos).
  if (digits.length === 8 && digits.startsWith('9')) digits = `0${digits}`;

  if (digits.length !== CORREO_CELULAR_LARGO) return null;
  // Con el 0 de trunk, un móvil siempre es 09XXXXXXX.
  if (!digits.startsWith('09')) return null;

  return digits;
}

/**
 * Valida un mail con el criterio mínimo razonable. AHIVA "valida formato" sin
 * documentar cuál, así que aplicamos algo estricto pero no exótico: un `@`,
 * dominio con punto, sin espacios.
 */
export function esMailValido(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim();
  if (v.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v);
}

/**
 * Resuelve el peso del paquete en kg.
 *
 * Contexto: DAC nunca pidió peso, así que las tiendas conectadas hoy en general
 * NO lo tienen cargado en Shopify. Correo lo exige (> 0 y < 30). Estrategia:
 * usar el peso real si vino, y si no, caer al default configurado por tienda.
 * Nunca inventamos un peso sin default explícito — devolver null hace que el
 * envío vaya a revisión en vez de despacharse con un peso falso que después
 * factura mal.
 *
 * @param gramosShopify suma de `grams` de la orden (0 o undefined si no hay)
 * @param defaultKg peso por defecto de la tienda (undefined si no configurado)
 */
export function resolverPesoKg(
  gramosShopify: number | null | undefined,
  defaultKg: number | null | undefined,
): { pesoKg: number } | { error: string } {
  const desdeShopify =
    typeof gramosShopify === 'number' && Number.isFinite(gramosShopify) && gramosShopify > 0
      ? gramosShopify / 1000
      : null;

  const candidato = desdeShopify ?? (typeof defaultKg === 'number' && defaultKg > 0 ? defaultKg : null);

  if (candidato === null) {
    return {
      error:
        'Sin peso: la orden no trae peso en Shopify y la tienda no tiene peso por defecto configurado',
    };
  }
  if (!Number.isFinite(candidato)) {
    return { error: `Peso inválido (${candidato} kg): debe ser mayor a 0` };
  }

  // Redondear ANTES de validar los límites. Si se valida primero, un peso de
  // 29.999 kg pasa el chequeo y después el redondeo lo deja en 30 — que es
  // justo el valor que AHIVA rechaza. Dos decimales: el servicio toma double,
  // pero mandar 1.3333333 es ruido.
  const pesoKg = Math.round(candidato * 100) / 100;

  if (pesoKg <= CORREO_PESO_MIN_KG) {
    return { error: `Peso inválido (${pesoKg} kg): debe ser mayor a 0` };
  }
  if (pesoKg >= CORREO_PESO_MAX_KG) {
    return {
      error: `Peso ${pesoKg} kg: Correo Uruguayo no acepta paquetes de ${CORREO_PESO_MAX_KG} kg o más`,
    };
  }

  return { pesoKg };
}

/**
 * En Montevideo, AHIVA usa el campo `localidad` para el BARRIO (misma semántica
 * que el K_Barrio de DAC). En el interior es la ciudad/localidad.
 */
export function resolverLocalidad(
  departamento: CorreoDepartamento,
  ciudad: string | null | undefined,
  barrio: string | null | undefined,
): string | null {
  if (departamento === 'MONTEVIDEO') {
    const b = (barrio ?? '').trim();
    if (b) return b;
    // Sin barrio no mandamos Montevideo: es la causa #1 de rechazo silencioso
    // que ya conocemos de DAC.
    return null;
  }
  const c = (ciudad ?? '').trim();
  return c || null;
}

/** Resultado de validar un destinatario antes de armar el envío. */
export type ValidacionDestinatario =
  | { ok: true; nombre: string; mail: string; celular: string }
  | { ok: false; motivo: string };

/**
 * Valida los tres campos que AHIVA exige del destinatario. Se corre ANTES de
 * construir el envelope para poder mandar el pedido a revisión con un motivo
 * legible por un humano, en vez de comerse un fault opaco.
 */
export function validarDestinatario(input: {
  nombre: string | null | undefined;
  mail: string | null | undefined;
  celular: string | null | undefined;
}): ValidacionDestinatario {
  const nombre = (input.nombre ?? '').trim();
  if (!nombre) return { ok: false, motivo: 'Falta el nombre del destinatario' };

  if (!esMailValido(input.mail)) {
    return {
      ok: false,
      motivo: `Correo Uruguayo exige un email válido del destinatario (recibido: ${input.mail ? `"${input.mail}"` : 'vacío'})`,
    };
  }

  const celular = normalizarCelular(input.celular);
  if (!celular) {
    return {
      ok: false,
      motivo: `Correo Uruguayo exige un celular uruguayo de 9 dígitos (recibido: ${input.celular ? `"${input.celular}"` : 'vacío'})`,
    };
  }

  return { ok: true, nombre, mail: (input.mail ?? '').trim(), celular };
}
