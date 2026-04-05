import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'LabelFlow — Shopify x DAC Uruguay',
  description: 'Genera etiquetas de DAC automaticamente desde tu tienda Shopify',
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
      <body className="antialiased">{children}</body>
    </html>
  );
}
