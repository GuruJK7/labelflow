'use client';

import { useEffect, useState } from 'react';
import { Save, Loader2, MessageSquare, Clock, AlertCircle, Eye, Wifi, WifiOff, CheckCircle2, Send } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { RecoverConfig } from '@/types/recover';

const DELAY_OPTIONS = [
  { value: 30, label: '30 minutos' },
  { value: 60, label: '1 hora' },
  { value: 90, label: '1.5 horas' },
  { value: 120, label: '2 horas' },
  { value: 180, label: '3 horas' },
];

function interpolatePreview(template: string): string {
  return template
    .replaceAll('{{1}}', 'Maria')
    .replaceAll('{{2}}', 'Vestido floral talle M')
    .replaceAll('{{3}}', 'https://tu-tienda.com/checkouts/abc123');
}

export default function RecoverSettingsPage() {
  const [config, setConfig] = useState<RecoverConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Form state
  const [delayMinutes, setDelayMinutes] = useState(60);
  const [secondMessageEnabled, setSecondMessageEnabled] = useState(false);
  const [secondMessageDelayMinutes, setSecondMessageDelayMinutes] = useState(1440);
  const [messageTemplate1, setMessageTemplate1] = useState('');
  const [messageTemplate2, setMessageTemplate2] = useState('');
  const [optOutKeyword, setOptOutKeyword] = useState('STOP');

  // WhatsApp credentials state
  const [whatsappMode, setWhatsappMode] = useState<'PLATFORM' | 'OWN'>('PLATFORM');
  const [whatsappApiToken, setWhatsappApiToken] = useState('');
  const [whatsappPhoneNumberId, setWhatsappPhoneNumberId] = useState('');
  const [whatsappApiTokenSet, setWhatsappApiTokenSet] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    fetch('/api/recover/config')
      .then((r) => r.json())
      .then((res) => {
        const cfg = res.data as RecoverConfig & { whatsappApiTokenSet?: boolean };
        setConfig(cfg);
        setDelayMinutes(cfg.delayMinutes);
        setSecondMessageEnabled(cfg.secondMessageEnabled);
        setSecondMessageDelayMinutes(cfg.secondMessageDelayMinutes);
        setMessageTemplate1(cfg.messageTemplate1);
        setMessageTemplate2(cfg.messageTemplate2);
        setOptOutKeyword(cfg.optOutKeyword);
        setWhatsappMode((cfg.whatsappMode as 'PLATFORM' | 'OWN') ?? 'PLATFORM');
        setWhatsappPhoneNumberId(cfg.whatsappPhoneNumberId ?? '');
        setWhatsappApiTokenSet(cfg.whatsappApiTokenSet ?? false);
      })
      .catch(() => setError('Error al cargar configuracion'))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    setError('');
    setSaved(false);

    try {
      const payload: Record<string, unknown> = {
        delayMinutes,
        secondMessageEnabled,
        secondMessageDelayMinutes,
        messageTemplate1,
        messageTemplate2,
        optOutKeyword,
        whatsappMode,
        whatsappPhoneNumberId: whatsappPhoneNumberId || undefined,
      };
      // Only send the token if the user typed a new one
      if (whatsappApiToken.trim()) {
        payload.whatsappApiToken = whatsappApiToken.trim();
      }

      const res = await fetch('/api/recover/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? 'Error al guardar');
        return;
      }

      const data = await res.json();
      setConfig(data.data);
      if (whatsappApiToken.trim()) {
        setWhatsappApiTokenSet(true);
        setWhatsappApiToken(''); // clear after saving
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError('Error de conexion');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestWhatsapp() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/recover/test-whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testPhone.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setTestResult({ ok: true, msg: 'Mensaje enviado correctamente' });
      } else {
        setTestResult({ ok: false, msg: data.error ?? 'Error desconocido' });
      }
    } catch {
      setTestResult({ ok: false, msg: 'Error de conexion' });
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-white">Configuracion Recover</h1>
        <p className="text-zinc-500 text-sm mt-1">
          Personaliza el timing y los mensajes de recuperacion de carritos.
        </p>
      </div>

      {/* Variables reference */}
      <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-xl p-4">
        <p className="text-xs font-semibold text-cyan-400 mb-2">Variables disponibles</p>
        <div className="flex flex-wrap gap-2">
          {[
            { key: '{{1}}', desc: 'Nombre del cliente' },
            { key: '{{2}}', desc: 'Producto principal' },
            { key: '{{3}}', desc: 'Link al carrito' },
          ].map((v) => (
            <span
              key={v.key}
              className="text-[11px] bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1 text-zinc-300"
            >
              <span className="text-cyan-400 font-mono">{v.key}</span>
              {' '}{v.desc}
            </span>
          ))}
        </div>
      </div>

      {/* Timing */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Clock className="w-4 h-4 text-zinc-400" />
          <h2 className="text-sm font-semibold text-white">Timing del primer mensaje</h2>
        </div>

        <div>
          <label className="block text-xs text-zinc-400 mb-2">
            Enviar primer mensaje despues de...
          </label>
          <div className="flex flex-wrap gap-2">
            {DELAY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDelayMinutes(opt.value)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all',
                  delayMinutes === opt.value
                    ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30'
                    : 'bg-white/[0.02] text-zinc-400 border-white/[0.06] hover:text-zinc-200'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Template 1 */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5 space-y-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-blue-400" />
          <h2 className="text-sm font-semibold text-white">Mensaje 1</h2>
        </div>

        <div>
          <textarea
            value={messageTemplate1}
            onChange={(e) => setMessageTemplate1(e.target.value)}
            rows={4}
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40 resize-none"
            placeholder="Escribe tu mensaje aqui..."
          />
        </div>

        {/* Preview */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Eye className="w-3 h-3 text-zinc-600" />
            <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Preview</span>
          </div>
          <div className="bg-emerald-950/30 border border-emerald-900/30 rounded-lg px-4 py-3">
            <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">
              {interpolatePreview(messageTemplate1)}
            </p>
          </div>
        </div>
      </div>

      {/* Second message toggle */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-yellow-400" />
            <h2 className="text-sm font-semibold text-white">Segundo mensaje (opcional)</h2>
          </div>
          <button
            onClick={() => setSecondMessageEnabled(!secondMessageEnabled)}
            className={cn(
              'w-10 h-5 rounded-full transition-colors relative',
              secondMessageEnabled ? 'bg-cyan-500' : 'bg-zinc-700'
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 w-4 h-4 bg-white rounded-full transition-transform shadow-sm',
                secondMessageEnabled ? 'left-5' : 'left-0.5'
              )}
            />
          </button>
        </div>

        {secondMessageEnabled && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-2">
                Enviar segundo mensaje despues del primero...
              </label>
              <select
                value={secondMessageDelayMinutes}
                onChange={(e) => setSecondMessageDelayMinutes(Number(e.target.value))}
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500/40"
              >
                <option value={720}>12 horas</option>
                <option value={1440}>24 horas</option>
                <option value={2880}>48 horas</option>
              </select>
            </div>

            <textarea
              value={messageTemplate2}
              onChange={(e) => setMessageTemplate2(e.target.value)}
              rows={4}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-cyan-500/40 resize-none"
              placeholder="Mensaje de segundo recordatorio..."
            />

            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <Eye className="w-3 h-3 text-zinc-600" />
                <span className="text-[10px] text-zinc-600 uppercase tracking-wide">Preview</span>
              </div>
              <div className="bg-emerald-950/30 border border-emerald-900/30 rounded-lg px-4 py-3">
                <p className="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap">
                  {interpolatePreview(messageTemplate2)}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* WhatsApp Connection */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5 space-y-5">
        <div className="flex items-center gap-2">
          <Wifi className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-white">Conexion de WhatsApp</h2>
        </div>

        {/* Mode selector */}
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setWhatsappMode('PLATFORM')}
            className={cn(
              'flex flex-col items-start gap-1 p-3 rounded-lg border text-left transition-all',
              whatsappMode === 'PLATFORM'
                ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                : 'bg-white/[0.02] border-white/[0.06] text-zinc-400 hover:text-zinc-200'
            )}
          >
            <span className="text-xs font-semibold">Numero de AutoEnvia</span>
            <span className="text-[10px] opacity-70">Los mensajes salen del numero compartido de AutoEnvia</span>
          </button>
          <button
            onClick={() => setWhatsappMode('OWN')}
            className={cn(
              'flex flex-col items-start gap-1 p-3 rounded-lg border text-left transition-all',
              whatsappMode === 'OWN'
                ? 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400'
                : 'bg-white/[0.02] border-white/[0.06] text-zinc-400 hover:text-zinc-200'
            )}
          >
            <span className="text-xs font-semibold">Mi propio numero</span>
            <span className="text-[10px] opacity-70">Conecta tu propia cuenta de WhatsApp Business API</span>
          </button>
        </div>

        {/* OWN mode credentials */}
        {whatsappMode === 'OWN' && (
          <div className="space-y-3 pt-1">
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">
                Phone Number ID
                <span className="text-zinc-600 ml-1">(de Meta Developers → WhatsApp → API Setup)</span>
              </label>
              <input
                value={whatsappPhoneNumberId}
                onChange={(e) => setWhatsappPhoneNumberId(e.target.value)}
                placeholder="Ej: 123456789012345"
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-cyan-500/40"
              />
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">
                API Token (permanente)
                {whatsappApiTokenSet && (
                  <span className="ml-2 inline-flex items-center gap-1 text-emerald-400">
                    <CheckCircle2 className="w-3 h-3" />
                    Token guardado
                  </span>
                )}
              </label>
              <input
                type="password"
                value={whatsappApiToken}
                onChange={(e) => setWhatsappApiToken(e.target.value)}
                placeholder={whatsappApiTokenSet ? 'Dejar vacio para mantener el token actual' : 'EAAxxxxxxxxxxxxxxx...'}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-cyan-500/40"
              />
              <p className="text-[10px] text-zinc-600 mt-1">
                El token se encripta con AES-256 antes de guardarse. Nunca se muestra en texto plano.
              </p>
            </div>
          </div>
        )}

        {whatsappMode === 'PLATFORM' && (
          <p className="text-xs text-zinc-500">
            AutoEnvia envia los mensajes desde su numero de WhatsApp Business.
            No necesitas configurar nada adicional.
          </p>
        )}

        {/* Test connection */}
        <div className="border-t border-white/[0.06] pt-4">
          <p className="text-xs text-zinc-400 mb-2">Probar conexion — envia un mensaje de prueba</p>
          <div className="flex items-center gap-2">
            <input
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="+59891234567"
              className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-cyan-500/40"
            />
            <button
              onClick={handleTestWhatsapp}
              disabled={testing || !testPhone.trim()}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.06] text-xs text-zinc-300 hover:text-white disabled:opacity-40 transition-all"
            >
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              Enviar prueba
            </button>
          </div>
          {testResult && (
            <p className={cn('text-xs mt-2 flex items-center gap-1.5', testResult.ok ? 'text-emerald-400' : 'text-red-400')}>
              {testResult.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
              {testResult.msg}
            </p>
          )}
        </div>
      </div>

      {/* Opt-out keyword */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
        <label className="block text-xs text-zinc-400 mb-2">
          Palabra clave para opt-out (el cliente envia esta palabra para dejar de recibir mensajes)
        </label>
        <input
          value={optOutKeyword}
          onChange={(e) => setOptOutKeyword(e.target.value.toUpperCase())}
          className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white font-mono uppercase focus:outline-none focus:border-cyan-500/40 w-40"
          maxLength={20}
        />
      </div>

      {/* Error / success */}
      {error && (
        <div className="flex items-center gap-2 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={saving}
        className={cn(
          'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold transition-all',
          saved
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
            : 'bg-cyan-500 hover:bg-cyan-400 text-white disabled:opacity-50'
        )}
      >
        {saving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Save className="w-4 h-4" />
        )}
        {saved ? 'Guardado' : saving ? 'Guardando...' : 'Guardar cambios'}
      </button>
    </div>
  );
}
