/**
 * Ad Monitor Job processor.
 * Checks active ads metrics against configured rules and auto-pauses underperformers.
 */

import { db } from '../db';
import { decryptIfPresent } from '../encryption';
import logger from '../logger';

const META_API_VERSION = 'v21.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

interface AdInsights {
  impressions: string;
  clicks: string;
  spend: string;
  actions?: Array<{ action_type: string; value: string }>;
  ctr: string;
  cpc: string;
  cpm: string;
}

export async function processAdMonitorJob(
  jobId: string,
  metaAdAccountId: string
): Promise<void> {
  try {
    const adAccount = await db.metaAdAccount.findUnique({
      where: { id: metaAdAccountId },
      include: {
        rules: { where: { isActive: true } },
        ads: { where: { status: 'ACTIVE', metaAdId: { not: null } } },
      },
    });

    if (!adAccount) {
      await markMonitorFailed(jobId, 'Ad account not found');
      return;
    }

    const accessToken = decryptIfPresent(adAccount.metaAccessToken);
    if (!accessToken) {
      await markMonitorFailed(jobId, 'Missing Meta API token');
      return;
    }

    if (adAccount.ads.length === 0) {
      await markMonitorCompleted(jobId, 0, 0);
      return;
    }

    let adsChecked = 0;
    let adsPaused = 0;

    for (const ad of adAccount.ads) {
      if (!ad.metaAdId) continue;

      try {
        // Get max window from rules
        const maxWindow = Math.max(...adAccount.rules.map((r) => r.windowHours), 48);
        const insights = await getAdInsights(accessToken, ad.metaAdId, maxWindow);

        if (!insights) {
          adsChecked++;
          continue;
        }

        const impressions = parseInt(insights.impressions || '0', 10);
        const clicks = parseInt(insights.clicks || '0', 10);
        const spend = parseFloat(insights.spend || '0');
        const ctr = parseFloat(insights.ctr || '0');
        const cpc = parseFloat(insights.cpc || '0');
        const cpm = parseFloat(insights.cpm || '0');

        const purchases = extractPurchases(insights);
        const purchaseIntentRate = clicks > 0 ? (purchases / clicks) * 100 : 0;
        const roas = spend > 0 ? purchases / spend : 0;

        // Save metrics snapshot
        await db.adMetricsHistory.create({
          data: {
            managedAdId: ad.id,
            impressions,
            clicks,
            spend,
            purchases,
            ctr,
            cpc,
            cpm,
            roas,
            purchaseIntentRate,
          },
        });

        // Update current metrics on the ad
        await db.managedAd.update({
          where: { id: ad.id },
          data: {
            impressions,
            clicks,
            spend,
            purchases,
            ctr,
            cpc,
            cpm,
            roas,
            purchaseIntentRate,
            lastCheckedAt: new Date(),
          },
        });

        // Evaluate rules
        const metricsMap: Record<string, number> = {
          ctr,
          cpc,
          cpm,
          roas,
          purchase_intent_rate: purchaseIntentRate,
          impressions,
          clicks,
          spend,
        };

        let shouldPause = false;
        let pauseReason = '';

        for (const rule of adAccount.rules) {
          const metricValue = metricsMap[rule.metric];
          if (metricValue === undefined) continue;

          let triggered = false;
          switch (rule.operator) {
            case 'lt':
              triggered = metricValue < rule.threshold;
              break;
            case 'gt':
              triggered = metricValue > rule.threshold;
              break;
            case 'lte':
              triggered = metricValue <= rule.threshold;
              break;
            case 'gte':
              triggered = metricValue >= rule.threshold;
              break;
          }

          if (triggered && rule.action === 'pause') {
            shouldPause = true;
            pauseReason = `Regla "${rule.name}": ${rule.metric} ${rule.operator} ${rule.threshold} (actual: ${metricValue.toFixed(2)})`;
            break;
          }
        }

        if (shouldPause && ad.metaAdId) {
          // Pause on Meta
          await pauseMetaAd(accessToken, ad.metaAdId);

          // Update local status
          await db.managedAd.update({
            where: { id: ad.id },
            data: { status: 'PAUSED_AUTO', errorMessage: pauseReason },
          });

          adsPaused++;
          logger.info(
            { jobId, adId: ad.metaAdId, reason: pauseReason },
            'Ad auto-paused by rule'
          );

          // Notify
          await sendPauseNotification(adAccount, ad.creativeName, pauseReason);
        }

        adsChecked++;
      } catch (err) {
        logger.error(
          { jobId, adId: ad.metaAdId, error: (err as Error).message },
          'Error checking ad metrics'
        );
        adsChecked++;
      }
    }

    await markMonitorCompleted(jobId, adsChecked, adsPaused);
  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error({ jobId, error: errMsg }, 'Monitor job failed');
    await markMonitorFailed(jobId, errMsg);
  }
}

// --- Meta helpers ---

async function getAdInsights(
  accessToken: string,
  adId: string,
  windowHours: number
): Promise<AdInsights | null> {
  const now = new Date();
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const params = new URLSearchParams({
    access_token: accessToken,
    fields: 'impressions,clicks,spend,actions,ctr,cpc,cpm',
    time_range: JSON.stringify({
      since: since.toISOString().split('T')[0],
      until: now.toISOString().split('T')[0],
    }),
  });

  const res = await fetch(`${META_BASE_URL}/${adId}/insights?${params.toString()}`);
  if (!res.ok) return null;

  const data = (await res.json()) as { data: AdInsights[] };
  return data.data?.[0] ?? null;
}

async function pauseMetaAd(accessToken: string, adId: string): Promise<void> {
  await fetch(`${META_BASE_URL}/${adId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: accessToken, status: 'PAUSED' }),
  });
}

function extractPurchases(insights: AdInsights): number {
  const action = insights.actions?.find(
    (a) =>
      a.action_type === 'purchase' ||
      a.action_type === 'offsite_conversion.fb_pixel_purchase'
  );
  return action ? parseInt(action.value, 10) : 0;
}

// --- Job state helpers ---

async function markMonitorCompleted(
  jobId: string,
  adsChecked: number,
  adsPaused: number
): Promise<void> {
  await db.adMonitorQueue.update({
    where: { id: jobId },
    data: {
      status: 'COMPLETED',
      finishedAt: new Date(),
      adsChecked,
      adsPaused,
    },
  });
}

async function markMonitorFailed(jobId: string, errorMessage: string): Promise<void> {
  await db.adMonitorQueue.update({
    where: { id: jobId },
    data: {
      status: 'FAILED',
      finishedAt: new Date(),
      errorMessage,
    },
  });
}

// --- Notifications ---

async function sendPauseNotification(
  adAccount: { notifyWebhook: string | null; notifyEmail: string | null },
  adName: string,
  reason: string
): Promise<void> {
  if (adAccount.notifyWebhook) {
    try {
      await fetch(adAccount.notifyWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'ad_paused_auto',
          title: `Anuncio pausado: ${adName}`,
          message: reason,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch {
      // Non-critical
    }
  }
}
