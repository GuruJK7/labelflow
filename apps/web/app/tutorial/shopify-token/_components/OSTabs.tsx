'use client';

import { useState, useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * OS-aware content switcher for the Shopify token tutorial.
 *
 * Several steps in this flow have OS-specific commands (file paths, kill-port
 * recipes, verify scripts). Rather than dump three blocks one after another
 * — which makes the page noisy and the wrong-OS commands a copy/paste trap
 * — this component shows one OS at a time behind a tab strip.
 *
 * On mount we sniff `navigator.userAgent` to pre-select the user's OS so the
 * default state already matches their machine. The user can still flip tabs
 * manually (e.g. SSH'd from Mac into a Linux box, or Linux dev with a
 * Windows colleague reading over their shoulder).
 *
 * SSR safety: `useState` defaults to 'mac' (most common in our user base);
 * detection runs in `useEffect`, so server-rendered HTML stays deterministic
 * and the first client paint corrects to the real OS.
 */

type OS = 'mac' | 'linux' | 'windows';

const TABS: { value: OS; label: string }[] = [
  { value: 'mac', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
  { value: 'windows', label: 'Windows' },
];

function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'mac';
  const ua = navigator.userAgent.toLowerCase();
  // Order matters: Mac UA strings sometimes contain "linux"-shaped tokens
  // through embedded webviews; check Mac first.
  if (/mac|iphone|ipad|ipod/.test(ua)) return 'mac';
  if (/win/.test(ua)) return 'windows';
  if (/linux|x11|cros/.test(ua)) return 'linux';
  return 'mac';
}

export function OSTabs({
  mac,
  linux,
  windows,
  className,
}: {
  mac: ReactNode;
  linux: ReactNode;
  windows: ReactNode;
  className?: string;
}) {
  const [os, setOS] = useState<OS>('mac');

  useEffect(() => {
    setOS(detectOS());
  }, []);

  const content: Record<OS, ReactNode> = { mac, linux, windows };

  return (
    <div className={cn('w-full', className)}>
      <div
        role="tablist"
        aria-label="Sistema operativo"
        className="flex gap-1 border-b border-white/[0.08] mb-3"
      >
        {TABS.map((tab) => {
          const active = os === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setOS(tab.value)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-t-md transition-colors -mb-px',
                active
                  ? 'text-cyan-300 bg-cyan-500/10 border-b-2 border-cyan-400 font-semibold'
                  : 'text-zinc-500 hover:text-zinc-300 border-b-2 border-transparent',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">{content[os]}</div>
    </div>
  );
}
