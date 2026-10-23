import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createApp, createTestUser, getAuthToken, authenticatedRequest } from '../helpers.js';
import Course from '../../src/models/Course.js';
import Settings from '../../src/models/Settings.js';

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

async function createCourseWithGroups(profToken) {
  const courseRes = await createCourseAsProf(profToken);
  const courseId = courseRes.json().course._id;

  await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/groups`, {
    token: profToken,
    payload: { categoryName: 'Lab Groups', numberOfGroups: 2 },
  });

  return courseId;
}

// ---------- Course-wide video chat ----------
describe('Course-wide video chat', () => {
  it('toggle enables video chat', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/toggle`, { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.videoChatOptions).toBeDefined();
    expect(body.videoChatOptions.urlId).toBeTruthy();
    expect(body.videoChatOptions.joined).toEqual([]);
  });

  it('toggle disables video chat', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    // Enable
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/toggle`, { token });
    // Disable
    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/toggle`, { token });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
  });

  it('updates api options', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/toggle`, { token });

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${courseId}/video/api-options`, {
      token,
      payload: { startAudioMuted: false, startTileView: false },
    });
    expect(res.statusCode).toBe(200);
    const opts = res.json().videoChatOptions.apiOptions;
    expect(opts.startAudioMuted).toBe(false);
    expect(opts.startTileView).toBe(false);
    expect(opts.startVideoMuted).toBe(true); // unchanged default
  });

  it('rejects api options when video not enabled', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${courseId}/video/api-options`, {
      token,
      payload: { startAudioMuted: false },
    });
    expect(res.statusCode).toBe(400);
  });

  it('join and leave course-wide video', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    // Enable video
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/toggle`, { token });

    // Enroll a student
    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const enrollCode = courseRes.json().course.enrollmentCode;
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: enrollCode },
    });

    // Student joins
    const joinRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/join`, { token: studentToken });
    expect(joinRes.statusCode).toBe(200);

    // Check course
    const courseCheck = await Course.findById(courseId);
    expect(courseCheck.videoChatOptions.joined).toContain(student._id);

    // Student leaves
    const leaveRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/leave`, { token: studentToken });
    expect(leaveRes.statusCode).toBe(200);

    const courseCheck2 = await Course.findById(courseId);
    expect(courseCheck2.videoChatOptions.joined).not.toContain(student._id);
  });

  it('clear participants', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/toggle`, { token });
    // Prof joins
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/join`, { token });

    // Clear
    const clearRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/clear`, { token });
    expect(clearRes.statusCode).toBe(200);

    const course = await Course.findById(courseId);
    expect(course.videoChatOptions.joined).toEqual([]);
  });

  it('broadcasts video:updated for course-wide toggle, api option updates, and clear', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof-video-updated@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const student = await createTestUser({ email: 'student-video-updated@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: courseRes.json().course.enrollmentCode },
    });

    const wsSpy = vi.spyOn(app, 'wsSendToUsers');

    const toggleRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/toggle`, { token });
    expect(toggleRes.statusCode).toBe(200);

    const optionsRes = await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${courseId}/video/api-options`, {
      token,
      payload: { startAudioMuted: false },
    });
    expect(optionsRes.statusCode).toBe(200);

    const clearRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/clear`, { token });
    expect(clearRes.statusCode).toBe(200);

    const videoUpdateCalls = wsSpy.mock.calls.filter(([, event]) => event === 'video:updated');
    expect(videoUpdateCalls).toHaveLength(3);

    const expectedRecipients = [prof._id.toString(), student._id.toString()].sort();
    videoUpdateCalls.forEach(([memberIds, event, data]) => {
      expect(event).toBe('video:updated');
      expect([...memberIds].map((id) => String(id)).sort()).toEqual(expectedRecipients);
      expect(String(data.courseId)).toBe(String(courseId));
    });
  });

  it('student cannot toggle video', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(profToken);
    const courseId = courseRes.json().course._id;

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const enrollCode = courseRes.json().course.enrollmentCode;
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: enrollCode },
    });

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/toggle`, { token: studentToken });
    expect(res.statusCode).toBe(403);
  });

  it('does not grant video settings access to a professor enrolled only as a student', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const instructor = await createTestUser({ email: 'video-instructor@example.com', roles: ['professor'] });
    const instructorToken = await getAuthToken(app, instructor);
    const courseRes = await createCourseAsProf(instructorToken);
    const courseId = courseRes.json().course._id;

    const professorStudent = await createTestUser({ email: 'video-professor-student@example.com', roles: ['professor', 'student'] });
    const professorStudentToken = await getAuthToken(app, professorStudent);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: professorStudentToken,
      payload: { enrollmentCode: courseRes.json().course.enrollmentCode },
    });

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/toggle`, {
      token: professorStudentToken,
    });

    expect(res.statusCode).toBe(403);
  });
});

