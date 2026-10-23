import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createApp, createTestUser, getAuthToken, authenticatedRequest } from '../helpers.js';
import Course from '../../src/models/Course.js';
import Grade from '../../src/models/Grade.js';
import Session from '../../src/models/Session.js';
import Question from '../../src/models/Question.js';
import Response from '../../src/models/Response.js';

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
  const {
    allowStudentQuestions,
    inactive,
    requireVerified,
    quizTimeFormat,
    tags,
    ...apiOverrides
  } = overrides;
  const payload = {
    name: 'Test Course',
    deptCode: 'CS',
    courseNumber: '101',
    section: '001',
    semester: 'Fall 2025',
    ...apiOverrides,
  };
  const res = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
    token: profToken,
    payload,
  });
  if (res.statusCode === 201) {
    const courseId = res.json().course?._id;
    const postCreateUpdates = {};
    if (allowStudentQuestions !== undefined) postCreateUpdates.allowStudentQuestions = allowStudentQuestions;
    if (inactive !== undefined) postCreateUpdates.inactive = inactive;
    if (requireVerified !== undefined) postCreateUpdates.requireVerified = requireVerified;
    if (quizTimeFormat !== undefined) postCreateUpdates.quizTimeFormat = quizTimeFormat;
    if (tags !== undefined) postCreateUpdates.tags = tags;
    if (courseId && Object.keys(postCreateUpdates).length > 0) {
      await Course.findByIdAndUpdate(courseId, { $set: postCreateUpdates });
    }
  }
  return res;
}

// Helper to create a session via the API
async function createSessionInCourse(token, courseId, overrides = {}) {
  const payload = { name: 'Test Session', ...overrides };
  const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/sessions`, {
    token,
    payload,
  });
  return res;
}

// Helper to create a question via the API
async function createQuestionAsProf(profToken, overrides = {}) {
  const payload = { type: 2, content: 'Test question?', ...overrides };
  const res = await authenticatedRequest(app, 'POST', '/api/v1/questions', {
    token: profToken,
    payload,
  });
  return res;
}

async function createQuestionInSession(profToken, {
  sessionId,
  courseId,
  ...payload
}) {
  const qRes = await createQuestionAsProf(profToken, {
    sessionId,
    courseId,
    ...payload,
  });
  expect(qRes.statusCode).toBe(201);

  const question = qRes.json().question;
  const addRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/questions`, {
    token: profToken,
    payload: { questionId: question._id },
  });
  expect(addRes.statusCode).toBe(200);
  return question;
}

// Helper: prof + course + session
async function setupCourseAndSession() {
  const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
  const profToken = await getAuthToken(app, prof);
  const courseRes = await createCourseAsProf(profToken);
  const course = courseRes.json().course;
  const sessRes = await createSessionInCourse(profToken, course._id);
  const session = sessRes.json().session;
  return { prof, profToken, course, session };
}

