import { describe, it, expect, vi, beforeEach } from 'vitest';
// Import estático: `vi.mock` se hoistea, así que los mocks de arriba ya están
// puestos cuando esto se resuelve. Un `await import()` de nivel superior
// compila en vitest pero rompe el `tsc` del build de producción (TS1378).
import { verificarStorage, motivoStorageCaido } from '../storage/health';

/**
 * 🔴 EL INCIDENTE (06-09-2026). Supabase restringió el proyecto por cuota de
 * egress y devolvió 402 a toda subida. El despacho igual emitía la guía en DAC
 * —real y facturada— y recién después fallaba al guardar el PDF: **120 guías en
 * poco más de un día sin etiqueta imprimible**, en 6 tiendas.
 *
 * La regla que faltaba: no emitas una guía que no vas a poder entregar.
 * Estos tests fijan que la comprobación falle CERRADA en todos los caminos.
 */

const upload = vi.fn();
const remove = vi.fn().mockResolvedValue({ error: null });
const from = vi.fn(() => ({ upload, remove }));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ storage: { from } })),
}));

const config = {
  SUPABASE_URL: 'https://proyecto.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'clave',
  SUPABASE_STORAGE_BUCKET: 'labels',
};
vi.mock('../config', () => ({ getConfig: () => config }));
vi.mock('../logger', () => ({ default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));


beforeEach(() => {
  vi.clearAllMocks();
  config.SUPABASE_URL = 'https://proyecto.supabase.co';
  config.SUPABASE_SERVICE_ROLE_KEY = 'clave';
});

describe('verificarStorage', () => {
  it('escribe y borra: storage sano', async () => {
    upload.mockResolvedValue({ error: null });
    const r = await verificarStorage();
    expect(r.escribible).toBe(true);
    expect(r.error).toBe('');
    expect(upload).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce(); // no deja basura
  });

  it('el 402 de cuota excedida NO es escribible — el caso exacto del incidente', async () => {
    const real =
      'Service for this project is restricted due to the following violations: ' +
      'exceed_egress_quota. The project owner must upgrade their plan or remove spend caps to restore service.';
    upload.mockResolvedValue({ error: { message: real } });
    const r = await verificarStorage();
    expect(r.escribible).toBe(false);
    expect(r.error).toBe(real); // el mensaje del proveedor llega textual
  });

  it('una excepción de red tampoco pasa (fail-closed)', async () => {
    upload.mockRejectedValue(new Error('ECONNRESET'));
    const r = await verificarStorage();
    expect(r.escribible).toBe(false);
    expect(r.error).toBe('ECONNRESET');
  });

  it('sin configuración de Supabase no se intenta ni la subida', async () => {
    config.SUPABASE_URL = '';
    const r = await verificarStorage();
    expect(r.escribible).toBe(false);
    expect(r.error).toMatch(/no está configurado/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('sin service-role key tampoco', async () => {
    config.SUPABASE_SERVICE_ROLE_KEY = '';
    const r = await verificarStorage();
    expect(r.escribible).toBe(false);
    expect(upload).not.toHaveBeenCalled();
  });

  it('si el borrado del healthcheck falla, igual cuenta como escribible', async () => {
    upload.mockResolvedValue({ error: null });
    remove.mockRejectedValueOnce(new Error('no se pudo borrar'));
    const r = await verificarStorage();
    expect(r.escribible).toBe(true); // lo que importa es que la ESCRITURA anduvo
  });
});

describe('motivoStorageCaido', () => {
  it('le dice al comerciante lo único que le importa: no se emitió nada y no se le cobró', () => {
    const m = motivoStorageCaido('exceed_egress_quota');
    expect(m).toMatch(/No se procesó ningún pedido/);
    expect(m).toMatch(/no se emitió ninguna guía/i);
    expect(m).toMatch(/no se descontó ningún envío/i);
    expect(m).toContain('exceed_egress_quota'); // y el detalle técnico, para el operador
  });
});
