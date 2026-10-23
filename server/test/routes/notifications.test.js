import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import Course from '../../src/models/Course.js';
import Notification from '../../src/models/Notification.js';
import NotificationDismissal from '../../src/models/NotificationDismissal.js';
import User from '../../src/models/User.js';
import { createApp, createTestUser, getAuthToken, authenticatedRequest } from '../helpers.js';

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

async function createCourseAsProfessor(token, overrides = {}) {
  const response = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
    token,
    payload: {
      name: 'Notifications Course',
      deptCode: 'CS',
      courseNumber: '401',
      section: '001',
      semester: 'Fall 2026',
      ...overrides,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().course;
}

function buildWindow(startOffsetMinutes, endOffsetMinutes) {
  const now = Date.now();
  return {
    startAt: new Date(now + (startOffsetMinutes * 60 * 1000)).toISOString(),
    endAt: new Date(now + (endOffsetMinutes * 60 * 1000)).toISOString(),
  };
}

describe('notification routes', () => {
  it('admin can create, edit, list, and delete system notifications', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-notify@example.com', roles: ['admin'] });
    const token = await getAuthToken(app, admin);

    const createRes = await authenticatedRequest(app, 'POST', '/api/v1/notifications/manage', {
      token,
      payload: {
        scopeType: 'system',
        title: 'Maintenance',
        message: 'The site will restart tonight.',
        persistUntilDismissed: false,
        ...buildWindow(-30, 120),
      },
    });
    expect(createRes.statusCode).toBe(201);
    const createdNotification = createRes.json().notification;
    expect(createdNotification.scopeType).toBe('system');
    expect(createdNotification.recipientType).toBe('all');

    const listRes = await authenticatedRequest(app, 'GET', '/api/v1/notifications/manage?scopeType=system', { token });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().notifications).toHaveLength(1);
    expect(listRes.json().notifications[0].title).toBe('Maintenance');

    const updateRes = await authenticatedRequest(app, 'PATCH', `/api/v1/notifications/${createdNotification._id}`, {
      token,
      payload: {
        title: 'Maintenance window',
        message: 'The site will restart at 22:00.',
        persistUntilDismissed: true,
        ...buildWindow(-45, 60),
      },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().notification.title).toBe('Maintenance window');
    expect(updateRes.json().notification.persistUntilDismissed).toBe(true);

    await NotificationDismissal.create({ notificationId: createdNotification._id, userId: admin._id.toString() });
    const deleteRes = await authenticatedRequest(app, 'DELETE', `/api/v1/notifications/${createdNotification._id}`, { token });
    expect(deleteRes.statusCode).toBe(204);
    expect(await Notification.findById(createdNotification._id).lean()).toBeNull();
    expect(await NotificationDismissal.findOne({ notificationId: createdNotification._id }).lean()).toBeNull();
  });

  it('routes system and course notifications to the requested recipients', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-visible@example.com', roles: ['admin'] });
    const adminToken = await getAuthToken(app, admin);
    const professor = await createTestUser({ email: 'prof-visible@example.com', roles: ['professor'] });
    const professorToken = await getAuthToken(app, professor);
    const student = await createTestUser({ email: 'student-visible@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const ta = await createTestUser({ email: 'ta-visible@example.com', roles: ['student'] });
    const taToken = await getAuthToken(app, ta);

    const course = await createCourseAsProfessor(professorToken);
    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);
    const addInstructorRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${course._id}/instructors`, {
      token: professorToken,
      payload: { userId: ta._id.toString() },
    });
    expect(addInstructorRes.statusCode).toBe(200);

    const systemPayloads = [
      { title: 'System everyone', recipientType: 'all' },
      { title: 'System students', recipientType: 'students' },
      { title: 'System professors', recipientType: 'instructors' },
    ];
    const coursePayloads = [
      { title: 'Course everyone', recipientType: 'all' },
      { title: 'Course students', recipientType: 'students' },
      { title: 'Course instructors', recipientType: 'instructors' },
    ];

    for (const payload of systemPayloads) {
      const response = await authenticatedRequest(app, 'POST', '/api/v1/notifications/manage', {
        token: adminToken,
        payload: {
          scopeType: 'system',
          message: `${payload.title} body.`,
          persistUntilDismissed: false,
          ...buildWindow(-20, 60),
          ...payload,
        },
      });
      expect(response.statusCode).toBe(201);
    }

    for (const payload of coursePayloads) {
      const response = await authenticatedRequest(app, 'POST', '/api/v1/notifications/manage', {
        token: professorToken,
        payload: {
          scopeType: 'course',
          courseId: course._id,
          message: `${payload.title} body.`,
          persistUntilDismissed: false,
          ...buildWindow(-10, 120),
          ...payload,
        },
      });
      expect(response.statusCode).toBe(201);
    }

    const studentSummaryRes = await authenticatedRequest(app, 'GET', '/api/v1/notifications/summary', { token: studentToken });
    expect(studentSummaryRes.statusCode).toBe(200);
    expect(studentSummaryRes.json().count).toBe(4);

    const professorSummaryRes = await authenticatedRequest(app, 'GET', '/api/v1/notifications/summary', { token: professorToken });
    expect(professorSummaryRes.statusCode).toBe(200);
    expect(professorSummaryRes.json().count).toBe(4);

    const taSummaryRes = await authenticatedRequest(app, 'GET', '/api/v1/notifications/summary', { token: taToken });
    expect(taSummaryRes.statusCode).toBe(200);
    expect(taSummaryRes.json().count).toBe(4);

    const studentListRes = await authenticatedRequest(app, 'GET', '/api/v1/notifications', { token: studentToken });
    expect(studentListRes.statusCode).toBe(200);
    expect(studentListRes.json().notifications.map((notification) => notification.title).sort()).toEqual([
      'Course everyone',
      'Course students',
      'System everyone',
      'System students',
    ]);

    const professorListRes = await authenticatedRequest(app, 'GET', '/api/v1/notifications', { token: professorToken });
    expect(professorListRes.statusCode).toBe(200);
    expect(professorListRes.json().notifications.map((notification) => notification.title).sort()).toEqual([
      'Course everyone',
      'Course instructors',
      'System everyone',
      'System professors',
    ]);

    const taListRes = await authenticatedRequest(app, 'GET', '/api/v1/notifications', { token: taToken });
    expect(taListRes.statusCode).toBe(200);
    expect(taListRes.json().notifications.map((notification) => notification.title).sort()).toEqual([
      'Course everyone',
      'Course instructors',
      'System everyone',
      'System students',
    ]);
  });

  it('supports dismissal while respecting targeted recipients', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-dismiss-visible@example.com', roles: ['admin'] });
    const adminToken = await getAuthToken(app, admin);
    const professor = await createTestUser({ email: 'prof-dismiss-visible@example.com', roles: ['professor'] });
    const professorToken = await getAuthToken(app, professor);
    const student = await createTestUser({ email: 'student-dismiss-visible@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    const course = await createCourseAsProfessor(professorToken);
    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);

    const courseNotificationRes = await authenticatedRequest(app, 'POST', '/api/v1/notifications/manage', {
      token: professorToken,
      payload: {
        scopeType: 'course',
        courseId: course._id,
        recipientType: 'students',
        title: 'Course students only',
        message: 'Read chapter 5 before class.',
        persistUntilDismissed: false,
        ...buildWindow(-10, 120),
      },
    });
    expect(courseNotificationRes.statusCode).toBe(201);
    const courseNotificationId = courseNotificationRes.json().notification._id;

    const systemNotificationRes = await authenticatedRequest(app, 'POST', '/api/v1/notifications/manage', {
      token: adminToken,
      payload: {
        scopeType: 'system',
        recipientType: 'all',
        title: 'System notice',
        message: 'Welcome back.',
        persistUntilDismissed: false,
        ...buildWindow(-20, 60),
      },
    });
    expect(systemNotificationRes.statusCode).toBe(201);
    const systemNotificationId = systemNotificationRes.json().notification._id;

    const dismissRes = await authenticatedRequest(app, 'POST', `/api/v1/notifications/${courseNotificationId}/dismiss`, {
      token: studentToken,
    });
    expect(dismissRes.statusCode).toBe(204);

    const refreshedSummaryRes = await authenticatedRequest(app, 'GET', '/api/v1/notifications/summary', { token: studentToken });
    expect(refreshedSummaryRes.json().count).toBe(1);
    const refreshedListRes = await authenticatedRequest(app, 'GET', '/api/v1/notifications', { token: studentToken });
    expect(refreshedListRes.json().notifications.map((notification) => notification.title)).toEqual([
      'System notice',
    ]);

    const forbiddenDismissRes = await authenticatedRequest(app, 'POST', `/api/v1/notifications/${courseNotificationId}/dismiss`, {
      token: professorToken,
    });
    expect(forbiddenDismissRes.statusCode).toBe(403);

    const systemDismissRes = await authenticatedRequest(app, 'POST', `/api/v1/notifications/${systemNotificationId}/dismiss`, {
      token: studentToken,
    });
    expect(systemDismissRes.statusCode).toBe(204);
  });

  it('allows student-only instructor accounts to create course notifications', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'prof-ta@example.com', roles: ['professor'] });
    const professorToken = await getAuthToken(app, professor);
    const ta = await createTestUser({ email: 'ta-only@example.com', roles: ['student'] });
    const taToken = await getAuthToken(app, ta);
    const course = await createCourseAsProfessor(professorToken);

    const addInstructorRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${course._id}/instructors`, {
      token: professorToken,
      payload: { userId: ta._id.toString() },
    });
    expect(addInstructorRes.statusCode).toBe(200);

    const createRes = await authenticatedRequest(app, 'POST', '/api/v1/notifications/manage', {
      token: taToken,
      payload: {
        scopeType: 'course',
        courseId: course._id,
        recipientType: 'instructors',
        title: 'TA notice',
        message: 'Allowed for instructors.',
        persistUntilDismissed: false,
        ...buildWindow(-10, 60),
      },
    });
    expect(createRes.statusCode).toBe(201);
    expect(createRes.json().notification.recipientType).toBe('instructors');

    const listRes = await authenticatedRequest(app, 'GET', `/api/v1/notifications/manage?scopeType=course&courseId=${course._id}`, {
      token: taToken,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().notifications).toHaveLength(1);
    expect(listRes.json().notifications[0].title).toBe('TA notice');
  });

  it('prevents non-instructor students from creating course notifications', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'prof-student-only@example.com', roles: ['professor'] });
    const professorToken = await getAuthToken(app, professor);
    const student = await createTestUser({ email: 'student-only@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const course = await createCourseAsProfessor(professorToken);

    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);

    const createRes = await authenticatedRequest(app, 'POST', '/api/v1/notifications/manage', {
      token: studentToken,
      payload: {
        scopeType: 'course',
        courseId: course._id,
        recipientType: 'all',
        title: 'Student notice',
        message: 'Not allowed.',
        persistUntilDismissed: false,
        ...buildWindow(-10, 60),
      },
    });
    expect(createRes.statusCode).toBe(403);
    expect(createRes.json().message).toMatch(/course instructors or admins/i);
  });

  it('prevents professors from creating system notifications', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'prof-system@example.com', roles: ['professor'] });
    const professorToken = await getAuthToken(app, professor);

    const createRes = await authenticatedRequest(app, 'POST', '/api/v1/notifications/manage', {
      token: professorToken,
      payload: {
        scopeType: 'system',
        title: 'Professor system notice',
        message: 'Nope.',
        persistUntilDismissed: false,
        ...buildWindow(-10, 60),
      },
    });
    expect(createRes.statusCode).toBe(403);
  });

  it('prevents professors from managing notifications outside their courses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const owner = await createTestUser({ email: 'owner-notify@example.com', roles: ['professor'] });
    const ownerToken = await getAuthToken(app, owner);
    const outsider = await createTestUser({ email: 'outsider-notify@example.com', roles: ['professor'] });
    const outsiderToken = await getAuthToken(app, outsider);
    const course = await createCourseAsProfessor(ownerToken);

    const createRes = await authenticatedRequest(app, 'POST', '/api/v1/notifications/manage', {
      token: ownerToken,
      payload: {
        scopeType: 'course',
        courseId: course._id,
        title: 'Owner notice',
        message: 'Visible only to this course.',
        persistUntilDismissed: false,
        ...buildWindow(-10, 60),
      },
    });
    expect(createRes.statusCode).toBe(201);

    const listRes = await authenticatedRequest(app, 'GET', `/api/v1/notifications/manage?scopeType=course&courseId=${course._id}`, {
      token: outsiderToken,
    });
    expect(listRes.statusCode).toBe(403);
  });

  it('rejects dismissals for inaccessible course notifications', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const professor = await createTestUser({ email: 'prof-dismiss@example.com', roles: ['professor'] });
    const professorToken = await getAuthToken(app, professor);
    const outsider = await createTestUser({ email: 'outsider-dismiss@example.com', roles: ['student'] });
    const outsiderToken = await getAuthToken(app, outsider);
    const course = await createCourseAsProfessor(professorToken);

    const createRes = await authenticatedRequest(app, 'POST', '/api/v1/notifications/manage', {
      token: professorToken,
      payload: {
        scopeType: 'course',
        courseId: course._id,
        title: 'Course-only notice',
        message: 'Only enrolled users can dismiss this.',
        persistUntilDismissed: false,
        ...buildWindow(-10, 60),
      },
    });
    expect(createRes.statusCode).toBe(201);

    const dismissRes = await authenticatedRequest(app, 'POST', `/api/v1/notifications/${createRes.json().notification._id}/dismiss`, {
      token: outsiderToken,
    });
    expect(dismissRes.statusCode).toBe(403);
  });
});
