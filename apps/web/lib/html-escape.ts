/**
 * Escape mínimo para interpolar texto dentro de HTML generado a mano (sin
 * React). Cubre los cinco caracteres que cambian de significado en un nodo
 * de texto o en un atributo entre comillas dobles.
 *
 * Existe porque /api/shopify/claim renderiza una página server-side desde un
 * route handler y ahí no hay JSX que escape solo: el email de la sesión y el
 * dominio de la tienda son datos, nunca markup.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
