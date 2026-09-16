/**
 * De una planilla a pedidos.
 *
 * Módulo PURO: recibe las filas YA parseadas (objetos `{ encabezado: celda }`) y
 * devuelve `PedidoCrudo[]`. No importa `xlsx` a propósito, por dos motivos:
 *
 *   1. Testeable sin armar un .xlsx de mentira.
 *   2. 🔴 El parseo del archivo pasa en el NAVEGADOR, no acá. `xlsx@0.18.5` —la
 *      última que SheetJS publicó en npm— arrastra CVE-2023-30533 (prototype
 *      pollution al leer un archivo armado a mano). Leyendo del lado del cliente,
 *      el archivo de un comerciante sólo puede afectar su propia pestaña, nunca
 *      el proceso del servidor. No se pierde nada: el servidor igual re-valida
 *      TODO con `normalizarPedido`, así que nunca confió en lo que viene.
 *
 * El comerciante llena una plantilla nuestra, pero la gente renombra columnas y
 * les pone tildes o mayúsculas. Por eso el encabezado se busca por alias
 * normalizados en vez de exigir una grafía exacta: que la importación falle
 * porque alguien escribió "Teléfono" en vez de "telefono" sería absurdo.
 */
import type { PedidoCrudo } from './pedido-interno';

/** Cada campo con las formas en que la gente lo escribe. Todo normalizado. */
const ALIAS: Record<string, string[]> = {
  fecha: ['fecha', 'fecha de venta', 'fecha venta', 'dia'],
  nombre: ['nombre', 'cliente', 'nombre del cliente', 'destinatario', 'nombre y apellido', 'quien recibe'],
  telefono: ['telefono', 'tel', 'celular', 'cel', 'whatsapp', 'contacto'],
  // Sin «correo» a secas a propósito: la segunda pasada (la floja, por
  // contención) lo habría encontrado en cualquier encabezado que hablara del
  // transportista. «Correo electrónico» sí, que no se confunde con nada.
  email: ['email', 'e mail', 'mail', 'correo electronico', 'email del cliente', 'mail del cliente', 'email cliente'],
  documento: ['cedula', 'ci', 'documento', 'doc', 'rut'],
  departamento: ['departamento', 'depto', 'destino', 'dpto'],
  localidad: ['localidad', 'ciudad', 'barrio', 'pueblo'],
  direccion: ['direccion', 'direccion de envio', 'domicilio', 'calle', 'direccion envio'],
  agencia: ['agencia', 'sucursal', 'retiro', 'agencia dac'],
  producto: ['producto', 'productos', 'articulo', 'articulos', 'detalle', 'descripcion', 'item', 'items'],
  variante: ['talle', 'color', 'talle color', 'talle y color', 'variante', 'medida'],
  cantidad: ['cantidad', 'cant', 'unidades', 'qty'],
  precio: ['precio', 'importe', 'monto', 'total', 'valor', 'precio unitario'],
  formaDePago: ['forma de pago', 'pago', 'medio de pago', 'formadepago', 'cobro'],
  referencia: ['referencia', 'ref', 'entre calles', 'esquina'],
  observaciones: ['observaciones', 'obs', 'notas', 'comentarios', 'aclaraciones'],
};

