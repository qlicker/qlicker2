import Course from '../models/Course.js';
import Settings from '../models/Settings.js';
import { getMailConfigurationStatus } from '../services/email.js';
import {
  getBackupManagerHealth,
  normalizeAllowedDomains,
  normalizeSettingsPayload,
  isSsoEnabled,
} from '../utils/authPolicy.js';
import { stringParamsSchema } from '../utils/apiDocs.js';
import { getOrCreateSettingsDocument } from '../utils/settingsSingleton.js';
import { normalizeAiBackends, serializeAiBackends } from '../services/ai.js';
import { isCourseMember, isCourseStudent } from '../utils/courseAccess.js';

async function getOrCreateSettings(options = {}) {
  return getOrCreateSettingsDocument(options);
}

function buildBackupRequestId() {
  return `manual-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const BACKUP_STATE_RESET_MESSAGE = 'Backup request state was reset by an admin.';

// Whitelist of fields that may be updated via the admin settings PATCH endpoint.
// Prevents injection of unexpected fields into the settings document.
const ALLOWED_SETTINGS_FIELDS = new Set([
  'restrictDomain', 'allowedDomains', 'requireVerified', 'registrationDisabled', 'adminEmail', 'email',
  'SSO_enabled', 'SSO_entrypoint', 'SSO_cert', 'SSO_privCert', 'SSO_privKey',
  'SSO_EntityId', 'SSO_logoutUrl', 'SSO_identifierFormat', 'SSO_emailIdentifier',
  'SSO_firstNameIdentifier', 'SSO_lastNameIdentifier', 'SSO_studentNumberIdentifier',
  'SSO_institutionName', 'SSO_roleIdentifier', 'SSO_roleProfName',
  'SSO_wantAssertionsSigned', 'SSO_wantAuthnResponseSigned', 'SSO_acceptedClockSkewMs',
  'SSO_disableRequestedAuthnContext', 'SSO_authnContext', 'SSO_routeMode',
  'storageType', 'AWS_bucket', 'AWS_region', 'AWS_accessKeyId', 'AWS_secretAccessKey',
  'AWS_endpoint', 'AWS_forcePathStyle', 'AWS_accessKey', 'AWS_secret',
  'Azure_storageAccount', 'Azure_storageAccessKey', 'Azure_storageContainer',
  'Azure_accountName', 'Azure_accountKey', 'Azure_containerName',
  'tokenExpiryMinutes',
  'backupEnabled', 'backupTimeLocal', 'backupRetentionDaily', 'backupRetentionWeekly',
  'backupRetentionMonthly',
  'Jitsi_Enabled', 'Jitsi_Domain', 'Jitsi_EtherpadDomain', 'Jitsi_EnabledCourses',
  'AI_Enabled', 'AI_ApiUrl', 'AI_ApiToken', 'AI_EnabledCourses', 'AI_AllowCourseBackendCourses',
  'AI_Backends', 'AI_DefaultBackendId', 'AI_DefaultModelId', 'AI_RequestTimeoutSeconds',
  'locale', 'dateFormat', 'timeFormat',
  'maxImageSize', 'maxImageWidth', 'avatarThumbnailSize',
]);

// Write-only secret fields. They are never returned by the API (masked to ''
// with a companion `<name>Set` boolean) and an empty/blank value in a PATCH
// means "keep the stored secret" so the auto-saving admin forms cannot wipe
// them by round-tripping the masked response.
const SECRET_SETTINGS_FIELDS = new Set([
  'SSO_privKey',
  'AWS_secretAccessKey', 'AWS_secret',
  'Azure_storageAccessKey', 'Azure_accountKey',
  'AI_ApiToken',
]);
// Mongoose virtuals that resolve the secrets above (new-or-legacy fallbacks).
const SECRET_SETTINGS_VIRTUALS = [
  'resolvedAWSSecretAccessKey',
  'resolvedAzureStorageAccessKey',
];

function hasStoredValue(value) {
  return String(value || '').trim().length > 0;
}

function maskSettingsSecrets(payload = {}) {
  const masked = { ...payload };
  masked.SSO_privKeySet = hasStoredValue(payload.SSO_privKey);
  masked.AWS_secretAccessKeySet = hasStoredValue(payload.AWS_secretAccessKey)
    || hasStoredValue(payload.AWS_secret);
  masked.Azure_storageAccessKeySet = hasStoredValue(payload.Azure_storageAccessKey)
    || hasStoredValue(payload.Azure_accountKey);
  masked.AI_ApiTokenSet = hasStoredValue(payload.AI_ApiToken);
  masked.AI_Backends = serializeAiBackends(payload.AI_Backends || []);
  for (const field of SECRET_SETTINGS_FIELDS) {
    if (field in masked) masked[field] = '';
  }
  for (const field of SECRET_SETTINGS_VIRTUALS) {
    if (field in masked) masked[field] = '';
  }
  return masked;
}

function sanitizeSettingsPatchPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }

  const filtered = {};
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_SETTINGS_FIELDS.has(key)) continue;
    // Blank secrets mean "leave the stored secret unchanged".
    if (SECRET_SETTINGS_FIELDS.has(key) && !hasStoredValue(payload[key])) continue;
    if (key === 'AI_Backends') {
      const existingBackends = normalizeAiBackends(payload[key]);
      filtered[key] = existingBackends;
    } else {
      filtered[key] = payload[key];
    }
  }
  return filtered;
}

const updateSettingsSchema = {
  body: {
    type: 'object',
    properties: {
      restrictDomain: { type: 'boolean' },
      allowedDomains: { type: 'array', items: { type: 'string' } },
      requireVerified: { type: 'boolean' },
      registrationDisabled: { type: 'boolean' },
      adminEmail: { type: 'string' },
      email: { type: 'string' },
      SSO_enabled: { type: 'boolean' },
      SSO_entrypoint: { type: 'string' },
      SSO_cert: { type: 'string' },
      SSO_privCert: { type: 'string' },
      SSO_privKey: { type: 'string' },
      SSO_EntityId: { type: 'string' },
      SSO_logoutUrl: { type: 'string' },
      SSO_identifierFormat: { type: 'string' },
      SSO_emailIdentifier: { type: 'string' },
      SSO_firstNameIdentifier: { type: 'string' },
      SSO_lastNameIdentifier: { type: 'string' },
      SSO_studentNumberIdentifier: { type: 'string' },
      SSO_institutionName: { type: 'string' },
      SSO_roleIdentifier: { type: 'string' },
      SSO_roleProfName: { type: 'string' },
      SSO_wantAssertionsSigned: { type: 'boolean' },
      SSO_wantAuthnResponseSigned: { type: 'boolean' },
      SSO_acceptedClockSkewMs: { type: 'number', minimum: -1 },
      SSO_disableRequestedAuthnContext: { type: 'boolean' },
      SSO_authnContext: { type: 'string' },
      SSO_routeMode: { type: 'string', enum: ['legacy', 'api_v1'] },
      storageType: { type: 'string', enum: ['local', 's3', 'azure'] },
      AWS_bucket: { type: 'string' },
      AWS_region: { type: 'string' },
      AWS_accessKeyId: { type: 'string' },
      AWS_secretAccessKey: { type: 'string' },
      AWS_endpoint: { type: 'string' },
      AWS_forcePathStyle: { type: 'boolean' },
      AWS_accessKey: { type: 'string' },
      AWS_secret: { type: 'string' },
      Azure_storageAccount: { type: 'string' },
      Azure_storageAccessKey: { type: 'string' },
      Azure_storageContainer: { type: 'string' },
      Azure_accountName: { type: 'string' },
      Azure_accountKey: { type: 'string' },
      Azure_containerName: { type: 'string' },
      tokenExpiryMinutes: { type: 'number', minimum: 1 },
      backupEnabled: { type: 'boolean' },
      backupTimeLocal: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
      backupRetentionDaily: { type: 'number', minimum: 0 },
      backupRetentionWeekly: { type: 'number', minimum: 0 },
      backupRetentionMonthly: { type: 'number', minimum: 0 },
      Jitsi_Enabled: { type: 'boolean' },
      Jitsi_Domain: { type: 'string' },
      Jitsi_EtherpadDomain: { type: 'string' },
      Jitsi_EnabledCourses: { type: 'array', items: { type: 'string' } },
      AI_Enabled: { type: 'boolean' },
      AI_ApiUrl: { type: 'string' },
      AI_ApiToken: { type: 'string' },
      AI_EnabledCourses: { type: 'array', items: { type: 'string' } },
      AI_AllowCourseBackendCourses: { type: 'array', items: { type: 'string' } },
      AI_Backends: { type: 'array' },
      AI_DefaultBackendId: { type: 'string' },
      AI_DefaultModelId: { type: 'string' },
      AI_RequestTimeoutSeconds: { type: 'number', minimum: 10, maximum: 1800 },
      locale: { type: 'string' },
      dateFormat: { type: 'string' },
      timeFormat: { type: 'string', enum: ['24h', '12h'] },
      maxImageSize: { type: 'number', minimum: 0 },
      maxImageWidth: { type: 'number', minimum: 1 },
      avatarThumbnailSize: { type: 'number', minimum: 64 },
    },
    additionalProperties: false,
  },
};

const courseIdParamsSchema = {
  params: stringParamsSchema(['courseId']),
};

function buildSettingsResponse(settings = {}) {
  return {
    ...maskSettingsSecrets(normalizeSettingsPayload(settings)),
    emailDeliveryStatus: getMailConfigurationStatus(),
  };
}

function buildSettingsUpdatePayload(currentSettings = {}, updates = {}) {
  const allowedDomains = normalizeAllowedDomains(
    updates.allowedDomains !== undefined ? updates.allowedDomains : currentSettings.allowedDomains
  );
  const nextSsoEnabled = updates.SSO_enabled !== undefined
    ? updates.SSO_enabled === true
    : isSsoEnabled(currentSettings);
  const nextRequireVerified = Boolean(
    (updates.requireVerified !== undefined
      ? updates.requireVerified
      : currentSettings.requireVerified)
    || (!nextSsoEnabled && allowedDomains.length > 0)
  );
  const nextRestrictDomain = Boolean(
    !nextSsoEnabled && (
      (updates.restrictDomain !== undefined
        ? updates.restrictDomain
        : currentSettings.restrictDomain)
      || allowedDomains.length > 0
    )
  );

  const next = {
    ...updates,
    allowedDomains,
    requireVerified: nextRequireVerified,
    restrictDomain: nextRestrictDomain,
    registrationDisabled: updates.registrationDisabled !== undefined
      ? updates.registrationDisabled === true
      : currentSettings.registrationDisabled === true,
  };
  if (updates.AI_Backends !== undefined) {
    const existingById = new Map(normalizeAiBackends(currentSettings.AI_Backends || []).map((backend) => [backend.id, backend]));
    next.AI_Backends = normalizeAiBackends(updates.AI_Backends).map((backend) => ({
      ...backend,
      // Empty values from the write-only UI mean "keep the configured token".
      apiToken: backend.apiToken || existingById.get(backend.id)?.apiToken || '',
    }));
  }
  return next;
}

export default async function settingsRoutes(app) {
  const { authenticate, requireRole } = app;
  const settingsRateLimitPreHandler = app.rateLimit({
    max: 30,
    timeWindow: '1 minute',
  });
  const settingsRateLimit = {
    rateLimit: { max: 30, timeWindow: '1 minute' },
    config: {
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
  };

  // GET / (admin only)
  app.get('/', { preHandler: requireRole(['admin']) }, async (request, reply) => {
    const settings = await getOrCreateSettings();
    return buildSettingsResponse(settings.toObject());
  });

  // PATCH / (admin only)
  app.patch(
    '/',
    {
      preValidation: async (request) => {
        request.body = sanitizeSettingsPatchPayload(request.body);
      },
      preHandler: requireRole(['admin']),
      schema: updateSettingsSchema,
      ...settingsRateLimit,
    },
    async (request, reply) => {
      const updates = request.body || {};

      try {
        const currentSettings = await getOrCreateSettings({ lean: true });
        const settings = await getOrCreateSettings({ select: '_id' });
        const normalizedUpdates = buildSettingsUpdatePayload(currentSettings, updates);

        const updatedSettings = await Settings.findByIdAndUpdate(
          settings._id,
          { $set: normalizedUpdates },
          {
            returnDocument: 'after',
            runValidators: true,
          }
        );

        return buildSettingsResponse(updatedSettings.toObject());
      } catch (err) {
        request.log.error({ err }, 'Failed to update settings');
        return reply.code(400).send({
          error: 'Bad Request',
          message: err.message || 'Failed to update settings',
        });
      }
    }
  );

  app.post(
    '/backup-now',
    {
      preHandler: [requireRole(['admin']), settingsRateLimitPreHandler],
      rateLimit: { max: 30, timeWindow: '1 minute' },
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const requestId = buildBackupRequestId();

      try {
        const settings = await getOrCreateSettings({ select: '_id' });

        const currentSettings = await getOrCreateSettings({ lean: true });
        const backupManagerHealth = getBackupManagerHealth(currentSettings);
        if (backupManagerHealth.status !== 'healthy' && backupManagerHealth.status !== 'warning') {
          return reply.code(503).send({
            error: 'Service Unavailable',
            message: backupManagerHealth.message,
          });
        }

        const updatedSettings = await Settings.findByIdAndUpdate(
          settings._id,
          {
            $set: {
              backupManualRequestId: requestId,
              backupLastRunStatus: 'running',
              backupLastRunType: 'manual',
              backupLastRunMessage: 'Manual backup requested.',
            },
          },
          {
            returnDocument: 'after',
            runValidators: true,
          }
        );

        return buildSettingsResponse(updatedSettings.toObject());
      } catch (err) {
        request.log.error({ err }, 'Failed to queue manual backup');
        return reply.code(400).send({
          error: 'Bad Request',
          message: err.message || 'Failed to queue manual backup',
        });
      }
    }
  );

  app.post(
    '/backup-reset',
    {
      preHandler: [requireRole(['admin']), settingsRateLimitPreHandler],
      rateLimit: { max: 30, timeWindow: '1 minute' },
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      try {
        const settings = await getOrCreateSettings({ select: '_id' });

        const updatedSettings = await Settings.findByIdAndUpdate(
          settings._id,
          {
            $set: {
              backupManualRequestId: '',
              backupLastHandledManualRequestId: '',
              backupLastRunStatus: 'idle',
              backupLastRunType: '',
              backupLastRunMessage: BACKUP_STATE_RESET_MESSAGE,
            },
          },
          {
            returnDocument: 'after',
            runValidators: true,
          }
        );

        return buildSettingsResponse(updatedSettings.toObject());
      } catch (err) {
        request.log.error({ err }, 'Failed to reset backup state');
        return reply.code(400).send({
          error: 'Bad Request',
          message: err.message || 'Failed to reset backup state',
        });
      }
    }
  );

  // GET /public (no auth)
  app.get('/public', async (request, reply) => {
    const settings = await getOrCreateSettings();
    const normalizedSettings = normalizeSettingsPayload(settings.toObject());
    return {
      SSO_enabled: normalizedSettings.SSO_enabled || false,
      SSO_institutionName: normalizedSettings.SSO_institutionName || '',
      restrictDomain: normalizedSettings.restrictDomain || false,
      requireVerified: normalizedSettings.requireVerified || false,
      registrationDisabled: normalizedSettings.registrationDisabled || false,
      Jitsi_Enabled: normalizedSettings.Jitsi_Enabled || false,
      timeFormat: normalizedSettings.timeFormat || '24h',
      maxImageWidth: normalizedSettings.maxImageWidth,
      avatarThumbnailSize: normalizedSettings.avatarThumbnailSize,
    };
  });

  // GET /jitsi-course/:courseId (authenticated) — returns whether Jitsi is enabled for a specific course
  app.get('/jitsi-course/:courseId', { preHandler: authenticate, schema: courseIdParamsSchema, ...settingsRateLimit }, async (request, reply) => {
    const { courseId } = request.params;
    const course = await Course.findById(courseId).select('_id instructors students inactive');
    if (!course) {
      return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    }

    if (!isCourseMember(course, request.user)) {
      const message = course.inactive && isCourseStudent(course, request.user)
        ? 'Course is inactive for students'
        : 'Not enrolled in this course';
      return reply.code(403).send({ error: 'Forbidden', message });
    }

    const settings = await getOrCreateSettings();
    const enabledCourses = settings.Jitsi_EnabledCourses || [];

    return {
      enabled: Boolean(settings.Jitsi_Enabled && enabledCourses.includes(courseId)),
    };
  });

  // GET /ai-course/:courseId — only exposes policy flags, never AI credentials.
  app.get('/ai-course/:courseId', { preHandler: authenticate, schema: courseIdParamsSchema, ...settingsRateLimit }, async (request, reply) => {
    const { courseId } = request.params;
    const course = await Course.findById(courseId).select('_id instructors students inactive');
    if (!course) return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });

    if (!isCourseMember(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Not enrolled in this course' });
    }

    const settings = await getOrCreateSettings();
    const aiEnabledCourses = (settings.AI_EnabledCourses || []).map(String);
    const courseBackends = (settings.AI_AllowCourseBackendCourses || []).map(String);
    const enabled = Boolean(settings.AI_Enabled && aiEnabledCourses.includes(String(courseId)));
    return {
      enabled,
      allowCourseBackend: enabled && courseBackends.includes(String(courseId)),
    };
  });

  // GET /jitsi-domain (authenticated) — returns Jitsi server info for video chat
  app.get('/jitsi-domain', { preHandler: authenticate, ...settingsRateLimit }, async (request, reply) => {
    const settings = await getOrCreateSettings();
    if (!settings.Jitsi_Enabled) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Jitsi is not enabled' });
    }
    return {
      domain: settings.Jitsi_Domain || '',
      etherpad: settings.Jitsi_EtherpadDomain || '',
    };
  });
}
