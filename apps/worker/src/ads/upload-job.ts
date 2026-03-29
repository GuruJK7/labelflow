/**
 * Ad Upload Job processor.
 * Scans Google Drive folder for creatives, uploads to Meta, and creates ads.
 */

import { db } from '../db';
import { decryptIfPresent } from '../encryption';
import logger from '../logger';

const META_API_VERSION = 'v21.0';
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_MIMES = ['video/mp4', 'video/quicktime'];
const SUPPORTED_MIMES = [...IMAGE_MIMES, ...VIDEO_MIMES];

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

interface CopiesJson {
  defaultHeadline: string;
  defaultBody: string;
  defaultCallToAction: string;
  defaultLinkUrl: string;
  copies: Array<{
    fileName: string;
    headline: string;
    body: string;
    callToAction?: string;
    linkUrl?: string;
  }>;
}

export async function processAdUploadJob(
  jobId: string,
  metaAdAccountId: string
): Promise<void> {
  const startTime = Date.now();

  try {
    // Load ad account with tenant
    const adAccount = await db.metaAdAccount.findUnique({
      where: { id: metaAdAccountId },
      include: { tenant: true },
    });

    if (!adAccount) {
      await markJobFailed(jobId, 'Ad account not found');
      return;
    }

    const accessToken = decryptIfPresent(adAccount.metaAccessToken);
    const driveApiKey = decryptIfPresent(adAccount.driveApiKey);

    if (!accessToken || !adAccount.metaAdAccountId) {
      await markJobFailed(jobId, 'Missing Meta API credentials');
      return;
    }

    if (!driveApiKey || !adAccount.driveFolderId) {
      await markJobFailed(jobId, 'Missing Google Drive configuration');
      return;
    }

    // Scan Drive for creative files
    const files = await listDriveFiles(driveApiKey, adAccount.driveFolderId);
    logger.info({ jobId, fileCount: files.length }, 'Drive scan complete');

    // Get existing managed ads to skip duplicates
    const existingAds = await db.managedAd.findMany({
      where: { metaAdAccountId },
      select: { driveFileId: true },
    });
    const existingFileIds = new Set(existingAds.map((a) => a.driveFileId));

    const newFiles = files.filter((f) => !existingFileIds.has(f.id));

    await db.adUploadJob.update({
      where: { id: jobId },
      data: { totalFiles: newFiles.length },
    });

    if (newFiles.length === 0) {
      await markJobCompleted(jobId, startTime, 0, 0, 0);
      return;
    }

    // Read copies.json
    const copiesData = await readCopiesJson(driveApiKey, adAccount.driveFolderId);

    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    // Find or create campaign and adset for this account
    // We use a default campaign/adset naming convention
    const campaignId = await ensureCampaign(accessToken, adAccount.metaAdAccountId, adAccount.metaPageId);
    const adSetId = await ensureAdSet(accessToken, adAccount.metaAdAccountId, campaignId);

    for (const file of newFiles) {
      try {
        // Get copy for this file
        const copy = getCopyForFile(copiesData, file.name);

        if (!copy.linkUrl) {
          skippedCount++;
          logger.warn({ jobId, fileName: file.name }, 'Skipped: no link URL configured');
          continue;
        }

        // Download file from Drive
        const fileBuffer = await downloadDriveFile(driveApiKey, file.id);

        const isImage = IMAGE_MIMES.includes(file.mimeType);
        const isVideo = VIDEO_MIMES.includes(file.mimeType);

        let imageHash: string | undefined;
        let videoId: string | undefined;

        if (isImage) {
          imageHash = await uploadImageToMeta(accessToken, adAccount.metaAdAccountId, fileBuffer, file.name);
        } else if (isVideo) {
          videoId = await uploadVideoToMeta(accessToken, adAccount.metaAdAccountId, fileBuffer, file.name);
        }

        // Create ad creative + ad
        const result = await createMetaAd({
          accessToken,
          adAccountId: adAccount.metaAdAccountId,
          pageId: adAccount.metaPageId ?? '',
          campaignId,
          adSetId,
          name: file.name,
          imageHash,
          videoId,
          headline: copy.headline,
          bodyText: copy.body,
          callToAction: copy.callToAction,
          linkUrl: copy.linkUrl,
        });

        // Save to DB
        await db.managedAd.create({
          data: {
            metaAdAccountId,
            metaCampaignId: campaignId,
            metaAdSetId: adSetId,
            metaAdId: result.adId,
            metaCreativeId: result.creativeId,
            creativeName: file.name,
            creativeType: isImage ? 'IMAGE' : 'VIDEO',
            driveFileId: file.id,
            headline: copy.headline,
            bodyText: copy.body,
            callToAction: copy.callToAction,
            linkUrl: copy.linkUrl,
            status: 'ACTIVE',
          },
        });

        successCount++;
        logger.info({ jobId, fileName: file.name, adId: result.adId }, 'Ad created successfully');
      } catch (err) {
        failedCount++;
        const errMsg = (err as Error).message;
        logger.error({ jobId, fileName: file.name, error: errMsg }, 'Failed to create ad');

        // Still record it as a managed ad with error
        await db.managedAd.create({
          data: {
            metaAdAccountId,
            creativeName: file.name,
            creativeType: IMAGE_MIMES.includes(file.mimeType) ? 'IMAGE' : 'VIDEO',
            driveFileId: file.id,
            status: 'ERROR',
            errorMessage: errMsg,
          },
        });
      }
    }

    await markJobCompleted(jobId, startTime, successCount, failedCount, skippedCount);

    // Send notification
    await sendUploadNotification(adAccount, successCount, failedCount, skippedCount);
  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error({ jobId, error: errMsg }, 'Upload job failed');
    await markJobFailed(jobId, errMsg);
  }
}

