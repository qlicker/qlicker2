import sharp from 'sharp';
import User from '../models/User.js';
import Course from '../models/Course.js';
import Image from '../models/Image.js';
import SystemMetricSample from '../models/SystemMetricSample.js';
import SystemMonitorEvent from '../models/SystemMonitorEvent.js';
import { generateMeteorId } from '../utils/meteorId.js';
import { emailRegex } from '../utils/email.js';
import { escapeForRegex } from '../utils/regex.js';
import { stringParamsSchema } from '../utils/apiDocs.js';
import {
  canUseEmailLogin,
  isAdminUser,
  normalizeAvatarThumbnailSize,
  shouldLockLocalProfileEdits,
} from '../utils/authPolicy.js';
import { isSafeProfileImageUrl, isPrivateHostname } from '../utils/url.js';
import { getLastLoginAudit } from '../utils/sessionAudit.js';
import { getUserAccessFlags } from '../utils/userAccess.js';
import { getOrCreateSettingsDocument } from '../utils/settingsSingleton.js';
import {
  buildSystemMonitoringResponse,
  SYSTEM_METRIC_RANGES,
} from '../services/systemMetrics.js';

async function getAuthSettings() {
  return getOrCreateSettingsDocument({
    select: 'SSO_enabled avatarThumbnailSize',
    lean: true,
  });
}

function hasOnlyStudentRole(roles = []) {
  return roles.includes('student') && !roles.includes('professor') && !roles.includes('admin');
}

function toSanitizedUserObject(user, settings = {}) {
  const obj = user?.toObject ? user.toObject() : { ...user };
  const { lastLogin } = getLastLoginAudit(user);
  obj.lastLogin = lastLogin;
  obj.isSSOUser = !!user.services?.sso?.id;
  obj.isSSOCreatedUser = !!user.ssoCreated;
  obj.allowEmailLogin = canUseEmailLogin(user, settings);
  obj.lastAuthProvider = user.lastAuthProvider || '';
  return obj;
}

async function sanitizeUser(user, settings = {}) {
  const obj = toSanitizedUserObject(user, settings);
  Object.assign(obj, await getUserAccessFlags(user));
  delete obj.services;
  return obj;
}

async function sanitizeRawUser(user = {}, settings = {}) {
  const obj = toSanitizedUserObject(user, settings);
  Object.assign(obj, await getUserAccessFlags(user));
  delete obj.services;
  return obj;
}

function sortCoursePayloads(courses = []) {
  return [...courses].sort((a, b) => {
    const aKey = [
      a?.deptCode || '',
      a?.courseNumber || '',
      a?.section || '',
      a?.name || '',
      a?.semester || '',
    ].join(' ').toLowerCase();
    const bKey = [
      b?.deptCode || '',
      b?.courseNumber || '',
      b?.section || '',
      b?.name || '',
      b?.semester || '',
    ].join(' ').toLowerCase();
    return aKey.localeCompare(bKey);
  });
}

function buildCourseStatisticsSortKey(course = {}) {
  return [
    course.deptCode || '',
    course.courseNumber || '',
    course.section || '',
    course.name || '',
    course.semester || '',
  ].join(' ').toLowerCase();
}

async function loadAdminUserCourses(user = {}) {
  const courseIds = Array.isArray(user?.profile?.courses)
    ? [...new Set(user.profile.courses.map((courseId) => String(courseId)).filter(Boolean))]
    : [];

  if (courseIds.length === 0) {
    return {
      studentCourses: [],
      instructorCourses: [],
    };
  }

  const courses = await Course.find({ _id: { $in: courseIds } })
    .select('_id name deptCode courseNumber section semester inactive instructors')
    .lean();
  const courseById = new Map(courses.map((course) => [String(course._id), course]));
  const studentCourses = [];
  const instructorCourses = [];

  for (const courseId of courseIds) {
    const course = courseById.get(courseId);
    if (!course) continue;
    const instructorIds = Array.isArray(course.instructors)
      ? course.instructors.map((instructorId) => String(instructorId))
      : [];
    if (instructorIds.includes(String(user._id))) {
      instructorCourses.push(course);
    } else {
      studentCourses.push(course);
    }
  }

  return {
    studentCourses: sortCoursePayloads(studentCourses),
    instructorCourses: sortCoursePayloads(instructorCourses),
  };
}

