export interface RunLog {
  id: string;
  createdAt: string;
  level: string;
  message: string;
  meta: Record<string, unknown>;
}

/**
 * Extract the step tag from a log message.
 * Messages are formatted as "[step-name] rest of message".
 */
export function extractStep(message: string): string | null {
  const match = message.match(/^\[([^\]]+)\]/);
  return match ? match[1] : null;
}

/**
 * Extract the message body after the step tag.
 */
export function extractBody(message: string): string {
  return message.replace(/^\[[^\]]+\]\s*/, '');
}

export function getDisplayMessage(log: RunLog): string | null {
  const step = (log.meta as Record<string, unknown>)?.step as string | undefined;
  const meta = log.meta as Record<string, unknown>;

  // Mensajes a MOSTRAR (retornan string)
  const messages: Record<string, string> = {
    // Auth DAC
    dac_login_start: '\u{1F510}  Iniciando sesion en DAC...',
    dac_cookies_reused: '\u{1F36A}  Sesion DAC reutilizada (cookies validas)',
    dac_captcha_start: '\u{1F916}  Resolviendo CAPTCHA... (puede tardar ~60s)',
    dac_captcha_solved: '\u2705  CAPTCHA resuelto',
    dac_login_ok: '\u2705  Login DAC exitoso',
    dac_login_failed: '\u274C  Login DAC fallo \u2014 revisar credenciales',

    // Shopify
    shopify_fetch_start: '\u{1F6CD}\uFE0F   Consultando pedidos en Shopify...',
    shopify_fetch_ok: `\u{1F6CD}\uFE0F   Shopify \u2192 ${meta?.count ?? ''} pedidos nuevos encontrados`,
    shopify_no_orders: '\u{1F634}  Sin pedidos nuevos por ahora',

    // Por pedido
    dac_form_start: `\u25B6   Pedido ${meta?.orderName ?? ''} \u2014 ${meta?.customerName ?? ''} \u2014 iniciando en DAC`,
    dac_form_step3_start: `     Cargando datos de ${meta?.customerName ?? 'cliente'}...`,
    dac_form_tel_filled: '     Telefono confirmado',
    dac_form_step3_ok: '     Direccion y datos cargados \u2713',
    dac_form_step4_visible: '     Paquete configurado \u2713',
    dac_form_agregar_clicked: '   Enviando a DAC...',
    dac_guia_found: `\u2705  Guia generada \u2192 ${meta?.guia ?? ''}`,
    dac_guia_not_found: '\u26A0\uFE0F   Guia no encontrada en cart \u2014 usando ID temporal',

    // DB / Email
    db_label_saved: '     Guardado en sistema',
    shopify_tag_ok: '     Pedido marcado en Shopify \u2713',
    email_sent: '     Email enviado a cliente \u2713',
    email_skipped: '     Email omitido (SMTP no configurado)',

    // Job
    job_complete: '\u{1F3C1}  Ejecucion completada',
    job_failed: '\u274C  Ejecucion fallida \u2014 ver Logs para detalle',
  };

  // Si tiene step mapeado -> mostrar
  if (step && messages[step]) return messages[step];

  // Also try extracting step from the message string [step-name]
  const msgStep = extractStep(log.message);
  if (msgStep) {
    // Map worker step names to display messages
    const workerMessages: Record<string, string> = {
      'start': '\u25B6  Iniciando ciclo de procesamiento...',
      'shopify': `\u{1F6CD}\uFE0F   ${extractBody(log.message)}`,
      'filter': `\u{1F50D}  ${extractBody(log.message)}`,
      'dac-login': log.level === 'ERROR'
        ? `\u274C  ${extractBody(log.message)}`
        : (log.level === 'SUCCESS' ? '\u2705  Login DAC exitoso' : '\u{1F510}  Conectando a DAC...'),
      'order-start': `\u25B6  ${extractBody(log.message)}`,
      'order-payment': `\u{1F4B3}  ${extractBody(log.message)}`,
      'order-shipment': `\u{1F4E6}  ${extractBody(log.message)}`,
      'order-complete': `\u2705  ${extractBody(log.message)}`,
      'order-fail': `\u274C  ${extractBody(log.message)}`,
      'order-validate': `\u26A0\uFE0F  ${extractBody(log.message)}`,
      'order-db': `\u{1F4BE}  Guardado en sistema`,
      'order-shopify': `\u{1F6CD}\uFE0F   Marcado en Shopify`,
      'order-email': `\u{1F4E7}  Email enviado`,
      'order-pdf': `\u{1F4C4}  ${extractBody(log.message)}`,
      'complete': `\u{1F3C1}  ${extractBody(log.message)}`,
      'fatal': `\u274C  Error fatal: ${extractBody(log.message)}`,
      'limit': `\u26A0\uFE0F  ${extractBody(log.message)}`,
    };
    if (workerMessages[msgStep]) return workerMessages[msgStep];
  }

  // Si level es ERROR y no tiene step -> mostrar igual
  if (log.level === 'ERROR') return `\u274C  ${log.message}`;

  // Todo lo demas -> OCULTAR (no mostrarlo en el feed)
  return null;
}

// ---- Order tracking data extraction ----

export interface OrderTrack {
  index: number;
  total: number;
  orderName: string;
  customerName: string;
  address: string;
  city: string;
  paymentType: string;
  amount: string;
  guia: string | null;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  errorMessage?: string;
  startTime?: number;
  duration?: number;
}

/**
 * Parse all logs to build an array of tracked orders.
 * Each order transitions: queued -> processing -> completed|failed
 */
