export interface RunLog {
  id: string;
  createdAt: string;
  level: string;
  message: string;
  meta: Record<string, unknown>;
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

  // Si level es ERROR y no tiene step -> mostrar igual
  if (log.level === 'ERROR') return `\u274C  ${log.message}`;

  // Todo lo demas -> OCULTAR (no mostrarlo en el feed)
  return null;
}
