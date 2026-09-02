'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Save, Loader2, CheckCircle, Search, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/cn';
import { processingModeFromCron, type ProcessingMode, type StoreKind } from '@/lib/onboarding-state';
import { ModoProcesamiento, saveProcessingMode, type SelectableMode } from './ModoProcesamiento';

/**
 * Parámetros de envío explicados (D33, paso 4 del wizard y Configuración >
 * Parámetros). Cada bloque dice qué hace, para quién es y un ejemplo, y se
 * guarda solo (`PUT /api/v1/settings`; las reglas de envío gratis por
 * `POST /api/v1/shipping-rules`). Todo tiene un valor por defecto que
 * funciona: el usuario puede seguir sin tocar nada.
 *
 * Sólo lo que el producto YA hace (spec §6.4): no hay filtro por SKU exacto,
 * ni "siempre paga la tienda", ni WhatsApp al cliente, ni contrareembolso por
 * pedido. Lo que es sólo del admin (slots, reparto propio, impresión, API
 * key) no vive acá.
 *
 * `compact`: dentro del wizard no se muestra el bloque de modo (es el paso 5).
 */
interface SettingsDTO {
  paymentThreshold: number;
  paymentRuleEnabled: boolean;
  consolidateConsecutiveOrders: boolean;
  consolidationWindowMinutes: number;
  allowedProductTypes: string[] | null;
  productTypeCache: unknown;
  fulfillMode: 'off' | 'on' | 'always' | string;
  skuInObservations: boolean;
  codEnabled?: boolean;
  emailHost: string | null;
  emailPort: number | null;
  emailUser: string | null;
  emailPassSet: boolean;
  emailFrom: string | null;
  storeName: string | null;
  orderSortDirection: string;
  cronSchedule: string;
}

interface Producto {
  id: string;
  title: string;
  type: string;
  vendor: string;
}

type Msg = { type: 'ok' | 'error'; text: string } | null;

