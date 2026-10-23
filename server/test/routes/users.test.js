import fs from 'fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import Course from '../../src/models/Course.js';
import Settings from '../../src/models/Settings.js';
import User from '../../src/models/User.js';
import SystemMetricSample from '../../src/models/SystemMetricSample.js';
import SystemMonitorEvent from '../../src/models/SystemMonitorEvent.js';
import { generateMeteorId } from '../../src/utils/meteorId.js';
import { createApp, createTestUser, getAuthToken, authenticatedRequest, csrfHeaders } from '../helpers.js';

let app;

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
    expect(body.user.profile.lastname).toBe('User');
    expect(body.user.services).toBeUndefined(); // services stripped
  });

  it('includes SSO auth metadata for profile restrictions', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { SSO_enabled: true } },
      { upsert: true }
    );
    const user = await User.create({
      emails: [{ address: 'sso-meta@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        sso: { id: 'sso-meta-1', email: 'sso-meta@example.com' },
      },
      profile: { firstname: 'SSO', lastname: 'Meta', roles: ['student'] },
      ssoCreated: true,
      allowEmailLogin: false,
      lastAuthProvider: 'sso',
      createdAt: new Date(),
    });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/users/me', { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.isSSOUser).toBe(true);
    expect(body.user.isSSOCreatedUser).toBe(true);
    expect(body.user.allowEmailLogin).toBe(false);
    expect(body.user.lastAuthProvider).toBe('sso');
  });

  it('includes locale field when set', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'locale@example.com' });
    await User.findByIdAndUpdate(user._id, { locale: 'fr' });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/users/me', { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.locale).toBe('fr');
  });

  it('includes student-dashboard access flags for student accounts that also instruct courses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'owner@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const courseRes = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
      token: profToken,
      payload: {
        name: 'Instructor Course',
        deptCode: 'CS',
        courseNumber: '401',
        section: '001',
        semester: 'Fall 2026',
      },
    });
    expect(courseRes.statusCode).toBe(201);
    const course = courseRes.json().course;

    const student = await createTestUser({ email: 'mixed@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const addInstructorRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${course._id}/instructors`, {
      token: profToken,
      payload: { userId: student._id.toString() },
    });
    expect(addInstructorRes.statusCode).toBe(200);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/users/me', { token: studentToken });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.hasInstructorCourses).toBe(true);
    expect(res.json().user.canAccessProfessorDashboard).toBe(false);

    const storedCourse = await Course.findById(course._id).lean();
    expect((storedCourse.students || []).map(String)).not.toContain(String(student._id));
    const storedStudent = await User.findById(student._id).lean();
    expect((storedStudent.profile.courses || []).map(String)).toContain(String(course._id));
  });

  it('returns empty locale for legacy users without locale field', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    // Simulate a legacy user that has no locale field at all
    const user = await createTestUser({ email: 'legacy@example.com' });
    // Unset locale entirely to simulate legacy doc
    await User.collection.updateOne({ _id: user._id }, { $unset: { locale: '' } });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/users/me', { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Should default to empty string (use app default)
    expect(body.user.locale === '' || body.user.locale === undefined || body.user.locale === null).toBe(true);
  });

  it('rejects unauthenticated request', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const res = await app.inject({ method: 'GET', url: '/api/v1/users/me' });
    expect(res.statusCode).toBe(401);
  });
});

// ---------- PATCH /api/v1/users/me ----------
describe('PATCH /api/v1/users/me', () => {
  it('updates profile fields', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'patch@example.com' });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me', {
      token,
      payload: { firstname: 'Updated', lastname: 'Name', studentNumber: 'S12345' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.firstname).toBe('Updated');
    expect(body.profile.lastname).toBe('Name');
    expect(body.profile.studentNumber).toBe('S12345');
  });

  it('does not let SSO-created users change their names', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { SSO_enabled: true } },
      { upsert: true }
    );
    const user = await User.create({
      emails: [{ address: 'sso-name@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        sso: { id: 'sso-name-1', email: 'sso-name@example.com' },
      },
      profile: { firstname: 'Managed', lastname: 'Name', studentNumber: 'S1', roles: ['student'] },
      ssoCreated: true,
      allowEmailLogin: false,
      lastAuthProvider: 'sso',
      createdAt: new Date(),
    });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me', {
      token,
      payload: { firstname: 'Changed', lastname: 'User', studentNumber: 'S2' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.firstname).toBe('Managed');
    expect(body.profile.lastname).toBe('Name');
    expect(body.profile.studentNumber).toBe('S2');
  });

  it('updates locale preference', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'locale-patch@example.com' });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me', {
      token,
      payload: { locale: 'fr' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.locale).toBe('fr');

    // Verify persisted
    const stored = await User.findById(user._id);
    expect(stored.locale).toBe('fr');
  });

  it('clears locale to empty string (use app default)', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'locale-clear@example.com' });
    await User.findByIdAndUpdate(user._id, { locale: 'fr' });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me', {
      token,
      payload: { locale: '' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.locale).toBe('');
  });

  it('updates profile and locale together', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'combo@example.com' });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me', {
      token,
      payload: { firstname: 'NewFirst', locale: 'fr' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.firstname).toBe('NewFirst');
    expect(body.locale).toBe('fr');
  });

  it('does not expose services field', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'safe@example.com' });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me', {
      token,
      payload: { firstname: 'Safe' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().services).toBeUndefined();
  });
});

