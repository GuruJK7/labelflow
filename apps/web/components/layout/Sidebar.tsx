'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from 'next-auth/react';
import {
  LayoutDashboard,
  Package,
  Tags,
  Settings,
  FileText,
  LogOut,
  Zap,
  CreditCard,
  ChevronLeft,
  Menu,
  X,
  Megaphone,
  Image,
  BarChart3,
  SlidersHorizontal,
  MessageSquare,
  ShoppingCart,
  Flag,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useState } from 'react';

const navSections = [
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
    items: [
      { href: '/ads', label: 'Panel de Anuncios', icon: Megaphone },
      { href: '/ads/creativos', label: 'Anuncios', icon: Image },
      { href: '/ads/rendimiento', label: 'Rendimiento', icon: BarChart3 },
      { href: '/ads/configuracion', label: 'Config. Ads', icon: SlidersHorizontal },
    ],
  },
  {
    label: 'RECOVER',
    items: [
      { href: '/recover', label: 'Panel Recover', icon: MessageSquare },
      { href: '/recover/carts', label: 'Carritos', icon: ShoppingCart },
      { href: '/recover/settings', label: 'Config. Recover', icon: SlidersHorizontal },
    ],
  },
  {
    label: 'Sistema',
    items: [
      { href: '/logs', label: 'Logs', icon: FileText },
      { href: '/reports', label: 'Reportes', icon: Flag },
      { href: '/settings', label: 'Configuracion', icon: Settings },
      { href: '/settings/billing', label: 'Facturacion', icon: CreditCard },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

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
        {navSections.map((section) => (
          <div key={section.label}>
            {!collapsed && (
              <p className="px-3 mb-2 text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">
                {section.label}
              </p>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const isActive =
                  (item.href === '/dashboard' && pathname === '/dashboard') ||
                  (item.href !== '/dashboard' && pathname?.startsWith(item.href));

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
        ))}
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
