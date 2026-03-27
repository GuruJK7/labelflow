/**
 * DAC shipment form step constants for structured logging.
 * Each micro-step in the flow gets a unique identifier.
 */

export const DAC_STEPS = {
  // -- Login --
  LOGIN_START: 'login:start',
  LOGIN_COOKIE_TRY: 'login:cookie-try',
  LOGIN_COOKIE_OK: 'login:cookie-ok',
  LOGIN_COOKIE_FAIL: 'login:cookie-fail',
  LOGIN_CAPTCHA_SOLVE: 'login:captcha-solve',
  LOGIN_CAPTCHA_OK: 'login:captcha-ok',
  LOGIN_SUBMIT: 'login:submit',
  LOGIN_OK: 'login:ok',
  LOGIN_FAIL: 'login:fail',

  // -- Navigate to form --
  NAV_NEW_SHIPMENT: 'nav:new-shipment',
  NAV_FORM_LOADED: 'nav:form-loaded',

  // -- Step 1: Shipment type --
  STEP1_START: 'step1:start',
  STEP1_TIPO_SERVICIO: 'step1:tipo-servicio',
  STEP1_TIPO_GUIA: 'step1:tipo-guia',
  STEP1_TIPO_ENVIO: 'step1:tipo-envio',
  STEP1_TIPO_ENTREGA: 'step1:tipo-entrega',
  STEP1_SIGUIENTE: 'step1:siguiente-click',
  STEP1_OK: 'step1:ok',

  // -- Step 2: Origin (auto-filled) --
  STEP2_START: 'step2:start',
  STEP2_SIGUIENTE: 'step2:siguiente-click',
  STEP2_OK: 'step2:ok',

  // -- Step 3: Recipient --
  STEP3_START: 'step3:start',
  STEP3_FILL_NAME: 'step3:fill-name',
  STEP3_FILL_PHONE: 'step3:fill-phone',
  STEP3_FILL_EMAIL: 'step3:fill-email',
  STEP3_FILL_ADDRESS: 'step3:fill-address',
  STEP3_SELECT_DEPT: 'step3:select-department',
  STEP3_WAIT_CITIES: 'step3:wait-cities-load',
  STEP3_SELECT_CITY: 'step3:select-city',
  STEP3_SELECT_BARRIO: 'step3:select-barrio',
  STEP3_SIGUIENTE: 'step3:siguiente-click',
  STEP3_OK: 'step3:ok',

  // -- Step 4: Quantity + Submit --
  STEP4_START: 'step4:start',
  STEP4_FILL_QTY: 'step4:fill-quantity',
  STEP4_FILL_PACKAGE: 'step4:fill-package-size',
  STEP4_WAIT_BTN: 'step4:wait-btn-add',
  STEP4_CLICK_SUBMIT: 'step4:click-agregar',
  STEP4_OK: 'step4:ok',

  // -- Post-submit --
  SUBMIT_WAIT_NAV: 'submit:wait-navigation',
  SUBMIT_CHECK_CART: 'submit:check-cart',
  SUBMIT_EXTRACT_GUIA: 'submit:extract-guia',
  SUBMIT_OK: 'submit:ok',
  SUBMIT_FAIL: 'submit:fail',

  // -- Screenshot --
  SCREENSHOT: 'debug:screenshot',
} as const;

export type DacStep = (typeof DAC_STEPS)[keyof typeof DAC_STEPS];
