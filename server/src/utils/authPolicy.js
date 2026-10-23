export const DEFAULT_TOKEN_EXPIRY_MINUTES = 120;
export const DEFAULT_MAX_IMAGE_WIDTH = 1920;
export const DEFAULT_AVATAR_THUMBNAIL_SIZE = 512;
export const DEFAULT_SSO_ROUTE_MODE = 'legacy';
export const DEFAULT_SSO_CLOCK_SKEW_MS = 60 * 1000;
export const DEFAULT_BACKUP_TIME_LOCAL = '02:00';
export const DEFAULT_BACKUP_RETENTION_DAILY = 7;
export const DEFAULT_BACKUP_RETENTION_WEEKLY = 4;
export const DEFAULT_BACKUP_RETENTION_MONTHLY = 12;
export const DEFAULT_BACKUP_MANAGER_CHECK_INTERVAL_SECONDS = 60;
export const DEFAULT_BACKUP_MANAGER_HOST_PATH = './backups';
export const BACKUP_MANAGER_STALE_MULTIPLIER = 3;
export const BACKUP_MANAGER_MIN_STALE_MS = 3 * 60 * 1000;

export const SSO_PROVIDER_ROUTES = {
  legacy: {
    callbackPath: '/SSO/SAML2',
    logoutCallbackPath: '/SSO/SAML2/logout',
  },
  api_v1: {
    callbackPath: '/api/v1/auth/sso/callback',
    logoutCallbackPath: '/api/v1/auth/sso/logout',
  },
};

function normalizeInteger(value, fallback, { min = Number.NEGATIVE_INFINITY } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  if (normalized < min) return fallback;
  return normalized;
}

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return fallback;
}

function normalizeString(value, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

export function normalizeAllowedDomains(value) {
  const rawDomains = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];

  return [...new Set(
    rawDomains
      .map((entry) => String(entry || '').trim().toLowerCase())
      .filter(Boolean)
  )];
}

export function isAdminUser(user = {}) {
  const roles = user?.profile?.roles || [];
  return Array.isArray(roles) && roles.includes('admin');
}

export function isSsoEnabled(settings = {}) {
  return settings?.SSO_enabled === true;
}

export function isSelfRegistrationDisabled(settings = {}) {
  return settings?.registrationDisabled === true;
}

export function hasAllowedEmailDomains(settings = {}) {
  return normalizeAllowedDomains(settings?.allowedDomains).length > 0;
}

export function isDomainRestrictionEnabled(settings = {}) {
  return !isSsoEnabled(settings)
    && (
      settings?.restrictDomain === true
      || hasAllowedEmailDomains(settings)
    );
}

export function isVerifiedEmailRequired(settings = {}) {
  return settings?.requireVerified === true
    || (!isSsoEnabled(settings) && hasAllowedEmailDomains(settings));
}

export function isUserEmailVerified(user = {}) {
  return Array.isArray(user?.emails) && user.emails.some((entry) => entry?.verified === true);
}

export function canUseEmailLogin(user = {}, settings = {}) {
  if (isAdminUser(user)) return true;
  if (!isSsoEnabled(settings)) return true;
  return user?.allowEmailLogin === true;
}

export function shouldLockLocalProfileEdits(user = {}, settings = {}) {
  return isSsoEnabled(settings) && !canUseEmailLogin(user, settings);
}

export function normalizeTokenExpiryMinutes(value) {
  return normalizeInteger(value, DEFAULT_TOKEN_EXPIRY_MINUTES, { min: 1 });
}

export function normalizeMaxImageWidth(value) {
  return normalizeInteger(value, DEFAULT_MAX_IMAGE_WIDTH, { min: 1 });
}

export function normalizeAvatarThumbnailSize(value) {
  return normalizeInteger(value, DEFAULT_AVATAR_THUMBNAIL_SIZE, { min: 64 });
}

export function normalizeBackupTimeLocal(value) {
  const normalized = String(value || '').trim();
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(normalized)) {
    return normalized;
  }
  return DEFAULT_BACKUP_TIME_LOCAL;
}

export function normalizeBackupRetentionCount(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  return normalizeInteger(value, fallback, { min: 0 });
}

export function normalizeBackupManagerCheckIntervalSeconds(value) {
  return normalizeInteger(value, DEFAULT_BACKUP_MANAGER_CHECK_INTERVAL_SECONDS, { min: 5 });
}

export function normalizeBackupManagerHostPath(value) {
  return normalizeString(value, DEFAULT_BACKUP_MANAGER_HOST_PATH);
}

export function normalizeBackupManagerStatus(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === 'healthy' || normalized === 'warning' || normalized === 'error' || normalized === 'unknown') {
    return normalized;
  }
  return 'unknown';
}