// ---------- PATCH /api/v1/users/me/password ----------
describe('PATCH /api/v1/users/me/password', () => {
  it('changes password with valid current password', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'pwchange@example.com', password: 'oldpassword123' });
    await User.findByIdAndUpdate(user._id, {
      $set: {
        'services.resume.loginTokens': [{ sessionId: 'device-1', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }],
      },
    });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me/password', {
      token,
      payload: { currentPassword: 'oldpassword123', newPassword: 'newpassword456' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const storedAfterChange = await User.findById(user._id);
    expect(storedAfterChange.refreshTokenVersion).toBe(1);
    expect(storedAfterChange.services?.resume?.loginTokens).toEqual([]);

    // Verify new password works
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { ...csrfHeaders },
      payload: { email: 'pwchange@example.com', password: 'newpassword456' },
    });
    expect(loginRes.statusCode).toBe(200);
  });

  it('blocks password changes while signed in through SSO', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { SSO_enabled: true } },
      { upsert: true }
    );
    const user = await User.create({
      emails: [{ address: 'sso-password@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        sso: { id: 'sso-password-1', email: 'sso-password@example.com' },
      },
      profile: { firstname: 'SSO', lastname: 'Password', roles: ['student'] },
      ssoCreated: true,
      allowEmailLogin: false,
      lastAuthProvider: 'sso',
      createdAt: new Date(),
    });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me/password', {
      token,
      payload: { currentPassword: 'password123', newPassword: 'newpassword456' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SSO_PASSWORD_CHANGE_DISABLED');
  });

  it('rejects wrong current password', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'wrongpw@example.com', password: 'correctpassword' });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me/password', {
      token,
      payload: { currentPassword: 'wrongpassword', newPassword: 'newpassword456' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects short new password', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'shortpw@example.com', password: 'password123' });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me/password', {
      token,
      payload: { currentPassword: 'password123', newPassword: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------- PATCH /api/v1/users/me/image ----------
describe('PATCH /api/v1/users/me/image', () => {
  it('accepts site-relative and https profile image URLs', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'image-ok@example.com' });
    const token = await getAuthToken(app, user);

    const relativeRes = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me/image', {
      token,
      payload: { profileImage: '/uploads/avatar.png' },
    });
    expect(relativeRes.statusCode).toBe(200);
    expect(relativeRes.json().profile.profileImage).toBe('/uploads/avatar.png');
    expect(relativeRes.json().profile.profileThumbnail).toBe('/uploads/avatar.png');

    const absoluteRes = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me/image', {
      token,
      payload: {
        profileImage: 'https://cdn.example.com/avatar.png',
        profileThumbnail: 'https://cdn.example.com/avatar-thumb.png',
      },
    });
    expect(absoluteRes.statusCode).toBe(200);
    expect(absoluteRes.json().profile.profileImage).toBe('https://cdn.example.com/avatar.png');
    expect(absoluteRes.json().profile.profileThumbnail).toBe('https://cdn.example.com/avatar-thumb.png');
  });

  it('rejects unsafe profile image URL schemes', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'image-bad@example.com' });
    const token = await getAuthToken(app, user);

    const badImageRes = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me/image', {
      token,
      payload: { profileImage: 'javascript:alert(1)' },
    });
    expect(badImageRes.statusCode).toBe(400);
    expect(badImageRes.json().message).toMatch(/http\(s\)|site-relative/i);

    const badThumbnailRes = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me/image', {
      token,
      payload: {
        profileImage: '/uploads/avatar.png',
        profileThumbnail: 'data:text/html;base64,PHNjcmlwdD4=',
      },
    });
    expect(badThumbnailRes.statusCode).toBe(400);
  });
});