// ---------- POST /api/v1/questions ----------
describe('POST /api/v1/questions', () => {
  it('professor can create a question', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);

    const res = await createQuestionAsProf(profToken, {
      type: 0,
      content: 'What is 2+2?',
      options: [
        { answer: '3', correct: false },
        { answer: '4', correct: true },
      ],
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.question).toBeDefined();
    expect(body.question.content).toBe('What is 2+2?');
    expect(body.question.type).toBe(0);
    expect(body.question.creator).toBe(prof._id.toString());
    expect(body.question.options.length).toBe(2);
  });

  it('rejects multiple-choice questions with more than one correct option', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);

    const res = await createQuestionAsProf(profToken, {
      type: 0,
      content: 'Pick one answer',
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: true },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Multiple Choice questions can only have one correct option');
  });

  it('student cannot create a question when student questions are disabled (403)', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { course } = await setupCourseAndSession();
    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);

    const res = await createQuestionAsProf(studentToken, { courseId: course._id });

    expect(res.statusCode).toBe(403);
  });

  it('student can create a private unapproved library question when enabled', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'student-questions-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken, { allowStudentQuestions: true })).json().course;
    await Course.findByIdAndUpdate(course._id, { $set: { allowStudentQuestions: true } });
    const student = await createTestUser({ email: 'student-enabled@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);

    const res = await authenticatedRequest(app, 'POST', '/api/v1/questions', {
      token: studentToken,
      payload: {
        type: 2,
        courseId: course._id,
        content: 'Student library question',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().question.approved).toBe(false);
    expect(res.json().question.public).toBe(false);
    expect(res.json().question.studentCreated).toBe(true);
    expect(res.json().question.sessionId).toBe('');
  });

  it('student-only instructor can create instructor-managed questions without student-practice access', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'mixed-create-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken, { allowStudentQuestions: true })).json().course;
    const mixedUser = await createTestUser({ email: 'mixed-create-student@example.com', roles: ['student'] });
    const mixedToken = await getAuthToken(app, mixedUser);

    const addInstructorRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${course._id}/instructors`, {
      token: profToken,
      payload: { userId: mixedUser._id.toString() },
    });
    expect(addInstructorRes.statusCode).toBe(200);

    const res = await authenticatedRequest(app, 'POST', '/api/v1/questions', {
      token: mixedToken,
      payload: {
        type: 2,
        courseId: course._id,
        content: 'Instructor-managed question',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().question.studentCreated).toBe(false);
    expect(res.json().question.approved).toBe(true);
  });

  it('creates question with sessionId and courseId', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();

    const res = await createQuestionAsProf(profToken, {
      sessionId: session._id,
      courseId: course._id,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.question.sessionId).toBe(session._id);
    expect(body.question.courseId).toBe(course._id);
  });

  it('accepts slide questions with session options during creation', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();

    const res = await createQuestionAsProf(profToken, {
      type: 6,
      content: '<p>Slide content</p>',
      plainText: 'Slide content',
      sessionId: session._id,
      courseId: course._id,
      sessionOptions: {
        points: 0,
        hidden: false,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.question.type).toBe(6);
    expect(body.question.sessionOptions.points).toBe(0);
    expect(body.question.sessionOptions.hidden).toBe(false);
  });

  it('preserves slide content when the saved question is fetched again', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();

    const createRes = await createQuestionAsProf(profToken, {
      type: 6,
      content: '<p>Slide content</p>',
      plainText: 'Slide content',
      sessionId: session._id,
      courseId: course._id,
      sessionOptions: { points: 0 },
    });

    expect(createRes.statusCode).toBe(201);
    const questionId = createRes.json().question._id;

    const fetchRes = await authenticatedRequest(app, 'GET', `/api/v1/questions/${questionId}`, {
      token: profToken,
    });

    expect(fetchRes.statusCode).toBe(200);
    expect(fetchRes.json().question.type).toBe(6);
    expect(fetchRes.json().question.content).toBe('<p>Slide content</p>');
    expect(fetchRes.json().question.plainText).toBe('Slide content');
  });
});

// ---------- GET /api/v1/questions/:id ----------
describe('GET /api/v1/questions/:id', () => {
  it('authenticated user can get a question', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const qRes = await createQuestionAsProf(profToken, { content: 'My Q' });
    const question = qRes.json().question;

    const res = await authenticatedRequest(app, 'GET', `/api/v1/questions/${question._id}`, {
      token: profToken,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.question).toBeDefined();
    expect(body.question.content).toBe('My Q');
  });

  it('course instructors can get private course questions they did not create', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const ownerProf = await createTestUser({ email: 'owner-prof@example.com', roles: ['professor'] });
    const ownerToken = await getAuthToken(app, ownerProf);
    const course = (await createCourseAsProf(ownerToken)).json().course;

    const otherProf = await createTestUser({ email: 'other-prof@example.com', roles: ['professor'] });
    const otherToken = await getAuthToken(app, otherProf);
    const addInstructorRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${course._id}/instructors`, {
      token: ownerToken,
      payload: { userId: otherProf._id.toString() },
    });
    expect(addInstructorRes.statusCode).toBe(200);

    const question = (await createQuestionAsProf(ownerToken, {
      courseId: course._id,
      content: 'Private instructor question',
      public: false,
    })).json().question;

    const res = await authenticatedRequest(app, 'GET', `/api/v1/questions/${question._id}`, {
      token: otherToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().question.content).toBe('Private instructor question');
  });

  it('blocks students from getting private course questions directly', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'private-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken, { allowStudentQuestions: true })).json().course;
    const student = await createTestUser({ email: 'private-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);

    const question = (await createQuestionAsProf(profToken, {
      courseId: course._id,
      content: 'Private to instructors',
      solution: 'secret',
      public: false,
    })).json().question;

    const res = await authenticatedRequest(app, 'GET', `/api/v1/questions/${question._id}`, {
      token: studentToken,
    });

    expect(res.statusCode).toBe(403);
  });

  it('allows enrolled students to view course-public questions without answer reveals', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'public-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken, { allowStudentQuestions: true })).json().course;
    const student = await createTestUser({ email: 'public-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);

    const question = (await createQuestionAsProf(profToken, {
      courseId: course._id,
      type: 0,
      content: 'Visible to the course',
      solution: 'hidden solution',
      public: true,
      options: [
        { answer: 'A', correct: false },
        { answer: 'B', correct: true },
      ],
    })).json().question;

    const res = await authenticatedRequest(app, 'GET', `/api/v1/questions/${question._id}`, {
      token: studentToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().question.solution).toBeUndefined();
    expect(res.json().question.options[1].correct).toBeUndefined();
  });

  it('allows Qlicker-wide public questions to include or exclude student viewers', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'global-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const student = await createTestUser({ email: 'global-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);

    const profOnlyQuestion = (await createQuestionAsProf(profToken, {
      content: 'Prof-only global question',
      publicOnQlicker: true,
      publicOnQlickerForStudents: false,
    })).json().question;
    const studentVisibleQuestion = (await createQuestionAsProf(profToken, {
      content: 'Student-visible global question',
      publicOnQlicker: true,
      publicOnQlickerForStudents: true,
    })).json().question;

    const blockedRes = await authenticatedRequest(app, 'GET', `/api/v1/questions/${profOnlyQuestion._id}`, {
      token: studentToken,
    });
    const allowedRes = await authenticatedRequest(app, 'GET', `/api/v1/questions/${studentVisibleQuestion._id}`, {
      token: studentToken,
    });

    expect(blockedRes.statusCode).toBe(403);
    expect(allowedRes.statusCode).toBe(200);
    expect(allowedRes.json().question.content).toBe('Student-visible global question');
  });

  it('allows enrolled students to get reviewable-session and live-quiz questions', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'review-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken)).json().course;
    const student = await createTestUser({ email: 'review-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);

    const reviewSession = (await createSessionInCourse(profToken, course._id)).json().session;
    const reviewPatchRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${reviewSession._id}`, {
      token: profToken,
      payload: { status: 'done', reviewable: true },
    });
    expect(reviewPatchRes.statusCode).toBe(200);
    const reviewQuestion = await createQuestionInSession(profToken, {
      sessionId: reviewSession._id,
      courseId: course._id,
      content: 'Reviewable question',
      type: 2,
    });

    const liveSession = (await createSessionInCourse(profToken, course._id, {
      quiz: true,
      quizStart: new Date(Date.now() - 60_000).toISOString(),
      quizEnd: new Date(Date.now() + 60_000).toISOString(),
    })).json().session;
    const livePatchRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${liveSession._id}`, {
      token: profToken,
      payload: { status: 'visible' },
    });
    expect(livePatchRes.statusCode).toBe(200);
    const liveQuestion = await createQuestionInSession(profToken, {
      sessionId: liveSession._id,
      courseId: course._id,
      content: 'Live quiz question',
      type: 2,
    });

    const reviewRes = await authenticatedRequest(app, 'GET', `/api/v1/questions/${reviewQuestion._id}`, {
      token: studentToken,
    });
    const liveRes = await authenticatedRequest(app, 'GET', `/api/v1/questions/${liveQuestion._id}`, {
      token: studentToken,
    });

    expect(reviewRes.statusCode).toBe(200);
    expect(liveRes.statusCode).toBe(200);
  });

  it('returns 404 for non-existent question', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);

    const res = await authenticatedRequest(app, 'GET', '/api/v1/questions/nonexistent12345', {
      token: profToken,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/v1/questions/bulk-visibility', () => {
  it('updates selected question visibility states for manageable questions', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();
    const question = await createQuestionInSession(profToken, {
      courseId: course._id,
      sessionId: session._id,
      content: 'Bulk visibility question',
      public: false,
      publicOnQlicker: false,
    });

    const res = await authenticatedRequest(app, 'POST', '/api/v1/questions/bulk-visibility', {
      token: profToken,
      payload: {
        questionIds: [question._id],
        public: true,
        publicOnQlicker: true,
        publicOnQlickerForStudents: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().updatedQuestionIds).toEqual([question._id]);

    const updated = await Question.findById(question._id).lean();
    expect(updated.public).toBe(true);
    expect(updated.publicOnQlicker).toBe(true);
    expect(updated.publicOnQlickerForStudents).toBe(true);
  });
});

// ---------- PATCH /api/v1/questions/:id ----------
describe('PATCH /api/v1/questions/:id', () => {
  it('creator can update a question', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const qRes = await createQuestionAsProf(profToken);
    const question = qRes.json().question;

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${question._id}`, {
      token: profToken,
      payload: { content: 'Updated content', solution: 'The answer is 42' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.question.content).toBe('Updated content');
    expect(body.question.solution).toBe('The answer is 42');
  });

  it('persists zero points without resetting other session options and reports affected grades', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { prof, profToken, course, session } = await setupCourseAndSession();
    const qRes = await createQuestionAsProf(profToken, {
      courseId: course._id,
      sessionId: session._id,
      sessionOptions: {
        points: 1,
        hidden: true,
        stats: true,
        maxAttempts: 3,
      },
    });
    const question = qRes.json().question;
    await Grade.create({
      userId: String(prof._id),
      courseId: String(course._id),
      sessionId: String(session._id),
      marks: [{ questionId: question._id, points: 1, outOf: 1 }],
    });

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${question._id}`, {
      token: profToken,
      payload: { sessionOptions: { points: 0 } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().gradingAffected).toBe(true);
    expect(res.json().question.sessionOptions).toMatchObject({
      points: 0,
      hidden: true,
      stats: true,
      maxAttempts: 3,
    });
  });

  it('preserves slide content when a slide question is updated', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();
    const createRes = await createQuestionAsProf(profToken, {
      type: 6,
      content: '<p>Original slide</p>',
      plainText: 'Original slide',
      sessionId: session._id,
      courseId: course._id,
      sessionOptions: { points: 0 },
    });
    expect(createRes.statusCode).toBe(201);
    const questionId = createRes.json().question._id;

    const updateRes = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${questionId}`, {
      token: profToken,
      payload: {
        type: 6,
        content: '<p>Updated slide</p>',
        plainText: 'Updated slide',
        sessionOptions: { points: 0 },
      },
    });

    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().question.type).toBe(6);
    expect(updateRes.json().question.content).toBe('<p>Updated slide</p>');
    expect(updateRes.json().question.plainText).toBe('Updated slide');
    expect(updateRes.json().question.solution).toBe('');
  });

  it('non-creator/non-admin gets 403', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const qRes = await createQuestionAsProf(profToken);
    const question = qRes.json().question;

    const other = await createTestUser({ email: 'other@example.com', roles: ['professor'] });
    const otherToken = await getAuthToken(app, other);

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${question._id}`, {
      token: otherToken,
      payload: { content: 'Hacked' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('student cannot update another student’s question', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'student-owner-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken)).json().course;
    await Course.findByIdAndUpdate(course._id, {
      $set: {
        allowStudentQuestions: true,
        tags: [{ value: 'algebra', label: 'algebra' }],
      },
    });

    const studentOwner = await createTestUser({ email: 'student-owner@example.com', roles: ['student'] });
    const studentOwnerToken = await getAuthToken(app, studentOwner);
    const otherStudent = await createTestUser({ email: 'other-student@example.com', roles: ['student'] });
    const otherStudentToken = await getAuthToken(app, otherStudent);

    for (const token of [studentOwnerToken, otherStudentToken]) {
      const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
        token,
        payload: { enrollmentCode: course.enrollmentCode },
      });
      expect(enrollRes.statusCode).toBe(200);
    }

    const questionRes = await authenticatedRequest(app, 'POST', '/api/v1/questions', {
      token: studentOwnerToken,
      payload: {
        type: 2,
        courseId: course._id,
        content: 'Owner question',
        tags: [{ value: 'algebra', label: 'algebra' }],
      },
    });
    expect(questionRes.statusCode).toBe(201);

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${questionRes.json().question._id}`, {
      token: otherStudentToken,
      payload: { content: 'Not allowed' },
    });

    expect(res.statusCode).toBe(403);
  });

  it('admin can update any question', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const qRes = await createQuestionAsProf(profToken);
    const question = qRes.json().question;

    const admin = await createTestUser({ email: 'admin@example.com', roles: ['admin'] });
    const adminToken = await getAuthToken(app, admin);

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${question._id}`, {
      token: adminToken,
      payload: { content: 'Admin edit' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().question.content).toBe('Admin edit');
  });

  it('allows non-tag updates when a question still has legacy non-course tags', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course } = await setupCourseAndSession();
    await Course.findByIdAndUpdate(course._id, {
      $set: { tags: [{ value: 'algebra', label: 'algebra' }] },
    });

    const qRes = await createQuestionAsProf(profToken, {
      type: 2,
      courseId: course._id,
      content: 'Original content',
      tags: [{ value: 'algebra', label: 'algebra' }],
    });
    expect(qRes.statusCode).toBe(201);
    const questionId = qRes.json().question._id;

    await Question.findByIdAndUpdate(questionId, {
      $set: { tags: [{ value: 'legacy-topic', label: 'legacy-topic' }] },
    });

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${questionId}`, {
      token: profToken,
      payload: { content: 'Updated content' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().question.content).toBe('Updated content');
    expect(res.json().question.tags).toEqual([{ value: 'legacy-topic', label: 'legacy-topic' }]);
  });

  it('allows removing legacy non-course tags but still rejects adding new ones', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course } = await setupCourseAndSession();
    await Course.findByIdAndUpdate(course._id, {
      $set: { tags: [{ value: 'algebra', label: 'algebra' }] },
    });

    const qRes = await createQuestionAsProf(profToken, {
      type: 2,
      courseId: course._id,
      content: 'Tagged content',
      tags: [{ value: 'algebra', label: 'algebra' }],
    });
    expect(qRes.statusCode).toBe(201);
    const questionId = qRes.json().question._id;

    await Question.findByIdAndUpdate(questionId, {
      $set: { tags: [{ value: 'legacy-topic', label: 'legacy-topic' }] },
    });

    const removeLegacyRes = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${questionId}`, {
      token: profToken,
      payload: { tags: [] },
    });
    expect(removeLegacyRes.statusCode).toBe(200);
    expect(removeLegacyRes.json().question.tags).toEqual([]);

    await Question.findByIdAndUpdate(questionId, {
      $set: { tags: [{ value: 'legacy-topic', label: 'legacy-topic' }] },
    });

    const addInvalidRes = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${questionId}`, {
      token: profToken,
      payload: {
        tags: [
          { value: 'legacy-topic', label: 'legacy-topic' },
          { value: 'calculus', label: 'calculus' },
        ],
      },
    });
    expect(addInvalidRes.statusCode).toBe(400);
    expect(addInvalidRes.json().message).toBe('Questions can only use the course topics');
  });

  it('course instructors can update a session question when legacy question.courseId is missing', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { course, session } = await setupCourseAndSession();

    const legacyCreator = await createTestUser({ email: 'legacy-owner@example.com', roles: ['professor'] });
    const legacyCreatorToken = await getAuthToken(app, legacyCreator);
    const prof = await createTestUser({ email: 'course-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);

    await Course.findByIdAndUpdate(course._id, {
      $addToSet: { instructors: prof._id.toString() },
    });

    const qRes = await createQuestionAsProf(legacyCreatorToken, {
      type: 6,
      content: '<p>Legacy slide</p>',
      plainText: 'Legacy slide',
      sessionId: session._id,
      courseId: '',
      sessionOptions: { points: 0 },
    });
    const question = qRes.json().question;

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${question._id}`, {
      token: profToken,
      payload: {
        type: 6,
        content: '<p>Updated slide</p>',
        plainText: 'Updated slide',
        sessionOptions: { points: 0 },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().question.content).toBe('<p>Updated slide</p>');
  });

  it('course instructors can update a slide linked to their session even when question session metadata is blank', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { course, session } = await setupCourseAndSession();

    const legacyCreator = await createTestUser({ email: 'session-linked-owner@example.com', roles: ['professor'] });
    const legacyCreatorToken = await getAuthToken(app, legacyCreator);
    const prof = await createTestUser({ email: 'linked-course-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);

    await Course.findByIdAndUpdate(course._id, {
      $addToSet: { instructors: prof._id.toString() },
    });

    const qRes = await createQuestionAsProf(legacyCreatorToken, {
      type: 6,
      content: '<p>Linked slide</p>',
      plainText: 'Linked slide',
      sessionId: '',
      courseId: '',
      sessionOptions: { points: 0 },
    });
    const question = qRes.json().question;

    const addRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/questions`, {
      token: profToken,
      payload: { questionId: question._id },
    });
    expect(addRes.statusCode).toBe(200);
    const addResQs = addRes.json().session.questions;
    const copiedQId = addResQs[addResQs.length - 1];

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${copiedQId}`, {
      token: profToken,
      payload: {
        type: 6,
        content: '<p>Updated linked slide</p>',
        plainText: 'Updated linked slide',
        sessionOptions: { points: 0 },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().question.content).toBe('<p>Updated linked slide</p>');
  });

  it('rejects switching multi-select to multiple-choice when multiple correct options exist', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const qRes = await createQuestionAsProf(profToken, {
      type: 3,
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: true },
      ],
    });
    const question = qRes.json().question;

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${question._id}`, {
      token: profToken,
      payload: { type: 0 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Multiple Choice questions can only have one correct option');
  });

  it('rejects changing the number of options when the question already has responses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();
    const qRes = await createQuestionAsProf(profToken, {
      type: 0,
      content: 'Choose one',
      sessionId: session._id,
      courseId: course._id,
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: false },
      ],
    });
    const question = qRes.json().question;

    await Response.create({
      attempt: 1,
      questionId: question._id,
      studentUserId: 'student-1',
      answer: '0',
    });

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${question._id}`, {
      token: profToken,
      payload: {
        type: 0,
        content: 'Choose one',
        options: [
          { answer: 'A', correct: true },
          { answer: 'B', correct: false },
          { answer: 'C', correct: false },
        ],
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Question options cannot be added or removed because this question has response data');
  });

  it('broadcasts a granular question update when a linked session question changes', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();
    const wsSendToUsersSpy = vi.spyOn(app, 'wsSendToUsers');

    const qRes = await createQuestionAsProf(profToken, {
      type: 6,
      content: '<p>Slide</p>',
      plainText: 'Slide',
      sessionId: '',
      courseId: '',
      sessionOptions: { points: 0 },
    });
    const question = qRes.json().question;

    const addRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/questions`, {
      token: profToken,
      payload: { questionId: question._id },
    });
    expect(addRes.statusCode).toBe(200);
    const addResQs = addRes.json().session.questions;
    const copiedQId = addResQs[addResQs.length - 1];

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${copiedQId}`, {
      token: profToken,
      payload: {
        type: 6,
        content: '<p>Updated slide</p>',
        plainText: 'Updated slide',
        sessionOptions: { points: 0 },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(wsSendToUsersSpy).toHaveBeenLastCalledWith(
      expect.arrayContaining([String(course.instructors[0])]),
      'session:question-updated',
      expect.objectContaining({
        courseId: course._id,
        sessionId: session._id,
        questionId: copiedQId,
      })
    );
  });

  it('sanitizes current-question updates for students in a live session', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();
    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    const wsSendToUsersSpy = vi.spyOn(app, 'wsSendToUsers');
    const qRes = await createQuestionAsProf(profToken, {
      type: 0,
      content: '<p>Current question</p>',
      plainText: 'Current question',
      options: [
        { answer: 'A', correct: false },
        { answer: 'B', correct: true },
      ],
      sessionOptions: {
        hidden: false,
        correct: false,
        stats: true,
        points: 1,
      },
    });
    const question = qRes.json().question;

    await Session.findByIdAndUpdate(session._id, {
      $set: {
        currentQuestion: question._id,
        status: 'running',
      },
      $addToSet: {
        questions: question._id,
      },
    });

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${question._id}`, {
      token: profToken,
      payload: {
        type: 0,
        content: '<p>Updated current question</p>',
        plainText: 'Updated current question',
        options: [
          { answer: 'A', correct: true },
          { answer: 'B', correct: false },
        ],
        sessionOptions: {
          hidden: false,
          correct: false,
          stats: true,
          points: 1,
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(wsSendToUsersSpy).toHaveBeenCalledWith(
      [String(course.instructors[0])],
      'session:question-updated',
      expect.objectContaining({
        courseId: course._id,
        sessionId: session._id,
        questionId: question._id,
        question: expect.objectContaining({
          content: '<p>Updated current question</p>',
          options: expect.arrayContaining([
            expect.objectContaining({ answer: 'A', correct: true }),
            expect.objectContaining({ answer: 'B', correct: false }),
          ]),
        }),
      })
    );
    expect(wsSendToUsersSpy).toHaveBeenCalledWith(
      [String(student._id)],
      'session:question-updated',
      expect.objectContaining({
        courseId: course._id,
        sessionId: session._id,
        questionId: question._id,
        questionHidden: false,
        showStats: true,
        showCorrect: false,
        question: expect.objectContaining({
          content: '<p>Updated current question</p>',
          options: expect.arrayContaining([
            expect.objectContaining({ answer: 'A' }),
            expect.objectContaining({ answer: 'B' }),
          ]),
        }),
      })
    );
    const studentEvent = wsSendToUsersSpy.mock.calls.find(([userIds, event]) => (
      event === 'session:question-updated' && userIds.includes(String(student._id))
    ));
    expect(studentEvent[2].question.options.every((option) => !Object.hasOwn(option, 'correct'))).toBe(true);
    expect(studentEvent[2].question).not.toHaveProperty('sessionProperties');
  });
});

// ---------- DELETE /api/v1/questions/:id ----------
describe('DELETE /api/v1/questions/:id', () => {
  it('creator can delete a question', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const qRes = await createQuestionAsProf(profToken);
    const question = qRes.json().question;

    const res = await authenticatedRequest(app, 'DELETE', `/api/v1/questions/${question._id}`, {
      token: profToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    // Verify deleted
    const deleted = await Question.findById(question._id);
    expect(deleted).toBeNull();
  });

  it('non-creator gets 403', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const qRes = await createQuestionAsProf(profToken);
    const question = qRes.json().question;

    const other = await createTestUser({ email: 'other@example.com', roles: ['professor'] });
    const otherToken = await getAuthToken(app, other);

    const res = await authenticatedRequest(app, 'DELETE', `/api/v1/questions/${question._id}`, {
      token: otherToken,
    });

    expect(res.statusCode).toBe(403);
  });

  it('deleting question removes it from session', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();

    const qRes = await createQuestionAsProf(profToken, {
      sessionId: session._id,
      courseId: course._id,
    });
    const question = qRes.json().question;

    // Add question to session
    await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/questions`, {
      token: profToken,
      payload: { questionId: question._id },
    });

    // Delete the question
    await authenticatedRequest(app, 'DELETE', `/api/v1/questions/${question._id}`, {
      token: profToken,
    });

    // Verify removed from session
    const updatedSession = await Session.findById(session._id);
    expect(updatedSession.questions).not.toContain(question._id);
  });
});

// ---------- POST /api/v1/questions/:id/copy ----------
describe('POST /api/v1/questions/:id/copy', () => {
  it('user can copy a question to personal library', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const qRes = await createQuestionAsProf(profToken, {
      content: 'Original Q',
      publicOnQlicker: true,
      publicOnQlickerForStudents: true,
      sessionId: 'session-source',
      sessionOptions: {
        points: 4,
        hidden: false,
        stats: true,
        correct: true,
        attempts: [{ number: 1, closed: false }],
      },
    });
    const question = qRes.json().question;

    const other = await createTestUser({ email: 'other@example.com', roles: ['professor'] });
    const otherToken = await getAuthToken(app, other);

    const res = await authenticatedRequest(app, 'POST', `/api/v1/questions/${question._id}/copy`, {
      token: otherToken,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.question.content).toBe('Original Q');
    expect(body.question._id).not.toBe(question._id);
    expect(body.question.creator).toBe(prof._id.toString());
    expect(body.question.owner).toBe(other._id.toString());
    expect(body.question.sessionId).toBe('');
    expect(body.question.courseId).toBe(question.courseId);
    expect(body.question.originalQuestion).toBe(question._id);
    expect(body.question.originalCourse).toBe(question.courseId);
    expect(body.question.publicOnQlicker).toBe(true);
    expect(body.question.publicOnQlickerForStudents).toBe(true);
    expect(body.question.sessionOptions).toBeUndefined();
  });

  it('student-only instructor keeps instructor copy behavior in instructor courses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'mixed-copy-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken)).json().course;
    const sourceQuestion = (await createQuestionAsProf(profToken, {
      courseId: course._id,
      content: 'Instructor source question',
      public: true,
    })).json().question;

    const mixedUser = await createTestUser({ email: 'mixed-copy-student@example.com', roles: ['student'] });
    const mixedToken = await getAuthToken(app, mixedUser);
    const addInstructorRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${course._id}/instructors`, {
      token: profToken,
      payload: { userId: mixedUser._id.toString() },
    });
    expect(addInstructorRes.statusCode).toBe(200);

    const copyRes = await authenticatedRequest(app, 'POST', `/api/v1/questions/${sourceQuestion._id}/copy`, {
      token: mixedToken,
    });

    expect(copyRes.statusCode).toBe(201);
    expect(copyRes.json().question.studentCreated).toBe(false);
    expect(copyRes.json().question.approved).toBe(true);
  });
});

// ---------- GET /api/v1/courses/:courseId/questions ----------
describe('GET /api/v1/courses/:courseId/questions', () => {
  it('lists filtered course questions with linked-session and response metadata', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();
    await Course.findByIdAndUpdate(course._id, {
      $set: {
        tags: [
          { value: 'algebra', label: 'algebra' },
          { value: 'calculus', label: 'calculus' },
        ],
      },
    });

    const olderRes = await createQuestionAsProf(profToken, {
      type: 2,
      content: 'Older algebra prompt',
      plainText: 'Older algebra prompt',
      courseId: course._id,
      tags: [{ value: 'algebra', label: 'algebra' }],
    });
    const newerRes = await createQuestionAsProf(profToken, {
      type: 0,
      content: 'Session algebra prompt',
      plainText: 'Session algebra prompt',
      courseId: course._id,
      sessionId: session._id,
      tags: [{ value: 'algebra', label: 'algebra' }],
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: false },
      ],
    });
    const hiddenRes = await createQuestionAsProf(profToken, {
      type: 2,
      content: 'Hidden calculus prompt',
      plainText: 'Hidden calculus prompt',
      courseId: course._id,
      tags: [{ value: 'calculus', label: 'calculus' }],
    });

    const olderQuestion = olderRes.json().question;
    const newerQuestion = newerRes.json().question;
    const hiddenQuestion = hiddenRes.json().question;

    await Session.findByIdAndUpdate(session._id, {
      $set: { questions: [newerQuestion._id] },
    });
    await Question.findByIdAndUpdate(olderQuestion._id, {
      $set: { createdAt: new Date('2024-01-01T00:00:00.000Z') },
    });
    await Question.findByIdAndUpdate(newerQuestion._id, {
      $set: { createdAt: new Date('2025-01-01T00:00:00.000Z') },
    });
    await Question.findByIdAndUpdate(hiddenQuestion._id, {
      $set: { approved: false },
    });
    await Response.create({
      attempt: 1,
      questionId: newerQuestion._id,
      studentUserId: 'student-1',
      answer: '0',
    });

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/questions?tags=algebra&approved=true`, {
      token: profToken,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.questions.map((question) => question._id)).toEqual([newerQuestion._id, olderQuestion._id]);
    expect(body.questions[0].hasResponses).toBe(true);
    expect(body.questions[0].responseCount).toBe(1);
    expect(body.questions[0].linkedSessions).toEqual([
      expect.objectContaining({ _id: session._id, name: session.name }),
    ]);
    expect(body.questionTypes).toEqual(expect.arrayContaining([0, 2]));
  });

  it('rejects professor question tags that are not course topics', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course } = await setupCourseAndSession();
    await Course.findByIdAndUpdate(course._id, {
      $set: {
        tags: [{ value: 'algebra', label: 'algebra' }],
      },
    });

    const res = await createQuestionAsProf(profToken, {
      type: 2,
      courseId: course._id,
      content: 'Off-topic question',
      tags: [{ value: 'calculus', label: 'calculus' }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Questions can only use the course topics');
  });

  it('student sees only visible questions via DB-level visibility query (public and session-linked)', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'batch-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken, { allowStudentQuestions: true })).json().course;

    const student = await createTestUser({ email: 'batch-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    // Create a session and mark it reviewable + done
    const sessRes = await createSessionInCourse(profToken, course._id, { name: 'Reviewable' });
    const session = sessRes.json().session;
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}`, {
      token: profToken,
      payload: { status: 'visible' },
    });

    // Create a public question (visible to student)
    const q1Res = await createQuestionAsProf(profToken, {
      type: 0,
      content: 'Public question',
      courseId: course._id,
      public: true,
      options: [{ answer: 'A', correct: true }],
    });
    expect(q1Res.statusCode).toBe(201);

    // Create a private question in a reviewable session (visible after review)
    const q2Res = await createQuestionAsProf(profToken, {
      type: 2,
      content: 'Session question',
      courseId: course._id,
      sessionId: session._id,
    });
    expect(q2Res.statusCode).toBe(201);
    const q2 = q2Res.json().question;
    await Session.findByIdAndUpdate(session._id, {
      $set: { questions: [q2._id], reviewable: true, status: 'done' },
    });

    // Create a private question NOT in any session (invisible to student)
    const q3Res = await createQuestionAsProf(profToken, {
      type: 2,
      content: 'Hidden question',
      courseId: course._id,
    });
    expect(q3Res.statusCode).toBe(201);

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/questions`, {
      token: studentToken,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Student should see the public question and the session question, but not the hidden one
    const visibleContents = body.questions.map((q) => q.content);
    expect(visibleContents).toContain('Public question');
    expect(visibleContents).toContain('Session question');
    expect(visibleContents).not.toContain('Hidden question');
    expect(body.total).toBe(2);
  });

  it('student sees own questions and publicOnQlickerForStudents questions in DB-level query', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'dbq-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken)).json().course;
    await Course.findByIdAndUpdate(course._id, { $set: { allowStudentQuestions: true } });

    const student = await createTestUser({ email: 'dbq-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);

    // Student creates a question (owned by the student → always visible)
    const ownQRes = await authenticatedRequest(app, 'POST', '/api/v1/questions', {
      token: studentToken,
      payload: { type: 2, content: 'Student owned question', courseId: course._id },
    });
    expect(ownQRes.statusCode).toBe(201);

    // Professor creates a publicOnQlicker+publicOnQlickerForStudents question
    const globalQRes = await createQuestionAsProf(profToken, {
      type: 2,
      content: 'Global student-visible question',
      courseId: course._id,
      publicOnQlicker: true,
      publicOnQlickerForStudents: true,
    });
    expect(globalQRes.statusCode).toBe(201);

    // Professor creates a publicOnQlickerForStudents question that is NOT
    // public to course members.  We force the DB to test the cross-course path.
    const crossCourseQ = globalQRes.json().question;
    await Question.create({
      type: 2,
      content: 'Cross-course student-visible question',
      courseId: course._id,
      creator: prof._id,
      owner: prof._id,
      public: false,
      publicOnQlicker: true,
      publicOnQlickerForStudents: true,
    });

    // Private question not in any session and not public → invisible
    const hiddenQRes = await createQuestionAsProf(profToken, {
      type: 2,
      content: 'Completely hidden question',
      courseId: course._id,
    });
    expect(hiddenQRes.statusCode).toBe(201);

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/questions`, {
      token: studentToken,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const visibleContents = body.questions.map((q) => q.content);
    // Student-owned, public, and publicOnQlickerForStudents questions are visible
    expect(visibleContents).toContain('Student owned question');
    expect(visibleContents).toContain('Global student-visible question');
    expect(visibleContents).toContain('Cross-course student-visible question');
    // Private, non-session questions are not visible
    expect(visibleContents).not.toContain('Completely hidden question');
    expect(body.total).toBe(3);
  });

  it('student library uses DB-level pagination with skip/limit', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'pgn-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken, { allowStudentQuestions: true })).json().course;

    const student = await createTestUser({ email: 'pgn-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    // Create 5 public questions
    for (let i = 1; i <= 5; i++) {
      const qRes = await createQuestionAsProf(profToken, {
        type: 2,
        content: `Visible question ${i}`,
        courseId: course._id,
        public: true,
      });
      expect(qRes.statusCode).toBe(201);
    }
    // Create 2 hidden questions
    for (let i = 1; i <= 2; i++) {
      const qRes = await createQuestionAsProf(profToken, {
        type: 2,
        content: `Hidden question ${i}`,
        courseId: course._id,
      });
      expect(qRes.statusCode).toBe(201);
    }

    // Page 1 (limit=2): should get 2 questions, total=5
    const p1Res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/questions?page=1&limit=2`, {
      token: studentToken,
    });
    expect(p1Res.statusCode).toBe(200);
    const p1 = p1Res.json();
    expect(p1.questions.length).toBe(2);
    expect(p1.total).toBe(5);
    expect(p1.page).toBe(1);
    expect(p1.limit).toBe(2);
    // Confirm no hidden questions leaked
    expect(p1.questions.every((q) => q.content.startsWith('Visible'))).toBe(true);

    // Page 3 (limit=2): should get 1 question (5 total, pages of 2 → last page has 1)
    const p3Res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/questions?page=3&limit=2`, {
      token: studentToken,
    });
    expect(p3Res.statusCode).toBe(200);
    const p3 = p3Res.json();
    expect(p3.questions.length).toBe(1);
    expect(p3.total).toBe(5);
    expect(p3.page).toBe(3);
  });

  it('student library strips answer fields from non-owned questions', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'strip-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken, { allowStudentQuestions: true })).json().course;

    const student = await createTestUser({ email: 'strip-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    // Create a public MC question with correct answer
    const qRes = await createQuestionAsProf(profToken, {
      type: 0,
      content: 'Public MC question',
      courseId: course._id,
      public: true,
      correctNumerical: 42,
      solution: 'The answer is A',
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: false },
      ],
    });
    expect(qRes.statusCode).toBe(201);

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/questions`, {
      token: studentToken,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.questions.length).toBe(1);
    const q = body.questions[0];
    // Correct answer flags should be stripped
    expect(q.options.every((opt) => opt.correct === undefined)).toBe(true);
    expect(q.correctNumerical).toBeUndefined();
    expect(q.solution).toBeUndefined();
  });

  it('returns autocomplete tag suggestions for a course library', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course } = await setupCourseAndSession();
    await Course.findByIdAndUpdate(course._id, {
      $set: {
        tags: [
          { value: 'algebra', label: 'Algebra' },
          { value: 'algorithms', label: 'Algorithms' },
        ],
      },
    });

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/question-tags?q=alg`, {
      token: profToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toEqual([
      { value: 'algebra', label: 'Algebra' },
      { value: 'algorithms', label: 'Algorithms' },
    ]);
  });

  it('returns only course topics to students for question tags', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'student-tags-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken)).json().course;
    await Course.findByIdAndUpdate(course._id, {
      $set: {
        allowStudentQuestions: true,
        tags: [{ value: 'algebra', label: 'Algebra' }],
      },
    });
    await createQuestionAsProf(profToken, {
      courseId: course._id,
      tags: [{ value: 'algorithms', label: 'Algorithms' }],
    });

    const student = await createTestUser({ email: 'student-tags@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);

    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/question-tags?q=alg`, {
      token: studentToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().tags).toEqual([
      { value: 'algebra', label: 'Algebra' },
    ]);
  });

  it('blocks student library access when student questions are disabled', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'blocked-library-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken)).json().course;
    const student = await createTestUser({ email: 'blocked-library-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    const questionsRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/questions`, {
      token: studentToken,
    });
    expect(questionsRes.statusCode).toBe(403);

    const tagsRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/question-tags?q=alg`, {
      token: studentToken,
    });
    expect(tagsRes.statusCode).toBe(403);
  });
});

// ---------- POST /api/v1/questions/:id/approve ----------
describe('POST /api/v1/questions/:id/approve', () => {
  it('approves an unapproved course question', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course } = await setupCourseAndSession();

    const qRes = await createQuestionAsProf(profToken, {
      courseId: course._id,
      content: 'Needs approval',
    });
    const question = qRes.json().question;
    await Question.findByIdAndUpdate(question._id, { $set: { approved: false } });

    const res = await authenticatedRequest(app, 'POST', `/api/v1/questions/${question._id}/approve`, {
      token: profToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().question.approved).toBe(true);
  });

  it('lets a professor make a student question public and take ownership', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'publicize-prof@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);
    const course = (await createCourseAsProf(profToken)).json().course;
    await Course.findByIdAndUpdate(course._id, { $set: { allowStudentQuestions: true } });
    const student = await createTestUser({ email: 'publicize-student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    const enrollRes = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrollRes.statusCode).toBe(200);

    const studentQuestionRes = await authenticatedRequest(app, 'POST', '/api/v1/questions', {
      token: studentToken,
      payload: {
        type: 2,
        courseId: course._id,
        content: 'Student draft question',
      },
    });
    expect(studentQuestionRes.statusCode).toBe(201);
    const questionId = studentQuestionRes.json().question._id;

    const publicizeRes = await authenticatedRequest(app, 'POST', `/api/v1/questions/${questionId}/make-public`, {
      token: profToken,
    });

    expect(publicizeRes.statusCode).toBe(200);
    expect(publicizeRes.json().question.public).toBe(true);
    expect(publicizeRes.json().question.approved).toBe(true);
    expect(publicizeRes.json().question.owner).toBe(prof._id.toString());

    const studentPatchRes = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${questionId}`, {
      token: studentToken,
      payload: { content: 'Student edit should fail' },
    });
    expect(studentPatchRes.statusCode).toBe(403);
  });
});

