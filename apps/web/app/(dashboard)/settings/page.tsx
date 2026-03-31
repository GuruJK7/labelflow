'use client';

import { useEffect, useState, FormEvent, useCallback } from 'react';
import { Save, Loader2, CheckCircle, ExternalLink, Clock, Plus, X, Calendar } from 'lucide-react';

interface ScheduleSlot {
  time: string;   // "HH:MM"
  maxOrders: number; // 0 = all
}

interface SettingsData {
  shopifyStoreUrl: string;
  shopifyTokenSet: boolean;
  dacUsername: string;
  dacPasswordSet: boolean;
  emailHost: string;
  emailPort: number;
  emailUser: string;
  emailPassSet: boolean;
  emailFrom: string;
  storeName: string;
  paymentThreshold: number;
  paymentRuleEnabled: boolean;
  cronSchedule: string;
  scheduleSlots: ScheduleSlot[] | null;
  maxOrdersPerRun: number;
  apiKey: string;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [shopifyUrl, setShopifyUrl] = useState('');
  const [shopifyToken, setShopifyToken] = useState('');
  const [dacUsername, setDacUsername] = useState('');
  const [dacPassword, setDacPassword] = useState('');
  const [emailHost, setEmailHost] = useState('smtp.gmail.com');
  const [emailPort, setEmailPort] = useState(587);
  const [emailUser, setEmailUser] = useState('');
  const [emailPass, setEmailPass] = useState('');
  const [emailFrom, setEmailFrom] = useState('');
  const [storeName, setStoreName] = useState('');
  const [threshold, setThreshold] = useState(4000);
  const [paymentRuleEnabled, setPaymentRuleEnabled] = useState(false);
  const [cronSchedule, setCronSchedule] = useState('*/15 * * * *');
  const [scheduleSlots, setScheduleSlots] = useState<ScheduleSlot[]>([{ time: '09:00', maxOrders: 0 }]);
  const [scheduleDays, setScheduleDays] = useState<number[]>([1, 2, 3, 4, 5]); // Mon-Fri

  const DAYS = [
    { value: 0, label: 'Dom', short: 'D' },
    { value: 1, label: 'Lun', short: 'L' },
    { value: 2, label: 'Mar', short: 'M' },
    { value: 3, label: 'Mie', short: 'X' },
    { value: 4, label: 'Jue', short: 'J' },
    { value: 5, label: 'Vie', short: 'V' },
    { value: 6, label: 'Sab', short: 'S' },
  ];

  // Parse cron + scheduleSlots to visual schedule on load
  const parseCronToSchedule = useCallback((cron: string, slots: ScheduleSlot[] | null) => {
    // If we have scheduleSlots, use those directly
    if (slots && slots.length > 0) {
      setScheduleSlots(slots);
    } else {
      // Legacy: parse from cron expression
      const parts = cron.split(' ');
      if (parts.length !== 5) return;
      const [minute, hour] = parts;

      if (hour.includes(',')) {
        const hours = hour.split(',');
        const minutes = minute.split(',');
        const times: ScheduleSlot[] = [];
        hours.forEach((h, i) => {
          const m = minutes[i] ?? minutes[0] ?? '0';
          times.push({ time: `${h.padStart(2, '0')}:${m.padStart(2, '0')}`, maxOrders: 0 });
        });
        setScheduleSlots(times);
      } else if (hour !== '*' && !hour.includes('/')) {
        setScheduleSlots([{ time: `${hour.padStart(2, '0')}:${(minute === '*' ? '0' : minute).padStart(2, '0')}`, maxOrders: 0 }]);
      }
    }

    // Parse days from cron
    const parts = cron.split(' ');
    if (parts.length !== 5) return;
    const dayOfWeek = parts[4];
    if (dayOfWeek === '*') {
      setScheduleDays([0, 1, 2, 3, 4, 5, 6]);
    } else if (dayOfWeek.includes('-')) {
      const [start, end] = dayOfWeek.split('-').map(Number);
      const days: number[] = [];
      for (let i = start; i <= end; i++) days.push(i);
      setScheduleDays(days);
    } else if (dayOfWeek.includes(',')) {
      setScheduleDays(dayOfWeek.split(',').map(Number));
    }
  }, []);

  // Convert visual schedule to cron
  function slotsToCron(slots: ScheduleSlot[], days: number[]): string {
    if (slots.length === 0) return '0 9 * * *';
    const minutes = slots.map(s => s.time.split(':')[1] ?? '0').join(',');
    const hourNums = slots.map(s => s.time.split(':')[0]).join(',');
    const dayStr = days.length === 7 ? '*' : days.sort((a, b) => a - b).join(',');
    return `${minutes} ${hourNums} * * ${dayStr}`;
  }

