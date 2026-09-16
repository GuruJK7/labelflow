'use client';

/**
 * Importar una planilla de pedidos.
 *
 * Tres pasos, y ninguna fila entra a la base sin pasar por el del medio:
 *   1. Elegir el archivo → se parsea EN EL NAVEGADOR.
 *   2. Revisión: el servidor valida y devuelve, fila por fila, qué entra y qué no.
 *   3. Importar sólo las válidas.
 *
 * 🔴 El parseo va del lado del cliente a propósito. `xlsx@0.18.5` —la última que
 * SheetJS publicó en npm— arrastra CVE-2023-30533 (prototype pollution al leer un
 * archivo armado a mano). Leyéndolo acá, un archivo malicioso sólo puede afectar
 * la pestaña de quien lo subió, nunca el proceso del servidor. No se pierde nada:
 * el servidor re-valida TODO con `normalizarPedido`, así que nunca confió en lo
 * que viene del cliente.
 *
 * El `import('xlsx')` es dinámico para que la librería (~900 KB) no la pague
 * quien entra a la pantalla y no importa nada.
 */

import { useRef, useState } from 'react';
import { Upload, FileDown, AlertCircle, CheckCircle2, X } from 'lucide-react';
import {
  filasAPedidos,
  COLUMNAS_PLANTILLA,
  EJEMPLO_PLANTILLA,
  type FilaImportada,
} from '@/lib/importar-excel';

type Validacion =
  | { fila: number; ok: true; resumen: { nombre: string; email: string | null; destino: string | null; departamento: string; totalUyu: number; contraEntrega: boolean } }
  | { fila: number; ok: false; errores: string[] };

const pesos = (n: number) => `$ ${n.toLocaleString('es-UY')}`;

