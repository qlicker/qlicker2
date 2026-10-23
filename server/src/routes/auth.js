import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import {
  isAdminUser,
  canUseEmailLogin,
  getSsoProviderRoutes,
  isDomainRestrictionEnabled,
  isSelfRegistrationDisabled,
  isUserEmailVerified,
  isVerifiedEmailRequired,
  normalizeAllowedDomains,
  normalizeTokenExpiryMinutes,
} from '../utils/authPolicy.js';
import { generateMeteorId } from '../utils/meteorId.js';
import { emailRegex } from '../utils/email.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/email.js';
import { normalizeCertificatePem } from '../utils/certificate.js';
import { buildRefreshSessionEntry, getRequestIp, normalizeIpAddress } from '../utils/sessionAudit.js';
import { getUserAccessFlags } from '../utils/userAccess.js';
import { getOrCreateSettingsDocument } from '../utils/settingsSingleton.js';

const LOGIN_LOCKOUT_THRESHOLD = 5;
const LOGIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000;
// Single-use email tokens must expire. A reset token grants account takeover, so
// keep it short; verification is lower-risk but should still not live forever.
const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function isTimestampWithinTtl(when, ttlMs) {
  const whenMs = when ? new Date(when).getTime() : NaN;
  if (!Number.isFinite(whenMs)) return false;
  const ageMs = Date.now() - whenMs;
  return ageMs >= 0 && ageMs <= ttlMs;
}
const LEGACY_REFRESH_VERSION_QUERY = {
  $or: [
    { refreshTokenVersion: { $exists: false } },
    { refreshTokenVersion: null },
    { refreshTokenVersion: 0 },
  ],
};

function getAttr(profile, key) {
  if (!key || !profile) return '';
  const val = profile[key];
  if (Array.isArray(val)) return val[0] || '';
  return val || '';
}

async function sanitizeUser(user, settings = {}) {
  const obj = user?.toObject ? user.toObject() : { ...user };
  obj.isSSOUser = !!user?.services?.sso?.id;
  obj.isSSOCreatedUser = !!user?.ssoCreated;
  obj.allowEmailLogin = canUseEmailLogin(user, settings);
  obj.lastAuthProvider = user?.lastAuthProvider || '';
  Object.assign(obj, await getUserAccessFlags(user));
  delete obj.services;
  return obj;
}

async function getAuthSettings() {
  return getOrCreateSettingsDocument({ lean: true });
}

async function getTokenExpiryMinutes(settings = null) {
  const resolvedSettings = settings || await getAuthSettings();
  return normalizeTokenExpiryMinutes(resolvedSettings?.tokenExpiryMinutes);
}

async function signAccessToken(app, user, settings = null) {
  const mins = await getTokenExpiryMinutes(settings);
  return app.jwt.sign(
    { userId: user._id, roles: user.profile?.roles || [] },
    { expiresIn: `${mins}m` }
  );
}

function getRefreshTokenVersion(user) {
  return Math.max(0, Number(user?.refreshTokenVersion) || 0);
}

function getRefreshSessionMaxAgeMs(settings = {}) {
  return normalizeTokenExpiryMinutes(settings?.tokenExpiryMinutes) * 60 * 1000;
}

function getRefreshTokenTtlSeconds(sessionEntry, nowMs = Date.now()) {
  const expiresAtMs = sessionEntry?.expiresAt ? new Date(sessionEntry.expiresAt).getTime() : NaN;
  if (!Number.isFinite(expiresAtMs)) return 0;
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}

function signRefreshToken(config, user, sessionId, maxAgeSeconds) {
  return jwt.sign(
    { userId: user._id, type: 'refresh', sessionId },
    config.jwtRefreshSecret,
    { expiresIn: maxAgeSeconds }
  );
}

function ensureResumeLoginTokens(user) {
  if (!user.services) user.services = {};
  if (!user.services.resume) user.services.resume = {};
  if (!Array.isArray(user.services.resume.loginTokens)) {
    user.services.resume.loginTokens = [];
  }
  return user.services.resume.loginTokens;
}