// ---------- POST /api/v1/users/me/image/thumbnail ----------
describe('POST /api/v1/users/me/image/thumbnail', () => {
  it('can recrop a legacy local profile image even when no images document exists', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'legacy-avatar@example.com' });
    const token = await getAuthToken(app, user);
    const sourceKey = 'legacy-avatar-source.png';
    const sourceUrl = `/uploads/${sourceKey}`;
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwH4QZYAwAR8oH+Xm0fdIAAAAASUVORK5CYII=',
      'base64'
    );

    await fs.writeFile(`${app.uploadsDir}/${sourceKey}`, pngBuffer);
    await User.findByIdAndUpdate(user._id, {
      $set: {
        'profile.profileImage': sourceUrl,
        'profile.profileThumbnail': sourceUrl,
      },
    });

    const res = await authenticatedRequest(app, 'POST', '/api/v1/users/me/image/thumbnail', {
      token,
      payload: {
        rotation: 0,
        cropX: 0,
        cropY: 0,
        cropSize: 1,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().profile.profileImage).toBe(sourceUrl);
    expect(res.json().profile.profileThumbnail).toMatch(/^\/uploads\/.+\.jpg$/);

    const updated = await User.findById(user._id);
    expect(updated.profile.profileThumbnail).toMatch(/^\/uploads\/.+\.jpg$/);
  });

  it('can recrop a legacy remote profile image when no images document exists', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'legacy-remote-avatar@example.com' });
    const token = await getAuthToken(app, user);
    const sourceUrl = 'https://legacy-cdn.example.com/avatars/user-1/image';
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwH4QZYAwAR8oH+Xm0fdIAAAAASUVORK5CYII=',
      'base64'
    );
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      expect(url).toBe(sourceUrl);
      return new Response(pngBuffer, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(pngBuffer.length),
        },
      });
    };

    try {
      await User.findByIdAndUpdate(user._id, {
        $set: {
          'profile.profileImage': sourceUrl,
          'profile.profileThumbnail': sourceUrl,
        },
      });

      const res = await authenticatedRequest(app, 'POST', '/api/v1/users/me/image/thumbnail', {
        token,
        payload: {
          rotation: 0,
          cropX: 0,
          cropY: 0,
          cropSize: 1,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().profile.profileImage).toBe(sourceUrl);
      expect(res.json().profile.profileThumbnail).toMatch(/^\/uploads\/.+\.jpg$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('blocks recropping remote profile images on private IPv6 hosts', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'legacy-private-ipv6-avatar@example.com' });
    const token = await getAuthToken(app, user);
    const sourceUrl = 'http://[fd00::1]:8080/avatar.png';
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;

    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error('fetch should not be called for private IPv6 hosts');
    };

    try {
      await User.findByIdAndUpdate(user._id, {
        $set: {
          'profile.profileImage': sourceUrl,
          'profile.profileThumbnail': sourceUrl,
        },
      });

      const res = await authenticatedRequest(app, 'POST', '/api/v1/users/me/image/thumbnail', {
        token,
        payload: {
          rotation: 0,
          cropX: 0,
          cropY: 0,
          cropSize: 1,
        },
      });

      expect(fetchCalled).toBe(false);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/could not be loaded/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts decimal crop coordinates from drag interactions', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'decimal-avatar@example.com' });
    const token = await getAuthToken(app, user);
    const sourceKey = 'decimal-avatar-source.png';
    const sourceUrl = `/uploads/${sourceKey}`;
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8DwH4QZYAwAR8oH+Xm0fdIAAAAASUVORK5CYII=',
      'base64'
    );

    await fs.writeFile(`${app.uploadsDir}/${sourceKey}`, pngBuffer);
    await User.findByIdAndUpdate(user._id, {
      $set: {
        'profile.profileImage': sourceUrl,
        'profile.profileThumbnail': sourceUrl,
      },
    });

    const res = await authenticatedRequest(app, 'POST', '/api/v1/users/me/image/thumbnail', {
      token,
      payload: {
        rotation: 0,
        cropX: 0.4,
        cropY: 0.7,
        cropSize: 1.2,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().profile.profileThumbnail).toMatch(/^\/uploads\/.+\.jpg$/);
  });
});

// ---------- Admin user management ----------
describe('Authorization roles are resolved from the database', () => {
  it('a demoted admin loses admin access immediately, before token expiry', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-demoted@example.com', roles: ['admin'] });
    const token = await getAuthToken(app, admin);

    // Token still says admin, but the DB is the source of truth.
    const before = await authenticatedRequest(app, 'GET', '/api/v1/users', { token });
    expect(before.statusCode).toBe(200);

    await User.findByIdAndUpdate(admin._id, { $set: { 'profile.roles': ['student'] } });

    const after = await authenticatedRequest(app, 'GET', '/api/v1/users', { token });
    expect(after.statusCode).toBe(403);
  });
});