/** minúsculas, sin tildes, sin puntuación, espacios colapsados. */
export function normalizarEncabezado(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** encabezado del archivo → campo nuestro. Devuelve null si no lo reconocemos. */
export function campoDeEncabezado(encabezado: string): string | null {
  const n = normalizarEncabezado(encabezado);
  if (!n) return null;
  for (const [campo, alias] of Object.entries(ALIAS)) {
    if (alias.includes(n)) return campo;
  }
  // Segunda pasada, más floja: "nombre del comprador" contiene "nombre". Sólo
  // se acepta si UN solo campo matchea, para no elegir a los tropezones.
  const candidatos = Object.entries(ALIAS).filter(([, alias]) =>
    alias.some((a) => a.length >= 5 && n.includes(a)),
  );
  return candidatos.length === 1 ? candidatos[0][0] : null;
}

export interface FilaCruda {
  [encabezado: string]: unknown;
}

export interface FilaImportada {
  /** Número de fila en el Excel, contando el encabezado. Para que coincida. */
  fila: number;
  pedido: PedidoCrudo;
}

export interface ResultadoImportacion {
  filas: FilaImportada[];
  /** Encabezados del archivo que no supimos mapear. Se avisan, no se rompe. */
  columnasIgnoradas: string[];
  /** Campos importantes que el archivo no trae. */
  columnasFaltantes: string[];
  /**
   * Todos los campos nuestros que el archivo SÍ trae. Existe para que la
   * pantalla pueda avisar, antes de importar, que falta una columna que no es
   * obligatoria en general pero sí para esta tienda (el mail, cuando despacha
   * por Correo Uruguayo) — sin decidirlo acá, que no sabe de tiendas.
   */
  columnasPresentes: string[];
}

/** Los que no pueden faltar: sin esto no hay envío que valga. */
const REQUERIDOS = ['nombre', 'telefono', 'departamento', 'producto'] as const;

/**
 * Convierte las filas de la planilla en pedidos sin validarlos: de eso se
 * encarga `normalizarPedido` en el servidor, que es donde tiene que estar la
 * última palabra.
 */
export function filasAPedidos(filas: FilaCruda[]): ResultadoImportacion {
  if (filas.length === 0) {
    return { filas: [], columnasIgnoradas: [], columnasFaltantes: [...REQUERIDOS], columnasPresentes: [] };
  }

  // El mapa de columnas se arma UNA vez, con los encabezados de la primera fila.
  const encabezados = Object.keys(filas[0]);
  const mapa = new Map<string, string>(); // encabezado original → campo nuestro
  const ignoradas: string[] = [];
  for (const e of encabezados) {
    const campo = campoDeEncabezado(e);
    if (campo && !Array.from(mapa.values()).includes(campo)) mapa.set(e, campo);
    else if (!campo && normalizarEncabezado(e)) ignoradas.push(e);
  }

  const presentes = new Set(mapa.values());
  const faltantes = REQUERIDOS.filter((r) => !presentes.has(r));

  const out: FilaImportada[] = [];
  filas.forEach((f, i) => {
    const v: Record<string, unknown> = {};
    for (const [encabezado, campo] of mapa) v[campo] = f[encabezado];

    // Una fila sin NADA es una fila en blanco al final de la planilla, de las
    // que Excel agrega solas. No se reporta como error: se saltea.
    const tieneAlgo = Object.values(v).some((x) => x !== null && x !== undefined && String(x).trim() !== '');
    if (!tieneAlgo) return;

    // "Remera negra" + talle "M" → "Remera negra (M)". La variante no tiene
    // columna propia en el pedido: es parte de lo que dice la etiqueta.
    const producto = [v.producto, v.variante]
      .map((x) => (x === null || x === undefined ? '' : String(x).trim()))
      .filter(Boolean)
      .join(' ');

    out.push({
      fila: i + 2, // +1 por el encabezado, +1 porque Excel cuenta desde 1
      pedido: {
        nombre: v.nombre,
        telefono: v.telefono,
        email: v.email,
        documento: v.documento,
        departamento: v.departamento,
        localidad: v.localidad,
        direccion: v.direccion,
        agencia: v.agencia,
        referencia: v.referencia,
        observaciones: v.observaciones,
        contraEntrega: v.formaDePago,
        fechaVenta: v.fecha,
        items: producto ? [{ nombre: producto, cantidad: v.cantidad ?? 1, precio: v.precio }] : [],
      },
    });
  });

  return { filas: out, columnasIgnoradas: ignoradas, columnasFaltantes: faltantes, columnasPresentes: [...presentes] };
}

/** Las columnas de la plantilla, en orden. Se usan para el archivo de ejemplo. */
export const COLUMNAS_PLANTILLA = [
  'Fecha',
  'Nombre',
  'Teléfono',
  'Email',
  'Cédula',
  'Departamento',
  'Localidad',
  'Dirección',
  'Agencia',
  'Producto',
  'Talle / Color',
  'Cantidad',
  'Precio',
  'Forma de pago',
  'Observaciones',
] as const;

/** Una fila de ejemplo por cada caso que la gente pregunta: casa y agencia. */
export const EJEMPLO_PLANTILLA: Array<Record<string, string | number>> = [
  {
    Fecha: '03/09/2026',
    Nombre: 'Carla Pérez',
    'Teléfono': '099 887 766',
    // El mail va en la plantilla aunque para DAC sea opcional: Correo Uruguayo
    // lo exige (avisa la llegada por ahí) y una planilla sin la columna, en una
    // tienda con Correo, es una planilla que no despacha nada.
    Email: 'carla.perez@example.com',
    'Cédula': '4.512.345-6',
    Departamento: 'Maldonado',
    Localidad: 'Punta del Este',
    'Dirección': 'Gorlero 1234 apto 302',
    Agencia: '',
    Producto: 'Perfume Oud',
    'Talle / Color': '100ml',
    Cantidad: 1,
    Precio: 1390,
    'Forma de pago': 'Contra entrega',
    Observaciones: 'Llamar antes',
  },
  {
    Fecha: '03/09/2026',
    Nombre: 'Martín Suárez',
    'Teléfono': '098 111 222',
    Email: 'martin.suarez@example.com',
    'Cédula': '',
    Departamento: 'Montevideo',
    // 🔴 La localidad va TAMBIÉN cuando retira en agencia, y por eso la plantilla
    // la trae llena: es lo único que permite saber a cuál de las agencias del
    // departamento va. Montevideo tiene 17 oficinas de Correo. Hasta el
    // 16-09-2026 este ejemplo la dejaba vacía y enseñaba, sin querer, a cargar
    // un pedido que después no se podía despachar.
    Localidad: 'Montevideo',
    // Con agencia, la dirección va vacía: lo retira él.
    'Dirección': '',
    Agencia: 'Tres Cruces',
    Producto: 'Remera',
    'Talle / Color': 'M negra',
    Cantidad: 2,
    Precio: 890,
    'Forma de pago': 'Transferencia',
    Observaciones: '',
  },
];
