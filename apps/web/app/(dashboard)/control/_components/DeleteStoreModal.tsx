'use client';

/**
 * "Eliminar tienda" — destructive confirmation modal for permanently deleting
 * a store and everything under it (pedidos, etiquetas, historial). Calls
 * DELETE /api/v1/tenants/[id] (ownership + guards server-side). The confirm
 * button only enables once the user types the exact store name, so a delete
 * can never be a one-click accident. On success it calls onDeleted() so the
 * parent can refresh the overview and drop the card.
 */

import { useEffect, useState } from 'react';
import { X, AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { cn } from '@/lib/cn';

export function DeleteStoreModal({
  tenantId,
  tenantName,
  onClose,
  onDeleted,
}: {
  tenantId: string;
  tenantName: string;
  onClose: () => void;
  onDeleted: (name: string) => void;
}) {
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const match = confirm.trim() === tenantName.trim();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, deleting]);

  const handleDelete = async () => {
    if (!match || deleting) return;
    setDeleting(true);
    setError('');
    try {
      const res = await fetch(`/api/v1/tenants/${encodeURIComponent(tenantId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: confirm.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? 'No se pudo eliminar la tienda');
        setDeleting(false);
        return;
      }
      onDeleted(tenantName);
    } catch {
      setError('Error de conexion');
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={() => !deleting && onClose()}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative glass rounded-2xl w-full max-w-md border border-red-500/20 shadow-2xl"
      >
        {/* header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06]">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
            <Trash2 className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-white truncate">Eliminar tienda</h2>
            <p className="text-[11px] text-zinc-500 truncate">{tenantName}</p>
          </div>
          <button
            onClick={() => !deleting && onClose()}
            disabled={deleting}
            aria-label="Cerrar"
            className="ml-auto p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* body */}
        <div className="px-5 py-4 space-y-4">
          <div className="flex gap-3 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3.5 py-3">
            <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-[12px] leading-relaxed text-red-200/90">
              Esta acción es <span className="font-semibold">permanente</span>. Se eliminarán la
              tienda y <span className="font-semibold">todos sus datos</span> (pedidos, etiquetas,
              guías e historial). No se puede deshacer.
            </p>
          </div>

          <div>
            <label className="block text-[11px] text-zinc-400 mb-1.5">
              Escribí <span className="font-mono text-zinc-200">{tenantName}</span> para confirmar:
            </label>
            <input
              autoFocus
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleDelete()}
              disabled={deleting}
              placeholder={tenantName}
              className="w-full rounded-xl bg-white/[0.03] border border-white/[0.1] px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-red-500/40 disabled:opacity-50"
            />
          </div>

          {error && <p className="text-[12px] text-red-400">{error}</p>}
        </div>

        {/* footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/[0.06]">
          <button
            onClick={() => !deleting && onClose()}
            disabled={deleting}
            className="px-3.5 py-2 rounded-xl text-sm font-medium text-zinc-300 hover:text-white hover:bg-white/[0.05] transition-colors disabled:opacity-40"
          >
            Cancelar
          </button>
          <button
            onClick={handleDelete}
            disabled={!match || deleting}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors',
              match && !deleting
                ? 'bg-red-500 text-white hover:bg-red-400'
                : 'bg-red-500/20 text-red-300/50 cursor-not-allowed',
            )}
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            {deleting ? 'Eliminando...' : 'Eliminar definitivamente'}
          </button>
        </div>
      </div>
    </div>
  );
}
