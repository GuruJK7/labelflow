/**
 * Recover message processor.
 * Handles sending WhatsApp recovery messages for abandoned carts.
 * Follows the same pattern as process-orders.job.ts and upload-job.ts.
 */

import { db } from '../db';
import logger from '../logger';
import { sendWhatsAppMessage, type WhatsAppCredentials } from './whatsapp';
import { decryptIfPresent } from '../encryption';

/**
 * Interpolates template variables.
 * {{1}} = customer first name, {{2}} = product name, {{3}} = checkout URL
 */
function interpolateTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return Object.entries(vars).reduce(
    (msg, [key, value]) => msg.replaceAll(key, value),
    template
  );
}

function extractFirstName(fullName: string | null | undefined): string {
  if (!fullName || fullName.trim().length === 0) return 'cliente';
  return fullName.trim().split(/\s+/)[0] ?? 'cliente';
}

function maskPhone(phone: string): string {
  if (phone.length < 8) return '***';
  return `${phone.slice(0, 6)}${'*'.repeat(Math.max(phone.length - 8, 3))}${phone.slice(-2)}`;
}

/**
 * Processes a single RecoverJob — sends the WhatsApp message and updates state.
 */
export async function processRecoverMessage(jobId: string): Promise<void> {
  const startTime = Date.now();

  // Load job with related cart and config
  const job = await db.recoverJob.findUnique({
    where: { id: jobId },
    include: {
      cart: {
        include: {
          recoverConfig: true,
        },
      },
    },
  });

  if (!job) {
    logger.warn({ jobId }, '[Recover] Job not found');
    return;
  }

  const { cart } = job;
  const config = cart.recoverConfig;

  // Guard: recoverConfig relation must exist (should always exist, but safeguard)
  if (!config) {
    logger.error({ jobId, cartId: cart.id }, '[Recover] recoverConfig not found — marking job failed');
    await markJobFailed(jobId, startTime, 'RecoverConfig not found for cart');
    return;
  }

  // Guard: config must be active with valid subscription
  if (!config.isActive || config.subscriptionStatus !== 'ACTIVE') {
    logger.warn({ jobId, cartId: cart.id }, '[Recover] Module inactive, skipping job');
    await markJobCompleted(jobId, startTime);
    return;
  }

  // Guard: if this is message 2 and second message was disabled since scheduling, skip
  if (job.messageNumber === 2 && !config.secondMessageEnabled) {
    logger.warn({ jobId, cartId: cart.id }, '[Recover] Second message disabled, skipping job');
    await markJobCompleted(jobId, startTime);
    return;
  }

  // Guard: cart must still be in a recoverable state
  const recoverableStatuses = ['PENDING', 'MESSAGE_1_SENT'];
  if (!recoverableStatuses.includes(cart.status)) {
    logger.warn(
      { jobId, cartId: cart.id, status: cart.status },
      '[Recover] Cart no longer recoverable, skipping'
    );
    await markJobCompleted(jobId, startTime);
    return;
  }

  // Guard: must have a phone number
  if (!cart.customerPhone) {
    logger.warn({ jobId, cartId: cart.id }, '[Recover] No phone number on cart');
    await db.recoverCart.update({
      where: { id: cart.id },
      data: { status: 'NO_PHONE' },
    });
    await markJobCompleted(jobId, startTime);
    return;
  }

  // Guard: skip if message already sent for this message number
  if (job.messageNumber === 1 && ['MESSAGE_1_SENT', 'MESSAGE_2_SENT'].includes(cart.status)) {
    logger.warn({ jobId, cartId: cart.id }, '[Recover] Message 1 already sent, skipping');
    await markJobCompleted(jobId, startTime);
    return;
  }
  if (job.messageNumber === 2 && cart.status === 'MESSAGE_2_SENT') {
    logger.warn({ jobId, cartId: cart.id }, '[Recover] Message 2 already sent, skipping');
    await markJobCompleted(jobId, startTime);
    return;
  }

  // Guard: check opt-out
  const optOut = await db.recoverOptOut.findUnique({
    where: {
      tenantId_phone: {
        tenantId: job.tenantId,
        phone: cart.customerPhone,
      },
    },
  });

  if (optOut) {
    logger.warn(
      { jobId, cartId: cart.id, phone: maskPhone(cart.customerPhone) },
      '[Recover] Phone opted out, skipping'
    );
    await db.recoverCart.update({
      where: { id: cart.id },
      data: { status: 'OPTED_OUT' },
    });
    await markJobCompleted(jobId, startTime);
    return;
  }

  // Determine which template to use
  const template =
    job.messageNumber === 1 ? config.messageTemplate1 : config.messageTemplate2;

  if (!template) {
    logger.warn({ jobId, messageNumber: job.messageNumber }, '[Recover] Template not configured');
    await markJobFailed(jobId, startTime, 'Template not configured');
    return;
  }

  // Build message body
  const cartItemsRaw = cart.cartItems as Array<{ title: string; quantity: number; price: number }>;
  const firstItem = cartItemsRaw?.[0];
  const productName = firstItem?.title ?? 'tus productos';
  const checkoutUrl = cart.checkoutUrl ?? '';
  const firstName = extractFirstName(cart.customerName);

  const messageBody = interpolateTemplate(template, {
    '{{1}}': firstName,
    '{{2}}': productName,
    '{{3}}': checkoutUrl,
  });

  logger.info(
    {
      jobId,
      cartId: cart.id,
      messageNumber: job.messageNumber,
      phone: maskPhone(cart.customerPhone),
    },
    '[Recover] Sending WhatsApp message'
  );

  // Resolve WhatsApp credentials based on mode
  let credentials: WhatsAppCredentials | undefined;
  if (config.whatsappMode === 'OWN') {
    const apiToken = decryptIfPresent(config.whatsappApiToken);
    if (!apiToken || !config.whatsappPhoneNumberId) {
      logger.error(
        { jobId, cartId: cart.id },
        '[Recover] OWN mode but credentials missing or undecryptable — marking job failed'
      );
      await markJobFailed(jobId, startTime, 'OWN mode credentials missing');
      return;
    }
    credentials = { apiToken, phoneNumberId: config.whatsappPhoneNumberId };
  }
  // PLATFORM mode: credentials = undefined → sendWhatsAppMessage uses env vars

  // Send the message
  const result = await sendWhatsAppMessage({
    to: cart.customerPhone,
    body: messageBody,
    credentials,
  });

  // Log the message send attempt
  await db.recoverMessageLog.create({
    data: {
      cartId: cart.id,
      tenantId: job.tenantId,
      messageNumber: job.messageNumber,
      phone: cart.customerPhone,
      messageBody,
      whatsappMessageId: result.success ? (result.messageId ?? null) : null,
      status: result.success ? 'SENT' : 'FAILED',
      metaErrorCode: result.error?.code ?? null,
      metaErrorMessage: result.error?.message ?? null,
    },
  });

  if (!result.success) {
    logger.error(
      { jobId, cartId: cart.id, error: result.error },
      '[Recover] WhatsApp send failed'
    );
    await markJobFailed(jobId, startTime, result.error?.message ?? 'WhatsApp send failed');

    // Only permanently mark the cart FAILED for non-recoverable errors.
    // Transient errors (missing config, network issues) should leave the cart
    // in its current state so it can be manually retried or recovered once the
    // underlying issue is fixed.
    const transientErrorCodes = ['CONFIG_MISSING', 'NETWORK_ERROR'];
    const isTransient = transientErrorCodes.includes(result.error?.code ?? '');

    if (!isTransient) {
      await db.recoverCart.update({
        where: { id: cart.id },
        data: { status: 'FAILED' },
      });
    }
    return;
  }

  // Update cart status
  const newCartStatus = job.messageNumber === 1 ? 'MESSAGE_1_SENT' : 'MESSAGE_2_SENT';
  await db.recoverCart.update({
    where: { id: cart.id },
    data: { status: newCartStatus },
  });

  logger.info(
    {
      jobId,
      cartId: cart.id,
      messageId: result.messageId,
      messageNumber: job.messageNumber,
    },
    '[Recover] Message sent successfully'
  );

  await markJobCompleted(jobId, startTime);
}

async function markJobCompleted(jobId: string, startTime: number): Promise<void> {
  await db.recoverJob.update({
    where: { id: jobId },
    data: {
      status: 'COMPLETED',
      finishedAt: new Date(),
    },
  });
  logger.info({ jobId, durationMs: Date.now() - startTime }, '[Recover] Job completed');
}

async function markJobFailed(
  jobId: string,
  startTime: number,
  errorMessage: string
): Promise<void> {
  await db.recoverJob.update({
    where: { id: jobId },
    data: {
      status: 'FAILED',
      finishedAt: new Date(),
      errorMessage: errorMessage.slice(0, 500),
    },
  });
  logger.error({ jobId, durationMs: Date.now() - startTime, errorMessage }, '[Recover] Job failed');
}
