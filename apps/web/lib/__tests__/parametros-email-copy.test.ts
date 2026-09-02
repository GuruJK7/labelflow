import { describe, it, expect } from 'vitest';
import { EMAIL_AVISO } from '@/app/(dashboard)/settings/_components/ParametrosForm';

/**
 * Copy de "Aviso al cliente por email" (revisión 2026-09-02). Decía "para
 * apagarlo, dejalos vacíos", pero eso no apaga nada: `PUT /api/v1/settings`
 * exige `min(1)` en emailHost/emailUser/emailPass y el form ni siquiera manda
 * los campos vacíos. Lo que hace el worker (`process-orders.job.ts`, "Send
 * email notification") es: manda sólo si los tres están guardados. El texto
 * tiene que decir eso y nada más.
 */
describe('copy del aviso por email', () => {
  it('no promete un "apagar" dejando los campos vacíos', () => {
    expect(EMAIL_AVISO).not.toMatch(/dejalos vacíos|para apagarlo/i);
  });

  it('dice la condición real del worker (los tres campos guardados) y que vaciar no borra', () => {
    expect(EMAIL_AVISO).toMatch(/servidor, usuario y contraseña/);
    expect(EMAIL_AVISO).toMatch(/los tres guardados/);
    expect(EMAIL_AVISO).toMatch(/no sale ningún email/);
    expect(EMAIL_AVISO).toMatch(/no borra lo que ya está guardado/);
  });
});
