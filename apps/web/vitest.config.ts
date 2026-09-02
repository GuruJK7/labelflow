import { defineConfig, type Plugin } from 'vitest/config';
import path from 'node:path';
import ts from 'typescript';

/**
 * tsconfig.json tiene `jsx: preserve` (lo exige Next y lo reescribe si se
 * cambia). Vite 8 (oxc) respeta ese tsconfig al transformar y deja el JSX sin
 * compilar, así que ningún test podía importar un componente .tsx. Este plugin
 * transpila SOLO los .tsx con el compilador de TypeScript (ya está en
 * devDependencies) antes de que oxc los vea. Sirve para renderizar Sidebar o
 * SettingsNav en node con react-dom/server.
 */
function tsxViaTypescript(): Plugin {
  return {
    name: 'labelflow:tsx-via-typescript',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.tsx')) return null;
      const out = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2020,
          esModuleInterop: true,
          sourceMap: false,
        },
      });
      return { code: out.outputText, map: null };
    },
  };
}

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
  plugins: [tsxViaTypescript()],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  test: {
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
    globals: true,
    environment: 'node',
  },
});
