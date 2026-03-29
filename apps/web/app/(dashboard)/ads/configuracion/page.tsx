'use client';

import { useEffect, useState } from 'react';
import {
  SlidersHorizontal,
  Save,
  Loader2,
  Plus,
  Trash2,
  Shield,
  FolderOpen,
  Bell,
} from 'lucide-react';

interface Rule {
  id?: string;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  windowHours: number;
  action: string;
  isActive: boolean;
}

interface ConfigData {
  metaAdAccountId: string;
  metaPageId: string;
  metaPixelId: string;
  hasMetaAccessToken: boolean;
  driveFolderId: string;
  hasDriveApiKey: boolean;
  notifyEmail: string;
  notifyWebhook: string;
  isActive: boolean;
  scanSchedule: string;
  monitorSchedule: string;
}

const METRICS = [
  { value: 'purchase_intent_rate', label: 'Purchase Intent Rate (%)' },
  { value: 'ctr', label: 'CTR (%)' },
  { value: 'cpc', label: 'CPC ($)' },
  { value: 'cpm', label: 'CPM ($)' },
  { value: 'roas', label: 'ROAS' },
  { value: 'spend', label: 'Gasto ($)' },
];

const OPERATORS = [
  { value: 'lt', label: '< menor que' },
  { value: 'gt', label: '> mayor que' },
  { value: 'lte', label: '<= menor o igual' },
  { value: 'gte', label: '>= mayor o igual' },
];