// ---------- Category video chat ----------
describe('Category video chat', () => {
  it('toggle enables category video', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseId = await createCourseWithGroups(token);

    const course = await Course.findById(courseId);
    const catNum = course.groupCategories[0].categoryNumber;

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/toggle`, { token });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    const updated = await Course.findById(courseId);
    const cat = updated.groupCategories[0];
    expect(cat.catVideoChatOptions).toBeDefined();
    expect(cat.catVideoChatOptions.urlId).toBeTruthy();
  });

  it('toggle disables category video', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseId = await createCourseWithGroups(token);

    const course = await Course.findById(courseId);
    const catNum = course.groupCategories[0].categoryNumber;

    // Enable
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/toggle`, { token });
    // Disable
    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/toggle`, { token });
    expect(res.statusCode).toBe(200);

    const updated = await Course.findById(courseId);
    expect(updated.groupCategories[0].catVideoChatOptions).toBeUndefined();
  });

  it('join and leave category group video', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseId = await createCourseWithGroups(token);

    // Add a student to the course and assign to group
    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const course = await Course.findById(courseId);
    course.students.push(student._id);
    course.groupCategories[0].groups[0].members.push(student._id);
    await course.save();

    const catNum = course.groupCategories[0].categoryNumber;

    // Enable category video
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/toggle`, { token });

    // Student joins group 0
    const joinRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/group/0/join`, { token: studentToken });
    expect(joinRes.statusCode).toBe(200);

    let updated = await Course.findById(courseId);
    expect(updated.groupCategories[0].groups[0].joinedVideoChat).toContain(student._id);

    // Student leaves group 0
    const leaveRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/group/0/leave`, { token: studentToken });
    expect(leaveRes.statusCode).toBe(200);

    updated = await Course.findById(courseId);
    expect(updated.groupCategories[0].groups[0].joinedVideoChat).not.toContain(student._id);
  });

  it('student cannot join group they are not in', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseId = await createCourseWithGroups(token);

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const course = await Course.findById(courseId);
    course.students.push(student._id);
    // Student is NOT added to any group
    await course.save();

    const catNum = course.groupCategories[0].categoryNumber;
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/toggle`, { token });

    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/group/0/join`, { token: studentToken });
    expect(res.statusCode).toBe(403);
  });

  it('instructor joining disables help button', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseId = await createCourseWithGroups(token);

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const course = await Course.findById(courseId);
    course.students.push(student._id);
    course.groupCategories[0].groups[0].members.push(student._id);
    await course.save();

    const catNum = course.groupCategories[0].categoryNumber;
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/toggle`, { token });

    // Student toggles help
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/group/0/join`, { token: studentToken });
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/group/0/toggle-help`, { token: studentToken });

    let updated = await Course.findById(courseId);
    expect(updated.groupCategories[0].groups[0].helpVideoChat).toBe(true);

    // Instructor joins — help should be disabled
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/group/0/join`, { token });

    updated = await Course.findById(courseId);
    expect(updated.groupCategories[0].groups[0].helpVideoChat).toBe(false);
  });

  it('clear category rooms', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseId = await createCourseWithGroups(token);

    const course = await Course.findById(courseId);
    const catNum = course.groupCategories[0].categoryNumber;
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/toggle`, { token });

    // Prof joins a group
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/group/0/join`, { token });

    // Clear all rooms in category
    const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/clear`, { token });
    expect(res.statusCode).toBe(200);

    const updated = await Course.findById(courseId);
    expect(updated.groupCategories[0].groups[0].joinedVideoChat).toEqual([]);
  });
});

// ---------- Connection info ----------
describe('Connection info', () => {
  it('returns course-wide connection info', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/toggle`, { token });

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${courseId}/video/connection-info`, { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.options.roomName).toContain(courseId);
    expect(body.options.roomName).toContain('Qlicker');
    expect(body.apiOptions.subjectTitle).toBe('Course chat');
    expect(body.courseId).toBe(courseId);
    expect(body.isInstructor).toBe(true);
  });

  it('rejects connection info when video not enabled', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseRes = await createCourseAsProf(token);
    const courseId = courseRes.json().course._id;

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${courseId}/video/connection-info`, { token });
    expect(res.statusCode).toBe(400);
  });

  it('returns category group connection info for instructor', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const token = await getAuthToken(app, prof);
    const courseId = await createCourseWithGroups(token);

    const course = await Course.findById(courseId);
    const catNum = course.groupCategories[0].categoryNumber;
    await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/video/category/${catNum}/toggle`, { token });

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${courseId}/video/category/${catNum}/group/0/connection-info`, { token });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.options.roomName).toContain('Ql_C_');
    expect(body.courseId).toBe(courseId);
    expect(body.categoryNumber).toBe(catNum);
    expect(body.isInstructor).toBe(true);
  });
});

// ---------- Jitsi domain endpoint ----------
describe('GET /api/v1/settings/jitsi-domain', () => {
  it('returns 403 when Jitsi is not enabled', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const user = await createTestUser({ email: 'user@example.com', roles: ['student'] });
    const token = await getAuthToken(app, user);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/settings/jitsi-domain', { token });
    expect(res.statusCode).toBe(403);
  });

  it('returns domain when Jitsi is enabled', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const admin = await createTestUser({ email: 'admin@example.com', roles: ['admin'] });
    const adminToken = await getAuthToken(app, admin);

    // Enable Jitsi in settings
    await authenticatedRequest(app, 'PATCH', '/api/v1/settings', {
      token: adminToken,
      payload: {
        Jitsi_Enabled: true,
        Jitsi_Domain: 'meet.jit.si',
        Jitsi_EtherpadDomain: 'etherpad.wikimedia.org',
      },
    });

    const res = await authenticatedRequest(app, 'GET', '/api/v1/settings/jitsi-domain', { token: adminToken });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.domain).toBe('meet.jit.si');
    expect(body.etherpad).toBe('etherpad.wikimedia.org');
  });
});
