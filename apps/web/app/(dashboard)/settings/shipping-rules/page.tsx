/**
 * /settings/shipping-rules — CRUD UI for ShippingRule rows.
 *
 * Rules are evaluated in the worker in priority ASC order (top of the list =
 * evaluated first). Only active rules run. First match wins and forces
 * REMITENTE (store pays); if nothing matches, the legacy threshold/consolidation
 * path runs exactly as before, so tenants with zero rules keep their current
 * behavior.
 *
 * State is fetched on mount and refetched after every write. Reordering uses
 * move-up/move-down buttons (no drag-drop library) and posts an ordered id
 * list to /reorder, which renumbers priorities in one transaction.
 *
 * Per-type config uses a discriminated form in the modal — each ShippingRuleType
 * renders its own inputs. The Zod validators in lib/shipping-rules.ts are the
 * source of truth; this UI only does light client-side hinting.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Pencil, Trash2, ArrowUp, ArrowDown, Save, X, Power, PowerOff } from 'lucide-react';
import { SettingsNav } from '../_components/SettingsNav';
import {
  SHIPPING_RULE_TYPES,
  RULE_TYPE_LABELS,
  RULE_TYPE_DESCRIPTIONS,
  type ShippingRuleType,
} from '@/lib/shipping-rules';

interface ShippingRuleDTO {
  id: string;
  name: string;
  ruleType: ShippingRuleType;
  config: Record<string, unknown>;
  priority: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

type ConfigDraft = {
  minTotalUyu?: number;
  windowMinutes?: number;
  nth?: number;
  tag?: string;
  minItems?: number;
};

const DEFAULT_CONFIG: Record<ShippingRuleType, ConfigDraft> = {
  THRESHOLD_TOTAL: { minTotalUyu: 4000 },
  CONSECUTIVE_ORDERS: { windowMinutes: 30 },
  NTH_SHIPMENT_FREE: { nth: 10 },
  CUSTOMER_TAG: { tag: 'vip' },
  ITEM_COUNT: { minItems: 3 },
};

/**
 * Plantillas de reglas — cinco presets curados que cubren los casos más
 * comunes. Se muestran arriba del formulario cuando el usuario crea una
 * regla nueva; un click rellena nombre / tipo / config / prioridad y el
 * usuario sólo revisa + guarda. Al editar una regla existente las
 * plantillas no se muestran (no queremos que un click accidental pise
 * la configuración viva).
 */
type RulePreset = {
  id: string;
  title: string;
  summary: string;
  useCase: string;
  icon: string;
  name: string;
  ruleType: ShippingRuleType;
  config: ConfigDraft;
  priority: number;
};

const RULE_PRESETS: RulePreset[] = [
  {
    id: 'high-value',
    title: 'Envíos grandes (> $3.000 UYU)',
    summary: 'Pedidos con total superior a $3.000 se marcan REMITENTE.',
    useCase: 'Cuando pagás vos los envíos caros en vez de cobrárselos al cliente.',
    icon: '💰',
    name: 'Envíos grandes (> $3.000 UYU)',
    ruleType: 'THRESHOLD_TOTAL',
    config: { minTotalUyu: 3000 },
    priority: 100,
  },
  {
    id: 'second-order',
    title: 'Segundo pedido del mismo cliente (60 min)',
    summary: 'Si un cliente hace 2+ pedidos en 60 min, del 2do en adelante va REMITENTE.',
    useCase: 'Evitar cobrar envío múltiple cuando el cliente compra varios productos seguidos.',
    icon: '🔁',
    name: 'Segundo pedido del mismo cliente (60 min)',
    ruleType: 'CONSECUTIVE_ORDERS',
    config: { windowMinutes: 60 },
    priority: 50,
  },
  {
    id: 'vip-tag',
    title: 'Clientes VIP (tag "vip")',
    summary: 'Pedidos de clientes con el tag "vip" en Shopify se marcan REMITENTE.',
    useCase: 'Envío gratis para tus mejores clientes; el tag lo asignás en Shopify.',
    icon: '⭐',
    name: 'Clientes VIP (tag "vip")',
    ruleType: 'CUSTOMER_TAG',
    config: { tag: 'vip' },
    priority: 10,
  },
  {
    id: 'bulk-items',
    title: 'Pedidos mayoristas (5+ items)',
    summary: 'Pedidos con 5 items o más se marcan REMITENTE.',
    useCase: 'Clientes que compran al por mayor o hacen regalos grandes.',
    icon: '📦',
    name: 'Pedidos mayoristas (5+ items)',
    ruleType: 'ITEM_COUNT',
    config: { minItems: 5 },
    priority: 80,
  },
  {
    id: 'nth-free',
    title: 'Cada 10mo envío gratis',
    summary: 'El envío número 10, 20, 30... de cada cliente se marca REMITENTE.',
    useCase: 'Programa de fidelidad simple.',
    icon: '🎁',
    name: 'Cada 10mo envío gratis',
    ruleType: 'NTH_SHIPMENT_FREE',
    config: { nth: 10 },
    priority: 60,
  },
];