export default function ConfiguracionPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configured, setConfigured] = useState(false);

  // Config fields
  const [metaAccessToken, setMetaAccessToken] = useState('');
  const [metaAdAccountId, setMetaAdAccountId] = useState('');
  const [metaPageId, setMetaPageId] = useState('');
  const [metaPixelId, setMetaPixelId] = useState('');
  const [driveFolderId, setDriveFolderId] = useState('');
  const [driveApiKey, setDriveApiKey] = useState('');
  const [notifyEmail, setNotifyEmail] = useState('');
  const [notifyWebhook, setNotifyWebhook] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [scanSchedule, setScanSchedule] = useState('0 8 * * 1-5');
  const [monitorSchedule, setMonitorSchedule] = useState('*/30 * * * *');
  const [rules, setRules] = useState<Rule[]>([]);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await fetch('/api/ads/config');
        if (res.ok) {
          const data = await res.json();
          const cfg = data.data;
          setConfigured(cfg.configured);
          if (cfg.config) {
            setMetaAdAccountId(cfg.config.metaAdAccountId);
            setMetaPageId(cfg.config.metaPageId);
            setMetaPixelId(cfg.config.metaPixelId);
            setDriveFolderId(cfg.config.driveFolderId);
            setNotifyEmail(cfg.config.notifyEmail);
            setNotifyWebhook(cfg.config.notifyWebhook);
            setIsActive(cfg.config.isActive);
            setScanSchedule(cfg.config.scanSchedule);
            setMonitorSchedule(cfg.config.monitorSchedule);
          }
          if (cfg.rules) {
            setRules(cfg.rules);
          }
        }
      } catch {
        // Silent
      } finally {
        setLoading(false);
      }
    };
    fetchConfig();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        metaAdAccountId,
        metaPageId,
        metaPixelId,
        driveFolderId,
        notifyEmail,
        notifyWebhook,
        isActive,
        scanSchedule,
        monitorSchedule,
        rules: rules.map((r) => ({
          name: r.name,
          metric: r.metric,
          operator: r.operator,
          threshold: r.threshold,
          windowHours: r.windowHours,
          action: r.action,
          isActive: r.isActive,
        })),
      };

      // Only send tokens if user typed new ones
      if (metaAccessToken) body.metaAccessToken = metaAccessToken;
      if (driveApiKey) body.driveApiKey = driveApiKey;

      const res = await fetch('/api/ads/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        setConfigured(true);
        setMetaAccessToken('');
        setDriveApiKey('');
      }
    } catch {
      // Silent
    } finally {
      setSaving(false);
    }
  };

  const addRule = () => {
    setRules([
      ...rules,
      {
        name: '',
        metric: 'purchase_intent_rate',
        operator: 'lt',
        threshold: 2,
        windowHours: 48,
        action: 'pause',
        isActive: true,
      },
    ]);
  };

  const removeRule = (index: number) => {
    setRules(rules.filter((_, i) => i !== index));
  };

  const updateRule = (index: number, field: keyof Rule, value: unknown) => {
    setRules(rules.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
      </div>
    );
  }

  const inputClass =
    'w-full bg-zinc-900/80 border border-white/[0.08] rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20 transition-colors';

  const labelClass = 'block text-xs font-medium text-zinc-400 mb-1.5';

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Meta credentials */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
        <div className="flex items-center gap-2 mb-5">
          <Shield className="w-4 h-4 text-cyan-400" />
          <h2 className="text-sm font-semibold text-white">Credenciales de Meta</h2>
        </div>
        <div className="space-y-4">
          <div>
            <label className={labelClass}>Access Token</label>
            <input
              type="password"
              value={metaAccessToken}
              onChange={(e) => setMetaAccessToken(e.target.value)}
              placeholder={configured ? '(guardado — ingresa nuevo para cambiar)' : 'EAAxxxxxx...'}
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Ad Account ID</label>
              <input
                type="text"
                value={metaAdAccountId}
                onChange={(e) => setMetaAdAccountId(e.target.value)}
                placeholder="act_123456789"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Page ID</label>
              <input
                type="text"
                value={metaPageId}
                onChange={(e) => setMetaPageId(e.target.value)}
                placeholder="123456789"
                className={inputClass}
              />
            </div>
          </div>
          <div>
            <label className={labelClass}>Pixel ID (opcional)</label>
            <input
              type="text"
              value={metaPixelId}
              onChange={(e) => setMetaPixelId(e.target.value)}
              placeholder="123456789"
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {/* Google Drive */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
        <div className="flex items-center gap-2 mb-5">
          <FolderOpen className="w-4 h-4 text-cyan-400" />
          <h2 className="text-sm font-semibold text-white">Google Drive</h2>
        </div>
        <div className="space-y-4">
          <div>
            <label className={labelClass}>Folder ID</label>
            <input
              type="text"
              value={driveFolderId}
              onChange={(e) => setDriveFolderId(e.target.value)}
              placeholder="1AbC_dEfGhIjKlMnOpQr"
              className={inputClass}
            />
            <p className="text-[11px] text-zinc-600 mt-1">ID de la carpeta con tus creativos (imagenes/videos) y copies.json</p>
          </div>
          <div>
            <label className={labelClass}>API Key</label>
            <input
              type="password"
              value={driveApiKey}
              onChange={(e) => setDriveApiKey(e.target.value)}
              placeholder={configured ? '(guardado — ingresa nuevo para cambiar)' : 'AIzaSy...'}
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {/* Rules */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-white">Reglas de Auto-pausa</h2>
          </div>
          <button
            onClick={addRule}
            className="inline-flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> Agregar regla
          </button>
        </div>

        {rules.length === 0 ? (
          <p className="text-sm text-zinc-600">Sin reglas configuradas. Los anuncios no se pausaran automaticamente.</p>
        ) : (
          <div className="space-y-3">
            {rules.map((rule, i) => (
              <div key={i} className="bg-zinc-800/50 border border-white/[0.04] rounded-lg p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <input
                    type="text"
                    value={rule.name}
                    onChange={(e) => updateRule(i, 'name', e.target.value)}
                    placeholder="Nombre de la regla"
                    className="bg-transparent border-none text-sm text-white placeholder-zinc-600 focus:outline-none flex-1"
                  />
                  <button
                    onClick={() => removeRule(i)}
                    className="text-zinc-600 hover:text-red-400 transition-colors p-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <select
                    value={rule.metric}
                    onChange={(e) => updateRule(i, 'metric', e.target.value)}
                    className={inputClass}
                  >
                    {METRICS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <select
                    value={rule.operator}
                    onChange={(e) => updateRule(i, 'operator', e.target.value)}
                    className={inputClass}
                  >
                    {OPERATORS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step="0.01"
                    value={rule.threshold}
                    onChange={(e) => updateRule(i, 'threshold', parseFloat(e.target.value) || 0)}
                    placeholder="Umbral"
                    className={inputClass}
                  />
                  <input
                    type="number"
                    value={rule.windowHours}
                    onChange={(e) => updateRule(i, 'windowHours', parseInt(e.target.value) || 48)}
                    placeholder="Horas"
                    className={inputClass}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Notifications */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
        <div className="flex items-center gap-2 mb-5">
          <Bell className="w-4 h-4 text-cyan-400" />
          <h2 className="text-sm font-semibold text-white">Notificaciones</h2>
        </div>
        <div className="space-y-4">
          <div>
            <label className={labelClass}>Email de notificaciones</label>
            <input
              type="email"
              value={notifyEmail}
              onChange={(e) => setNotifyEmail(e.target.value)}
              placeholder="tu@email.com"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Webhook URL (opcional)</label>
            <input
              type="url"
              value={notifyWebhook}
              onChange={(e) => setNotifyWebhook(e.target.value)}
              placeholder="https://hooks.slack.com/..."
              className={inputClass}
            />
          </div>
        </div>
      </div>

      {/* Schedules */}
      <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
        <h2 className="text-sm font-semibold text-white mb-4">Programacion</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Escaneo de Drive (cron)</label>
            <input
              type="text"
              value={scanSchedule}
              onChange={(e) => setScanSchedule(e.target.value)}
              className={inputClass}
            />
            <p className="text-[11px] text-zinc-600 mt-1">Default: L-V a las 8am</p>
          </div>
          <div>
            <label className={labelClass}>Monitor de metricas (cron)</label>
            <input
              type="text"
              value={monitorSchedule}
              onChange={(e) => setMonitorSchedule(e.target.value)}
              className={inputClass}
            />
            <p className="text-[11px] text-zinc-600 mt-1">Default: cada 30 min</p>
          </div>
        </div>
      </div>

      {/* Active toggle + Save */}
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-3 cursor-pointer">
          <div
            className={`relative w-11 h-6 rounded-full transition-colors ${isActive ? 'bg-cyan-600' : 'bg-zinc-700'}`}
            onClick={() => setIsActive(!isActive)}
          >
            <div
              className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${isActive ? 'translate-x-5' : ''}`}
            />
          </div>
          <span className="text-sm text-zinc-400">{isActive ? 'Agente activo' : 'Agente inactivo'}</span>
        </label>
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-600/50 text-white px-6 py-2.5 rounded-lg text-sm font-medium transition-colors"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Guardar Configuracion
        </button>
      </div>
    </div>
  );
}
