'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { CURRENCIES, DEFAULT_CURRENCY, isCurrency, type Currency } from '@/lib/pricing';

/**
 * Selector de moneda de LECTURA: USD o UYU.
 *
 * No cambia lo que se cobra. La escalera está denominada en dólares (D35) y
 * MercadoPago cobra en pesos siempre; esto elige en qué moneda el comerciante
 * LEE los números. Los pesos que muestra salen de `formatTotalPrice`, que usa
 * la misma conversión a peso entero que el checkout: lo que se lee acá es lo
 * que se va a pagar, no una estimación paralela.
 *
 * DÓNDE VIVE Y POR QUÉ. En `app/_components/` y no en la carpeta de billing
 * porque lo consumen dos pantallas de dueños distintos: la de compra del
 * dashboard y la landing (rama `feat/landing-v2`, PR #13). El componente no
 * sabe nada de packs ni de tenants — recibe el valor y devuelve el nuevo — así
 * que se puede montar en cualquiera de las dos sin arrastrar dependencias.
 */

/**
 * Clave de localStorage. Estable a propósito: si cambia, todo el mundo vuelve
 * al default y pierde su elección sin entender por qué.
 */
export const CURRENCY_STORAGE_KEY = 'autoenvia.currency';

/**
 * El `Storage` del navegador, o `null` si no hay.
 *
 * `window.localStorage` no es sólo "undefined en el server": el ACCESO MISMO
 * tira en Safari con cookies bloqueadas y en algunos modos privados, antes de
 * llamar a ningún método. Por eso el try/catch envuelve el acceso a la
 * propiedad y no sólo la lectura del valor.
 */
function browserStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * La moneda guardada, o el default. Nunca tira.
 *
 * Puro y exportado para poder probarlo sin DOM: se le pasa cualquier objeto con
 * `getItem`, incluido uno que explote, y tiene que seguir devolviendo una
 * moneda válida. Un valor basura en localStorage (otra versión de la app, o
 * alguien editándolo a mano) cae al default en vez de romper la pantalla.
 */
export function readStoredCurrency(
  storage: Pick<Storage, 'getItem'> | null = browserStorage(),
): Currency {
  try {
    const raw = storage?.getItem(CURRENCY_STORAGE_KEY);
    return isCurrency(raw) ? raw : DEFAULT_CURRENCY;
  } catch {
    return DEFAULT_CURRENCY;
  }
}

/**
 * Guarda la elección. Nunca tira: en modo privado o con la cuota llena, la
 * elección vale para esta sesión y se pierde al recargar. Perder la preferencia
 * es molesto; romper la pantalla de compra por eso, no.
 */
export function writeStoredCurrency(
  currency: Currency,
  storage: Pick<Storage, 'setItem'> | null = browserStorage(),
): void {
  try {
    storage?.setItem(CURRENCY_STORAGE_KEY, currency);
  } catch {
    /* sin persistencia: la elección vive lo que dure la pestaña */
  }
}

/**
 * Estado de la moneda elegida, persistido.
 *
 * 🔴 EL PRIMER RENDER SIEMPRE ES EL DEFAULT, y recién después se lee
 * localStorage. Es a propósito: el HTML lo pinta el server, donde no hay
 * localStorage, así que leerlo durante el render haría que el server escriba
 * UYU y el cliente hidrate USD — mismatch de hidratación, que en React 18
 * descarta el árbol y vuelve a renderizar todo del lado del cliente. Un frame
 * en pesos es más barato que eso.
 */
export function useCurrency(): [Currency, (next: Currency) => void] {
  const [currency, setCurrencyState] = useState<Currency>(DEFAULT_CURRENCY);

  useEffect(() => {
    setCurrencyState(readStoredCurrency());
  }, []);

  const setCurrency = useCallback((next: Currency) => {
    setCurrencyState(next);
    writeStoredCurrency(next);
  }, []);

  return [currency, setCurrency];
}

export interface CurrencyToggleProps {
  value: Currency;
  onChange: (next: Currency) => void;
  /** Nombre del grupo para lectores de pantalla. */
  label?: string;
  className?: string;
}

/**
 * Los dos botones.
 *
 * ACCESIBILIDAD: es un `radiogroup` de verdad, no dos botones sueltos. Un
 * lector de pantalla anuncia "Moneda, grupo de opciones, USD, 1 de 2" en vez de
 * dos botones sin relación. Con tabindex rotativo (sólo el seleccionado es
 * tabulable) el grupo entero es UNA parada de Tab, y adentro se navega con las
 * flechas —también Home/End—, que es lo que un usuario de teclado espera de un
 * grupo de opciones. El foco viaja con la selección: sin eso, la flecha cambia
 * la opción y deja el foco en un elemento que ya no es tabulable.
 */
export function CurrencyToggle({
  value,
  onChange,
  label = 'Moneda',
  className,
}: CurrencyToggleProps) {
  const botones = useRef<Array<HTMLButtonElement | null>>([]);

  function mover(indice: number) {
    onChange(CURRENCIES[indice]);
    botones.current[indice]?.focus();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const actual = CURRENCIES.indexOf(value);
    const ultimo = CURRENCIES.length - 1;
    let destino: number | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      destino = actual === ultimo ? 0 : actual + 1;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      destino = actual === 0 ? ultimo : actual - 1;
    } else if (e.key === 'Home') {
      destino = 0;
    } else if (e.key === 'End') {
      destino = ultimo;
    }
    if (destino === null) return;
    e.preventDefault(); // las flechas no scrollean la página adentro del grupo
    mover(destino);
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-xl border border-white/[0.08] bg-zinc-950/60 p-0.5',
        className,
      )}
    >
      {CURRENCIES.map((moneda, i) => {
        const activo = moneda === value;
        return (
          <button
            key={moneda}
            ref={(el) => {
              botones.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={activo}
            tabIndex={activo ? 0 : -1}
            onClick={() => onChange(moneda)}
            className={cn(
              'px-3 py-1.5 rounded-[10px] text-xs font-semibold tracking-wide transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50',
              activo
                ? 'bg-cyan-500 text-zinc-950 shadow-lg shadow-cyan-500/20'
                : 'text-zinc-400 hover:text-white',
            )}
          >
            {moneda}
          </button>
        );
      })}
    </div>
  );
}