function isManagedRefreshSession(entry) {
  return !!entry && typeof entry === 'object' && typeof entry.sessionId === 'string' && entry.sessionId.length > 0;
}

function pruneRefreshSessions(user, nowMs = Date.now()) {
  const loginTokens = ensureResumeLoginTokens(user);
  user.services.resume.loginTokens = loginTokens.filter((entry) => {
    if (!isManagedRefreshSession(entry)) return true;
    const expiresAtMs = entry.expiresAt ? new Date(entry.expiresAt).getTime() : NaN;
    return !Number.isFinite(expiresAtMs) || expiresAtMs > nowMs;
  });
  return user.services.resume.loginTokens;
}

function issueRefreshSession(user, maxAgeMs, ipAddress = '') {
  pruneRefreshSessions(user);
  const sessionId = crypto.randomBytes(24).toString('hex');
  const sessionEntry = buildRefreshSessionEntry(sessionId, maxAgeMs, new Date(), ipAddress);
  ensureResumeLoginTokens(user).push(sessionEntry);
  return sessionEntry;
}

function rotateRefreshSession(user, currentSessionId, ipAddress = '') {
  pruneRefreshSessions(user);
  const loginTokens = ensureResumeLoginTokens(user);
  const index = loginTokens.findIndex(
    (entry) => isManagedRefreshSession(entry) && entry.sessionId === currentSessionId
  );
  if (index === -1) return null;

  const now = new Date();
  const nextSessionId = crypto.randomBytes(24).toString('hex');
  loginTokens[index].sessionId = nextSessionId;
  loginTokens[index].lastUsedAt = now;
  if (!loginTokens[index].createdAt) loginTokens[index].createdAt = now;
  const normalizedIp = normalizeIpAddress(ipAddress);
  if (normalizedIp) {
    loginTokens[index].ipAddress = normalizedIp;
  }
  return loginTokens[index];
}

function revokeRefreshSession(user, sessionId) {
  pruneRefreshSessions(user);
  const loginTokens = ensureResumeLoginTokens(user);
  const nextTokens = loginTokens.filter(
    (entry) => !(isManagedRefreshSession(entry) && entry.sessionId === sessionId)
  );
  const changed = nextTokens.length !== loginTokens.length;
  user.services.resume.loginTokens = nextTokens;
  return changed;
}

function revokeAllRefreshSessions(user) {
  ensureResumeLoginTokens(user);
  user.services.resume.loginTokens = [];
}

function setRefreshTokenCookie(reply, app, refreshToken, maxAgeSeconds) {
  reply.setCookie('refreshToken', refreshToken, {
    path: '/',
    httpOnly: true,
    secure: app.config.nodeEnv === 'production',
    sameSite: 'strict',
    maxAge: maxAgeSeconds,
  });
}

function clearRefreshTokenCookie(reply) {
  reply.clearCookie('refreshToken', { path: '/' });
}

function isLoginLocked(user) {
  const lockedUntil = user?.loginLockedUntil ? new Date(user.loginLockedUntil) : null;
  return !!lockedUntil && lockedUntil.getTime() > Date.now();
}

function isUserDisabled(user) {
  return user?.disabled === true;
}

function getDisabledAccountMessage() {
  return 'This account has been disabled. Please contact an administrator.';
}

function getEmailVerificationRequiredMessage() {
  return 'You must verify your email address before logging in.';
}

function prepareLoginLockoutReset(user) {
  if (!user) return;
  user.failedLoginAttempts = 0;
  user.loginLockedUntil = null;
}

async function recordFailedLoginAttempt(user) {
  if (!user) return false;

  const attempts = (Number(user.failedLoginAttempts) || 0) + 1;
  user.failedLoginAttempts = attempts;
  if (attempts >= LOGIN_LOCKOUT_THRESHOLD) {
    user.loginLockedUntil = new Date(Date.now() + LOGIN_LOCKOUT_DURATION_MS);
  }
  await user.save();
  return isLoginLocked(user);
}

