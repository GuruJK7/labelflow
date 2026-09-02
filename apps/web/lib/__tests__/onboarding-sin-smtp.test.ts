import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El bloque de "Aviso al cliente por email" NO va en el asistente.
 *
 * Pedía servidor SMTP, puerto, usuario y una **contraseña de aplicación** de la
 * cuenta de correo del comerciante: seis campos y una credencial ajena, en el
 * medio de un alta que promete tres minutos. Es la fricción más cara del
 * onboarding, no hace falta para despachar, y es justo la clase de pedido que
 * un revisor de Shopify mira con lupa.
 *
 * POR QUÉ ESTE TEST MIRA LA FUENTE Y NO EL RENDER. `ParametrosForm` carga sus
 * datos con fetch: en `renderToStaticMarkup` sale un spinner y cualquier
 * aserción sobre el HTML pasa sin probar nada (pasó, por eso está escrito así).
 * Lo que se fija acá es la estructura: el bloque existe UNA vez y está adentro
 * de un `!compact`.
 */
const FUENTE = readFileSync(
  join(__dirname, '..', '..', 'app', '(dashboard)', 'settings', '_components', 'ParametrosForm.tsx'),
  'utf8',
);

describe('el bloque de aviso por email', () => {
  it('sigue existiendo: esto cambia dónde se muestra, no qué hace el worker', () => {
    expect(FUENTE).toContain('Aviso al cliente por email');
    expect(FUENTE).toContain('Servidor SMTP');
  });

  it('el <Bloque> del email está una sola vez: el guardarraíl no se esquiva', () => {
    // El título aparece también en un comentario de más abajo; lo que tiene que
    // ser único es el bloque renderizado.
    expect(FUENTE.split('title="Aviso al cliente por email"')).toHaveLength(2);
    expect(FUENTE.split('id="email"')).toHaveLength(2);
  });

  it('🔴 está adentro de un !compact: el asistente no lo muestra', () => {
    const i = FUENTE.indexOf('id="email"');
    expect(i).toBeGreaterThan(0);
    // Lo inmediatamente anterior al <Bloque id="email"> tiene que ser la guarda.
    const antes = FUENTE.slice(0, i);
    const guarda = antes.lastIndexOf('{!compact && (');
    const bloqueAbre = antes.lastIndexOf('<Bloque');
    expect(guarda).toBeGreaterThan(-1);
    expect(guarda).toBeGreaterThan(antes.lastIndexOf('</Bloque>'));
    expect(bloqueAbre).toBeGreaterThan(guarda);
  });

  it('el asistente sigue pidiendo lo que sí importa para despachar', () => {
    // Quién paga el envío y el envío gratis NO están tras la guarda.
    for (const clave of ['Quién paga el envío', 'Envío gratis por reglas']) {
      const j = FUENTE.indexOf(clave);
      expect(j, `falta "${clave}"`).toBeGreaterThan(0);
    }
  });
});
