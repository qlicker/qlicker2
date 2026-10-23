import jwt from 'jsonwebtoken';
import User from '../models/User.js';

function buildRequestUser(user) {
  return {
    userId: user._id,
    roles: user?.profile?.roles || [],
  };
}

function hasActiveRefreshSession(user, sessionId, nowMs = Date.now()) {
  const loginTokens = user?.services?.resume?.loginTokens;
  if (!Array.isArray(loginTokens) || !sessionId) return false;
  return loginTokens.some((entry) => {
    if (!entry || typeof entry !== 'object' || entry.sessionId !== sessionId) return false;
    const expiresAtMs = entry.expiresAt ? new Date(entry.expiresAt).getTime() : NaN;
    return !Number.isFinite(expiresAtMs) || expiresAtMs > nowMs;
  });
}

function hasMatchingLegacyRefreshVersion(user, version) {
  return Number.isInteger(version) && version >= 0
    && Math.max(0, Number(user?.refreshTokenVersion) || 0) === version;
}

export async function authenticate(request, reply) {
  try {
    await request.jwtVerify();
    const user = await User.findById(request.user?.userId)
      .select('_id disabled profile.roles')
      .lean();
    if (!user || user.disabled === true) {
      reply.code(403).send({
        error: 'Forbidden',
        code: 'ACCOUNT_DISABLED',
        message: 'This account has been disabled. Please contact an administrator.',
      });
      return;
    }
    // Authorization roles come from the database, not the token payload, so
    // demotions/role removals take effect immediately instead of at token expiry.
    request.user = buildRequestUser(user);
    request.server.recordAuthenticatedActivity?.(request.user);
  } catch (err) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' });
  }
}

export async function authenticateAccessTokenOrRefreshCookie(request, reply) {
  try {
    await request.jwtVerify();
    const user = await User.findById(request.user?.userId)
      .select('_id disabled profile.roles')
      .lean();
    if (!user || user.disabled === true) {
      reply.code(403).send({
        error: 'Forbidden',
        code: 'ACCOUNT_DISABLED',
        message: 'This account has been disabled. Please contact an administrator.',
      });
      return;
    }
    request.user = buildRequestUser(user);
    request.server.recordAuthenticatedActivity?.(request.user);
    return;
  } catch {
    // Fall back to the same-origin refresh cookie for asset requests such as <img>.
  }

  const refreshToken = request.cookies?.refreshToken;
  if (!refreshToken) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' });
    return;
  }

  let payload;
  try {
    payload = jwt.verify(refreshToken, request.server.config.jwtRefreshSecret);
  } catch {
    reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' });
    return;
  }

  if (payload?.type !== 'refresh' || !payload?.userId) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' });
    return;
  }

  const user = await User.findById(payload.userId)
    .select('_id disabled profile.roles refreshTokenVersion services.resume.loginTokens')
    .lean();

  if (!user) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' });
    return;
  }

  if (user.disabled === true) {
    reply.code(403).send({
      error: 'Forbidden',
      code: 'ACCOUNT_DISABLED',
      message: 'This account has been disabled. Please contact an administrator.',
    });
    return;
  }

  const hasValidSession = typeof payload.sessionId === 'string' && payload.sessionId
    ? hasActiveRefreshSession(user, payload.sessionId)
    : hasMatchingLegacyRefreshVersion(user, payload.version);

  if (!hasValidSession) {
    reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or missing token' });
    return;
  }

  request.user = buildRequestUser(user);
  request.server.recordAuthenticatedActivity?.(request.user);
}

export function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return async function checkRole(request, reply) {
    // authenticate first
    await authenticate(request, reply);
    if (reply.sent) return;

    const userRoles = request.user?.roles || [];
    const hasRole = allowed.some((r) => userRoles.includes(r));
    if (!hasRole) {
      reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
    }
  };
}

export function requireRoleFromAccessTokenOrRefreshCookie(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return async function checkRole(request, reply) {
    await authenticateAccessTokenOrRefreshCookie(request, reply);
    if (reply.sent) return;

    const userRoles = request.user?.roles || [];
    const hasRole = allowed.some((role) => userRoles.includes(role));
    if (!hasRole) {
      reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
    }
  };
}