// ---------- POST /api/v1/questions/bulk-copy ----------
describe('POST /api/v1/questions/bulk-copy', () => {
  it('copies selected questions into another course session while preserving lineage metadata and resetting live session state', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const prof = await createTestUser({ email: 'bulkcopy@example.com', roles: ['professor'] });
    const profToken = await getAuthToken(app, prof);

    const sourceCourse = (await createCourseAsProf(profToken, { name: 'Source Course' })).json().course;
    const sourceSession = (await createSessionInCourse(profToken, sourceCourse._id, { name: 'Source Session' })).json().session;
    const targetCourse = (await createCourseAsProf(profToken, { name: 'Target Course' })).json().course;
    const targetSession = (await createSessionInCourse(profToken, targetCourse._id, { name: 'Target Session' })).json().session;

    const questionRes = await createQuestionAsProf(profToken, {
      type: 0,
      courseId: sourceCourse._id,
      sessionId: sourceSession._id,
        content: 'Copy me',
        plainText: 'Copy me',
        options: [
          { answer: 'Yes', correct: true },
          { answer: 'No', correct: false },
        ],
        sessionOptions: {
          points: 7,
          maxAttempts: 3,
          attemptWeights: [1, 0.5, 0.25],
          hidden: false,
          stats: true,
          correct: true,
          attempts: [
            { number: 1, closed: true },
            { number: 2, closed: false },
          ],
        },
      });
    const question = questionRes.json().question;

    const res = await authenticatedRequest(app, 'POST', '/api/v1/questions/bulk-copy', {
      token: profToken,
      payload: {
        questionIds: [question._id],
        targetCourseId: targetCourse._id,
        targetSessionId: targetSession._id,
      },
    });

    expect(res.statusCode).toBe(201);
    const copiedQuestion = res.json().questions[0];
    expect(copiedQuestion._id).not.toBe(question._id);
    expect(copiedQuestion.creator).toBe(prof._id.toString());
    expect(copiedQuestion.owner).toBe(prof._id.toString());
    expect(copiedQuestion.originalQuestion).toBe(question._id);
    expect(copiedQuestion.originalCourse).toBe(sourceCourse._id);
    expect(copiedQuestion.courseId).toBe(targetCourse._id);
    expect(copiedQuestion.sessionId).toBe(targetSession._id);
    expect(copiedQuestion.sessionOptions).toMatchObject({
      points: 7,
      maxAttempts: 3,
      attemptWeights: [1, 0.5, 0.25],
      hidden: true,
      stats: false,
      correct: false,
      attempts: [],
    });

    const updatedTargetSession = await Session.findById(targetSession._id).lean();
    expect(updatedTargetSession.questions).toContain(copiedQuestion._id);
  });
});

