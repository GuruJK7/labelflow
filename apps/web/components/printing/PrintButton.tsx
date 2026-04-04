'use client';

export function PrintButton({ labelId, pdfPath, size }: { labelId: string; pdfPath: string | null; size?: string }) {
  if (!pdfPath) return null;
  return (
    <a
      href={`/api/v1/labels/${labelId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-center p-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-zinc-400 hover:text-cyan-400 hover:border-cyan-500/20 transition-colors"
      title="Imprimir"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width={size === 'md' ? 16 : 14} height={size === 'md' ? 16 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/></svg>
    </a>
  );
}
