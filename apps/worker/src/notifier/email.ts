import nodemailer from 'nodemailer';
import { buildShipmentEmailHtml, buildSubject } from './templates';
import { ShopifyOrder } from '../shopify/types';
import logger from '../logger';
import { maskEmail } from '@labelflow/shared';

interface EmailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export async function sendShipmentNotification(
  order: ShopifyOrder,
  guia: string,
  paymentType: 'REMITENTE' | 'DESTINATARIO',
  storeName: string,
  emailConfig: EmailConfig
): Promise<boolean> {
  if (!order.email) {
    logger.warn({ orderId: order.id }, 'Order has no email, skipping notification');
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: emailConfig.host,
    port: emailConfig.port,
    secure: emailConfig.port === 465,
    auth: { user: emailConfig.user, pass: emailConfig.pass },
  });

  const html = buildShipmentEmailHtml({
    customerName: order.shipping_address?.first_name ?? 'Cliente',
    orderName: order.name,
    guia,
    storeName,
    paymentType,
    items: order.line_items.map((i) => ({ title: i.title, quantity: i.quantity })),
  });

  try {
    await transporter.sendMail({
      from: emailConfig.from,
      to: order.email,
      subject: buildSubject(order.name, guia),
      html,
    });

    logger.info({
      orderId: order.id,
      email: maskEmail(order.email),
      guia,
    }, 'Notification email sent');

    return true;
  } catch (err) {
    logger.error({
      orderId: order.id,
      email: maskEmail(order.email),
      error: (err as Error).message,
    }, 'Failed to send notification email');
    return false;
  }
}
