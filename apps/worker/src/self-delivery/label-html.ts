import { code128bSvg } from './code128';

/**
 * Etiqueta de envio propia de LabelFlow (10 x 15 cm), para los pedidos que se
 * reparten sin pasar por DAC.
 *
 * Criterios de diseno — esto se imprime y viaja pegado a una caja, asi que
 * manda la legibilidad, no la estetica de pantalla:
 *
 *  - BLANCO Y NEGRO PURO. Sin grises claros ni color: se imprime en termica
 *    (que solo tiene negro) y en laser barata. Un gris del 20% desaparece.
 *  - JERARQUIA POR TAMANO. El repartidor lee tres cosas a un metro de
 *    distancia: a quien, a donde, y cuanto cobra. Eso va grande; el resto chico.
 *  - EL MONTO A COBRAR ES LO MAS DESTACADO despues de la direccion. Un cobro
 *    mal leido es plata perdida en el momento, no un reclamo despues.
 *  - TELEFONO GRANDE. Es la herramienta nº1 del repartidor cuando no encuentra
 *    la puerta.
 *  - Sin fuentes web. El contenedor de Playwright en Render no tiene acceso
 *    garantizado a Google Fonts, y una etiqueta que depende de la red para
 *    renderizar bien es una etiqueta que un dia sale rota. Stack del sistema.
 *
 * El PDF se genera con Playwright (page.pdf) que ya es dependencia del worker.
 */

export interface DatosEtiqueta {
  /** Codigo de seguimiento propio, ej "LF-3K7QP2XA". */
  codigo: string;
  /** Nombre de la tienda que envia. */
  remitente: string;
  destinatario: {
    nombre: string;
    direccion: string;
    ciudad: string;
    departamento: string;
    telefono?: string | null;
  };
  pedido: {
    /** Nombre del pedido en Shopify, ej "#1234". */
    nombre: string;
    fecha: Date;
  };
  /** Monto a cobrar en el momento de la entrega, o null si ya esta pago. */
  cobrarUyu: number | null;
  /** Nota opcional (ej. referencias de la casa). */
  nota?: string | null;
}

/** Escapa para HTML. Los nombres de clientes traen & y < mas seguido de lo que uno cree. */
const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * $ 1.234 — separador de miles con punto, como se escribe en Uruguay.
 *
 * A mano y no con toLocaleString('es-UY') a proposito: si el contenedor de
 * Playwright viene sin ICU completo, ese locale cae en silencio a en-US y la
 * etiqueta sale con "1,234". En un monto a cobrar, esa coma es un problema real.
 */
