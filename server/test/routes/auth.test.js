import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createApp, createTestUser, getAuthToken, authenticatedRequest, csrfHeaders } from '../helpers.js';
import Settings from '../../src/models/Settings.js';
import User from '../../src/models/User.js';
import Course from '../../src/models/Course.js';

let app;

function extractCookieValue(setCookieHeader, name) {
  const entries = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const entry of entries) {
    const match = String(entry || '').match(new RegExp(`${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

beforeEach(async (ctx) => {
  if (mongoose.connection.readyState !== 1) {
    ctx.skip();
    return;
  }
  app = await createApp();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

// ---------- POST /api/v1/auth/register ----------
describe('POST /api/v1/auth/register', () => {
  it('creates a new user with valid data', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { ...csrfHeaders },
      payload: {
        email: 'new@example.com',
        password: 'password123',
        firstname: 'New',
        lastname: 'User',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toBeDefined();
    expect(body.user).toBeDefined();
    expect(body.user.profile.firstname).toBe('New');
    expect(body.user.profile.lastname).toBe('User');
    expect(body.user.emails[0].address).toBe('new@example.com');
  });

  it('first user becomes admin', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { ...csrfHeaders },
      payload: {
        email: 'admin@example.com',
        password: 'password123',
        firstname: 'Admin',
        lastname: 'User',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.profile.roles).toContain('admin');
  });

  it('second user becomes student', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'first@example.com', roles: ['admin'] });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { ...csrfHeaders },
      payload: {
        email: 'second@example.com',
        password: 'password123',
        firstname: 'Second',
        lastname: 'User',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.profile.roles).toContain('student');
    expect(body.user.profile.roles).not.toContain('admin');
  });

  it('returns JWT token and user profile', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { ...csrfHeaders },
      payload: {
        email: 'jwt@example.com',
        password: 'password123',
        firstname: 'JWT',
        lastname: 'Test',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.user.profile).toBeDefined();
    expect(body.user.services).toBeUndefined();
  });

  it('records last-login audit metadata for newly registered users', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: {
        ...csrfHeaders,
        'x-forwarded-for': '203.0.113.10',
      },
      payload: {
        email: 'audit-register@example.com',
        password: 'password123',
        firstname: 'Audit',
        lastname: 'Register',
      },
    });

    expect(res.statusCode).toBe(201);

    const stored = await User.findOne({ 'emails.address': 'audit-register@example.com' });
    expect(stored.lastLogin).toBeInstanceOf(Date);
    expect(stored.lastLoginIp).toBe('203.0.113.10');
    expect(stored.services?.resume?.loginTokens).toHaveLength(1);
    expect(stored.services.resume.loginTokens[0].ipAddress).toBe('203.0.113.10');
  });

  it('rejects duplicate email', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'dup@example.com' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { ...csrfHeaders },
      payload: {
        email: 'dup@example.com',
        password: 'password123',
        firstname: 'Dup',
        lastname: 'User',
      },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.message).toMatch(/already registered/i);
  });

  it('rejects self-registration when disabled in settings', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { registrationDisabled: true } },
      { upsert: true, returnDocument: 'after' }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { ...csrfHeaders },
      payload: {
        email: 'blocked@example.com',
        password: 'password123',
        firstname: 'Blocked',
        lastname: 'User',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SELF_REGISTRATION_DISABLED');
  });

  it('rejects unapproved email domains when allowed domains are configured', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { restrictDomain: false, allowedDomains: ['allowed.edu'], requireVerified: false } },
      { upsert: true, returnDocument: 'after' }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { ...csrfHeaders },
      payload: {
        email: 'student@other.edu',
        password: 'password123',
        firstname: 'Other',
        lastname: 'Domain',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/domain not allowed/i);
  });

  it('requires email verification for local signups when allowed domains are configured', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    await createTestUser({ email: 'admin@example.com', roles: ['admin'] });
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { restrictDomain: false, allowedDomains: ['allowed.edu'], requireVerified: false } },
      { upsert: true, returnDocument: 'after' }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { ...csrfHeaders },
      payload: {
        email: 'student@allowed.edu',
        password: 'password123',
        firstname: 'Allowed',
        lastname: 'Student',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().requiresEmailVerification).toBe(true);
    expect(res.json().token).toBeUndefined();

    const stored = await User.findOne({ 'emails.address': 'student@allowed.edu' });
    expect(stored).toBeTruthy();
    expect(stored.emails[0].verified).toBe(false);
    expect(stored.services?.email?.verificationTokens).toHaveLength(1);
    expect(stored.services?.resume?.loginTokens || []).toHaveLength(0);
  });

  it('ignores local domain restrictions when institution-wide SSO is enabled', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    await createTestUser({ email: 'admin@example.com', roles: ['admin'] });
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      {
        $set: {
          SSO_enabled: true,
          restrictDomain: true,
          allowedDomains: ['allowed.edu'],
          requireVerified: false,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { ...csrfHeaders },
      payload: {
        email: 'student@other.edu',
        password: 'password123',
        firstname: 'Sso',
        lastname: 'Ignored',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(typeof res.json().token).toBe('string');
  });

  it('rejects missing required fields', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: { ...csrfHeaders },
      payload: {
        email: 'missing@example.com',
      },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ---------- POST /api/v1/auth/login ----------
describe('POST /api/v1/auth/login', () => {
  it('returns JWT with valid credentials', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'login@example.com', password: 'password123' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'login@example.com',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeDefined();
    expect(typeof body.token).toBe('string');
  });

  it('marks student-role instructor accounts as student-dashboard users in the login response', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const owner = await createTestUser({ email: 'owner-login@example.com', roles: ['professor'] });
    const ownerToken = await getAuthToken(app, owner);
    const courseRes = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
      token: ownerToken,
      payload: {
        name: 'Login Course',
        deptCode: 'CS',
        courseNumber: '201',
        section: '001',
        semester: 'Fall 2026',
      },
    });
    expect(courseRes.statusCode).toBe(201);
    const course = courseRes.json().course;

    const mixed = await createTestUser({ email: 'mixed-login@example.com', password: 'password123', roles: ['student'] });
    const addInstructorRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${course._id}/instructors`, {
      token: ownerToken,
      payload: { userId: mixed._id.toString() },
    });
    expect(addInstructorRes.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'mixed-login@example.com',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.hasInstructorCourses).toBe(true);
    expect(body.user.canAccessProfessorDashboard).toBe(false);
    expect(body.user.profile.roles).toContain('student');
    expect(body.user.profile.roles).not.toContain('professor');
  });

  it('skips instructor-course lookups for plain student logins', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'plain-student-login@example.com', password: 'password123', roles: ['student'] });

    const existsSpy = vi.spyOn(Course, 'exists');

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'plain-student-login@example.com',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.hasInstructorCourses).toBe(false);
    expect(res.json().user.canAccessProfessorDashboard).toBe(false);
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it('rejects wrong password', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'wrong@example.com', password: 'password123' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'wrong@example.com',
        password: 'wrongpassword',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.message).toMatch(/invalid/i);
  });

  it('rejects non-existent email', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'nonexistent@example.com',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.message).toMatch(/invalid/i);
  });

  it('rejects unverified email logins when verified email is required', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const user = await createTestUser({ email: 'needs-verify@example.com', password: 'password123' });
    await User.updateOne(
      { _id: user._id },
      { $set: { 'emails.0.verified': false } }
    );
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { requireVerified: true } },
      { upsert: true, returnDocument: 'after' }
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'needs-verify@example.com',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('rejects disabled accounts', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'disabled-login@example.com', password: 'password123' });
    await User.updateOne({ _id: user._id }, { $set: { disabled: true, disabledAt: new Date() } });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'disabled-login@example.com',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('ACCOUNT_DISABLED');
  });

  it('returns user profile without services field', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'profile@example.com', password: 'password123' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'profile@example.com',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toBeDefined();
    expect(body.user.services).toBeUndefined();
    expect(body.user.profile).toBeDefined();
  });

  it('records client IP metadata on login and refresh rotation', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'audit-login@example.com', password: 'password123' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        ...csrfHeaders,
        'x-forwarded-for': '198.51.100.20',
      },
      payload: {
        email: 'audit-login@example.com',
        password: 'password123',
      },
    });

    expect(loginRes.statusCode).toBe(200);
    const refreshToken = extractCookieValue(loginRes.headers['set-cookie'], 'refreshToken');
    expect(refreshToken).toBeTruthy();

    const storedAfterLogin = await User.findOne({ 'emails.address': 'audit-login@example.com' });
    expect(storedAfterLogin.lastLoginIp).toBe('198.51.100.20');
    expect(storedAfterLogin.services.resume.loginTokens[0].ipAddress).toBe('198.51.100.20');
    const firstSessionId = storedAfterLogin.services.resume.loginTokens[0].sessionId;

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        'x-forwarded-for': '198.51.100.99',
        cookie: `refreshToken=${refreshToken}`,
      },
    });

    expect(refreshRes.statusCode).toBe(200);

    const storedAfterRefresh = await User.findOne({ 'emails.address': 'audit-login@example.com' });
    expect(storedAfterRefresh.services.resume.loginTokens[0].sessionId).not.toBe(firstSessionId);
    expect(storedAfterRefresh.services.resume.loginTokens[0].ipAddress).toBe('198.51.100.99');
  });

  it('finds mixed-case email user (case-insensitive lookup)', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    // Simulate a user stored with mixed-case email
    const User = (await import('../../src/models/User.js')).default;
    const hashedPassword = await User.hashPassword('password123');
    await User.create({
      emails: [{ address: 'John.Doe@University.Edu', verified: true }],
      services: { password: { hash: hashedPassword } },
      profile: { firstname: 'John', lastname: 'Doe', roles: ['student'] },
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'john.doe@university.edu',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeDefined();
    expect(body.user).toBeDefined();
    expect(body.user.profile.firstname).toBe('John');
  });

  it('requires password reset for legacy bcrypt users', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const User = (await import('../../src/models/User.js')).default;
    await User.create({
      emails: [{ address: 'legacy@example.com', verified: true }],
      services: { password: { bcrypt: '$2a$10$RpS898ow7xM8/7VsgV.CRO07nMYdzt5t62DZXEejz75DbUIH.clgm' } },
      profile: { firstname: 'Legacy', lastname: 'User', roles: ['student'] },
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'legacy@example.com',
        password: 'anything',
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe('PASSWORD_RESET_REQUIRED');
    expect(body.requiresPasswordReset).toBe(true);
    expect(body.reason).toBe('legacy_hash');
    expect(body.message).toMatch(/reset/i);
  });

  it('requires password reset when no local password is set', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const User = (await import('../../src/models/User.js')).default;
    await User.create({
      emails: [{ address: 'nopass@example.com', verified: true }],
      services: {},
      profile: { firstname: 'No', lastname: 'Password', roles: ['student'] },
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'nopass@example.com',
        password: 'anything',
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe('PASSWORD_RESET_REQUIRED');
    expect(body.requiresPasswordReset).toBe(true);
    expect(body.reason).toBe('no_local_password');
    expect(body.message).toMatch(/reset/i);
  });

  it('allows login when argon2 hash exists even if legacy bcrypt field is present', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const User = (await import('../../src/models/User.js')).default;
    const hashedPassword = await User.hashPassword('password123');
    await User.create({
      emails: [{ address: 'dual@example.com', verified: true }],
      services: {
        password: {
          hash: hashedPassword,
          bcrypt: '$2a$10$RpS898ow7xM8/7VsgV.CRO07nMYdzt5t62DZXEejz75DbUIH.clgm',
        },
      },
      profile: { firstname: 'Dual', lastname: 'Mode', roles: ['student'] },
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'dual@example.com',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeDefined();
    expect(body.user).toBeDefined();
  });

  it('blocks email login for SSO-created users until admin approval is enabled', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { SSO_enabled: true } },
      { upsert: true }
    );
    const User = (await import('../../src/models/User.js')).default;
    const hashedPassword = await User.hashPassword('password123');
    await User.create({
      emails: [{ address: 'sso-only@example.com', verified: true }],
      services: {
        password: { hash: hashedPassword },
        sso: { id: 'sso-user-1', email: 'sso-only@example.com' },
      },
      profile: { firstname: 'SSO', lastname: 'Only', roles: ['student'] },
      ssoCreated: true,
      allowEmailLogin: false,
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'sso-only@example.com',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe('SSO_EMAIL_LOGIN_DISABLED');
    expect(body.message).toMatch(/SSO/i);
  });

  it('blocks local email login for non-admin accounts when institution-wide SSO is enabled and no exception is set', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { SSO_enabled: true } },
      { upsert: true }
    );
    await createTestUser({ email: 'local-sso-blocked@example.com', password: 'password123' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'local-sso-blocked@example.com',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SSO_EMAIL_LOGIN_DISABLED');
  });

  it('still allows admin accounts to log in by email when SSO is enabled', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { SSO_enabled: true } },
      { upsert: true }
    );
    await createTestUser({
      email: 'admin-sso-login@example.com',
      password: 'password123',
      roles: ['admin'],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'admin-sso-login@example.com',
        password: 'password123',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.allowEmailLogin).toBe(true);
  });
});