// --- Drive helpers ---

async function listDriveFiles(apiKey: string, folderId: string): Promise<DriveFile[]> {
  const mimeQuery = SUPPORTED_MIMES.map((m) => `mimeType='${m}'`).join(' or ');
  const query = `'${folderId}' in parents and (${mimeQuery}) and trashed=false`;
  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    fields: 'files(id,name,mimeType,size)',
    orderBy: 'createdTime desc',
    pageSize: '100',
  });

  const res = await fetch(`${DRIVE_API_BASE}/files?${params.toString()}`);
  if (!res.ok) throw new Error(`Drive API error: ${res.status}`);

  const data = (await res.json()) as { files: DriveFile[] };
  return data.files || [];
}

async function downloadDriveFile(apiKey: string, fileId: string): Promise<Buffer> {
  const params = new URLSearchParams({ key: apiKey, alt: 'media' });
  const res = await fetch(`${DRIVE_API_BASE}/files/${fileId}?${params.toString()}`);
  if (!res.ok) throw new Error(`Drive download error: ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function readCopiesJson(apiKey: string, folderId: string): Promise<CopiesJson | null> {
  const query = `'${folderId}' in parents and name='copies.json' and trashed=false`;
  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    fields: 'files(id)',
    pageSize: '1',
  });

  const res = await fetch(`${DRIVE_API_BASE}/files?${params.toString()}`);
  if (!res.ok) return null;

  const data = (await res.json()) as { files: Array<{ id: string }> };
  if (!data.files?.length) return null;

  const buffer = await downloadDriveFile(apiKey, data.files[0].id);
  try {
    return JSON.parse(buffer.toString('utf-8')) as CopiesJson;
  } catch {
    return null;
  }
}

function getCopyForFile(copiesData: CopiesJson | null, fileName: string) {
  const defaults = {
    headline: copiesData?.defaultHeadline ?? 'Shop Now',
    body: copiesData?.defaultBody ?? '',
    callToAction: copiesData?.defaultCallToAction ?? 'SHOP_NOW',
    linkUrl: copiesData?.defaultLinkUrl ?? '',
  };

  if (!copiesData?.copies) return defaults;

  const entry = copiesData.copies.find(
    (c) => c.fileName.toLowerCase() === fileName.toLowerCase()
  );

  if (!entry) return defaults;

  return {
    headline: entry.headline || defaults.headline,
    body: entry.body || defaults.body,
    callToAction: entry.callToAction || defaults.callToAction,
    linkUrl: entry.linkUrl || defaults.linkUrl,
  };
}

// --- Meta helpers ---

async function uploadImageToMeta(
  accessToken: string,
  adAccountId: string,
  buffer: Buffer,
  fileName: string
): Promise<string> {
  const formData = new FormData();
  formData.append('access_token', accessToken);
  formData.append('filename', fileName);
  formData.append('bytes', new Blob([new Uint8Array(buffer)]), fileName);

  const res = await fetch(`${META_BASE_URL}/${adAccountId}/adimages`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) throw new Error(`Meta image upload failed: ${res.status}`);

  const data = (await res.json()) as { images: Record<string, { hash: string }> };
  const imageData = Object.values(data.images)[0];
  if (!imageData) throw new Error('No image hash returned');

  return imageData.hash;
}

async function uploadVideoToMeta(
  accessToken: string,
  adAccountId: string,
  buffer: Buffer,
  fileName: string
): Promise<string> {
  const formData = new FormData();
  formData.append('access_token', accessToken);
  formData.append('title', fileName);
  formData.append('source', new Blob([new Uint8Array(buffer)]), fileName);

  const res = await fetch(`${META_BASE_URL}/${adAccountId}/advideos`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) throw new Error(`Meta video upload failed: ${res.status}`);

  const data = (await res.json()) as { id: string };
  return data.id;
}

async function ensureCampaign(
  accessToken: string,
  adAccountId: string,
  _pageId: string | null
): Promise<string> {
  // Check for existing LabelFlow campaign
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: 'id,name',
    filtering: JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: 'LF_Auto' }]),
    limit: '1',
  });

  const res = await fetch(`${META_BASE_URL}/${adAccountId}/campaigns?${params.toString()}`);
  if (res.ok) {
    const data = (await res.json()) as { data: Array<{ id: string }> };
    if (data.data?.length) return data.data[0].id;
  }

  // Create new campaign
  const createRes = await fetch(`${META_BASE_URL}/${adAccountId}/campaigns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: accessToken,
      name: 'LF_Auto_Campaign',
      objective: 'OUTCOME_SALES',
      status: 'ACTIVE',
      special_ad_categories: [],
    }),
  });

  if (!createRes.ok) throw new Error(`Failed to create campaign: ${createRes.status}`);

  const campaign = (await createRes.json()) as { id: string };
  return campaign.id;
}