describe('Admin user management', () => {
  it('admin can list users', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-list@example.com', roles: ['admin'] });
    await createTestUser({ email: 'student1@example.com', roles: ['student'] });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/users', { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users).toBeDefined();
    expect(body.total).toBeGreaterThanOrEqual(2);
    // Services should be stripped
    body.users.forEach((u) => expect(u.services).toBeUndefined());
  });

  it('reports recent unique logins and ranks courses by active enrolled members', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-usage@example.com', roles: ['admin'] });
    const activeHour = await createTestUser({ email: 'active-hour@example.com', roles: ['student'] });
    const activeDay = await createTestUser({ email: 'active-day@example.com', roles: ['student'] });
    const activeWeek = await createTestUser({ email: 'active-week@example.com', roles: ['student'] });
    const inactive = await createTestUser({ email: 'inactive-usage@example.com', roles: ['student'] });
    const now = Date.now();
    await Promise.all([
      User.findByIdAndUpdate(activeHour._id, { $set: { lastLogin: new Date(now - (30 * 60 * 1000)) } }),
      User.findByIdAndUpdate(activeDay._id, { $set: { lastLogin: new Date(now - (2 * 60 * 60 * 1000)) } }),
      User.findByIdAndUpdate(activeWeek._id, { $set: { lastLogin: new Date(now - (2 * 24 * 60 * 60 * 1000)) } }),
      User.findByIdAndUpdate(inactive._id, { $set: { lastLogin: new Date(now - (8 * 24 * 60 * 60 * 1000)) } }),
    ]);

    await Course.create([
      {
        name: 'Most Active', deptCode: 'STAT', courseNumber: '101', section: '001',
        owner: String(admin._id), instructors: [String(admin._id)],
        students: [String(activeHour._id), String(activeDay._id)],
        enrollmentCode: 'USAGE01', semester: 'Fall 2026',
      },
      {
        name: 'Less Active', deptCode: 'STAT', courseNumber: '102', section: '001',
        owner: String(admin._id), instructors: [],
        students: [String(activeWeek._id), String(inactive._id)],
        enrollmentCode: 'USAGE02', semester: 'Fall 2026',
      },
    ]);

    const token = await getAuthToken(app, admin);
    const res = await authenticatedRequest(app, 'GET', '/api/v1/users/admin/usage-statistics', { token });

    expect(res.statusCode).toBe(200);
    expect(res.json().loginCounts).toEqual({
      pastHour: 1,
      past24Hours: 2,
      past7Days: 3,
    });
    expect(res.json().activeCourseWindowDays).toBe(7);
    expect(res.json().topCourses.slice(0, 2)).toEqual([
      expect.objectContaining({ name: 'Most Active', activeUserCount: 2, enrollment: 2 }),
      expect.objectContaining({ name: 'Less Active', activeUserCount: 1, enrollment: 2 }),
    ]);

    const studentToken = await getAuthToken(app, activeHour);
    const forbiddenRes = await authenticatedRequest(app, 'GET', '/api/v1/users/admin/usage-statistics', {
      token: studentToken,
    });
    expect(forbiddenRes.statusCode).toBe(403);
  });

  it('returns downsampled system history and monitor events to administrators only', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-system-monitor@example.com', roles: ['admin'] });
    const student = await createTestUser({ email: 'student-system-monitor@example.com', roles: ['student'] });
    const now = Date.now();
    const expiresAt = new Date(now + (7 * 24 * 60 * 60 * 1000));
    await SystemMetricSample.create([
      {
        timestamp: new Date(now - (2 * 60 * 1000)),
        expiresAt,
        collectorId: 'monitor-1',
        sampleIntervalSeconds: 60,
        cpu: { usagePercent: 25, cores: 4, load1: 0.5 },
        memory: { usedBytes: 400, availableBytes: 600, totalBytes: 1000, usedPercent: 40 },
        network: { interfaces: ['eth0'], receivedBytesPerSecond: 100, transmittedBytesPerSecond: 50 },
        activity: { source: 'redis', windowMinutes: 15, activeUsers: 4, activeStudents: 3, activeProfessors: 1, activeAdmins: 1 },
      },
      {
        timestamp: new Date(now - (60 * 1000)),
        expiresAt,
        collectorId: 'monitor-1',
        sampleIntervalSeconds: 60,
        cpu: { usagePercent: 75, cores: 4, load1: 2 },
        memory: { usedBytes: 700, availableBytes: 300, totalBytes: 1000, usedPercent: 70 },
        network: { interfaces: ['eth0'], receivedBytesPerSecond: 500, transmittedBytesPerSecond: 250 },
        activity: { source: 'redis', windowMinutes: 15, activeUsers: 18, activeStudents: 15, activeProfessors: 3, activeAdmins: 1 },
      },
    ]);
    await SystemMonitorEvent.create({
      timestamp: new Date(now - 30_000),
      expiresAt,
      collectorId: 'monitor-1',
      level: 'info',
      code: 'collector_started',
      message: 'System monitor started',
    });

    const token = await getAuthToken(app, admin);
    const response = await authenticatedRequest(
      app,
      'GET',
      '/api/v1/users/admin/system-monitoring?range=6h',
      { token }
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      status: 'healthy',
      range: '6h',
      retentionDays: 7,
      bucketSeconds: 60,
    }));
    expect(response.json().latest).toEqual(expect.objectContaining({
      collectorId: 'monitor-1',
      activity: expect.objectContaining({ activeUsers: 18 }),
    }));
    expect(response.json().history).toHaveLength(2);
    expect(response.json().peakPeriods[0].activeUsers).toBe(18);
    expect(response.json().events[0]).toEqual(expect.objectContaining({ code: 'collector_started' }));

    const unauthenticated = await authenticatedRequest(app, 'GET', '/api/v1/users/admin/system-monitoring');
    expect(unauthenticated.statusCode).toBe(401);
    const invalid = await authenticatedRequest(app, 'GET', '/api/v1/users/admin/system-monitoring?range=30d', { token });
    expect(invalid.statusCode).toBe(400);
    const professor = await createTestUser({ email: 'prof-monitor@example.com', roles: ['professor'] });
    const professorToken = await getAuthToken(app, professor);
    const professorResult = await authenticatedRequest(app, 'GET', '/api/v1/users/admin/system-monitoring?range=6h', { token: professorToken });
    expect(professorResult.statusCode).toBe(403);

    const studentToken = await getAuthToken(app, student);
    const forbidden = await authenticatedRequest(
      app,
      'GET',
      '/api/v1/users/admin/system-monitoring?range=24h',
      { token: studentToken }
    );
    expect(forbidden.statusCode).toBe(403);
  });

  it('lists users by most recent last login by default and supports explicit sort fields', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-sort@example.com', roles: ['admin'] });
    await User.create({
      emails: [{ address: 'zoe@example.com', verified: true }],
      services: { password: { hash: await User.hashPassword('password123') } },
      profile: { firstname: 'Zoe', lastname: 'Zimmer', roles: ['student'] },
      lastLogin: new Date('2026-03-28T10:00:00.000Z'),
      createdAt: new Date(),
    });
    await User.create({
      emails: [{ address: 'amy@example.com', verified: true }],
      services: { password: { hash: await User.hashPassword('password123') } },
      profile: { firstname: 'Amy', lastname: 'Able', roles: ['student'] },
      lastLogin: new Date('2026-03-29T10:00:00.000Z'),
      createdAt: new Date(),
    });
    await User.create({
      emails: [{ address: 'mike@example.com', verified: true }],
      services: { password: { hash: await User.hashPassword('password123') } },
      profile: { firstname: 'Mike', lastname: 'Middle', roles: ['professor'] },
      createdAt: new Date(),
    });
    const token = await getAuthToken(app, admin);

    const defaultRes = await authenticatedRequest(app, 'GET', '/api/v1/users?limit=10', { token });
    expect(defaultRes.statusCode).toBe(200);
    const defaultEmails = defaultRes.json().users
      .map((user) => user.emails?.[0]?.address)
      .filter((email) => ['amy@example.com', 'zoe@example.com', 'mike@example.com'].includes(email));
    expect(defaultEmails.slice(0, 3)).toEqual(['amy@example.com', 'zoe@example.com', 'mike@example.com']);

    const nameSortRes = await authenticatedRequest(app, 'GET', '/api/v1/users?limit=10&sortBy=name&sortDirection=asc', { token });
    expect(nameSortRes.statusCode).toBe(200);
    const nameSortedEmails = nameSortRes.json().users
      .map((user) => user.emails?.[0]?.address)
      .filter((email) => ['amy@example.com', 'zoe@example.com', 'mike@example.com'].includes(email));
    expect(nameSortedEmails.slice(0, 3)).toEqual(['amy@example.com', 'mike@example.com', 'zoe@example.com']);
  });

  it('derives last login in the users list from active refresh sessions when needed', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-derived-list@example.com', roles: ['admin'] });
    const derivedLastLogin = new Date('2026-03-25T14:30:00.000Z');
    await User.create({
      emails: [{ address: 'derived-list@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        resume: {
          loginTokens: [{
            sessionId: 'session-derived',
            createdAt: derivedLastLogin,
            lastUsedAt: derivedLastLogin,
            expiresAt: new Date(Date.now() + 60_000),
            ipAddress: '203.0.113.41',
          }],
        },
      },
      profile: { firstname: 'Derived', lastname: 'List', roles: ['student'] },
      createdAt: new Date(),
    });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/users', { token, headers: { 'x-forwarded-for': '198.51.100.1' } });
    expect(res.statusCode).toBe(200);
    const listed = res.json().users.find((user) => user.emails?.[0]?.address === 'derived-list@example.com');
    expect(listed).toBeTruthy();
    expect(new Date(listed.lastLogin).toISOString()).toBe(derivedLastLogin.toISOString());
  });

  it('admin can inspect current sessions and last-login IP metadata for a user', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-session-detail@example.com', roles: ['admin'] });
    const activeCreatedAt = new Date('2026-03-25T14:30:00.000Z');
    const activeLastUsedAt = new Date('2026-03-25T15:15:00.000Z');
    const target = await User.create({
      emails: [{ address: 'session-detail@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        resume: {
          loginTokens: [
            {
              sessionId: 'active-session',
              createdAt: activeCreatedAt,
              lastUsedAt: activeLastUsedAt,
              expiresAt: new Date(Date.now() + 120_000),
              ipAddress: '203.0.113.42',
            },
            {
              sessionId: 'expired-session',
              createdAt: new Date('2026-03-20T10:00:00.000Z'),
              lastUsedAt: new Date('2026-03-20T10:30:00.000Z'),
              expiresAt: new Date(Date.now() - 120_000),
              ipAddress: '203.0.113.77',
            },
          ],
        },
      },
      profile: { firstname: 'Session', lastname: 'Detail', roles: ['student'] },
      lastLogin: new Date('2026-03-20T10:00:00.000Z'),
      createdAt: new Date(),
    });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'GET', `/api/v1/users/${target._id}`, { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.services).toBeUndefined();
    expect(body.currentlyLoggedIn).toBe(true);
    expect(body.activeSessions).toHaveLength(1);
    expect(body.activeSessions[0].ipAddress).toBe('203.0.113.42');
    expect(new Date(body.activeSessions[0].createdAt).toISOString()).toBe(activeCreatedAt.toISOString());
    expect(new Date(body.lastLogin).toISOString()).toBe(activeCreatedAt.toISOString());
    expect(body.lastLoginIp).toBe('203.0.113.42');
  });

  it('includes role-specific course lists in the admin user payload', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-courses@example.com', roles: ['admin'] });
    const target = await createTestUser({
      email: 'course-user@example.com',
      roles: ['professor', 'student'],
    });
    const instructorCourse = await Course.create({
      name: 'Instructor Course',
      deptCode: 'CS',
      courseNumber: '201',
      section: '001',
      semester: 'Fall 2026',
      owner: target._id,
      enrollmentCode: 'INS201',
      instructors: [target._id],
      students: [],
    });
    const studentCourse = await Course.create({
      name: 'Student Course',
      deptCode: 'MATH',
      courseNumber: '101',
      section: '002',
      semester: 'Winter 2026',
      owner: admin._id,
      enrollmentCode: 'STU101',
      instructors: [admin._id],
      students: [target._id],
    });
    await User.findByIdAndUpdate(target._id, {
      $set: { 'profile.courses': [studentCourse._id, instructorCourse._id] },
    });

    const token = await getAuthToken(app, admin);
    const res = await authenticatedRequest(app, 'GET', `/api/v1/users/${target._id}`, { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.studentCourses).toHaveLength(1);
    expect(body.studentCourses[0]._id).toBe(studentCourse._id);
    expect(body.studentCourses[0].name).toBe('Student Course');
    expect(body.instructorCourses).toHaveLength(1);
    expect(body.instructorCourses[0]._id).toBe(instructorCourse._id);
    expect(body.instructorCourses[0].name).toBe('Instructor Course');
  });

  it('non-admin cannot list users', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const student = await createTestUser({ email: 'student-list@example.com', roles: ['student'] });
    const token = await getAuthToken(app, student);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/users', { token });
    expect(res.statusCode).toBe(403);
  });

  it('admin can create a user', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-create@example.com', roles: ['admin'] });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'POST', '/api/v1/users', {
      token,
      payload: {
        email: 'newuser@example.com',
        password: 'password123',
        firstname: 'Created',
        lastname: 'User',
        role: 'student',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.profile.firstname).toBe('Created');
    expect(body.profile.roles).toContain('student');
  });

  it('admin can delete a user', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-delete@example.com', roles: ['admin'] });
    const target = await createTestUser({ email: 'deleteme@example.com', roles: ['student'] });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'DELETE', `/api/v1/users/${target._id}`, { token });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const deleted = await User.findById(target._id);
    expect(deleted).toBeNull();
  });

  it('admin can change user role', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-role@example.com', roles: ['admin'] });
    const student = await createTestUser({ email: 'promote@example.com', roles: ['student'] });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/users/${student._id}/role`, {
      token,
      payload: { role: 'professor' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.roles).toContain('professor');
  });

  it('admin cannot change own role', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-self@example.com', roles: ['admin'] });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/users/${admin._id}/role`, {
      token,
      payload: { role: 'student' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin can verify user email', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-verify@example.com', roles: ['admin'] });
    const unverified = await User.create({
      emails: [{ address: 'unverified@example.com', verified: false }],
      services: { password: { hash: await User.hashPassword('password123') } },
      profile: { firstname: 'Unverified', lastname: 'User', roles: ['student'] },
    });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/users/${unverified._id}/verify-email`, { token });
    expect(res.statusCode).toBe(200);

    const updated = await User.findById(unverified._id);
    expect(updated.emails[0].verified).toBe(true);
  });

  it('admin can toggle user properties for SSO approval and promotion', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { SSO_enabled: true } },
      { upsert: true }
    );
    const admin = await createTestUser({ email: 'admin-properties@example.com', roles: ['admin'] });
    const target = await User.create({
      emails: [{ address: 'sso-target@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        resume: {
          loginTokens: [{ sessionId: 'device-1', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }],
        },
        sso: { id: 'sso-target-1', email: 'sso-target@example.com' },
        resetPassword: {
          token: 'pending-reset',
          email: 'sso-target@example.com',
          when: new Date(),
          reason: 'reset',
        },
      },
      profile: { firstname: 'Toggle', lastname: 'Target', roles: ['professor'], canPromote: false },
      ssoCreated: true,
      allowEmailLogin: false,
      createdAt: new Date(),
    });
    const token = await getAuthToken(app, admin);

    const enableRes = await authenticatedRequest(app, 'PATCH', `/api/v1/users/${target._id}/properties`, {
      token,
      payload: { canPromote: true, allowEmailLogin: true },
    });
    expect(enableRes.statusCode).toBe(200);
    expect(enableRes.json().profile.canPromote).toBe(true);
    expect(enableRes.json().allowEmailLogin).toBe(true);

    const disableRes = await authenticatedRequest(app, 'PATCH', `/api/v1/users/${target._id}/properties`, {
      token,
      payload: { allowEmailLogin: false },
    });
    expect(disableRes.statusCode).toBe(200);
    expect(disableRes.json().allowEmailLogin).toBe(false);

    const disableAccountRes = await authenticatedRequest(app, 'PATCH', `/api/v1/users/${target._id}/properties`, {
      token,
      payload: { disabled: true },
    });
    expect(disableAccountRes.statusCode).toBe(200);
    expect(disableAccountRes.json().disabled).toBe(true);

    const restoreAccountRes = await authenticatedRequest(app, 'PATCH', `/api/v1/users/${target._id}/properties`, {
      token,
      payload: { disabled: false },
    });
    expect(restoreAccountRes.statusCode).toBe(200);
    expect(restoreAccountRes.json().disabled).toBe(false);

    const updated = await User.findById(target._id);
    expect(updated.profile.canPromote).toBe(true);
    expect(updated.allowEmailLogin).toBe(false);
    expect(updated.services?.resetPassword).toBeUndefined();
    expect(updated.refreshTokenVersion).toBe(1);
    expect(updated.services?.resume?.loginTokens).toEqual([]);
    expect(updated.disabled).toBe(false);
    expect(updated.disabledAt).toBeNull();
  });

  it('admin can reset a user password from the user properties flow', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { SSO_enabled: true } },
      { upsert: true }
    );
    const admin = await createTestUser({ email: 'admin-reset@example.com', roles: ['admin'] });
    const target = await User.create({
      emails: [{ address: 'reset-target@example.com', verified: true }],
      services: {
        password: { bcrypt: '$2a$10$RpS898ow7xM8/7VsgV.CRO07nMYdzt5t62DZXEejz75DbUIH.clgm' },
        resume: {
          loginTokens: [{ sessionId: 'device-1', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }],
        },
        resetPassword: {
          token: 'pending-admin-reset',
          email: 'reset-target@example.com',
          when: new Date(),
          reason: 'reset',
        },
      },
      profile: { firstname: 'Reset', lastname: 'Target', roles: ['student'] },
      allowEmailLogin: false,
      createdAt: new Date(),
    });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/users/${target._id}/password`, {
      token,
      payload: { newPassword: 'newpassword456' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().allowEmailLogin).toBe(false);

    const updated = await User.findById(target._id);
    expect(updated.refreshTokenVersion).toBe(1);
    expect(updated.services?.resume?.loginTokens).toEqual([]);
    expect(updated.services?.resetPassword).toBeUndefined();
    expect(updated.services?.password?.hash).toMatch(/^\$argon2id\$/);
    expect(updated.services?.password?.bcrypt).toBeUndefined();
    expect(updated.passwordResetRequired()).toBe(false);
    await expect(updated.verifyPassword('newpassword456')).resolves.toBe(true);

    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { SSO_enabled: true } },
      { upsert: true }
    );
    await User.findByIdAndUpdate(target._id, { $set: { allowEmailLogin: true } });

    const loginRes = await authenticatedRequest(app, 'POST', '/api/v1/auth/login', {
      payload: {
        email: 'reset-target@example.com',
        password: 'newpassword456',
      },
    });
    expect(loginRes.statusCode).toBe(200);
    const postLoginUser = await User.findById(target._id);
    expect(postLoginUser.services?.resetPassword).toBeUndefined();
    expect(postLoginUser.passwordResetRequired()).toBe(false);
  });

  it('keeps canPromote disabled for student-only accounts and clears it when a user is demoted to student', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-student-props@example.com', roles: ['admin'] });
    const target = await User.create({
      emails: [{ address: 'student-props@example.com', verified: true }],
      services: { password: { hash: await User.hashPassword('password123') } },
      profile: { firstname: 'Student', lastname: 'Props', roles: ['student'], canPromote: true },
      createdAt: new Date(),
    });
    const token = await getAuthToken(app, admin);

    const propsRes = await authenticatedRequest(app, 'PATCH', `/api/v1/users/${target._id}/properties`, {
      token,
      payload: { canPromote: true },
    });
    expect(propsRes.statusCode).toBe(200);
    expect(propsRes.json().profile.canPromote).toBe(false);

    const professorRes = await authenticatedRequest(app, 'PATCH', `/api/v1/users/${target._id}/role`, {
      token,
      payload: { role: 'professor' },
    });
    expect(professorRes.statusCode).toBe(200);

    const promoteRes = await authenticatedRequest(app, 'PATCH', `/api/v1/users/${target._id}/properties`, {
      token,
      payload: { canPromote: true },
    });
    expect(promoteRes.statusCode).toBe(200);
    expect(promoteRes.json().profile.canPromote).toBe(true);

    const demoteRes = await authenticatedRequest(app, 'PATCH', `/api/v1/users/${target._id}/role`, {
      token,
      payload: { role: 'student' },
    });
    expect(demoteRes.statusCode).toBe(200);
    expect(demoteRes.json().profile.roles).toEqual(['student']);
    expect(demoteRes.json().profile.canPromote).toBe(false);

    const updated = await User.findById(target._id);
    expect(updated.profile.roles).toEqual(['student']);
    expect(updated.profile.canPromote).toBe(false);
  });
});