// ---------- POST /api/v1/auth/logout ----------
describe('POST /api/v1/auth/logout', () => {
  it('returns success', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...csrfHeaders },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
  });

  it('invalidates the current refresh token when present', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'logout-refresh@example.com', password: 'password123' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'logout-refresh@example.com',
        password: 'password123',
      },
    });
    expect(loginRes.statusCode).toBe(200);

    const refreshCookie = extractCookieValue(loginRes.headers['set-cookie'], 'refreshToken');
    expect(refreshCookie).toBeTruthy();

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${refreshCookie}`,
      },
    });
    expect(logoutRes.statusCode).toBe(200);

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${refreshCookie}`,
      },
    });
    expect(refreshRes.statusCode).toBe(401);
  });

  it('does not log out a second device when the first device logs out', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'logout-multi@example.com', password: 'password123' });

    const firstLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'logout-multi@example.com',
        password: 'password123',
      },
    });
    const secondLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'logout-multi@example.com',
        password: 'password123',
      },
    });

    const firstRefreshCookie = extractCookieValue(firstLoginRes.headers['set-cookie'], 'refreshToken');
    const secondRefreshCookie = extractCookieValue(secondLoginRes.headers['set-cookie'], 'refreshToken');
    expect(firstRefreshCookie).toBeTruthy();
    expect(secondRefreshCookie).toBeTruthy();
    expect(secondRefreshCookie).not.toBe(firstRefreshCookie);

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${firstRefreshCookie}`,
      },
    });
    expect(logoutRes.statusCode).toBe(200);

    const firstRefreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${firstRefreshCookie}`,
      },
    });
    expect(firstRefreshRes.statusCode).toBe(401);

    const secondRefreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${secondRefreshCookie}`,
      },
    });
    expect(secondRefreshRes.statusCode).toBe(200);
    expect(secondRefreshRes.json().token).toBeTruthy();
  });
});

// ---------- POST /api/v1/auth/refresh ----------
describe('POST /api/v1/auth/refresh', () => {
  it('rejects refresh for disabled accounts and clears the cookie', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'disabled-refresh@example.com', password: 'password123' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'disabled-refresh@example.com',
        password: 'password123',
      },
    });
    expect(loginRes.statusCode).toBe(200);

    const refreshToken = extractCookieValue(loginRes.headers['set-cookie'], 'refreshToken');
    await User.updateOne({ _id: user._id }, { $set: { disabled: true, disabledAt: new Date() } });

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${refreshToken}`,
      },
    });

    expect(refreshRes.statusCode).toBe(403);
    expect(refreshRes.json().code).toBe('ACCOUNT_DISABLED');
  });

  it('rotates refresh tokens so the previous token becomes invalid after use', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'rotate@example.com', password: 'password123' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'rotate@example.com',
        password: 'password123',
      },
    });
    expect(loginRes.statusCode).toBe(200);

    const originalRefreshToken = extractCookieValue(loginRes.headers['set-cookie'], 'refreshToken');
    expect(originalRefreshToken).toBeTruthy();

    const firstRefreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${originalRefreshToken}`,
      },
    });
    expect(firstRefreshRes.statusCode).toBe(200);
    expect(firstRefreshRes.json().token).toBeTruthy();

    const rotatedRefreshToken = extractCookieValue(firstRefreshRes.headers['set-cookie'], 'refreshToken');
    expect(rotatedRefreshToken).toBeTruthy();
    expect(rotatedRefreshToken).not.toBe(originalRefreshToken);

    const rejectedReuseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${originalRefreshToken}`,
      },
    });
    expect(rejectedReuseRes.statusCode).toBe(401);

    const secondRefreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${rotatedRefreshToken}`,
      },
    });
    expect(secondRefreshRes.statusCode).toBe(200);
    expect(secondRefreshRes.json().token).toBeTruthy();
  });

  it('accepts one legacy refresh token (no version claim) and rotates to a session-based token', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'legacy-refresh@example.com', password: 'password123' });
    await User.updateOne({ _id: user._id }, { $unset: { refreshTokenVersion: 1 } });

    const legacyRefreshToken = jwt.sign(
      { userId: user._id, type: 'refresh' },
      app.config.jwtRefreshSecret,
      { expiresIn: '7d' }
    );

    const firstRefreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${legacyRefreshToken}`,
      },
    });
    expect(firstRefreshRes.statusCode).toBe(200);
    expect(firstRefreshRes.json().token).toBeTruthy();

    const rotatedRefreshToken = extractCookieValue(firstRefreshRes.headers['set-cookie'], 'refreshToken');
    expect(rotatedRefreshToken).toBeTruthy();
    const rotatedPayload = jwt.verify(rotatedRefreshToken, app.config.jwtRefreshSecret);
    expect(typeof rotatedPayload.sessionId).toBe('string');
    expect(rotatedPayload.sessionId.length).toBeGreaterThan(0);

    const rejectedLegacyReuseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${legacyRefreshToken}`,
      },
    });
    expect(rejectedLegacyReuseRes.statusCode).toBe(401);
  });

  it('lets two separately logged-in devices refresh independently', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'multi-device@example.com', password: 'password123' });

    const firstLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'multi-device@example.com',
        password: 'password123',
      },
    });
    const secondLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'multi-device@example.com',
        password: 'password123',
      },
    });

    const firstRefreshCookie = extractCookieValue(firstLoginRes.headers['set-cookie'], 'refreshToken');
    const secondRefreshCookie = extractCookieValue(secondLoginRes.headers['set-cookie'], 'refreshToken');
    expect(firstRefreshCookie).toBeTruthy();
    expect(secondRefreshCookie).toBeTruthy();
    expect(secondRefreshCookie).not.toBe(firstRefreshCookie);

    const firstRefreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${firstRefreshCookie}`,
      },
    });
    const secondRefreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${secondRefreshCookie}`,
      },
    });

    expect(firstRefreshRes.statusCode).toBe(200);
    expect(secondRefreshRes.statusCode).toBe(200);
    expect(firstRefreshRes.json().token).toBeTruthy();
    expect(secondRefreshRes.json().token).toBeTruthy();

    const rotatedFirstRefresh = extractCookieValue(firstRefreshRes.headers['set-cookie'], 'refreshToken');
    const rotatedSecondRefresh = extractCookieValue(secondRefreshRes.headers['set-cookie'], 'refreshToken');
    expect(rotatedFirstRefresh).toBeTruthy();
    expect(rotatedSecondRefresh).toBeTruthy();
    expect(rotatedFirstRefresh).not.toBe(rotatedSecondRefresh);

    const rejectedReuseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${firstRefreshCookie}`,
      },
    });
    expect(rejectedReuseRes.statusCode).toBe(401);
  });

  it('uses tokenExpiryMinutes for refresh-session lifetime without extending that lifetime on rotation', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { tokenExpiryMinutes: 2 } },
      { upsert: true }
    );
    await createTestUser({ email: 'expiry@example.com', password: 'password123' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'expiry@example.com',
        password: 'password123',
      },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(String(loginRes.headers['set-cookie'])).toContain('Max-Age=120');

    const refreshToken = extractCookieValue(loginRes.headers['set-cookie'], 'refreshToken');
    expect(refreshToken).toBeTruthy();

    const storedAfterLogin = await User.findOne({ 'emails.address': 'expiry@example.com' });
    const initialExpiryMs = new Date(storedAfterLogin.services.resume.loginTokens[0].expiresAt).getTime();

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${refreshToken}`,
      },
    });
    expect(refreshRes.statusCode).toBe(200);

    const storedAfterRefresh = await User.findOne({ 'emails.address': 'expiry@example.com' });
    const rotatedExpiryMs = new Date(storedAfterRefresh.services.resume.loginTokens[0].expiresAt).getTime();
    expect(rotatedExpiryMs).toBe(initialExpiryMs);
  });

  it('rejects refresh when the server-side session has expired even if the cookie JWT is still valid', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'expired-session@example.com', password: 'password123' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'expired-session@example.com',
        password: 'password123',
      },
    });
    expect(loginRes.statusCode).toBe(200);

    const refreshToken = extractCookieValue(loginRes.headers['set-cookie'], 'refreshToken');
    expect(refreshToken).toBeTruthy();

    await User.updateOne(
      { 'emails.address': 'expired-session@example.com' },
      { $set: { 'services.resume.loginTokens.0.expiresAt': new Date(Date.now() - 1000) } }
    );

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        ...csrfHeaders,
        cookie: `refreshToken=${refreshToken}`,
      },
    });

    expect(refreshRes.statusCode).toBe(401);
  });
});

// ---------- POST /api/v1/auth/forgot-password ----------
describe('POST /api/v1/auth/forgot-password', () => {
  it('does not create a reset token for unapproved SSO-created users', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { SSO_enabled: true } },
      { upsert: true }
    );
    const User = (await import('../../src/models/User.js')).default;
    await User.create({
      emails: [{ address: 'sso-forgot@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        sso: { id: 'sso-forgot-1', email: 'sso-forgot@example.com' },
      },
      profile: { firstname: 'SSO', lastname: 'Forgot', roles: ['student'] },
      ssoCreated: true,
      allowEmailLogin: false,
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      headers: { ...csrfHeaders },
      payload: { email: 'sso-forgot@example.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const stored = await User.findOne({ 'emails.address': 'sso-forgot@example.com' });
    expect(stored.services?.resetPassword).toBeUndefined();
  });
});

describe('login hardening', () => {
  it('temporarily locks an account after repeated failed password attempts and clears the lock on success', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'locked@example.com', password: 'password123' });

    for (let attempt = 1; attempt < 5; attempt += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { ...csrfHeaders },
        payload: {
          email: 'locked@example.com',
          password: 'wrongpassword',
        },
      });
      expect(res.statusCode).toBe(401);
    }

    const lockRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'locked@example.com',
        password: 'wrongpassword',
      },
    });
    expect(lockRes.statusCode).toBe(423);
    expect(lockRes.json().code).toBe('ACCOUNT_LOCKED');

    const lockedCorrectPasswordRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'locked@example.com',
        password: 'password123',
      },
    });
    expect(lockedCorrectPasswordRes.statusCode).toBe(423);

    await (await import('../../src/models/User.js')).default.findByIdAndUpdate(user._id, {
      $set: {
        loginLockedUntil: new Date(Date.now() - 1000),
      },
    });

    const unlockedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'locked@example.com',
        password: 'password123',
      },
    });
    expect(unlockedRes.statusCode).toBe(200);

    const updated = await (await import('../../src/models/User.js')).default.findById(user._id);
    expect(updated.failedLoginAttempts).toBe(0);
    expect(updated.loginLockedUntil).toBeNull();
  });

  it('issues refresh tokens with a session identifier claim', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await createTestUser({ email: 'version@example.com', password: 'password123' });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: {
        email: 'version@example.com',
        password: 'password123',
      },
    });
    expect(loginRes.statusCode).toBe(200);

    const refreshToken = extractCookieValue(loginRes.headers['set-cookie'], 'refreshToken');
    const decoded = jwt.verify(refreshToken, app.config.jwtRefreshSecret);
    expect(decoded.type).toBe('refresh');
    expect(typeof decoded.sessionId).toBe('string');
    expect(decoded.sessionId.length).toBeGreaterThan(0);
  });
});

// ---------- POST /api/v1/auth/reset-password ----------
describe('POST /api/v1/auth/reset-password', () => {
  it('rejects password resets for unapproved SSO-created users', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { SSO_enabled: true } },
      { upsert: true }
    );
    const User = (await import('../../src/models/User.js')).default;
    await User.create({
      emails: [{ address: 'sso-reset@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        resetPassword: {
          token: 'blocked-reset-token',
          email: 'sso-reset@example.com',
          when: new Date(),
          reason: 'reset',
        },
        sso: { id: 'sso-reset-1', email: 'sso-reset@example.com' },
      },
      profile: { firstname: 'SSO', lastname: 'Reset', roles: ['student'] },
      ssoCreated: true,
      allowEmailLogin: false,
      createdAt: new Date(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      headers: { ...csrfHeaders },
      payload: { token: 'blocked-reset-token', newPassword: 'newpassword456' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SSO_EMAIL_LOGIN_DISABLED');
  });
});

// ---------- GET /api/v1/auth/sso/login ----------
describe('GET /api/v1/auth/sso/login', () => {
  it('uses Microsoft-compatible SAML validation defaults', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    await Settings.create({
      _id: 'settings',
      SSO_enabled: true,
      SSO_emailIdentifier: 'mail',
      SSO_EntityId: 'qlicker-test',
      SSO_entrypoint: 'https://idp.example.com/login',
      SSO_cert: 'ZmFrZS1pZHAtY2VydA==',
    });

    const saml = await app.getSamlProvider();

    expect(saml).toBeTruthy();
    // Secure-by-default: assertions must be signed unless explicitly disabled.
    expect(saml.options.wantAssertionsSigned).toBe(true);
    expect(saml.options.wantAuthnResponseSigned).toBe(false);
    expect(saml.options.acceptedClockSkewMs).toBe(60 * 1000);
  });

  it('accepts SSO private keys stored with escaped newlines', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const escapedPrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');

    await Settings.create({
      _id: 'settings',
      SSO_enabled: true,
      SSO_emailIdentifier: 'mail',
      SSO_EntityId: 'qlicker-test',
      SSO_entrypoint: 'https://idp.example.com/login',
      SSO_cert: 'ZmFrZS1pZHAtY2VydA==',
      SSO_privKey: escapedPrivateKey,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/login',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/idp\.example\.com\/login\?/);
    expect(res.headers.location).toContain('SAMLRequest=');
    expect(res.headers.location).toContain('Signature=');
  });

  it('uses legacy ACS and logout callback paths even on the current login alias', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const getAuthorizeUrlAsync = vi.fn(async () => 'https://idp.example.com/login?SAMLRequest=current-alias');
    app.getSamlProvider = vi.fn(async (options) => {
      expect(options).toEqual({
        callbackPath: '/SSO/SAML2',
        logoutCallbackPath: '/SSO/SAML2/logout',
      });
      return { getAuthorizeUrlAsync };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/login',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://idp.example.com/login?SAMLRequest=current-alias');
    expect(getAuthorizeUrlAsync).toHaveBeenCalledOnce();
  });

  it('can present the api_v1 callback and logout routes to the IdP when route mode is switched', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      {
        $set: {
          SSO_enabled: true,
          SSO_routeMode: 'api_v1',
        },
      },
      { upsert: true }
    );

    const getAuthorizeUrlAsync = vi.fn(async () => 'https://idp.example.com/login?SAMLRequest=api-v1');
    app.getSamlProvider = vi.fn(async (options) => {
      expect(options).toEqual({
        callbackPath: '/api/v1/auth/sso/callback',
        logoutCallbackPath: '/api/v1/auth/sso/logout',
      });
      return { getAuthorizeUrlAsync };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/login',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://idp.example.com/login?SAMLRequest=api-v1');
    expect(getAuthorizeUrlAsync).toHaveBeenCalledOnce();
  });
});

// ---------- GET /SSO/SAML2 ----------
describe('GET /SSO/SAML2', () => {
  it('uses the legacy ACS and logout callback paths when initiating SSO login', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const getAuthorizeUrlAsync = vi.fn(async () => 'https://idp.example.com/login?SAMLRequest=legacy');
    app.getSamlProvider = vi.fn(async (options) => {
      expect(options).toEqual({
        callbackPath: '/SSO/SAML2',
        logoutCallbackPath: '/SSO/SAML2/logout',
      });
      return { getAuthorizeUrlAsync };
    });

    const res = await app.inject({
      method: 'GET',
      url: '/SSO/SAML2',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://idp.example.com/login?SAMLRequest=legacy');
    expect(getAuthorizeUrlAsync).toHaveBeenCalledOnce();
  });
});

// ---------- POST /api/v1/auth/sso/callback ----------
describe('POST /api/v1/auth/sso/callback', () => {
  it('marks newly created SSO users as SSO-created and disables email login by default', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.create({
      _id: 'settings',
      SSO_enabled: true,
      SSO_emailIdentifier: 'mail',
      SSO_firstNameIdentifier: 'givenName',
      SSO_lastNameIdentifier: 'sn',
      SSO_EntityId: 'qlicker-test',
      SSO_entrypoint: 'https://idp.example.com/login',
    });
    app.getSamlProvider = async () => ({
      validatePostResponseAsync: async () => ({
        profile: {
          nameID: 'sso-created-user',
          attributes: {
            mail: 'created-via-sso@example.com',
            givenName: 'Created',
            sn: 'FromSSO',
          },
        },
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sso/callback',
      payload: { SAMLResponse: 'stub' },
    });

    expect(res.statusCode).toBe(302);
    const User = (await import('../../src/models/User.js')).default;
    const created = await User.findOne({ 'emails.address': 'created-via-sso@example.com' });
    expect(created).toBeTruthy();
    expect(created.ssoCreated).toBe(true);
    expect(created.allowEmailLogin).toBe(false);
    expect(created.lastAuthProvider).toBe('sso');
    expect(created.emails?.[0]?.verified).toBe(true);
  });
});

// ---------- POST /SSO/SAML2 ----------
describe('POST /SSO/SAML2', () => {
  it('accepts the legacy ACS callback and creates an SSO user', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.create({
      _id: 'settings',
      SSO_enabled: true,
      SSO_emailIdentifier: 'mail',
      SSO_firstNameIdentifier: 'givenName',
      SSO_lastNameIdentifier: 'sn',
      SSO_EntityId: 'qlicker-test',
      SSO_entrypoint: 'https://idp.example.com/login',
    });

    app.getSamlProvider = vi.fn(async (options) => {
      expect(options).toEqual({
        callbackPath: '/SSO/SAML2',
        logoutCallbackPath: '/SSO/SAML2/logout',
      });
      return {
        validatePostResponseAsync: async () => ({
          profile: {
            nameID: 'legacy-sso-user',
            attributes: {
              mail: 'legacy-sso@example.com',
              givenName: 'Legacy',
              sn: 'Route',
            },
          },
        }),
      };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/SSO/SAML2',
      payload: { SAMLResponse: 'stub' },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(new RegExp(`^${app.config.rootUrl}/sso-callback\\?token=`));

    const created = await User.findOne({ 'emails.address': 'legacy-sso@example.com' });
    expect(created).toBeTruthy();
    expect(created.ssoCreated).toBe(true);
    expect(created.allowEmailLogin).toBe(false);
    expect(created.lastAuthProvider).toBe('sso');
  });
});

// ---------- GET /SSO/SAML2/metadata ----------
describe('GET /SSO/SAML2/metadata', () => {
  it('publishes the legacy ACS and SLO endpoints in metadata', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.create({
      _id: 'settings',
      SSO_enabled: true,
      SSO_emailIdentifier: 'mail',
      SSO_EntityId: 'qlicker-test',
      SSO_entrypoint: 'https://idp.example.com/login',
      SSO_cert: 'ZmFrZS1pZHAtY2VydA==',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/SSO/SAML2/metadata',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.body).toContain(`${app.config.rootUrl}/SSO/SAML2`);
    expect(res.body).toContain(`${app.config.rootUrl}/SSO/SAML2/logout`);
  });

  it('serves the legacy metadata.xml alias', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.create({
      _id: 'settings',
      SSO_enabled: true,
      SSO_emailIdentifier: 'mail',
      SSO_EntityId: 'qlicker-test',
      SSO_entrypoint: 'https://idp.example.com/login',
      SSO_cert: 'ZmFrZS1pZHAtY2VydA==',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/SSO/SAML2/metadata.xml',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`${app.config.rootUrl}/SSO/SAML2`);
  });
});

// ---------- GET /api/v1/auth/sso/metadata ----------
describe('GET /api/v1/auth/sso/metadata', () => {
  it('publishes legacy ACS and SLO endpoints on the current metadata alias', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.create({
      _id: 'settings',
      SSO_enabled: true,
      SSO_emailIdentifier: 'mail',
      SSO_EntityId: 'qlicker-test',
      SSO_entrypoint: 'https://idp.example.com/login',
      SSO_cert: 'ZmFrZS1pZHAtY2VydA==',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/metadata',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.body).toContain(`${app.config.rootUrl}/SSO/SAML2`);
    expect(res.body).toContain(`${app.config.rootUrl}/SSO/SAML2/logout`);
    expect(res.body).not.toContain(`${app.config.rootUrl}/api/v1/auth/sso/callback`);
    expect(res.body).not.toContain(`${app.config.rootUrl}/api/v1/auth/sso/logout`);
  });

  it('publishes api_v1 ACS and SLO endpoints when route mode is switched', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.create({
      _id: 'settings',
      SSO_enabled: true,
      SSO_routeMode: 'api_v1',
      SSO_emailIdentifier: 'mail',
      SSO_EntityId: 'qlicker-test',
      SSO_entrypoint: 'https://idp.example.com/login',
      SSO_cert: 'ZmFrZS1pZHAtY2VydA==',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/sso/metadata',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`${app.config.rootUrl}/api/v1/auth/sso/callback`);
    expect(res.body).toContain(`${app.config.rootUrl}/api/v1/auth/sso/logout`);
    expect(res.body).not.toContain(`${app.config.rootUrl}/SSO/SAML2`);
  });
});

// ---------- GET /api/v1/auth/sso/logout-url ----------
describe('GET /api/v1/auth/sso/logout-url', () => {
  it('returns an SP-initiated logout URL for an authenticated SSO session', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.create({
      _id: 'settings',
      SSO_enabled: true,
      SSO_emailIdentifier: 'mail',
      SSO_EntityId: 'qlicker-test',
      SSO_entrypoint: 'https://idp.example.com/login',
      SSO_logoutUrl: 'https://idp.example.com/logout',
    });

    const user = await User.create({
      emails: [{ address: 'sso-session@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        sso: {
          id: 'name-id-1',
          nameID: 'name-id-1',
          nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
          email: 'sso-session@example.com',
          sessions: [{ sessionIndex: 'session-123' }],
        },
      },
      profile: { firstname: 'SSO', lastname: 'Session', roles: ['student'] },
      ssoCreated: true,
      allowEmailLogin: false,
      lastAuthProvider: 'sso',
      createdAt: new Date(),
    });
    const token = await getAuthToken(app, user);

    app.getSamlProvider = async () => ({
      getLogoutUrlAsync: async (profile) => {
        expect(profile.nameID).toBe('name-id-1');
        expect(profile.sessionIndex).toBe('session-123');
        return 'https://idp.example.com/logout?SAMLRequest=stub';
      },
    });

    const res = await authenticatedRequest(app, 'GET', '/api/v1/auth/sso/logout-url', { token });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: 'https://idp.example.com/logout?SAMLRequest=stub' });
  });
});

// ---------- POST /api/v1/auth/sso/logout ----------
describe('POST /api/v1/auth/sso/logout', () => {
  it('removes the matching SSO session when logout XML includes a session index', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await User.create({
      emails: [{ address: 'logout@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        sso: {
          id: 'logout-user',
          nameID: 'logout-user',
          nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
          email: 'logout@example.com',
          sessions: [{ sessionIndex: 'keep-me' }, { sessionIndex: 'remove-me' }],
        },
      },
      profile: { firstname: 'SSO', lastname: 'Logout', roles: ['student'] },
      ssoCreated: true,
      allowEmailLogin: false,
      lastAuthProvider: 'sso',
      createdAt: new Date(),
    });

    const xml = [
      '<saml2p:LogoutRequest xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol">',
      '<saml2p:SessionIndex>remove-me</saml2p:SessionIndex>',
      '</saml2p:LogoutRequest>',
    ].join('');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sso/logout',
      payload: { SAMLRequest: Buffer.from(xml, 'utf8').toString('base64') },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${app.config.rootUrl}/login`);

    const updated = await User.findById(user._id);
    expect(updated.services.sso.sessions.map((session) => session.toObject())).toEqual([
      { sessionIndex: 'keep-me' },
    ]);
  });
});

