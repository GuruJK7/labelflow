/**
 * Canal de atención publicado, FUENTE ÚNICA.
 *
 * 🔴 POR QUÉ NO HAY UN MAIL ACÁ. Hasta el 2026-09-02 las páginas legales
 * publicaban `soporte@labelflow.uy` como único canal —para pedir reembolsos y
 * para ejercer los derechos de la Ley 18.331—. Ese dominio no existe: no tiene
 * NS, ni SOA, ni MX (verificado contra 8.8.8.8 y 1.1.1.1, NXDOMAIN en los dos).
 * Cualquier mail a esa casilla rebota. `soporte@autoenvia.com` tampoco sirve
 * todavía: el dominio resuelve (Vercel DNS) pero NO tiene registros MX, así que
 * puede mandar mails y no puede recibirlos.
 *
 * Publicar una casilla que rebota es peor que no publicar ninguna: el cliente
 * cree que reclamó. Por eso el canal es el WhatsApp, que es el que hoy
 * efectivamente atiende una persona.
 *
 * CUANDO HAYA MX: agregar acá `SOPORTE_EMAIL` y sumarlo —no reemplazar— en
 * `/terminos` §11 y en `/privacidad`. El orden importa: primero la casilla,
 * después el texto.
 */

/** Número de atención, en formato internacional sin símbolos (para wa.me). */
export const WHATSAPP_E164 = '59898943949';

/** El mismo número, escrito para leer. */
export const WHATSAPP_LEGIBLE = '+598 98 943 949';

/** Link de WhatsApp con un mensaje pre-armado. */
export function whatsappUrl(mensaje: string): string {
  return `https://wa.me/${WHATSAPP_E164}?text=${encodeURIComponent(mensaje)}`;
}
