'use client';

/**
 * Tenant (store) switcher — dropdown in the dashboard top-bar that lets a
 * user with multiple Shopify stores swap which one is "active" for this
 * session.
 *
 * Switching flow:
 *   1. User picks a store from the dropdown.
 *   2. POST /api/v1/tenants/switch — server validates ownership, returns
 *      the chosen tenant's metadata.
 *   3. Client calls `update({ tenantId })` from useSession() — that fires
 *      the NextAuth `update` trigger in auth.ts:jwt callback, which mints
 *      a fresh JWT cookie with the new tenantId/tenantSlug.
 *   4. `router.refresh()` re-fetches the dashboard server components so
 *      every per-tenant query (credits counter, sidebar badges, etc.)
 *      reads from the newly-active store.
 *
 * Why we don't just call `update({ tenantId })` directly without the API
 * round-trip: the update trigger DOES re-validate ownership inside the
 * jwt callback, but failing fast on the API gives a clean error toast
 * ("no tenés permiso para esa tienda") instead of a silent no-op when a
 * tampered client tries to switch to someone else's store.
 *
 * Single-store users see the switcher render as a static label (no
 * dropdown chrome) — the "+ Agregar tienda" CTA is still available so
 * they can add their second store without hunting through Settings.
 */

import { useEffect, useState, useRef, type FC } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { ChevronsUpDown, Check, Plus, Store, Loader2, Pencil, X } from 'lucide-react';
import { cn } from '@/lib/cn';

interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  shopifyStoreUrl: string | null;
  onboardingComplete: boolean;
  isActive: boolean;
  availableCredits: number;
  createdAt: string;
}

