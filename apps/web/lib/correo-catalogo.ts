/**
 * Catálogo de oficinas de Correo Uruguayo, del lado web. [04-sep-2026]
 *
 * POR QUÉ EXISTE ACÁ. `correoOficinaDevolucion` es una configuración POR TIENDA,
 * y el worker la valida contra el catálogo por cada pedido: si el nombre no
 * existe, `construirEnvio` devuelve motivo y el pedido va a NEEDS_REVIEW. Como
 * el valor es de la tienda y no del pedido, un solo nombre mal escrito manda el
 * **100% de los envíos de esa tienda** a revisión, corrida tras corrida, sin que
 * nadie entienda por qué. Se valida al guardar, que es cuando hay una persona
 * mirando la pantalla y puede corregirlo.
 *
 * POR QUÉ NO SE IMPORTA EL DEL WORKER. Es la misma duplicación deliberada que ya
 * tiene `lib/transportista.ts`: `apps/web` y `apps/worker` son dos deploys
 * distintos (Vercel y Render) sin dependencia declarada entre sí, y
 * `packages/shared` hoy no lo importa nadie ni figura en ningún `package.json`
 * — meterlo en el camino de build de un deploy productivo para esto sería
 * cambiar la forma en que compilan las dos apps por una validación.
 *
 * Se copia SÓLO lo mínimo: una llamada y los `<nombre>` de la respuesta. El
 * parseo completo del catálogo (departamento, CP, código AHIVA) vive únicamente
 * en el worker, que es quien lo necesita.
 */

const ENDPOINTS = {
  test: 'https://ahivatest.correo.com.uy/web/CargaMasivaServicev4',
  prod: 'https://ahiva.correo.com.uy/web/CargaMasivaServicev4',
} as const;

export type CorreoAmbienteWeb = keyof typeof ENDPOINTS;

const ENVELOPE =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="http://webservices/">' +
  '<soapenv:Header/><soapenv:Body><web:obtenerLocalidadesCorreo/></soapenv:Body></soapenv:Envelope>';

/**
 * Normalización para COMPARAR nombres de oficina.
 *
 * ⚠️ NO es idéntica a `stripAccentsUpper` del worker (`correo/mapper.ts`), y la
 * diferencia es deliberada: el worker preserva la Ñ con un centinela y ésta la
 * trata como N. O sea que ésta es ESTRICTAMENTE MÁS PERMISIVA — para el worker
 * "CAÑAS" ≠ "CANAS", para ésta son iguales.
 *
 * Por qué es seguro, y por qué conviene: lo que se guarda NUNCA es lo que tipeó
 * el comerciante, sino el `nombre` CANÓNICO del catálogo (ver `verificarOficina`).
 * Así que alguien que escribe "Canas" sin ñ pasa la validación acá y termina con
 * "Cañas" guardado, que es exactamente lo que el worker espera. La permisividad
 * extra sólo agrega tolerancia al tipeo; nunca produce un valor que el worker
 * después rechace.
 *
 * En producción esto toca 2 oficinas reales: "Bañado de Medina" y "Cañas"
 * (Cerro Largo), verificado contra el catálogo el 04-09-2026.
 *
 * 🔴 Si algún día se guardara el texto crudo del comerciante en vez del canónico,
 * esta asimetría SÍ pasa a ser un bug: la web aceptaría "Canas" y el worker
 * mandaría todos los envíos de esa tienda a revisión.
 */
export function normalizarNombreOficina(v: string): string {
  return v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nombres de oficina tal cual los publica Correo. Sin credenciales. */
export async function obtenerNombresOficinas(
  ambiente: CorreoAmbienteWeb = 'prod',
  timeoutMs = 15_000,
): Promise<string[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINTS[ambiente], {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '' },
      body: ENVELOPE,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const nombres = [...xml.matchAll(/<nombre>([\s\S]*?)<\/nombre>/g)]
      .map((m) =>
        m[1]
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&')
          .trim(),
      )
      .filter(Boolean);
    // Un catálogo vacío no es un catálogo: si Correo cambia el contrato, es
    // preferible fallar acá que aprobar cualquier nombre como válido.
    if (nombres.length === 0) throw new Error('el catálogo vino vacío');
    return nombres;
  } finally {
    clearTimeout(t);
  }
}

export type ChequeoOficina =
  | { ok: true; nombre: string }
  | { ok: false; sugerencias: string[] };

/**
 * ¿Existe esa oficina? Devuelve el nombre canónico del catálogo, que es el que
 * hay que guardar: AHIVA identifica la sucursal por el texto exacto.
 */
export function verificarOficina(pedida: string, catalogo: string[]): ChequeoOficina {
  const objetivo = normalizarNombreOficina(pedida);
  const exacta = catalogo.find((n) => normalizarNombreOficina(n) === objetivo);
  if (exacta) return { ok: true, nombre: exacta };
  return {
    ok: false,
    sugerencias: catalogo
      .filter((n) => {
        const x = normalizarNombreOficina(n);
        return x.includes(objetivo) || objetivo.includes(x);
      })
      .slice(0, 6),
  };
}