async function consumeLegacyRefreshTokenVersion(userId, version) {
  if (Number.isInteger(version) && version >= 0) {
    return User.findOneAndUpdate(
      { _id: userId, refreshTokenVersion: version },
      { $inc: { refreshTokenVersion: 1 } },
      { returnDocument: 'after' }
    );
  }

  // Backward-compatible path for pre-rotation tokens that had no version claim.
  return User.findOneAndUpdate(
    { _id: userId, ...LEGACY_REFRESH_VERSION_QUERY },
    { $set: { refreshTokenVersion: 1 } },
    { returnDocument: 'after' }
  );
}

const registerSchema = {
  body: {
    type: 'object',
    required: ['email', 'password', 'firstname', 'lastname'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 8 },
      firstname: { type: 'string', minLength: 1 },
      lastname: { type: 'string', minLength: 1 },
    },
  },
};

const loginSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string' },
      password: { type: 'string' },
    },
  },
};

const CURRENT_SSO_ROUTES = {
  loginPath: '/sso/login',
  callbackPath: '/sso/callback',
  logoutPath: '/sso/logout',
  logoutUrlPath: '/sso/logout-url',
  metadataPaths: ['/sso/metadata'],
};

const LEGACY_SSO_ROUTES = {
  loginPath: '/SSO/SAML2',
  callbackPath: '/SSO/SAML2',
  logoutPath: '/SSO/SAML2/logout',
  metadataPaths: ['/SSO/SAML2/metadata', '/SSO/SAML2/metadata.xml'],
};