// ---------- POST /api/v1/questions/export + POST /api/v1/courses/:courseId/questions/import ----------
describe('question import/export endpoints', () => {
  it('exports selected questions and re-imports them into another course session', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { prof, profToken, course } = await setupCourseAndSession();
    const targetCourse = (await createCourseAsProf(profToken, { name: 'Imported Course' })).json().course;
    const targetSession = (await createSessionInCourse(profToken, targetCourse._id, { name: 'Imported Session' })).json().session;
    await Promise.all([
      Course.findByIdAndUpdate(course._id, {
        $set: { tags: [{ value: 'review', label: 'Review' }] },
      }),
      Course.findByIdAndUpdate(targetCourse._id, {
        $set: { tags: [{ value: 'review', label: 'Review' }] },
      }),
    ]);

    const qRes = await createQuestionAsProf(profToken, {
      type: 2,
      courseId: course._id,
      content: 'Exportable question',
      plainText: 'Exportable question',
      tags: [{ value: 'review', label: 'Review' }],
      solution: '<p>Worked solution</p>',
      solution_plainText: 'Worked solution',
    });
    const question = qRes.json().question;

    const exportRes = await authenticatedRequest(app, 'POST', '/api/v1/questions/export', {
      token: profToken,
      payload: { questionIds: [question._id] },
    });

    expect(exportRes.statusCode).toBe(200);
    const [exportedQuestion] = exportRes.json().questions;
    expect(exportedQuestion._id).toBeUndefined();

    const importRes = await authenticatedRequest(app, 'POST', `/api/v1/courses/${targetCourse._id}/questions/import`, {
      token: profToken,
      payload: {
        questions: [exportedQuestion],
        sessionId: targetSession._id,
      },
    });

    expect(importRes.statusCode).toBe(201);
    const importedQuestion = importRes.json().questions[0];
    expect(importedQuestion.courseId).toBe(targetCourse._id);
    expect(importedQuestion.sessionId).toBe(targetSession._id);
    expect(importedQuestion.owner).toBe(prof._id.toString());
    expect(importedQuestion.approved).toBe(true);
    expect(importedQuestion.tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'review', label: 'Review' }),
      expect.objectContaining({ value: 'imported', label: 'imported' }),
    ]));

    const importedSession = await Session.findById(targetSession._id).lean();
    expect(importedSession.questions).toContain(importedQuestion._id);
  });
});

