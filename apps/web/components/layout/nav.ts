import {
  LayoutDashboard,
  LayoutGrid,
  Package,
  Tags,
  Settings,
  CreditCard,
  Megaphone,
  Image,
  BarChart3,
  SlidersHorizontal,
  MessageSquare,
  ShoppingCart,
  Flag,
  Truck,
  Gift,
  Shield,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

/**
 * `displayLabel` is the user-facing name for "soon" (feature-flagged-off)
 * sections, since when collapsed into a single umbrella row the section
 * uppercase label ("META ADS") would look like a header rather than a
 * nav item. For enabled sections it's unused — we keep the original
 * uppercase label as the section heading.
 */
export interface NavSection {
  label: string;
  displayLabel?: string;
  items: NavItem[];
}

/**
 * Menú por rol (D32). Puro, sin React: se testea en node.
 *
 * - Usuario normal: SOLO Dashboard, Etiquetas y Configuración. Configuración
 *   agrupa adentro tiendas, DAC, reglas y parámetros de envío y comprar
 *   envíos (ver settings/_components/SettingsNav.tsx).
 * - Admin (ADMIN_EMAILS): todo lo de hoy — Control, Pedidos, Meta Ads,
 *   Recover, Reportes, Reglas, Comprar envíos, Referidos — más /admin.
 *
 * Las páginas que acá no aparecen para el usuario también devuelven 404
 * server-side (lib/admin.ts → requireAdminOrNotFound): esconder el link no
 * es el control de acceso, es sólo el menú.
 */
export function navSectionsFor(isAdmin: boolean): NavSection[] {
  if (!isAdmin) {
    return [
      {
        label: 'Principal',
        items: [
          { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
          { href: '/labels', label: 'Etiquetas', icon: Tags },
        ],
      },
      {
        label: 'Sistema',
        items: [{ href: '/settings', label: 'Configuración', icon: Settings }],
      },
    ];
  }

  return [
    {
      label: 'Principal',
      items: [
        { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
        { href: '/control', label: 'Control', icon: LayoutGrid },
        { href: '/orders', label: 'Pedidos', icon: Package },
        { href: '/labels', label: 'Etiquetas', icon: Tags },
      ],
    },
    {
      label: 'META ADS',
      displayLabel: 'Meta Ads',
      items: [
        { href: '/ads', label: 'Panel de Anuncios', icon: Megaphone },
        { href: '/ads/creativos', label: 'Anuncios', icon: Image },
        { href: '/ads/rendimiento', label: 'Rendimiento', icon: BarChart3 },
        { href: '/ads/configuracion', label: 'Config. Ads', icon: SlidersHorizontal },
      ],
    },
    {
      label: 'RECOVER',
      displayLabel: 'Recover',
      items: [
        { href: '/recover', label: 'Panel Recover', icon: MessageSquare },
        { href: '/recover/carts', label: 'Carritos', icon: ShoppingCart },
        { href: '/recover/settings', label: 'Config. Recover', icon: SlidersHorizontal },
      ],
    },
    {
      label: 'Sistema',
      items: [
        { href: '/reports', label: 'Reportes', icon: Flag },
        { href: '/settings', label: 'Configuración', icon: Settings },
        { href: '/settings/shipping-rules', label: 'Reglas de envío', icon: Truck },
        { href: '/settings/billing', label: 'Comprar envíos', icon: CreditCard },
        { href: '/settings/referrals', label: 'Referidos', icon: Gift },
        { href: '/admin', label: 'Admin', icon: Shield },
      ],
    },
  ];
}