function registerSsoRoutes(app, routes) {
  const getSamlProvider = async () => {
    const settings = await getAuthSettings();
    const providerRoutes = getSsoProviderRoutes(settings);
    return app.getSamlProvider(providerRoutes);
  };

  app.get(routes.loginPath, async (request, reply) => {
    const saml = await getSamlProvider();
    if (!saml) {
      return reply.code(400).send({ error: 'Bad Request', message: 'SSO is not configured' });
    }

    const url = await saml.getAuthorizeUrlAsync('', request.id, {});
    return reply.redirect(url);
  });

  app.post(routes.callbackPath, async (request, reply) => {
    const saml = await getSamlProvider();
    if (!saml) {
      return reply.code(400).send({ error: 'Bad Request', message: 'SSO is not configured' });
    }

    let profile;
    try {
      const result = await saml.validatePostResponseAsync(request.body);
      profile = result.profile;
    } catch (err) {
      request.log.error(
        { err, samlResponsePresent: !!request.body?.SAMLResponse },
        'SAML validation failed – check IdP certificate, clock skew, and audience (issuer) settings',
      );
      return reply.code(401).send({ error: 'Unauthorized', message: 'SAML validation failed' });
    }

    if (!profile) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'No profile returned from IdP' });
    }

    const settings = await getAuthSettings();
    const attrs = profile.attributes || profile;

    const email = (getAttr(attrs, settings.SSO_emailIdentifier) || profile.nameID || '').toLowerCase().trim();
    if (!email) {
      return reply.code(400).send({ error: 'Bad Request', message: 'No email in SAML response' });
    }

    const firstname = getAttr(attrs, settings.SSO_firstNameIdentifier);
    const lastname = getAttr(attrs, settings.SSO_lastNameIdentifier);
    const studentNumber = getAttr(attrs, settings.SSO_studentNumberIdentifier);
    const roleValue = getAttr(attrs, settings.SSO_roleIdentifier);
    const sessionIndex = profile.sessionIndex || '';

    let user = await User.findOne({ 'emails.address': emailRegex(email) });

    const requestIp = getRequestIp(request);

    if (user && isUserDisabled(user)) {
      return reply.code(403).send({
        error: 'Forbidden',
        code: 'ACCOUNT_DISABLED',
        message: getDisabledAccountMessage(),
      });
    }

    if (!user) {
      const isProfessor = settings.SSO_roleProfName && roleValue === settings.SSO_roleProfName;
      const roles = isProfessor ? ['professor'] : ['student'];

      user = await User.create({
        _id: generateMeteorId(),
        emails: [{ address: email, verified: true }],
        services: {
          password: { hash: await User.hashPassword(crypto.randomBytes(32).toString('hex')) },
          sso: {
            id: profile.nameID,
            nameID: profile.nameID,
            nameIDFormat: profile.nameIDFormat || '',
            email,
            SSORole: roleValue,
            studentNumber,
            sessions: [],
          },
        },
        profile: {
          firstname,
          lastname,
          roles,
          studentNumber,
        },
        ssoCreated: true,
        allowEmailLogin: false,
        lastAuthProvider: 'sso',
        createdAt: new Date(),
        lastLogin: new Date(),
        lastLoginIp: requestIp,
      });
    } else {
      if (firstname) user.profile.firstname = firstname;
      if (lastname) user.profile.lastname = lastname;
      if (studentNumber) user.profile.studentNumber = studentNumber;

      if (settings.SSO_roleProfName && roleValue === settings.SSO_roleProfName
          && !user.profile.roles.includes('professor') && !user.profile.roles.includes('admin')) {
        user.profile.roles = ['professor'];
      }

      if (!user.services) user.services = {};
      if (!user.services.sso) user.services.sso = {};
      user.services.sso.id = profile.nameID;
      user.services.sso.nameID = profile.nameID;
      user.services.sso.nameIDFormat = profile.nameIDFormat || '';
      user.services.sso.email = email;
      user.services.sso.SSORole = roleValue;
      user.services.sso.studentNumber = studentNumber;

      const emailEntry = user.emails.find(e => e.address === email);
      if (emailEntry && !emailEntry.verified) {
        emailEntry.verified = true;
      }

      user.lastLogin = new Date();
      user.lastLoginIp = requestIp;
      user.lastAuthProvider = 'sso';
    }

    if (sessionIndex) {
      if (!user.services.sso.sessions) user.services.sso.sessions = [];
      user.services.sso.sessions.push({ sessionIndex });
    }

    const refreshSession = issueRefreshSession(user, getRefreshSessionMaxAgeMs(settings), requestIp);
    await user.save();

    const token = await signAccessToken(app, user, settings);
    const refreshTokenMaxAgeSeconds = getRefreshTokenTtlSeconds(refreshSession);
    const refreshToken = signRefreshToken(app.config, user, refreshSession.sessionId, refreshTokenMaxAgeSeconds);

    setRefreshTokenCookie(reply, app, refreshToken, refreshTokenMaxAgeSeconds);

    return reply.redirect(`${app.config.rootUrl}/sso-callback?token=${encodeURIComponent(token)}`);
  });

  app.get(routes.logoutPath, async (request, reply) => reply.redirect(`${app.config.rootUrl}/login`));

  app.post(routes.logoutPath, async (request, reply) => {
    try {
      const samlRequest = request.body?.SAMLRequest;
      if (!samlRequest) {
        return reply.redirect(`${app.config.rootUrl}/login`);
      }

      request.log.info('SSO logout POST received from %s', request.ip);

      let sessionIndex = null;

      const saml = await getSamlProvider();
      if (saml) {
        try {
          const result = await saml.validatePostRequestAsync(request.body);
          const profile = result?.profile;
          if (profile?.sessionIndex) {
            sessionIndex = profile.sessionIndex;
            request.log.info('SSO logout validated cryptographically, sessionIndex=%s', sessionIndex);
          }
        } catch (validationErr) {
          request.log.warn(
            { err: validationErr },
            'SSO logout crypto validation failed, falling back to manual XML extraction'
          );
        }
      }

      if (!sessionIndex) {
        const xml = Buffer.from(samlRequest, 'base64').toString('utf8');
        const sessionIndexPatterns = [
          /<saml2p:SessionIndex[^>]*>([^<]+)<\/saml2p:SessionIndex>/,
          /<samlp:SessionIndex[^>]*>([^<]+)<\/samlp:SessionIndex>/,
          /<SessionIndex[^>]*>([^<]+)<\/SessionIndex>/,
        ];
        for (const pattern of sessionIndexPatterns) {
          const match = xml.match(pattern);
          if (match) {
            sessionIndex = match[1];
            request.log.warn('SSO logout using unvalidated session index from XML fallback');
            break;
          }
        }
      }

      if (sessionIndex) {
        const user = await User.findOne({ 'services.sso.sessions.sessionIndex': sessionIndex });
        if (user && user.services?.sso?.sessions) {
          user.services.sso.sessions = user.services.sso.sessions.filter(
            (session) => session.sessionIndex !== sessionIndex
          );
          await user.save();
        }
      }
    } catch (err) {
      request.log.error('SSO logout error:', err);
    }

    return reply.redirect(`${app.config.rootUrl}/login`);
  });

  if (routes.logoutUrlPath) {
    app.get(routes.logoutUrlPath, { preHandler: app.authenticate }, async (request, reply) => {
      const saml = await getSamlProvider();
      if (!saml) {
        return { url: null };
      }

      const user = await User.findById(request.user.userId);
      if (!user?.services?.sso?.sessions?.length) {
        return { url: null };
      }

      const settings = await getAuthSettings();
      if (!settings?.SSO_logoutUrl) {
        return { url: null };
      }

      const session = user.services.sso.sessions[user.services.sso.sessions.length - 1];
      try {
        const logoutUrl = await saml.getLogoutUrlAsync(
          {
            nameID: user.services.sso.nameID,
            nameIDFormat: user.services.sso.nameIDFormat,
            sessionIndex: session.sessionIndex,
          },
          '',
          {}
        );
        return { url: logoutUrl };
      } catch (err) {
        request.log.error('Failed to generate SSO logout URL:', err);
        return { url: null };
      }
    });
  }

  for (const metadataPath of routes.metadataPaths) {
    app.get(metadataPath, async (request, reply) => {
      const saml = await getSamlProvider();
      if (!saml) {
        return reply.code(400).send({ error: 'Bad Request', message: 'SSO is not configured' });
      }

      const settings = saml._qlickerSettings || await getAuthSettings();
      const decryptionCert = normalizeCertificatePem(settings.SSO_privCert || '') || null;
      const signingCert = normalizeCertificatePem(settings.SSO_privCert || '') || null;
      const metadata = saml.generateServiceProviderMetadata(decryptionCert, signingCert);
      return reply.type('application/xml').send(metadata);
    });
  }
}

