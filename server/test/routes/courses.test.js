import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { createApp, createTestUser, getAuthToken, authenticatedRequest } from '../helpers.js';
import Course from '../../src/models/Course.js';
import Session from '../../src/models/Session.js';
import Settings from '../../src/models/Settings.js';
import User from '../../src/models/User.js';

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

// Helper to create a course via the API
async function createCourseAsProf(profToken, overrides = {}) {
  const payload = {
    name: 'Test Course',
    deptCode: 'CS',
    courseNumber: '101',
    section: '001',
    semester: 'Fall 2025',
    ...overrides,
  };
  const res = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
    token: profToken,
    payload,
  });
  return res;
}

// ---------- POST /api/v1/courses ----------
describe('POST /api/v1/courses', () => {
  it('professor can create a course', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);

    const res = await createCourseAsProf(token);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.course).toBeDefined();
    expect(body.course.name).toBe('Test Course');
    expect(body.course.deptCode).toBe('CS');
    expect(body.course.owner).toBe(prof._id.toString());
    expect(body.course.instructors).toContain(prof._id.toString());
    expect(body.course.allowSharedActivities).toBe(false);
  });

  it('pure admin can create a course without being added as an instructor', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-course@example.com', roles: ['admin'] });
    const token = await getAuthToken(app, admin);

    const res = await createCourseAsProf(token, { name: 'Admin-owned Course' });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.course.owner).toBe(admin._id.toString());
    expect(body.course.instructors || []).toEqual([]);

    const persistedAdmin = await User.findById(admin._id).lean();
    expect(persistedAdmin.profile.courses || []).toEqual([]);
  });

  it('student cannot create a course', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const token = await getAuthToken(app, student);

    const res = await createCourseAsProf(token);

    expect(res.statusCode).toBe(403);
  });

  it('returns course with enrollment code', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);

    const res = await createCourseAsProf(token);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.course.enrollmentCode).toBeDefined();
    expect(typeof body.course.enrollmentCode).toBe('string');
    expect(body.course.enrollmentCode.length).toBe(6);
  });
});