export const TenantSwitcher: FC = () => {
  const { data: session, update } = useSession();
  const router = useRouter();
  const [tenants, setTenants] = useState<TenantSummary[] | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // Inline rename state: which row is being edited, its draft value, which
  // row is mid-save, and whether the last save failed (recoverable — the
  // input stays open so the user can retry without re-typing).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [renameError, setRenameError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentTenantId = (session?.user as Record<string, unknown> | undefined)?.tenantId as
    | string
    | undefined;

  // Fetch the user's stores once on mount. We don't refetch on every
  // dashboard navigation because the list rarely changes within a session
  // — only after the user adds a new store. The "+ Agregar tienda" handler
  // does its own refetch after the create call.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/tenants')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.data?.tenants) setTenants(data.data.tenants);
      })
      .catch(() => {
        if (!cancelled) setTenants([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close the dropdown when the user clicks outside. Standard pattern —
  // `mousedown` instead of `click` so a click-and-drag selection inside
  // the dropdown doesn't dismiss it accidentally.
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        // Abandon any in-progress inline rename when the dropdown closes so
        // a half-typed name doesn't reappear the next time it's opened.
        setEditingId(null);
        setRenameError(false);
      }
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  async function handleSwitch(tenantId: string) {
    if (tenantId === currentTenantId || switching) return;
    setSwitching(tenantId);
    try {
      const res = await fetch('/api/v1/tenants/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId }),
      });
      if (!res.ok) {
        // Silently roll back the loading state on failure. We could surface
        // a toast here, but the most common failure mode (403 — user
        // doesn't own that tenant) is impossible to hit from this UI
        // anyway; the only realistic 4xx is a stale list after the user
        // deleted a store in another tab, which clears on next mount.
        setSwitching(null);
        return;
      }
      // Mint a new JWT with the new tenantId — see auth.ts:jwt callback's
      // `update` branch.
      await update({ tenantId });
      // Refresh server components so credits counter + sidebar reflect the
      // new active store. router.refresh() re-runs the layout's tenant
      // query without a full reload.
      router.refresh();
      setOpen(false);
    } finally {
      setSwitching(null);
    }
  }

  async function handleAddStore() {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/v1/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nueva tienda' }),
      });
      if (!res.ok) {
        setCreating(false);
        return;
      }
      const json = await res.json();
      const newTenantId = json?.data?.tenant?.id;
      if (!newTenantId) {
        setCreating(false);
        return;
      }
      // Switch to the new (empty) tenant immediately so onboarding writes
      // its Shopify+DAC creds onto THIS tenant, not the previous one.
      await fetch('/api/v1/tenants/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: newTenantId }),
      });
      await update({ tenantId: newTenantId });
      // Hard navigation so the dashboard layout's onboarding gate
      // re-evaluates against the new tenant (which has
      // onboardingComplete=false) and routes the user into the wizard.
      window.location.href = '/onboarding';
    } catch {
      setCreating(false);
    }
  }

  function startEdit(t: TenantSummary) {
    setEditingId(t.id);
    setEditValue(t.name);
    setRenameError(false);
  }

  function cancelEdit() {
    if (savingId) return;
    setEditingId(null);
    setEditValue('');
    setRenameError(false);
  }

  // Persist a rename. Ownership is enforced server-side (PATCH validates the
  // tenant belongs to this user), so the worst a tampered client can do is
  // get a 403. On success we patch local state in place so the dropdown and
  // the top-bar label update instantly, then router.refresh() syncs any
  // server-rendered surface that prints the store name.
  async function handleRename(tenantId: string) {
    const name = editValue.trim();
    if (name.length === 0 || savingId) return;
    setSavingId(tenantId);
    setRenameError(false);
    try {
      const res = await fetch(`/api/v1/tenants/${tenantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        // Keep the input open with the typed value so the user can retry.
        setRenameError(true);
        return;
      }
      const json = await res.json().catch(() => null);
      const newName = json?.data?.tenant?.name ?? name;
      setTenants((prev) =>
        prev ? prev.map((x) => (x.id === tenantId ? { ...x, name: newName } : x)) : prev,
      );
      setEditingId(null);
      setEditValue('');
      router.refresh();
    } catch {
      setRenameError(true);
    } finally {
      setSavingId(null);
    }
  }

  // Don't render anything until we've fetched the list. Avoids a flash
  // of "1 store" → "3 stores" on slow connections.
  if (tenants === null) return null;

  const current = tenants.find((t) => t.id === currentTenantId) ?? tenants[0];
  const hasMultiple = tenants.length > 1;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-300 hover:text-white hover:bg-white/[0.04] transition-colors max-w-[180px] sm:max-w-[240px]"
        aria-label="Cambiar tienda"
      >
        <Store className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
        <span className="truncate">{current?.name ?? 'Mi tienda'}</span>
        {hasMultiple && (
          <ChevronsUpDown className="w-3 h-3 text-zinc-500 flex-shrink-0" />
        )}
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 w-72 z-50 rounded-xl bg-zinc-950/95 backdrop-blur-xl ring-1 ring-white/[0.08] shadow-2xl shadow-black/40 overflow-hidden">
          <div className="p-1.5 max-h-[60vh] overflow-y-auto">
            {tenants.map((t) => {
              const isCurrent = t.id === currentTenantId;
              const isSwitching = switching === t.id;
              const isEditing = editingId === t.id;
              const isSaving = savingId === t.id;

              // Inline rename mode: the row becomes an editable input with
              // save/cancel. We swap the switch <button> out entirely so we
              // never nest an <input>/<button> inside a <button>.
              if (isEditing) {
                return (
                  <div
                    key={t.id}
                    className="flex flex-col gap-1 px-2.5 py-2 rounded-lg bg-white/[0.04]"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="w-7 h-7 rounded-md bg-cyan-500/15 text-cyan-300 flex items-center justify-center flex-shrink-0">
                        <Store className="w-3.5 h-3.5" />
                      </span>
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => {
                          setEditValue(e.target.value);
                          if (renameError) setRenameError(false);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleRename(t.id);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            cancelEdit();
                          }
                        }}
                        maxLength={80}
                        disabled={isSaving}
                        placeholder="Nombre de la tienda"
                        className="flex-1 min-w-0 bg-zinc-900 ring-1 ring-white/10 focus:ring-cyan-400/50 rounded-md px-2 py-1 text-sm text-white outline-none disabled:opacity-50"
                      />
                      <button
                        type="button"
                        onClick={() => handleRename(t.id)}
                        disabled={isSaving || editValue.trim().length === 0}
                        aria-label="Guardar nombre"
                        className="w-7 h-7 rounded-md flex items-center justify-center text-cyan-300 hover:bg-cyan-500/15 disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                      >
                        {isSaving ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Check className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        disabled={isSaving}
                        aria-label="Cancelar"
                        className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-400 hover:bg-white/[0.06] disabled:opacity-40 flex-shrink-0"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {renameError && (
                      <span className="text-[10px] text-red-400 pl-9">
                        No se pudo guardar. Intentá de nuevo.
                      </span>
                    )}
                  </div>
                );
              }

              return (
                <div
                  key={t.id}
                  className={cn(
                    'group flex items-stretch rounded-lg transition-colors',
                    isCurrent ? 'bg-cyan-500/[0.08]' : 'hover:bg-white/[0.04]',
                    !isCurrent && switching && 'opacity-40',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => handleSwitch(t.id)}
                    disabled={isCurrent || !!switching}
                    className={cn(
                      'flex-1 min-w-0 flex items-start gap-2.5 px-2.5 py-2 text-left',
                      isCurrent ? 'cursor-default' : 'cursor-pointer',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0',
                        isCurrent
                          ? 'bg-cyan-500/20 text-cyan-300'
                          : 'bg-white/[0.05] text-zinc-400',
                      )}
                    >
                      <Store className="w-3.5 h-3.5" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            'text-sm font-medium truncate',
                            isCurrent ? 'text-cyan-100' : 'text-zinc-200',
                          )}
                        >
                          {t.name}
                        </span>
                        {isSwitching && (
                          <Loader2 className="w-3 h-3 text-cyan-300 animate-spin flex-shrink-0" />
                        )}
                        {isCurrent && !isSwitching && (
                          <Check className="w-3 h-3 text-cyan-300 flex-shrink-0" />
                        )}
                      </div>
                      <div className="text-[11px] text-zinc-500 truncate">
                        {t.shopifyStoreUrl ?? 'Sin Shopify conectado'}
                      </div>
                      <div className="text-[10px] text-zinc-600 mt-0.5">
                        {t.availableCredits} envío{t.availableCredits === 1 ? '' : 's'} disponible{t.availableCredits === 1 ? '' : 's'}
                        {!t.onboardingComplete && ' · Onboarding pendiente'}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(t)}
                    aria-label={`Renombrar ${t.name}`}
                    title="Renombrar tienda"
                    className="px-2 flex items-center text-zinc-500 hover:text-cyan-300 opacity-60 group-hover:opacity-100 transition-opacity flex-shrink-0"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="border-t border-white/[0.06] p-1.5">
            <button
              type="button"
              onClick={handleAddStore}
              disabled={creating}
              className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium text-cyan-300 hover:text-cyan-200 hover:bg-cyan-500/[0.06] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span className="w-7 h-7 rounded-md bg-cyan-500/15 flex items-center justify-center">
                {creating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" strokeWidth={2.5} />
                )}
              </span>
              {creating ? 'Creando tienda nueva…' : 'Agregar otra tienda'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
