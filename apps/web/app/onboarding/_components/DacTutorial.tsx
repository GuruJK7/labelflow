'use client';

import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Info,
  ExternalLink,
  Shield,
  AlertTriangle,
} from 'lucide-react';

/**
 * In-step tutorial for DAC credentials.
 *
 * DAC is the Uruguayan postal/courier service. Most store owners already
 * have a DAC account (it's how they ship today, manually). But some don't,
 * and others are confused about which credentials to use — there are two
 * different portals.
 *
 * Key points the user needs to know:
 *   - Use credentials from `dac.com.uy/usuarios/login` (the customer portal,
 *     NOT the corporate one).
 *   - The bot logs in as them and clicks through the same shipment-creation
 *     flow they'd do manually — no API key, no SOAP integration available.
 *   - 2-factor auth is not supported by DAC's user portal (no TOTP), so we
 *     don't have to worry about that. If they have any "extra security"
 *     toggled on, point them at how to disable it.
 */
export function DacTutorial() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-5 rounded-xl border border-cyan-500/15 bg-cyan-500/[0.04] overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-cyan-500/[0.04] transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <Info className="w-4 h-4 text-cyan-400 flex-shrink-0" />
          <span className="text-sm font-medium text-white">
            ¿Qué credenciales usar y para qué?
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-zinc-500 flex-shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-zinc-500 flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-4 text-sm text-zinc-300">
          <div className="bg-zinc-900/40 border border-white/[0.04] rounded-lg p-3 leading-relaxed text-xs text-zinc-400">
            DAC no tiene API pública, así que usamos un{' '}
            <strong className="text-zinc-200">bot</strong> que inicia sesión en
            tu cuenta y completa el formulario de creación de guía igual que lo
            harías vos a mano. Necesitamos las mismas credenciales que usás para
            entrar al portal.
          </div>

          {/* Where to find creds */}
          <div>
            <h4 className="text-xs font-semibold text-white mb-2 uppercase tracking-wider">
              ¿Dónde están tus credenciales?
            </h4>
            <ol className="space-y-2.5 text-sm text-zinc-300">
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                  1
                </span>
                <div className="flex-1 leading-relaxed">
                  Andá a{' '}
                  <a
                    href="https://www.dac.com.uy/usuarios/login"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1 font-medium"
                  >
                    dac.com.uy/usuarios/login{' '}
                    <ExternalLink className="w-3 h-3" />
                  </a>{' '}
                  — el mismo portal donde generás guías a mano.
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                  2
                </span>
                <div className="flex-1 leading-relaxed">
                  Confirmá que podés iniciar sesión con esos datos. Si funciona
                  ahí, funcionan acá — usamos exactamente el mismo login.
                </div>
              </li>
              <li className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-cyan-500/15 ring-1 ring-cyan-500/30 text-cyan-300 text-xs font-semibold flex items-center justify-center">
                  3
                </span>
                <div className="flex-1 leading-relaxed">
                  Pegá usuario (cédula o RUT) y contraseña abajo. Si tu cuenta
                  tiene saldo prepago en DAC, también lo va a usar — el bot
                  trabaja sobre tu cuenta real.
                </div>
              </li>
            </ol>
          </div>

          {/* No account */}
          <div>
            <h4 className="text-xs font-semibold text-white mb-2 uppercase tracking-wider">
              ¿No tenés cuenta DAC todavía?
            </h4>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Registrate primero en{' '}
              <a
                href="https://www.dac.com.uy/usuarios/registro"
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1 font-medium"
              >
                dac.com.uy/usuarios/registro{' '}
                <ExternalLink className="w-3 h-3" />
              </a>
              . Es gratis, te toma 2 minutos, y volvés acá con tus datos. (Si tu
              negocio ya tiene cuenta corporativa, usá esas credenciales — no
              hace falta crear una nueva.)
            </p>
          </div>

          {/* Common gotchas */}
          <div className="flex items-start gap-2 text-xs leading-relaxed bg-amber-500/[0.06] border border-amber-500/20 rounded-lg p-3">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="text-amber-100">
              <p className="font-medium mb-1">Errores comunes:</p>
              <ul className="space-y-0.5 text-amber-200/80 list-disc list-inside marker:text-amber-500/60">
                <li>Usar el portal corporativo en vez del de usuarios.</li>
                <li>Tener mayúsculas/minúsculas distintas en el RUT.</li>
                <li>
                  Cuenta nueva sin verificar el mail — DAC bloquea el login
                  hasta que confirmes.
                </li>
              </ul>
            </div>
          </div>

          {/* Security */}
          <div className="flex items-start gap-2 text-[11px] text-zinc-500 leading-relaxed bg-black/20 border border-white/[0.04] rounded-lg p-3">
            <Shield className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0 mt-0.5" />
            <span>
              Guardamos usuario y contraseña cifrados con AES-256. Sólo se
              descifran dentro del worker para iniciar sesión, nunca se loguean
              en texto plano. Podés cambiarlas o borrarlas cuando quieras desde{' '}
              <span className="text-zinc-300 font-medium">Configuración</span>.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