// ---------- GET /api/v1/courses ----------
describe('GET /api/v1/courses', () => {
  it('professor sees their courses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    await createCourseAsProf(token, { name: 'Prof Course' });

    const res = await authenticatedRequest(app, 'GET', '/api/v1/courses', { token });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.courses).toBeDefined();
    expect(body.courses.length).toBe(1);
    expect(body.courses[0].name).toBe('Prof Course');
  });

  it('student sees enrolled courses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;
    await Course.findByIdAndUpdate(course._id, {
      $set: {
        aiApiUrl: 'http://private-ai.internal',
        aiBackends: [{ id: 'private', url: 'http://private-ai.internal', apiToken: 'secret' }],
        aiStudentChatGuidance: 'private guidance',
      },
    });

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    // Enroll the student
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    const res = await authenticatedRequest(app, 'GET', '/api/v1/courses', { token: studentToken });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.courses.length).toBe(1);
    expect(body.courses[0].aiApiUrl).toBeUndefined();
    expect(body.courses[0].aiBackends).toBeUndefined();
    expect(body.courses[0].aiStudentChatGuidance).toBeUndefined();
  });

  it('professor can fetch student-view courses separately from instructor courses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const owner = await createTestUser({ email: 'owner-prof@example.com', roles: ['professor'] });
    const ownerToken = await getAuthToken(app, owner);
    const courseRes = await createCourseAsProf(ownerToken, { name: 'Student View Course' });
    const course = courseRes.json().course;

    const enrolledProf = await createTestUser({ email: 'enrolled-prof@example.com', roles: ['professor'] });
    const enrolledProfToken = await getAuthToken(app, enrolledProf);

    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: enrolledProfToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);

    // Pin the course creation time before the session so lastActivityAt (the
    // max of course.createdAt and the latest session) resolves to the session
    // rather than to "now" once real time moves past the seeded dates.
    await Course.findByIdAndUpdate(course._id, {
      $set: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
    });

    await Session.create({
      name: 'Recent Session',
      courseId: course._id,
      creator: owner._id.toString(),
      status: 'done',
      createdAt: new Date('2026-04-05T00:00:00.000Z'),
    });

    const instructorRes = await authenticatedRequest(app, 'GET', '/api/v1/courses?view=instructor', {
      token: enrolledProfToken,
    });
    expect(instructorRes.statusCode).toBe(200);
    expect(instructorRes.json().courses).toEqual([]);

    const studentRes = await authenticatedRequest(app, 'GET', '/api/v1/courses?view=student', {
      token: enrolledProfToken,
    });

    expect(studentRes.statusCode).toBe(200);
    expect(studentRes.json().courses).toHaveLength(1);
    expect(studentRes.json().courses[0]._id).toBe(course._id);
    expect(studentRes.json().courses[0].lastActivityAt).toBe('2026-04-05T00:00:00.000Z');
  });

  it('student-only instructor accounts can fetch instructor courses explicitly', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof-instructor-view@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken, { name: 'Instructor View Course' });
    const course = createRes.json().course;

    const student = await createTestUser({ email: 'mixed-course@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    await authenticatedRequest(app, 'POST', `/api/v1/courses/${course._id}/instructors`, {
      token: profToken,
      payload: { userId: student._id.toString() },
    });

    const instructorRes = await authenticatedRequest(app, 'GET', '/api/v1/courses?view=instructor', {
      token: studentToken,
    });
    expect(instructorRes.statusCode).toBe(200);
    expect(instructorRes.json().courses.map((entry) => entry._id)).toContain(course._id);

    const storedCourse = await Course.findById(course._id).lean();
    expect((storedCourse.students || []).map(String)).not.toContain(String(student._id));
    const storedStudent = await User.findById(student._id).lean();
    expect((storedStudent.profile.courses || []).map(String)).toContain(String(course._id));
  });

  it('rejects instructor-view course lists for students without instructor courses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const student = await createTestUser({ email: 'plain-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/courses?view=instructor', {
      token: studentToken,
    });

    expect(res.statusCode).toBe(403);
  });

  it('admin sees all courses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    await createCourseAsProf(profToken, { name: 'Course A' });
    await createCourseAsProf(profToken, { name: 'Course B', courseNumber: '102' });

    const admin = await createTestUser({ email: 'admin@example.com', roles: ['admin'] });
    const adminToken = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/courses', { token: adminToken });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.courses.length).toBe(2);
  });

  it('admin instructor-view includes courses they own', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin-owned-course@example.com', roles: ['admin'] });
    const adminToken = await getAuthToken(app, admin);
    const createRes = await createCourseAsProf(adminToken, { name: 'Admin Owned Course' });
    const course = createRes.json().course;

    const res = await authenticatedRequest(app, 'GET', '/api/v1/courses?view=instructor', { token: adminToken });

    expect(res.statusCode).toBe(200);
    expect(res.json().courses.map((entry) => String(entry._id))).toContain(String(course._id));
  });
});

// ---------- GET /api/v1/courses/:id ----------
describe('GET /api/v1/courses/:id', () => {
  it('instructor sees full details including students', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}`, {
      token: profToken,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.course).toBeDefined();
    expect(body.course.students).toBeDefined();
    expect(body.course.name).toBe('Test Course');
  });

  it('student sees course without student list', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}`, {
      token: studentToken,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.course).toBeDefined();
    expect(body.course.students).toBeUndefined();
    // Students now see limited groupCategories for video chat (but no full member lists)
    expect(body.course.currentUserId).toBeDefined();
  });

  it('non-enrolled user gets 403', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const other = await createTestUser({ email: 'other@example.com', roles: ['student'] });
    const otherToken = await getAuthToken(app, other);

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}`, {
      token: otherToken,
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /api/v1/courses/:id', () => {
  it('only permits AI helper settings for administrator-approved courses and never returns a course token', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof-ai-course@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(token)).json().course;

    const denied = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${course._id}`, {
      token,
      payload: { aiEnabled: true },
    });
    expect(denied.statusCode).toBe(403);

    await Settings.findOneAndUpdate(
      { _id: 'settings' },
      { $set: { AI_Enabled: true, AI_EnabledCourses: [course._id], AI_AllowCourseBackendCourses: [course._id] } },
      { upsert: true },
    );
    const enabled = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${course._id}`, {
      token,
      payload: { aiEnabled: true, aiApiUrl: 'https://llm.example/v1', aiApiToken: 'course-secret-token' },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().course.aiEnabled).toBe(true);
    expect(enabled.json().course.aiApiToken).toBeUndefined();
    expect(enabled.json().course.aiApiTokenSet).toBe(true);

    const courseGet = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}`, { token });
    expect(JSON.stringify(courseGet.json())).not.toContain('course-secret-token');
  });

  it('allows instructors to override the course quiz time format', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const prof = await createTestUser({ email: 'prof-course-format@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const courseId = createRes.json().course._id;

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${courseId}`, {
      token: profToken,
      payload: { quizTimeFormat: '12h' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().course.quizTimeFormat).toBe('12h');

    const storedCourse = await Course.findById(courseId).lean();
    expect(storedCourse.quizTimeFormat).toBe('12h');
  });
});

// ---------- PATCH /api/v1/courses/:id ----------
describe('PATCH /api/v1/courses/:id', () => {
  it('instructor can update', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${course._id}`, {
      token: profToken,
      payload: { name: 'Updated Course' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.course.name).toBe('Updated Course');
  });

  it('persists normalized course tags from settings updates', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'course-tags-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken)).json().course;

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${course._id}`, {
      token: profToken,
      payload: {
        tags: [
          { value: 'physics', label: 'physics' },
          { value: 'first-year', label: 'first-year' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().course.tags).toEqual([
      { value: 'physics', label: 'physics' },
      { value: 'first-year', label: 'first-year' },
    ]);
  });

  it('non-instructor gets 403', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const other = await createTestUser({ email: 'other@example.com', roles: ['professor'] });
    const otherToken = await getAuthToken(app, other);

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${course._id}`, {
      token: otherToken,
      payload: { name: 'Hacked' },
    });

    expect(res.statusCode).toBe(403);
  });
});