/* ─── Tokens visuales ─────────────────────────────────────────────────────
 * Los mismos de /settings (settings/page.tsx): el layout del dashboard pinta
 * #050505, las tarjetas son glass zinc-900/50 y el único acento es cyan.
 *
 * El botón primario usa la variante `cyan-500 sobre zinc-950` — la que ya
 * usan /settings/billing y /settings/referrals — y no `cyan-600 con texto
 * blanco`: esa combinación da 3,7:1 y no llega al 4,5:1 que exige texto de
 * este tamaño. Mismo acento, distinta polaridad.
 *
 * Todo el texto de contenido va en zinc-400 o más claro (>= 7:1 sobre la
 * tarjeta). zinc-500 queda en 4,0:1, así que acá no se usa para texto.
 */
const CARD = 'bg-zinc-900/50 border border-white/[0.06] rounded-xl';
const INPUT =
  'w-full px-3.5 py-2.5 bg-zinc-800/50 border border-white/[0.08] rounded-lg text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 transition-colors';
const BTN_PRIMARY =
  'inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-zinc-950 text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const BTN_GHOST =
  'px-4 py-2 rounded-lg text-sm text-zinc-300 hover:bg-white/[0.06] transition-colors disabled:opacity-50';
const HELP = 'text-xs text-zinc-400 mt-1.5 leading-relaxed';
const ALERT_ERROR = 'p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm';

