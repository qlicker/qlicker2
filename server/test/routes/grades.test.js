import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createApp, getAuthToken, authenticatedRequest } from '../helpers.js';
import Course from '../../src/models/Course.js';
import Grade from '../../src/models/Grade.js';
import Question from '../../src/models/Question.js';
import Response from '../../src/models/Response.js';
import Session from '../../src/models/Session.js';
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

async function createUser({ email, roles = ['student'], firstname = 'Test', lastname = 'User' }) {
  return User.create({
    emails: [{ address: email.toLowerCase(), verified: true }],
    profile: {
      firstname,
      lastname,
      roles,
      courses: [],
    },
    createdAt: new Date(),
  });
}

async function createCourseAsProf(profToken, overrides = {}) {
  const payload = {
    name: 'Test Course',
    deptCode: 'CS',
    courseNumber: '610',
    section: '001',
    semester: 'Winter 2026',
    ...overrides,
  };

  const res = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
    token: profToken,
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json().course;
}

async function createSessionInCourse(profToken, courseId, overrides = {}) {
  const res = await authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/sessions`, {
    token: profToken,
    payload: {
      name: 'Test Session',
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().session;
}

async function setupCourseWithStudents({ studentCount = 2, prefix = 'grades' } = {}) {
  const prof = await createUser({
    email: `${prefix}.prof@example.com`,
    roles: ['professor'],
    firstname: 'Prof',
    lastname: 'One',
  });
  const profToken = await getAuthToken(app, prof);
  const createdCourse = await createCourseAsProf(profToken, {
    name: `${prefix}-course`,
  });

  const students = [];
  for (let i = 0; i < studentCount; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const student = await createUser({
      email: `${prefix}.student${i}@example.com`,
      roles: ['student'],
      firstname: `S${i}`,
      lastname: `Student${i}`,
    });
    students.push(student);
  }

  await Course.findByIdAndUpdate(createdCourse._id, {
    $set: {
      instructors: [prof._id],
      students: students.map((student) => student._id),
    },
  });

  const studentTokens = [];
  for (const student of students) {
    // eslint-disable-next-line no-await-in-loop
    studentTokens.push(await getAuthToken(app, student));
  }

  const course = await Course.findById(createdCourse._id).lean();
  return {
    prof,
    profToken,
    course,
    students,
    studentTokens,
  };
}

async function createMcQuestion({ creatorId, sessionId, courseId, points = 1 }) {
  return Question.create({
    type: 0,
    creator: creatorId,
    owner: creatorId,
    courseId,
    sessionId,
    plainText: 'MC question',
    content: '<p>MC question</p>',
    options: [
      { answer: 'A', plainText: 'A', correct: true },
      { answer: 'B', plainText: 'B', correct: false },
    ],
    sessionOptions: {
      points,
      maxAttempts: 1,
      attemptWeights: [1],
      attempts: [{ number: 1, closed: false }],
    },
  });
}

async function createSaQuestion({ creatorId, sessionId, courseId, points = 1 }) {
  return Question.create({
    type: 2,
    creator: creatorId,
    owner: creatorId,
    courseId,
    sessionId,
    plainText: 'SA question',
    content: '<p>Explain your reasoning</p>',
    sessionOptions: {
      points,
      maxAttempts: 1,
      attempts: [{ number: 1, closed: false }],
    },
  });
}

async function createSlideQuestion({ creatorId, sessionId, courseId, points = 0 }) {
  return Question.create({
    type: 6,
    creator: creatorId,
    owner: creatorId,
    courseId,
    sessionId,
    plainText: 'Slide item',
    content: '<p>Slide item</p>',
    sessionOptions: {
      points,
    },
  });
}

describe('Grading routes', () => {
  it('blocks recalculation and manual mark edits until the session is ended', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 1,
      prefix: 'grading-lock',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Live grading lock session' });
    const question = await createSaQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 1,
    });

    await Session.findByIdAndUpdate(session._id, {
      $set: { status: 'running', questions: [question._id] },
    });

    const grade = await Grade.create({
      userId: students[0]._id,
      courseId: course._id,
      sessionId: session._id,
      name: session.name,
      joined: true,
      marks: [
        {
          questionId: question._id,
          points: 0,
          outOf: 1,
          automatic: false,
          needsGrading: true,
          attempt: 1,
          responseId: new mongoose.Types.ObjectId().toString(),
          feedback: '',
        },
      ],
    });

    const recalcRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });
    expect(recalcRes.statusCode).toBe(409);
    expect(recalcRes.json().message).toContain('Ended');

    const markRes = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/grades/${grade._id}/marks/${question._id}`,
      {
        token: profToken,
        payload: { points: 0, feedback: 'Still blocked' },
      }
    );
    expect(markRes.statusCode).toBe(409);
    expect(markRes.json().message).toContain('Ended');
  });

  it('lets instructors load the grade review while a session is still running', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 1,
      prefix: 'grading-review-load',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Running review session' });
    const question = await createSaQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 1,
    });

    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'running',
        reviewable: true,
        questions: [question._id],
        joined: [students[0]._id],
      },
    });

    const res = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/grades`, {
      token: profToken,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().instructorView).toBe(true);
    expect(Array.isArray(res.json().grades)).toBe(true);
  });

  it('filters course grades to a requested student and includes joined and quiz completion metadata', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 2,
      prefix: 'course-student-modal',
    });

    const interactiveSession = await createSessionInCourse(profToken, course._id, {
      name: 'Interactive Session',
    });
    const quizSession = await createSessionInCourse(profToken, course._id, {
      name: 'Quiz Session',
      quiz: true,
    });

    await Session.findByIdAndUpdate(interactiveSession._id, {
      $set: {
        status: 'done',
        joined: [students[0]._id, students[1]._id],
      },
    });
    await Session.findByIdAndUpdate(quizSession._id, {
      $set: {
        status: 'done',
        quiz: true,
        joined: [students[0]._id, students[1]._id],
        submittedQuiz: [students[0]._id],
      },
    });

    await Grade.create({
      userId: students[0]._id,
      courseId: course._id,
      sessionId: interactiveSession._id,
      name: interactiveSession.name,
      joined: true,
      participation: 75,
      value: 80,
    });
    await Grade.create({
      userId: students[0]._id,
      courseId: course._id,
      sessionId: quizSession._id,
      name: quizSession.name,
      joined: true,
      participation: 0,
      value: 90,
    });

    const res = await authenticatedRequest(
      app,
      'GET',
      `/api/v1/courses/${course._id}/grades?studentId=${students[0]._id}`,
      { token: profToken }
    );

    expect(res.statusCode).toBe(200);
    const payload = res.json();
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].student.studentId).toBe(students[0]._id);
    expect(payload.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _id: interactiveSession._id,
          joinedCount: 2,
        }),
        expect.objectContaining({
          _id: quizSession._id,
          joinedCount: 2,
        }),
      ])
    );
    const interactiveGrade = payload.rows[0].grades.find((grade) => grade.sessionId === interactiveSession._id);
    const quizGrade = payload.rows[0].grades.find((grade) => grade.sessionId === quizSession._id);
    expect(interactiveGrade).toMatchObject({ joined: true, submitted: false });
    expect(quizGrade).toMatchObject({ joined: true, submitted: true });
  });

  it('backfills a missing session msScoringMethod to the default during grade recalculation', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course } = await setupCourseWithStudents({
      studentCount: 1,
      prefix: 'ms-backfill',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'MS backfill session' });
    await Session.findByIdAndUpdate(session._id, {
      $set: { status: 'done' },
      $unset: { msScoringMethod: '' },
    });

    const recalc = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });

    expect(recalc.statusCode).toBe(200);

    const persistedSession = await Session.findById(session._id).lean();
    expect(persistedSession.msScoringMethod).toBe('right-minus-wrong');
  });

  it('calculates expected marks and totals for mixed question point values and responses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 2,
      prefix: 'mixed-question-points',
    });
    const session = await createSessionInCourse(profToken, course._id, {
      name: 'Mixed question points session',
    });
    const questions = await Promise.all([
      createMcQuestion({
        creatorId: course.instructors[0],
        sessionId: session._id,
        courseId: course._id,
        points: 1,
      }),
      createMcQuestion({
        creatorId: course.instructors[0],
        sessionId: session._id,
        courseId: course._id,
        points: 2,
      }),
      createMcQuestion({
        creatorId: course.instructors[0],
        sessionId: session._id,
        courseId: course._id,
        points: 0,
      }),
    ]);

    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        reviewable: true,
        joined: students.map((student) => student._id),
        questions: questions.map((question) => question._id),
      },
    });

    const responseTime = new Date('2026-01-01T00:00:00.000Z');
    await Response.create([
      // Student 0: 1/1, 0/2, and a correct response to the zero-point question.
      { questionId: questions[0]._id, studentUserId: students[0]._id, attempt: 1, answer: 'A', createdAt: responseTime, updatedAt: responseTime },
      { questionId: questions[1]._id, studentUserId: students[0]._id, attempt: 1, answer: 'B', createdAt: responseTime, updatedAt: responseTime },
      { questionId: questions[2]._id, studentUserId: students[0]._id, attempt: 1, answer: 'A', createdAt: responseTime, updatedAt: responseTime },
      // Student 1: 0/1 and 2/2; no response is needed for the zero-point question.
      { questionId: questions[0]._id, studentUserId: students[1]._id, attempt: 1, answer: 'B', createdAt: responseTime, updatedAt: responseTime },
      { questionId: questions[1]._id, studentUserId: students[1]._id, attempt: 1, answer: 'A', createdAt: responseTime, updatedAt: responseTime },
    ]);

    const recalc = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });
    expect(recalc.statusCode).toBe(200);

    const gradesResponse = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/grades`, {
      token: profToken,
    });
    expect(gradesResponse.statusCode).toBe(200);
    const gradesByStudentId = new Map(
      gradesResponse.json().grades.map((grade) => [String(grade.userId), grade])
    );

    const firstGrade = gradesByStudentId.get(String(students[0]._id));
    expect(firstGrade).toMatchObject({
      points: 1,
      outOf: 3,
      value: 33.3,
      participation: 100,
      numAnswered: 2,
      numQuestions: 2,
      numAnsweredTotal: 3,
      numQuestionsTotal: 3,
    });
    expect(firstGrade.marks.map(({ points, outOf }) => ({ points, outOf }))).toEqual([
      { points: 1, outOf: 1 },
      { points: 0, outOf: 2 },
      { points: 0, outOf: 0 },
    ]);

    const secondGrade = gradesByStudentId.get(String(students[1]._id));
    expect(secondGrade).toMatchObject({
      points: 2,
      outOf: 3,
      value: 66.7,
      participation: 100,
      numAnswered: 2,
      numQuestions: 2,
      numAnsweredTotal: 2,
      numQuestionsTotal: 3,
    });
    expect(secondGrade.marks.map(({ points, outOf }) => ({ points, outOf }))).toEqual([
      { points: 0, outOf: 1 },
      { points: 2, outOf: 2 },
      { points: 0, outOf: 0 },
    ]);
  });

  it('counts blank short-answer responses for participation without requiring grading', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 1,
      prefix: 'blank-sa',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Blank SA session' });
    const question = await createSaQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 1,
    });

    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        reviewable: true,
        joined: [students[0]._id],
        questions: [question._id],
      },
    });

    const response = await Response.create({
      attempt: 1,
      questionId: question._id,
      studentUserId: students[0]._id,
      answer: '',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const recalc = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });

    expect(recalc.statusCode).toBe(200);
    expect(recalc.json().summary.needsGradingMarks).toBe(0);

    const grade = await Grade.findOne({
      sessionId: session._id,
      courseId: course._id,
      userId: students[0]._id,
    }).lean();

    expect(grade.participation).toBe(100);
    expect(grade.numAnswered).toBe(1);
    expect(grade.numAnsweredTotal).toBe(1);
    expect(grade.needsGrading).toBe(false);
    expect(grade.marks[0]?.responseId).toBe(String(response._id));
    expect(grade.marks[0]?.attempt).toBe(1);
    expect(grade.marks[0]?.points).toBe(0);
    expect(grade.marks[0]?.needsGrading).toBe(false);

    const sessionGrades = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/grades`, {
      token: profToken,
    });
    expect(sessionGrades.statusCode).toBe(200);
    expect(sessionGrades.json().grades[0].marks[0].needsGrading).toBe(false);
  });

  it('ignores slide items when calculating grade and participation denominators', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 1,
      prefix: 'slide-denominator',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Slide denominator session' });
    const slide = await createSlideQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 5,
    });
    const question = await createMcQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 1,
    });

    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        reviewable: true,
        joined: [students[0]._id],
        questions: [slide._id, question._id],
      },
    });

    await Response.create({
      attempt: 1,
      questionId: question._id,
      studentUserId: students[0]._id,
      answer: '0',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const recalc = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });

    expect(recalc.statusCode).toBe(200);

    const grade = await Grade.findOne({
      sessionId: session._id,
      courseId: course._id,
      userId: students[0]._id,
    }).lean();

    expect(grade.marks).toHaveLength(1);
    expect(grade.marks[0].questionId).toBe(question._id);
    expect(grade.outOf).toBe(1);
    expect(grade.numQuestions).toBe(1);
    expect(grade.numQuestionsTotal).toBe(1);
    expect(grade.participation).toBe(100);
  });

  it('ignores stale blank-response grading flags in session review and course summaries', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 1,
      prefix: 'stale-blank-sa',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Stale blank SA session' });
    const question = await createSaQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 1,
    });

    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        reviewable: true,
        joined: [students[0]._id],
        questions: [question._id],
      },
    });

    const response = await Response.create({
      attempt: 1,
      questionId: question._id,
      studentUserId: students[0]._id,
      answer: '   ',
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    });

    await Grade.create({
      courseId: course._id,
      sessionId: session._id,
      userId: students[0]._id,
      name: session.name,
      points: 0,
      outOf: 1,
      participation: 100,
      automatic: false,
      joined: true,
      needsGrading: true,
      visibleToStudents: true,
      numAnswered: 1,
      numQuestions: 1,
      numAnsweredTotal: 1,
      numQuestionsTotal: 1,
      marks: [
        {
          questionId: question._id,
          points: 0,
          outOf: 1,
          automatic: false,
          needsGrading: true,
          attempt: 1,
          responseId: String(response._id),
          feedback: '',
        },
      ],
    });

    const sessionGrades = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/grades`, {
      token: profToken,
    });
    expect(sessionGrades.statusCode).toBe(200);
    expect(sessionGrades.json().grades[0].needsGrading).toBe(false);
    expect(sessionGrades.json().grades[0].marks[0].needsGrading).toBe(false);

    const courseGrades = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/grades?sessionIds=${session._id}`, {
      token: profToken,
    });
    expect(courseGrades.statusCode).toBe(200);
    expect(courseGrades.json().sessions[0].studentsNeedingGrading).toBe(0);
    expect(courseGrades.json().sessions[0].marksNeedingGrading).toBe(0);
  });

  it('tracks feedbackUpdatedAt on marks when instructor feedback changes', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 1,
      prefix: 'feedback-updated-at',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Feedback timestamp session' });
    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
      },
    });
    const question = await createSaQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 1,
    });

    const grade = await Grade.create({
      userId: students[0]._id,
      courseId: course._id,
      sessionId: session._id,
      name: session.name,
      marks: [
        {
          questionId: question._id,
          points: 0,
          outOf: 1,
          automatic: false,
          needsGrading: false,
          feedback: '',
          feedbackUpdatedAt: null,
        },
      ],
      visibleToStudents: true,
    });

    const firstFeedback = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/grades/${grade._id}/marks/${question._id}`,
      {
        token: profToken,
        payload: { feedback: '<p>First feedback</p>' },
      }
    );
    expect(firstFeedback.statusCode).toBe(200);
    const firstMark = firstFeedback.json().grade.marks.find((mark) => mark.questionId === question._id);
    expect(firstMark.feedbackUpdatedAt).toBeDefined();
    const firstUpdatedAt = new Date(firstMark.feedbackUpdatedAt).getTime();
    expect(Number.isFinite(firstUpdatedAt)).toBe(true);

    const pointsOnly = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/grades/${grade._id}/marks/${question._id}`,
      {
        token: profToken,
        payload: { points: 0.5 },
      }
    );
    expect(pointsOnly.statusCode).toBe(200);
    const pointsOnlyMark = pointsOnly.json().grade.marks.find((mark) => mark.questionId === question._id);
    expect(pointsOnlyMark.feedbackUpdatedAt).toBe(firstMark.feedbackUpdatedAt);

    const updatedFeedback = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/grades/${grade._id}/marks/${question._id}`,
      {
        token: profToken,
        payload: { feedback: '<p>Updated feedback</p>' },
      }
    );
    expect(updatedFeedback.statusCode).toBe(200);
    const updatedMark = updatedFeedback.json().grade.marks.find((mark) => mark.questionId === question._id);
    const updatedAt = new Date(updatedMark.feedbackUpdatedAt).getTime();
    expect(Number.isFinite(updatedAt)).toBe(true);
    expect(updatedAt).toBeGreaterThanOrEqual(firstUpdatedAt);

    const clearedFeedback = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/grades/${grade._id}/marks/${question._id}`,
      {
        token: profToken,
        payload: { feedback: '' },
      }
    );
    expect(clearedFeedback.statusCode).toBe(200);
    const clearedMark = clearedFeedback.json().grade.marks.find((mark) => mark.questionId === question._id);
    expect(clearedMark.feedbackUpdatedAt).toBeNull();
  });

  it('notifies only the affected student when feedback changes', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 2,
      prefix: 'feedback-websocket',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Feedback websocket session' });
    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
      },
    });
    const question = await createSaQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 1,
    });

    const grade = await Grade.create({
      userId: students[0]._id,
      courseId: course._id,
      sessionId: session._id,
      name: session.name,
      visibleToStudents: true,
      marks: [
        {
          questionId: question._id,
          points: 0,
          outOf: 1,
          automatic: false,
          needsGrading: false,
          feedback: '',
          feedbackUpdatedAt: null,
        },
      ],
    });

    const wsSendToUserSpy = vi.spyOn(app, 'wsSendToUser');
    const res = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/grades/${grade._id}/marks/${question._id}`,
      {
        token: profToken,
        payload: { feedback: '<p>Targeted feedback</p>' },
      }
    );

    expect(res.statusCode).toBe(200);
    expect(wsSendToUserSpy).toHaveBeenCalledTimes(1);
    expect(wsSendToUserSpy).toHaveBeenCalledWith(
      String(students[0]._id),
      'session:feedback-updated',
      expect.objectContaining({
        courseId: course._id,
        sessionId: session._id,
      })
    );
  });

  it('bulk-updates selected marks without overwriting untouched points or feedback', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 2,
      prefix: 'bulk-mark-update',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Bulk grading session' });
    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        joined: students.map((student) => student._id),
      },
    });
    const question = await createSaQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 2,
    });

    const [gradeA, gradeB] = await Grade.create([
      {
        userId: students[0]._id,
        courseId: course._id,
        sessionId: session._id,
        name: session.name,
        joined: true,
        automatic: false,
        outOf: 2,
        visibleToStudents: true,
        marks: [{
          questionId: question._id,
          points: 1,
          outOf: 2,
          automatic: false,
          needsGrading: false,
          feedback: 'Keep points',
          responseId: new mongoose.Types.ObjectId().toString(),
          attempt: 1,
        }],
      },
      {
        userId: students[1]._id,
        courseId: course._id,
        sessionId: session._id,
        name: session.name,
        joined: true,
        automatic: false,
        outOf: 2,
        visibleToStudents: true,
        marks: [{
          questionId: question._id,
          points: 0,
          outOf: 2,
          automatic: false,
          needsGrading: true,
          feedback: 'Keep points',
          responseId: new mongoose.Types.ObjectId().toString(),
          attempt: 1,
        }],
      },
    ]);

    const feedbackOnly = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/grades/marks/${question._id}`, {
      token: profToken,
      payload: {
        gradeIds: [gradeA._id, gradeB._id],
        feedback: 'Shared feedback',
      },
    });

    expect(feedbackOnly.statusCode).toBe(200);
    expect(feedbackOnly.json().updatedCount).toBe(2);
    expect(feedbackOnly.json().grades.every((grade) => grade.marks[0].feedback === 'Shared feedback')).toBe(true);
    expect(feedbackOnly.json().grades.find((grade) => grade._id === gradeA._id).marks[0].points).toBe(1);
    expect(feedbackOnly.json().grades.find((grade) => grade._id === gradeB._id).marks[0].points).toBe(0);

    const pointsOnly = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/grades/marks/${question._id}`, {
      token: profToken,
      payload: {
        gradeIds: [gradeA._id, gradeB._id],
        points: 2,
      },
    });

    expect(pointsOnly.statusCode).toBe(200);
    expect(pointsOnly.json().grades.every((grade) => grade.marks[0].points === 2)).toBe(true);
    expect(pointsOnly.json().grades.every((grade) => grade.marks[0].feedback === 'Shared feedback')).toBe(true);
    expect(pointsOnly.json().grades.every((grade) => grade.value === 100)).toBe(true);
    expect(pointsOnly.json().grades.every((grade) => grade.participation === 100)).toBe(true);
  });

  it('recomputes aggregate grade and participation when a mark is edited', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 1,
      prefix: 'manual-mark-recompute',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Manual mark recompute session' });
    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
      },
    });
    const gradedQuestionId = new mongoose.Types.ObjectId().toString();
    const zeroPointQuestionId = new mongoose.Types.ObjectId().toString();

    const grade = await Grade.create({
      userId: students[0]._id,
      courseId: course._id,
      sessionId: session._id,
      name: session.name,
      joined: true,
      participation: 0,
      value: 99,
      automatic: false,
      points: 0,
      outOf: 2,
      numAnswered: 0,
      numQuestions: 0,
      numAnsweredTotal: 0,
      numQuestionsTotal: 0,
      visibleToStudents: true,
      needsGrading: true,
      marks: [
        {
          questionId: gradedQuestionId,
          points: 0,
          outOf: 2,
          automatic: false,
          needsGrading: true,
          attempt: 1,
          responseId: new mongoose.Types.ObjectId().toString(),
          feedback: '',
        },
        {
          questionId: zeroPointQuestionId,
          points: 0,
          outOf: 0,
          automatic: false,
          needsGrading: false,
          attempt: 1,
          responseId: new mongoose.Types.ObjectId().toString(),
          feedback: '',
        },
      ],
    });

    const res = await authenticatedRequest(app, 'PATCH', `/api/v1/grades/${grade._id}/marks/${gradedQuestionId}`, {
      token: profToken,
      payload: { points: 1 },
    });

    expect(res.statusCode).toBe(200);
    const updated = res.json().grade;
    expect(updated.points).toBe(1);
    expect(updated.value).toBe(50);
    expect(updated.automatic).toBe(true);
    expect(updated.participation).toBe(100);
    expect(updated.numAnswered).toBe(1);
    expect(updated.numQuestions).toBe(1);
    expect(updated.numAnsweredTotal).toBe(2);
    expect(updated.numQuestionsTotal).toBe(2);
    expect(updated.needsGrading).toBe(false);
  });

  it('recalculates grades, preserves manual overrides, and exposes grading conflicts/warnings', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 2,
      prefix: 'manual-conflicts',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Manual conflict session' });
    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        joined: [students[0]._id],
      },
    });

    const mcQuestion = await createMcQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 1,
    });
    const saQuestion = await createSaQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 1,
    });

    await Session.findByIdAndUpdate(session._id, {
      $set: { questions: [mcQuestion._id, saQuestion._id] },
    });

    const now = new Date();
    await Response.create({
      attempt: 1,
      questionId: mcQuestion._id,
      studentUserId: students[0]._id,
      answer: 'A',
      createdAt: now,
      updatedAt: now,
    });
    await Response.create({
      attempt: 1,
      questionId: saQuestion._id,
      studentUserId: students[0]._id,
      answer: 'This should be manually graded.',
      createdAt: now,
      updatedAt: now,
    });

    const recalcInitial = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });

    expect(recalcInitial.statusCode).toBe(200);
    expect(recalcInitial.json().summary.createdGradeCount).toBe(2);

    const gradesAfterInitial = await Grade.find({ sessionId: session._id, courseId: course._id }).lean();
    const studentGrade = gradesAfterInitial.find((grade) => grade.userId === students[0]._id);
    expect(studentGrade).toBeDefined();

    const setManualMark = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/grades/${studentGrade._id}/marks/${mcQuestion._id}`,
      {
        token: profToken,
        payload: {
          points: 0,
          feedback: '<p>Manual override</p>',
        },
      }
    );
    expect(setManualMark.statusCode).toBe(200);
    expect(setManualMark.json().grade.marks.find((mark) => mark.questionId === mcQuestion._id).automatic).toBe(false);

    const setManualSaMark = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/grades/${studentGrade._id}/marks/${saQuestion._id}`,
      {
        token: profToken,
        payload: {
          points: 0.5,
          feedback: '<p>Manual SA grade</p>',
        },
      }
    );
    expect(setManualSaMark.statusCode).toBe(200);
    expect(setManualSaMark.json().grade.marks.find((mark) => mark.questionId === saQuestion._id).automatic).toBe(false);

    const recalcAgain = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });

    expect(recalcAgain.statusCode).toBe(200);
    const recalcSummary = recalcAgain.json().summary;
    expect(recalcSummary.manualMarkConflicts).toHaveLength(1);
    expect(recalcSummary.manualMarkConflicts[0].questionId).toBe(mcQuestion._id);
    expect(recalcSummary.manualMarkConflicts.some((conflict) => conflict.questionId === saQuestion._id)).toBe(false);
    expect(recalcSummary.ungradableQuestionIds).toContain(saQuestion._id);
    // After manual grading, the "cannot be auto-graded" warning should NOT appear
    // because all marks have been graded (needsGrading is false for all marks)
    expect(recalcSummary.warnings.join(' ')).not.toContain('cannot be auto-graded');
    expect(recalcSummary.warnings.join(' ')).toContain('manual mark overrides differ');

    const persistedStudentGrade = await Grade.findById(studentGrade._id).lean();
    const persistedManualMark = persistedStudentGrade.marks.find((mark) => mark.questionId === mcQuestion._id);
    expect(persistedManualMark.points).toBe(0);
    expect(persistedManualMark.automatic).toBe(false);

    const restoreAutomaticMark = await authenticatedRequest(
      app,
      'POST',
      `/api/v1/grades/${studentGrade._id}/marks/${mcQuestion._id}/set-automatic`,
      { token: profToken }
    );
    expect(restoreAutomaticMark.statusCode).toBe(200);
    const restoredMark = restoreAutomaticMark.json().grade.marks.find((mark) => mark.questionId === mcQuestion._id);
    expect(restoredMark.automatic).toBe(true);
    expect(restoredMark.points).toBe(1);

    const setManualGradeValue = await authenticatedRequest(app, 'PATCH', `/api/v1/grades/${studentGrade._id}/value`, {
      token: profToken,
      payload: { value: 12.3 },
    });
    expect(setManualGradeValue.statusCode).toBe(200);
    expect(setManualGradeValue.json().grade.automatic).toBe(false);
    expect(setManualGradeValue.json().grade.value).toBe(12.3);

    const restoreAutomaticGradeValue = await authenticatedRequest(app, 'POST', `/api/v1/grades/${studentGrade._id}/value/set-automatic`, {
      token: profToken,
    });
    expect(restoreAutomaticGradeValue.statusCode).toBe(200);
    expect(restoreAutomaticGradeValue.json().grade.automatic).toBe(true);
    expect(restoreAutomaticGradeValue.json().grade.value).toBe(75);
  });

  it('zeros manual-grading marks when question points drop to zero and reopens grading when points return', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 2,
      prefix: 'zero-points-toggle',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Zero points toggle session' });
    const question = await createSaQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 1,
    });

    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        reviewable: true,
        joined: students.map((student) => student._id),
        questions: [question._id],
      },
    });

    await Response.create([
      {
        questionId: question._id,
        studentUserId: students[0]._id,
        attempt: 1,
        answer: 'First response',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        questionId: question._id,
        studentUserId: students[1]._id,
        attempt: 1,
        answer: 'Second response',
        createdAt: new Date('2026-01-01T00:01:00.000Z'),
      },
    ]);

    const initialRecalc = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });
    expect(initialRecalc.statusCode).toBe(200);

    const initialGrades = await Grade.find({ sessionId: session._id, courseId: course._id }).lean();
    expect(initialGrades).toHaveLength(2);
    expect(initialGrades.every((grade) => grade.marks[0]?.outOf === 1)).toBe(true);
    expect(initialGrades.every((grade) => grade.marks[0]?.needsGrading === true)).toBe(true);

    const manuallyGraded = initialGrades.find((grade) => String(grade.userId) === String(students[0]._id));
    const setManualMark = await authenticatedRequest(
      app,
      'PATCH',
      `/api/v1/grades/${manuallyGraded._id}/marks/${question._id}`,
      {
        token: profToken,
        payload: { points: 1, feedback: 'Looks good.' },
      }
    );
    expect(setManualMark.statusCode).toBe(200);

    await Question.findByIdAndUpdate(question._id, {
      $set: { 'sessionOptions.points': 0 },
    });

    const zeroPointRecalc = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });
    expect(zeroPointRecalc.statusCode).toBe(200);

    const zeroPointGrades = await Grade.find({ sessionId: session._id, courseId: course._id }).lean();
    expect(zeroPointGrades.every((grade) => grade.needsGrading === false)).toBe(true);
    expect(zeroPointGrades.every((grade) => grade.marks[0]?.points === 0)).toBe(true);
    expect(zeroPointGrades.every((grade) => grade.marks[0]?.outOf === 0)).toBe(true);
    expect(zeroPointGrades.every((grade) => grade.marks[0]?.needsGrading === false)).toBe(true);

    await Question.findByIdAndUpdate(question._id, {
      $set: { 'sessionOptions.points': 2 },
    });

    const restoredPointRecalc = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });
    expect(restoredPointRecalc.statusCode).toBe(200);

    const restoredGrades = await Grade.find({ sessionId: session._id, courseId: course._id }).lean();
    expect(restoredGrades.every((grade) => grade.needsGrading === true)).toBe(true);
    expect(restoredGrades.every((grade) => grade.marks[0]?.points === 0)).toBe(true);
    expect(restoredGrades.every((grade) => grade.marks[0]?.outOf === 2)).toBe(true);
    expect(restoredGrades.every((grade) => grade.marks[0]?.needsGrading === true)).toBe(true);
  });

  it('keeps recalculating existing session grade rows after students are removed from course roster', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 2,
      prefix: 'removed-roster-student',
    });

    const activeStudent = students[0];
    const removedStudent = students[1];

    const session = await createSessionInCourse(profToken, course._id, { name: 'Removed roster grading session' });
    const question = await createSaQuestion({
      creatorId: activeStudent._id,
      sessionId: session._id,
      courseId: course._id,
      points: 1,
    });

    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        reviewable: true,
        joined: [activeStudent._id, removedStudent._id],
        questions: [question._id],
      },
    });

    await Response.create([
      {
        questionId: question._id,
        studentUserId: activeStudent._id,
        attempt: 1,
        answer: 'Still enrolled response',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        questionId: question._id,
        studentUserId: removedStudent._id,
        attempt: 1,
        answer: 'Removed roster response',
        createdAt: new Date('2026-01-01T00:01:00.000Z'),
      },
    ]);

    const initialRecalc = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });
    expect(initialRecalc.statusCode).toBe(200);

    const removedStudentGradeBeforeRemoval = await Grade.findOne({
      sessionId: session._id,
      courseId: course._id,
      userId: removedStudent._id,
    }).lean();
    expect(removedStudentGradeBeforeRemoval).toBeTruthy();
    expect(removedStudentGradeBeforeRemoval.marks[0]?.outOf).toBe(1);
    expect(removedStudentGradeBeforeRemoval.marks[0]?.needsGrading).toBe(true);

    await Course.findByIdAndUpdate(course._id, {
      $set: { students: [activeStudent._id] },
    });

    await Question.findByIdAndUpdate(question._id, {
      $set: { 'sessionOptions.points': 0 },
    });

    const recalcAfterRemoval = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });
    expect(recalcAfterRemoval.statusCode).toBe(200);
    expect(recalcAfterRemoval.json().summary.updatedGradeCount).toBe(2);

    const removedStudentGradeAfterRemoval = await Grade.findOne({
      sessionId: session._id,
      courseId: course._id,
      userId: removedStudent._id,
    }).lean();
    const removedStudentMark = removedStudentGradeAfterRemoval.marks.find(
      (mark) => mark.questionId === question._id
    );
    expect(removedStudentMark.outOf).toBe(0);
    expect(removedStudentMark.points).toBe(0);
    expect(removedStudentMark.needsGrading).toBe(false);
    expect(removedStudentGradeAfterRemoval.needsGrading).toBe(false);
  });

  it('prevents duplicate grade identities and keeps the latest attempt per student', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 1,
      prefix: 'grade-identity-unique',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Grade identity unique session' });
    const question = await createSaQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 0,
    });

    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        joined: [students[0]._id],
        questions: [question._id],
      },
    });

    await Response.create([
      {
        questionId: question._id,
        studentUserId: students[0]._id,
        attempt: 1,
        answer: 'First attempt',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        questionId: question._id,
        studentUserId: students[0]._id,
        attempt: 2,
        answer: 'Latest attempt',
        createdAt: new Date('2026-01-01T00:01:00.000Z'),
        updatedAt: new Date('2026-01-01T00:02:00.000Z'),
      },
    ]);

    const initialRecalcRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });
    expect(initialRecalcRes.statusCode).toBe(200);

    await Grade.syncIndexes();

    await expect(Grade.create({
      userId: students[0]._id,
      courseId: course._id,
      sessionId: session._id,
      name: session.name,
      joined: true,
      points: 0,
      outOf: 0,
      visibleToStudents: false,
      marks: [],
    })).rejects.toMatchObject({ code: 11000 });

    const recalcRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });

    expect(recalcRes.statusCode).toBe(200);

    const persistedGrades = await Grade.find({
      sessionId: session._id,
      courseId: course._id,
      userId: students[0]._id,
    }).lean();
    expect(persistedGrades).toHaveLength(1);
    expect(persistedGrades[0].points).toBe(0);
    expect(persistedGrades[0].outOf).toBe(0);
    expect(persistedGrades[0].value).toBe(0);
    expect(persistedGrades[0].participation).toBe(100);
    expect(persistedGrades[0].numQuestions).toBe(0);
    expect(Number.isFinite(persistedGrades[0].value)).toBe(true);
    expect(Number.isFinite(persistedGrades[0].participation)).toBe(true);
    expect(persistedGrades[0].marks[0]?.outOf).toBe(0);
    expect(persistedGrades[0].marks[0]?.attempt).toBe(2);
    expect(persistedGrades[0].marks[0]?.needsGrading).toBe(false);
  });

  it('enforces student visibility restrictions for course/session grades and blocks student recalculation', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const {
      profToken,
      course,
      students,
      studentTokens,
    } = await setupCourseWithStudents({ studentCount: 2, prefix: 'visibility' });

    const reviewableSession = await createSessionInCourse(profToken, course._id, { name: 'Reviewable session' });
    const hiddenGradesSession = await createSessionInCourse(profToken, course._id, { name: 'Non-reviewable session' });

    await Session.findByIdAndUpdate(reviewableSession._id, {
      $set: {
        status: 'done',
        reviewable: true,
        joined: [students[0]._id],
      },
    });
    await Session.findByIdAndUpdate(hiddenGradesSession._id, {
      $set: {
        status: 'done',
        reviewable: false,
        joined: [students[0]._id],
      },
    });

    const reviewableQuestion = await createMcQuestion({
      creatorId: students[0]._id,
      sessionId: reviewableSession._id,
      courseId: course._id,
      points: 1,
    });
    const hiddenQuestion = await createMcQuestion({
      creatorId: students[0]._id,
      sessionId: hiddenGradesSession._id,
      courseId: course._id,
      points: 1,
    });

    await Session.findByIdAndUpdate(reviewableSession._id, {
      $set: { questions: [reviewableQuestion._id] },
    });
    await Session.findByIdAndUpdate(hiddenGradesSession._id, {
      $set: { questions: [hiddenQuestion._id] },
    });

    const now = new Date();
    await Response.create({
      attempt: 1,
      questionId: reviewableQuestion._id,
      studentUserId: students[0]._id,
      answer: 'A',
      createdAt: now,
      updatedAt: now,
    });
    await Response.create({
      attempt: 1,
      questionId: hiddenQuestion._id,
      studentUserId: students[0]._id,
      answer: 'A',
      createdAt: now,
      updatedAt: now,
    });

    const recalcReviewable = await authenticatedRequest(
      app,
      'POST',
      `/api/v1/sessions/${reviewableSession._id}/grades/recalculate`,
      { token: profToken, payload: { missingOnly: false } }
    );
    expect(recalcReviewable.statusCode).toBe(200);

    const recalcHidden = await authenticatedRequest(
      app,
      'POST',
      `/api/v1/sessions/${hiddenGradesSession._id}/grades/recalculate`,
      { token: profToken, payload: { missingOnly: false } }
    );
    expect(recalcHidden.statusCode).toBe(200);

    const studentAToken = studentTokens[0];
    const studentBToken = studentTokens[1];

    const courseGradesForStudentA = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/grades`, {
      token: studentAToken,
    });
    expect(courseGradesForStudentA.statusCode).toBe(200);
    const courseGradesPayload = courseGradesForStudentA.json();
    expect(courseGradesPayload.instructorView).toBe(false);
    expect(courseGradesPayload.sessions).toHaveLength(1);
    expect(courseGradesPayload.sessions[0]._id).toBe(reviewableSession._id);
    expect(courseGradesPayload.sessions[0].autoGradeableQuestionIds).toContain(reviewableQuestion._id);
    expect(courseGradesPayload.sessions[0].questionTypeById).toMatchObject({
      [reviewableQuestion._id]: expect.any(Number),
    });
    expect(courseGradesPayload.rows).toHaveLength(1);
    expect(courseGradesPayload.rows[0].student.studentId).toBe(students[0]._id);
    expect(courseGradesPayload.rows[0].student).toHaveProperty('profileImage');
    expect(courseGradesPayload.rows[0].student).toHaveProperty('profileThumbnail');

    const courseGradesForStudentB = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/grades`, {
      token: studentBToken,
    });
    expect(courseGradesForStudentB.statusCode).toBe(200);
    expect(courseGradesForStudentB.json().rows).toHaveLength(1);
    expect(courseGradesForStudentB.json().rows[0].student.studentId).toBe(students[1]._id);

    const sessionGradesReviewable = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${reviewableSession._id}/grades`, {
      token: studentAToken,
    });
    expect(sessionGradesReviewable.statusCode).toBe(200);
    expect(sessionGradesReviewable.json().instructorView).toBe(false);
    expect(sessionGradesReviewable.json().grades).toHaveLength(1);
    expect(sessionGradesReviewable.json().grades[0].userId).toBeUndefined();
    expect(sessionGradesReviewable.json().grades[0].marks[0].responseId).toBeUndefined();

    const sessionGradesNotReviewable = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${hiddenGradesSession._id}/grades`, {
      token: studentAToken,
    });
    expect(sessionGradesNotReviewable.statusCode).toBe(403);

    const studentRecalcAttempt = await authenticatedRequest(
      app,
      'POST',
      `/api/v1/sessions/${reviewableSession._id}/grades/recalculate`,
      {
        token: studentAToken,
        payload: { missingOnly: false },
      }
    );
    expect(studentRecalcAttempt.statusCode).toBe(403);
  });

  it('excludes low-response single-attempt questions and supports missing-only grade backfill', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 20,
      prefix: 'low-response',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Low response exclusion session' });
    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        reviewable: false,
        joined: students.map((student) => student._id),
      },
    });

    const question = await createMcQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 1,
    });

    await Session.findByIdAndUpdate(session._id, {
      $set: { questions: [question._id] },
    });

    const now = new Date();
    await Response.create({
      attempt: 1,
      questionId: question._id,
      studentUserId: students[0]._id,
      answer: 'A',
      createdAt: now,
      updatedAt: now,
    });

    const firstRecalc = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: false },
    });

    expect(firstRecalc.statusCode).toBe(200);
    const firstSummary = firstRecalc.json().summary;
    expect(firstSummary.lowResponseExcludedQuestionIds).toContain(question._id);
    expect(firstSummary.createdGradeCount).toBe(20);

    const responseStudentGrade = await Grade.findOne({
      sessionId: session._id,
      courseId: course._id,
      userId: students[0]._id,
    }).lean();
    expect(responseStudentGrade.outOf).toBe(0);
    expect(responseStudentGrade.numQuestions).toBe(0);
    expect(responseStudentGrade.participation).toBe(100);
    expect(responseStudentGrade.marks[0].outOf).toBe(0);

    await Grade.deleteOne({
      sessionId: session._id,
      courseId: course._id,
      userId: students[19]._id,
    });

    const missingOnlyRecalc = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: profToken,
      payload: { missingOnly: true },
    });

    expect(missingOnlyRecalc.statusCode).toBe(200);
    const missingSummary = missingOnlyRecalc.json().summary;
    expect(missingSummary.createdGradeCount).toBe(1);
    expect(missingSummary.skippedExistingCount).toBe(19);
  });

  it.each([
    ['POST', '/end', 'running'],
    ['PATCH', '', 'done'],
    ['PATCH', '/reviewable', 'done'],
    ['PATCH', '/reviewable', 'done', 0],
  ])('publishing via %s %s completes existing grades and preserves manual overrides (points: %s)', async (method, suffix, status, points = 2) => {
    const { prof, profToken, course, students } = await setupCourseWithStudents({ studentCount: 3 });
    const session = await createSessionInCourse(profToken, course._id);
    const question = await createMcQuestion({ creatorId: prof._id, sessionId: session._id, courseId: course._id, points });
    await Session.findByIdAndUpdate(session._id, { $set: {
      status, questions: [question._id], joined: students.map((student) => student._id),
      questionResponseCounts: { [question._id]: 3 },
    } });
    await Response.create(students.map((student) => ({
      questionId: question._id, studentUserId: student._id, attempt: 1, answer: 'A',
    })));
    // An existing row is not proof that all question marks have been calculated.
    await Grade.create({ userId: students[0]._id, courseId: course._id, sessionId: session._id, marks: [] });
    await Grade.create({
      userId: students[1]._id, courseId: course._id, sessionId: session._id,
      automatic: false, value: 73,
      marks: [{ questionId: question._id, points: 0.5, outOf: 2, automatic: false, feedback: 'Keep this mark' }],
    });

    const publish = await authenticatedRequest(app, method, `/api/v1/sessions/${session._id}${suffix}`, {
      token: profToken, payload: { reviewable: true },
    });
    expect(publish.statusCode).toBe(200);
    expect(publish.json().session.reviewable).toBe(true);
    expect(publish.json().nonAutoGradeableWarning).toBeNull();
    const grades = await Grade.find({ sessionId: session._id }).lean();
    expect(grades).toHaveLength(3);
    for (const student of [students[0], students[2]]) {
      expect(grades.find((grade) => grade.userId === student._id)).toMatchObject({
        points, value: points > 0 ? 100 : 0, visibleToStudents: true,
        marks: [expect.objectContaining({ questionId: question._id, points, automatic: true })],
      });
    }
    expect(grades.find((grade) => grade.userId === students[1]._id)).toMatchObject({
      automatic: false, value: 73, visibleToStudents: true,
      marks: [expect.objectContaining({ points: 0.5, outOf: 2, automatic: false, feedback: 'Keep this mark' })],
    });
  });

  it('seeds missing grade rows when making a session reviewable and toggles grade visibility', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 3,
      prefix: 'reviewable-toggle',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Reviewable toggle session' });
    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        reviewable: false,
      },
    });

    await Grade.create({
      userId: students[0]._id,
      courseId: course._id,
      sessionId: session._id,
      name: session.name,
      joined: false,
      participation: 0,
      value: 0,
      automatic: true,
      points: 0,
      outOf: 0,
      numAnswered: 0,
      numQuestions: 0,
      numAnsweredTotal: 0,
      numQuestionsTotal: 0,
      visibleToStudents: false,
      needsGrading: false,
      marks: [],
    });

    const makeReviewable = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}`, {
      token: profToken,
      payload: { reviewable: true },
    });

    expect(makeReviewable.statusCode).toBe(200);
    expect(makeReviewable.json().session.reviewable).toBe(true);
    expect(makeReviewable.json().grading).toBeDefined();
    expect(makeReviewable.json().grading.missingOnly).toBe(false);
    expect(makeReviewable.json().grading.createdGradeCount).toBe(2);

    const visibleGrades = await Grade.find({ sessionId: session._id, courseId: course._id }).lean();
    expect(visibleGrades).toHaveLength(3);
    expect(visibleGrades.every((grade) => grade.visibleToStudents === true)).toBe(true);

    const hideReviewable = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/reviewable`, {
      token: profToken,
      payload: { reviewable: false },
    });

    expect(hideReviewable.statusCode).toBe(200);
    const hiddenGrades = await Grade.find({ sessionId: session._id, courseId: course._id }).lean();
    expect(hiddenGrades.every((grade) => grade.visibleToStudents === false)).toBe(true);
  });

  it('makes an ended session reviewable immediately even when manual grading is required', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 2,
      prefix: 'reviewable-warning',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Reviewable warning session' });
    const question = await createSaQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 3,
    });

    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        reviewable: false,
        questions: [question._id],
      },
    });

    await Response.create({ questionId: question._id, studentUserId: students[0]._id, attempt: 1, answer: 'Needs a manual mark' });
    await Grade.create({ userId: students[0]._id, courseId: course._id, sessionId: session._id, marks: [] });

    const makeReviewableRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/reviewable`, {
      token: profToken,
      payload: { reviewable: true },
    });

    expect(makeReviewableRes.statusCode).toBe(200);
    expect(makeReviewableRes.json().session.reviewable).toBe(true);
    expect(makeReviewableRes.json().nonAutoGradeableWarning).toBeNull();

    expect(makeReviewableRes.json().grading.needsGradingMarks).toBe(1);
    expect(makeReviewableRes.json().grading.warnings).toContain('Some questions cannot be auto-graded and still need manual grading.');

    const zeroedQuestion = await Question.findById(question._id).lean();
    expect(zeroedQuestion.sessionOptions.points).toBe(3);

    const grades = await Grade.find({ sessionId: session._id, courseId: course._id }).lean();
    expect(grades).toHaveLength(2);
    expect(grades.every((grade) => grade.visibleToStudents === true)).toBe(true);
  });

  it('makes an ended session reviewable immediately even when some questions have no responses', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const { profToken, course, students } = await setupCourseWithStudents({
      studentCount: 1,
      prefix: 'reviewable-no-response',
    });

    const session = await createSessionInCourse(profToken, course._id, { name: 'Reviewable no-response session' });
    const question = await createMcQuestion({
      creatorId: students[0]._id,
      sessionId: session._id,
      courseId: course._id,
      points: 3,
    });

    await Session.findByIdAndUpdate(session._id, {
      $set: {
        status: 'done',
        reviewable: false,
        joined: [students[0]._id],
        questions: [question._id],
      },
    });

    const makeReviewableRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/reviewable`, {
      token: profToken,
      payload: { reviewable: true },
    });

    expect(makeReviewableRes.statusCode).toBe(200);
    expect(makeReviewableRes.json().session.reviewable).toBe(true);
    expect(makeReviewableRes.json().nonAutoGradeableWarning).toBeNull();

    const zeroedQuestion = await Question.findById(question._id).lean();
    expect(zeroedQuestion.sessionOptions.points).toBe(3);
  });
});