const montoUy = (n: number): string =>
  `$ ${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

/**
 * dd/mm/aaaa en hora de Uruguay. Se arma pieza por pieza en vez de confiar en
 * el locale por el mismo motivo que el monto: sin ICU, 'es-UY' degrada a
 * formato de EE.UU. y el 08/09 pasaria a leerse como 9 de agosto.
 * 'en-CA' se usa solo como fuente de partes ISO estables (aaaa-mm-dd).
 */
const fechaUy = (d: Date): string => {
  const partes = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: 'America/Montevideo',
  }).formatToParts(d);
  const p = (t: string) => partes.find((x) => x.type === t)?.value ?? '';
  return `${p('day')}/${p('month')}/${p('year')}`;
};

/**
 * Ajusta el tamano de fuente al largo del texto para que una direccion larga
 * no desborde ni obligue a scroll (en un PDF, "desbordar" = texto cortado).
 */
function escalar(texto: string, base: number, umbral: number, minimo: number): number {
  const largo = texto.length;
  if (largo <= umbral) return base;
  const factor = umbral / largo;
  return Math.max(minimo, Math.round(base * factor * 10) / 10);
}

export function etiquetaHtml(d: DatosEtiqueta): string {
  const { svg: barcodeSvg } = code128bSvg(d.codigo, { alto: 56, moduloPx: 2, quietZone: 8 });

  const dir = d.destinatario.direccion.trim();
  const nombre = d.destinatario.nombre.trim();
  const ciudadDepto = [d.destinatario.ciudad, d.destinatario.departamento]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(', ');

  const fsNombre = escalar(nombre, 19, 26, 12);
  const fsDir = escalar(dir, 17, 34, 11);

  const cobra = d.cobrarUyu !== null && d.cobrarUyu > 0;

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<style>
  @page { size: 100mm 150mm; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    width: 100mm; height: 150mm;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #000; background: #fff;
    -webkit-font-smoothing: antialiased;
  }
  .etiqueta { width: 100mm; height: 150mm; padding: 3.5mm; display: flex; flex-direction: column; }

  /* ── Cabecera: marca + remitente ── */
  .cabecera {
    display: flex; align-items: center; justify-content: space-between;
    background: #000; color: #fff;
    padding: 2.2mm 2.8mm; border-radius: 1.2mm;
  }
  .marca { display: flex; align-items: center; gap: 1.8mm; }
  .rayo { width: 4.6mm; height: 4.6mm; flex: none; }
  .marca-nombre { font-size: 13pt; font-weight: 800; letter-spacing: -0.02em; }
  .remitente { text-align: right; max-width: 46mm; }
  .remitente .rot { font-size: 5.4pt; letter-spacing: 0.14em; text-transform: uppercase; opacity: .75; }
  .remitente .val { font-size: 8.4pt; font-weight: 700; line-height: 1.15;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── Banda de zona ── */
  .zona {
    margin-top: 2.2mm; border: 0.5mm solid #000; border-radius: 1.2mm;
    padding: 1.6mm 2.4mm; display: flex; align-items: baseline; justify-content: space-between;
  }
  .zona .rot { font-size: 6pt; letter-spacing: 0.16em; text-transform: uppercase; font-weight: 700; }
  .zona .val { font-size: 11pt; font-weight: 800; letter-spacing: -0.01em; }

  /* ── Destinatario: el bloque que se lee a un metro ── */
  .destino { margin-top: 2.4mm; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .rotulo { font-size: 6pt; letter-spacing: 0.16em; text-transform: uppercase;
            font-weight: 700; padding-bottom: 1mm; border-bottom: 0.25mm solid #000; }
  .nombre { font-size: ${fsNombre}pt; font-weight: 800; line-height: 1.12; margin-top: 2mm;
            word-break: break-word; }
  .direccion { font-size: ${fsDir}pt; font-weight: 600; line-height: 1.22; margin-top: 1.4mm;
               word-break: break-word; }
  .ciudad { font-size: 11pt; font-weight: 700; margin-top: 1.4mm; text-transform: uppercase;
            letter-spacing: 0.01em; }
  .tel { margin-top: 2mm; display: flex; align-items: baseline; gap: 2mm; }
  .tel .rot { font-size: 6pt; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 700; }
  .tel .val { font-size: 14pt; font-weight: 800; letter-spacing: 0.01em; }
  .nota { margin-top: 1.8mm; font-size: 8pt; line-height: 1.25; font-style: italic;
          border-left: 0.5mm solid #000; padding-left: 1.8mm; word-break: break-word;
          max-height: 9mm; overflow: hidden; }

  /* ── Recibi conforme ──
     Ocupa el aire que queda entre la direccion y el cobro. En reparto propio
     no hay comprobante del courier, asi que la firma en la etiqueta es el
     unico respaldo de la entrega — sobre todo cuando se cobra en el momento.
     margin-top:auto la ancla abajo: si la direccion crece, esto no se mueve. */
  .firma { margin-top: auto; padding-top: 2mm; display: flex; gap: 3mm; }
  .firma > div { flex: 1; }
  .firma .linea { border-bottom: 0.3mm solid #000; height: 6.5mm; }
  .firma .rot { font-size: 5.6pt; letter-spacing: 0.13em; text-transform: uppercase;
                font-weight: 700; padding-top: 0.8mm; display: block; }

  /* ── Cobro ── */
  .cobro { margin-top: 2mm; border-radius: 1.2mm; padding: 2mm 2.8mm;
           display: flex; align-items: center; justify-content: space-between; }
  .cobro.cobrar { background: #000; color: #fff; }
  .cobro.pago   { border: 0.5mm solid #000; }
  .cobro .rot { font-size: 6.4pt; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 700; }
  .cobro .val { font-size: 17pt; font-weight: 800; letter-spacing: -0.01em; }
  .cobro.pago .val { font-size: 12pt; }

  /* ── Pie: barcode + datos del pedido ── */
  .pie { margin-top: 2.2mm; border-top: 0.25mm solid #000; padding-top: 2mm; }
  .codigo-barras { display: flex; justify-content: center; }
  .codigo-barras svg { width: 100%; height: 13mm; }
  .codigo-txt { text-align: center; font-size: 11.5pt; font-weight: 800;
                letter-spacing: 0.16em; margin-top: 1.2mm;
                font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .meta { display: flex; justify-content: space-between; margin-top: 1.6mm; font-size: 7pt; }
  .meta .par { display: flex; gap: 1.2mm; align-items: baseline; }
  .meta .rot { letter-spacing: 0.12em; text-transform: uppercase; font-weight: 700; }
  .meta .val { font-weight: 700; }
</style></head>
<body><div class="etiqueta">

  <div class="cabecera">
    <div class="marca">
      <svg class="rayo" viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
        <path d="M13.2 2 4 13.6h6.1L9.6 22l9.6-11.9h-6.4z"/>
      </svg>
      <span class="marca-nombre">LabelFlow</span>
    </div>
    <div class="remitente">
      <div class="rot">Remitente</div>
      <div class="val">${esc(d.remitente)}</div>
    </div>
  </div>

  <div class="zona">
    <span class="rot">Reparto propio</span>
    <span class="val">${esc(d.destinatario.departamento || '—')}</span>
  </div>

  <div class="destino">
    <div class="rotulo">Entregar a</div>
    <div class="nombre">${esc(nombre)}</div>
    <div class="direccion">${esc(dir)}</div>
    ${ciudadDepto ? `<div class="ciudad">${esc(ciudadDepto)}</div>` : ''}
    ${d.destinatario.telefono
      ? `<div class="tel"><span class="rot">Tel</span><span class="val">${esc(d.destinatario.telefono)}</span></div>`
      : ''}
    ${d.nota ? `<div class="nota">${esc(d.nota)}</div>` : ''}
    <div class="firma">
      <div><div class="linea"></div><span class="rot">Firma</span></div>
      <div><div class="linea"></div><span class="rot">Aclaración / C.I.</span></div>
    </div>
  </div>

  <div class="cobro ${cobra ? 'cobrar' : 'pago'}">
    <span class="rot">${cobra ? 'Cobrar al entregar' : 'Ya abonado'}</span>
    <span class="val">${cobra ? esc(montoUy(d.cobrarUyu as number)) : 'NO COBRAR'}</span>
  </div>

  <div class="pie">
    <div class="codigo-barras">${barcodeSvg}</div>
    <div class="codigo-txt">${esc(d.codigo)}</div>
    <div class="meta">
      <span class="par"><span class="rot">Pedido</span><span class="val">${esc(d.pedido.nombre)}</span></span>
      <span class="par"><span class="rot">Fecha</span><span class="val">${esc(fechaUy(d.pedido.fecha))}</span></span>
    </div>
  </div>

</div></body></html>`;
}
