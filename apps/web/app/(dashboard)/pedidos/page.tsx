'use client';

/**
 * Pedidos de la carga propia — listar, cargar a mano, editar, borrar y despachar.
 *
 * Es la pantalla que hace usable la fuente interna: sin esto el comerciante que
 * no vende por Shopify no tiene dónde poner un pedido.
 *
 * Reglas que se ven en la UI y valen también en el servidor (las dos puntas, a
 * propósito — un botón deshabilitado no es una garantía):
 *   · Editar y borrar SÓLO mientras está pendiente. Con la guía emitida el
 *     pedido queda congelado: una guía de DAC no se deshace desde acá.
 *   · "Despachar ahora" encola el mismo job que el cron. No es un camino
 *     paralelo: es el mismo, sin esperar.
 */

import { useState, useEffect, useCallback } from 'react';
import { Plus, Package, Trash2, Pencil, Send, AlertCircle } from 'lucide-react';
import { DEPARTAMENTOS_CANONICOS } from '@/lib/departamentos';

interface ItemPedido {
  nombre: string;
  cantidad: number;
  precio: number;
}

interface Pedido {
  id: string;
  estado: 'PENDIENTE' | 'DESPACHADO' | 'CANCELADO';
  nombre: string;
  telefono: string;
  documento: string | null;
  departamento: string;
  localidad: string | null;
  direccion: string | null;
  agencia: string | null;
  referencia: string | null;
  items: ItemPedido[];
  totalUyu: number;
  contraEntrega: boolean;
  observaciones: string | null;
  dacGuia: string | null;
  errorMessage: string | null;
  createdAt: string;
}