describe('Quiz grading readiness and saved-answer coverage', () => {
  it('refreshes all answers when a prematurely ended quiz returns to its schedule and closes automatically', async () => {
    const { prof, profToken, course, students } = await setupCourseWithStudents({ studentCount: 110, prefix: 'scheduled-count' });
    const session = await createSessionInCourse(profToken, course._id, { quiz: true });
    const question = await createSaQuestion({ creatorId: prof._id, sessionId: session._id, courseId: course._id, points: 5 });
    await Session.updateOne({ _id: session._id }, { $set: {
      status: 'visible', quizStart: new Date(Date.now() - 7200000), quizEnd: new Date(Date.now() - 3600000),
      questions: [question._id], submittedQuiz: students.slice(0, 30).map((student) => student._id),
    } });
    await Response.insertMany(students.slice(0, 30).map((student) => ({
      questionId: question._id, studentUserId: student._id, attempt: 1, answer: 'Early answer',
    })));
    const ended = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/end`, { token: profToken, payload: {} });
    expect(ended.statusCode).toBe(200);
    expect(await Grade.countDocuments({ sessionId: session._id, needsGrading: true })).toBe(30);
    const reopened = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}`, {
      token: profToken, payload: { status: 'visible', quizEnd: new Date(Date.now() + 3600000).toISOString() },
    });
    expect(reopened.statusCode).toBe(200);
    await Response.insertMany(students.slice(30).map((student, index) => ({
      questionId: question._id, studentUserId: student._id, attempt: 1,
      answer: index === 79 ? '   ' : 'Later answer',
    })));
    await Session.updateOne({ _id: session._id }, { $set: { quizEnd: new Date(Date.now() - 1000) } });
    const results = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/results`, { token: profToken });
    expect(results.statusCode).toBe(200);
    expect(results.json().session.status).toBe('done');
    const res = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/grades`, { token: profToken });
    expect(res.statusCode).toBe(200);
    expect(res.json().grades.filter((grade) => grade.needsGrading)).toHaveLength(109);
    // Existing installations can already have stale false flags after this sequence.
    await Grade.updateMany({ sessionId: session._id }, { $set: { needsGrading: false, 'marks.$[].needsGrading': false } });
    const repairedRead = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/grades`, { token: profToken });
    expect(repairedRead.json().grades.filter((entry) => entry.needsGrading)).toHaveLength(109);

    const grade = res.json().grades.find((entry) => entry.userId === students[0]._id);
    const save = await authenticatedRequest(app, 'PATCH', `/api/v1/grades/${grade._id}/marks/${question._id}`, {
      token: profToken, payload: { points: 0 },
    });
    expect(save.statusCode).toBe(200);
    const refreshed = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/grades`, { token: profToken });
    expect(refreshed.json().grades.filter((entry) => entry.needsGrading)).toHaveLength(108);
    expect(refreshed.json().grades.find((entry) => entry._id === grade._id).marks[0]).toMatchObject({ points: 0, automatic: false, needsGrading: false });
  });

  it('leaves missing grade items absent on read and permits explicit creation only by instructors', async () => {
    const { prof, profToken, course, students, studentTokens } = await setupCourseWithStudents({ studentCount: 1, prefix: 'missing-items' });
    const session = await createSessionInCourse(profToken, course._id);
    const question = await createSaQuestion({ creatorId: prof._id, sessionId: session._id, courseId: course._id, points: 5 });
    await Session.updateOne({ _id: session._id }, { $set: { status: 'done', questions: [question._id] } });
    const read = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/grades`, { token: profToken });
    expect(read.json()).toMatchObject({ grades: [], gradingLockReason: 'missing-grades' });
    expect(await Grade.countDocuments({ sessionId: session._id })).toBe(0);
    const denied = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, { token: studentTokens[0], payload: { missingOnly: true } });
    expect(denied.statusCode).toBe(403);
    const created = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, { token: profToken, payload: { missingOnly: true } });
    expect(created.statusCode).toBe(200);
    expect(await Grade.findOne({ sessionId: session._id, userId: students[0]._id }).lean()).toBeTruthy();
  });

  it.each(['active', 'upcoming'])('locks all grading writes during an %s extension on an ended quiz', async (window) => {
    const { profToken, course, students } = await setupCourseWithStudents({ studentCount: 1, prefix: `extension-${window}` });
    const session = await createSessionInCourse(profToken, course._id, { quiz: true });
    await Session.updateOne({ _id: session._id }, { $set: { status: 'done', quizExtensions: [{
      userId: students[0]._id, quizStart: new Date(Date.now() + (window === 'active' ? -3600000 : 3600000)), quizEnd: new Date(Date.now() + 7200000),
    }] } });
    const grade = await Grade.create({ userId: students[0]._id, courseId: course._id, sessionId: session._id, marks: [{ questionId: 'q', outOf: 5 }] });
    const requests = [
      ['POST', `/sessions/${session._id}/grades/recalculate`, { missingOnly: true }],
      ['PATCH', `/grades/${grade._id}/marks/q`, { points: 0 }],
      ['PATCH', `/sessions/${session._id}/grades/marks/q`, { gradeIds: [grade._id], points: 0 }],
      ['POST', `/grades/${grade._id}/marks/q/set-automatic`, {}],
      ['PATCH', `/grades/${grade._id}/value`, { value: 0 }],
      ['POST', `/grades/${grade._id}/value/set-automatic`, {}],
      ['POST', `/ai/courses/${course._id}/sessions/${session._id}/ai-grading`, {}],
    ];
    for (const [method, path, payload] of requests) {
      const res = await authenticatedRequest(app, method, `/api/v1${path}`, { token: profToken, payload });
      expect(res.statusCode, path).toBe(409);
    }
    const read = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/grades`, { token: profToken });
    expect(read.json().gradingLockReason).toBe('extensions');
  });
});

