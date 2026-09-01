/**
 * Vitest para apps/web — SÓLO tests de funciones puras de lib/.
 *
 * Correr:  cd apps/web && ../../node_modules/.bin/vitest run
 *
 * Notas de por qué está así y no de otra forma:
 *
 *  - vitest NO está en las dependencias de apps/web a propósito. Render/Vercel
 *    construyen la web con sus propias deps y agregar una devDependency acá
 *    obliga a tocar el package-lock del monorepo. El binario se toma del
 *    node_modules raíz (hoisted desde apps/worker, que sí lo declara).
 *  - `include` apunta sólo a *.test.ts: los *.test.mjs que ya existen en
 *    lib/__tests__ corren con `node --test` (ver el encabezado de cada uno) y
 *    vitest no los entiende.
 *  - lib/__tests__ y este archivo están excluidos del tsconfig de la web para
 *    que `next build` no intente typechear imports de 'vitest' que en un build
 *    limpio de producción no existen.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['lib/__tests__/**/*.test.ts'],
    globals: false,
  },
});