async function ensureAdSet(
  accessToken: string,
  adAccountId: string,
  campaignId: string
): Promise<string> {
  // Check for existing adset
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: 'id,name',
    filtering: JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: 'LF_Auto' }]),
    limit: '1',
  });

  const res = await fetch(`${META_BASE_URL}/${campaignId}/adsets?${params.toString()}`);
  if (res.ok) {
    const data = (await res.json()) as { data: Array<{ id: string }> };
    if (data.data?.length) return data.data[0].id;
  }

  // Create new adset with broad targeting
  const createRes = await fetch(`${META_BASE_URL}/${adAccountId}/adsets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: accessToken,
      name: 'LF_Auto_AdSet',
      campaign_id: campaignId,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      daily_budget: 2000, // $20 in cents
      targeting: { geo_locations: { countries: ['UY'] } },
      status: 'ACTIVE',
    }),
  });

  if (!createRes.ok) throw new Error(`Failed to create adset: ${createRes.status}`);

  const adSet = (await createRes.json()) as { id: string };
  return adSet.id;
}

async function createMetaAd(params: {
  accessToken: string;
  adAccountId: string;
  pageId: string;
  campaignId: string;
  adSetId: string;
  name: string;
  imageHash?: string;
  videoId?: string;
  headline: string;
  bodyText: string;
  callToAction: string;
  linkUrl: string;
}): Promise<{ creativeId: string; adId: string }> {
  const objectStorySpec: Record<string, unknown> = {
    page_id: params.pageId,
  };

  if (params.videoId) {
    objectStorySpec.video_data = {
      video_id: params.videoId,
      title: params.headline,
      message: params.bodyText,
      call_to_action: { type: params.callToAction, value: { link: params.linkUrl } },
    };
  } else if (params.imageHash) {
    objectStorySpec.link_data = {
      image_hash: params.imageHash,
      link: params.linkUrl,
      message: params.bodyText,
      name: params.headline,
      call_to_action: { type: params.callToAction, value: { link: params.linkUrl } },
    };
  }

  // Create creative
  const creativeRes = await fetch(`${META_BASE_URL}/${params.adAccountId}/adcreatives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: params.accessToken,
      name: `LF_${params.name}`,
      object_story_spec: objectStorySpec,
    }),
  });

  if (!creativeRes.ok) throw new Error(`Failed to create creative: ${creativeRes.status}`);
  const creative = (await creativeRes.json()) as { id: string };

  // Create ad
  const adRes = await fetch(`${META_BASE_URL}/${params.adAccountId}/ads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: params.accessToken,
      name: `LF_Ad_${params.name}`,
      adset_id: params.adSetId,
      creative: { creative_id: creative.id },
      status: 'ACTIVE',
    }),
  });

  if (!adRes.ok) throw new Error(`Failed to create ad: ${adRes.status}`);
  const ad = (await adRes.json()) as { id: string };

  return { creativeId: creative.id, adId: ad.id };
}

// --- Job state helpers ---

async function markJobCompleted(
  jobId: string,
  startTime: number,
  successCount: number,
  failedCount: number,
  skippedCount: number
): Promise<void> {
  await db.adUploadJob.update({
    where: { id: jobId },
    data: {
      status: failedCount > 0 && successCount > 0 ? 'PARTIAL' : failedCount > 0 ? 'FAILED' : 'COMPLETED',
      finishedAt: new Date(),
      durationMs: Date.now() - startTime,
      successCount,
      failedCount,
      skippedCount,
    },
  });
}

async function markJobFailed(jobId: string, errorMessage: string): Promise<void> {
  await db.adUploadJob.update({
    where: { id: jobId },
    data: {
      status: 'FAILED',
      finishedAt: new Date(),
      errorMessage,
    },
  });
}

// --- Notifications ---

async function sendUploadNotification(
  adAccount: { notifyWebhook: string | null; notifyEmail: string | null },
  successCount: number,
  failedCount: number,
  skippedCount: number
): Promise<void> {
  if (adAccount.notifyWebhook) {
    try {
      await fetch(adAccount.notifyWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'scan_completed',
          title: 'Escaneo de creativos completado',
          message: `Subidos: ${successCount}, Fallidos: ${failedCount}, Omitidos: ${skippedCount}`,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch {
      // Non-critical
    }
  }
}