export default function ShippingRulesPage() {
  const [rules, setRules] = useState<ShippingRuleDTO[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ShippingRuleDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/shipping-rules', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Error al cargar reglas');
      setRules(json.data as ShippingRuleDTO[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleActive = async (rule: ShippingRuleDTO) => {
    setBusyId(rule.id);
    try {
      const res = await fetch(`/api/v1/shipping-rules/${rule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? 'Error al actualizar');
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (rule: ShippingRuleDTO) => {
    if (!confirm(`Eliminar la regla "${rule.name}"?`)) return;
    setBusyId(rule.id);
    try {
      const res = await fetch(`/api/v1/shipping-rules/${rule.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? 'Error al eliminar');
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const move = async (idx: number, dir: -1 | 1) => {
    if (!rules) return;
    const target = idx + dir;
    if (target < 0 || target >= rules.length) return;
    const newOrder = [...rules];
    [newOrder[idx], newOrder[target]] = [newOrder[target], newOrder[idx]];
    setRules(newOrder); // optimistic
    try {
      const res = await fetch('/api/v1/shipping-rules/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: newOrder.map((r) => r.id) }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? 'Error al reordenar');
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
      await load(); // revert optimistic by refetching
    }
  };

  return (
    <div className="max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Reglas de envío</h1>
        <p className="text-zinc-400 text-sm mt-1">
          Cuándo el envío lo pagás vos en DAC (REMITENTE) en vez de cobrárselo al cliente
        </p>
      </div>

      <SettingsNav />

      <div className="flex items-start justify-between gap-6 mb-6">
        <div className="max-w-2xl rounded-lg bg-zinc-800/30 border border-white/[0.04] p-4 space-y-2">
          <p className="text-xs text-zinc-400 leading-relaxed">
            Las reglas se evalúan de arriba hacia abajo y la primera que coincide gana: ese pedido
            va como <b className="text-zinc-200 font-semibold">REMITENTE</b> en vez de
            DESTINATARIO. Si no coincide ninguna, se aplica el umbral clásico de la sección
            Configuración.
          </p>
          <p className="text-xs text-zinc-400 leading-relaxed">
            <b className="text-zinc-200 font-semibold">¿Qué pasa con los REMITENTE?</b> El worker
            deja una nota en Shopify con el monto del pedido y vos lo cargás a mano en DAC. No se
            usa tarjeta guardada.
          </p>
        </div>
        <button onClick={() => setCreating(true)} className={`${BTN_PRIMARY} shrink-0`}>
          <Plus className="w-4 h-4" /> Nueva regla
        </button>
      </div>

      {error && <div className={`mb-4 ${ALERT_ERROR}`}>{error}</div>}

      {loading && !rules ? (
        <div className="flex items-center gap-2 text-zinc-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando...
        </div>
      ) : rules && rules.length === 0 ? (
        <div className="bg-zinc-900/30 border border-dashed border-white/[0.10] rounded-xl p-10 text-center">
          <p className="text-zinc-400 text-sm mb-4">
            No hay reglas configuradas. Se sigue aplicando el umbral clásico de{' '}
            <b className="text-zinc-200 font-mono font-semibold">paymentThreshold</b>.
          </p>
          <button onClick={() => setCreating(true)} className={BTN_PRIMARY}>
            <Plus className="w-4 h-4" /> Crear la primera regla
          </button>
        </div>
      ) : (
        <div className={`${CARD} overflow-hidden`}>
          <table className="w-full text-sm">
            <thead className="bg-white/[0.02] text-zinc-400 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left w-12">#</th>
                <th className="px-3 py-2 text-left">Nombre</th>
                <th className="px-3 py-2 text-left">Tipo</th>
                <th className="px-3 py-2 text-left">Parametros</th>
                <th className="px-3 py-2 text-left w-24">Estado</th>
                <th className="px-3 py-2 text-right w-48">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {rules?.map((rule, idx) => (
                <tr key={rule.id} className="border-t border-white/[0.06] hover:bg-white/[0.02] transition-colors">
                  <td className="px-3 py-2.5 font-mono text-xs text-zinc-400">{idx + 1}</td>
                  <td className="px-3 py-2.5 font-medium text-white">{rule.name}</td>
                  <td className="px-3 py-2.5 text-zinc-300">{RULE_TYPE_LABELS[rule.ruleType]}</td>
                  <td className="px-3 py-2.5 text-zinc-400 font-mono text-xs">
                    {formatConfig(rule.ruleType, rule.config as ConfigDraft)}
                  </td>
                  <td className="px-3 py-2.5">
                    {rule.isActive ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs">
                        Activa
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-700/40 border border-white/[0.08] text-zinc-300 text-xs">
                        Pausada
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="inline-flex items-center gap-1">
                      <IconButton
                        title="Subir"
                        onClick={() => move(idx, -1)}
                        disabled={idx === 0 || busyId === rule.id}
                      >
                        <ArrowUp className="w-4 h-4" />
                      </IconButton>
                      <IconButton
                        title="Bajar"
                        onClick={() => move(idx, +1)}
                        disabled={idx === rules.length - 1 || busyId === rule.id}
                      >
                        <ArrowDown className="w-4 h-4" />
                      </IconButton>
                      <IconButton
                        title={rule.isActive ? 'Pausar' : 'Activar'}
                        onClick={() => toggleActive(rule)}
                        disabled={busyId === rule.id}
                      >
                        {rule.isActive ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
                      </IconButton>
                      <IconButton title="Editar" onClick={() => setEditing(rule)} disabled={busyId === rule.id}>
                        <Pencil className="w-4 h-4" />
                      </IconButton>
                      <IconButton title="Eliminar" onClick={() => remove(rule)} disabled={busyId === rule.id} danger>
                        <Trash2 className="w-4 h-4" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(creating || editing) && (
        <RuleModal
          initial={editing ?? undefined}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            setCreating(false);
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

/* ─── Modal ──────────────────────────────────────────────────────────────── */

function RuleModal({
  initial,
  onClose,
  onSaved,
}: {
  initial?: ShippingRuleDTO;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name ?? '');
  const [ruleType, setRuleType] = useState<ShippingRuleType>(initial?.ruleType ?? 'THRESHOLD_TOTAL');
  const [config, setConfig] = useState<ConfigDraft>(
    (initial?.config as ConfigDraft) ?? DEFAULT_CONFIG.THRESHOLD_TOTAL,
  );
  const [priority, setPriority] = useState<number>(initial?.priority ?? 100);
  const [isActive, setIsActive] = useState<boolean>(initial?.isActive ?? true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Presets visible by default when creating; hidden when editing (would be
  // dangerous to one-click-pisar an existing rule's config).
  const [showPresets, setShowPresets] = useState<boolean>(!isEdit);

  // When ruleType changes, reset config to that type's default (unless editing
  // and user hasn't changed the type yet).
  const changeRuleType = (next: ShippingRuleType) => {
    setRuleType(next);
    setConfig(DEFAULT_CONFIG[next]);
  };

  // Apply a preset: fills name / ruleType / config / priority in one shot.
  // We keep isActive=true (new rule) and collapse the preset picker so the
  // user gets straight to review-and-save on the filled form.
  const applyPreset = (preset: RulePreset) => {
    setName(preset.name);
    setRuleType(preset.ruleType);
    setConfig({ ...preset.config });
    setPriority(preset.priority);
    setIsActive(true);
    setShowPresets(false);
  };

  const submit = async () => {
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = { name, ruleType, config, priority, isActive };
      const url = isEdit ? `/api/v1/shipping-rules/${initial!.id}` : '/api/v1/shipping-rules';
      const method = isEdit ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? 'Error al guardar');
      }
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="glass rounded-xl border border-white/10 shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <h2 className="text-base font-semibold text-white">
            {isEdit ? 'Editar regla' : 'Nueva regla de envío'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Plantillas — solo visible al crear. Un click rellena el form entero
              con los valores recomendados y colapsa esta seccion. */}
          {!isEdit && showPresets && (
            <div className="rounded-lg border border-white/[0.06] bg-zinc-800/30 p-4">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-white">
                    Empezar con una plantilla
                  </h3>
                  <p className="text-xs text-zinc-400 mt-1 leading-relaxed">
                    Elegí un preset común y editá los valores si hace falta. O{' '}
                    <button
                      type="button"
                      onClick={() => setShowPresets(false)}
                      className="text-cyan-400 underline underline-offset-2 hover:text-cyan-300 transition-colors"
                    >
                      empezar desde cero
                    </button>.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {RULE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    className="group text-left rounded-lg border border-white/[0.06] bg-zinc-900/60 p-3 hover:border-cyan-500/40 hover:bg-zinc-900 transition-all focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-lg leading-none" aria-hidden="true">
                        {preset.icon}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-white">
                          {preset.title}
                        </p>
                        <p className="text-[11px] text-zinc-400 mt-1 leading-snug">
                          {preset.summary}
                        </p>
                        <p className="text-[10px] text-zinc-400 mt-1 leading-snug italic">
                          {preset.useCase}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!isEdit && !showPresets && (
            <button
              type="button"
              onClick={() => setShowPresets(true)}
              className="text-xs text-zinc-400 hover:text-cyan-400 underline underline-offset-2 transition-colors"
            >
              ← Volver a ver plantillas
            </button>
          )}

          <Field label="Nombre">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder="Ej: VIPs siempre envío gratis"
              className={INPUT}
            />
          </Field>

          <Field label="Tipo de regla">
            <select
              value={ruleType}
              onChange={(e) => changeRuleType(e.target.value as ShippingRuleType)}
              className={`${INPUT} [color-scheme:dark]`}
            >
              {SHIPPING_RULE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {RULE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <p className={HELP}>{RULE_TYPE_DESCRIPTIONS[ruleType]}</p>
          </Field>

          <ConfigEditor ruleType={ruleType} config={config} onChange={setConfig} />

          <div className="grid grid-cols-2 gap-3">
            <Field label="Prioridad (menor = primero)">
              <input
                type="number"
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value || '0', 10))}
                min={0}
                max={10000}
                className={INPUT}
              />
            </Field>
            <Field label="Estado">
              <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="w-4 h-4 accent-cyan-500"
                />
                <span className="text-sm text-zinc-300">{isActive ? 'Activa' : 'Pausada'}</span>
              </label>
            </Field>
          </div>

          {err && <div className={ALERT_ERROR}>{err}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-white/[0.06] bg-white/[0.02] rounded-b-xl">
          <button onClick={onClose} className={BTN_GHOST} disabled={saving}>
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={saving || !name.trim()}
            className={BTN_PRIMARY}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Per-type config editor ─────────────────────────────────────────────── */

function ConfigEditor({
  ruleType,
  config,
  onChange,
}: {
  ruleType: ShippingRuleType;
  config: ConfigDraft;
  onChange: (c: ConfigDraft) => void;
}) {
  switch (ruleType) {
    case 'THRESHOLD_TOTAL':
      return (
        <Field label="Monto mínimo en UYU (estricto mayor que)">
          <input
            type="number"
            value={config.minTotalUyu ?? ''}
            onChange={(e) => onChange({ minTotalUyu: parseFloat(e.target.value || '0') })}
            min={1}
            className={INPUT}
          />
          <p className={HELP}>
            Pedidos con total convertido a UYU mayor que este monto → REMITENTE.
          </p>
        </Field>
      );
    case 'CONSECUTIVE_ORDERS':
      return (
        <Field label="Ventana en minutos">
          <input
            type="number"
            value={config.windowMinutes ?? ''}
            onChange={(e) => onChange({ windowMinutes: parseInt(e.target.value || '0', 10) })}
            min={1}
            max={1440}
            className={INPUT}
          />
          <p className={HELP}>
            Si el mismo cliente ya tiene un pedido dentro de este período, el nuevo va como REMITENTE.
          </p>
        </Field>
      );
    case 'NTH_SHIPMENT_FREE':
      return (
        <Field label="Cada N envíos">
          <input
            type="number"
            value={config.nth ?? ''}
            onChange={(e) => onChange({ nth: parseInt(e.target.value || '0', 10) })}
            min={2}
            max={1000}
            className={INPUT}
          />
          <p className={HELP}>
            El 2do, 4to, N-ésimo... envío al mismo email va como REMITENTE. Se cuentan etiquetas CREATED y COMPLETED.
          </p>
        </Field>
      );
    case 'CUSTOMER_TAG':
      return (
        <Field label="Etiqueta">
          <input
            value={config.tag ?? ''}
            onChange={(e) => onChange({ tag: e.target.value })}
            maxLength={100}
            placeholder="vip"
            className={INPUT}
          />
          <p className={HELP}>
            Comparacion case-insensitive contra tags del pedido o del cliente en Shopify.
          </p>
        </Field>
      );
    case 'ITEM_COUNT':
      return (
        <Field label="Mínimo de items (estricto mayor que)">
          <input
            type="number"
            value={config.minItems ?? ''}
            onChange={(e) => onChange({ minItems: parseInt(e.target.value || '0', 10) })}
            min={1}
            max={100}
            className={INPUT}
          />
          <p className={HELP}>
            Pedidos con más items que este número → REMITENTE.
          </p>
        </Field>
      );
  }
}

/* ─── Small UI primitives ────────────────────────────────────────────────── */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-zinc-400 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function IconButton({
  children,
  onClick,
  disabled,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`p-1.5 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
        danger
          ? 'text-red-400 hover:text-red-300 hover:bg-red-500/10'
          : 'text-zinc-400 hover:text-white hover:bg-white/[0.06]'
      }`}
    >
      {children}
    </button>
  );
}

function formatConfig(type: ShippingRuleType, c: ConfigDraft): string {
  switch (type) {
    case 'THRESHOLD_TOTAL':
      return `> $${c.minTotalUyu ?? '?'} UYU`;
    case 'CONSECUTIVE_ORDERS':
      return `ventana ${c.windowMinutes ?? '?'} min`;
    case 'NTH_SHIPMENT_FREE':
      return `cada ${c.nth ?? '?'} envíos`;
    case 'CUSTOMER_TAG':
      return `tag "${c.tag ?? '?'}"`;
    case 'ITEM_COUNT':
      return `> ${c.minItems ?? '?'} items`;
  }
}
