import mongoose from 'mongoose';
import {
  DEFAULT_BACKUP_MANAGER_CHECK_INTERVAL_SECONDS,
  DEFAULT_BACKUP_MANAGER_HOST_PATH,
  DEFAULT_BACKUP_RETENTION_DAILY,
  DEFAULT_BACKUP_RETENTION_MONTHLY,
  DEFAULT_BACKUP_RETENTION_WEEKLY,
  DEFAULT_BACKUP_TIME_LOCAL,
} from '../utils/authPolicy.js';

const AiModelSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    displayName: { type: String, default: '', maxlength: 200 },
    compatibility: { type: String, enum: ['', 'qrag'], default: '' },
    available: { type: Boolean, default: true },
  },
  { _id: false }
);

const AiBackendSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, default: '' },
    type: { type: String, enum: ['ollama', 'openai'], default: 'ollama' },
    url: { type: String, required: true },
    apiToken: { type: String, default: '' },
    models: { type: [AiModelSchema], default: [] },
  },
  { _id: false }
);

const SettingsSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: 'settings',
      enum: ['settings'],
      required: true,
    },
    restrictDomain: { type: Boolean, default: false },
    allowedDomains: { type: [String], default: [] },
    requireVerified: { type: Boolean, default: false },
    registrationDisabled: { type: Boolean, default: false },
    adminEmail: { type: String, default: '' },
    // Legacy field name (Meteor used 'email' instead of 'adminEmail')
    email: { type: String, default: '' },

    // SSO fields (field names match between legacy and new)
    SSO_enabled: { type: Boolean, default: false },
    SSO_entrypoint: { type: String, default: '' },
    SSO_cert: { type: String, default: '' },
    SSO_privCert: { type: String, default: '' },
    SSO_privKey: { type: String, default: '' },
    SSO_EntityId: { type: String, default: '' },
    SSO_logoutUrl: { type: String, default: '' },
    SSO_identifierFormat: { type: String, default: '' },
    SSO_emailIdentifier: { type: String, default: '' },
    SSO_firstNameIdentifier: { type: String, default: '' },
    SSO_lastNameIdentifier: { type: String, default: '' },
    SSO_studentNumberIdentifier: { type: String, default: '' },
    SSO_institutionName: { type: String, default: '' },
    SSO_roleIdentifier: { type: String, default: '' },
    SSO_roleProfName: { type: String, default: '' },
    // Secure-by-default for new deployments: require signed SAML assertions.
    // Existing settings documents keep whatever value they already stored, so
    // this does not change behaviour for a deployment that is already live.
    SSO_wantAssertionsSigned: { type: Boolean, default: true },
    SSO_wantAuthnResponseSigned: { type: Boolean, default: false },
    SSO_acceptedClockSkewMs: { type: Number, default: 60 * 1000 },
    SSO_disableRequestedAuthnContext: { type: Boolean, default: true },
    SSO_authnContext: { type: String, default: '' },
    SSO_routeMode: {
      type: String,
      enum: ['legacy', 'api_v1'],
      default: 'legacy',
    },

    // Storage config (flat fields matching admin UI)
    storageType: {
      type: String,
      enum: ['local', 's3', 'azure'],
      default: 'local',
    },
    // AWS S3 config (new field names)
    AWS_bucket: { type: String, default: '' },
    AWS_region: { type: String, default: '' },
    AWS_accessKeyId: { type: String, default: '' },
    AWS_secretAccessKey: { type: String, default: '' },
    AWS_endpoint: { type: String, default: '' },
    AWS_forcePathStyle: { type: Boolean, default: false },
    // AWS S3 legacy field names (Meteor used different names)
    AWS_accessKey: { type: String, default: '' },
    AWS_secret: { type: String, default: '' },
    // Azure Blob Storage config (new field names)
    Azure_storageAccount: { type: String, default: '' },
    Azure_storageAccessKey: { type: String, default: '' },
    Azure_storageContainer: { type: String, default: '' },
    // Azure legacy field names (Meteor used different names)
    Azure_accountName: { type: String, default: '' },
    Azure_accountKey: { type: String, default: '' },
    Azure_containerName: { type: String, default: '' },

    // Token expiry (minutes). Default 120 = 2 hours. Adjustable in admin panel.
    tokenExpiryMinutes: { type: Number, default: 120 },

    // Backup manager settings and run metadata.
    backupEnabled: { type: Boolean, default: false },
    backupTimeLocal: {
      type: String,
      default: DEFAULT_BACKUP_TIME_LOCAL,
      match: /^(?:[01]\d|2[0-3]):[0-5]\d$/,
    },
    backupRetentionDaily: { type: Number, default: DEFAULT_BACKUP_RETENTION_DAILY, min: 0 },
    backupRetentionWeekly: { type: Number, default: DEFAULT_BACKUP_RETENTION_WEEKLY, min: 0 },
    backupRetentionMonthly: { type: Number, default: DEFAULT_BACKUP_RETENTION_MONTHLY, min: 0 },
    backupLastRunAt: { type: Date, default: null },
    backupLastRunType: {
      type: String,
      enum: ['', 'daily', 'weekly', 'monthly', 'manual'],
      default: '',
    },
    backupLastRunStatus: {
      type: String,
      enum: ['idle', 'running', 'success', 'failed'],
      default: 'idle',
    },
    backupLastRunFilename: { type: String, default: '' },
    backupLastRunMessage: { type: String, default: '' },
    backupLastDailyRunKey: { type: String, default: '' },
    backupLastWeeklyRunKey: { type: String, default: '' },
    backupLastMonthlyRunKey: { type: String, default: '' },
    backupManualRequestId: { type: String, default: '' },
    backupLastHandledManualRequestId: { type: String, default: '' },
    backupManagerLastSeenAt: { type: Date, default: null },
    backupManagerCheckIntervalSeconds: {
      type: Number,
      default: DEFAULT_BACKUP_MANAGER_CHECK_INTERVAL_SECONDS,
      min: 5,
    },
    backupManagerStatus: {
      type: String,
      enum: ['unknown', 'healthy', 'warning', 'error'],
      default: 'unknown',
    },
    backupManagerMessage: { type: String, default: '' },
    backupManagerHostPath: { type: String, default: DEFAULT_BACKUP_MANAGER_HOST_PATH },

    // Jitsi video chat settings
    Jitsi_Enabled: { type: Boolean, default: false },
    Jitsi_Domain: { type: String, default: '' },
    Jitsi_EtherpadDomain: { type: String, default: '' },
    Jitsi_EnabledCourses: { type: [String], default: [] },

    // OpenAI-compatible AI helper settings. Tokens are never returned from
    // settings routes; see routes/settings.js for write-only handling.
    AI_Enabled: { type: Boolean, default: false },
    AI_ApiUrl: { type: String, default: '' },
    AI_ApiToken: { type: String, default: '' },
    AI_EnabledCourses: { type: [String], default: [] },
    AI_AllowCourseBackendCourses: { type: [String], default: [] },
    AI_Backends: { type: [AiBackendSchema], default: [] },
    AI_DefaultBackendId: { type: String, default: '' },
    AI_DefaultModelId: { type: String, default: '' },
    AI_RequestTimeoutSeconds: { type: Number, default: 300, min: 10, max: 1800 },

    // i18n / locale settings
    locale: { type: String, default: 'en' },
    dateFormat: { type: String, default: 'DD-MMM-YYYY' },
    timeFormat: { type: String, enum: ['24h', '12h'], default: '24h' },

    // Legacy extra fields (preserved so they aren't stripped on save)
    maxImageSize: { type: Number, default: 0 },
    maxImageWidth: { type: Number, default: 1920 },
    avatarThumbnailSize: { type: Number, default: 512 },
  },
  {
    collection: 'settings',
    timestamps: false,
    strict: false,
  }
);

// Virtual getters that resolve new or legacy field names for AWS/Azure/email
SettingsSchema.virtual('resolvedAdminEmail').get(function () {
  return this.adminEmail || this.email || '';
});
SettingsSchema.virtual('resolvedAWSAccessKeyId').get(function () {
  return this.AWS_accessKeyId || this.AWS_accessKey || '';
});
SettingsSchema.virtual('resolvedAWSSecretAccessKey').get(function () {
  return this.AWS_secretAccessKey || this.AWS_secret || '';
});
SettingsSchema.virtual('resolvedAzureStorageAccount').get(function () {
  return this.Azure_storageAccount || this.Azure_accountName || '';
});
SettingsSchema.virtual('resolvedAzureStorageAccessKey').get(function () {
  return this.Azure_storageAccessKey || this.Azure_accountKey || '';
});
SettingsSchema.virtual('resolvedAzureStorageContainer').get(function () {
  return this.Azure_storageContainer || this.Azure_containerName || '';
});

SettingsSchema.set('toJSON', { virtuals: true });
SettingsSchema.set('toObject', { virtuals: true });

const Settings = mongoose.model('Settings', SettingsSchema);

export default Settings;