async function buildAdminUserPayload(user, settings = {}) {
  const courses = await loadAdminUserCourses(user);
  const obj = toSanitizedUserObject(user, settings);
  const { lastLogin, lastLoginIp, activeSessions } = getLastLoginAudit(user);
  obj.lastLogin = lastLogin;
  obj.lastLoginIp = lastLoginIp;
  obj.currentlyLoggedIn = activeSessions.length > 0;
  obj.activeSessions = activeSessions.map((session) => ({
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
    ipAddress: session.ipAddress,
  }));
  obj.studentCourses = courses.studentCourses;
  obj.instructorCourses = courses.instructorCourses;
  delete obj.services;
  return obj;
}

async function setLocalPassword(user, newPassword) {
  const hashedPassword = await User.hashPassword(newPassword);
  if (!user.services) user.services = {};
  if (!user.services.password) user.services.password = {};
  if (!user.services.resume) user.services.resume = {};
  user.services.password.hash = hashedPassword;
  user.set('services.password.bcrypt', undefined);
  user.set('services.resetPassword', undefined);
  user.services.resume.loginTokens = [];
  user.refreshTokenVersion = (Number(user.refreshTokenVersion) || 0) + 1;
}

function normalizeQuarterTurnRotation(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 0;
  const normalized = ((Math.round(raw / 90) % 4) + 4) % 4;
  return normalized * 90;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function deriveImageKeyFromUrl(sourceUrl = '') {
  const rawUrl = String(sourceUrl || '').trim();
  if (!rawUrl) return '';

  const decodeKey = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  try {
    const parsed = rawUrl.startsWith('/')
      ? new URL(rawUrl, 'http://localhost')
      : new URL(rawUrl);
    const pathname = String(parsed.pathname || '');
    if (!pathname.startsWith('/uploads/')) {
      return '';
    }
    return decodeKey(pathname.slice('/uploads/'.length));
  } catch {
    const stripped = rawUrl.split('?')[0].split('#')[0];
    if (stripped.startsWith('/uploads/')) {
      return decodeKey(stripped.slice('/uploads/'.length));
    }
    return '';
  }
}

async function fetchRemoteProfileImageBuffer(sourceUrl) {
  if (!/^https?:\/\//i.test(String(sourceUrl || ''))) {
    return null;
  }

  // SSRF protection: block requests to private/internal networks
  try {
    const parsed = new URL(sourceUrl);
    if (isPrivateHostname(parsed.hostname)) {
      return null;
    }
  } catch {
    return null;
  }

  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(10_000)
    : undefined;
  const response = await fetch(sourceUrl, { redirect: 'follow', signal });
  if (!response.ok) {
    throw new Error(`Remote profile image request failed with status ${response.status}`);
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.startsWith('image/')) {
    throw new Error(`Remote profile image is not an image (${contentType})`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 15 * 1024 * 1024) {
    throw new Error('Remote profile image is too large to crop safely');
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

const updateProfileSchema = {
  body: {
    type: 'object',
    properties: {
      firstname: { type: 'string', minLength: 1 },
      lastname: { type: 'string', minLength: 1 },
      studentNumber: { type: 'string' },
      locale: { type: 'string' },
    },
    additionalProperties: false,
  },
};

const updateProfileImageSchema = {
  body: {
    type: 'object',
    required: ['profileImage'],
    properties: {
      profileImage: { type: 'string', minLength: 1 },
      profileThumbnail: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
};

const regenerateProfileThumbnailSchema = {
  body: {
    type: 'object',
    required: ['rotation', 'cropX', 'cropY', 'cropSize'],
    properties: {
      rotation: { type: 'number' },
      cropX: { type: 'number', minimum: 0 },
      cropY: { type: 'number', minimum: 0 },
      cropSize: { type: 'number', minimum: 1 },
    },
    additionalProperties: false,
  },
};

const listUsersSchema = {
  querystring: {
    type: 'object',
    properties: {
      search: { type: 'string' },
      role: { type: 'string' },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      sortBy: {
        type: 'string',
        enum: ['name', 'email', 'verified', 'lastLogin', 'role'],
      },
      sortDirection: {
        type: 'string',
        enum: ['asc', 'desc'],
      },
    },
    additionalProperties: false,
  },
};

const userIdParamsSchema = {
  params: stringParamsSchema(['id']),
};

// The only assignable account roles. `admin` may only ever be granted by an
// existing admin; canPromote professors are limited to student <-> professor.
const VALID_ROLES = ['student', 'professor', 'admin'];

const updateRoleSchema = {
  ...userIdParamsSchema,
  body: {
    type: 'object',
    required: ['role'],
    properties: {
      role: { type: 'string', enum: VALID_ROLES },
    },
    additionalProperties: false,
  },
};

const updateUserPropertiesSchema = {
  ...userIdParamsSchema,
  body: {
    type: 'object',
    properties: {
      canPromote: { type: 'boolean' },
      allowEmailLogin: { type: 'boolean' },
      disabled: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const adminResetPasswordSchema = {
  ...userIdParamsSchema,
  body: {
    type: 'object',
    required: ['newPassword'],
    properties: {
      newPassword: { type: 'string', minLength: 8 },
    },
    additionalProperties: false,
  },
};

export default async function userRoutes(app) {
  const { authenticate, requireRole } = app;
  const userMutationRateLimit = {
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  };

  function buildUserListSort(sortBy = 'lastLogin', sortDirection = 'desc') {
    const direction = sortDirection === 'asc' ? 1 : -1;
    switch (sortBy) {
      case 'name':
        return {
          'profile.lastname': direction,
          'profile.firstname': direction,
          'emails.address': 1,
          _id: 1,
        };
      case 'email':
        return {
          'emails.address': direction,
          'profile.lastname': 1,
          'profile.firstname': 1,
          _id: 1,
        };
      case 'verified':
        return {
          'emails.verified': direction,
          'profile.lastname': 1,
          'profile.firstname': 1,
          _id: 1,
        };
      case 'role':
        return {
          'profile.roles': direction,
          'profile.lastname': 1,
          'profile.firstname': 1,
          _id: 1,
        };
      case 'lastLogin':
      default:
        return {
          lastLogin: direction,
          'profile.lastname': 1,
          'profile.firstname': 1,
          _id: 1,
        };
    }
  }

  // GET /me
  app.get('/me', { preHandler: authenticate }, async (request, reply) => {
    const [user, settings] = await Promise.all([
      User.findById(request.user.userId).lean(),
      getAuthSettings(),
    ]);
    if (!user) {
      return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
    }
    return { user: await sanitizeRawUser(user, settings) };
  });

  // PATCH /me
  app.patch('/me', { preHandler: authenticate, schema: updateProfileSchema, ...userMutationRateLimit }, async (request, reply) => {
    const profileAllowed = ['firstname', 'lastname', 'studentNumber'];
    const updates = {};

    const [user, settings] = await Promise.all([
      User.findById(request.user.userId),
      getAuthSettings(),
    ]);
    if (!user) {
      return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
    }

    const nameLocked = shouldLockLocalProfileEdits(user, settings);

    for (const key of profileAllowed) {
      if (request.body?.[key] !== undefined) {
        if (nameLocked && (key === 'firstname' || key === 'lastname')) {
          continue; // SSO users cannot change name fields
        }
        updates[`profile.${key}`] = request.body[key];
      }
    }

    // Per-user locale preference
    if (request.body?.locale !== undefined) {
      updates.locale = request.body.locale;
    }

    const updated = await User.findByIdAndUpdate(
      request.user.userId,
      { $set: updates },
      { returnDocument: 'after' }
    );
    if (!updated) {
      return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
    }
    return await sanitizeUser(updated, settings);
  });

  // PATCH /me/password
  app.patch(
    '/me/password',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          properties: {
            currentPassword: { type: 'string' },
            newPassword: { type: 'string', minLength: 8 },
          },
        },
      },
    },
    async (request, reply) => {
      const { currentPassword, newPassword } = request.body;

      const [user, settings] = await Promise.all([
        User.findById(request.user.userId),
        getAuthSettings(),
      ]);
      if (!user) {
        return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
      }

      if (shouldLockLocalProfileEdits(user, settings)) {
        return reply.code(403).send({
          error: 'Forbidden',
          code: 'SSO_PASSWORD_CHANGE_DISABLED',
          message: 'Password changes are unavailable while signed in through SSO.',
        });
      }

      const valid = await user.verifyPassword(currentPassword);
      if (!valid) {
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
        return reply.code(401).send({ error: 'Unauthorized', message: 'Current password is incorrect' });
      }

      await setLocalPassword(user, newPassword);
      await user.save();

      return { success: true };
    }
  );

  // PATCH /me/image — Update profile image
  app.patch('/me/image', { preHandler: authenticate, schema: updateProfileImageSchema, ...userMutationRateLimit }, async (request, reply) => {
    const { profileImage, profileThumbnail } = request.body || {};
    if (typeof profileImage !== 'string') {
      return reply.code(400).send({ error: 'Bad Request', message: 'profileImage URL string is required' });
    }
    if (profileThumbnail !== undefined && typeof profileThumbnail !== 'string') {
      return reply.code(400).send({ error: 'Bad Request', message: 'profileThumbnail must be a URL string when provided' });
    }
    if (!isSafeProfileImageUrl(profileImage)) {
      return reply.code(400).send({ error: 'Bad Request', message: 'profileImage must use an http(s) URL or site-relative path' });
    }
    if (profileThumbnail !== undefined && !isSafeProfileImageUrl(profileThumbnail)) {
      return reply.code(400).send({ error: 'Bad Request', message: 'profileThumbnail must use an http(s) URL or site-relative path' });
    }

    const resolvedThumbnail = profileThumbnail ?? profileImage;

    const user = await User.findByIdAndUpdate(
      request.user.userId,
      {
        $set: {
          'profile.profileImage': profileImage,
          'profile.profileThumbnail': resolvedThumbnail,
        },
      },
      { returnDocument: 'after' }
    );
    if (!user) {
      return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
    }
    const settings = await getAuthSettings();
    return await sanitizeUser(user, settings);
  });

  // POST /me/image/thumbnail — regenerate avatar thumbnail from the stored full-size profile image
  app.post(
    '/me/image/thumbnail',
    {
      preHandler: authenticate,
      schema: regenerateProfileThumbnailSchema,
      ...userMutationRateLimit,
    },
    async (request, reply) => {
      const [user, settings] = await Promise.all([
        User.findById(request.user.userId),
        getAuthSettings(),
      ]);
      if (!user) {
        return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
      }
      const thumbnailSize = normalizeAvatarThumbnailSize(settings?.avatarThumbnailSize);

      const sourceUrl = user.profile?.profileImage || '';
      if (!sourceUrl) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No profile image is available to crop' });
      }

      if (!isSafeProfileImageUrl(sourceUrl)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Stored profile image URL is invalid' });
      }

      let sourceBuffer;
      const fallbackKey = deriveImageKeyFromUrl(sourceUrl);
      const sourceImage = await Image.findOne(
        fallbackKey
          ? { $or: [{ url: sourceUrl }, { key: fallbackKey }] }
          : { url: sourceUrl }
      ).lean();
      const sourceKey = sourceImage?.key || fallbackKey;

      if (sourceKey) {
        try {
          sourceBuffer = await app.getFileBuffer(sourceKey);
        } catch (err) {
          request.log.warn({ err, imageKey: sourceKey, sourceUrl }, 'Failed to read stored profile image source');
        }
      }

      if (!sourceBuffer) {
        try {
          sourceBuffer = await fetchRemoteProfileImageBuffer(sourceUrl);
        } catch (err) {
          request.log.warn({ err, sourceUrl }, 'Failed to fetch remote profile image source');
        }
      }

      if (!sourceBuffer) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'The current profile image could not be loaded for thumbnail generation.',
        });
      }

      const rotation = normalizeQuarterTurnRotation(request.body.rotation);
      const initialCropX = Math.round(Number(request.body.cropX) || 0);
      const initialCropY = Math.round(Number(request.body.cropY) || 0);
      const initialCropSize = Math.round(Number(request.body.cropSize) || 0);

      try {
        const rotatedImage = sharp(sourceBuffer).rotate(rotation);
        const metadata = await rotatedImage.clone().metadata();
        const rotatedWidth = Number(metadata.width) || 0;
        const rotatedHeight = Number(metadata.height) || 0;
        if (!rotatedWidth || !rotatedHeight) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Profile image dimensions could not be determined' });
        }

        const maxCropSize = Math.min(rotatedWidth, rotatedHeight);
        const cropSize = clamp(initialCropSize || maxCropSize, 1, maxCropSize);
        const cropX = clamp(initialCropX, 0, rotatedWidth - cropSize);
        const cropY = clamp(initialCropY, 0, rotatedHeight - cropSize);

        const thumbnailBuffer = await rotatedImage
          .extract({ left: cropX, top: cropY, width: cropSize, height: cropSize })
          .resize(thumbnailSize, thumbnailSize, { fit: 'cover' })
          .jpeg({ quality: 92, mozjpeg: true })
          .toBuffer();

        const { url, key } = await app.uploadFile(thumbnailBuffer, 'profile-thumbnail.jpg', 'image/jpeg');
        await Image.create({
          _id: generateMeteorId(),
          url,
          key,
          UID: request.user.userId,
          type: 'image/jpeg',
          size: thumbnailBuffer.length,
          createdAt: new Date(),
        });

        user.profile.profileThumbnail = url;
        await user.save();

        return await sanitizeUser(user, settings);
      } catch (err) {
        request.log.error({ err }, 'Failed to generate profile thumbnail');
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Failed to generate profile thumbnail',
        });
      }
    }
  );

  // GET /admin/usage-statistics - System-wide usage summary for administrators
  app.get(
    '/admin/usage-statistics',
    { preHandler: requireRole(['admin']) },
    async () => {
      const now = new Date();
      const hourAgo = new Date(now.getTime() - (60 * 60 * 1000));
      const dayAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
      const weekAgo = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));

      const [pastHour, past24Hours, past7Days, activeUserIds, courses] = await Promise.all([
        User.countDocuments({ lastLogin: { $gte: hourAgo } }),
        User.countDocuments({ lastLogin: { $gte: dayAgo } }),
        User.countDocuments({ lastLogin: { $gte: weekAgo } }),
        User.distinct('_id', { lastLogin: { $gte: weekAgo } }),
        Course.find({})
          .select('_id name deptCode courseNumber section semester inactive students instructors')
          .lean(),
      ]);

      const activeUserIdSet = new Set(activeUserIds.map((userId) => String(userId)));
      const topCourses = courses
        .map((course) => {
          const studentIds = [...new Set((course.students || []).map((userId) => String(userId)))];
          const memberIds = new Set([
            ...studentIds,
            ...(course.instructors || []).map((userId) => String(userId)),
          ]);
          const activeUserCount = [...memberIds]
            .filter((userId) => activeUserIdSet.has(userId))
            .length;
          return {
            _id: String(course._id),
            name: course.name,
            deptCode: course.deptCode,
            courseNumber: course.courseNumber,
            section: course.section,
            semester: course.semester,
            inactive: !!course.inactive,
            enrollment: studentIds.length,
            activeUserCount,
          };
        })
        .sort((a, b) => (
          b.activeUserCount - a.activeUserCount
          || b.enrollment - a.enrollment
          || buildCourseStatisticsSortKey(a).localeCompare(buildCourseStatisticsSortKey(b))
        ))
        .slice(0, 5);

      return {
        generatedAt: now,
        loginCounts: {
          pastHour,
          past24Hours,
          past7Days,
        },
        activeCourseWindowDays: 7,
        topCourses,
      };
    }
  );

  // GET /admin/system-monitoring - Seven-day host metrics and monitor events.
  const monitoringCache = new Map();
  app.get(
    '/admin/system-monitoring',
    {
      preHandler: requireRole(['admin']),
      schema: {
        description: 'Admin-only host metrics, active-user counts, and collector events retained for seven days.',
        querystring: {
          type: 'object',
          properties: {
            range: { type: 'string', enum: Object.keys(SYSTEM_METRIC_RANGES), default: '24h' },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['healthy', 'stale', 'unavailable'] },
              range: { type: 'string' },
              generatedAt: { type: 'string', format: 'date-time' },
              retentionDays: { type: 'integer' },
              bucketSeconds: { type: 'integer' },
              activeUserDefinition: { type: 'string' },
              latest: { type: ['object', 'null'], additionalProperties: true },
              history: { type: 'array', items: { type: 'object', additionalProperties: true } },
              peakPeriods: { type: 'array', items: { type: 'object', additionalProperties: true } },
              events: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
    },
    async (request) => {
      const range = request.query?.range || '24h';
      const now = new Date();
      const cached = monitoringCache.get(range);
      if (cached && now.getTime() - cached.createdAt < 30_000) return cached.promise;
      const rangeConfig = SYSTEM_METRIC_RANGES[range] || SYSTEM_METRIC_RANGES['24h'];
      const cutoff = new Date(now.getTime() - rangeConfig.durationMs);
      const promise = Promise.all([
        SystemMetricSample.find({ timestamp: { $gte: cutoff, $lte: now } })
          .sort({ timestamp: -1 })
          .limit(20_161)
          .maxTimeMS(2_000)
          .select('-_id -__v -expiresAt')
          .lean(),
        SystemMonitorEvent.find({ timestamp: { $gte: new Date(now.getTime() - SYSTEM_METRIC_RANGES['7d'].durationMs) } })
          .sort({ timestamp: -1 })
          .limit(50)
          .maxTimeMS(2_000)
          .select('-_id -__v -expiresAt')
          .lean(),
      ]).then(([samples, events]) => buildSystemMonitoringResponse({ samples, events, range, now }));
      monitoringCache.set(range, { createdAt: now.getTime(), promise });
      try {
        return await promise;
      } catch (error) {
        monitoringCache.delete(range);
        throw error;
      }
    }
  );

  // GET / (admin only - paginated user list)
  app.get(
    '/',
    { preHandler: requireRole(['admin']), schema: listUsersSchema },
    async (request, reply) => {
      const {
        search,
        role,
        page: pageParam,
        limit: limitParam,
        sortBy = 'lastLogin',
        sortDirection = 'desc',
      } = request.query;
      const page = Math.max(1, parseInt(pageParam, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(limitParam, 10) || 20));

      const filter = {};
      if (search) {
        const regex = new RegExp(escapeForRegex(search), 'i');
        filter.$or = [
          { 'profile.firstname': regex },
          { 'profile.lastname': regex },
          { 'emails.address': regex },
          { 'services.sso.email': regex },
          { 'profile.studentNumber': regex },
        ];
      }
      if (role) {
        filter['profile.roles'] = role;
      }

      const [users, total, settings] = await Promise.all([
        User.find(filter)
          .sort(buildUserListSort(sortBy, sortDirection))
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        User.countDocuments(filter),
        getAuthSettings(),
      ]);

      // Remove services from each user
      const sanitized = await Promise.all(users.map((u) => sanitizeRawUser(u, settings)));

      return {
        users: sanitized,
        total,
        page,
        pages: Math.ceil(total / limit),
      };
    }
  );

  // GET /:id (admin only)
  app.get(
    '/:id',
      { preHandler: requireRole(['admin']), schema: userIdParamsSchema },
    async (request, reply) => {
      const [user, settings] = await Promise.all([
        User.findById(request.params.id).lean(),
        getAuthSettings(),
      ]);
      if (!user) {
        return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
      }
      return buildAdminUserPayload(user, settings);
    }
  );

  // PATCH /:id/properties (admin only)
  app.patch(
    '/:id/properties',
    {
      preHandler: requireRole(['admin']),
      schema: updateUserPropertiesSchema,
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const [existingUser, settings] = await Promise.all([
        User.findById(request.params.id),
        getAuthSettings(),
      ]);
      if (!existingUser) {
        return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
      }

      const setUpdates = {};
      const unsetUpdates = {};
      const existingRoles = existingUser.profile?.roles || [];
      const targetIsStudentOnly = hasOnlyStudentRole(existingRoles);

      if (request.body?.disabled === true && request.params.id === request.user.userId) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Admins cannot disable their own account' });
      }

      if (targetIsStudentOnly) {
        setUpdates['profile.canPromote'] = false;
      } else if (request.body?.canPromote !== undefined) {
        setUpdates['profile.canPromote'] = !!request.body.canPromote;
      }
      if (request.body?.allowEmailLogin !== undefined) {
        setUpdates.allowEmailLogin = isAdminUser(existingUser) ? true : !!request.body.allowEmailLogin;
        if (request.body.allowEmailLogin === false || isAdminUser(existingUser)) {
          unsetUpdates['services.resetPassword'] = 1;
        }
      }
      if (request.body?.disabled !== undefined) {
        const disabled = !!request.body.disabled;
        setUpdates.disabled = disabled;
        setUpdates.disabledAt = disabled ? new Date() : null;
        if (disabled) {
          setUpdates['services.resume.loginTokens'] = [];
          setUpdates['services.sso.sessions'] = [];
          setUpdates.refreshTokenVersion = (Number(existingUser.refreshTokenVersion) || 0) + 1;
          unsetUpdates['services.resetPassword'] = 1;
        }
      }

      const updateDoc = {};
      if (Object.keys(setUpdates).length > 0) {
        updateDoc.$set = setUpdates;
      }
      if (Object.keys(unsetUpdates).length > 0) {
        updateDoc.$unset = unsetUpdates;
      }

      const user = await User.findByIdAndUpdate(
        request.params.id,
        updateDoc,
        { returnDocument: 'after' }
      );
      if (!user) {
        return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
      }
      // Disabling revokes refresh sessions above; also drop any live WebSocket
      // connections so the account stops receiving pushes immediately.
      if (request.body?.disabled === true && typeof app.wsCloseUser === 'function') {
        app.wsCloseUser(request.params.id);
      }
      return buildAdminUserPayload(user, settings);
    }
  );

  // PATCH /:id/password (admin only)
  app.patch(
    '/:id/password',
    {
      preHandler: requireRole(['admin']),
      schema: adminResetPasswordSchema,
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const [user, settings] = await Promise.all([
        User.findById(request.params.id),
        getAuthSettings(),
      ]);
      if (!user) {
        return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
      }

      await setLocalPassword(user, request.body.newPassword);
      await user.save();

      return buildAdminUserPayload(user, settings);
    }
  );

  // PATCH /:id/role
  // Admins may set any role. A professor explicitly granted canPromote may only
  // move accounts between student and professor — never to admin, and never
  // their own account. Granting admin is strictly an admin-only operation and is
  // deliberately kept separate from canPromote.
  app.patch(
    '/:id/role',
      { preHandler: authenticate, schema: updateRoleSchema },
    async (request, reply) => {
      const { role } = request.body || {};
      if (!VALID_ROLES.includes(role)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'A valid role is required' });
      }

      // No one may change their own role — this prevents a canPromote professor
      // from self-escalating and stops an admin from accidentally locking
      // themselves out of admin access.
      if (request.params.id === request.user.userId) {
        return reply.code(403).send({ error: 'Forbidden', message: 'You cannot change your own role' });
      }

      const callerRoles = request.user.roles || [];
      const isAdmin = callerRoles.includes('admin');

      if (!isAdmin) {
        // Only an admin can ever grant the admin role.
        if (role === 'admin') {
          return reply.code(403).send({ error: 'Forbidden', message: 'Only an admin can grant the admin role' });
        }
        // Otherwise the caller must be a professor explicitly granted canPromote,
        // and is limited to student <-> professor changes (enforced above).
        const caller = await User.findById(request.user.userId);
        if (!caller || !callerRoles.includes('professor') || !caller.profile?.canPromote) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
        }
      }

      const roleUpdates = { 'profile.roles': [role] };
      if (role === 'student') {
        roleUpdates['profile.canPromote'] = false;
      }
      if (role === 'admin') {
        roleUpdates.allowEmailLogin = true;
      }

      const user = await User.findByIdAndUpdate(
        request.params.id,
        { $set: roleUpdates },
        { returnDocument: 'after' }
      );
      if (!user) {
        return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
      }
      const settings = await getAuthSettings();
      return await sanitizeUser(user, settings);
    }
  );

  // PATCH /:id/verify-email (admin only)
  app.patch(
    '/:id/verify-email',
      { preHandler: requireRole(['admin']), schema: userIdParamsSchema },
    async (request, reply) => {
      const [user, settings] = await Promise.all([
        User.findById(request.params.id),
        getAuthSettings(),
      ]);
      if (!user) {
        return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
      }
      if (user.emails && user.emails.length > 0) {
        user.emails[0].verified = true;
        await user.save();
      }
      return await sanitizeUser(user, settings);
    }
  );

  // DELETE /:id (admin only)
  app.delete(
    '/:id',
    { preHandler: requireRole(['admin']), schema: userIdParamsSchema },
    async (request, reply) => {
      const user = await User.findByIdAndDelete(request.params.id);
      if (!user) {
        return reply.code(404).send({ error: 'Not Found', message: 'User not found' });
      }
      return { success: true };
    }
  );

  // POST / (admin only - create user)
  app.post(
    '/',
    {
      preHandler: requireRole(['admin']),
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password', 'firstname', 'lastname'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
            firstname: { type: 'string', minLength: 1 },
            lastname: { type: 'string', minLength: 1 },
            role: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password, firstname, lastname, role } = request.body;
      const normalizedEmail = email.toLowerCase().trim();

      const existing = await User.findOne({ 'emails.address': emailRegex(normalizedEmail) });
      if (existing) {
        return reply.code(409).send({ error: 'Conflict', message: 'Email already registered' });
      }

      const hashedPassword = await User.hashPassword(password);
      const roleName = role || 'student';
      const user = await User.create({
        _id: generateMeteorId(),
        emails: [{ address: normalizedEmail, verified: false }],
        services: {
          password: { hash: hashedPassword },
        },
        profile: {
          firstname,
          lastname,
          roles: [roleName],
        },
        allowEmailLogin: roleName === 'admin',
        createdAt: new Date(),
      });

      const settings = await getAuthSettings();
      return reply.code(201).send(await sanitizeUser(user, settings));
    }
  );
}
