interface EmailData {
  customerName: string;
  orderName: string;
  guia: string;
  storeName: string;
  paymentType: 'REMITENTE' | 'DESTINATARIO';
  items: Array<{ title: string; quantity: number }>;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildShipmentEmailHtml(data: EmailData): string {
  const customerName = escapeHtml(data.customerName);
  const orderName = escapeHtml(data.orderName);
  const guia = escapeHtml(data.guia);
  const storeName = escapeHtml(data.storeName);
  const { paymentType, items } = data;
  const trackingUrl = `https://www.dac.com.uy/envios/rastrear`;

  const itemsHtml = items
    .map((item) => `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;color:#333;">${escapeHtml(item.title)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:14px;color:#333;text-align:center;">${item.quantity}</td></tr>`)
    .join('');

  const paymentNotice = paymentType === 'DESTINATARIO'
    ? `<div style="background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:12px 16px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#856404;"><strong>Importante:</strong> El envio se paga al recibirlo. Tene el efectivo listo cuando llegue el repartidor.</p></div>`
    : '';

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:20px 0;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:100%;"><tr><td style="background:#06b6d4;padding:24px;text-align:center;"><h1 style="margin:0;color:#fff;font-size:22px;">${storeName}</h1></td></tr><tr><td style="padding:32px 24px;"><h2 style="margin:0 0 8px;font-size:20px;color:#111;">Tu pedido esta en camino!</h2><p style="margin:0 0 24px;font-size:15px;color:#555;">Hola <strong>${customerName}</strong>, tu pedido <strong>${orderName}</strong> fue despachado via DAC.</p><div style="background:#f0f7ff;border:1px solid #06b6d4;border-radius:8px;padding:16px;margin:0 0 24px;text-align:center;"><p style="margin:0 0 4px;font-size:13px;color:#555;">Numero de guia DAC</p><p style="margin:0 0 12px;font-size:24px;font-weight:700;color:#06b6d4;letter-spacing:1px;">${guia}</p><a href="${trackingUrl}" style="display:inline-block;background:#06b6d4;color:#fff;text-decoration:none;padding:10px 24px;border-radius:6px;font-size:14px;font-weight:500;">Rastrear mi pedido</a></div>${paymentNotice}<h3 style="margin:0 0 12px;font-size:16px;color:#111;">Productos</h3><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;margin:0 0 24px;"><thead><tr style="background:#f9fafb;"><th style="padding:10px 12px;text-align:left;font-size:13px;color:#555;">Producto</th><th style="padding:10px 12px;text-align:center;font-size:13px;color:#555;">Cant.</th></tr></thead><tbody>${itemsHtml}</tbody></table><div style="background:#f0fdf4;border:1px solid #22c55e;border-radius:8px;padding:12px 16px;"><p style="margin:0;font-size:14px;color:#166534;">Entrega estimada: <strong>24 a 48 horas habiles</strong>.</p></div></td></tr><tr><td style="background:#f9fafb;padding:20px 24px;border-top:1px solid #eee;"><p style="margin:0;font-size:13px;color:#888;text-align:center;">${storeName} &mdash; Gracias por tu compra.</p></td></tr></table></td></tr></table></body></html>`;
}

export function buildSubject(orderName: string, guia: string): string {
  return `Tu pedido ${orderName} esta en camino (Guia DAC: ${guia})`;
}
