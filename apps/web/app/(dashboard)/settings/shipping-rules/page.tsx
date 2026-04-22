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
    title: 'Envios grandes (> $3.000 UYU)',
    summary: 'Pedidos con total superior a $3.000 se marcan REMITENTE.',
    useCase: 'Cuando pagas vos los envios caros en vez de cobrarselos al cliente.',
    icon: '💰',
    name: 'Envios grandes (> $3.000 UYU)',
    ruleType: 'THRESHOLD_TOTAL',
    config: { minTotalUyu: 3000 },
    priority: 100,
  },
  {
    id: 'second-order',
    title: 'Segundo pedido del mismo cliente (60 min)',
    summary: 'Si un cliente hace 2+ pedidos en 60 min, del 2do en adelante va REMITENTE.',
    useCase: 'Evitar cobrar envio multiple cuando el cliente compra varios productos seguidos.',
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
    useCase: 'Envio gratis para tus mejores clientes; el tag lo asignas en Shopify.',
    icon: '⭐',
    name: 'Clientes VIP (tag "vip")',
    ruleType: 'CUSTOMER_TAG',
    config: { tag: 'vip' },
    priority: 10,
  },
  {
    id: 'bulk-items',
    title: 'Pedidos mayoristas (5+ items)',
    summary: 'Pedidos con 5 items o mas se marcan REMITENTE.',
    useCase: 'Clientes que compran al por mayor o hacen regalos grandes.',
    icon: '📦',
    name: 'Pedidos mayoristas (5+ items)',
    ruleType: 'ITEM_COUNT',
    config: { minItems: 5 },
    priority: 80,
  },
  {
    id: 'nth-free',
    title: 'Cada 10mo envio gratis',
    summary: 'El envio numero 10, 20, 30... de cada cliente se marca REMITENTE.',
    useCase: 'Programa de fidelidad simple.',
    icon: '🎁',
    name: 'Cada 10mo envio gratis',
    ruleType: 'NTH_SHIPMENT_FREE',
    config: { nth: 10 },
    priority: 60,
  },
];

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
    <div className="p-6 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Reglas de envio</h1>
          <p className="text-sm text-gray-600 mt-1">
            Configura cuando un pedido se marca como <b>REMITENTE</b> (lo pagas vos en DAC)
            en lugar de DESTINATARIO (lo paga el cliente al recibir). Las reglas se evaluan de
            arriba hacia abajo; la primera que coincide gana. Si ninguna coincide, se usa el
            umbral clasico de la seccion Configuracion.
          </p>
          <p className="text-xs text-gray-500 mt-2 leading-relaxed">
            <b>¿Que pasa con los REMITENTE?</b> El worker deja una nota en Shopify con el monto
            del pedido y vos lo cargas a mano en DAC. No se usa tarjeta guardada.
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-black text-white rounded-lg hover:bg-gray-800 text-sm font-medium"
        >
          <Plus className="w-4 h-4" /> Nueva regla
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">
          {error}
        </div>
      )}

      {loading && !rules ? (
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Cargando...
        </div>
      ) : rules && rules.length === 0 ? (
        <div className="border border-dashed border-gray-300 rounded-lg p-10 text-center">
          <p className="text-gray-600 mb-4">
            No hay reglas configuradas. Se sigue aplicando el umbral clasico de <b>paymentThreshold</b>.
          </p>
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-black text-white rounded-lg hover:bg-gray-800 text-sm"
          >
            <Plus className="w-4 h-4" /> Crear la primera regla
          </button>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
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
                <tr key={rule.id} className="border-t border-gray-100 hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs text-gray-500">{idx + 1}</td>
                  <td className="px-3 py-2 font-medium text-gray-900">{rule.name}</td>
                  <td className="px-3 py-2 text-gray-700">{RULE_TYPE_LABELS[rule.ruleType]}</td>
                  <td className="px-3 py-2 text-gray-600 font-mono text-xs">
                    {formatConfig(rule.ruleType, rule.config as ConfigDraft)}
                  </td>
                  <td className="px-3 py-2">
                    {rule.isActive ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-xs">
                        Activa
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
                        Pausada
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
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
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">
            {isEdit ? 'Editar regla' : 'Nueva regla de envio'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Plantillas — solo visible al crear. Un click rellena el form entero
              con los valores recomendados y colapsa esta seccion. */}
          {!isEdit && showPresets && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">
                    Empezar con una plantilla
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Elegi un preset comun y edita los valores si hace falta. O{' '}
                    <button
                      type="button"
                      onClick={() => setShowPresets(false)}
                      className="text-gray-700 underline hover:text-black"
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
                    className="group text-left rounded-lg border border-gray-200 bg-white p-3 hover:border-black hover:shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-black"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-lg leading-none" aria-hidden="true">
                        {preset.icon}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 group-hover:text-black">
                          {preset.title}
                        </p>
                        <p className="text-[11px] text-gray-600 mt-0.5 leading-snug">
                          {preset.summary}
                        </p>
                        <p className="text-[10px] text-gray-400 mt-1 leading-snug italic">
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
              className="text-xs text-gray-500 hover:text-black underline underline-offset-2"
            >
              ← Volver a ver plantillas
            </button>
          )}

          <Field label="Nombre">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder="Ej: VIPs siempre envio gratis"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black"
            />
          </Field>

          <Field label="Tipo de regla">
            <select
              value={ruleType}
              onChange={(e) => changeRuleType(e.target.value as ShippingRuleType)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-black"
            >
              {SHIPPING_RULE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {RULE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">{RULE_TYPE_DESCRIPTIONS[ruleType]}</p>
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
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black"
              />
            </Field>
            <Field label="Estado">
              <label className="flex items-center gap-2 mt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="w-4 h-4"
                />
                <span className="text-sm text-gray-700">{isActive ? 'Activa' : 'Pausada'}</span>
              </label>
            </Field>
          </div>

          {err && (
            <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm">{err}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b-xl">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-lg"
            disabled={saving}
          >
            Cancelar
          </button>
          <button
            onClick={submit}
            disabled={saving || !name.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 bg-black text-white rounded-lg hover:bg-gray-800 text-sm font-medium disabled:opacity-50"
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
        <Field label="Monto minimo en UYU (estricto mayor que)">
          <input
            type="number"
            value={config.minTotalUyu ?? ''}
            onChange={(e) => onChange({ minTotalUyu: parseFloat(e.target.value || '0') })}
            min={1}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black"
          />
          <p className="text-xs text-gray-500 mt-1">
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
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black"
          />
          <p className="text-xs text-gray-500 mt-1">
            Si el mismo cliente ya tiene un pedido dentro de este periodo, el nuevo va como REMITENTE.
          </p>
        </Field>
      );
    case 'NTH_SHIPMENT_FREE':
      return (
        <Field label="Cada N envios">
          <input
            type="number"
            value={config.nth ?? ''}
            onChange={(e) => onChange({ nth: parseInt(e.target.value || '0', 10) })}
            min={2}
            max={1000}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black"
          />
          <p className="text-xs text-gray-500 mt-1">
            El 2do, 4to, Nesimo... envio al mismo email va como REMITENTE. Se cuentan etiquetas CREATED y COMPLETED.
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
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black"
          />
          <p className="text-xs text-gray-500 mt-1">
            Comparacion case-insensitive contra tags del pedido o del cliente en Shopify.
          </p>
        </Field>
      );
    case 'ITEM_COUNT':
      return (
        <Field label="Minimo de items (estricto mayor que)">
          <input
            type="number"
            value={config.minItems ?? ''}
            onChange={(e) => onChange({ minItems: parseInt(e.target.value || '0', 10) })}
            min={1}
            max={100}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-black"
          />
          <p className="text-xs text-gray-500 mt-1">
            Pedidos con mas items que este numero → REMITENTE.
          </p>
        </Field>
      );
  }
}

/* ─── Small UI primitives ────────────────────────────────────────────────── */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
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
      className={`p-1.5 rounded-md disabled:opacity-30 disabled:cursor-not-allowed ${
        danger ? 'text-red-600 hover:bg-red-50' : 'text-gray-600 hover:bg-gray-100'
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
      return `cada ${c.nth ?? '?'} envios`;
    case 'CUSTOMER_TAG':
      return `tag "${c.tag ?? '?'}"`;
    case 'ITEM_COUNT':
      return `> ${c.minItems ?? '?'} items`;
  }
}
