export const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
export const MIN_REFRESH_DELAY_MS = 1000;

function decodeBase64Url(value) {
  if (!value || typeof value !== 'string') return null;

  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');

  try {
    if (typeof atob === 'function') {
      return atob(padded);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(padded, 'base64').toString('utf8');
    }
  } catch {
    return null;
  }

  return null;
}

export function decodeJwtPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;

  const decoded = decodeBase64Url(parts[1]);
  if (!decoded) return null;

  try {
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function getTokenExpiryMs(token) {
  const payload = decodeJwtPayload(token);
  const expSeconds = Number(payload?.exp);
  if (!Number.isFinite(expSeconds) || expSeconds <= 0) {
    return null;
  }
  return expSeconds * 1000;
}

export function isTokenExpiringSoon(
  token,
  { nowMs = Date.now(), skewMs = TOKEN_REFRESH_SKEW_MS } = {}
) {
  const expiryMs = getTokenExpiryMs(token);
  if (!Number.isFinite(expiryMs)) return false;
  return expiryMs <= (nowMs + skewMs);
}

export function getRefreshDelayMs(
  token,
  {
    nowMs = Date.now(),
    skewMs = TOKEN_REFRESH_SKEW_MS,
    minDelayMs = MIN_REFRESH_DELAY_MS,
  } = {}
) {
  const expiryMs = getTokenExpiryMs(token);
  if (!Number.isFinite(expiryMs)) return null;

  const refreshAtMs = expiryMs - skewMs;
  return Math.max(refreshAtMs - nowMs, minDelayMs);
}