export function getBackupManagerHealth(settings = {}, { now = new Date() } = {}) {
  const checkIntervalSeconds = normalizeBackupManagerCheckIntervalSeconds(
    settings?.backupManagerCheckIntervalSeconds
  );
  const hostPath = normalizeBackupManagerHostPath(settings?.backupManagerHostPath);
  const rawStatus = normalizeBackupManagerStatus(settings?.backupManagerStatus);
  const rawMessage = normalizeString(settings?.backupManagerMessage);
  const parsedLastSeenAt = settings?.backupManagerLastSeenAt
    ? new Date(settings.backupManagerLastSeenAt)
    : null;
  const lastSeenAt = parsedLastSeenAt && !Number.isNaN(parsedLastSeenAt.getTime())
    ? parsedLastSeenAt
    : null;
  const staleAfterMs = Math.max(
    checkIntervalSeconds * BACKUP_MANAGER_STALE_MULTIPLIER * 1000,
    BACKUP_MANAGER_MIN_STALE_MS
  );
  const isStale = Boolean(lastSeenAt) && (now.getTime() - lastSeenAt.getTime()) > staleAfterMs;

  let status = rawStatus;
  let message = rawMessage;

  if (!lastSeenAt && status === 'unknown' && !message) {
    message = `Backup manager has not reported in yet. Make sure the backup-manager service is running and ${hostPath} on the host is writable.`;
  }

  if (isStale) {
    status = 'stale';
    if (!message || rawStatus === 'healthy' || rawStatus === 'warning' || rawStatus === 'unknown') {
      message = `Backup manager heartbeat is stale. Check the backup-manager service and confirm ${hostPath} on the host is writable.`;
    }
  } else if (status === 'healthy' && !message) {
    message = `Backup manager is running. Archives are written to ${hostPath} on the host.`;
  } else if (status === 'error' && !message) {
    message = `Backup manager reported an error. Check the backup-manager service and ${hostPath} on the host.`;
  } else if (status === 'warning' && !message) {
    message = `Backup manager reported a warning. Check the latest backup details below and confirm ${hostPath} on the host is writable.`;
  }

  return {
    status,
    message,
    lastSeenAt,
    checkIntervalSeconds,
    hostPath,
    isStale,
  };
}

export function normalizeSsoRouteMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'legacy' || normalized === 'api_v1') {
    return normalized;
  }
  return DEFAULT_SSO_ROUTE_MODE;
}

export function normalizeSsoClockSkewMs(value) {
  return normalizeInteger(value, DEFAULT_SSO_CLOCK_SKEW_MS, { min: -1 });
}

export function parseAuthnContext(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getSamlAdvancedSettings(settings = {}) {
  return {
    // Secure-by-default: require a valid signature on the SAML assertion (the
    // node-saml / passport-saml default). This prevents forged, unsigned
    // assertions from being accepted since SSO attributes grant roles. Response
    // envelope signing stays optional so IdPs that only sign the assertion still
    // work; deployments can opt into it explicitly.
    wantAssertionsSigned: normalizeBoolean(settings?.SSO_wantAssertionsSigned, true),
    wantAuthnResponseSigned: normalizeBoolean(settings?.SSO_wantAuthnResponseSigned, false),
    acceptedClockSkewMs: normalizeSsoClockSkewMs(settings?.SSO_acceptedClockSkewMs),
    disableRequestedAuthnContext: normalizeBoolean(settings?.SSO_disableRequestedAuthnContext, true),
    authnContext: parseAuthnContext(settings?.SSO_authnContext),
    routeMode: normalizeSsoRouteMode(settings?.SSO_routeMode),
  };
}

export function getSsoProviderRoutes(settings = {}) {
  const routeMode = normalizeSsoRouteMode(settings?.SSO_routeMode);
  return SSO_PROVIDER_ROUTES[routeMode] || SSO_PROVIDER_ROUTES[DEFAULT_SSO_ROUTE_MODE];
}

export function normalizeSettingsPayload(settings = {}) {
  const backupManagerHealth = getBackupManagerHealth(settings);
  const allowedDomains = normalizeAllowedDomains(settings?.allowedDomains);
  const ssoEnabled = isSsoEnabled(settings);
  return {
    ...settings,
    allowedDomains,
    restrictDomain: !ssoEnabled
      && (normalizeBoolean(settings?.restrictDomain, false) || allowedDomains.length > 0),
    requireVerified: normalizeBoolean(settings?.requireVerified, false)
      || (!ssoEnabled && allowedDomains.length > 0),
    registrationDisabled: normalizeBoolean(settings?.registrationDisabled, false),
    tokenExpiryMinutes: normalizeTokenExpiryMinutes(settings?.tokenExpiryMinutes),
    maxImageWidth: normalizeMaxImageWidth(settings?.maxImageWidth),
    avatarThumbnailSize: normalizeAvatarThumbnailSize(settings?.avatarThumbnailSize),
    backupEnabled: settings?.backupEnabled === true,
    backupTimeLocal: normalizeBackupTimeLocal(settings?.backupTimeLocal),
    backupRetentionDaily: normalizeBackupRetentionCount(
      settings?.backupRetentionDaily,
      DEFAULT_BACKUP_RETENTION_DAILY
    ),
    backupRetentionWeekly: normalizeBackupRetentionCount(
      settings?.backupRetentionWeekly,
      DEFAULT_BACKUP_RETENTION_WEEKLY
    ),
    backupRetentionMonthly: normalizeBackupRetentionCount(
      settings?.backupRetentionMonthly,
      DEFAULT_BACKUP_RETENTION_MONTHLY
    ),
    backupManagerLastSeenAt: backupManagerHealth.lastSeenAt,
    backupManagerCheckIntervalSeconds: backupManagerHealth.checkIntervalSeconds,
    backupManagerStatus: backupManagerHealth.status,
    backupManagerMessage: backupManagerHealth.message,
    backupManagerHostPath: backupManagerHealth.hostPath,
    backupManagerIsStale: backupManagerHealth.isStale,
    SSO_routeMode: normalizeSsoRouteMode(settings?.SSO_routeMode),
    SSO_wantAssertionsSigned: normalizeBoolean(settings?.SSO_wantAssertionsSigned, true),
    SSO_wantAuthnResponseSigned: normalizeBoolean(settings?.SSO_wantAuthnResponseSigned, false),
    SSO_acceptedClockSkewMs: normalizeSsoClockSkewMs(settings?.SSO_acceptedClockSkewMs),
    SSO_disableRequestedAuthnContext: normalizeBoolean(settings?.SSO_disableRequestedAuthnContext, true),
    SSO_authnContext: String(settings?.SSO_authnContext || '').trim(),
  };
}
