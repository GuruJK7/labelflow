import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Runner de tests de apps/web.
 *
 * Los tests viejos de `lib/__tests__/*.mjs` corren con `node --test` y
 * re-implementan la lógica que verifican, así que pasan aunque el código real
 * cambie (está documentado en el encabezado de shopify-webhook.test.mjs). Los
 * `.test.ts` que corren acá importan el módulo de verdad.
 *
 *   npx vitest run --root apps/web
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
    globals: true,
    environment: 'node',
  },
});