export function ParametrosForm({
  compact = false,
  storeKind,
  onSaved,
}: {
  compact?: boolean;
  storeKind: StoreKind;
  onSaved?: (block: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState('');
  const [msgs, setMsgs] = useState<Record<string, Msg>>({});

  // 1. Modo (sólo Configuración)
  const [currentMode, setCurrentMode] = useState<ProcessingMode>('inmediato');
  const [modeChoice, setModeChoice] = useState<SelectableMode | null>(null);
  // 2. Quién paga
  const [paymentRuleEnabled, setPaymentRuleEnabled] = useState(false);
  const [paymentThreshold, setPaymentThreshold] = useState(4000);
  // 3. Reglas de envío gratis
  const [rulesCount, setRulesCount] = useState<number | null>(null);
  const [ruleMonto, setRuleMonto] = useState(3000);
  const [ruleItems, setRuleItems] = useState(3);
  const [ruleTag, setRuleTag] = useState('vip');
  // 4. Pedidos seguidos
  const [consolidate, setConsolidate] = useState(false);
  const [consolidateMin, setConsolidateMin] = useState(30);
  // 5. Productos
  const [allowed, setAllowed] = useState<string[]>([]);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [scanning, setScanning] = useState(false);
  // 6. Preparado en Shopify
  const [fulfillMode, setFulfillMode] = useState<'off' | 'on' | 'always'>('on');
  // 7. SKU
  const [skuInObservations, setSkuInObservations] = useState(false);
  // 8. Contrareembolso
  const [codEnabled, setCodEnabled] = useState(false);
  // 9. Email
  const [emailHost, setEmailHost] = useState('');
  const [emailPort, setEmailPort] = useState(587);
  const [emailUser, setEmailUser] = useState('');
  const [emailPass, setEmailPass] = useState('');
  const [emailPassSet, setEmailPassSet] = useState(false);
  const [emailFrom, setEmailFrom] = useState('');
  const [storeName, setStoreName] = useState('');
  // 10. Orden
  const [orderSort, setOrderSort] = useState<'oldest_first' | 'newest_first'>('oldest_first');

  const loadRulesCount = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/shipping-rules');
      if (!r.ok) return;
      const { data } = await r.json();
      if (Array.isArray(data)) setRulesCount(data.filter((x: { isActive?: boolean }) => x.isActive !== false).length);
    } catch {
      // se muestra sin contador
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/v1/settings');
        const { data } = (await r.json()) as { data?: SettingsDTO };
        if (!r.ok || !data) throw new Error('settings');
        if (cancelled) return;
        const mode = processingModeFromCron(data.cronSchedule);
        setCurrentMode(mode);
        setModeChoice(mode === 'personalizado' ? null : mode);
        setPaymentRuleEnabled(!!data.paymentRuleEnabled);
        setPaymentThreshold(Number(data.paymentThreshold) || 4000);
        setConsolidate(!!data.consolidateConsecutiveOrders);
        setConsolidateMin(Number(data.consolidationWindowMinutes) || 30);
        const stored = Array.isArray(data.allowedProductTypes) ? data.allowedProductTypes : [];
        setAllowed(stored);
        setProductos(normalizeProductCache(data.productTypeCache, stored));
        setFulfillMode(data.fulfillMode === 'off' || data.fulfillMode === 'always' ? data.fulfillMode : 'on');
        setSkuInObservations(!!data.skuInObservations);
        setCodEnabled(!!data.codEnabled);
        setEmailHost(data.emailHost ?? '');
        setEmailPort(data.emailPort ?? 587);
        setEmailUser(data.emailUser ?? '');
        setEmailPassSet(!!data.emailPassSet);
        setEmailFrom(data.emailFrom ?? '');
        setStoreName(data.storeName ?? '');
        setOrderSort(data.orderSortDirection === 'newest_first' ? 'newest_first' : 'oldest_first');
        setLoaded(true);
      } catch {
        if (!cancelled) setLoadError('No pudimos cargar tus parámetros. Recargá la página.');
      }
    })();
    void loadRulesCount();
    return () => {
      cancelled = true;
    };
  }, [loadRulesCount]);

  function flash(block: string, m: Msg) {
    setMsgs((prev) => ({ ...prev, [block]: m }));
    if (m) setTimeout(() => setMsgs((prev) => (prev[block] === m ? { ...prev, [block]: null } : prev)), m.type === 'ok' ? 4000 : 7000);
  }

  async function save(block: string, body: Record<string, unknown>) {
    setSaving(block);
    try {
      const res = await fetch('/api/v1/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        flash(block, { type: 'ok', text: 'Guardado' });
        onSaved?.(block);
      } else {
        flash(block, { type: 'error', text: data.error ?? 'No se pudo guardar' });
      }
    } catch {
      flash(block, { type: 'error', text: 'Error de conexión. Probá de nuevo.' });
    } finally {
      setSaving('');
    }
  }

  async function saveMode() {
    if (!modeChoice) return;
    setSaving('modo');
    const r = await saveProcessingMode(modeChoice);
    setSaving('');
    if (r.ok) {
      setCurrentMode(modeChoice);
      flash('modo', { type: 'ok', text: 'Guardado' });
      onSaved?.('modo');
    } else {
      flash('modo', { type: 'error', text: r.error ?? 'No se pudo guardar' });
    }
  }

  async function createRule(block: string, rule: { name: string; ruleType: string; config: Record<string, unknown>; priority: number }) {
    setSaving(block);
    try {
      const res = await fetch('/api/v1/shipping-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...rule, isActive: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        flash(block, { type: 'ok', text: 'Regla creada' });
        await loadRulesCount();
        onSaved?.(block);
      } else {
        flash(block, { type: 'error', text: data.error ?? 'No se pudo crear la regla' });
      }
    } catch {
      flash(block, { type: 'error', text: 'Error de conexión. Probá de nuevo.' });
    } finally {
      setSaving('');
    }
  }

  async function scanProducts() {
    setScanning(true);
    try {
      const res = await fetch('/api/v1/products/scan', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const list = (data?.data?.products ?? []) as Producto[];
        setProductos(mergeStored(list, allowed));
        flash('productos', { type: 'ok', text: `${list.length} productos encontrados` });
      } else {
        flash('productos', { type: 'error', text: data.error ?? 'No se pudo leer la tienda' });
      }
    } catch {
      flash('productos', { type: 'error', text: 'Error de conexión. Probá de nuevo.' });
    } finally {
      setScanning(false);
    }
  }

  if (loadError) {
    return <p className="text-sm text-red-300">{loadError}</p>;
  }
  if (!loaded) {
    return (
      <div className="flex items-center gap-2 text-sm text-zinc-500 py-6">
        <Loader2 className="w-4 h-4 animate-spin" /> Cargando tus parámetros…
      </div>
    );
  }

  const esShopify = storeKind === 'shopify';
  const avisoRemitente =
    'Los envíos que te tocan pagar a vos no se cargan solos: te dejamos una nota en el pedido de Shopify con el monto y lo cargás vos en DAC. Los que paga el cliente salen automáticos.';

  return (
    <div className={cn('space-y-5', compact && 'space-y-4')}>
      {!compact && (
        <Bloque
          id="modo"
          title="Cómo se procesan"
          que="Cada cuánto miramos tu tienda y generamos las guías."
          paraQuien="Para todas las tiendas. Inmediato es lo normal; Cada hora sirve si querés revisar antes de que salgan."
          ejemplo="Con Inmediato, un pedido pago a las 10:03 sale a las 10:03 (o a las 10:15 como mucho). Con Cada hora, sale a las 11:00."
          footer={
            <SaveRow
              label="Guardar modo"
              busy={saving === 'modo'}
              disabled={!modeChoice || modeChoice === currentMode}
              onClick={saveMode}
              msg={msgs.modo}
            />
          }
        >
          <ModoProcesamiento value={modeChoice} currentMode={currentMode} storeKind={storeKind} onChange={setModeChoice} />
        </Bloque>
      )}

      <Bloque
        id="quien-paga"
        title="Quién paga el envío"
        que="Define si el envío lo paga tu cliente al recibir (DAC lo cobra en la puerta) o lo pagás vos."
        paraQuien="Para tiendas que absorben el envío en compras grandes."
        ejemplo="Con umbral $4.000: un pedido de $5.200 lo pagás vos; uno de $2.900 lo paga el cliente."
        aviso={avisoRemitente}
        footer={
          <SaveRow
            label="Guardar"
            busy={saving === 'quien-paga'}
            disabled={paymentRuleEnabled && !(paymentThreshold > 0)}
            disabledHint={paymentRuleEnabled && !(paymentThreshold > 0) ? 'Poné un monto mayor a 0' : undefined}
            onClick={() => save('quien-paga', { paymentRuleEnabled, paymentThreshold })}
            msg={msgs['quien-paga']}
          />
        }
      >
        <Toggle
          checked={paymentRuleEnabled}
          onChange={setPaymentRuleEnabled}
          label="Yo pago el envío cuando el pedido supera un monto"
          hint={paymentRuleEnabled ? 'Por encima del monto lo pagás vos; por debajo, el cliente al recibir.' : 'Apagado: todos los envíos los paga el cliente al recibir.'}
        />
        {paymentRuleEnabled && (
          <div className="mt-3">
            <label className={labelClass}>Monto (UYU)</label>
            <input
              type="number"
              min={1}
              value={paymentThreshold}
              onChange={(e) => setPaymentThreshold(Number(e.target.value))}
              className={cn(inputClass, 'max-w-xs')}
            />
          </div>
        )}
      </Bloque>

      <Bloque
        id="envio-gratis"
        title="Envío gratis por reglas"
        que="Reglas que marcan un pedido como 'lo paga la tienda'. Gana la primera que coincide."
        paraQuien="Para promociones: envío gratis a partir de un monto, de una cantidad de productos, o para clientes marcados en Shopify."
        ejemplo="Con $3.000, un pedido de $3.500 sale gratis para el cliente. Con 3 productos, un pedido de 3 o más ítems sale gratis."
        aviso={avisoRemitente}
        footer={
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-zinc-500">
              {rulesCount === null ? 'Reglas activas: —' : `Reglas activas: ${rulesCount}`}
            </p>
            <a href="/settings/shipping-rules" className="text-xs text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1">
              Ver todas las reglas <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        }
      >
        <div className="space-y-3">
          <Atajo
            label="Envío gratis a partir de $"
            input={
              <input type="number" min={1} value={ruleMonto} onChange={(e) => setRuleMonto(Number(e.target.value))} className={cn(inputClass, 'w-32 py-2')} />
            }
            busy={saving === 'regla-monto'}
            disabled={!(ruleMonto > 0)}
            onClick={() =>
              createRule('regla-monto', {
                name: `Envío gratis a partir de $${ruleMonto}`,
                ruleType: 'THRESHOLD_TOTAL',
                config: { minTotalUyu: ruleMonto },
                priority: 100,
              })
            }
            msg={msgs['regla-monto']}
          />
          <Atajo
            label="Envío gratis a partir de"
            suffix="productos"
            input={
              <input type="number" min={1} max={100} value={ruleItems} onChange={(e) => setRuleItems(Number(e.target.value))} className={cn(inputClass, 'w-24 py-2')} />
            }
            busy={saving === 'regla-items'}
            disabled={!(ruleItems >= 1)}
            onClick={() =>
              createRule('regla-items', {
                name: `Envío gratis desde ${ruleItems} productos`,
                ruleType: 'ITEM_COUNT',
                config: { minItems: ruleItems },
                priority: 80,
              })
            }
            msg={msgs['regla-items']}
          />
          <Atajo
            label="Envío gratis para clientes con la etiqueta"
            suffix="en Shopify"
            input={<input value={ruleTag} onChange={(e) => setRuleTag(e.target.value)} className={cn(inputClass, 'w-32 py-2')} placeholder="vip" />}
            busy={saving === 'regla-tag'}
            disabled={!esShopify || !ruleTag.trim()}
            onClick={() =>
              createRule('regla-tag', {
                name: `Clientes con etiqueta "${ruleTag.trim()}"`,
                ruleType: 'CUSTOMER_TAG',
                config: { tag: ruleTag.trim() },
                priority: 10,
              })
            }
            msg={msgs['regla-tag']}
            note={
              esShopify
                ? 'Marcás al cliente en Shopify y sus envíos salen gratis. Si conectaste con la app pública, las etiquetas del cliente no llegan: usá etiquetas del pedido.'
                : 'Sólo tiendas Shopify.'
            }
          />
        </div>
      </Bloque>

      <Bloque
        id="pedidos-seguidos"
        title="Pedidos seguidos del mismo cliente"
        que="Si el mismo cliente compra dos veces en pocos minutos, el segundo envío lo pagás vos (para no cobrarle dos envíos)."
        paraQuien="Para tiendas donde el cliente suele volver a comprar enseguida porque se olvidó algo."
        ejemplo="Ventana de 30 minutos: compra a las 10:00 y otra vez a las 10:20, el segundo va como pagado por la tienda."
        footer={
          <SaveRow
            label="Guardar"
            busy={saving === 'pedidos-seguidos'}
            disabled={consolidate && !(consolidateMin >= 1 && consolidateMin <= 1440)}
            onClick={() => save('pedidos-seguidos', { consolidateConsecutiveOrders: consolidate, consolidationWindowMinutes: consolidateMin })}
            msg={msgs['pedidos-seguidos']}
          />
        }
      >
        <Toggle checked={consolidate} onChange={setConsolidate} label="Juntar pedidos seguidos del mismo cliente" hint={consolidate ? `Ventana de ${consolidateMin} minutos.` : 'Apagado: cada pedido se evalúa por separado.'} />
        {consolidate && (
          <div className="mt-3">
            <label className={labelClass}>Minutos (1 a 1440)</label>
            <input type="number" min={1} max={1440} value={consolidateMin} onChange={(e) => setConsolidateMin(Number(e.target.value))} className={cn(inputClass, 'max-w-xs')} />
          </div>
        )}
      </Bloque>

      <Bloque
        id="productos"
        title="Qué productos se envían"
        que="Elegí qué productos se despachan con DAC. Lo que no está en la lista se ignora (no se crea guía ni se gasta un envío)."
        paraQuien="Tiendas que venden también productos digitales, retiros en local o cosas que mandan por otro lado."
        ejemplo="Marcás 'Remeras' y 'Buzos'; un pedido de 'Gift card' no se procesa."
        aviso="Se compara contra el título, el tipo y el proveedor del producto. No hay filtro por SKU exacto."
        footer={
          <SaveRow
            label="Guardar"
            busy={saving === 'productos'}
            onClick={() => save('productos', { allowedProductTypes: allowed.length > 0 ? allowed : null })}
            msg={msgs.productos}
          />
        }
      >
        <div className="flex items-center justify-between gap-3 mb-2">
          <p className="text-xs text-zinc-500">{allowed.length === 0 ? 'Sin filtro: se envía todo.' : `Sólo se envían: ${allowed.join(', ')}`}</p>
          {esShopify ? (
            <button type="button" onClick={scanProducts} disabled={scanning} className="inline-flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 disabled:opacity-50 flex-shrink-0">
              {scanning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
              {scanning ? 'Buscando…' : 'Buscar tipos en mi tienda'}
            </button>
          ) : (
            <span className="text-[11px] text-zinc-600">La búsqueda automática es sólo para Shopify.</span>
          )}
        </div>
        {productos.length === 0 ? (
          <div className="bg-white/[0.02] border border-dashed border-white/[0.08] rounded-lg p-4 text-center">
            <p className="text-xs text-zinc-500">Todavía no hay productos cargados.</p>
            {esShopify && <p className="text-[11px] text-zinc-600 mt-1">Tocá "Buscar tipos en mi tienda" para traerlos desde Shopify.</p>}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {productos.map((p) => {
              const label = p.title || p.type || p.vendor || p.id;
              const on = allowed.includes(label);
              const sub = [p.type, p.vendor].filter(Boolean).join(' · ');
              return (
                <button
                  key={p.id}
                  type="button"
                  title={sub || undefined}
                  onClick={() => setAllowed((prev) => (on ? prev.filter((t) => t !== label) : [...prev, label]))}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-xs font-medium border transition-all max-w-[260px] truncate',
                    on ? 'bg-cyan-600/20 text-cyan-300 border-cyan-500/30' : 'bg-white/[0.03] text-zinc-500 border-white/[0.06] hover:text-zinc-300 hover:border-white/[0.15]',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
      </Bloque>

      <Bloque
        id="preparado"
        title="Marcar como Preparado en Shopify"
        que="Después de crear la guía, marcamos el pedido como Preparado en Shopify y le agregamos la guía."
        paraQuien="Para tiendas Shopify que quieren el estado del pedido al día sin tocarlo a mano."
        ejemplo="Sale la guía 12345678 y el pedido #1042 pasa a Preparado con ese número de seguimiento."
        aviso={!esShopify ? 'No aplica al Dashboard con Excel.' : undefined}
        footer={<SaveRow label="Guardar" busy={saving === 'preparado'} disabled={!esShopify} onClick={() => save('preparado', { fulfillMode })} msg={msgs.preparado} />}
      >
        <div className={cn('flex flex-wrap gap-2', !esShopify && 'opacity-50 pointer-events-none')}>
          {(
            [
              { v: 'off', l: 'No' },
              { v: 'on', l: 'Sí, si el pedido lo permite' },
              { v: 'always', l: 'Siempre' },
            ] as const
          ).map((o) => (
            <Chip key={o.v} active={fulfillMode === o.v} onClick={() => setFulfillMode(o.v)}>
              {o.l}
            </Chip>
          ))}
        </div>
        {fulfillMode === 'always' && esShopify && (
          <p className="text-[11px] text-zinc-500 mt-2">"Siempre" fuerza Preparado aunque el pedido tenga partes sin enviar.</p>
        )}
      </Bloque>

      <Bloque
        id="sku"
        title="SKU en la guía"
        que="Escribe los SKU del pedido en 'Observaciones' de la guía de DAC, para armar el paquete mirando la etiqueta."
        paraQuien="Para quien prepara los paquetes leyendo la etiqueta, sin abrir la tienda."
        ejemplo="SKU: REM-M-AZUL x2, BUZ-L-NEG x1"
        footer={<SaveRow label="Guardar" busy={saving === 'sku'} onClick={() => save('sku', { skuInObservations })} msg={msgs.sku} />}
      >
        <Toggle checked={skuInObservations} onChange={setSkuInObservations} label="Escribir los SKU en la guía" hint={skuInObservations ? 'Los SKU van en Observaciones.' : 'Apagado: la guía no lleva SKU.'} />
      </Bloque>

      <Bloque
        id="contrareembolso"
        title="Contrareembolso"
        que="DAC le cobra al cliente el valor de la compra al entregar y te lo gira. La guía sale como 'Contrareembolso' con el total del pedido."
        paraQuien="Tiendas que venden contra entrega."
        ejemplo="Pedido de $2.500: DAC cobra $2.500 en la puerta y te los transfiere."
        aviso="Se aplica a todos los pedidos de la tienda mientras esté prendido; no hay selección por pedido. El monto es el total del pedido, redondeado."
        footer={<SaveRow label="Guardar" busy={saving === 'contrareembolso'} onClick={() => save('contrareembolso', { codEnabled })} msg={msgs.contrareembolso} />}
      >
        <Toggle checked={codEnabled} onChange={setCodEnabled} label="Cobrar el pedido al entregar (contrareembolso)" hint={codEnabled ? 'Todas las guías salen como contrareembolso.' : 'Apagado: las guías salen sin cobro en la entrega.'} />
      </Bloque>

      <Bloque
        id="email"
        title="Aviso al cliente por email"
        que="Cuando sale la guía, le mandamos un email a tu cliente con el número de seguimiento, desde tu propia casilla."
        paraQuien="Tiendas que quieren avisar sin depender de Shopify."
        ejemplo="Gmail: servidor smtp.gmail.com, puerto 587, tu usuario y una contraseña de aplicación."
        aviso="Se manda sólo si cargás servidor, usuario y contraseña. Para apagarlo, dejalos vacíos."
        footer={
          <SaveRow
            label="Guardar"
            busy={saving === 'email'}
            onClick={() =>
              save('email', {
                ...(emailHost ? { emailHost } : {}),
                emailPort,
                ...(emailUser ? { emailUser } : {}),
                ...(emailPass ? { emailPass } : {}),
                ...(emailFrom ? { emailFrom } : {}),
                storeName,
              })
            }
            msg={msgs.email}
          />
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Servidor SMTP</label>
            <input value={emailHost} onChange={(e) => setEmailHost(e.target.value)} className={inputClass} placeholder="smtp.gmail.com" />
          </div>
          <div>
            <label className={labelClass}>Puerto</label>
            <input type="number" value={emailPort} onChange={(e) => setEmailPort(Number(e.target.value))} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Usuario</label>
            <input value={emailUser} onChange={(e) => setEmailUser(e.target.value)} className={inputClass} placeholder="tienda@gmail.com" autoComplete="off" />
          </div>
          <div>
            <label className={labelClass}>Contraseña</label>
            <input type="password" value={emailPass} onChange={(e) => setEmailPass(e.target.value)} className={inputClass} placeholder={emailPassSet ? '********' : 'Contraseña de aplicación'} autoComplete="new-password" />
          </div>
          <div>
            <label className={labelClass}>Remitente (De)</label>
            <input value={emailFrom} onChange={(e) => setEmailFrom(e.target.value)} className={inputClass} placeholder="Mi Tienda <hola@mitienda.uy>" />
          </div>
          <div>
            <label className={labelClass}>Nombre de la tienda</label>
            <input value={storeName} onChange={(e) => setStoreName(e.target.value)} className={inputClass} placeholder="Mi Tienda" />
          </div>
        </div>
      </Bloque>

      <Bloque
        id="orden"
        title="Orden de procesamiento"
        que="Qué pedidos salen primero cuando hay varios pendientes."
        paraQuien="Para todas las tiendas; casi siempre conviene el más antiguo primero."
        ejemplo="Con 'Más antiguos primero', el pedido de ayer sale antes que el de hoy."
        footer={<SaveRow label="Guardar" busy={saving === 'orden'} onClick={() => save('orden', { orderSortDirection: orderSort })} msg={msgs.orden} />}
      >
        <div className="flex flex-wrap gap-2">
          <Chip active={orderSort === 'oldest_first'} onClick={() => setOrderSort('oldest_first')}>Más antiguos primero</Chip>
          <Chip active={orderSort === 'newest_first'} onClick={() => setOrderSort('newest_first')}>Más recientes primero</Chip>
        </div>
      </Bloque>
    </div>
  );
}

/* ─── Piezas ───────────────────────────────────────────────────────────── */

const inputClass =
  'w-full px-3.5 py-2.5 bg-white/[0.03] border border-white/[0.08] rounded-lg text-white text-sm placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30 transition-colors';
const labelClass = 'block text-xs font-medium text-zinc-400 mb-1.5';

function Bloque({
  id,
  title,
  que,
  paraQuien,
  ejemplo,
  aviso,
  children,
  footer,
}: {
  id: string;
  title: string;
  que: string;
  paraQuien: string;
  ejemplo: string;
  aviso?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section id={`param-${id}`} className="scroll-mt-24 bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
      <h3 className="text-sm font-semibold text-white">{title}</h3>
      <dl className="mt-2 space-y-1 text-xs leading-relaxed">
        <div className="flex gap-2">
          <dt className="text-zinc-500 w-20 flex-shrink-0">Qué hace</dt>
          <dd className="text-zinc-300">{que}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-zinc-500 w-20 flex-shrink-0">Para quién</dt>
          <dd className="text-zinc-300">{paraQuien}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-zinc-500 w-20 flex-shrink-0">Ejemplo</dt>
          <dd className="text-zinc-400">{ejemplo}</dd>
        </div>
      </dl>
      {aviso && <p className="mt-3 px-3 py-2 rounded-lg bg-cyan-500/[0.05] border border-cyan-500/20 text-[11px] text-cyan-100/80 leading-relaxed">{aviso}</p>}
      <div className="mt-4">{children}</div>
      {footer && <div className="mt-4 pt-3 border-t border-white/[0.06]">{footer}</div>}
    </section>
  );
}

function SaveRow({
  label,
  busy,
  disabled,
  disabledHint,
  onClick,
  msg,
}: {
  label: string;
  busy: boolean;
  disabled?: boolean;
  disabledHint?: string;
  onClick: () => void;
  msg?: Msg;
}) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button
        type="button"
        onClick={onClick}
        disabled={busy || disabled}
        className="inline-flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-4 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} {label}
      </button>
      {disabledHint && <span className="text-xs text-amber-300/80">{disabledHint}</span>}
      {msg && (
        <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium animate-fade-in', msg.type === 'ok' ? 'text-emerald-400' : 'text-red-400')}>
          {msg.type === 'ok' && <CheckCircle className="w-3.5 h-3.5" />}
          {msg.text}
        </span>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
      <div className="min-w-0">
        <p className="text-sm text-white font-medium">{label}</p>
        {hint && <p className="text-[11px] text-zinc-500 mt-0.5">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn('relative shrink-0 w-11 h-6 rounded-full transition-colors duration-200', checked ? 'bg-cyan-600' : 'bg-zinc-700')}
      >
        <span className={cn('absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200', checked ? 'translate-x-5' : 'translate-x-0')} />
      </button>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-4 py-2 rounded-lg text-xs font-medium border transition-all',
        active ? 'bg-cyan-600 border-cyan-500 text-white' : 'bg-white/[0.03] border-white/[0.06] text-zinc-400 hover:text-white hover:border-white/[0.15]',
      )}
    >
      {children}
    </button>
  );
}

function Atajo({
  label,
  suffix,
  input,
  busy,
  disabled,
  onClick,
  msg,
  note,
}: {
  label: string;
  suffix?: string;
  input: ReactNode;
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
  msg?: Msg;
  note?: string;
}) {
  return (
    <div className="p-3 rounded-lg bg-white/[0.02] border border-white/[0.04]">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-zinc-200">{label}</span>
        {input}
        {suffix && <span className="text-sm text-zinc-200">{suffix}</span>}
        <button
          type="button"
          onClick={onClick}
          disabled={busy || disabled}
          className="ml-auto inline-flex items-center gap-1.5 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Crear regla
        </button>
      </div>
      {note && <p className="text-[11px] text-zinc-500 mt-2 leading-relaxed">{note}</p>}
      {msg && (
        <p className={cn('text-xs mt-2 font-medium', msg.type === 'ok' ? 'text-emerald-400' : 'text-red-400')}>{msg.text}</p>
      )}
    </div>
  );
}

/* ─── Cache de productos (misma normalización que settings/page.tsx) ───── */

function normalizeProductCache(cache: unknown, storedAllowed: string[]): Producto[] {
  const out: Producto[] = [];
  const seen = new Set<string>();
  if (cache && typeof cache === 'object') {
    for (const [id, value] of Object.entries(cache as Record<string, unknown>)) {
      let title = '';
      let type = '';
      let vendor = '';
      if (typeof value === 'string') {
        title = value;
        vendor = value;
      } else if (value && typeof value === 'object') {
        const v = value as { title?: unknown; type?: unknown; vendor?: unknown };
        if (typeof v.title === 'string') title = v.title;
        if (typeof v.type === 'string') type = v.type;
        if (typeof v.vendor === 'string') vendor = v.vendor;
      }
      const label = (title || type || vendor || id).trim();
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      out.push({ id, title: title.trim(), type: type.trim(), vendor: vendor.trim() });
    }
  }
  return mergeStored(out, storedAllowed);
}

function mergeStored(list: Producto[], storedAllowed: string[]): Producto[] {
  const out = [...list];
  const seen = new Set(out.map((p) => (p.title || p.type || p.vendor || p.id).toLowerCase()));
  for (const stored of storedAllowed) {
    const t = stored.trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push({ id: `__stored__${t}`, title: t, type: '', vendor: '' });
  }
  return out.sort((a, b) => (a.title || a.type || a.vendor).localeCompare(b.title || b.type || b.vendor, 'es'));
}
