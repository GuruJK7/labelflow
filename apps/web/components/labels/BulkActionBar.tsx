'use client';

import { Download, Printer, X, Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

interface BulkActionBarProps {
  selectedCount: number;
  onPrint: () => void;
  onDownload: () => void;
  onClear: () => void;
  loading: 'print' | 'download' | null;
}

export function BulkActionBar({
  selectedCount,
  onPrint,
  onDownload,
  onClear,
  loading,
}: BulkActionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div
      className={cn(
        'fixed bottom-20 left-1/2 -translate-x-1/2 z-[9999]',
        'flex items-center gap-3 px-5 py-3',
        'bg-zinc-900/95 backdrop-blur-xl border border-cyan-500/20 rounded-2xl shadow-2xl shadow-cyan-500/10',
        'animate-fade-in-up'
      )}
    >
      {/* Count */}
      <div className="flex items-center gap-2 pr-3 border-r border-white/10">
        <span className="text-sm font-semibold text-white">{selectedCount}</span>
        <span className="text-xs text-zinc-400">
          {selectedCount === 1 ? 'seleccionada' : 'seleccionadas'}
        </span>
      </div>

      {/* Clear button */}
      <button
        onClick={onClear}
        className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
        title="Limpiar seleccion"
      >
        <X className="w-4 h-4" />
      </button>

      {/* Download button */}
      <button
        onClick={onDownload}
        disabled={loading !== null}
        className={cn(
          'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium transition-all',
          'bg-white/[0.05] border border-white/[0.08] text-zinc-300',
          'hover:bg-white/[0.08] hover:text-white hover:border-white/[0.12]',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
      >
        {loading === 'download' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Download className="w-3.5 h-3.5" />
        )}
        Descargar
      </button>

      {/* Print button */}
      <button
        onClick={onPrint}
        disabled={loading !== null}
        className={cn(
          'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-medium transition-all',
          'bg-cyan-600 border border-cyan-500 text-white',
          'hover:bg-cyan-500 hover:shadow-lg hover:shadow-cyan-500/20',
          'disabled:opacity-50 disabled:cursor-not-allowed'
        )}
      >
        {loading === 'print' ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Printer className="w-3.5 h-3.5" />
        )}
        Imprimir
      </button>
    </div>
  );
}