describe('course grade averages', () => {
  async function fixture() {
    const context = await setupCourseWithStudents({ prefix: 'average', studentCount: 2 });
    const { course, prof, students } = context;
    const makeSession = (name, overrides = {}) => Session.create({
      name, courseId: course._id, creator: prof._id, status: 'done', reviewable: true, ...overrides,
    });
    const makeGrade = (session, value, participation, overrides = {}) => Grade.create({
      courseId: course._id, sessionId: session._id, userId: students[0]._id,
      value, participation, visibleToStudents: true, ...overrides,
    });
    const first = await makeSession('First');
    const second = await makeSession('Second', { quiz: true });
    const missed = await makeSession('Missed');
    await makeGrade(first, 80, 100);
    await makeGrade(second, 40, 50);
    await makeGrade(missed, 0, 0);
    const empty = await makeSession('No grade items');
    const hiddenGrade = await makeSession('Unpublished grade');
    await makeGrade(hiddenGrade, 100, 100, { visibleToStudents: false });
    const excluded = [];
    for (const [name, overrides] of [
      ['Draft', { status: 'hidden' }], ['Upcoming', { status: 'visible' }],
      ['Live', { status: 'running' }],
      ['Anonymous', { anonymous: true }],
      ['Quiz with extension', { quiz: true, quizExtensions: [{ userId: students[1]._id, quizEnd: new Date(Date.now() + 86400000) }] }],
      ['Another student practice', { studentCreated: true, creator: students[1]._id }],
    ]) {
      const session = await makeSession(name, overrides);
      excluded.push(session);
      await makeGrade(session, 100, 100);
    }
    return { ...context, first, second, missed, empty, hiddenGrade, excluded, makeSession, makeGrade };
  }

  it('averages only visible grade items in ended sessions, including earned zeros', async () => {
    const f = await fixture();
    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${f.course._id}/grades`, { token: f.studentTokens[0] });
    expect(res.statusCode).toBe(200);
    const { sessions, rows } = res.json();
    expect(sessions.map((s) => s._id).sort()).toEqual([f.first, f.second, f.missed].map((s) => s._id).sort());
    expect(rows[0]).toMatchObject({ avgParticipation: 50, avgGrade: 40 });
    expect(rows[0].grades.find((g) => g.sessionId === f.missed._id)).toMatchObject({ hasGradeItem: true, value: 0 });
    expect(rows[0].grades.find((g) => g.sessionId === f.hiddenGrade._id)).toBeUndefined();
    expect(sessions.find((s) => s._id === f.empty._id)).toBeUndefined();
    const bypass = await authenticatedRequest(app, 'GET', `/api/v1/courses/${f.course._id}/grades?sessionIds=${f.excluded.map((s) => s._id).join(',')}`, { token: f.studentTokens[0] });
    expect(bypass.json().sessions).toEqual([]);
    expect(bypass.json().rows[0]).toMatchObject({ avgParticipation: null, avgGrade: null });
  });

  it('has no student average until grades are released, even when instructor grades exist', async () => {
    const f = await fixture();
    await Session.updateMany({ courseId: f.course._id }, { $set: { reviewable: false } });
    await Grade.updateMany({ courseId: f.course._id }, { $set: { visibleToStudents: false } });
    const student = await authenticatedRequest(app, 'GET', `/api/v1/courses/${f.course._id}/grades`, { token: f.studentTokens[0] });
    expect(student.statusCode).toBe(200);
    expect(student.json().sessions).toEqual([]);
    expect(student.json().rows).toHaveLength(1);
    expect(student.json().rows[0]).toMatchObject({
      student: { studentId: f.students[0]._id },
      avgParticipation: null, avgGrade: null, grades: [],
    });

    const selectedIds = [f.first, f.second, f.missed].map((session) => session._id).join(',');
    const instructor = await authenticatedRequest(app, 'GET', `/api/v1/courses/${f.course._id}/grades?sessionIds=${selectedIds}&studentId=${f.students[0]._id}`, { token: f.profToken });
    expect(instructor.statusCode).toBe(200);
    expect(instructor.json().rows[0]).toMatchObject({ avgParticipation: 50, avgGrade: 40 });

    const published = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${f.first._id}/reviewable`, {
      token: f.profToken, payload: { reviewable: true },
    });
    expect(published.statusCode).toBe(200);
    const releasedStudent = await authenticatedRequest(app, 'GET', `/api/v1/courses/${f.course._id}/grades`, { token: f.studentTokens[0] });
    const releasedInstructor = await authenticatedRequest(app, 'GET', `/api/v1/courses/${f.course._id}/grades?sessionIds=${f.first._id}&studentId=${f.students[0]._id}`, { token: f.profToken });
    expect(releasedStudent.json().sessions.map((session) => session._id)).toEqual([f.first._id]);
    expect(releasedStudent.json().rows[0].avgGrade).not.toBeNull();
    expect(releasedStudent.json().rows[0]).toMatchObject({
      avgParticipation: releasedInstructor.json().rows[0].avgParticipation,
      avgGrade: releasedInstructor.json().rows[0].avgGrade,
    });
  });

  it('uses only selected actual grade items for instructor averages and reports empty sessions', async () => {
    const f = await fixture();
    const ids = [f.first, f.second, f.missed, f.empty].map((s) => s._id).join(',');
    const res = await authenticatedRequest(app, 'GET', `/api/v1/courses/${f.course._id}/grades?sessionIds=${ids}`, { token: f.profToken });
    expect(res.statusCode).toBe(200);
    const { sessions, rows } = res.json();
    expect(sessions).toHaveLength(4);
    expect(sessions.find((s) => s._id === f.empty._id).hasGradeItems).toBe(false);
    expect(sessions.filter((s) => s.hasGradeItems)).toHaveLength(3);
    expect(rows.find((r) => r.student.studentId === f.students[0]._id)).toMatchObject({ avgParticipation: 50, avgGrade: 40 });
    expect(rows.find((r) => r.student.studentId === f.students[1]._id)).toMatchObject({ avgParticipation: null, avgGrade: null });
    const one = await authenticatedRequest(app, 'GET', `/api/v1/courses/${f.course._id}/grades?sessionIds=${f.first._id}`, { token: f.profToken });
    expect(one.json().rows[0]).toMatchObject({ avgParticipation: 100, avgGrade: 80 });
    const hidden = await authenticatedRequest(app, 'GET', `/api/v1/courses/${f.course._id}/grades?sessionIds=${f.hiddenGrade._id}`, { token: f.profToken });
    expect(hidden.json().rows[0]).toMatchObject({ avgParticipation: 100, avgGrade: 100 });
    expect(hidden.json().sessions[0].hasGradeItems).toBe(true);
  });
});

