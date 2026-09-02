import { describe, it, expect } from 'vitest';
import { SETTINGS_NAV, isSettingsNavActive } from '@/app/(dashboard)/settings/_components/SettingsNav';

/** Configuración agrupa las 5 partes del usuario (D32). */
describe('SettingsNav', () => {
  it('cinco entradas: Tiendas, Cuenta DAC, Reglas de envío, Parámetros, Comprar envíos', () => {
    expect(SETTINGS_NAV.map((i) => i.label)).toEqual([
      'Tiendas', 'Cuenta DAC', 'Reglas de envío', 'Parámetros', 'Comprar envíos',
    ]);
    expect(SETTINGS_NAV.map((i) => i.href)).toEqual([
      '/settings#tiendas', '/settings#dac', '/settings/shipping-rules', '/settings#parametros', '/settings/billing',
    ]);
  });

  it('activa por pathname + hash; en /settings sin hash gana Tiendas', () => {
    expect(isSettingsNavActive('/settings#tiendas', '/settings', '')).toBe(true);
    expect(isSettingsNavActive('/settings#dac', '/settings', '')).toBe(false);
    expect(isSettingsNavActive('/settings#dac', '/settings', '#dac')).toBe(true);
    expect(isSettingsNavActive('/settings#tiendas', '/settings', '#dac')).toBe(false);
    expect(isSettingsNavActive('/settings/billing', '/settings/billing', '')).toBe(true);
    expect(isSettingsNavActive('/settings/billing', '/settings', '')).toBe(false);
    expect(isSettingsNavActive('/settings#tiendas', '/settings/billing', '')).toBe(false);
    expect(isSettingsNavActive('/settings#tiendas', null, '')).toBe(false);
  });
});
