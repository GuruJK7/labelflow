import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TRIAL_SHIPMENTS, REFEREE_BONUS_CREDITS } from '../trial';

/**
 * D31: 5 envíos gratis por cuenta nueva, explícitos en cada alta. El default
 * del schema (10) NO se toca, así que cualquier create que confíe en él regala
 * el doble. Estos tests documentan las dos cosas a la vez.
 */
describe('lib/trial (D31)', () => {
  it('TRIAL_SHIPMENTS es 5', () => {
    expect(TRIAL_SHIPMENTS).toBe(5);
  });

  it('REFEREE_BONUS_CREDITS sigue en 10 (D31 no lo toca)', () => {
    expect(REFEREE_BONUS_CREDITS).toBe(10);
  });

  it('el default del schema sigue en 10 y es distinto del trial: el explícito es obligatorio', () => {
    const schema = readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const m = schema.match(/shipmentCredits\s+Int\s+@default\((\d+)\)/);
    expect(m).not.toBeNull();
    const schemaDefault = Number(m![1]);
    expect(schemaDefault).toBe(10);
    expect(schemaDefault).not.toBe(TRIAL_SHIPMENTS);
  });

  /**
   * Google OAuth no tiene harness de NextAuth en la suite: se fija por
   * estructura. Hay dos creates de tenant holder en lib/auth.ts (user nuevo y
   * user huérfano sin tenant) y los dos tienen que pasar el trial explícito.
   */
  it('lib/auth.ts pasa shipmentCredits: TRIAL_SHIPMENTS en sus 2 altas', () => {
    const src = readFileSync(path.resolve(__dirname, '../auth.ts'), 'utf8');
    expect(src.match(/shipmentCredits: TRIAL_SHIPMENTS/g)?.length).toBe(2);
    expect(src).not.toMatch(/const REFEREE_BONUS_CREDITS = /);
  });
});