export default async function authRoutes(app) {
  // POST /register
  app.post('/register', {
    schema: registerSchema,
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { email, password, firstname, lastname } = request.body;
    const normalizedEmail = email.toLowerCase().trim();

    const settings = await getAuthSettings();
    if (isSelfRegistrationDisabled(settings)) {
      return reply.code(403).send({
        error: 'Forbidden',
        code: 'SELF_REGISTRATION_DISABLED',
        message: 'Self-registration is disabled. Please contact an administrator.',
      });
    }

    if (isDomainRestrictionEnabled(settings)) {
      const allowedDomains = normalizeAllowedDomains(settings.allowedDomains);
      const domain = normalizedEmail.split('@')[1];
      if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Email domain not allowed' });
      }
    }

    // Check if user already exists (case-insensitive for legacy DB compatibility)
    const existing = await User.findOne({ 'emails.address': emailRegex(normalizedEmail) });
    if (existing) {
      return reply.code(409).send({ error: 'Conflict', message: 'Email already registered' });
    }

    const requestIp = getRequestIp(request);
    // First user becomes admin
    const userCount = await User.countDocuments();
    const roles = userCount === 0 ? ['admin'] : ['student'];

    const hashedPassword = await User.hashPassword(password);
    const userId = generateMeteorId();

    const user = await User.create({
      _id: userId,
      emails: [{ address: normalizedEmail, verified: false }],
      services: {
        password: { hash: hashedPassword },
      },
      profile: {
        firstname,
        lastname,
        roles,
      },
      allowEmailLogin: roles.includes('admin'),
      createdAt: new Date(),
      lastLogin: new Date(),
      lastLoginIp: requestIp,
      lastAuthProvider: 'password',
    });

    // Send verification email
    const verificationToken = crypto.randomBytes(32).toString('hex');
    user.services.email.verificationTokens.push({
      token: verificationToken,
      address: normalizedEmail,
      when: new Date(),
    });
    await user.save();

    try {
      await sendVerificationEmail(user, verificationToken);
    } catch (err) {
      request.log.error('Failed to send verification email:', err);
    }

    const requiresEmailVerification = !roles.includes('admin')
      && isVerifiedEmailRequired(settings)
      && !isUserEmailVerified(user);
    if (requiresEmailVerification) {
      return reply.code(201).send({
        requiresEmailVerification: true,
        message: getEmailVerificationRequiredMessage(),
      });
    }

    const refreshSession = issueRefreshSession(user, getRefreshSessionMaxAgeMs(settings), requestIp);
    await user.save();

    const token = await signAccessToken(app, user, settings);
    const refreshTokenMaxAgeSeconds = getRefreshTokenTtlSeconds(refreshSession);
    const refreshToken = signRefreshToken(app.config, user, refreshSession.sessionId, refreshTokenMaxAgeSeconds);

    setRefreshTokenCookie(reply, app, refreshToken, refreshTokenMaxAgeSeconds);

    return reply.code(201).send({ token, user: await sanitizeUser(user, settings) });
  });

  // POST /login
  app.post('/login', {
    schema: loginSchema,
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const { email, password } = request.body;
    const normalizedEmail = email.toLowerCase().trim();
    const settings = await getAuthSettings();

    const requestIp = getRequestIp(request);
    // Case-insensitive lookup for legacy DB compatibility
    const user = await User.findOne({ 'emails.address': emailRegex(normalizedEmail) });
    if (!user) {
      request.log.warn({ email: normalizedEmail }, 'Login failed: unknown email');
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid email or password' });
    }

    if (isUserDisabled(user)) {
      return reply.code(403).send({
        error: 'Forbidden',
        code: 'ACCOUNT_DISABLED',
        message: getDisabledAccountMessage(),
      });
    }

    if (!canUseEmailLogin(user, settings)) {
      request.log.warn({ email: normalizedEmail, userId: user._id }, 'Login blocked: SSO-only account');
      return reply.code(403).send({
        error: 'Forbidden',
        code: 'SSO_EMAIL_LOGIN_DISABLED',
        message: 'This account must sign in through SSO until email login is approved by an administrator.',
      });
    }

    if (user.passwordResetRequired()) {
      const reason = user.passwordResetReason();
      const message = reason === 'no_local_password'
        ? 'No local password is set for this account. Please reset your password.'
        : 'This account uses a legacy password format. Please reset your password.';
      return reply.code(403).send({
        error: 'Forbidden',
        code: 'PASSWORD_RESET_REQUIRED',
        requiresPasswordReset: true,
        reason,
        message,
      });
    }

    if (isLoginLocked(user)) {
      return reply.code(423).send({
        error: 'Locked',
        code: 'ACCOUNT_LOCKED',
        message: 'Too many failed login attempts. Please try again later.',
      });
    }

    const valid = await user.verifyPassword(password);
    if (!valid) {
      request.log.warn({ email: normalizedEmail, userId: user._id }, 'Login failed: invalid password');
      const locked = await recordFailedLoginAttempt(user);
      if (locked) {
        return reply.code(423).send({
          error: 'Locked',
          code: 'ACCOUNT_LOCKED',
          message: 'Too many failed login attempts. Please try again later.',
        });
      }
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid email or password' });
    }

    if (!isAdminUser(user) && isVerifiedEmailRequired(settings) && !isUserEmailVerified(user)) {
      return reply.code(403).send({
        error: 'Forbidden',
        code: 'EMAIL_NOT_VERIFIED',
        message: getEmailVerificationRequiredMessage(),
      });
    }

    prepareLoginLockoutReset(user);
    user.lastLogin = new Date();
    user.lastLoginIp = requestIp;
    user.lastAuthProvider = 'password';
    const refreshSession = issueRefreshSession(user, getRefreshSessionMaxAgeMs(settings), requestIp);
    await user.save();

    const token = await signAccessToken(app, user, settings);
    const refreshTokenMaxAgeSeconds = getRefreshTokenTtlSeconds(refreshSession);
    const refreshToken = signRefreshToken(app.config, user, refreshSession.sessionId, refreshTokenMaxAgeSeconds);

    setRefreshTokenCookie(reply, app, refreshToken, refreshTokenMaxAgeSeconds);

    return { token, user: await sanitizeUser(user, settings) };
  });

  // POST /logout
  app.post('/logout', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const refreshToken = request.cookies?.refreshToken;

    if (refreshToken) {
      try {
        const payload = jwt.verify(refreshToken, app.config.jwtRefreshSecret);
        if (payload?.type === 'refresh' && payload.userId) {
          if (typeof payload.sessionId === 'string' && payload.sessionId) {
            const user = await User.findById(payload.userId);
            if (user && revokeRefreshSession(user, payload.sessionId)) {
              await user.save();
            }
          } else {
            if (Number.isInteger(payload.version) && payload.version >= 0) {
              await User.updateOne(
                { _id: payload.userId, refreshTokenVersion: payload.version },
                { $inc: { refreshTokenVersion: 1 } }
              );
            } else {
              await User.updateOne(
                { _id: payload.userId, ...LEGACY_REFRESH_VERSION_QUERY },
                { $set: { refreshTokenVersion: 1 } }
              );
            }
          }
        }
      } catch {
        // Ignore invalid refresh tokens during logout and still clear the cookie.
      }
    }

    clearRefreshTokenCookie(reply);
    return { success: true };
  });

  // POST /refresh
  app.post('/refresh', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const refreshToken = request.cookies?.refreshToken;
    if (!refreshToken) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'No refresh token' });
    }

    let payload;
    try {
      payload = jwt.verify(refreshToken, app.config.jwtRefreshSecret);
    } catch {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid refresh token' });
    }

    if (payload.type !== 'refresh') {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid token type' });
    }

    if (!payload.userId) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid refresh token' });
    }

    if (typeof payload.sessionId === 'string' && payload.sessionId) {
      const user = await User.findById(payload.userId);
      if (!user) {
        return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid refresh token' });
      }
      if (isUserDisabled(user)) {
        clearRefreshTokenCookie(reply);
        return reply.code(403).send({
          error: 'Forbidden',
          code: 'ACCOUNT_DISABLED',
          message: getDisabledAccountMessage(),
        });
      }

      const nextSessionId = rotateRefreshSession(user, payload.sessionId, getRequestIp(request));
      if (!nextSessionId) {
        return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid refresh token' });
      }

      await user.save();
      const settings = await getAuthSettings();
      const token = await signAccessToken(app, user, settings);
      const nextRefreshTokenMaxAgeSeconds = getRefreshTokenTtlSeconds(nextSessionId);
      if (nextRefreshTokenMaxAgeSeconds <= 0) {
        clearRefreshTokenCookie(reply);
        return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid refresh token' });
      }
      const nextRefreshToken = signRefreshToken(
        app.config,
        user,
        nextSessionId.sessionId,
        nextRefreshTokenMaxAgeSeconds,
      );
      setRefreshTokenCookie(reply, app, nextRefreshToken, nextRefreshTokenMaxAgeSeconds);
      return { token };
    }

    const user = await consumeLegacyRefreshTokenVersion(payload.userId, payload.version);
    if (!user) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid refresh token' });
    }
    if (isUserDisabled(user)) {
      clearRefreshTokenCookie(reply);
      return reply.code(403).send({
        error: 'Forbidden',
        code: 'ACCOUNT_DISABLED',
        message: getDisabledAccountMessage(),
      });
    }

    const settings = await getAuthSettings();
    const nextSession = issueRefreshSession(user, getRefreshSessionMaxAgeMs(settings), getRequestIp(request));
    await user.save();
    const token = await signAccessToken(app, user, settings);
    const nextRefreshTokenMaxAgeSeconds = getRefreshTokenTtlSeconds(nextSession);
    const nextRefreshToken = signRefreshToken(
      app.config,
      user,
      nextSession.sessionId,
      nextRefreshTokenMaxAgeSeconds,
    );
    setRefreshTokenCookie(reply, app, nextRefreshToken, nextRefreshTokenMaxAgeSeconds);
    return { token };
  });

  // POST /forgot-password
  app.post(
    '/forgot-password',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          properties: { email: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { email } = request.body;
      const normalizedEmail = email.toLowerCase().trim();
      const settings = await getAuthSettings();

      // Always return success to avoid user enumeration
      const user = await User.findOne({ 'emails.address': emailRegex(normalizedEmail) });
      if (user && !isUserDisabled(user) && canUseEmailLogin(user, settings)) {
        const token = crypto.randomBytes(32).toString('hex');
        user.services.resetPassword = {
          token,
          email: normalizedEmail,
          when: new Date(),
          reason: 'reset',
        };
        await user.save();

        try {
          await sendPasswordResetEmail(user, token);
        } catch (err) {
          request.log.error('Failed to send password reset email:', err);
        }
      }

      return { success: true };
    }
  );

  // POST /reset-password
  app.post(
    '/reset-password',
    {
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
      schema: {
        body: {
          type: 'object',
          required: ['token', 'newPassword'],
          properties: {
            token: { type: 'string' },
            newPassword: { type: 'string', minLength: 8 },
          },
        },
      },
    },
    async (request, reply) => {
      const { token, newPassword } = request.body;

      const user = await User.findOne({ 'services.resetPassword.token': token });
      if (!user) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Invalid or expired token' });
      }

      // Reject (and clear) reset tokens that are missing a timestamp or past TTL.
      if (!isTimestampWithinTtl(user.services?.resetPassword?.when, PASSWORD_RESET_TOKEN_TTL_MS)) {
        user.set('services.resetPassword', undefined);
        await user.save();
        return reply.code(400).send({ error: 'Bad Request', message: 'Invalid or expired token' });
      }

      if (isUserDisabled(user)) {
        return reply.code(403).send({
          error: 'Forbidden',
          code: 'ACCOUNT_DISABLED',
          message: getDisabledAccountMessage(),
        });
      }

      const settings = await getAuthSettings();
      if (!canUseEmailLogin(user, settings)) {
        return reply.code(403).send({
          error: 'Forbidden',
          code: 'SSO_EMAIL_LOGIN_DISABLED',
          message: 'This account must sign in through SSO until email login is approved by an administrator.',
        });
      }

      const hashedPassword = await User.hashPassword(newPassword);
      if (!user.services.password) user.services.password = {};
      user.services.password.hash = hashedPassword;
      user.set('services.password.bcrypt', undefined);
      user.set('services.resetPassword', undefined);
      user.refreshTokenVersion = getRefreshTokenVersion(user) + 1;
      revokeAllRefreshSessions(user);
      await user.save();

      return { success: true };
    }
  );

  // POST /verify-email
  app.post(
    '/verify-email',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { token } = request.body;

      const user = await User.findOne({ 'services.email.verificationTokens.token': token });
      if (!user) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Invalid or expired token' });
      }

      // Find the token entry to get the address
      const tokenEntry = user.services.email.verificationTokens.find((t) => t.token === token);

      // Reject (and prune) tokens that are missing a timestamp or past TTL.
      if (!tokenEntry || !isTimestampWithinTtl(tokenEntry.when, EMAIL_VERIFICATION_TOKEN_TTL_MS)) {
        if (tokenEntry) {
          user.services.email.verificationTokens = user.services.email.verificationTokens.filter(
            (t) => t.token !== token
          );
          await user.save();
        }
        return reply.code(400).send({ error: 'Bad Request', message: 'Invalid or expired token' });
      }

      const emailEntry = user.emails.find((e) => e.address === tokenEntry.address);
      if (emailEntry) {
        emailEntry.verified = true;
      }

      // Remove used token
      user.services.email.verificationTokens = user.services.email.verificationTokens.filter(
        (t) => t.token !== token
      );
      await user.save();

      return { success: true };
    }
  );

  registerSsoRoutes(app, CURRENT_SSO_ROUTES);
}

export async function legacySamlRoutes(app) {
  registerSsoRoutes(app, LEGACY_SSO_ROUTES);
}
