'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Store, KeyRound, Truck, SlidersHorizontal, CreditCard, Send } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Barra de Configuración (D32). Para el usuario normal, Configuración es el
 * único lugar donde vive todo lo que no es Dashboard ni Etiquetas, así que
 * acá se agrupan sus partes: Tiendas, Cuenta DAC, Transportista, Reglas de
 * envío, Parámetros y Comprar envíos. Se renderiza igual para el admin.
 *
 * Las entradas con `#` apuntan a tarjetas de /settings (ids `tiendas`, `dac`,
 * `parametros`); las otras dos son páginas propias. La activa se decide por
 * pathname + hash; en /settings sin hash queda activa "Tiendas".
 */
export const SETTINGS_NAV: Array<{ href: string; label: string; icon: typeof Store }> = [
  { href: '/settings#tiendas', label: 'Tiendas', icon: Store },
  { href: '/settings#dac', label: 'Cuenta DAC', icon: KeyRound },
  { href: '/settings#transportista', label: 'Transportista', icon: Send },
  { href: '/settings/shipping-rules', label: 'Reglas de envío', icon: Truck },
  { href: '/settings#parametros', label: 'Parámetros', icon: SlidersHorizontal },
  { href: '/settings/billing', label: 'Comprar envíos', icon: CreditCard },
];

export function isSettingsNavActive(href: string, pathname: string | null, hash: string): boolean {
  const [path, anchor] = href.split('#');
  if (pathname !== path) return false;
  if (!anchor) return true;
  const current = hash.replace(/^#/, '') || 'tiendas';
  return current === anchor;
}

export function SettingsNav() {
  const pathname = usePathname();
  const [hash, setHash] = useState('');

  useEffect(() => {
    const read = () => setHash(window.location.hash);
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  return (
    <nav
      aria-label="Secciones de configuración"
      className="flex gap-1 overflow-x-auto mb-8 -mx-1 px-1 pb-1 border-b border-white/[0.06]"
    >
      {SETTINGS_NAV.map((item) => {
        const active = isSettingsNavActive(item.href, pathname, hash);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => {
              const anchor = item.href.split('#')[1];
              if (anchor) setHash(`#${anchor}`);
            }}
            className={cn(
              'flex items-center gap-2 whitespace-nowrap px-3 py-2 rounded-t-lg text-[13px] font-medium border-b-2 -mb-px transition-colors',
              active
                ? 'text-cyan-400 border-cyan-500'
                : 'text-zinc-500 border-transparent hover:text-zinc-300 hover:bg-white/[0.03]',
            )}
          >
            <item.icon className="w-4 h-4 flex-shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
