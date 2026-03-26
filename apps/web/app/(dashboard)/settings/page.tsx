'use client';

import { useEffect, useState, FormEvent } from 'react';
import { Save, Loader2, CheckCircle, ExternalLink } from 'lucide-react';

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
  cronSchedule: string;
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
  const [cronSchedule, setCronSchedule] = useState('*/15 * * * *');
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
          setCronSchedule(data.cronSchedule ?? '*/15 * * * *');
        }
      })
      .catch(() => {});
  }, []);

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

        {/* Rules */}
        <div className="bg-zinc-900/50 border border-white/[0.06] rounded-xl p-6">
          <h2 className="text-sm font-semibold text-white mb-4">Reglas de negocio</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Umbral pago (UYU)</label>
              <input type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className={inputClass} />
              <p className="text-[10px] text-zinc-600 mt-1">Por encima: paga remitente. Por debajo: paga destinatario.</p>
            </div>
            <div>
              <label className={labelClass}>Frecuencia (cron)</label>
              <input value={cronSchedule} onChange={(e) => setCronSchedule(e.target.value)} className={inputClass} />
              <p className="text-[10px] text-zinc-600 mt-1">*/15 * * * * = cada 15 min</p>
            </div>
          </div>
          <button onClick={() => saveSection('rules', { paymentThreshold: threshold, cronSchedule })} disabled={saving === 'rules'}
            className="mt-3 inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50">
            {saving === 'rules' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Guardar reglas
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