// ---------- DELETE /api/v1/courses/:id ----------
describe('DELETE /api/v1/courses/:id', () => {
  it('owner can delete', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const res = await authenticatedRequest(app, 'DELETE', `/api/v1/courses/${course._id}`, {
      token: profToken,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
  });

  it('non-owner gets 403', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const other = await createTestUser({ email: 'other@example.com', roles: ['professor'] });
    const otherToken = await getAuthToken(app, other);

    const res = await authenticatedRequest(app, 'DELETE', `/api/v1/courses/${course._id}`, {
      token: otherToken,
    });

    expect(res.statusCode).toBe(403);
  });
});

// ---------- POST /api/v1/courses/enroll ----------
describe('POST /api/v1/courses/enroll', () => {
  it('student can enroll with valid code', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    const res = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.course).toBeDefined();
    expect(body.course._id).toBe(course._id);
  });

  it('professors can enroll as students in other courses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const owner = await createTestUser({ email: 'owner-prof-enroll@example.com', roles: ['professor'] });
    const ownerToken = await getAuthToken(app, owner);
    const createRes = await createCourseAsProf(ownerToken);
    const course = createRes.json().course;

    const prof = await createTestUser({ email: 'prof-enroll@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);

    const res = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: profToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().course._id).toBe(course._id);

    const storedCourse = await Course.findById(course._id).lean();
    expect((storedCourse.students || []).map(String)).toContain(String(prof._id));
    const storedUser = await User.findById(prof._id).lean();
    expect((storedUser.profile.courses || []).map(String)).toContain(String(course._id));
  });

  it('rejects enrolling as a student when already an instructor in the course', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof-own-course@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const res = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: profToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/already enrolled as an instructor/i);
  });

  it('invalid code returns 404', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    const res = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: 'ZZZZZZ' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('duplicate enrollment returns 409', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    const res = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    expect(res.statusCode).toBe(409);
  });

  it('inactive course blocks student enrollment', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof-inactive@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;
    await Course.findByIdAndUpdate(course._id, { $set: { inactive: true } });

    const student = await createTestUser({ email: 'student-inactive@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    const res = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe('COURSE_INACTIVE');
    expect(body.message).toBe('Course is inactive for students');

    const persistedCourse = await Course.findById(course._id).lean();
    const persistedStudent = await User.findById(student._id).lean();
    expect((persistedCourse?.students || []).map((id) => String(id))).not.toContain(String(student._id));
    expect((persistedStudent?.profile?.courses || []).map((id) => String(id))).not.toContain(String(course._id));
  });

  it('skips the verified-email enrollment requirement when SSO is enabled', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    await Settings.create({ _id: 'settings', SSO_enabled: true });

    const prof = await createTestUser({ email: 'prof-sso@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;
    await Course.findByIdAndUpdate(course._id, { requireVerified: true });

    const student = await createTestUser({ email: 'student-sso@example.com', roles: ['student'] });
    await User.updateOne(
      { _id: student._id },
      { $set: { 'emails.0.verified': false } }
    );
    const studentToken = await getAuthToken(app, student);

    const res = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    expect(res.statusCode).toBe(200);
  });
});

