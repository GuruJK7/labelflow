/**
 * DAC Uruguay (dac.com.uy) — CSS Selectors
 *
 * CONFIRMED via live Chrome DOM inspection (March 2026).
 * Technology: Server-rendered PHP (Chukupax framework), vanilla HTML.
 *
 * IMPORTANT: All buttons are type="button" (JS onclick), NOT type="submit".
 */

export const DAC_URLS = {
  BASE: 'https://www.dac.com.uy',
  LOGIN: 'https://www.dac.com.uy/usuarios/login',
  NEW_SHIPMENT: 'https://www.dac.com.uy/envios/nuevo',
  TRACK: 'https://www.dac.com.uy/envios/rastrear',
  CART: 'https://www.dac.com.uy/envios/cart',
} as const;

export const DAC = {
  // ===== LOGIN (CONFIRMED) =====
  // Form: #loginForm, action="/usuarios/doLogin", POST
  login: {
    form: '#loginForm',
    /** input#documento name="documento" — NOT email, it's document/RUT */
    userInput: '#documento',
    /** input#password name="password" */
    passwordInput: '#password',
    /** button#btnLogin type="button" — uses JS onclick, NOT form submit */
    submitButton: '#btnLogin',
    /** Visible after successful login */
    successIndicator: 'a[href*="envios/nuevo"], a[href*="logout"], a[href*="cerrar"]',
  },

  // ===== NEW SHIPMENT FORM (CONFIRMED from /tarifas) =====
  // Field names confirmed via DOM inspection of tariff calculator
  shipment: {
    /** select[name="TipoServicio"] — 0=Mostrador, 1=Levante */
    pickupType: 'select[name="TipoServicio"]',
    pickupValues: { mostrador: '0', levante: '1' },

    /** select[name="TipoEntrega"] — 1=Agencia, 2=A Domicilio */
    deliveryType: 'select[name="TipoEntrega"]',
    deliveryValues: { agencia: '1', domicilio: '2' },

    /** select[name="TipoEnvio"] — 1=Paquete, 2=Carta, 3=Sobre, 4=Producto */
    packageType: 'select[name="TipoEnvio"]',
    packageValues: { paquete: '1', carta: '2', sobre: '3', producto: '4' },

    /** input[name="TipoGuia"] — hidden, payment type */
    paymentType: 'input[name="TipoGuia"]',

    /** select[name="K_Estado"] — department (1-19 values) */
    department: 'select[name="K_Estado"]',

    /** select[name="K_Ciudad"] — city (loaded dynamically based on department) */
    city: 'select[name="K_Ciudad"]',

    /** input#DirD name="DirD" — delivery address */
    address: '#DirD, input[name="DirD"]',

    /** input[name="Cantidad"] type=number — package count, default 1 */
    quantity: 'input[name="Cantidad"]',

    // These fields need confirmation via authenticated probe:
    recipientName: 'input[name="nombre"], input[name="NombreD"], input[placeholder*="nombre" i]',
    recipientPhone: 'input[name="telefono"], input[name="TelefonoD"], input[type="tel"], input[placeholder*="tel" i]',

    /** Submit button (likely type="button" like all DAC buttons) */
    submitButton: 'button.btnAdd, button:has-text("Agregar"), button:has-text("Finalizar")',
    guiaDisplay: '.guia-number, .tracking-number, .numero-guia, [data-guia]',
    successMessage: '.success, .alert-success, [class*="success"], [class*="exito"]',
  },

  // ===== TRACKING (CONFIRMED) =====
  // Form: #FormRastreo, action="/envios/doRastrear2", POST
  tracking: {
    form: '#FormRastreo',
    /** input[name="rastreopedido"] — no ID */
    searchInput: 'input[name="rastreopedido"]',
    /** button#btnSearch type="button" */
    searchButton: '#btnSearch',
    downloadButton: 'a:has-text("Descargar"), a:has-text("Etiqueta"), a[href*=".pdf"]',
  },
} as const;
