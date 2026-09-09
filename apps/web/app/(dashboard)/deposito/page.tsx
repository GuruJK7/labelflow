'use client';

/**
 * Depósito — etiquetas distribuidas por cliente.
 *
 * El resumen (cuántas por marca) sale de /api/v1/control/depo-etiquetas. El
 * detalle de UNA marca reusa /api/v1/control/labels, que es el mismo endpoint
 * que ya alimenta el modal "Pedidos ejecutados" de Control: no se duplica la
 * consulta ni su manejo de privacidad (el PDF se firma aparte, on demand).
 */

import { useCallback, useEffect, useState } from 'react';
import { Warehouse, RefreshCw, AlertTriangle, ChevronDown, FileText, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { pct } from '@/lib/depo-etiquetas';

interface FilaCliente {
  tenantId: string;
  tenantName: string;
  esDeposito: boolean;
  total: number;
}

interface Resumen {
  desde: string;
  hasta: string;
  soloDeposito: boolean;
  truncado: boolean;
  clientes: FilaCliente[];
  total: number;
}

interface EtiquetaDetalle {
  id: string;
  orderName: string;
  customer: string;
  city: string;
  status: string;
  dacGuia: string | null;
  createdAt: string;
  hasPdf: boolean;
}

/** `YYYY-MM-DD` de hoy en Uruguay (UTC-3), sin depender de la zona del navegador. */
function hoyUy(): string {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function restarDias(ymd: string, dias: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - dias * 86400000).toISOString().slice(0, 10);
}

function fechaCorta(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit' }) +
    ' ' + d.toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' });
}

export default function DepositoPage() {
  const hoy = hoyUy();
  const [desde, setDesde] = useState(() => restarDias(hoy, 29));
  const [hasta, setHasta] = useState(hoy);
  const [soloDeposito, setSoloDeposito] = useState(true);
  const [data, setData] = useState<Resumen | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detalle de un cliente, cargado sólo cuando se abre la fila.
  const [abierto, setAbierto] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<EtiquetaDetalle[]>([]);
  const [cargandoDetalle, setCargandoDetalle] = useState(false);
  const [errorDetalle, setErrorDetalle] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ desde, hasta, soloDeposito: soloDeposito ? '1' : '0' });
      const res = await fetch(`/api/v1/control/depo-etiquetas?${qs}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'No se pudo cargar el resumen');
      setData(json.data ?? json);
      setAbierto(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el resumen');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [desde, hasta, soloDeposito]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const abrir = useCallback(async (tenantId: string) => {
    if (abierto === tenantId) {
      setAbierto(null);
      return;
    }
    setAbierto(tenantId);
    setDetalle([]);
    setErrorDetalle(null);
    setCargandoDetalle(true);
    try {
      const res = await fetch(`/api/v1/control/labels?tenantId=${encodeURIComponent(tenantId)}&status=COMPLETED&limit=100`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? 'No se pudieron cargar las etiquetas');
      setDetalle(json.data ?? json ?? []);
    } catch (e) {
      setErrorDetalle(e instanceof Error ? e.message : 'No se pudieron cargar las etiquetas');
    } finally {
      setCargandoDetalle(false);
    }
  }, [abierto]);

  return (
    <div className="animate-fade-in">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-xs font-medium tracking-widest text-cyan-400/80 uppercase mb-1 flex items-center gap-1.5">
            <Warehouse className="w-3.5 h-3.5" />
            Depósito
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Etiquetas por cliente</h1>
          <p className="mt-1 text-xs text-zinc-500">
            Envíos realmente emitidos en el rango. Tocá un cliente para ver sus etiquetas.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Desde</span>
            <input
              type="date"
              value={desde}
              max={hasta}
              onChange={(e) => setDesde(e.target.value)}
              className="glass rounded-xl px-3 py-2 text-sm text-white [color-scheme:dark]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">Hasta</span>
            <input
              type="date"
              value={hasta}
              min={desde}
              onChange={(e) => setHasta(e.target.value)}
              className="glass rounded-xl px-3 py-2 text-sm text-white [color-scheme:dark]"
            />
          </label>
          <button
            onClick={() => void cargar()}
            disabled={loading}
            className="glass rounded-xl px-3 py-2 text-sm text-zinc-300 hover:text-white transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            Actualizar
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 mb-5">
        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={soloDeposito}
            onChange={(e) => setSoloDeposito(e.target.checked)}
            className="accent-cyan-400"
          />
          <span className="text-xs text-zinc-400">
            Sólo tiendas del depósito
            <span className="text-zinc-600"> · destildá para ver todas</span>
          </span>
        </label>
        {data && (
          <span className="text-xs text-zinc-500">
            <span className="text-white font-semibold tabular-nums">{data.total}</span> etiquetas ·{' '}
            <span className="text-white font-semibold tabular-nums">{data.clientes.length}</span>{' '}
            {data.clientes.length === 1 ? 'cliente' : 'clientes'}
          </span>
        )}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm mb-5 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {data?.truncado && (
        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-400 px-4 py-3 rounded-xl text-sm mb-5 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          El rango tiene demasiadas etiquetas y el total está recortado. Achicá las fechas para un número exacto.
        </div>
      )}

      <div className="glass rounded-2xl overflow-hidden">
        {loading && !data ? (
          <div className="flex items-center justify-center py-24 text-zinc-500">
            <RefreshCw className="w-5 h-5 animate-spin mr-2" />
            Cargando…
          </div>
        ) : !data || data.clientes.length === 0 ? (
          <div className="py-20 text-center">
            <Warehouse className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
            <p className="text-sm text-zinc-400">No se emitió ninguna etiqueta en este rango.</p>
            <p className="text-xs text-zinc-600 mt-1">
              Probá ampliar las fechas{soloDeposito ? ' o destildar «sólo tiendas del depósito»' : ''}.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/[0.04]">
            {data.clientes.map((c) => {
              const p = pct(c.total, data.total);
              const estaAbierto = abierto === c.tenantId;
              return (
                <div key={c.tenantId}>
                  <button
                    onClick={() => void abrir(c.tenantId)}
                    className="w-full px-5 py-4 flex items-center gap-4 hover:bg-white/[0.02] transition-colors text-left"
                  >
                    <ChevronDown
                      className={cn(
                        'w-4 h-4 text-zinc-600 shrink-0 transition-transform',
                        estaAbierto && 'rotate-180 text-cyan-400',
                      )}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-white">{c.tenantName}</span>
                      {c.esDeposito && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider text-cyan-400/80 border border-cyan-400/20 rounded px-1.5 py-0.5">
                          depósito
                        </span>
                      )}
                    </div>
                    <div className="hidden sm:flex items-center gap-2 shrink-0">
                      <div className="h-1.5 w-24 rounded-full bg-white/[0.06] overflow-hidden">
                        <div className="h-full bg-cyan-400/70" style={{ width: `${p}%` }} />
                      </div>
                      <span className="text-[11px] text-zinc-500 tabular-nums w-9 text-right">{p}%</span>
                    </div>
                    <span className="text-xl font-bold text-white tabular-nums w-16 text-right shrink-0">
                      {c.total}
                    </span>
                  </button>

                  {estaAbierto && (
                    <div className="bg-black/20 px-5 py-4 border-t border-white/[0.04]">
                      {cargandoDetalle ? (
                        <div className="flex items-center text-zinc-500 text-sm py-6 justify-center">
                          <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Cargando etiquetas…
                        </div>
                      ) : errorDetalle ? (
                        <div className="text-red-400 text-sm flex items-center gap-2 py-2">
                          <X className="w-4 h-4" /> {errorDetalle}
                        </div>
                      ) : detalle.length === 0 ? (
                        <p className="text-sm text-zinc-500 py-2">Sin etiquetas para mostrar.</p>
                      ) : (
                        <>
                          <p className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
                            Últimas {detalle.length} etiquetas emitidas
                          </p>
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-[10px] uppercase tracking-wider text-zinc-600">
                                  <th className="text-left font-medium py-2 pr-4">Pedido</th>
                                  <th className="text-left font-medium py-2 pr-4">Cliente</th>
                                  <th className="text-left font-medium py-2 pr-4">Ciudad</th>
                                  <th className="text-left font-medium py-2 pr-4">Guía</th>
                                  <th className="text-left font-medium py-2 pr-4">Fecha</th>
                                  <th className="text-right font-medium py-2">PDF</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-white/[0.03]">
                                {detalle.map((e) => (
                                  <tr key={e.id} className="text-zinc-400">
                                    <td className="py-2 pr-4 text-white whitespace-nowrap">{e.orderName}</td>
                                    <td className="py-2 pr-4 truncate max-w-[16ch]">{e.customer}</td>
                                    <td className="py-2 pr-4 truncate max-w-[14ch]">{e.city}</td>
                                    <td className="py-2 pr-4 font-mono text-[11px] whitespace-nowrap">
                                      {e.dacGuia ?? '—'}
                                    </td>
                                    <td className="py-2 pr-4 whitespace-nowrap">{fechaCorta(e.createdAt)}</td>
                                    <td className="py-2 text-right">
                                      {e.hasPdf ? (
                                        <a
                                          href={`/api/v1/control/labels/${e.id}/pdf`}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300"
                                        >
                                          <FileText className="w-3 h-3" /> ver
                                        </a>
                                      ) : (
                                        <span className="text-zinc-700">—</span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
