/**
 * Envíos gratis por CUENTA nueva (D31).
 *
 * Se acreditan UNA sola vez al tenant holder (el primero del user): signup
 * público, alta por Google y alta desde el App Store (`created`). Tiendas
 * adicionales y reclamadas nacen con 0, y un dominio de Shopify ya vinculado
 * a otro tenant nunca acredita nada.
 *
 * NO es el default del schema (`Tenant.shipmentCredits @default(10)`), que no
 * se toca: por eso cada create de cuenta nueva pasa este valor explícito. Un
 * create que confíe en el default regala 10 en vez de 5.
 */
export const TRIAL_SHIPMENTS = 5;

/**
 * Bono extra por entrar con link de referido (pool `referralBonusCredits`,
 * aparte del saldo pago). Movido de signup/route.ts y lib/auth.ts sin cambiar
 * el valor. D31 no lo toca.
 */
export const REFEREE_BONUS_CREDITS = 10;
