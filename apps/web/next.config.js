/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ['@prisma/client', 'bullmq', 'ioredis'],
  },
  async headers() {
    // CSP base — bloquea XSS aún si una dependencia se compromete. `unsafe-
    // inline` en script-src/style-src es necesario por Next.js 14 (no usa
    // nonces todavía); cuando podamos migrar a App Router con nonces hay
    // que tightening más. Permite SDK de MercadoPago (checkout) y Supabase.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://sdk.mercadopago.com https://www.mercadopago.com https://*.mercadopago.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data: https://fonts.gstatic.com",
      "connect-src 'self' https://*.supabase.co https://api.mercadopago.com https://*.mercadopago.com",
      "frame-src 'self' https://www.mercadopago.com https://*.mercadopago.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://www.mercadopago.com",
      "object-src 'none'",
      'upgrade-insecure-requests',
    ].join('; ');

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
  // NO volver a poner un rewrite de '/' a un HTML estático.
  //
  // Entre el 2026-06-12 y hoy, la raíz servía `public/landing.html` por un
  // rewrite `beforeFiles`. Consecuencia: `app/page.tsx` era código muerto y
  // nadie lo veía. El landing estático quedó congelado en el modelo de venta
  // por llamada —"Solicitar demo", "Coordinar llamada", cero enlaces a
  // /signup— mientras el alta pasaba a ser self-serve, y ninguna de las
  // correcciones que sí se hicieron sobre page.tsx llegó nunca a un visitante.
  //
  // La raíz vuelve a resolverse por el App Router, que es donde vive el
  // landing mantenible.
  //
  // `apps/web/public/landing.html` se BORRÓ (2026-09-02). Sacar el rewrite no
  // alcanzaba: Next sirve todo `public/` desde la raíz, así que el estático
  // seguía respondiendo 200 en `/landing.html` — indexable, con "Solicitar
  // demo", cinco CTA a WhatsApp para coordinar una llamada, cero enlaces a
  // /signup y un <title> casi duplicado compitiendo contra el de `/`. Estaba
  // verificado con curl contra el dev server, no leyendo el config.
  //
  // NO volver a dejar un HTML de marketing en `public/`: cualquier archivo ahí
  // es una URL pública aunque ninguna ruta lo enlace. Si hace falta la copia
  // vieja, está en el historial de git.
};

module.exports = nextConfig;