describe('independent grade visibility', () => {
  async function fixture(overrides = {}) {
    const f = await setupCourseWithStudents({ prefix: 'grade-release', studentCount: 2 });
    const session = await Session.create({
      courseId: f.course._id, creator: f.prof._id, name: 'Grade-only release',
      status: 'done', reviewable: false, ...overrides,
    });
    const question = await createMcQuestion({ courseId: f.course._id, sessionId: session._id, creatorId: f.prof._id });
    await Session.updateOne({ _id: session._id }, { $set: { questions: [question._id] } });
    const grade = await Grade.create({
      courseId: f.course._id, sessionId: session._id, userId: f.students[0]._id,
      automatic: false, value: 73, participation: 100, points: 1, outOf: 2,
      marks: [{ questionId: question._id, points: 1, outOf: 2, automatic: false, feedback: 'Private review feedback' }],
    });
    const toggle = (visibleToStudents, token = f.profToken) => authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/grades/visibility`, {
      token, payload: { visibleToStudents },
    });
    const table = (token = f.studentTokens[0]) => authenticatedRequest(app, 'GET', `/api/v1/courses/${f.course._id}/grades`, { token });
    return { ...f, session, grade, question, toggle, table };
  }

  it('publishes summary grades without review access or question details, preserves scores, and seeds missing rows', async () => {
    const f = await fixture();
    expect((await f.table()).json().sessions).toEqual([]);
    const release = await f.toggle(true);
    expect(release.statusCode).toBe(200);
    expect(release.json().session).toMatchObject({ reviewable: false, gradesVisible: true });
    const saved = await Grade.findById(f.grade._id).lean();
    expect(saved).toMatchObject({ value: 73, automatic: false, visibleToStudents: true });
    expect(saved.marks[0].feedback).toBe('Private review feedback');
    expect(await Grade.countDocuments({ sessionId: f.session._id, visibleToStudents: true })).toBe(2);
    const table = (await f.table()).json();
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ avgGrade: 73, avgParticipation: 100 });
    expect(table.rows[0].grades[0]).not.toHaveProperty('marks');
    expect(table.sessions[0]).toMatchObject({ _id: f.session._id, reviewable: false });
    expect(table.sessions[0]).not.toHaveProperty('questionTypeById');
    expect(JSON.stringify(table)).not.toContain('Private review feedback');
    for (const path of ['review', 'results', 'grades']) {
      const read = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${f.session._id}/${path}`, { token: f.studentTokens[0] });
      expect(read.statusCode, path).toBe(403);
    }
    const other = await authenticatedRequest(app, 'GET', `/api/v1/courses/${f.course._id}/grades?studentId=${f.students[1]._id}`, { token: f.studentTokens[0] });
    expect(other.statusCode).toBe(403);
    expect((await f.toggle(false)).statusCode).toBe(200);
    expect((await f.table()).json().sessions).toEqual([]);
    expect((await Session.findById(f.session._id)).reviewable).toBe(false);
  });

  it.each(['reviewable', 'patch', 'end'])('synchronizes both visibility flags through %s and requires explicit grade-only release afterward', async (path) => {
    const f = await fixture();
    const publish = (reviewable) => authenticatedRequest(app, path === 'end' ? 'POST' : 'PATCH',
      `/api/v1/sessions/${f.session._id}${path === 'patch' ? '' : `/${path}`}`, {
        token: f.profToken, payload: { reviewable, acknowledgeNonAutoGradeable: true },
      });
    expect((await publish(true)).statusCode).toBe(200);
    expect(await Session.findById(f.session._id).lean()).toMatchObject({ reviewable: true, gradesVisible: true });
    expect((await f.toggle(false)).statusCode).toBe(409);
    expect((await publish(false)).statusCode).toBe(200);
    expect(await Session.findById(f.session._id).lean()).toMatchObject({ reviewable: false, gradesVisible: false });
    expect(await Grade.countDocuments({ sessionId: f.session._id, visibleToStudents: true })).toBe(0);
    expect((await f.table()).json().sessions).toEqual([]);
    expect((await f.toggle(true)).statusCode).toBe(200);
    expect((await f.table()).json().sessions).toHaveLength(1);
  });

  it('preserves grade-only release on recalculation and enrollment, and includes it with reviewable grades in averages', async () => {
    const f = await fixture();
    await f.toggle(true);
    const recalc = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${f.session._id}/grades/recalculate`, { token: f.profToken, payload: {} });
    expect(recalc.statusCode).toBe(200);
    expect((await Grade.findById(f.grade._id)).visibleToStudents).toBe(true);
    const newcomer = await createUser({ email: 'new-grade-release@example.com' });
    const token = await getAuthToken(app, newcomer);
    const enrollment = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', { token, payload: { enrollmentCode: f.course.enrollmentCode } });
    expect(enrollment.statusCode).toBe(200);
    expect(await Grade.findOne({ sessionId: f.session._id, userId: newcomer._id }).lean()).toMatchObject({ visibleToStudents: true });
    const other = await Session.create({ courseId: f.course._id, creator: f.prof._id, name: 'Reviewable grade', status: 'done', reviewable: true });
    await Grade.create({ courseId: f.course._id, sessionId: other._id, userId: f.students[0]._id, value: 27, participation: 0, visibleToStudents: true });
    const before = (await f.table()).json().rows[0];
    const ownGrade = await Grade.findById(f.grade._id).lean();
    expect(before.avgGrade).toBe(50);
    expect(before.avgParticipation).toBe(Math.round(ownGrade.participation / 2 * 10) / 10);
  });

  it.each(['start', 'patch', 'extensions'])('revokes independent grade release when reopening through %s', async (path) => {
    const f = await fixture(path === 'extensions' ? { quiz: true } : {});
    await f.toggle(true);
    const response = await authenticatedRequest(app, path === 'start' ? 'POST' : 'PATCH',
      `/api/v1/sessions/${f.session._id}${path === 'patch' ? '' : `/${path}`}`, {
        token: f.profToken, payload: path === 'extensions'
          ? { extensions: [{ userId: f.students[0]._id, quizStart: new Date(Date.now() - 60000).toISOString(), quizEnd: new Date(Date.now() + 3600000).toISOString() }] }
          : path === 'patch' ? { status: 'running' } : {},
      });
    expect(response.statusCode).toBe(200);
    expect(await Session.findById(f.session._id).lean()).toMatchObject({ reviewable: false, gradesVisible: false });
    expect(await Grade.countDocuments({ sessionId: f.session._id, visibleToStudents: true })).toBe(0);
  });

  it.each([
    { anonymous: true }, { studentCreated: true }, { status: 'running' }, { status: 'hidden' },
    { quiz: true, quizExtensions: [{ userId: 'extension-student', quizEnd: new Date(Date.now() + 3600000) }] },
  ])('rejects publication for ineligible sessions: %j', async (overrides) => {
    const f = await fixture(overrides);
    expect((await f.toggle(true)).statusCode).toBe(409);
    expect((await Grade.findById(f.grade._id)).visibleToStudents).toBe(false);
  });

  it('requires course instructor permission and validates the visibility payload', async () => {
    const f = await fixture();
    expect((await f.toggle(true, f.studentTokens[0])).statusCode).toBe(403);
    const outsider = await createUser({ email: 'other-instructor@example.com', roles: ['professor'] });
    expect((await f.toggle(true, await getAuthToken(app, outsider))).statusCode).toBe(403);
    const invalid = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${f.session._id}/grades/visibility`, { token: f.profToken, payload: {} });
    expect(invalid.statusCode).toBe(400);
  });
});
