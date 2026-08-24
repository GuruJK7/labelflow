/**
 * Code 128 (subset B) — generador de codigo de barras en SVG, sin dependencias.
 *
 * Se escribe a mano en vez de sumar una libreria porque el worker corre en un
 * contenedor de Render donde cada dependencia nueva es superficie de build que
 * puede romper un deploy de produccion. El algoritmo es un estandar cerrado
 * (ISO/IEC 15417) que no cambia, asi que el costo de mantenimiento es cero.
 *
 * Subset B: cubre ASCII 32..126 (mayusculas, minusculas, digitos y simbolos),
 * que es todo lo que necesita un codigo tipo "LF-3K7QP2".
 *
 * Estructura de un simbolo Code 128:
 *
 *   [START B] [datos...] [CHECKSUM] [STOP]
 *
 * Cada patron son 6 anchos alternando barra/espacio, empezando por barra, y
 * suman 11 modulos. La excepcion es STOP, que trae 7 anchos (13 modulos) —
 * los 2 modulos extra son la barra de terminacion.
 *
 * Checksum: (valor_start + suma(posicion * valor_i)) mod 103, con posicion
 * empezando en 1 para el primer caracter de datos.
 */

/** Los 107 patrones del estandar, como anchos de barra/espacio. Indice = valor. */
const PATRONES = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312',
  '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131',
  '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321',
  '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114',
  '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112',
  '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412',
  '211214', '211232', '2331112',
];

const START_B = 104;
const STOP = 106;

/** Solo ASCII imprimible: fuera de ese rango el subset B no puede representarlo. */
export const code128bValido = (texto: string): boolean =>
  texto.length > 0 && [...texto].every((c) => {
    const n = c.charCodeAt(0);
    return n >= 32 && n <= 126;
  });

/**
 * Devuelve los anchos crudos del simbolo completo: un array de numeros donde
 * el indice par es barra (negro) y el impar es espacio (blanco).
 */
export function code128bAnchos(texto: string): number[] {
  if (!code128bValido(texto)) {
    throw new Error(`Code128B no puede codificar ${JSON.stringify(texto)}: solo ASCII 32..126`);
  }
  const valores = [...texto].map((c) => c.charCodeAt(0) - 32);

  // Checksum ponderado por posicion (el primer caracter de datos pesa 1).
  let suma = START_B;
  valores.forEach((v, i) => {
    suma += v * (i + 1);
  });
  const checksum = suma % 103;

  const simbolos = [START_B, ...valores, checksum, STOP];
  const anchos: number[] = [];
  for (const s of simbolos) {
    for (const ch of PATRONES[s]) anchos.push(Number(ch));
  }
  return anchos;
}

/**
 * Dibuja el codigo como SVG embebible.
 *
 * `alto` es el alto de las barras en px; el ancho sale de la cantidad de
 * modulos por `moduloPx`. Se deja quiet zone de 10 modulos a cada lado: sin
 * ella muchos lectores no enganchan el codigo.
 */
export function code128bSvg(
  texto: string,
  opts?: { alto?: number; moduloPx?: number; quietZone?: number },
): { svg: string; anchoPx: number; altoPx: number } {
  const alto = opts?.alto ?? 60;
  const m = opts?.moduloPx ?? 2;
  const quiet = opts?.quietZone ?? 10;

  const anchos = code128bAnchos(texto);
  const modulos = anchos.reduce((a, b) => a + b, 0);
  const anchoPx = (modulos + quiet * 2) * m;

  const rects: string[] = [];
  let x = quiet * m;
  anchos.forEach((ancho, i) => {
    const w = ancho * m;
    if (i % 2 === 0) rects.push(`<rect x="${x}" y="0" width="${w}" height="${alto}"/>`);
    x += w;
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${anchoPx}" height="${alto}" ` +
    `viewBox="0 0 ${anchoPx} ${alto}" shape-rendering="crispEdges" fill="#000">` +
    rects.join('') +
    `</svg>`;

  return { svg, anchoPx, altoPx: alto };
}
