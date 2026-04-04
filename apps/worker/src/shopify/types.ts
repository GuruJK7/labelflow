export interface ShopifyOrder {
  id: number;
  name: string;
  email: string;
  total_price: string;
  currency: string;
  tags: string;
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
  line_items: Array<{ title: string; quantity: number; price: string; product_id: number | null }>;
  note: string | null;
  note_attributes: Array<{ name: string; value: string }> | null;
}
