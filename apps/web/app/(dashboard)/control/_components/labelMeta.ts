/**
 * Shared label presentation helpers for the control dashboard feeds
 * (store card timeAgo, the "Pedidos ejecutados" modal, and the global
 * "Ultimos envios" feed). Single source so status colors / filters / relative
 * time can't drift across components.
 */

/** Relative time in Spanish. `null` -> 'nunca' (e.g. a store never run). */
export function timeAgo(value: string | null): string {
  if (!value) return 'nunca';
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 0) return 'ahora';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'hace instantes';
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

/** Status badge label + Tailwind classes per LabelStatus. */
export const STATUS_META: Record<string, { label: string; cls: string }> = {
  COMPLETED: { label: 'Completado', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
  CREATED: { label: 'Creado', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
  FAILED: { label: 'Fallido', cls: 'text-red-300 bg-red-500/10 border-red-500/20' },
  NEEDS_REVIEW: { label: 'Revisar', cls: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
  PENDING: { label: 'Pendiente', cls: 'text-zinc-300 bg-white/[0.04] border-white/10' },
  SKIPPED: { label: 'Omitido', cls: 'text-zinc-400 bg-white/[0.03] border-white/10' },
};

/** True when the label is a dispatched shipment (a DAC guia was minted). */
export function isDispatched(status: string): boolean {
  return status === 'COMPLETED' || status === 'CREATED';
}

/**
 * Status filter chips for the feeds. NOTE: the 'COMPLETED' filter means the
 * codebase's dispatched-shipment set (CREATED|COMPLETED); the API expands it
 * server-side so a guia-minted-but-PDF-pending (CREATED) label is not hidden.
 */
export const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'Todos' },
  { key: 'COMPLETED', label: 'Completados' },
  { key: 'FAILED', label: 'Fallidos' },
  { key: 'NEEDS_REVIEW', label: 'Revisar' },
];