// ---------- Legacy database compatibility ----------
describe('Legacy database compatibility', () => {
  it('handles legacy user documents without locale field', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    // Insert a legacy-style document directly into MongoDB (no locale field)
    const legacyId = generateMeteorId();
    await User.collection.insertOne({
      _id: legacyId,
      emails: [{ address: 'legacy-no-locale@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        resume: { loginTokens: [] },
      },
      profile: {
        firstname: 'Legacy',
        lastname: 'User',
        roles: ['student'],
        courses: [],
      },
      createdAt: new Date(),
      // No locale field at all
    });

    const user = await User.findById(legacyId);
    const token = await getAuthToken(app, user);

    // GET /me should work fine
    const res = await authenticatedRequest(app, 'GET', '/api/v1/users/me', { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.profile.firstname).toBe('Legacy');
    // locale may be empty or undefined — both are valid for "use app default"
    const locale = body.user.locale;
    expect(locale === '' || locale === undefined || locale === null).toBe(true);

    // PATCH /me with locale should work (upgrade legacy doc)
    const patchRes = await authenticatedRequest(app, 'PATCH', '/api/v1/users/me', {
      token,
      payload: { locale: 'fr' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().locale).toBe('fr');
  });

  it('handles legacy user with missing profile sub-fields', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    // Insert minimal legacy document
    const legacyId = generateMeteorId();
    await User.collection.insertOne({
      _id: legacyId,
      emails: [{ address: 'minimal-legacy@example.com', verified: false }],
      services: {
        password: { hash: await User.hashPassword('password123') },
      },
      profile: {
        firstname: 'Min',
        lastname: 'Leg',
        roles: ['student'],
        // No courses, no studentNumber, no profileImage, no profileThumbnail
      },
      createdAt: new Date(),
    });

    const user = await User.findById(legacyId);
    const token = await getAuthToken(app, user);

    // Should handle missing sub-fields gracefully
    const res = await authenticatedRequest(app, 'GET', '/api/v1/users/me', { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user.profile.firstname).toBe('Min');
  });
});

// ---------- Settings locale tests ----------
describe('Settings locale and dateFormat', () => {
  it('admin can update locale and dateFormat settings', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const Settings = (await import('../../src/models/Settings.js')).default;

    // Create initial settings
    await Settings.collection.insertOne({
      _id: 'settings',
      locale: 'en',
      dateFormat: 'DD-MMM-YYYY',
    });

    const admin = await createTestUser({ email: 'admin-locale@example.com', roles: ['admin'] });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'PATCH', '/api/v1/settings', {
      token,
      payload: { locale: 'fr', dateFormat: 'YYYY-MM-DD' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.locale).toBe('fr');
    expect(body.dateFormat).toBe('YYYY-MM-DD');
  });

  it('settings locale defaults to en for legacy settings without locale', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const Settings = (await import('../../src/models/Settings.js')).default;

    // Insert a legacy settings doc without locale
    await Settings.collection.insertOne({
      _id: 'settings',
      restrictDomain: false,
      // No locale or dateFormat fields
    });

    const admin = await createTestUser({ email: 'admin-legacy-settings@example.com', roles: ['admin'] });
    const token = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/settings', { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Mongoose defaults should apply
    expect(body.locale).toBe('en');
    expect(body.dateFormat).toBe('DD-MMM-YYYY');
  });
});
