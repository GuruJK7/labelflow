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
import { readFileSync, readdirSync } from 'fs';
import * as ts from 'typescript';
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
/**
 * 🔴 SEGUNDA VERSIÓN DEL DETECTOR — la primera era ciega y dejó pasar el bug.
 *
 * La versión de línea-por-línea tenía dos agujeros que se comprobaron el
 * 18-09-2026, cuando el MISMO crash del rechazo apareció vivo en producción en
 * el simulador de precios de la landing:
 *   1. Miraba una lista fija de 10 archivos y la landing no estaba en ella.
 *   2. Descartaba toda línea que tuviera `{…}`, o sea justo la forma del texto
 *      que crashea («Arriba de {fmt(n)} envíos…»). Apuntada a mano al archivo
 *      culpable devolvía CERO.
 *
 * Ésta parsea el TSX de verdad y busca el defecto exacto: un FRAGMENT que sea
 * la rama de un ternario (o de un &&/||) y que tenga TEXTO COMO HIJO DIRECTO.
 * Ése es el único caso peligroso — un texto dentro de un <span> o un <h2> está
 * a salvo, porque el traductor no reemplaza elementos, sólo nodos de texto.
 *
 * Distinguir las dos cosas importa: la versión ingenua marcaba 46 sitios, de
 * los cuales 41 eran texto ya envuelto. Envolverlos «por las dudas» habría
 * metido <span> alrededor de <div> (HTML inválido) en media app.
 */
function fragmentsDeRamaConTextoSuelto(
  archivo: string,
  codigo: string,
): Array<{ linea: number; muestra: string }> {
  const src = ts.createSourceFile(archivo, codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hallazgos: Array<{ linea: number; muestra: string }> = [];

  const esRamaCondicional = (n: ts.Node): boolean => {
    const p = n.parent;
    if (!p) return false;
    if (ts.isConditionalExpression(p) && (p.whenTrue === n || p.whenFalse === n)) return true;
    if (
      ts.isBinaryExpression(p) &&
      (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        p.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      p.right === n
    )
      return true;
    if (ts.isParenthesizedExpression(p)) return esRamaCondicional(p);
    return false;
  };

  const visitar = (n: ts.Node): void => {
    if (ts.isJsxFragment(n) && esRamaCondicional(n)) {
      const sueltos = n.children.filter(
        (c): c is ts.JsxText => ts.isJsxText(c) && c.text.trim().length > 1,
      );
      if (sueltos.length > 0) {
        const { line } = src.getLineAndCharacterOfPosition(n.getStart());
        hallazgos.push({
          linea: line + 1,
          muestra: sueltos[0].text.trim().replace(/\s+/g, ' ').slice(0, 60),
        });
      }
    }
    ts.forEachChild(n, visitar);
  };

  visitar(src);
  return hallazgos;
}

/**
 * 🔴 EL SEGUNDO INVARIANTE, y el que faltaba: la rama necesita `key`.
 *
 * Envolver cada rama en un <span> NO alcanza, y costó un deploy comprobarlo.
 * Si las dos ramas de un ternario renderizan el MISMO tipo de elemento, React
 * no desmonta nada: reutiliza el elemento y reconcilia sus HIJOS, que siguen
 * siendo los nodos de texto que el traductor convirtió en <font>. El
 * `removeChild` vuelve a saltar igual.
 *
 * Verificado el 18-09 con el traductor simulado sobre la landing: con las tres
 * ramas envueltas en <span> pero SIN key, un click en el preset de 2.500 tira
 * la página (body de 7.528 a 213 caracteres, y React apunta «at span / at p»).
 * Con una key distinta por rama: 0 errores en 9 presets + 4 movidas de slider.
 *
 * 🔑 EL CRITERIO ES ESTRECHO A PROPÓSITO, y afinarlo importó: pedir key a
 * TODA rama con texto marcaba 49 sitios, casi todos inofensivos. Si las dos
 * ramas tienen la MISMA forma de hijos, React sólo actualiza el texto —y
 * actualizar un texto es seguro, porque el nodo sigue existiendo dentro del
 * <font>. El crash necesita que React tenga que REMOVER un hijo de texto, o
 * sea que las dos ramas difieran en la forma de sus hijos. Con ese criterio
 * los peligrosos reales eran 2.
 */
function ramasQueRemuevenTexto(
  archivo: string,
  codigo: string,
): Array<{ linea: number; detalle: string }> {
  const src = ts.createSourceFile(archivo, codigo, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hallazgos: Array<{ linea: number; detalle: string }> = [];

  const pelar = (n: ts.Node): ts.Node => (ts.isParenthesizedExpression(n) ? pelar(n.expression) : n);
  const etiqueta = (n: ts.Node): string | null =>
    ts.isJsxElement(n) ? n.openingElement.tagName.getText() : ts.isJsxFragment(n) ? '<>' : null;
  const conKey = (n: ts.Node): boolean =>
    ts.isJsxElement(n) &&
    n.openingElement.attributes.properties.some((a) => ts.isJsxAttribute(a) && a.name.getText() === 'key');

  /** La "forma" de los hijos: qué tipo de hijo hay y en qué orden. */
  const forma = (n: ts.Node): string => {
    if (!ts.isJsxElement(n) && !ts.isJsxFragment(n)) return 'X';
    return n.children
      .filter((c) => !(ts.isJsxText(c) && !c.text.trim()))
      .map((c) =>
        ts.isJsxText(c) ? 'T'
          : ts.isJsxExpression(c) ? 'E'
          : ts.isJsxElement(c) ? 'N:' + c.openingElement.tagName.getText()
          : ts.isJsxSelfClosingElement(c) ? 'N:' + c.tagName.getText()
          : '?',
      )
      .join(',');
  };
  const conTextoDirecto = (n: ts.Node): boolean =>
    (ts.isJsxElement(n) || ts.isJsxFragment(n)) &&
    n.children.some((c) => ts.isJsxText(c) && c.text.trim().length > 1);

  const visitar = (n: ts.Node): void => {
    if (ts.isConditionalExpression(n)) {
      const a = pelar(n.whenTrue);
      const b = pelar(n.whenFalse);
      const ta = etiqueta(a);
      const tb = etiqueta(b);
      if (ta && tb && ta === tb && (conTextoDirecto(a) || conTextoDirecto(b))) {
        if (forma(a) !== forma(b) && !(conKey(a) && conKey(b))) {
          const { line } = src.getLineAndCharacterOfPosition(n.getStart());
          hallazgos.push({
            linea: line + 1,
            detalle: `<${ta}> con hijos [${forma(a)}] vs [${forma(b)}] y sin key`,
          });
        }
      }
    }
    ts.forEachChild(n, visitar);
  };

  visitar(src);
  return hallazgos;
}

/** Todo .tsx de la app: el barrido no vuelve a depender de una lista a mano. */
function todosLosTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    if (entrada.name === 'node_modules' || entrada.name.startsWith('.')) continue;
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) out.push(...todosLosTsx(ruta));
    else if (entrada.name.endsWith('.tsx')) out.push(ruta);
  }
  return out;
}

