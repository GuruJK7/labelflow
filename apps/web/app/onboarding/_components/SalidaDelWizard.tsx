'use client';

import { useEffect, useState } from 'react';
import { signOut } from 'next-auth/react';
import { LogOut, Store, Loader2 } from 'lucide-react';

/**
 * La salida del wizard.
 *
 * 🔴 POR QUÉ EXISTE. `/dashboard` manda a `/onboarding` cuando a la tienda le
 * falta algo (`isConnected`), y `/onboarding` sólo deja volver cuando está TODO
 * completo (`shouldRedirectToDashboard`). Una tienda a medio configurar dejaba
 * al usuario encerrado: el panel rebotaba al wizard y el wizard no ofrecía
 * ninguna salida. Peor para quien tiene varias tiendas — el selector de tienda
 * vive en el layout del dashboard, que es justamente al que no podía llegar.
 *
 * Así que la salida va acá: cambiar a otra de sus tiendas, o cerrar sesión.
 * No se toca ninguno de los dos gates: siguen protegiendo lo que protegían.
 */
type Tienda = { id: string; name: string };

export function SalidaDelWizard({ tenantIdActual }: { tenantIdActual: string }) {
  const [tiendas, setTiendas] = useState<Tienda[] | null>(null);
  const [cambiando, setCambiando] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let vivo = true;
    fetch('/api/v1/tenants')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!vivo) return;
        const lista = (d?.data?.tenants ?? d?.tenants ?? d?.data ?? []) as Tienda[];
        setTiendas(Array.isArray(lista) ? lista : []);
      })
      .catch(() => vivo && setTiendas([]));
    return () => {
      vivo = false;
    };
  }, []);

  async function cambiar(id: string) {
    setError('');
    setCambiando(id);
    try {
      const res = await fetch('/api/v1/tenants/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: id }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error ?? 'No se pudo cambiar de tienda.');
        setCambiando(null);
        return;
      }
      // Recarga entera y no router.push: el tenant activo vive en el JWT de la
      // sesión, y hay que re-leerlo del servidor para que el gate del dashboard
      // vea la tienda nueva en vez de rebotar de vuelta acá.
      window.location.href = '/dashboard';
    } catch {
      setError('Error de conexión. Probá de nuevo.');
      setCambiando(null);
    }
  }

  // Se excluye la tienda que se está configurando. OJO: no sirve el `isActive`
  // que devuelve /api/v1/tenants — ése es el flag de "tienda habilitada", no
  // "tienda seleccionada". La seleccionada vive en el JWT y la baja el server.
  const otras = (tiendas ?? []).filter((t) => t.id !== tenantIdActual);

  return (
    <div className="mt-8 pt-6 border-t border-white/[0.06]">
      {error && <p className="text-xs text-red-400 mb-3">{error}</p>}

      {otras.length > 0 && (
        <div className="mb-4">
          <p className="text-[11px] text-zinc-500 mb-2 flex items-center gap-1.5">
            <Store className="w-3 h-3" />
            ¿Querés seguir con otra de tus tiendas? Lo que cargaste acá queda guardado.
          </p>
          <div className="flex flex-wrap gap-2">
            {otras.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => cambiar(t.id)}
                disabled={cambiando !== null}
                className="inline-flex items-center gap-1.5 text-xs rounded-lg border border-white/[0.1] bg-white/[0.03] px-3 py-1.5 text-zinc-300 hover:border-white/20 hover:text-white transition disabled:opacity-50"
              >
                {cambiando === t.id && <Loader2 className="w-3 h-3 animate-spin" />}
                {t.name || 'Tienda sin nombre'}
              </button>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => signOut({ callbackUrl: '/login' })}
        className="text-[11px] text-zinc-600 hover:text-zinc-400 inline-flex items-center gap-1.5 transition"
      >
        <LogOut className="w-3 h-3" />
        Cerrar sesión
      </button>
    </div>
  );
}
