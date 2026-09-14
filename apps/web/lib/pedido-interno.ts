/**
 * Qué es un pedido válido para la carga propia.
 *
 * Módulo PURO: lo usan el alta manual (una fila), el importador de Excel
 * (muchas) y sus tests. Está separado a propósito — si cada camino validara por
 * su cuenta, el Excel terminaría aceptando cosas que el formulario rechaza, y la
 * fila entraría a la base para romper recién en DAC, media hora después, sin
 * nadie mirando.
 */
import { normalizarDepartamento } from './departamentos';

export interface ItemPedido {
  nombre: string;
  cantidad: number;
  precio: number;
}

export interface PedidoNormalizado {
  nombre: string;
  telefono: string;
  documento: string | null;
  departamento: string;
  localidad: string | null;
  direccion: string | null;
  agencia: string | null;
  referencia: string | null;
  items: ItemPedido[];
  totalUyu: number;
  contraEntrega: boolean;
  fechaVenta: Date | null;
  observaciones: string | null;
}

export type ResultadoPedido =
  | { ok: true; pedido: PedidoNormalizado }
  /** Un mensaje por campo, en criollo: se muestran tal cual al comerciante. */
  | { ok: false; errores: string[] };

/** Lo que llega del formulario o de una fila de Excel, sin ninguna garantía. */
export interface PedidoCrudo {
  nombre?: unknown;
  telefono?: unknown;
  documento?: unknown;
  departamento?: unknown;
  localidad?: unknown;
  direccion?: unknown;
  agencia?: unknown;
  referencia?: unknown;
  items?: unknown;
  contraEntrega?: unknown;
  fechaVenta?: unknown;
  observaciones?: unknown;
}

const str = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t === '' ? null : t;
};

/**
 * Un precio escrito por una persona o por Excel.
 *
 * 🔴 Acá vive la trampa que más caro sale: en Uruguay "1.390" son mil
 * trescientos noventa pesos, no uno con treinta y nueve. Si el punto se toma
 * como decimal, el contrareembolso sale por $1 y lo descubre el cartero.
 *
 * Regla: la coma SIEMPRE es decimal. El punto es decimal sólo si lo que le sigue
 * NO son exactamente 3 dígitos (que sería separador de miles).
 */
export function parsearPrecio(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  const s = str(v);
  if (s === null) return null;
  const limpio = s.replace(/[^\d.,-]/g, ''); // saca "$", "UYU", espacios
  if (limpio === '' || !/\d/.test(limpio)) return null;

  let normal: string;
  if (limpio.includes(',')) {
    // Con coma presente, el punto sólo puede ser separador de miles.
    normal = limpio.replace(/\./g, '').replace(',', '.');
  } else {
    const m = limpio.match(/\.(\d+)$/);
    normal = m && m[1].length === 3 ? limpio.replace(/\./g, '') : limpio;
  }

  const n = Number(normal);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** "099 123 456", "+598 99 123 456" → dígitos. Se acepta cualquier grafía. */
export function parsearTelefono(v: unknown): string | null {
  const s = str(v);
  if (s === null) return null;
  const digitos = s.replace(/[^\d]/g, '');
  // Un teléfono uruguayo tiene 8 dígitos (o 11 con el 598). Menos de 7 es un
  // error de tipeo, no un número: DAC lo rechazaría igual, mejor avisar acá.
  return digitos.length >= 7 ? s : null;
}

/** dd/mm/aaaa (lo que escribe la gente acá) o lo que Excel haya puesto. */
export function parsearFecha(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = str(v);
  if (s === null) return null;
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    const [, d, mes, a] = m;
    const anio = a.length === 2 ? 2000 + Number(a) : Number(a);
    const fecha = new Date(anio, Number(mes) - 1, Number(d));
    return Number.isNaN(fecha.getTime()) ? null : fecha;
  }
  const iso = new Date(s);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

/** "contra entrega", "contraentrega", "cod", "a cobrar" → true. */
export function esContraEntrega(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const s = str(v);
  if (s === null) return false;
  const n = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /contra\s*entrega|contra\s*reembolso|contrareembolso|\bcod\b|a\s*cobrar|efectivo\s*al\s*recibir/.test(n);
}

function parsearItems(v: unknown): ItemPedido[] {
  if (!Array.isArray(v)) return [];
  const out: ItemPedido[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const it = raw as Record<string, unknown>;
    const nombre = str(it.nombre);
    if (!nombre) continue;
    const precio = parsearPrecio(it.precio) ?? 0;
    const cantidadCruda = parsearPrecio(it.cantidad);
    const cantidad = Math.max(1, Math.trunc(cantidadCruda ?? 1) || 1);
    out.push({ nombre, cantidad, precio });
  }
  return out;
}

/**
 * Valida y normaliza. Devuelve TODOS los errores juntos, no el primero: quien
 * está corrigiendo una planilla de 50 filas no quiere descubrirlos de a uno.
 */
export function normalizarPedido(crudo: PedidoCrudo): ResultadoPedido {
  const errores: string[] = [];

  const nombre = str(crudo.nombre);
  if (!nombre) errores.push('Falta el nombre de quien recibe');

  const telefono = parsearTelefono(crudo.telefono);
  if (!telefono) {
    errores.push(
      str(crudo.telefono) ? 'El teléfono es muy corto (mirá si falta un dígito)' : 'Falta el teléfono',
    );
  }

  const deptoCrudo = str(crudo.departamento);
  const departamento = normalizarDepartamento(deptoCrudo);
  if (!departamento) {
    errores.push(
      deptoCrudo
        ? `No reconozco el departamento "${deptoCrudo}"`
        : 'Falta el departamento',
    );
  }

  const direccion = str(crudo.direccion);
  const agencia = str(crudo.agencia);
  // Una de las dos alcanza: o va a domicilio, o lo retira en una agencia.
  if (!direccion && !agencia) errores.push('Falta la dirección (o el nombre de la agencia donde retira)');

  const items = parsearItems(crudo.items);
  if (items.length === 0) errores.push('El pedido no tiene ningún producto');

  if (errores.length > 0) return { ok: false, errores };

  const totalUyu = items.reduce((s, it) => s + it.precio * it.cantidad, 0);

  return {
    ok: true,
    pedido: {
      nombre: nombre!,
      telefono: telefono!,
      documento: str(crudo.documento),
      departamento: departamento!,
      localidad: str(crudo.localidad),
      direccion,
      agencia,
      referencia: str(crudo.referencia),
      items,
      totalUyu,
      contraEntrega: esContraEntrega(crudo.contraEntrega),
      fechaVenta: parsearFecha(crudo.fechaVenta),
      observaciones: str(crudo.observaciones),
    },
  };
}
