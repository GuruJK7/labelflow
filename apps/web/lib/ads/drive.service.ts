/**
 * Google Drive API service for scanning creative files.
 * Reads images/videos from a configured Drive folder and a copies.json for ad copy.
 */

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_DOWNLOAD_BASE = 'https://www.googleapis.com/drive/v3/files';

const IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
];

const VIDEO_MIMES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
];

const SUPPORTED_MIMES = [...IMAGE_MIMES, ...VIDEO_MIMES];

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdTime: string;
}

export interface CopyEntry {
  fileName: string;
  headline: string;
  body: string;
  callToAction?: string;
  linkUrl?: string;
}

export interface CopiesJson {
  defaultHeadline: string;
  defaultBody: string;
  defaultCallToAction: string;
  defaultLinkUrl: string;
  copies: CopyEntry[];
}

/**
 * List creative files (images and videos) from a Drive folder.
 */
export async function listCreativeFiles(
  apiKey: string,
  folderId: string
): Promise<DriveFile[]> {
  const mimeQuery = SUPPORTED_MIMES.map(
    (m) => `mimeType='${m}'`
  ).join(' or ');

  const query = `'${folderId}' in parents and (${mimeQuery}) and trashed=false`;

  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    fields: 'files(id,name,mimeType,size,createdTime)',
    orderBy: 'createdTime desc',
    pageSize: '100',
  });

  const res = await fetch(`${DRIVE_API_BASE}/files?${params.toString()}`);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive API error (${res.status}): ${err}`);
  }

  const data = (await res.json()) as { files: DriveFile[] };
  return data.files || [];
}

/**
 * Download a file from Google Drive as a Buffer.
 */
export async function downloadFile(
  apiKey: string,
  fileId: string
): Promise<Buffer> {
  const params = new URLSearchParams({
    key: apiKey,
    alt: 'media',
  });

  const res = await fetch(
    `${DRIVE_DOWNLOAD_BASE}/${fileId}?${params.toString()}`
  );

  if (!res.ok) {
    throw new Error(`Drive download error (${res.status}): ${await res.text()}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Read and parse the copies.json file from the Drive folder.
 * This file contains ad copy (headline, body text) for each creative.
 */
export async function readCopiesJson(
  apiKey: string,
  folderId: string
): Promise<CopiesJson | null> {
  // Search for copies.json in folder
  const query = `'${folderId}' in parents and name='copies.json' and trashed=false`;
  const params = new URLSearchParams({
    key: apiKey,
    q: query,
    fields: 'files(id,name)',
    pageSize: '1',
  });

  const res = await fetch(`${DRIVE_API_BASE}/files?${params.toString()}`);

  if (!res.ok) return null;

  const data = (await res.json()) as { files: Array<{ id: string; name: string }> };
  if (!data.files || data.files.length === 0) return null;

  const fileId = data.files[0].id;
  const buffer = await downloadFile(apiKey, fileId);
  const text = buffer.toString('utf-8');

  try {
    return JSON.parse(text) as CopiesJson;
  } catch {
    return null;
  }
}

/**
 * Get the ad copy for a specific file name from copies.json data.
 * Falls back to defaults if no specific copy is found.
 */
export function getCopyForFile(
  copiesData: CopiesJson | null,
  fileName: string
): {
  headline: string;
  body: string;
  callToAction: string;
  linkUrl: string;
} {
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

/**
 * Check if a file is an image by its MIME type.
 */
export function isImageFile(mimeType: string): boolean {
  return IMAGE_MIMES.includes(mimeType);
}

/**
 * Check if a file is a video by its MIME type.
 */
export function isVideoFile(mimeType: string): boolean {
  return VIDEO_MIMES.includes(mimeType);
}
