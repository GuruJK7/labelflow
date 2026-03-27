/**
 * DAC Uruguay (dac.com.uy) — CSS Selectors
 *
 * CONFIRMED via live Chrome DOM inspection (March 27, 2026).
 * Account: Luciano (RUT 56345725)
 *
 * FORM FLOW (4 steps, multi-section single page):
 *   Step 1: TipoServicio + TipoGuia + TipoEnvio + TipoEntrega -> click "Siguiente"
 *   Step 2: Origen (auto-filled from account) -> click "Siguiente"
 *   Step 3: Destino (NombreD, TelD, DirD, K_Estado, K_Ciudad, K_Barrio) -> click "Siguiente"
 *   Step 4: Cantidad -> click "Agregar" (final submit)
 *
 * LOGIN: "Documento o RUT" + "Contrasena" at /usuarios/login
 * POST-LOGIN: Redirects to /envios/nuevo
 * POST-SUBMIT: Shipment goes to cart at /envios/cart
 */

export const DAC_URLS = {
  LOGIN: 'https://www.dac.com.uy/usuarios/login',
  NEW_SHIPMENT: 'https://www.dac.com.uy/envios/nuevo',
  HISTORY: 'https://www.dac.com.uy/envios/cart',
  TRACK: 'https://www.dac.com.uy/envios/rastrear',
} as const;

export const DAC_SELECTORS = {
  // ========== LOGIN (CONFIRMED) ==========
  LOGIN_USER_INPUT: 'input[name="documento"]',
  LOGIN_PASSWORD_INPUT: 'input[name="password"]',
  LOGIN_SUBMIT_BUTTON: '#btnLogin',
  LOGIN_SUCCESS_INDICATOR: 'text=Bienvenido',

  // ========== STEP 1: SHIPMENT TYPE ==========
  /** Solicitud: 0=Mostrador, 1=Levante */
  PICKUP_TYPE: 'select[name="TipoServicio"]',
  PICKUP_VALUE_MOSTRADOR: '0',

  /** Tipo de Guia (PAYMENT): 1=Paga remitente, 4=Paga destinatario
   *  NOTE: This might be a hidden input or select — shipment.ts handles both */
  PAYMENT_TYPE: '[name="TipoGuia"]',
  PAYMENT_VALUE_REMITENTE: '1',
  PAYMENT_VALUE_DESTINATARIO: '4',

  /** Tipo de envio: 1=Paquete */
  PACKAGE_TYPE: 'select[name="TipoEnvio"]',
  PACKAGE_VALUE_PAQUETE: '1',

  /** Tipo de entrega: 2=Domicilio */
  DELIVERY_TYPE: 'select[name="TipoEntrega"]',
  DELIVERY_VALUE_DOMICILIO: '2',

  // ========== STEP 3: RECIPIENT ==========
  RECIPIENT_NAME: 'input[name="NombreD"]',
  RECIPIENT_PHONE: 'input[name="TelD"]',
  RECIPIENT_RUT: 'input[name="RUT_Destinatario"]',
  RECIPIENT_EMAIL: 'input[name="Correo_Destinatario"]',
  RECIPIENT_ADDRESS: 'input[name="DirD"]',
  RECIPIENT_DEPARTMENT: 'select[name="K_Estado"]',
  RECIPIENT_CITY: 'select[name="K_Ciudad"]',
  RECIPIENT_BARRIO: 'select[name="K_Barrio"]',

  // ========== STEP 4: QUANTITY ==========
  PACKAGE_QUANTITY: 'input[name="Cantidad"]',

  // ========== NAVIGATION ==========
  NEXT_BUTTON: 'a:has-text("Siguiente")',
  PREV_BUTTON: 'a:has-text("Anterior")',
  SUBMIT_BUTTON: 'button:has-text("Agregar")',

  // ========== HISTORY / DOWNLOAD ==========
  HISTORY_LINK: 'a:has-text("Historial de env")',
  DOWNLOAD_LABEL: 'a:has-text("Descargar"), a[href*="etiqueta"], a[href*=".pdf"]',
} as const;
