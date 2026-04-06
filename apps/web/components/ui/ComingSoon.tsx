'use client';

import { Clock, Sparkles } from 'lucide-react';

interface ComingSoonProps {
  title: string;
  description?: string;
}

export function ComingSoon({ title, description }: ComingSoonProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6">
      <div className="relative mb-6">
        <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-purple-500/20 border border-white/[0.08] flex items-center justify-center">
          <Sparkles className="w-9 h-9 text-cyan-400" />
        </div>
        <div className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
          <Clock className="w-3 h-3 text-amber-400" />
        </div>
      </div>
      <h2 className="text-xl font-semibold text-white mb-2">{title}</h2>
      <p className="text-sm text-zinc-500 text-center max-w-md mb-6">
        {description ?? 'Esta funcionalidad esta en desarrollo y estara disponible pronto.'}
      </p>
      <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-medium">
        <Clock className="w-3.5 h-3.5" />
        Coming Soon
      </div>
    </div>
  );
}