// ---------- POST /SSO/SAML2/logout ----------
describe('POST /SSO/SAML2/logout', () => {
  it('removes the matching SSO session when the legacy logout callback includes a session index', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await User.create({
      emails: [{ address: 'legacy-logout@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        sso: {
          id: 'legacy-logout-user',
          nameID: 'legacy-logout-user',
          nameIDFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
          email: 'legacy-logout@example.com',
          sessions: [{ sessionIndex: 'keep-me' }, { sessionIndex: 'remove-me' }],
        },
      },
      profile: { firstname: 'Legacy', lastname: 'Logout', roles: ['student'] },
      ssoCreated: true,
      allowEmailLogin: false,
      lastAuthProvider: 'sso',
      createdAt: new Date(),
    });

    const xml = [
      '<saml2p:LogoutRequest xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol">',
      '<saml2p:SessionIndex>remove-me</saml2p:SessionIndex>',
      '</saml2p:LogoutRequest>',
    ].join('');
    const res = await app.inject({
      method: 'POST',
      url: '/SSO/SAML2/logout',
      payload: { SAMLRequest: Buffer.from(xml, 'utf8').toString('base64') },
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${app.config.rootUrl}/login`);

    const updated = await User.findById(user._id);
    expect(updated.services.sso.sessions.map((session) => session.toObject())).toEqual([
      { sessionIndex: 'keep-me' },
    ]);
  });
});

// ---------- GET /api/v1/users/me ----------
describe('GET /api/v1/users/me', () => {
  it('returns current user profile', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'me@example.com' });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/users/me', { token });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toBeDefined();
    expect(body.user.profile.firstname).toBe('Test');
    expect(body.user.emails[0].address).toBe('me@example.com');
    expect(body.user.services).toBeUndefined();
  });

  it('returns 401 without token', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
    });

    expect(res.statusCode).toBe(401);
  });
});

// ---------- PATCH /api/v1/users/me ----------
describe('PATCH /api/v1/users/me', () => {
  it('updates firstname and lastname', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'update@example.com' });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me', {
      token,
      payload: { firstname: 'Updated', lastname: 'Name' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.firstname).toBe('Updated');
    expect(body.profile.lastname).toBe('Name');
  });
});

// ---------- GET /api/v1/users (admin only) ----------
describe('GET /api/v1/users', () => {
  it('returns paginated user list for admin', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin@example.com', roles: ['admin'] });
    await createTestUser({ email: 'user1@example.com' });
    await createTestUser({ email: 'user2@example.com' });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/users', { token });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users).toBeDefined();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(body.pages).toBeGreaterThanOrEqual(1);
  });

  it('returns 403 for non-admin', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const token = await getAuthToken(app, student);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/users', { token });

    expect(res.statusCode).toBe(403);
  });

  it('supports search parameter', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({
      email: 'admin@example.com',
      roles: ['admin'],
      firstname: 'Admin',
    });
    await createTestUser({ email: 'alice@example.com', firstname: 'Alice', lastname: 'Smith' });
    await createTestUser({ email: 'bob@example.com', firstname: 'Bob', lastname: 'Jones' });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/users?search=Alice', { token });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users).toHaveLength(1);
    expect(body.users[0].profile.firstname).toBe('Alice');
  });
});

// ---------- PATCH /api/v1/users/:id/role (admin) ----------
describe('PATCH /api/v1/users/:id/role', () => {
  it('changes user role', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin@example.com', roles: ['admin'] });
    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/users/${student._id}/role`,
      { token, payload: { role: 'professor' } }
    );

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.roles).toContain('professor');
    expect(body.profile.roles).not.toContain('student');
  });

  it('admin cannot change their own role', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin@example.com', roles: ['admin'] });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/users/${admin._id}/role`,
      { token, payload: { role: 'student' } }
    );

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.message).toMatch(/cannot change your own role/i);
  });

  async function createCanPromoteProfessor(email) {
    const professor = await createTestUser({ email, roles: ['professor'] });
    await User.updateOne({ _id: professor._id }, { $set: { 'profile.canPromote': true } });
    return professor;
  }

  it('rejects a canPromote professor granting the admin role', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createCanPromoteProfessor('promoter@example.com');
    const student = await createTestUser({ email: 'target@example.com', roles: ['student'] });
    const token = await getAuthToken(app, professor);

    const res = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/users/${student._id}/role`,
      { token, payload: { role: 'admin' } }
    );

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/only an admin can grant the admin role/i);
    const updated = await User.findById(student._id).lean();
    expect(updated.profile.roles).not.toContain('admin');
  });

  it('prevents a canPromote professor from self-escalating to admin', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createCanPromoteProfessor('selfpromoter@example.com');
    const token = await getAuthToken(app, professor);

    const res = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/users/${professor._id}/role`,
      { token, payload: { role: 'admin' } }
    );

    expect(res.statusCode).toBe(403);
    const updated = await User.findById(professor._id).lean();
    expect(updated.profile.roles).not.toContain('admin');
  });

  it('lets a canPromote professor promote a student to professor', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createCanPromoteProfessor('goodpromoter@example.com');
    const student = await createTestUser({ email: 'risingstar@example.com', roles: ['student'] });
    const token = await getAuthToken(app, professor);

    const res = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/users/${student._id}/role`,
      { token, payload: { role: 'professor' } }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().profile.roles).toContain('professor');
  });

  it('rejects an unknown role value', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-badrole@example.com', roles: ['admin'] });
    const student = await createTestUser({ email: 'badrole-target@example.com', roles: ['student'] });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/users/${student._id}/role`,
      { token, payload: { role: 'superadmin' } }
    );

    expect(res.statusCode).toBe(400);
  });
});
