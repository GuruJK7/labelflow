'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import {
  LayoutDashboard,
  Package,
  Tags,
  Settings,
  LogOut,
  Zap,
  CreditCard,
  ChevronLeft,
  ChevronDown,
  Menu,
  X,
  Megaphone,
  Image,
  BarChart3,
  SlidersHorizontal,
  MessageSquare,
  ShoppingCart,
  Flag,
  Truck,
  Gift,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useState } from 'react';
import { isFeatureEnabled, SECTION_FLAGS, ITEM_FLAGS } from '@/lib/feature-flags';

/**
 * Sidebar navigation sections.
 *
 * `displayLabel` is the user-facing name for "soon" (feature-flagged-off)
 * sections, since when collapsed into a single umbrella row the section
 * uppercase label ("META ADS") would look like a header rather than a
 * nav item. For enabled sections it's unused — we keep the original
 * uppercase label as the section heading.
 *
 * `umbrellaIcon` (optional) overrides the icon shown on the collapsed
 * umbrella row. Defaults to the first item's icon — which is what we
 * want for ads (Megaphone) and recover (MessageSquare).
 */
const navSections: Array<{
  label: string;
  displayLabel?: string;
  items: Array<{ href: string; label: string; icon: typeof LayoutDashboard }>;
}> = [
  {
    label: 'Principal',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
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
      { href: '/settings', label: 'Configuracion', icon: Settings },
      { href: '/settings/shipping-rules', label: 'Reglas de envio', icon: Truck },
      { href: '/settings/billing', label: 'Envíos', icon: CreditCard },
      { href: '/settings/referrals', label: 'Referidos', icon: Gift },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Which "Coming Soon" sections are expanded to reveal their sub-items.
  // Default: all collapsed → each soon-section shows a single umbrella row.
  // Stored as a Set keyed by section.label so we can toggle independently.
  const [expandedSoon, setExpandedSoon] = useState<Set<string>>(new Set());

  const toggleSoon = (label: string) => {
    setExpandedSoon((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const sidebarContent = (
    <>
      {/* Logo */}
      <div className={cn(
        'flex items-center border-b border-white/[0.06] transition-all duration-200',
        collapsed ? 'justify-center px-3 py-4' : 'justify-between px-5 py-4'
      )}>
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-gradient-to-br from-cyan-500 to-cyan-700 rounded-lg flex items-center justify-center shadow-lg shadow-cyan-500/20">
            <Zap className="w-4 h-4 text-white" />
          </div>
          {!collapsed && (
            <div className="animate-fade-in">
              <h1 className="font-bold text-white text-[15px] tracking-tight leading-none">
                Label<span className="text-cyan-400">Flow</span>
              </h1>
              <p className="text-[10px] text-zinc-600 mt-0.5">Shopify x DAC</p>
            </div>
          )}
        </Link>
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            className="hidden lg:flex w-6 h-6 items-center justify-center rounded-md hover:bg-white/[0.04] text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-6 overflow-y-auto">
        {navSections.map((section) => {
          const requiredFlag = SECTION_FLAGS[section.label];
          const sectionEnabled = !requiredFlag || isFeatureEnabled(requiredFlag);

          // ── "Coming Soon" sections ─────────────────────────────────────
          // Render a single umbrella row (using the section's first item's
          // icon + the friendlier displayLabel) plus a Soon pill and a
          // chevron. Clicking the row expands/collapses to reveal the
          // upcoming sub-items as disabled previews. This keeps the sidebar
          // clean — instead of 4 grayed-out items per soon section we show
          // 1 by default, while still letting curious users peek at what's
          // coming. In collapsed sidebar mode we just show the umbrella
          // icon (no expand — there's no horizontal room).
          if (!sectionEnabled) {
            const isExpanded = expandedSoon.has(section.label);
            const umbrella = section.items[0];
            const UmbrellaIcon = umbrella.icon;
            const previewItems = section.items;

            return (
              <div key={section.label}>
                <button
                  type="button"
                  onClick={() => !collapsed && toggleSoon(section.label)}
                  aria-expanded={isExpanded}
                  aria-label={`${section.displayLabel ?? section.label} — próximamente`}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg text-[13px] font-medium text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03] transition-all duration-150 w-full group relative',
                    collapsed ? 'justify-center px-2 py-2.5 cursor-default' : 'px-3 py-2.5',
                  )}
                >
                  <UmbrellaIcon className="w-[18px] h-[18px] flex-shrink-0 opacity-70" />
                  {!collapsed && (
                    <>
                      <span className="flex-1 text-left">
                        {section.displayLabel ?? section.label}
                      </span>
                      <span className="text-[9px] font-medium text-amber-400/80 bg-amber-500/10 px-1.5 py-0.5 rounded-full border border-amber-500/20">
                        Soon
                      </span>
                      <ChevronDown
                        className={cn(
                          'w-3.5 h-3.5 text-zinc-600 transition-transform duration-200',
                          isExpanded ? 'rotate-180' : 'rotate-0',
                        )}
                      />
                    </>
                  )}
                  {collapsed && (
                    <div className="absolute left-full ml-2 px-2.5 py-1.5 bg-zinc-800 text-zinc-200 text-xs rounded-md shadow-xl opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 border border-white/[0.08]">
                      {section.displayLabel ?? section.label} (Coming Soon)
                    </div>
                  )}
                </button>

                {/* Expanded preview list (only when sidebar is wide) */}
                {!collapsed && isExpanded && (
                  <div className="mt-1 ml-4 pl-3 border-l border-white/[0.04] space-y-0.5 animate-fade-in">
                    {previewItems.map((item) => (
                      <div
                        key={item.href}
                        className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-[12px] font-medium opacity-40 cursor-not-allowed text-zinc-600"
                      >
                        <item.icon className="w-[15px] h-[15px] flex-shrink-0" />
                        <span>{item.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          }

          // ── Enabled sections (Principal, Sistema, etc.) ─────────────────
          // Original behavior, unchanged from before. Section heading +
          // each item rendered as a Link (or as a disabled preview row when
          // gated by a per-item flag like /reports).
          return (
            <div key={section.label}>
              {!collapsed && (
                <div className="flex items-center gap-2 px-3 mb-2">
                  <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">
                    {section.label}
                  </p>
                </div>
              )}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const isActive =
                    (item.href === '/dashboard' && pathname === '/dashboard') ||
                    (item.href !== '/dashboard' && pathname?.startsWith(item.href));

                  // Check per-item flag (for items in enabled sections)
                  const itemFlag = ITEM_FLAGS[item.href];
                  const itemDisabled = itemFlag ? !isFeatureEnabled(itemFlag) : false;

                  if (itemDisabled) {
                    return (
                      <div
                        key={item.href}
                        className={cn(
                          'flex items-center gap-2.5 rounded-lg text-[13px] font-medium opacity-40 cursor-not-allowed group relative',
                          collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5',
                          'text-zinc-600'
                        )}
                      >
                        <item.icon className="w-[18px] h-[18px] flex-shrink-0" />
                        {!collapsed && <span>{item.label}</span>}
                        {collapsed && (
                          <div className="absolute left-full ml-2 px-2.5 py-1.5 bg-zinc-800 text-zinc-200 text-xs rounded-md shadow-xl opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 border border-white/[0.08]">
                            {item.label} (Coming Soon)
                          </div>
                        )}
                      </div>
                    );
                  }

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg text-[13px] font-medium transition-all duration-150 group relative',
                        collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5',
                        isActive
                          ? 'bg-cyan-500/10 text-cyan-400'
                          : 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03]'
                      )}
                    >
                      {isActive && (
                        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-cyan-500 rounded-r-full" />
                      )}
                      <item.icon className={cn('w-[18px] h-[18px] flex-shrink-0', isActive && 'drop-shadow-[0_0_4px_rgba(6,182,212,0.4)]')} />
                      {!collapsed && <span>{item.label}</span>}
                      {collapsed && (
                        <div className="absolute left-full ml-2 px-2.5 py-1.5 bg-zinc-800 text-zinc-200 text-xs rounded-md shadow-xl opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity whitespace-nowrap z-50 border border-white/[0.08]">
                          {item.label}
                        </div>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-3 py-3 border-t border-white/[0.06] space-y-1">
        {collapsed && (
          <button
            onClick={() => setCollapsed(false)}
            className="flex items-center justify-center w-full py-2.5 rounded-lg text-zinc-600 hover:text-zinc-400 hover:bg-white/[0.03] transition-colors"
          >
            <ChevronLeft className="w-4 h-4 rotate-180" />
          </button>
        )}
        <button
          onClick={() => signOut({ callbackUrl: '/login' })}
          className={cn(
            'flex items-center gap-2.5 rounded-lg text-[13px] font-medium text-zinc-600 hover:text-red-400 hover:bg-red-500/5 w-full transition-all duration-150',
            collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5'
          )}
        >
          <LogOut className="w-[18px] h-[18px]" />
          {!collapsed && <span>Cerrar sesion</span>}
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile trigger */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed top-4 left-4 z-50 lg:hidden w-10 h-10 bg-zinc-900/90 backdrop-blur border border-white/[0.08] rounded-lg flex items-center justify-center text-zinc-400 hover:text-white transition-colors"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile sidebar */}
      <aside className={cn(
        'fixed left-0 top-0 h-full w-64 bg-[#0a0a0b] flex flex-col z-50 lg:hidden transition-transform duration-300 border-r border-white/[0.06]',
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      )}>
        <button
          onClick={() => setMobileOpen(false)}
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/[0.04] text-zinc-500"
        >
          <X className="w-4 h-4" />
        </button>
        {sidebarContent}
      </aside>

      {/* Desktop sidebar */}
      <aside className={cn(
        'fixed left-0 top-0 h-full bg-[#0a0a0b]/80 backdrop-blur-xl flex-col z-20 border-r border-white/[0.06] hidden lg:flex transition-all duration-200',
        collapsed ? 'w-16' : 'w-60'
      )}>
        {sidebarContent}
      </aside>
    </>
  );
}
