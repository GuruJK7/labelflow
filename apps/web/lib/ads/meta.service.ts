/**
 * Meta Marketing API v21.0 service.
 * Handles creative uploads, ad creation, metrics retrieval, and ad management.
 */

const META_API_VERSION = 'v21.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

interface MetaApiError {
  error: {
    message: string;
    type: string;
    code: number;
  };
}

interface AdInsights {
  impressions: number;
  clicks: number;
  spend: number;
  actions: Array<{ action_type: string; value: string }>;
  ctr: number;
  cpc: number;
  cpm: number;
}

interface CreateAdParams {
  accessToken: string;
  adAccountId: string;
  pageId: string;
  campaignId: string;
  adSetId: string;
  creativeName: string;
  imageHash?: string;
  videoId?: string;
  headline: string;
  bodyText: string;
  callToAction: string;
  linkUrl: string;
}

interface UploadImageResult {
  hash: string;
  url: string;
}

interface UploadVideoResult {
  videoId: string;
}

async function metaFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const data = await res.json();

  if (!res.ok) {
    const apiError = data as MetaApiError;
    throw new Error(
      `Meta API error (${apiError.error?.code ?? res.status}): ${apiError.error?.message ?? 'Unknown error'}`
    );
  }

  return data as T;
}

/**
 * Upload an image to Meta Ad Account.
 */
export async function uploadImage(
  accessToken: string,
  adAccountId: string,
  imageBuffer: Buffer,
  fileName: string
): Promise<UploadImageResult> {
  const formData = new FormData();
  formData.append('access_token', accessToken);
  formData.append('filename', fileName);
  formData.append(
    'bytes',
    new Blob([new Uint8Array(imageBuffer)]),
    fileName
  );

  const data = await metaFetch<{
    images: Record<string, { hash: string; url: string }>;
  }>(`${META_BASE_URL}/${adAccountId}/adimages`, {
    method: 'POST',
    body: formData,
  });

  const imageData = Object.values(data.images)[0];
  if (!imageData) {
    throw new Error('No image data returned from Meta API');
  }

  return { hash: imageData.hash, url: imageData.url };
}

/**
 * Upload a video to Meta Ad Account.
 */
export async function uploadVideo(
  accessToken: string,
  adAccountId: string,
  videoBuffer: Buffer,
  fileName: string
): Promise<UploadVideoResult> {
  const formData = new FormData();
  formData.append('access_token', accessToken);
  formData.append('title', fileName);
  formData.append(
    'source',
    new Blob([new Uint8Array(videoBuffer)]),
    fileName
  );

  const data = await metaFetch<{ id: string }>(
    `${META_BASE_URL}/${adAccountId}/advideos`,
    { method: 'POST', body: formData }
  );

  return { videoId: data.id };
}

/**
 * Create a full ad (creative + ad) in an existing campaign/adset.
 */
export async function createFullAd(params: CreateAdParams): Promise<{
  creativeId: string;
  adId: string;
}> {
  const { accessToken, adAccountId, pageId, campaignId, adSetId } = params;

  // Build object story spec depending on image or video
  const objectStorySpec: Record<string, unknown> = {
    page_id: pageId,
  };

  if (params.videoId) {
    objectStorySpec.video_data = {
      video_id: params.videoId,
      title: params.headline,
      message: params.bodyText,
      call_to_action: {
        type: params.callToAction,
        value: { link: params.linkUrl },
      },
    };
  } else if (params.imageHash) {
    objectStorySpec.link_data = {
      image_hash: params.imageHash,
      link: params.linkUrl,
      message: params.bodyText,
      name: params.headline,
      call_to_action: {
        type: params.callToAction,
        value: { link: params.linkUrl },
      },
    };
  }

  // Create ad creative
  const creative = await metaFetch<{ id: string }>(
    `${META_BASE_URL}/${adAccountId}/adcreatives`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: accessToken,
        name: `LF_${params.creativeName}`,
        object_story_spec: objectStorySpec,
      }),
    }
  );

  // Create ad
  const ad = await metaFetch<{ id: string }>(
    `${META_BASE_URL}/${adAccountId}/ads`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: accessToken,
        name: `LF_Ad_${params.creativeName}`,
        adset_id: adSetId,
        creative: { creative_id: creative.id },
        status: 'ACTIVE',
      }),
    }
  );

  return { creativeId: creative.id, adId: ad.id };
}

/**
 * Get ad insights (metrics) for a specific ad.
 */
export async function getAdInsights(
  accessToken: string,
  adId: string,
  windowHours: number = 48
): Promise<AdInsights | null> {
  const now = new Date();
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const sinceStr = since.toISOString().split('T')[0];
  const untilStr = now.toISOString().split('T')[0];

  const params = new URLSearchParams({
    access_token: accessToken,
    fields: 'impressions,clicks,spend,actions,ctr,cpc,cpm',
    time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
  });

  const data = await metaFetch<{ data: AdInsights[] }>(
    `${META_BASE_URL}/${adId}/insights?${params.toString()}`
  );

  if (!data.data || data.data.length === 0) return null;

  return data.data[0];
}

/**
 * Pause an ad on Meta.
 */
export async function pauseAd(
  accessToken: string,
  adId: string
): Promise<void> {
  await metaFetch<{ success: boolean }>(`${META_BASE_URL}/${adId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: accessToken,
      status: 'PAUSED',
    }),
  });
}

/**
 * Activate (unpause) an ad on Meta.
 */
export async function activateAd(
  accessToken: string,
  adId: string
): Promise<void> {
  await metaFetch<{ success: boolean }>(`${META_BASE_URL}/${adId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: accessToken,
      status: 'ACTIVE',
    }),
  });
}

/**
 * Calculate purchase intent rate from ad insights.
 * Formula: (purchases / clicks) * 100
 * If no clicks, returns 0.
 */
export function calcPurchaseIntentRate(insights: AdInsights): number {
  const purchases =
    insights.actions?.find(
      (a) =>
        a.action_type === 'purchase' ||
        a.action_type === 'offsite_conversion.fb_pixel_purchase'
    );

  const purchaseCount = purchases ? parseInt(purchases.value, 10) : 0;
  const clicks = Number(insights.clicks) || 0;

  if (clicks === 0) return 0;

  return Number(((purchaseCount / clicks) * 100).toFixed(2));
}

/**
 * Extract purchase count from insights actions array.
 */
export function extractPurchases(insights: AdInsights): number {
  const purchases = insights.actions?.find(
    (a) =>
      a.action_type === 'purchase' ||
      a.action_type === 'offsite_conversion.fb_pixel_purchase'
  );
  return purchases ? parseInt(purchases.value, 10) : 0;
}

/**
 * Calculate ROAS from insights.
 * Formula: (purchase_value / spend)
 */
export function calcRoas(insights: AdInsights): number {
  const purchaseValue = insights.actions?.find(
    (a) =>
      a.action_type === 'purchase' ||
      a.action_type === 'offsite_conversion.fb_pixel_purchase'
  );

  const revenue = purchaseValue ? parseFloat(purchaseValue.value) : 0;
  const spend = Number(insights.spend) || 0;

  if (spend === 0) return 0;

  return Number((revenue / spend).toFixed(2));
}