const ESTADO_UI: Record<Pedido['estado'], { label: string; clase: string }> = {
  PENDIENTE: { label: 'Pendiente', clase: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  DESPACHADO: { label: 'Despachado', clase: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
  CANCELADO: { label: 'Cancelado', clase: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20' },
};

const INPUT =
  'w-full px-3 py-2 bg-zinc-800/50 border border-white/[0.08] rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40';
const LABEL = 'block text-xs font-medium text-zinc-400 mb-1.5';

const pesos = (n: number) => `$ ${n.toLocaleString('es-UY')}`;

export default function PedidosPage() {
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [total, setTotal] = useState(0);
  const [pendientes, setPendientes] = useState(0);
  const [page, setPage] = useState(1);
  const [cargando, setCargando] = useState(true);
  const [modal, setModal] = useState<{ abierto: boolean; editando: Pedido | null }>({ abierto: false, editando: null });
  const [despachando, setDespachando] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);
  const limit = 20;

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await fetch(`/api/v1/pedidos?page=${page}&limit=${limit}`);
      const json = await res.json();
      setPedidos(json.data ?? []);
      setTotal(json.meta?.total ?? 0);
      setPendientes(json.meta?.pendientes ?? 0);
    } finally {
      setCargando(false);
    }
  }, [page]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(null), 5000);
    return () => clearTimeout(t);
  }, [aviso]);

  async function borrar(p: Pedido) {
    if (!confirm(`¿Borrar el pedido de ${p.nombre}?`)) return;
    const res = await fetch(`/api/v1/pedidos/${p.id}`, { method: 'DELETE' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return setAviso({ tipo: 'error', texto: json.error ?? 'No se pudo borrar' });
    setAviso({ tipo: 'ok', texto: 'Pedido borrado.' });
    void cargar();
  }

  async function despacharAhora() {
    setDespachando(true);
    try {
      const res = await fetch('/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAviso({ tipo: 'error', texto: json.error ?? 'No se pudo encolar el despacho' });
        return;
      }
      setAviso({
        tipo: 'ok',
        texto: `Despachando ${pendientes} pedido${pendientes === 1 ? '' : 's'}. En unos minutos vas a ver las guías acá y en Etiquetas.`,
      });
    } finally {
      setDespachando(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Pedidos</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Cargá tus pedidos acá y nosotros les sacamos la guía.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {pendientes > 0 && (
            <button
              onClick={despacharAhora}
              disabled={despachando}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-white/[0.06] text-white border border-white/[0.08] hover:bg-white/[0.1] disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              {despachando ? 'Encolando…' : `Despachar ${pendientes} ahora`}
            </button>
          )}
          <button
            onClick={() => setModal({ abierto: true, editando: null })}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-cyan-500 text-zinc-950 hover:bg-cyan-400"
          >
            <Plus className="w-4 h-4" />
            Cargar pedido
          </button>
        </div>
      </div>

      {aviso && (
        <div
          className={`mb-4 px-4 py-3 rounded-lg text-sm border ${
            aviso.tipo === 'ok'
              ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20'
              : 'bg-red-500/10 text-red-300 border-red-500/20'
          }`}
        >
          {aviso.texto}
        </div>
      )}

      {cargando ? (
        <div className="text-sm text-zinc-500 py-12 text-center">Cargando…</div>
      ) : pedidos.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-zinc-900/50 py-16 px-6 text-center">
          <Package className="w-8 h-8 text-zinc-600 mx-auto mb-3" />
          <p className="text-sm text-zinc-300 font-medium">Todavía no cargaste ningún pedido</p>
          <p className="text-xs text-zinc-500 mt-1.5 max-w-sm mx-auto leading-relaxed">
            Cargá el primero a mano. Cuando lo despaches, la guía y la etiqueta para imprimir aparecen en Etiquetas.
          </p>
          <button
            onClick={() => setModal({ abierto: true, editando: null })}
            className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-cyan-500 text-zinc-950 hover:bg-cyan-400"
          >
            <Plus className="w-4 h-4" />
            Cargar el primero
          </button>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/[0.06] bg-zinc-900/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-left">
                  {['Quién recibe', 'Dónde', 'Total', 'Estado', ''].map((h) => (
                    <th key={h} className="px-4 py-3 text-xs font-medium text-zinc-500">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pedidos.map((p) => (
                  <tr key={p.id} className="border-b border-white/[0.04] last:border-0">
                    <td className="px-4 py-3">
                      <div className="text-white">{p.nombre}</div>
                      <div className="text-xs text-zinc-500">{p.telefono}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-zinc-300">{p.agencia ? `Agencia ${p.agencia}` : p.direccion}</div>
                      <div className="text-xs text-zinc-500">
                        {p.departamento}
                        {p.localidad ? ` · ${p.localidad}` : ''}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="text-zinc-300">{pesos(p.totalUyu)}</div>
                      {p.contraEntrega && <div className="text-xs text-amber-400">Contra entrega</div>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-md text-xs border ${ESTADO_UI[p.estado].clase}`}>
                        {ESTADO_UI[p.estado].label}
                      </span>
                      {p.dacGuia && <div className="text-xs text-zinc-500 mt-1 font-mono">{p.dacGuia}</div>}
                      {p.errorMessage && (
                        <div className="text-xs text-red-400 mt-1 flex items-start gap-1">
                          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                          {p.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {/* Con la guía emitida no se edita ni se borra: ya salió. */}
                      {p.estado === 'PENDIENTE' && (
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => setModal({ abierto: true, editando: p })}
                            className="p-1.5 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06]"
                            title="Editar"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => borrar(p)}
                            className="p-1.5 rounded-md text-zinc-400 hover:text-red-400 hover:bg-white/[0.06]"
                            title="Borrar"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-white/[0.06]">
              <span className="text-xs text-zinc-500">
                Mostrando {(page - 1) * limit + 1}–{Math.min(page * limit, total)} de {total}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-3 py-1 rounded-md text-xs text-zinc-400 hover:bg-white/[0.06] disabled:opacity-40"
                >
                  Anterior
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-3 py-1 rounded-md text-xs text-zinc-400 hover:bg-white/[0.06] disabled:opacity-40"
                >
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {modal.abierto && (
        <ModalPedido
          inicial={modal.editando}
          onCerrar={() => setModal({ abierto: false, editando: null })}
          onGuardado={(texto) => {
            setModal({ abierto: false, editando: null });
            setAviso({ tipo: 'ok', texto });
            void cargar();
          }}
        />
      )}
    </div>
  );
}

/** Alta y edición comparten formulario: `inicial` distingue los dos casos. */
function ModalPedido({
  inicial,
  onCerrar,
  onGuardado,
}: {
  inicial: Pedido | null;
  onCerrar: () => void;
  onGuardado: (texto: string) => void;
}) {
  const editando = inicial !== null;
  const [nombre, setNombre] = useState(inicial?.nombre ?? '');
  const [telefono, setTelefono] = useState(inicial?.telefono ?? '');
  const [documento, setDocumento] = useState(inicial?.documento ?? '');
  const [departamento, setDepartamento] = useState(inicial?.departamento ?? '');
  const [localidad, setLocalidad] = useState(inicial?.localidad ?? '');
  const [entrega, setEntrega] = useState<'domicilio' | 'agencia'>(inicial?.agencia ? 'agencia' : 'domicilio');
  const [direccion, setDireccion] = useState(inicial?.direccion ?? '');
  const [agencia, setAgencia] = useState(inicial?.agencia ?? '');
  const [referencia, setReferencia] = useState(inicial?.referencia ?? '');
  const [items, setItems] = useState<Array<{ nombre: string; cantidad: string; precio: string }>>(
    inicial?.items?.length
      ? inicial.items.map((i) => ({ nombre: i.nombre, cantidad: String(i.cantidad), precio: String(i.precio) }))
      : [{ nombre: '', cantidad: '1', precio: '' }],
  );
  const [contraEntrega, setContraEntrega] = useState(inicial?.contraEntrega ?? false);
  const [observaciones, setObservaciones] = useState(inicial?.observaciones ?? '');
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');

  const total = items.reduce((s, it) => {
    const precio = Number(String(it.precio).replace(/\./g, '').replace(',', '.')) || 0;
    return s + precio * (Number(it.cantidad) || 1);
  }, 0);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setGuardando(true);
    try {
      const cuerpo = {
        nombre,
        telefono,
        documento,
        departamento,
        localidad,
        // Se manda sólo el camino elegido: si eligió agencia, la dirección no
        // viaja, para que no queden los dos y el worker tenga que adivinar.
        direccion: entrega === 'domicilio' ? direccion : null,
        agencia: entrega === 'agencia' ? agencia : null,
        referencia,
        items: items.filter((i) => i.nombre.trim()),
        contraEntrega,
        observaciones,
      };
      const res = await fetch(editando ? `/api/v1/pedidos/${inicial!.id}` : '/api/v1/pedidos', {
        method: editando ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? 'No se pudo guardar');
        return;
      }
      onGuardado(editando ? 'Pedido actualizado.' : 'Pedido cargado. Sale en la próxima corrida.');
    } catch {
      setError('Error de conexión. Probá de nuevo.');
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4" onClick={onCerrar}>
      <div
        className="w-full max-w-2xl my-8 rounded-2xl border border-white/[0.08] bg-zinc-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-white mb-5">
          {editando ? 'Editar pedido' : 'Cargar un pedido'}
        </h2>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg text-sm bg-red-500/10 text-red-300 border border-red-500/20">
            {error}
          </div>
        )}

        <form onSubmit={guardar} className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className={LABEL}>Nombre de quien recibe *</label>
              <input value={nombre} onChange={(e) => setNombre(e.target.value)} className={INPUT} placeholder="Carla Pérez" />
            </div>
            <div>
              <label className={LABEL}>Teléfono *</label>
              <input value={telefono} onChange={(e) => setTelefono(e.target.value)} className={INPUT} placeholder="099 887 766" />
            </div>
            <div>
              <label className={LABEL}>Cédula</label>
              <input value={documento} onChange={(e) => setDocumento(e.target.value)} className={INPUT} placeholder="4.512.345-6" />
            </div>
            <div>
              <label className={LABEL}>Departamento *</label>
              <select value={departamento} onChange={(e) => setDepartamento(e.target.value)} className={INPUT}>
                <option value="">Elegí uno</option>
                {DEPARTAMENTOS_CANONICOS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className={LABEL}>Cómo lo recibe</label>
            <div className="flex gap-2 mb-3">
              {(['domicilio', 'agencia'] as const).map((modo) => (
                <button
                  key={modo}
                  type="button"
                  onClick={() => setEntrega(modo)}
                  className={`px-3 py-1.5 rounded-lg text-xs border ${
                    entrega === modo
                      ? 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30'
                      : 'bg-white/[0.02] text-zinc-400 border-white/[0.08] hover:text-zinc-300'
                  }`}
                >
                  {modo === 'domicilio' ? 'En su casa' : 'Retira en una agencia'}
                </button>
              ))}
            </div>
            {entrega === 'domicilio' ? (
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className={LABEL}>Dirección *</label>
                  <input value={direccion} onChange={(e) => setDireccion(e.target.value)} className={INPUT} placeholder="Gorlero 1234 apto 302" />
                </div>
                <div>
                  <label className={LABEL}>Localidad</label>
                  <input value={localidad} onChange={(e) => setLocalidad(e.target.value)} className={INPUT} placeholder="Punta del Este" />
                </div>
              </div>
            ) : (
              <div>
                <label className={LABEL}>Agencia donde retira *</label>
                <input value={agencia} onChange={(e) => setAgencia(e.target.value)} className={INPUT} placeholder="Tres Cruces" />
                <p className="text-[11px] text-zinc-500 mt-1">El nombre de la sucursal de DAC, como figura en su lista.</p>
              </div>
            )}
          </div>

          <div>
            <label className={LABEL}>Qué le mandás *</label>
            <div className="space-y-2">
              {items.map((it, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={it.nombre}
                    onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, nombre: e.target.value } : x)))}
                    className={INPUT}
                    placeholder="Producto (podés agregarle el talle o color)"
                  />
                  <input
                    value={it.cantidad}
                    onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, cantidad: e.target.value } : x)))}
                    className={`${INPUT} w-20 shrink-0`}
                    placeholder="1"
                  />
                  <input
                    value={it.precio}
                    onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, precio: e.target.value } : x)))}
                    className={`${INPUT} w-28 shrink-0`}
                    placeholder="1.390"
                  />
                  {items.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setItems(items.filter((_, j) => j !== i))}
                      className="px-2 text-zinc-500 hover:text-red-400 shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between mt-2">
              <button
                type="button"
                onClick={() => setItems([...items, { nombre: '', cantidad: '1', precio: '' }])}
                className="text-xs text-cyan-400 hover:text-cyan-300"
              >
                + Agregar otro
              </button>
              <span className="text-sm text-zinc-300">Total: {pesos(total)}</span>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className={LABEL}>Referencia para el repartidor</label>
              <input value={referencia} onChange={(e) => setReferencia(e.target.value)} className={INPUT} placeholder="Portón negro, timbre 3" />
            </div>
            <div>
              <label className={LABEL}>Observaciones</label>
              <input value={observaciones} onChange={(e) => setObservaciones(e.target.value)} className={INPUT} placeholder="Llamar antes" />
            </div>
          </div>

          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={contraEntrega}
              onChange={(e) => setContraEntrega(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-white/20 bg-white/5"
            />
            <span className="text-sm text-zinc-300">
              Cobrar al entregar
              <span className="block text-xs text-zinc-500">
                El repartidor le cobra {pesos(total)} al recibir. Si ya te pagó, dejalo sin marcar.
              </span>
            </span>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onCerrar} className="px-4 py-2 rounded-lg text-sm text-zinc-400 hover:text-white">
              Cancelar
            </button>
            <button
              type="submit"
              disabled={guardando}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-cyan-500 text-zinc-950 hover:bg-cyan-400 disabled:opacity-50"
            >
              {guardando ? 'Guardando…' : editando ? 'Guardar cambios' : 'Cargar pedido'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