  function toggleDay(day: number) {
    setScheduleDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
    );
  }

  function addSlot() {
    setScheduleSlots(prev => [...prev, { time: '12:00', maxOrders: 0 }]);
  }

  function removeSlot(index: number) {
    setScheduleSlots(prev => prev.filter((_, i) => i !== index));
  }

  function updateSlotTime(index: number, value: string) {
    setScheduleSlots(prev => prev.map((s, i) => i === index ? { ...s, time: value } : s));
  }

  function updateSlotMaxOrders(index: number, value: number) {
    setScheduleSlots(prev => prev.map((s, i) => i === index ? { ...s, maxOrders: value } : s));
  }
  const [saving, setSaving] = useState('');
  const [message, setMessage] = useState({ type: '', text: '' });

  useEffect(() => {
    fetch('/api/v1/settings')
      .then((r) => r.json())
      .then(({ data }) => {
        if (data) {
          setSettings(data);
          setShopifyUrl(data.shopifyStoreUrl ?? '');
          setDacUsername(data.dacUsername ?? '');
          setEmailHost(data.emailHost ?? 'smtp.gmail.com');
          setEmailPort(data.emailPort ?? 587);
          setEmailUser(data.emailUser ?? '');
          setEmailFrom(data.emailFrom ?? '');
          setStoreName(data.storeName ?? '');
          setThreshold(data.paymentThreshold ?? 4000);
          setPaymentRuleEnabled(data.paymentRuleEnabled ?? false);
          const cron = data.cronSchedule ?? '*/15 * * * *';
          setCronSchedule(cron);
          parseCronToSchedule(cron, data.scheduleSlots);
        }
      })
      .catch(() => {});
  }, [parseCronToSchedule]);

  async function saveSection(section: string, body: Record<string, unknown>) {
    setSaving(section);
    setMessage({ type: '', text: '' });
    const res = await fetch('/api/v1/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setSaving('');
    if (res.ok) {
      setMessage({ type: 'success', text: 'Guardado' });
    } else {
      setMessage({ type: 'error', text: data.error ?? 'Error' });
    }
  }

  const inputClass = 'w-full px-3.5 py-2.5 bg-zinc-800/50 border border-white/[0.08] rounded-lg text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/40 transition-colors';
  const labelClass = 'block text-xs font-medium text-zinc-400 mb-1.5';

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Configuracion</h1>
        <p className="text-zinc-500 text-sm mt-1">Conecta tus servicios</p>
      </div>

      {message.text && (
        <div className={`px-4 py-3 rounded-lg text-sm mb-6 ${message.type === 'success' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
          {message.text}
        </div>
      )}

      <div className="space-y-6 max-w-2xl">
        {/* Shopify */}
        <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">Shopify</h2>
            {settings?.shopifyTokenSet && <span className="text-[10px] text-emerald-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Conectado</span>}
          </div>
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Store URL</label>
              <input value={shopifyUrl} onChange={(e) => setShopifyUrl(e.target.value)} className={inputClass} placeholder="mitienda.myshopify.com" />
            </div>
            <div>
              <label className={labelClass}>Access Token</label>
              <input type="password" value={shopifyToken} onChange={(e) => setShopifyToken(e.target.value)} className={inputClass} placeholder={settings?.shopifyTokenSet ? '********' : 'shpat_xxx'} />
            </div>
            <button onClick={() => saveSection('shopify', { shopifyStoreUrl: shopifyUrl, ...(shopifyToken ? { shopifyToken } : {}) })} disabled={saving === 'shopify'}
              className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
              {saving === 'shopify' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Guardar Shopify
            </button>
          </div>
        </div>

        {/* DAC */}
        <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">DAC Uruguay</h2>
            {settings?.dacPasswordSet && <span className="text-[10px] text-emerald-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Conectado</span>}
          </div>
          <p className="text-xs text-zinc-500 mb-3">Usa tu Documento o RUT como usuario (no email)</p>
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Documento / RUT</label>
              <input value={dacUsername} onChange={(e) => setDacUsername(e.target.value)} className={inputClass} placeholder="12345678" />
            </div>
            <div>
              <label className={labelClass}>Password</label>
              <input type="password" value={dacPassword} onChange={(e) => setDacPassword(e.target.value)} className={inputClass} placeholder={settings?.dacPasswordSet ? '********' : 'Tu password de DAC'} />
            </div>
            <button onClick={() => saveSection('dac', { dacUsername, ...(dacPassword ? { dacPassword } : {}) })} disabled={saving === 'dac'}
              className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
              {saving === 'dac' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Guardar DAC
            </button>
          </div>
        </div>

        {/* Email */}
        <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
          <h2 className="text-sm font-semibold text-white mb-4">Email (notificaciones)</h2>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelClass}>SMTP Host</label><input value={emailHost} onChange={(e) => setEmailHost(e.target.value)} className={inputClass} /></div>
            <div><label className={labelClass}>Port</label><input type="number" value={emailPort} onChange={(e) => setEmailPort(Number(e.target.value))} className={inputClass} /></div>
            <div><label className={labelClass}>User</label><input value={emailUser} onChange={(e) => setEmailUser(e.target.value)} className={inputClass} /></div>
            <div><label className={labelClass}>Password</label><input type="password" value={emailPass} onChange={(e) => setEmailPass(e.target.value)} className={inputClass} placeholder={settings?.emailPassSet ? '********' : ''} /></div>
            <div><label className={labelClass}>From</label><input value={emailFrom} onChange={(e) => setEmailFrom(e.target.value)} className={inputClass} placeholder="Mi Tienda <noreply@...>" /></div>
            <div><label className={labelClass}>Nombre tienda</label><input value={storeName} onChange={(e) => setStoreName(e.target.value)} className={inputClass} /></div>
          </div>
          <button onClick={() => saveSection('email', { emailHost, emailPort, emailUser, ...(emailPass ? { emailPass } : {}), emailFrom, storeName })} disabled={saving === 'email'}
            className="mt-3 inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
            {saving === 'email' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Guardar Email
          </button>
        </div>

        {/* Reglas de pago */}
        <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
          <h2 className="text-sm font-semibold text-white mb-4">Regla de pago</h2>

          {/* Toggle */}
          <div className="flex items-center justify-between mb-4 p-3 rounded-lg bg-zinc-800/30 border border-white/[0.04]">
            <div>
              <p className="text-sm text-white font-medium">Pagar con tarjeta precargada en DAC</p>
              <p className="text-[10px] text-zinc-500 mt-0.5">
                {paymentRuleEnabled
                  ? 'Pedidos por encima del umbral se pagan con tu saldo DAC (remitente)'
                  : 'Desactivado — todos los envios los paga el cliente al recibir (destinatario)'}
              </p>
            </div>
            <button
              onClick={() => setPaymentRuleEnabled(!paymentRuleEnabled)}
              className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                paymentRuleEnabled ? 'bg-cyan-600' : 'bg-zinc-700'
              }`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                paymentRuleEnabled ? 'translate-x-5' : 'translate-x-0'
              }`} />
            </button>
          </div>

          {/* Threshold (only visible when enabled) */}
          {paymentRuleEnabled && (
            <div className="mb-3">
              <label className={labelClass}>Umbral pago (UYU)</label>
              <input type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className={inputClass + ' max-w-xs'} />
              <p className="text-[10px] text-zinc-600 mt-1">Pedidos por encima: paga tu tienda con saldo DAC. Por debajo: paga el cliente al recibir.</p>
            </div>
          )}

          <button onClick={() => saveSection('threshold', { paymentThreshold: threshold, paymentRuleEnabled })} disabled={saving === 'threshold'}
            className="mt-3 inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
            {saving === 'threshold' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Guardar regla
          </button>
        </div>

        {/* Programacion de horarios */}
        <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
          <div className="flex items-center gap-2 mb-5">
            <Clock className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-white">Programacion automatica</h2>
          </div>

          {/* Dias de la semana */}
          <div className="mb-5">
            <label className={labelClass}>Dias de ejecucion</label>
            <div className="flex gap-2 mt-1">
              {DAYS.map((day) => (
                <button
                  key={day.value}
                  onClick={() => toggleDay(day.value)}
                  className={`w-10 h-10 rounded-lg text-xs font-medium transition-all ${
                    scheduleDays.includes(day.value)
                      ? 'bg-cyan-600 text-white shadow-lg shadow-cyan-500/20'
                      : 'bg-zinc-800/50 text-zinc-500 border border-white/[0.06] hover:border-cyan-500/30 hover:text-zinc-300'
                  }`}
                >
                  {day.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2 mt-2">
              <button onClick={() => setScheduleDays([1, 2, 3, 4, 5])} className="text-[10px] text-cyan-400/70 hover:text-cyan-400 transition-colors">Lun-Vie</button>
              <span className="text-zinc-700 text-[10px]">|</span>
              <button onClick={() => setScheduleDays([0, 1, 2, 3, 4, 5, 6])} className="text-[10px] text-cyan-400/70 hover:text-cyan-400 transition-colors">Todos</button>
              <span className="text-zinc-700 text-[10px]">|</span>
              <button onClick={() => setScheduleDays([1, 3, 5])} className="text-[10px] text-cyan-400/70 hover:text-cyan-400 transition-colors">Lun-Mie-Vie</button>
            </div>
          </div>

          {/* Horarios con limite por slot */}
          <div className="mb-5">
            <label className={labelClass}>Horarios de ejecucion</label>
            <div className="space-y-2 mt-1">
              {scheduleSlots.map((slot, index) => (
                <div key={index} className="flex items-center gap-2 bg-zinc-800/20 border border-white/[0.04] rounded-lg p-2">
                  <input
                    type="time"
                    value={slot.time}
                    onChange={(e) => updateSlotTime(index, e.target.value)}
                    className="px-3 py-2 bg-zinc-800/50 border border-white/[0.08] rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/40 transition-colors [color-scheme:dark]"
                  />
                  <div className="flex items-center gap-1.5">
                    <label className="text-[10px] text-zinc-500 whitespace-nowrap">Max pedidos:</label>
                    <input
                      type="number"
                      min={0}
                      max={50}
                      value={slot.maxOrders}
                      onChange={(e) => updateSlotMaxOrders(index, Math.max(0, Math.min(50, Number(e.target.value))))}
                      className="w-16 px-2 py-2 bg-zinc-800/50 border border-white/[0.08] rounded-lg text-white text-sm text-center focus:outline-none focus:ring-2 focus:ring-cyan-500/40 transition-colors"
                      placeholder="0"
                    />
                    <span className="text-[9px] text-zinc-600">{slot.maxOrders === 0 ? '(todos)' : ''}</span>
                  </div>
                  {scheduleSlots.length > 1 && (
                    <button onClick={() => removeSlot(index)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-zinc-500 hover:text-red-400 transition-colors ml-auto">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button onClick={addSlot} className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-cyan-400/70 hover:text-cyan-400 transition-colors">
              <Plus className="w-3 h-3" /> Agregar otro horario
            </button>
            <p className="text-[10px] text-zinc-600 mt-1">Max pedidos: 0 = procesa todos los pendientes</p>
          </div>

          {/* Preview */}
          <div className="bg-zinc-800/30 border border-white/[0.04] rounded-lg px-4 py-3 mb-4">
            <p className="text-[11px] text-zinc-500 mb-1">Resumen:</p>
            <p className="text-xs text-white">
              <Calendar className="w-3 h-3 inline mr-1 text-cyan-400" />
              {scheduleDays.length === 7
                ? 'Todos los dias'
                : scheduleDays.length === 0
                  ? 'Ningun dia seleccionado'
                  : scheduleDays.sort((a, b) => a - b).map(d => DAYS.find(dd => dd.value === d)?.label).join(', ')
              }
            </p>
            <div className="mt-1.5 space-y-0.5">
              {scheduleSlots.map((slot, i) => (
                <p key={i} className="text-[11px] text-zinc-400">
                  <span className="text-cyan-400 font-medium">{slot.time}</span>
                  {' — '}
                  <span className="text-zinc-500">
                    {slot.maxOrders === 0 ? 'todos los pedidos' : `max ${slot.maxOrders} pedidos`}
                  </span>
                </p>
              ))}
            </div>
            <p className="text-[10px] text-zinc-600 mt-1.5">Cron: {slotsToCron(scheduleSlots, scheduleDays)}</p>
          </div>

          <button
            onClick={() => {
              const cron = slotsToCron(scheduleSlots, scheduleDays);
              setCronSchedule(cron);
              saveSection('schedule', { cronSchedule: cron, scheduleSlots });
            }}
            disabled={saving === 'schedule'}
            className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
          >
            {saving === 'schedule' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Guardar programacion
          </button>
        </div>

        {/* API Key */}
        {settings?.apiKey && (
          <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
            <h2 className="text-sm font-semibold text-white mb-2">API Key (MCP)</h2>
            <p className="text-xs text-zinc-500 mb-3">Usa esta clave para conectar desde Claude Desktop u otros clientes MCP.</p>
            <code className="block bg-zinc-800 px-4 py-2.5 rounded-lg text-cyan-400 text-xs font-mono break-all">{settings.apiKey}</code>
          </div>
        )}
      </div>
    </div>
  );
}
