export interface ShopifyOrder {
  id: number;
  name: string;
  email: string;
  total_price: string;
  currency: string;
  tags: string;
  fulfillment_status?: string | null;
  /**
   * Estado de pago del pedido ("paid", "pending", "refunded", "voided"...).
   * Se declara porque el camino CONTRA ENTREGA lo lee para descartar los
   * reembolsados y anulados: ahí se le pide a Shopify `financial_status=any`
   * y la lista blanca se aplica de este lado.
   */
  financial_status?: string | null;
  // Top-level order phone (checkout / SMS-notification number). Shopify
  // returns it on the order object; we declare it so resolveOrderPhone()
  // can fall back to it when shipping_address.phone is empty.
  phone?: string | null;
  shipping_address: {
    first_name: string;
    last_name: string;
    phone: string;
    address1: string;
    address2: string;
    city: string;
    province: string;
    zip: string;
    country: string;
  } | null;
  // Billing address — same payer as the order, usually the same person and
  // phone as shipping. Only the phone is consumed (by resolveOrderPhone()).
  billing_address?: {
    phone?: string | null;
  } | null;
  // Account-level customer record. Carries the order-placer's phone, which is
  // exactly who the DAC courier should call when a delivery detail is unclear.
  customer?: {
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    default_address?: {
      phone?: string | null;
    } | null;
  } | null;
  line_items: Array<{ title: string; quantity: number; price: string; product_id: number | null; sku?: string | null }>;
  note: string | null;
  note_attributes: Array<{ name: string; value: string }> | null;
}
