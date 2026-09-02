import './globals.css';
import type { Metadata } from 'next';
import { Providers } from './providers';

/** Metadata por defecto de todo el sitio. La landing (`app/page.tsx`) pisa
 *  title y description con los suyos; esto es lo que ve el resto de las rutas. */
export const metadata: Metadata = {
  title: 'AutoEnvía — Despachá con DAC sin cargar una guía a mano',
  description:
    'Conectás tu tienda Shopify y cada pedido pago sale con la guía de DAC emitida, el PDF listo para imprimir y el seguimiento cargado. 5 envíos de prueba al crear la cuenta.',
  icons: {
    icon: '/icon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
