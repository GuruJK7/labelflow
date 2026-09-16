/**
 * 🔴 Traducir la página no puede volver a tirar abajo la app.
 *
 * QUÉ PASÓ (14-09-2026). La revisión del Shopify App Store rechazó AutoEnvía con
 * «4.5.5 — the application lands to an error when trying to log in to the app
 * dashboard», y adjuntó un screencast. En el video se ve que el revisor tenía la
 * página traducida por Chrome (no habla español): escribe las credenciales del
 * listing, aprieta el botón, y la app queda en blanco con «Application error: a
 * client-side exception has occurred».
 *
 * El login NO estaba roto: quedaron SEIS `user.login.success` suyos en la base,
 * uno por cada intento, mientras él veía la pantalla de error.
 *
 * LA CAUSA, reproducida en el navegador el 16-09-2026. El traductor reemplaza
 * cada NODO DE TEXTO SUELTO por un elemento <font>. Cuando ese texto es hijo
 * directo de una rama de ternario, React guarda una referencia al nodo original;
 * al re-renderizar (acá: cambiar el texto del botón por el spinner) intenta
 * removerlo, ya no está donde cree, y tira `NotFoundError: Failed to execute
 * 'removeChild' on 'Node'`. Medido: 6 excepciones y `document.body.innerText`
 * vacío. Con el texto dentro de un <span>: 0 excepciones.
 *
 * LA REGLA: un texto que vive en una rama condicional de JSX va SIEMPRE dentro
 * de un elemento, nunca suelto.
 *
 * POR QUÉ ESTE TEST LEE EL CÓDIGO Y NO RENDERIZA. El defecto no está en el
 * comportamiento de un componente sino en la FORMA del JSX, y este paquete no
 * tiene jsdom ni testing-library (sólo `renderToStaticMarkup`), así que no hay
 * forma de simular el traductor + el click dentro de vitest. La verificación de
 * comportamiento se hizo a mano en el navegador; esto es la guarda de regresión.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const RAIZ = join(__dirname, '..', '..');

/**
 * Texto suelto en la PRIMERA línea de una rama de ternario o de un fragment
 * abierto dentro de ella — el patrón exacto que crasheó, y sólo ése.
 *
 * Se descartan comentarios (`{/* … *\/}`) y las líneas dentro de un tag abierto
 * (atributos), que son lo que ensuciaba una versión anterior de esta guarda con
 * falsos positivos.
 */
function textosSueltosEnRamaCondicional(codigo: string): Array<{ linea: number; texto: string }> {
  const lineas = codigo.split('\n');
  const hallazgos: Array<{ linea: number; texto: string }> = [];
  let enComentario = false;
  let enTagAbierto = false;

  for (let i = 0; i < lineas.length; i++) {
    const cruda = lineas[i];
    const s = cruda.trim();

    // Comentarios JSX y de bloque: nada de lo que hay adentro es markup.
    if (enComentario) {
      if (s.includes('*/')) enComentario = false;
      continue;
    }
    if (s.startsWith('{/*') || s.startsWith('/*')) {
      if (!s.includes('*/')) enComentario = true;
      continue;
    }
    if (s.startsWith('//')) continue;

    // Dentro de un tag abierto en varias líneas, lo que hay son ATRIBUTOS.
    if (enTagAbierto) {
      if (/\/?>\s*$/.test(s)) enTagAbierto = false;
      continue;
    }
    if (/^<[A-Za-z]/.test(s) && !/\/?>\s*$/.test(s)) {
      enTagAbierto = true;
      continue;
    }

    // La línea anterior (ignorando comentarios) tiene que ABRIR una rama
    // condicional o un fragment dentro de ella.
    let j = i - 1;
    while (j >= 0 && (lineas[j].trim().startsWith('{/*') || lineas[j].trim().startsWith('*') || lineas[j].trim() === '')) j--;
    const anterior = j >= 0 ? lineas[j].trim() : '';
    const abreRama = /\?\s*\($|:\s*\($|&&\s*\($|^<>$/.test(anterior);
    if (!abreRama) continue;

    // …y esta línea tiene que ser texto visible pelado (sin sintaxis JSX).
    if (!s || /^[<{})/\]]/.test(s)) continue;
    if (/[={}<>`]/.test(s)) continue;
    if (!/^[A-Za-zÁÉÍÓÚÑáéíóúñ¿¡][A-Za-zÁÉÍÓÚÑáéíóúñ0-9 ,.:;¿?¡!…'’\-]*$/.test(s)) continue;

    hallazgos.push({ linea: i + 1, texto: s.slice(0, 70) });
  }
  return hallazgos;
}

/** Las pantallas por las que pasa sí o sí un revisor del App Store. */
const CAMINO_DEL_REVISOR = [
  'app/(auth)/login/LoginForm.tsx',
  'app/(auth)/signup/SignupForm.tsx',
  'app/(auth)/_components/GoogleSignInButton.tsx',
  'app/(auth)/forgot-password/ForgotPasswordForm.tsx',
  'app/(auth)/reset-password/[token]/ResetPasswordForm.tsx',
  'app/onboarding/_components/wizard-ui.tsx',
  'app/onboarding/_components/OnboardingWizard.tsx',
  'app/(dashboard)/pedidos/page.tsx',
  'app/(dashboard)/labels/page.tsx',
  'components/layout/Sidebar.tsx',
];

describe('🔴 traducir la página no puede tirar abajo la app (Shopify 4.5.5)', () => {
  it('el botón donde crasheó el revisor tiene el texto envuelto', () => {
    // La guarda más importante: es el click exacto del screencast.
    const login = readFileSync(join(RAIZ, 'app', '(auth)', 'login', 'LoginForm.tsx'), 'utf-8');
    expect(login).toContain('<span>Iniciar sesión</span>');
    // Y que no vuelva a quedar suelto: una línea que sea sólo ese texto.
    expect(login.split('\n').some((l) => l.trim() === 'Iniciar sesión')).toBe(false);
  });

  it('ninguna pantalla del camino del revisor deja texto suelto en una rama condicional', () => {
    const ofensores: string[] = [];
    for (const rel of CAMINO_DEL_REVISOR) {
      const codigo = readFileSync(join(RAIZ, ...rel.split('/')), 'utf-8');
      for (const h of textosSueltosEnRamaCondicional(codigo)) {
        ofensores.push(`${rel}:${h.linea} → «${h.texto}»`);
      }
    }
    expect(
      ofensores,
      'Con la página traducida, React revienta con "removeChild" y la app queda en blanco: ' +
        'es lo que hizo que Shopify rechazara la app el 14-09-2026. Envolvelos en <span>…</span>.\n\n' +
        ofensores.join('\n'),
    ).toEqual([]);
  });
});