// ---------- DELETE /api/v1/courses/:id/students/:studentId ----------
describe('DELETE /api/v1/courses/:id/students/:studentId', () => {
  it('instructor can remove student', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    const res = await authenticatedRequest(
      app,
      'DELETE',
      `/api/v1/courses/${course._id}/students/${student._id}`,
      { token: profToken }
    );

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
  });
});

// ---------- POST /api/v1/courses/:id/instructors ----------
describe('POST /api/v1/courses/:id/instructors', () => {
  it('owner can add instructor', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const newInstructor = await createTestUser({ email: 'ta@example.com', roles: ['professor'] });

    const res = await authenticatedRequest(
      app,
      'POST',
      `/api/v1/courses/${course._id}/instructors`,
      { token: profToken, payload: { userId: newInstructor._id.toString() } }
    );

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
  });

  it('owner can add an SSO-created instructor by email address', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'owner@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const ssoInstructor = await User.create({
      emails: [{ address: 'sso-instructor@example.com', verified: true }],
      services: {
        password: { hash: await User.hashPassword('password123') },
        sso: { id: 'sso-instructor-1', email: 'sso-instructor@example.com' },
      },
      profile: { firstname: 'SSO', lastname: 'Instructor', roles: ['professor'] },
      ssoCreated: true,
      allowEmailLogin: false,
      createdAt: new Date(),
    });

    const res = await authenticatedRequest(
      app,
      'POST',
      `/api/v1/courses/${course._id}/instructors`,
      { token: profToken, payload: { userId: 'sso-instructor@example.com' } }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const updatedCourse = await Course.findById(course._id).lean();
    expect(updatedCourse.instructors).toContain(String(ssoInstructor._id));
  });

  it('rejects adding an instructor who is already enrolled as a student', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'owner-student-conflict@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const student = await createTestUser({ email: 'existing-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);

    const res = await authenticatedRequest(
      app,
      'POST',
      `/api/v1/courses/${course._id}/instructors`,
      { token: profToken, payload: { userId: student._id.toString() } }
    );

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/student already enrolled/i);

    const updatedCourse = await Course.findById(course._id).lean();
    expect((updatedCourse.students || []).map(String)).toContain(String(student._id));
    expect((updatedCourse.instructors || []).map(String)).not.toContain(String(student._id));
  });
});

// ---------- DELETE /api/v1/courses/:id/instructors/:instructorId ----------
describe('DELETE /api/v1/courses/:id/instructors/:instructorId', () => {
  it('cannot remove last instructor', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const res = await authenticatedRequest(
      app,
      'DELETE',
      `/api/v1/courses/${course._id}/instructors/${prof._id}`,
      { token: profToken }
    );

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.message).toMatch(/last instructor/i);
  });
});

// ---------- POST /api/v1/courses/:id/regenerate-code ----------
describe('POST /api/v1/courses/:id/regenerate-code', () => {
  it('instructor can regenerate', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;
    const oldCode = course.enrollmentCode;

    const res = await authenticatedRequest(
      app,
      'POST',
      `/api/v1/courses/${course._id}/regenerate-code`,
      { token: profToken }
    );

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enrollmentCode).toBeDefined();
    expect(typeof body.enrollmentCode).toBe('string');
    expect(body.enrollmentCode.length).toBe(6);
    expect(body.enrollmentCode).not.toBe(oldCode);
  });
});

// ---------- PATCH /api/v1/courses/:id/active ----------
describe('PATCH /api/v1/courses/:id/active', () => {
  it('instructor can toggle', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const res = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/courses/${course._id}/active`,
      { token: profToken, payload: { inactive: true } }
    );

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.course.inactive).toBe(true);
  });
});

// ---------- Student self-unenroll ----------
describe('DELETE /api/v1/courses/:id/students/:studentId (self-unenroll)', () => {
  it('student can unenroll themselves', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    const res = await authenticatedRequest(
      app,
      'DELETE',
      `/api/v1/courses/${course._id}/students/${student._id}`,
      { token: studentToken }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it('student cannot remove another student', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const createRes = await createCourseAsProf(profToken);
    const course = createRes.json().course;

    const student1 = await createTestUser({ email: 'student1@example.com', roles: ['student'] });
    const student1Token = await getAuthToken(app, student1);
    const student2 = await createTestUser({ email: 'student2@example.com', roles: ['student'] });
    const student2Token = await getAuthToken(app, student2);

    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: student1Token,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: student2Token,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    const res = await authenticatedRequest(
      app,
      'DELETE',
      `/api/v1/courses/${course._id}/students/${student2._id}`,
      { token: student1Token }
    );

    expect(res.statusCode).toBe(403);
  });
});
