import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Las capturas de la landing son producto real, no adorno: si una se rompe o
 * se queda sin alt, la página miente por omisión. Y una de las viñetas es una
 * afirmación que ya se prometió de más una vez.
 */
const RAIZ = path.resolve(__dirname, '../..');
const PAGE = fs.readFileSync(path.join(RAIZ, 'app/page.tsx'), 'utf8');

describe('capturas de la landing', () => {
  const usadas = [...PAGE.matchAll(/src: '(\/landing\/[^']+)'/g)].map((m) => m[1]);
  const heroe = PAGE.match(/src="(\/landing\/[^"]+)"/)?.[1];

  it('las cinco capturas existen en public/', () => {
    const todas = [...usadas, heroe].filter(Boolean) as string[];
    expect(todas).toHaveLength(5);
    for (const src of todas) {
      expect(fs.existsSync(path.join(RAIZ, 'public', src)), `falta ${src}`).toBe(true);
    }
  });

  it('ninguna captura va sin texto alternativo', () => {
    // Cada `src:` de FEATURE_SHOTS tiene que venir con su `alt:` no vacío.
    const alts = [...PAGE.matchAll(/alt: '([^']*)'/g)].map((m) => m[1]);
    expect(alts.length).toBeGreaterThanOrEqual(usadas.length);
    for (const a of alts) expect(a.trim().length).toBeGreaterThan(10);
    expect(PAGE).toMatch(/alt="[^"]{10,}"/); // la del hero
  });

  it('🔴 no promete que el PDF se guarda para siempre', () => {
    // pdf-retention.job.ts lo borra a los 15 días (PDF_RETENTION_DAYS). El
    // diseño original decía "queda guardado por si lo necesitás de nuevo",
    // sin plazo. Si vuelve esa frase, la landing promete de más.
    const sinComentarios = PAGE.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(sinComentarios).not.toMatch(/PDF[^.]{0,40}queda guardado(?![^.]*\d)/i);
    expect(sinComentarios).toContain('El PDF queda disponible 15 días');
  });

  it('el pie aclara que los datos son ficticios', () => {
    expect(PAGE).toMatch(/tienda y nombres ficticios/);
  });
});
