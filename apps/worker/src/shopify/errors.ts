/**
 * Errores tipados que la fachada (`index.ts`) re-exporta y los jobs pueden
 * mirar con `instanceof`, SIN importar ningún módulo GraphQL: con
 * SHOPIFY_API_MODE=rest el proceso no debe cargar `graphql-client.ts`
 * (test `shopify-facade.test.ts`), así que estas clases viven acá y no allá.
 * Los errores de fulfillment (`ShopifyAlreadyFulfilledError`,
 * `ShopifyMissingScopesError`) siguen en `fulfillment.ts`, que no se toca.
 */

/**
 * La app pública todavía no tiene aprobado el acceso a datos protegidos de
 * cliente (nombre, dirección, teléfono, email): Shopify contesta HTTP 200
 * con esos campos en null + `errors[]` por path. Se lanza ANTES de que un job
 * itere los pedidos, para que aborte el tenant con un único mensaje en el
 * runlog en vez de escribir "LabelFlow ERROR: No shipping address" en cada
 * pedido cada 15 minutos (D27, revisión).
 */
export class ShopifyProtectedDataError extends Error {
  readonly isShopifyProtectedDataError = true as const;
  constructor(
    readonly storeUrl: string,
    /** Campos denegados, p. ej. `orders.nodes.0.shippingAddress`. */
    readonly deniedPaths: string[],
  ) {
    super(
      `Shopify: protected customer data not approved for this app on ${storeUrl} ` +
        `(denied: ${deniedPaths.slice(0, 5).join(', ')}${deniedPaths.length > 5 ? ', …' : ''}). ` +
        'Partner Dashboard → app → API access → Protected customer data access: request name, address, phone and email, then retry.',
    );
    this.name = 'ShopifyProtectedDataError';
  }
}

export function isShopifyProtectedDataError(err: unknown): err is ShopifyProtectedDataError {
  return !!err && typeof err === 'object' && (err as ShopifyProtectedDataError).isShopifyProtectedDataError === true;
}
