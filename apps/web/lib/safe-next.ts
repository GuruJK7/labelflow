/**
 * ¿A dónde volver después de loguearse?
 *
 * El parámetro (`next` o `callbackUrl`) viene de la URL, o sea del usuario o
 * de quien le armó el link. Si lo usamos tal cual, /login se convierte en un
 * open redirect: "iniciá sesión en AutoEnvía" y al terminar te manda a un
 * sitio ajeno con pinta de nuestro. Por eso sólo se acepta una ruta RELATIVA
 * al mismo origen: empieza con una barra y no con dos (`//evil.com` es una URL
 * absoluta sin esquema para el navegador), sin barra invertida (los
 * navegadores la normalizan a `/`), sin esquema, sin espacios ni control.
 *
 * Devuelve null si no pasa. El llamador decide el default (/dashboard).
 */
export function safeRelativePath(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  if (!s.startsWith('/')) return null;
  if (s.startsWith('//')) return null;
  if (s.includes('\\')) return null;
  // Espacios, controles o DEL adentro de la ruta: nada legítimo los trae sin codificar.
  if (/[\x00-\x20\x7f]/.test(s)) return null;
  // Un `/` seguido de algo que el navegador pueda leer como esquema o host.
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(s)) return null;
  if (s.length > 2048) return null;
  return s;
}
