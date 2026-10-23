function toDateOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function toTimestamp(value) {
  const parsed = toDateOrNull(value);
  return parsed ? parsed.getTime() : 0;
}

export function normalizeIpAddress(value) {
  let normalized = String(value || '').trim();
  if (!normalized) return '';

  if (normalized.includes(',')) {
    [normalized] = normalized.split(',');
    normalized = normalized.trim();
  }

  const bracketedIpv6Match = normalized.match(/^\[([^[\]]+)\](?::\d+)?$/);
  if (bracketedIpv6Match) {
    normalized = bracketedIpv6Match[1];
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(normalized)) {
    normalized = normalized.replace(/:\d+$/, '');
  }

  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice('::ffff:'.length);
  }

  return normalized.trim();
}

export function getRequestIp(request) {
  // Prefer request.ip: when the app is configured with trustProxy it already
  // resolves the real client from X-Forwarded-For, and when it is not it stays
  // the direct socket address. Reading the forwarding headers directly here
  // would trust an unauthenticated, client-spoofable value, so we don't.
  return normalizeIpAddress(
    request?.ip
      || request?.socket?.remoteAddress
      || request?.raw?.socket?.remoteAddress
      || ''
  );
}

export function buildRefreshSessionEntry(sessionId, maxAgeMs, now = new Date(), ipAddress = '') {
  const normalizedIp = normalizeIpAddress(ipAddress);
  return {
    sessionId,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + maxAgeMs),
    ...(normalizedIp ? { ipAddress: normalizedIp } : {}),
  };
}

function getSessionCreatedAt(entry) {
  return toDateOrNull(entry?.createdAt) || toDateOrNull(entry?.lastUsedAt) || null;
}

function buildSessionAuditEntry(entry, index, nowMs) {
  const createdAt = getSessionCreatedAt(entry);
  const lastUsedAt = toDateOrNull(entry?.lastUsedAt) || createdAt;
  const expiresAt = toDateOrNull(entry?.expiresAt);
  return {
    sessionId: typeof entry?.sessionId === 'string' && entry.sessionId
      ? entry.sessionId
      : `legacy-${index}`,
    createdAt,
    lastUsedAt,
    expiresAt,
    ipAddress: normalizeIpAddress(entry?.ipAddress),
    isActive: !expiresAt || expiresAt.getTime() > nowMs,
  };
}

export function getRefreshSessionAudit(user, nowMs = Date.now()) {
  const loginTokens = Array.isArray(user?.services?.resume?.loginTokens)
    ? user.services.resume.loginTokens
    : [];

  return loginTokens
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry, index) => buildSessionAuditEntry(entry, index, nowMs))
    .sort((a, b) => {
      const aTime = toTimestamp(a.createdAt || a.lastUsedAt || a.expiresAt);
      const bTime = toTimestamp(b.createdAt || b.lastUsedAt || b.expiresAt);
      return bTime - aTime;
    });
}

export function getActiveLoginSessions(user, nowMs = Date.now()) {
  return getRefreshSessionAudit(user, nowMs).filter((entry) => entry.isActive);
}

export function getLastLoginAudit(user, nowMs = Date.now()) {
  const sessions = getRefreshSessionAudit(user, nowMs);
  const latestSession = sessions[0] || null;
  const explicitLastLogin = toDateOrNull(user?.lastLogin);
  const sessionLastLogin = latestSession?.createdAt || latestSession?.lastUsedAt || null;
  const explicitLastLoginIp = normalizeIpAddress(user?.lastLoginIp);
  const useSessionAsSource = !!sessionLastLogin
    && (!explicitLastLogin || sessionLastLogin.getTime() > explicitLastLogin.getTime());

  return {
    lastLogin: useSessionAsSource ? sessionLastLogin : (explicitLastLogin || sessionLastLogin || null),
    lastLoginIp: useSessionAsSource
      ? (latestSession?.ipAddress || explicitLastLoginIp)
      : (explicitLastLoginIp || latestSession?.ipAddress || ''),
    activeSessions: sessions.filter((entry) => entry.isActive),
  };
}