export function ImportarExcel({
  onImportado,
  correoEnabled,
}: {
  onImportado: (texto: string) => void;
  /** La tienda despacha por Correo Uruguayo: sin columna de mail no sale nada. */
  correoEnabled: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [paso, setPaso] = useState<'elegir' | 'leyendo' | 'revisar' | 'importando'>('elegir');
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState<string[]>([]);
  const [filas, setFilas] = useState<FilaImportada[]>([]);
  const [validaciones, setValidaciones] = useState<Validacion[]>([]);
  const [nombreArchivo, setNombreArchivo] = useState('');

  const validas = validaciones.filter((v) => v.ok);
  const invalidas = validaciones.filter((v) => !v.ok);

  async function elegirArchivo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Se limpia el input para que elegir el MISMO archivo otra vez vuelva a disparar.
    e.target.value = '';
    if (!file) return;

    setError('');
    setAviso([]);
    setNombreArchivo(file.name);
    setPaso('leyendo');

    try {
      const XLSX = await import('xlsx');
      const buf = await file.arrayBuffer();
      const libro = XLSX.read(buf, { type: 'array', cellDates: true });
      const hoja = libro.Sheets[libro.SheetNames[0]];
      if (!hoja) {
        setError('No pude leer ninguna hoja del archivo.');
        setPaso('elegir');
        return;
      }
      // `defval: ''` para que las celdas vacías existan como clave: si no, una
      // fila a la que le falta la última columna cambiaría el shape.
      const crudas = XLSX.utils.sheet_to_json<Record<string, unknown>>(hoja, { defval: '' });
      const r = filasAPedidos(crudas);

      if (r.filas.length === 0) {
        setError('El archivo no tiene ninguna fila con datos.');
        setPaso('elegir');
        return;
      }

      const avisos: string[] = [];
      if (r.columnasFaltantes.length > 0) {
        avisos.push(`No encontré columna para: ${r.columnasFaltantes.join(', ')}. Esas filas van a quedar afuera.`);
      }
      if (r.columnasIgnoradas.length > 0) {
        avisos.push(`Ignoré estas columnas porque no sé qué son: ${r.columnasIgnoradas.join(', ')}.`);
      }
      // El servidor va a rechazar fila por fila («Falta el email…»), pero el
      // motivo de fondo es UNO —falta la columna— y se dice una sola vez, arriba.
      if (correoEnabled && !r.columnasPresentes.includes('email')) {
        avisos.push(
          'No encontré la columna Email, y tu tienda despacha por Correo Uruguayo: sin el mail del comprador el pedido no sale. Agregala al archivo y volvé a subirlo.',
        );
      }
      setAviso(avisos);
      setFilas(r.filas);

      // La validación la hace el SERVIDOR, para que lo que se ve acá y lo que
      // después acepta el alta no puedan decir cosas distintas.
      const res = await fetch('/api/v1/pedidos/validar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filas: r.filas }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? 'No se pudo revisar el archivo');
        setPaso('elegir');
        return;
      }
      setValidaciones(json.data ?? []);
      setPaso('revisar');
    } catch (err) {
      setError(`No pude leer el archivo: ${(err as Error).message}`);
      setPaso('elegir');
    }
  }

  async function importar() {
    setPaso('importando');
    setError('');
    try {
      const filasValidas = new Set(validas.map((v) => v.fila));
      const pedidos = filas.filter((f) => filasValidas.has(f.fila)).map((f) => f.pedido);

      const res = await fetch('/api/v1/pedidos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pedidos }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? 'No se pudieron importar');
        setPaso('revisar');
        return;
      }
      const n = json.data?.creados ?? pedidos.length;
      cancelar();
      onImportado(
        `Importé ${n} pedido${n === 1 ? '' : 's'}.` +
          (invalidas.length > 0 ? ` Quedaron ${invalidas.length} afuera por errores.` : ''),
      );
    } catch {
      setError('Error de conexión. Probá de nuevo.');
      setPaso('revisar');
    }
  }

  function cancelar() {
    setPaso('elegir');
    setFilas([]);
    setValidaciones([]);
    setAviso([]);
    setError('');
    setNombreArchivo('');
  }

  async function bajarPlantilla() {
    const XLSX = await import('xlsx');
    const hoja = XLSX.utils.json_to_sheet(EJEMPLO_PLANTILLA, { header: [...COLUMNAS_PLANTILLA] });
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Pedidos');
    XLSX.writeFile(libro, 'plantilla-pedidos-autoenvia.xlsx');
  }

  if (paso === 'revisar' || paso === 'importando') {
    return (
      <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4">
        <div className="w-full max-w-3xl my-8 rounded-2xl border border-white/[0.08] bg-zinc-900 p-6">
          <div className="flex items-start justify-between mb-5">
            <div>
              <h2 className="text-base font-semibold text-white">Revisá antes de importar</h2>
              <p className="text-xs text-zinc-500 mt-1">{nombreArchivo}</p>
            </div>
            <button onClick={cancelar} className="p-1 text-zinc-500 hover:text-white">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex gap-3 mb-5">
            <div className="flex-1 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3">
              <div className="text-xl font-semibold text-emerald-400">{validas.length}</div>
              <div className="text-xs text-zinc-400">se van a importar</div>
            </div>
            {invalidas.length > 0 && (
              <div className="flex-1 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-4 py-3">
                <div className="text-xl font-semibold text-red-400">{invalidas.length}</div>
                <div className="text-xs text-zinc-400">quedan afuera</div>
              </div>
            )}
          </div>

          {aviso.map((a, i) => (
            <div key={i} className="mb-3 px-4 py-2.5 rounded-lg text-xs bg-amber-500/10 text-amber-300 border border-amber-500/20">
              {a}
            </div>
          ))}
          {error && (
            <div className="mb-3 px-4 py-2.5 rounded-lg text-sm bg-red-500/10 text-red-300 border border-red-500/20">
              {error}
            </div>
          )}

          {invalidas.length > 0 && (
            <div className="mb-5">
              <h3 className="text-xs font-medium text-zinc-400 mb-2">Filas con problemas</h3>
              <div className="rounded-lg border border-white/[0.06] divide-y divide-white/[0.04] max-h-56 overflow-y-auto">
                {invalidas.map((v) => (
                  <div key={v.fila} className="px-4 py-2.5 flex gap-3 items-start">
                    <span className="text-xs text-zinc-500 font-mono shrink-0 mt-0.5">Fila {v.fila}</span>
                    <div className="text-xs text-red-300">
                      {!v.ok && v.errores.join(' · ')}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-zinc-500 mt-2">
                Corregilas en el Excel y volvé a subirlo, o importá las {validas.length} buenas ahora y las demás después.
              </p>
            </div>
          )}

          {validas.length > 0 && (
            <div className="mb-5">
              <h3 className="text-xs font-medium text-zinc-400 mb-2">Lo que se va a importar</h3>
              <div className="rounded-lg border border-white/[0.06] max-h-56 overflow-y-auto">
                <table className="w-full text-xs">
                  <tbody className="divide-y divide-white/[0.04]">
                    {validas.map((v) => (
                      <tr key={v.fila}>
                        <td className="px-3 py-2 text-zinc-600 font-mono w-14">{v.fila}</td>
                        <td className="px-3 py-2 text-white">
                          {v.ok && v.resumen.nombre}
                          {v.ok && v.resumen.email && <div className="text-zinc-500">{v.resumen.email}</div>}
                        </td>
                        <td className="px-3 py-2 text-zinc-400">
                          {v.ok && v.resumen.destino}<span> · </span>{v.ok && v.resumen.departamento}
                        </td>
                        <td className="px-3 py-2 text-zinc-300 text-right whitespace-nowrap">
                          {v.ok && pesos(v.resumen.totalUyu)}
                          {v.ok && v.resumen.contraEntrega && <span className="text-amber-400 ml-1.5">a cobrar</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={cancelar} className="px-4 py-2 rounded-lg text-sm text-zinc-400 hover:text-white">
              Cancelar
            </button>
            <button
              onClick={importar}
              disabled={validas.length === 0 || paso === 'importando'}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-cyan-500 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50"
            >
              {paso === 'importando'
                ? 'Importando…'
                : `Importar ${validas.length} pedido${validas.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls,.csv"
        onChange={elegirArchivo}
        className="hidden"
      />
      <button
        onClick={() => fileRef.current?.click()}
        disabled={paso === 'leyendo'}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.06] text-white border border-white/[0.08] hover:bg-white/[0.1] disabled:opacity-50"
      >
        <Upload className="w-4 h-4" />
        {paso === 'leyendo' ? <span>Leyendo…</span> : <span>Importar Excel</span>}
      </button>
      <button
        onClick={bajarPlantilla}
        className="inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300"
        title="Descargar una planilla de ejemplo con las columnas que esperamos"
      >
        <FileDown className="w-3.5 h-3.5" />
        Plantilla
      </button>
      {error && (
        <span className="inline-flex items-center gap-1.5 text-xs text-red-400">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </span>
      )}
      {paso === 'elegir' && !error && validaciones.length === 0 && nombreArchivo && (
        <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>Listo</span>
        </span>
      )}
    </>
  );
}
