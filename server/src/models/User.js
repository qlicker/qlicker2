import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';
import {
  hashPasswordArgon2id,
  verifyPasswordArgon2id,
  requiresPasswordReset,
} from '../utils/password.js';

const EmailSchema = new mongoose.Schema(
  {
    address: { type: String, required: true },
    verified: { type: Boolean, default: false },
  },
  { _id: false }
);

const PasswordSchema = new mongoose.Schema(
  {
    hash: { type: String },
    // Legacy Meteor field. Kept for compatibility checks/reset prompts.
    bcrypt: { type: String },
  },
  { _id: false }
);

const ResumeLoginTokenSchema = new mongoose.Schema(
  {
    sessionId: { type: String },
    createdAt: { type: Date },
    lastUsedAt: { type: Date },
    expiresAt: { type: Date },
    ipAddress: { type: String, default: '' },
  },
  { _id: false, strict: false }
);

const ResumeSchema = new mongoose.Schema(
  {
    loginTokens: { type: [ResumeLoginTokenSchema], default: [] },
  },
  { _id: false }
);

const EmailTokenSchema = new mongoose.Schema(
  {
    token: { type: String },
    address: { type: String },
    when: { type: Date },
  },
  { _id: false }
);

const EmailServiceSchema = new mongoose.Schema(
  {
    verificationTokens: { type: [EmailTokenSchema], default: [] },
  },
  { _id: false }
);

const ResetPasswordSchema = new mongoose.Schema(
  {
    token: { type: String },
    email: { type: String },
    when: { type: Date },
    reason: { type: String, default: 'reset' },
  },
  { _id: false }
);

const SSOSessionSchema = new mongoose.Schema(
  {
    sessionIndex: { type: String },
    loginToken: { type: String },
  },
  { _id: false }
);

const SSOServiceSchema = new mongoose.Schema(
  {
    id: { type: String },
    nameID: { type: String },
    nameIDFormat: { type: String },
    email: { type: String },
    SSORole: { type: String },
    studentNumber: { type: String },
    sessions: { type: [SSOSessionSchema], default: [] },
  },
  { _id: false }
);

const ServicesSchema = new mongoose.Schema(
  {
    password: { type: PasswordSchema, default: () => ({}) },
    resume: { type: ResumeSchema, default: () => ({}) },
    email: { type: EmailServiceSchema, default: () => ({}) },
    resetPassword: { type: ResetPasswordSchema },
    sso: { type: SSOServiceSchema },
  },
  { _id: false }
);

const ProfileSchema = new mongoose.Schema(
  {
    firstname: { type: String, default: '' },
    lastname: { type: String, default: '' },
    roles: { type: [String], default: ['student'] },
    courses: { type: Array, default: [] },
    studentNumber: { type: String, default: '' },
    profileImage: { type: String, default: '' },
    profileThumbnail: { type: String, default: '' },
    canPromote: { type: Boolean, default: false },
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    emails: { type: [EmailSchema], default: [] },
    services: { type: ServicesSchema, default: () => ({}) },
    profile: { type: ProfileSchema, default: () => ({}) },
    ssoCreated: { type: Boolean, default: false },
    // Explicit exception used when institution-wide SSO is enabled.
    // Admin accounts are always treated as allowed regardless of this flag.
    allowEmailLogin: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    disabledAt: { type: Date, default: null },
    lastAuthProvider: { type: String, default: '' },
    refreshTokenVersion: { type: Number, default: 0 },
    failedLoginAttempts: { type: Number, default: 0 },
    loginLockedUntil: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    lastLogin: { type: Date },
    lastLoginIp: { type: String, default: '' },
    // Per-user locale preference (overrides app default from Settings).
    // Empty string or missing means "use app default".
    locale: { type: String, default: '' },
  },
  {
    collection: 'users',
    timestamps: false,
  }
);

// Indexes for query performance (matching legacy database indexes)
UserSchema.index({ 'emails.address': 1 });
UserSchema.index({ lastLogin: 1 });

// Virtual: convenient email getter
UserSchema.virtual('email').get(function () {
  return this.emails?.[0]?.address;
});

UserSchema.methods.isSSOLinked = function () {
  return !!this.services?.sso?.id;
};

UserSchema.methods.isSSOCreatedUser = function () {
  return !!this.ssoCreated;
};

UserSchema.methods.canUseEmailLogin = function () {
  return this.allowEmailLogin === true;
};

// Instance method: verify password
UserSchema.methods.verifyPassword = async function (password) {
  const hash = this.services?.password?.hash;
  if (!hash) return false;
  return verifyPasswordArgon2id(password, hash);
};

// Instance method: identify legacy hashes that require reset
UserSchema.methods.passwordResetRequired = function () {
  const current = this.services?.password?.hash;
  if (typeof current === 'string' && current.length > 0) return false;
  const legacy = this.services?.password?.bcrypt;
  if (requiresPasswordReset(legacy)) return true;
  // No local password hash (typical for some legacy SSO-only users).
  return true;
};

// Instance method: explain why reset is required
UserSchema.methods.passwordResetReason = function () {
  const current = this.services?.password?.hash;
  if (typeof current === 'string' && current.length > 0) return null;
  const legacy = this.services?.password?.bcrypt;
  if (requiresPasswordReset(legacy)) return 'legacy_hash';
  return 'no_local_password';
};

// Static method: hash password
UserSchema.statics.hashPassword = async function (password) {
  return hashPasswordArgon2id(password);
};

// Ensure virtuals are included in JSON/Object output
UserSchema.set('toJSON', { virtuals: true });
UserSchema.set('toObject', { virtuals: true });

const User = mongoose.model('User', UserSchema);

export default User;
