'use client';

/**
 * Red de seguridad para cualquier excepción del lado del cliente.
 *
 * POR QUÉ EXISTE. Hasta el 16-09-2026 no había ninguna, así que una excepción en
 * el navegador dejaba la pantalla EN BLANCO con el texto pelado de Next
 * («Application error: a client-side exception has occurred»), sin un solo botón.
 * Eso es exactamente lo que vio el revisor del Shopify App Store el 14-09: apretó
 * "Iniciar sesión", la app se cayó por el bug del traductor, y se quedó mirando
 * una pantalla negra. Rechazó la app por «lands to an error».
 *
 * La causa de FONDO de aquel caso ya está arreglada (los textos de JSX van
 * envueltos en un elemento; ver `lib/__tests__/traductor-no-rompe.test.ts`), pero
 * esto queda para el próximo error que no vimos venir: quien lo sufra ve qué
 * pasó y tiene una salida, en vez de una pantalla muda.
 *
 * `reset()` re-monta el árbol sin recargar. Se ofrece también recargar entero,
 * que es lo que destraba los casos en que el DOM quedó inconsistente — el del
 * traductor, justamente.
 */

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Queda en la consola del navegador y en los logs de Vercel: sin esto, un
    // crash del cliente es invisible para nosotros y sólo lo sufre el usuario.
    console.error('[app] excepción del cliente', { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <div className="min-h-screen bg-[#050505] flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-2xl border border-white/[0.08] bg-zinc-900 p-6 text-center">
        <h1 className="text-lg font-semibold text-white mb-2">
          <span>Se nos rompió algo en pantalla</span>
        </h1>
        <p className="text-sm text-zinc-400 mb-6">
          <span>
            No es culpa tuya y no perdiste nada: tus pedidos y tus etiquetas están a salvo. Probá de
            nuevo, y si sigue pasando escribinos.
          </span>
        </p>

        <div className="flex flex-col sm:flex-row gap-2 justify-center">
          <button
            type="button"
            onClick={reset}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-cyan-500 text-zinc-950 hover:bg-cyan-400"
          >
            <span>Reintentar</span>
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-4 py-2 rounded-lg text-sm text-zinc-300 border border-white/[0.08] hover:bg-white/[0.04]"
          >
            <span>Recargar la página</span>
          </button>
        </div>

        {error.digest && (
          <p className="text-[11px] text-zinc-600 mt-5">
            <span>Código del error: {error.digest}</span>
          </p>
        )}

        <a
          href="https://wa.me/59898943949"
          className="block text-xs text-cyan-400 hover:text-cyan-300 mt-5"
        >
          <span>Escribinos por WhatsApp</span>
        </a>
      </div>
    </div>
  );
}