export function buildOrderTracks(logs: RunLog[]): OrderTrack[] {
  const orders: Map<string, OrderTrack> = new Map();
  let totalOrders = 0;

  for (const log of logs) {
    const msgStep = extractStep(log.message);
    const meta = log.meta as Record<string, unknown>;
    const body = extractBody(log.message);

    if (msgStep === 'order-start') {
      // Parse "Processing order 1/3: #10861"
      const posMatch = body.match(/order\s+(\d+)\/(\d+):\s*(#?\S+)/i);
      if (posMatch) {
        const index = parseInt(posMatch[1]);
        const total = parseInt(posMatch[2]);
        const orderName = posMatch[3];
        totalOrders = total;

        orders.set(orderName, {
          index,
          total,
          orderName,
          customerName: (meta?.customer as string) ?? '',
          address: '',
          city: (meta?.city as string) ?? '',
          paymentType: '',
          amount: '',
          guia: null,
          status: 'processing',
          startTime: new Date(log.createdAt).getTime(),
        });
      }
    }

    if (msgStep === 'order-payment') {
      // "Payment type: DESTINATARIO"
      const orderName = (meta?.orderName as string) ?? '';
      const order = orders.get(orderName);
      if (order) {
        const payMatch = body.match(/Payment type:\s*(\S+)/i);
        if (payMatch) order.paymentType = payMatch[1];
      }
    }

    if (msgStep === 'step3:fill-name') {
      // Fill name -- meta has { selector, value }
      const value = (meta?.value as string) ?? '';
      // Find the most recently started order (last processing one)
      const lastProcessing = findLastProcessing(orders);
      if (lastProcessing && value) {
        lastProcessing.customerName = value;
      }
    }

    if (msgStep === 'step3:fill-address') {
      const value = (meta?.value as string) ?? '';
      const lastProcessing = findLastProcessing(orders);
      if (lastProcessing && value) {
        lastProcessing.address = value;
      }
    }

    if (msgStep === 'step3:select-city') {
      const lastProcessing = findLastProcessing(orders);
      if (lastProcessing) {
        // The city info is in the body: "Selecting city: Montevideo"
        const cityMatch = body.match(/city:\s*(.+)/i);
        if (cityMatch) lastProcessing.city = cityMatch[1].trim();
      }
    }

    if (msgStep === 'nav:new-shipment') {
      // meta has orderName, paymentType, city, province
      const orderName = (meta?.orderName as string) ?? '';
      const order = orders.get(orderName);
      if (order) {
        if (meta?.city) order.city = meta.city as string;
        if (meta?.paymentType) order.paymentType = meta.paymentType as string;
      }
    }

    if (msgStep === 'order-shipment' || msgStep === 'submit:ok') {
      // "DAC shipment created for #10861" with meta.guia
      const guia = (meta?.guia as string) ?? null;
      const orderName = (meta?.orderName as string) ?? '';
      // Try finding by orderName in meta first
      let order = orders.get(orderName);
      if (!order) {
        // Try extracting from body
        const nameMatch = body.match(/#\S+/);
        if (nameMatch) order = orders.get(nameMatch[0]);
      }
      if (!order) {
        // Fallback: last processing order
        order = findLastProcessing(orders) ?? undefined;
      }
      if (order && guia) {
        order.guia = guia;
      }
    }

    if (msgStep === 'order-complete') {
      // "Order #10861 processed successfully"
      const nameMatch = body.match(/#\S+/);
      const orderName = nameMatch ? nameMatch[0] : '';
      const order = orders.get(orderName);
      if (order) {
        order.status = 'completed';
        order.duration = Math.round((new Date(log.createdAt).getTime() - (order.startTime ?? 0)) / 1000);
        if (meta?.guia) order.guia = meta.guia as string;
        if (meta?.paymentType) order.paymentType = meta.paymentType as string;
      }
    }

    if (msgStep === 'order-fail' || msgStep === 'order-validate') {
      const nameMatch = body.match(/#?\S+\s+(?:failed|skipped)/i);
      // Try extracting order name from meta or body
      let orderName = '';
      const bodyNameMatch = body.match(/(#\S+)/);
      if (bodyNameMatch) orderName = bodyNameMatch[1];

      const order = orders.get(orderName) ?? findLastProcessing(orders);
      if (order) {
        order.status = 'failed';
        order.errorMessage = body;
        order.duration = Math.round((new Date(log.createdAt).getTime() - (order.startTime ?? 0)) / 1000);
      }
    }
  }

  // Convert map to sorted array
  const result = Array.from(orders.values()).sort((a, b) => a.index - b.index);

  // If we know totalOrders is greater than orders tracked, add queued placeholders
  // (The worker logs shopify fetch count before starting individual orders)
  return result;
}

function findLastProcessing(orders: Map<string, OrderTrack>): OrderTrack | null {
  let last: OrderTrack | null = null;
  for (const order of orders.values()) {
    if (order.status === 'processing') {
      if (!last || order.index > last.index) last = order;
    }
  }
  return last;
}

/**
 * Extract the total expected orders from shopify fetch or limit logs.
 */
export function extractTotalExpected(logs: RunLog[]): number {
  let total = 0;
  for (const log of logs) {
    const step = extractStep(log.message);
    const body = extractBody(log.message);

    if (step === 'order-start') {
      const match = body.match(/order\s+\d+\/(\d+)/i);
      if (match) total = Math.max(total, parseInt(match[1]));
    }
  }
  return total;
}
