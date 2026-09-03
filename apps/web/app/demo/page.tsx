import type { Metadata } from 'next';

/**
 * Página del screencast de revisión del Shopify App Store.
 *
 * POR QUÉ ESTÁ ACÁ Y NO EN YOUTUBE. El formulario pide una URL. La única
 * cuenta de YouTube disponible es un canal de gaming ajeno al producto y con
 * una advertencia activa por lineamientos: un revisor cayendo ahí es raro, y
 * si la advertencia escala el video se cae en plena revisión. Alojado en el
 * propio dominio, la URL no depende de un tercero.
 *
 * `noindex`: es material de revisión, no una landing. No tiene que competir en
 * buscadores con la página del producto.
 */
export const metadata: Metadata = {
  title: 'AutoEnvía — App review screencast',
  robots: { index: false, follow: false },
};

export default function DemoPage() {
  return (
    <main className="min-h-screen bg-[#050505] text-zinc-200">
      <div className="mx-auto max-w-5xl px-6 py-12">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-cyan-400">
          Shopify App Store review
        </p>
        <h1 className="mt-3 text-3xl font-bold text-white">
          Auto<span className="text-cyan-400">Envía</span> — product screencast
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-zinc-400">
          Merchant onboarding and core functionality, 3:50. English subtitles are burned into the
          picture; there is no audio track. Recorded against the live product with a development
          store. Customer names and addresses are fictitious.
        </p>

        <video
          className="mt-8 w-full rounded-xl border border-white/[0.08] shadow-2xl"
          controls
          preload="metadata"
          playsInline
          src="/demo/autoenvia-screencast.mp4"
        >
          <track kind="captions" srcLang="en" label="English" src="/demo/autoenvia-screencast.en.srt" />
        </video>

        <p className="mt-5 text-xs text-zinc-500">
          Direct file:{' '}
          <a className="text-cyan-400 hover:underline" href="/demo/autoenvia-screencast.mp4">
            /demo/autoenvia-screencast.mp4
          </a>
        </p>
      </div>
    </main>
  );
}