// ---------- POST /api/v1/questions/bulk-delete ----------
describe('POST /api/v1/questions/bulk-delete', () => {
  it('blocks deleting any selected question that has responses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course } = await setupCourseAndSession();

    const removable = (await createQuestionAsProf(profToken, {
      courseId: course._id,
      content: 'Removable',
    })).json().question;
    const responseBacked = (await createQuestionAsProf(profToken, {
      type: 0,
      courseId: course._id,
      content: 'Locked',
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: false },
      ],
    })).json().question;

    await Response.create({
      attempt: 1,
      questionId: responseBacked._id,
      studentUserId: 'student-1',
      answer: '0',
    });

    const res = await authenticatedRequest(app, 'POST', '/api/v1/questions/bulk-delete', {
      token: profToken,
      payload: { questionIds: [removable._id, responseBacked._id] },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().questionIds).toEqual([responseBacked._id]);
    expect(await Question.findById(removable._id)).not.toBeNull();
  });
});

// ---------- POST /api/v1/sessions/:sessionId/questions ----------
describe('POST /api/v1/sessions/:sessionId/questions', () => {
  it('instructor can add question to session', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();
    await Course.findByIdAndUpdate(course._id, { $set: { tags: [{ value: 'vectors', label: 'Vectors' }] } });
    await Session.findByIdAndUpdate(session._id, { $set: { tags: [{ value: 'vectors', label: 'Vectors' }] } });

    const qRes = await createQuestionAsProf(profToken);
    const question = qRes.json().question;

    const res = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/questions`, {
      token: profToken,
      payload: { questionId: question._id },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session.questions).toHaveLength(1);
    const copiedQuestionId = String(body.session.questions[0]);
    expect(copiedQuestionId).not.toBe(String(question._id));

    // Verify the copiedQuestionId is returned and matches the session copy
    expect(body.copiedQuestionId).toBeTruthy();
    expect(String(body.copiedQuestionId)).toBe(copiedQuestionId);

    const copiedQuestion = await Question.findById(copiedQuestionId).lean();
    expect(copiedQuestion).toBeTruthy();
    expect(String(copiedQuestion.originalQuestion)).toBe(String(question._id));
    expect(String(copiedQuestion.sessionId)).toBe(String(session._id));
    expect(copiedQuestion.tags).toEqual([{ value: 'vectors', label: 'Vectors' }]);
  });

  it('adding the same source question twice creates distinct session copies', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, session } = await setupCourseAndSession();

    const qRes = await createQuestionAsProf(profToken);
    const question = qRes.json().question;

    await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/questions`, {
      token: profToken,
      payload: { questionId: question._id },
    });

    const res = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/questions`, {
      token: profToken,
      payload: { questionId: question._id },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session.questions).toHaveLength(2);
    const copiedQuestionIds = body.session.questions.map((questionId) => String(questionId));
    expect(new Set(copiedQuestionIds).size).toBe(2);
    expect(copiedQuestionIds).not.toContain(String(question._id));
  });

  it('keeps the session questions array authoritative when adding a question to session', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();

    const q1Res = await createQuestionAsProf(profToken, {
      type: 0,
      content: 'Q1',
      sessionId: session._id,
      courseId: course._id,
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: false },
      ],
    });
    const slideRes = await createQuestionAsProf(profToken, {
      type: 6,
      content: '<p>Slide</p>',
      plainText: 'Slide',
      sessionId: session._id,
      courseId: course._id,
      sessionOptions: { points: 0 },
    });
    const libraryRes = await createQuestionAsProf(profToken, {
      type: 2,
      content: 'Library question',
    });

    const q1 = q1Res.json().question;
    const slide = slideRes.json().question;
    const libraryQuestion = libraryRes.json().question;

    await Session.findByIdAndUpdate(session._id, {
      $set: { questions: [q1._id, slide._id] },
    });

    const res = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/questions`, {
      token: profToken,
      payload: { questionId: libraryQuestion._id },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session.questions).toHaveLength(3);
    expect(String(body.session.questions[0])).toBe(String(q1._id));
    expect(String(body.session.questions[1])).toBe(String(slide._id));
    expect(String(body.session.questions[2])).not.toBe(String(libraryQuestion._id));

    const copiedQuestion = await Question.findById(String(body.session.questions[2])).lean();
    expect(copiedQuestion).toBeTruthy();
    expect(String(copiedQuestion.originalQuestion)).toBe(String(libraryQuestion._id));
    expect(String(copiedQuestion.sessionId)).toBe(String(session._id));
    expect(body.session.activities).toBeUndefined();
  });

  it.each(['add', 'copy-to-session'])('copies a numerical question already in the quiz through %s', async (route) => {
    const { profToken, course, session } = await setupCourseAndSession();
    const created = await createQuestionAsProf(profToken, {
      type: 4, courseId: course._id, sessionId: session._id,
      correctNumerical: 42, toleranceNumerical: 0.1,
    });
    const source = created.json().question;
    await Session.findByIdAndUpdate(session._id, { $set: { questions: [source._id] } });
    const url = route === 'add' ? `/api/v1/sessions/${session._id}/questions` : `/api/v1/questions/${source._id}/copy-to-session`;
    const result = await authenticatedRequest(app, 'POST', url, {
      token: profToken, payload: route === 'add' ? { questionId: source._id } : { sessionId: session._id },
    });
    expect(result.statusCode).toBe(route === 'add' ? 200 : 201);
    const copyId = result.json().copiedQuestionId || result.json().question._id;
    expect(copyId).not.toBe(source._id);
    expect((await Session.findById(session._id)).questions).toEqual([source._id, copyId]);
    expect(await Question.findById(copyId).lean()).toMatchObject({ correctNumerical: 42, originalQuestion: source._id });
    await Question.findByIdAndUpdate(copyId, { $set: { correctNumerical: 7 } });
    expect((await Question.findById(source._id)).correctNumerical).toBe(42);
  });

  it('reuses a question already created for the target session instead of copying it again', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();

    const sourceRes = await createQuestionAsProf(profToken, {
      type: 6,
      content: '<p>Slide content</p>',
      plainText: 'Slide content',
      sessionId: session._id,
      courseId: course._id,
      sessionOptions: { points: 0 },
    });
    expect(sourceRes.statusCode).toBe(201);
    const sourceQuestion = sourceRes.json().question;

    const addRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/questions`, {
      token: profToken,
      payload: { questionId: sourceQuestion._id },
    });

    expect(addRes.statusCode).toBe(200);
    const body = addRes.json();
    expect(body.copiedQuestionId).toBe(String(sourceQuestion._id));
    expect(body.session.questions).toContain(String(sourceQuestion._id));

    const matchingQuestions = await Question.find({ originalQuestion: sourceQuestion._id }).lean();
    expect(matchingQuestions).toHaveLength(0);
  });

  it('non-instructor gets 403', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    const qRes = await createQuestionAsProf(profToken);
    const question = qRes.json().question;

    const res = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/questions`, {
      token: studentToken,
      payload: { questionId: question._id },
    });

    expect(res.statusCode).toBe(403);
  });

  it('copied question has fresh sessionOptions and no responses from the source', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();

    // Create a question that already has session data (simulating a question from a used session)
    const qRes = await createQuestionAsProf(profToken, {
      type: 0,
      content: 'Question with data',
      sessionId: session._id,
      courseId: course._id,
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: false },
      ],
    });
    const sourceQuestion = qRes.json().question;

    // Simulate the question having accumulated session data
    await Question.findByIdAndUpdate(sourceQuestion._id, {
      $set: {
        sessionOptions: {
          hidden: false,
          stats: true,
          correct: true,
          points: 5,
          maxAttempts: 3,
          attempts: [{ number: 1, closed: true }, { number: 2, closed: false }],
          attemptStats: [{ number: 1, type: 'MC', total: 10, distribution: [] }],
        },
        sessionProperties: { lastAttemptNumber: 2, lastAttemptResponseCount: 10 },
      },
    });

    // Create a response for the source question
    await Response.create({
      questionId: sourceQuestion._id,
      studentUserId: 'student-user-id',
      attempt: 1,
      answer: 0,
      correct: true,
    });

    // Create a new session and add the question to it
    const sessionRes = await createSessionInCourse(profToken, course._id, { name: 'Target Session' });
    const targetSession = sessionRes.json().session;

    const addRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${targetSession._id}/questions`, {
      token: profToken,
      payload: { questionId: sourceQuestion._id },
    });

    expect(addRes.statusCode).toBe(200);
    const body = addRes.json();
    expect(body.copiedQuestionId).toBeTruthy();
    expect(String(body.copiedQuestionId)).not.toBe(String(sourceQuestion._id));

    const copiedQuestion = await Question.findById(body.copiedQuestionId).lean();
    expect(copiedQuestion).toBeTruthy();

    // Session config should be preserved
    expect(copiedQuestion.sessionOptions.points).toBe(5);
    expect(copiedQuestion.sessionOptions.maxAttempts).toBe(3);

    // Session runtime data should be reset
    expect(copiedQuestion.sessionOptions.hidden).toBe(true);
    expect(copiedQuestion.sessionOptions.stats).toBe(false);
    expect(copiedQuestion.sessionOptions.correct).toBe(false);
    expect(copiedQuestion.sessionOptions.attempts).toEqual([]);
    expect(copiedQuestion.sessionOptions.attemptStats).toEqual([]);

    // Session properties should be absent
    expect(copiedQuestion.sessionProperties).toBeUndefined();

    // No responses should exist for the new copy
    const responseCount = await Response.countDocuments({ questionId: body.copiedQuestionId });
    expect(responseCount).toBe(0);
  });
});

// ---------- DELETE /api/v1/sessions/:sessionId/questions/:questionId ----------
describe('DELETE /api/v1/sessions/:sessionId/questions/:questionId', () => {
  it('instructor can remove question from session', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, session } = await setupCourseAndSession();

    const qRes = await createQuestionAsProf(profToken);
    const question = qRes.json().question;

    // Add question to session
    await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/questions`, {
      token: profToken,
      payload: { questionId: question._id },
    });

    // Remove it
    const res = await authenticatedRequest(
      app,
      'DELETE',
      `/api/v1/sessions/${session._id}/questions/${question._id}`,
      { token: profToken }
    );

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session.questions).not.toContain(question._id);
  });

  it('non-instructor gets 403', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    const qRes = await createQuestionAsProf(profToken);
    const question = qRes.json().question;

    const res = await authenticatedRequest(
      app,
      'DELETE',
      `/api/v1/sessions/${session._id}/questions/${question._id}`,
      { token: studentToken }
    );

    expect(res.statusCode).toBe(403);
  });
});

