import apiClient from '../api/client';
import { DEFAULT_AVATAR_THUMBNAIL_SIZE_PX } from './imageUpload';

export const DEFAULT_MAX_IMAGE_WIDTH = 1920;
export const DEFAULT_AVATAR_THUMBNAIL_SIZE = DEFAULT_AVATAR_THUMBNAIL_SIZE_PX;

function normalizeMaxImageWidth(value) {
  const width = Number(value);
  if (!Number.isFinite(width) || width <= 0) {
    return DEFAULT_MAX_IMAGE_WIDTH;
  }
  return Math.round(width);
}

function normalizeAvatarThumbnailSize(value) {
  const width = Number(value);
  if (!Number.isFinite(width) || width < 64) {
    return DEFAULT_AVATAR_THUMBNAIL_SIZE;
  }
  return Math.round(width);
}

function normalizePublicSettings(data = {}) {
  return {
    SSO_enabled: !!data.SSO_enabled,
    SSO_institutionName: String(data.SSO_institutionName || '').trim(),
    restrictDomain: !!data.restrictDomain,
    requireVerified: !!data.requireVerified,
    registrationDisabled: !!data.registrationDisabled,
    Jitsi_Enabled: !!data.Jitsi_Enabled,
    timeFormat: data.timeFormat === '12h' ? '12h' : '24h',
    maxImageWidth: normalizeMaxImageWidth(data.maxImageWidth),
    avatarThumbnailSize: normalizeAvatarThumbnailSize(data.avatarThumbnailSize),
  };
}

let cachedPublicSettings = null;
let publicSettingsPromise = null;

export async function getPublicSettings({ force = false } = {}) {
  if (!force && cachedPublicSettings) {
    return cachedPublicSettings;
  }

  if (!force && publicSettingsPromise) {
    return publicSettingsPromise;
  }

  publicSettingsPromise = apiClient.get('/settings/public')
    .then(({ data }) => {
      cachedPublicSettings = normalizePublicSettings(data);
      return cachedPublicSettings;
    })
    .catch(() => {
      cachedPublicSettings = normalizePublicSettings();
      return cachedPublicSettings;
    })
    .finally(() => {
      publicSettingsPromise = null;
    });

  return publicSettingsPromise;
}

export function clearPublicSettingsCache() {
  cachedPublicSettings = null;
  publicSettingsPromise = null;
}

export function getDefaultMaxImageWidth() {
  return DEFAULT_MAX_IMAGE_WIDTH;
}

export function getDefaultAvatarThumbnailSize() {
  return DEFAULT_AVATAR_THUMBNAIL_SIZE;
}