describe('🔴 traducir la página no puede tirar abajo la app (Shopify 4.5.5)', () => {
  it('el botón donde crasheó el revisor tiene el texto envuelto', () => {
    // La guarda más importante: es el click exacto del screencast.
    const login = readFileSync(join(RAIZ, 'app', '(auth)', 'login', 'LoginForm.tsx'), 'utf-8');
    expect(login).toContain('<span>Iniciar sesión</span>');
    // Y que no vuelva a quedar suelto: una línea que sea sólo ese texto.
    expect(login.split('\n').some((l) => l.trim() === 'Iniciar sesión')).toBe(false);
  });

  it('NINGÚN .tsx de la app deja texto suelto en la rama de un ternario', () => {
    // Barrido completo, no una lista a mano: así fue como se escapó el de la
    // landing. Incluye app/ y components/.
    const ofensores: string[] = [];
    for (const abs of [...todosLosTsx(join(RAIZ, 'app')), ...todosLosTsx(join(RAIZ, 'components'))]) {
      const rel = abs.slice(RAIZ.length + 1);
      for (const h of fragmentsDeRamaConTextoSuelto(abs, readFileSync(abs, 'utf-8'))) {
        ofensores.push(`${rel}:${h.linea} → «${h.muestra}»`);
      }
    }
    expect(
      ofensores,
      'Con la página traducida por Chrome, React revienta con "removeChild" y la pantalla se cae: ' +
        'es lo que hizo que Shopify rechazara la app el 14-09-2026, y lo que volvió a aparecer en la ' +
        'landing el 18-09. Dale a la rama un elemento propio: <>…</> → <span>…</span>.\n\n' +
        ofensores.join('\n'),
    ).toEqual([]);
  });

  it('🔴 dos ramas del mismo tag con hijos distintos necesitan key: si no, React remueve texto', () => {
    const ofensores: string[] = [];
    for (const abs of [...todosLosTsx(join(RAIZ, 'app')), ...todosLosTsx(join(RAIZ, 'components'))]) {
      const rel = abs.slice(RAIZ.length + 1);
      for (const h of ramasQueRemuevenTexto(abs, readFileSync(abs, 'utf-8'))) {
        ofensores.push(`${rel}:${h.linea} → ${h.detalle}`);
      }
    }
    expect(
      ofensores,
      'React va a REUTILIZAR el elemento (mismo tag, sin key) y, como los hijos difieren, va a ' +
        'remover un hijo de texto — que con la página traducida ya no está donde cree. Es el crash ' +
        'del rechazo del 14-09. Dale a cada rama una key distinta.\n\n' + ofensores.join('\n'),
    ).toEqual([]);
  });


  it('🔴 el simulador de precios de la landing usa <span>, no fragments', () => {
    // Regresión puntual: este archivo se saltó a propósito en el fix del 16-09
    // («el riesgo ahí es bajo») y el 18-09 se reprodujo el crash en producción
    // apretando el preset de 2.500 envíos con la página traducida.
    const pricing = readFileSync(join(RAIZ, 'app', '_components', 'PricingSelector.tsx'), 'utf-8');
    expect(fragmentsDeRamaConTextoSuelto('PricingSelector.tsx', pricing)).toEqual([]);
  });
});
