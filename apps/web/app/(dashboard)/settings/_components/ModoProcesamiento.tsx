'use client';

import { Zap, Clock, Wrench, Check } from 'lucide-react';
import { cn } from '@/lib/cn';
import { cronForMode, type ProcessingMode, type StoreKind } from '@/lib/onboarding-state';

/**
 * Selector "Cada cuánto procesamos tus pedidos" (D33, paso 5 del wizard y
 * bloque 1 de Configuración > Parámetros). Escribe `cronSchedule` directo:
 * Inmediato = '*\/15 * * * *' (más el webhook cuando existe), Cada hora =
 * '0 * * * *'. Los slots por horario siguen existiendo para el admin
 * ("Programación automática"); si el tenant tiene uno de esos crons, acá se
 * ve como "Horario personalizado" y elegir una opción lo reemplaza.
 */
export type SelectableMode = Exclude<ProcessingMode, 'personalizado'>;

export function ModoProcesamiento({
  value,
  currentMode,
  storeKind,
  onChange,
  disabled,
}: {
  /** Lo que el usuario tiene elegido en pantalla (puede no estar guardado). */
  value: SelectableMode | null;
  /** Lo que está guardado en la base (para mostrar "personalizado"). */
  currentMode: ProcessingMode;
  storeKind: StoreKind;
  onChange: (mode: SelectableMode) => void;
  disabled?: boolean;
}) {
  const sinWebhook = storeKind !== 'shopify';
  const opciones: Array<{
    id: SelectableMode;
    icon: typeof Zap;
    title: string;
    badge?: string;
    text: string;
    note?: string;
  }> = [
    {
      id: 'inmediato',
      icon: Zap,
      title: 'Inmediato',
      badge: 'Recomendado',
      text: 'Apenas un pedido queda pago, lo procesamos. Además revisamos la tienda cada 15 minutos por si algo se escapó.',
      note: sinWebhook
        ? 'Con tu forma de conexión, el aviso instantáneo no está disponible: los pedidos entran en la revisión de cada 15 minutos.'
        : undefined,
    },
    {
      id: 'cada_hora',
      icon: Clock,
      title: 'Cada hora',
      text: 'Juntamos lo que entró y lo procesamos en punto, una vez por hora (por ejemplo 10:00, 11:00, 12:00). Útil si preferís revisar antes de que salgan.',
    },
  ];

  return (
    <div className="space-y-3" role="radiogroup" aria-label="Modo de procesamiento">
      {opciones.map((o) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.id)}
            className={cn(
              'w-full text-left p-4 rounded-xl border transition-all disabled:opacity-60',
              active
                ? 'bg-cyan-500/[0.08] border-cyan-500/40 ring-1 ring-cyan-500/30'
                : 'bg-white/[0.02] border-white/[0.08] hover:border-white/[0.15]',
            )}
          >
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
                  active ? 'bg-cyan-500/20 text-cyan-300' : 'bg-white/[0.04] text-zinc-500',
                )}
              >
                <o.icon className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className={cn('text-sm font-semibold', active ? 'text-white' : 'text-zinc-200')}>{o.title}</p>
                  {o.badge && (
                    <span className="text-[10px] uppercase tracking-wide text-cyan-300 bg-cyan-500/10 border border-cyan-500/20 rounded px-1.5 py-0.5">
                      {o.badge}
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-400 mt-1 leading-relaxed">{o.text}</p>
                {o.note && <p className="text-[11px] text-amber-200/80 mt-1.5 leading-relaxed">{o.note}</p>}
              </div>
              <div
                className={cn(
                  'w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 mt-0.5',
                  active ? 'border-cyan-400 bg-cyan-500' : 'border-white/[0.15]',
                )}
              >
                {active && <Check className="w-3 h-3 text-white" />}
              </div>
            </div>
          </button>
        );
      })}

      {currentMode === 'personalizado' && (
        <div className="p-4 rounded-xl border border-dashed border-white/[0.1] bg-white/[0.01]">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-white/[0.04] text-zinc-500 flex items-center justify-center flex-shrink-0">
              <Wrench className="w-4 h-4" />
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-300">Horario personalizado (configurado por soporte)</p>
              <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
                Hoy tus pedidos se procesan con un horario a medida. Si elegís una opción de arriba, reemplaza ese horario.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Guarda el modo elegido escribiendo `cronSchedule` (misma validación que hoy). */
export async function saveProcessingMode(mode: SelectableMode): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/v1/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cronSchedule: cronForMode(mode) }),
  });
  if (res.ok) return { ok: true };
  let error = 'No se pudo guardar el modo';
  try {
    const data = await res.json();
    if (data?.error) error = data.error;
  } catch {
    // sin cuerpo
  }
  return { ok: false, error };
}