// ---------- PATCH /api/v1/sessions/:sessionId/questions/points ----------
describe('PATCH /api/v1/sessions/:sessionId/questions/points', () => {
  it('sets all gradable questions to zero, leaves slides at zero, and reports affected grades', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { prof, profToken, course, session } = await setupCourseAndSession();
    const questionResponses = await Promise.all([
      createQuestionAsProf(profToken, {
        type: 2,
        content: 'First question',
        courseId: course._id,
        sessionId: session._id,
        sessionOptions: { points: 1, hidden: true, maxAttempts: 2 },
      }),
      createQuestionAsProf(profToken, {
        type: 4,
        content: 'Second question',
        courseId: course._id,
        sessionId: session._id,
        sessionOptions: { points: 2 },
      }),
      createQuestionAsProf(profToken, {
        type: 6,
        content: 'Explanatory slide',
        courseId: course._id,
        sessionId: session._id,
        sessionOptions: { points: 0 },
      }),
    ]);
    const [firstQuestion, secondQuestion, slide] = questionResponses.map((response) => response.json().question);
    await Session.findByIdAndUpdate(session._id, {
      $set: { questions: [firstQuestion._id, secondQuestion._id, slide._id] },
    });
    await Grade.create({
      userId: String(prof._id),
      courseId: String(course._id),
      sessionId: String(session._id),
      marks: [{ questionId: firstQuestion._id, points: 1, outOf: 1 }],
    });

    const res = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/sessions/${session._id}/questions/points`,
      { token: profToken, payload: { points: 0 } }
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      points: 0,
      updatedCount: 2,
      gradingAffected: true,
    });
    expect(res.json().updatedQuestionIds).toEqual(expect.arrayContaining([
      firstQuestion._id,
      secondQuestion._id,
    ]));

    const [updatedFirst, updatedSecond, updatedSlide] = await Promise.all([
      Question.findById(firstQuestion._id).lean(),
      Question.findById(secondQuestion._id).lean(),
      Question.findById(slide._id).lean(),
    ]);
    expect(updatedFirst.sessionOptions).toMatchObject({ points: 0, hidden: true, maxAttempts: 2 });
    expect(updatedSecond.sessionOptions.points).toBe(0);
    expect(updatedSlide.sessionOptions.points).toBe(0);
  });
});

// ---------- PATCH /api/v1/sessions/:sessionId/questions/order ----------
describe('PATCH /api/v1/sessions/:sessionId/questions/order', () => {
  it('rejects duplicate IDs without changing the session', async () => {
    const { profToken, session } = await setupCourseAndSession();
    const result = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/questions/order`, {
      token: profToken, payload: { questions: ['same-question', 'same-question'] },
    });
    expect(result.statusCode).toBe(400);
    expect((await Session.findById(session._id)).questions).toEqual([]);
  });

  it('rejects attaching a library reference through question ordering', async () => {
    const { profToken, session } = await setupCourseAndSession();
    const source = (await createQuestionAsProf(profToken)).json().question;
    const result = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/questions/order`, {
      token: profToken, payload: { questions: [source._id] },
    });
    expect(result.statusCode).toBe(400);
    expect((await Session.findById(session._id)).questions).toEqual([]);
  });

  it('instructor can reorder questions', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, session } = await setupCourseAndSession();

    const q1Res = await createQuestionAsProf(profToken, { content: 'Q1' });
    const q2Res = await createQuestionAsProf(profToken, { content: 'Q2' });
    const q1 = q1Res.json().question;
    const q2 = q2Res.json().question;

    // Add both questions
    await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/questions`, {
      token: profToken,
      payload: { questionId: q1._id },
    });
    await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/questions`, {
      token: profToken,
      payload: { questionId: q2._id },
    });

    const { questions: copiedIds } = await Session.findById(session._id).lean();

    // Reorder the session copies, not the library sources.
    const res = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/sessions/${session._id}/questions/order`,
      {
        token: profToken,
        payload: { questions: [copiedIds[1], copiedIds[0]] },
      }
    );

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session.questions[0]).toBe(copiedIds[1]);
    expect(body.session.questions[1]).toBe(copiedIds[0]);
  });

  it('non-instructor gets 403', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();

    const student = await createTestUser({ email: 'student@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: studentToken,
      payload: { enrollmentCode: course.enrollmentCode },
    });

    const res = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/sessions/${session._id}/questions/order`,
      {
        token: studentToken,
        payload: { questions: [] },
      }
    );

    expect(res.statusCode).toBe(403);
  });
});

// ---------- POST /api/v1/questions/:id/histogram ----------
describe('POST /api/v1/questions/:id/histogram', () => {
  it('generates histogram data for a numerical question in review mode', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();

    await createQuestionInSession(profToken, {
      sessionId: session._id,
      courseId: course._id,
      type: 4,
      content: '<p>What value?</p>',
      plainText: 'What value?',
    });

    // The copied question ID is needed; get it from the session
    const sessRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}`, {
      token: profToken,
    });
    const copiedQuestionId = sessRes.json().session.questions[sessRes.json().session.questions.length - 1];

    await Response.create([
      { questionId: copiedQuestionId, studentUserId: 'user1', attempt: 1, answer: '10' },
      { questionId: copiedQuestionId, studentUserId: 'user2', attempt: 1, answer: '20' },
      { questionId: copiedQuestionId, studentUserId: 'user3', attempt: 1, answer: '30' },
    ]);

    const res = await authenticatedRequest(app, 'POST', `/api/v1/questions/${copiedQuestionId}/histogram`, {
      token: profToken,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.histogramData).toBeDefined();
    expect(Array.isArray(body.histogramData.bins)).toBe(true);
    expect(body.histogramData.bins.length).toBeGreaterThan(0);
    expect(body.histogramData.visible).toBe(true);
  });

  it('rejects histogram for non-numerical question', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, session } = await setupCourseAndSession();

    await createQuestionInSession(profToken, {
      sessionId: session._id,
      courseId: course._id,
      type: 2,
      content: '<p>SA question</p>',
      plainText: 'SA question',
    });

    const sessRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}`, {
      token: profToken,
    });
    const copiedQuestionId = sessRes.json().session.questions[sessRes.json().session.questions.length - 1];

    const res = await authenticatedRequest(app, 'POST', `/api/v1/questions/${copiedQuestionId}/histogram`, {
      token: profToken,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});
