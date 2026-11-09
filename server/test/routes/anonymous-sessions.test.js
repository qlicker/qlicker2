import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createApp, createTestUser, getAuthToken, authenticatedRequest } from '../helpers.js';
import Grade from '../../src/models/Grade.js';
import Question from '../../src/models/Question.js';
import Response from '../../src/models/Response.js';
import Session from '../../src/models/Session.js';
import {
  getAnonymousParticipantId,
  isAnonymousParticipantId,
} from '../../src/utils/anonymousSession.js';

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

async function setupCourse({ studentCount = 2 } = {}) {
  const prof = await createTestUser({ email: 'anon-prof@example.com', roles: ['professor'] });
  const profToken = await getAuthToken(app, prof);
  const courseRes = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
    token: profToken,
    payload: {
      name: 'Anonymous Course',
      deptCode: 'PSY',
      courseNumber: '200',
      section: '001',
      semester: 'Fall 2026',
    },
  });
  expect(courseRes.statusCode).toBe(201);
  const course = courseRes.json().course;

  const students = [];
  for (let index = 0; index < studentCount; index += 1) {
    const student = await createTestUser({
      email: `anon-student-${index}@example.com`,
      firstname: `Firstname${index}`,
      lastname: `Lastname${index}`,
      roles: ['student'],
    });
    const token = await getAuthToken(app, student);
    await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token,
      payload: { enrollmentCode: course.enrollmentCode },
    });
    students.push({ user: student, token });
  }

  return { prof, profToken, course, students };
}

async function createSession(profToken, courseId, payload = {}) {
  return authenticatedRequest(app, 'POST', `/api/v1/courses/${courseId}/sessions`, {
    token: profToken,
    payload: { name: 'Anonymous Survey', ...payload },
  });
}

async function addMcQuestion(profToken, sessionId, courseId, content = 'How are you?') {
  const qRes = await authenticatedRequest(app, 'POST', '/api/v1/questions', {
    token: profToken,
    payload: {
      type: 0,
      content: `<p>${content}</p>`,
      plainText: content,
      sessionId,
      courseId,
      options: [
        { content: 'Good', correct: true },
        { content: 'Bad', correct: false },
      ],
    },
  });
  expect(qRes.statusCode).toBe(201);
  const addRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/questions`, {
    token: profToken,
    payload: { questionId: qRes.json().question._id },
  });
  expect(addRes.statusCode).toBe(200);
  const questionIds = addRes.json().session.questions;
  return questionIds[questionIds.length - 1];
}

async function startLiveQuestion(profToken, sessionId) {
  await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/start`, { token: profToken });
  const visibilityRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/question-visibility`, {
    token: profToken,
    payload: { hidden: false, stats: false, correct: false },
  });
  expect(visibilityRes.statusCode).toBe(200);
}

function expectNoIdentity(payload, students) {
  const serialized = JSON.stringify(payload);
  students.forEach(({ user }) => {
    expect(serialized).not.toContain(String(user._id));
    expect(serialized).not.toContain(user.profile.firstname);
    expect(serialized).not.toContain(user.profile.lastname);
    expect(serialized).not.toContain(user.emails[0].address);
  });
}

describe('anonymous participant ids', () => {
  it('are stable per session, distinct across sessions, and not the user id', () => {
    const first = getAnonymousParticipantId('session-a', 'user-1');
    expect(first).toBe(getAnonymousParticipantId('session-a', 'user-1'));
    expect(first).not.toBe(getAnonymousParticipantId('session-b', 'user-1'));
    expect(first).not.toBe(getAnonymousParticipantId('session-a', 'user-2'));
    expect(first).not.toContain('user-1');
    expect(isAnonymousParticipantId(first)).toBe(true);
  });
});

describe('anonymous session settings', () => {
  it('creates anonymous sessions and rejects anonymous practice sessions', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course } = await setupCourse({ studentCount: 0 });

    const res = await createSession(profToken, course._id, { anonymous: true });
    expect(res.statusCode).toBe(201);
    expect(res.json().session.anonymous).toBe(true);

    const practiceRes = await createSession(profToken, course._id, {
      anonymous: true,
      quiz: true,
      practiceQuiz: true,
    });
    expect(practiceRes.statusCode).toBe(400);

    const toPracticeRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${res.json().session._id}`, {
      token: profToken,
      payload: { quiz: true, practiceQuiz: true },
    });
    expect(toPracticeRes.statusCode).toBe(400);
  });

  it('locks anonymity once a student has joined and clears stale grades when enabled', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, students } = await setupCourse({ studentCount: 1 });
    const sessionId = (await createSession(profToken, course._id)).json().session._id;
    await Grade.create({ userId: String(students[0].user._id), courseId: course._id, sessionId });

    const enableRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken,
      payload: { anonymous: true },
    });
    expect(enableRes.statusCode).toBe(200);
    expect(enableRes.json().session.anonymous).toBe(true);
    expect(await Grade.countDocuments({ sessionId })).toBe(0);

    await addMcQuestion(profToken, sessionId, course._id);
    await startLiveQuestion(profToken, sessionId);
    await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join`, {
      token: students[0].token,
      payload: {},
    });

    const disableRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken,
      payload: { anonymous: false },
    });
    expect(disableRes.statusCode).toBe(409);
    expect((await Session.findById(sessionId).lean()).anonymous).toBe(true);
  });

  it('keeps practice, extensions, and session type consistent with anonymity', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, students } = await setupCourse({ studentCount: 1 });
    const now = Date.now();
    const sessionId = (await createSession(profToken, course._id, {
      quiz: true,
      quizStart: new Date(now - 60_000).toISOString(),
      quizEnd: new Date(now + 3_600_000).toISOString(),
    })).json().session._id;
    const extension = {
      userId: String(students[0].user._id),
      quizStart: new Date(now - 60_000).toISOString(),
      quizEnd: new Date(now + 7_200_000).toISOString(),
    };
    const addExtension = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/extensions`, {
      token: profToken, payload: { extensions: [extension] },
    });
    expect(addExtension.statusCode).toBe(200);
    const blockedEnable = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken, payload: { anonymous: true },
    });
    expect(blockedEnable.statusCode).toBe(400);
    expect((await Session.findById(sessionId).lean()).anonymous).toBe(false);

    const clearExtensions = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/extensions`, {
      token: profToken, payload: { extensions: [] },
    });
    expect(clearExtensions.statusCode).toBe(200);
    const enable = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken, payload: { anonymous: true },
    });
    expect(enable.statusCode).toBe(200);
    const blockedExtension = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/extensions`, {
      token: profToken, payload: { extensions: [extension] },
    });
    expect(blockedExtension.statusCode).toBe(400);
    const blockedPractice = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken, payload: { practiceQuiz: true },
    });
    expect(blockedPractice.statusCode).toBe(400);
    const switchToInteractive = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken, payload: { quiz: false },
    });
    expect(switchToInteractive.statusCode).toBe(200);
    expect(switchToInteractive.json().session.anonymous).toBe(true);
    expect(switchToInteractive.json().session.quiz).toBe(false);

    await addMcQuestion(profToken, sessionId, course._id);
    await startLiveQuestion(profToken, sessionId);
    const joined = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join`, {
      token: students[0].token, payload: {},
    });
    expect(joined.statusCode).toBe(200);
    const blockedMode = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken, payload: { quiz: true },
    });
    expect(blockedMode.statusCode).toBe(409);
    const blockedDisable = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken, payload: { anonymous: false },
    });
    expect(blockedDisable.statusCode).toBe(409);
  });

  it('rejects an anonymity change racing with the first join', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, students } = await setupCourse({ studentCount: 1 });
    const sessionId = (await createSession(profToken, course._id)).json().session._id;
    await addMcQuestion(profToken, sessionId, course._id);
    await startLiveQuestion(profToken, sessionId);

    const realExists = Response.exists.bind(Response);
    let releaseCheck;
    let enteredCheck;
    const checkStarted = new Promise((resolve) => { enteredCheck = resolve; });
    const checkReleased = new Promise((resolve) => { releaseCheck = resolve; });
    const existsSpy = vi.spyOn(Response, 'exists').mockImplementation(async (...args) => {
      enteredCheck();
      await checkReleased;
      return realExists(...args);
    });
    try {
      const togglePromise = authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
        token: profToken, payload: { anonymous: true },
      });
      await checkStarted;
      const join = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join`, {
        token: students[0].token, payload: {},
      });
      expect(join.statusCode).toBe(200);
      releaseCheck();
      const toggle = await togglePromise;
      expect(toggle.statusCode).toBe(409);
      const stored = await Session.findById(sessionId).lean();
      expect(stored.anonymous).toBe(false);
      expect(stored.participationStarted).toBe(true);
      expect(stored.joined).toContain(String(students[0].user._id));
    } finally {
      releaseCheck();
      existsSpy.mockRestore();
    }
  });

  it('locks anonymity when a quiz answer is saved without opening the quiz first', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, students } = await setupCourse({ studentCount: 1 });
    const now = Date.now();
    const sessionId = (await createSession(profToken, course._id, {
      quiz: true,
      quizStart: new Date(now - 60_000).toISOString(),
      quizEnd: new Date(now + 3_600_000).toISOString(),
    })).json().session._id;
    const questionId = await addMcQuestion(profToken, sessionId, course._id);
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken, payload: { status: 'visible' },
    });
    const save = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/quiz-response`, {
      token: students[0].token, payload: { questionId, answer: '0' },
    });
    expect(save.statusCode).toBe(200);
    const stored = await Session.findById(sessionId).lean();
    expect(stored.joined).toEqual([]);
    expect(stored.participationStarted).toBe(true);
    const toggle = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken, payload: { anonymous: true },
    });
    expect(toggle.statusCode).toBe(409);
  });

  it('copies the anonymous setting with the session', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course } = await setupCourse({ studentCount: 0 });
    const sessionId = (await createSession(profToken, course._id, { anonymous: true })).json().session._id;

    const copyRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/copy`, {
      token: profToken,
      payload: {},
    });
    expect(copyRes.statusCode).toBeLessThan(300);
    const copies = await Session.find({ courseId: course._id, _id: { $ne: sessionId } }).lean();
    expect(copies).toHaveLength(1);
    expect(copies[0].anonymous).toBe(true);
  });
});

describe('anonymous interactive sessions', () => {
  it('stores pseudonymous responses, allows one answer, and hides identities from instructors', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, students } = await setupCourse({ studentCount: 2 });
    const sessionId = (await createSession(profToken, course._id, { anonymous: true })).json().session._id;
    const questionId = await addMcQuestion(profToken, sessionId, course._id);
    await startLiveQuestion(profToken, sessionId);

    for (const [index, { token }] of students.entries()) {
      const joinRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join`, {
        token,
        payload: {},
      });
      expect(joinRes.statusCode).toBe(200);
      const respondRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/respond`, {
        token,
        payload: { answer: String(index % 2) },
      });
      expect(respondRes.statusCode).toBe(201);
    }

    const duplicateRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/respond`, {
      token: students[0].token,
      payload: { answer: '1' },
    });
    expect(duplicateRes.statusCode).toBe(409);

    const storedSession = await Session.findById(sessionId).lean();
    const storedResponses = await Response.find({ questionId }).lean();
    const realIds = students.map(({ user }) => String(user._id));
    expect(storedResponses).toHaveLength(2);
    storedResponses.forEach((response) => {
      expect(isAnonymousParticipantId(response.studentUserId)).toBe(true);
      expect(realIds).not.toContain(response.studentUserId);
      expect(response.submittedIpAddress).toBe('');
    });
    expect(storedSession.joined).toHaveLength(2);
    storedSession.joined.forEach((id) => expect(realIds).not.toContain(id));
    expect(storedSession.joinRecords).toHaveLength(0);
    const cachedQuestion = await Question.findById(questionId).lean();
    expect((cachedQuestion.sessionOptions?.attemptStats || []).flatMap((entry) => entry.answers || [])).toEqual([]);

    const studentLiveRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/live`, {
      token: students[0].token,
    });
    expect(studentLiveRes.json().isJoined).toBe(true);
    expect(studentLiveRes.json().session.anonymous).toBe(true);
    expect(studentLiveRes.json().studentResponse).toEqual(expect.objectContaining({ answer: '0' }));

    const instructorLiveRes = await authenticatedRequest(
      app,
      'GET',
      `/api/v1/sessions/${sessionId}/live?includeStudentNames=true&includeJoinedStudents=true`,
      { token: profToken }
    );
    expect(instructorLiveRes.statusCode).toBe(200);
    expect(instructorLiveRes.json().session.joinedCount).toBe(2);
    expect(instructorLiveRes.json().session.joined).toBeUndefined();
    expect(instructorLiveRes.json().session.joinedStudents).toBeUndefined();
    expect(instructorLiveRes.json().responseCount).toBe(2);
    expect(instructorLiveRes.json().allResponses).toEqual([]);
    expect(instructorLiveRes.json().responseStats).toBeNull();
    expectNoIdentity(instructorLiveRes.json(), students);

    const admitRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join/${realIds[0]}`, {
      token: profToken,
    });
    expect(admitRes.statusCode).toBe(400);

    const earlyResults = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, {
      token: profToken,
    });
    expect(earlyResults.statusCode).toBe(409);

    const endRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/end`, {
      token: profToken,
      payload: { reviewable: true },
    });
    expect(endRes.statusCode).toBe(200);
    expect(endRes.json().nonAutoGradeableWarning).toBeNull();
    expect(await Grade.countDocuments({ sessionId })).toBe(0);

    const resultsRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, {
      token: profToken,
    });
    expect(resultsRes.statusCode).toBe(200);
    const results = resultsRes.json();
    expect(results.session.anonymous).toBe(true);
    expect(results.anonymousSummary).toEqual({
      respondentCount: 2, joinedCount: 2, enrolledCount: 2,
      responsesWithheld: true, minimumRespondents: 4,
    });
    expect(results.studentResults).toEqual([]);
    expectNoIdentity(results, students);
    expect(JSON.stringify(results)).not.toContain('anon_');

    const gradesRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/grades`, {
      token: profToken,
    });
    expect(gradesRes.json()).toEqual(expect.objectContaining({ anonymous: true, grades: [] }));

    const recalcRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/grades/recalculate`, {
      token: profToken,
      payload: {},
    });
    expect(recalcRes.statusCode).toBe(409);

    const gradebookRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/grades`, {
      token: profToken,
    });
    expect(gradebookRes.statusCode).toBe(200);
    expect(JSON.stringify(gradebookRes.json())).not.toContain(sessionId);

    const studentReviewRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/review`, {
      token: students[1].token,
    });
    expect(studentReviewRes.statusCode).toBe(200);
    expect(studentReviewRes.json().session.anonymous).toBe(true);
    expect(studentReviewRes.json().grade).toBeNull();
    expect(studentReviewRes.json().responses[questionId]).toEqual([
      expect.objectContaining({ answer: '1' }),
    ]);

    const sessionRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}`, {
      token: profToken,
    });
    expect(sessionRes.json().session.joinedCount).toBe(2);
    expect(sessionRes.json().session.joined).toBeUndefined();
    expect(sessionRes.json().session.joinRecords).toBeUndefined();
  });

  it('keeps each respondent together across survey questions after ending', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, students } = await setupCourse({ studentCount: 4 });
    const sessionId = (await createSession(profToken, course._id, { anonymous: true })).json().session._id;
    const firstQuestionId = await addMcQuestion(profToken, sessionId, course._id, 'First question');
    const secondQuestionId = await addMcQuestion(profToken, sessionId, course._id, 'Second question');
    await startLiveQuestion(profToken, sessionId);
    for (const { token } of students) {
      const join = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join`, { token, payload: {} });
      expect(join.statusCode).toBe(200);
    }
    for (const [index, { token }] of students.entries()) {
      const response = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/respond`, {
        token, payload: { answer: String(index) },
      });
      expect(response.statusCode).toBe(201);
    }
    const move = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/current`, {
      token: profToken, payload: { questionId: secondQuestionId },
    });
    expect(move.statusCode).toBe(200);
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/question-visibility`, {
      token: profToken, payload: { hidden: false },
    });
    for (const [index, { token }] of students.entries()) {
      const response = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/respond`, {
        token, payload: { answer: String(1 - index) },
      });
      expect(response.statusCode).toBe(201);
    }
    const early = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, { token: profToken });
    expect(early.statusCode).toBe(409);
    // A sparse second attempt must not suppress eligible first attempts.
    await Response.create({
      questionId: firstQuestionId,
      studentUserId: getAnonymousParticipantId(sessionId, students[0].user._id),
      attempt: 2,
      answer: 'follow-up',
    });
    await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/end`, { token: profToken, payload: {} });
    const withheld = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, { token: profToken });
    const partial = withheld.json();
    expect(partial.studentResults).toHaveLength(4);
    expect(partial.anonymousSummary.responsesWithheld).toBe(true);
    expect(partial.questions[0].anonymousResponseAttempts).toEqual([
      { attempt: 1, respondentCount: 4, responsesWithheld: false, minimumRespondents: 4 },
      { attempt: 2, respondentCount: 1, responsesWithheld: true, minimumRespondents: 4 },
    ]);
    for (const row of partial.studentResults) {
      expect(row.participation).toBeNull();
      expect(row.questionResults.map((entry) => entry.responses.length)).toEqual([1, 1]);
    }
    expect(JSON.stringify(partial)).not.toContain('follow-up');
    expectNoIdentity(partial, students);
    await Response.insertMany(students.slice(1).map(({ user }) => ({
      questionId: firstQuestionId,
      studentUserId: getAnonymousParticipantId(sessionId, user._id),
      attempt: 2,
      answer: 'follow-up',
    })));
    const result = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, { token: profToken });
    expect(result.statusCode).toBe(200);
    const rows = result.json().studentResults;
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.questionResults.map((question) => question.responses[0]?.answer)).sort()).toEqual([
      ['0', '1'], ['1', '0'], ['2', '-1'], ['3', '-2'],
    ]);
    expect(rows.map((row) => row.studentId).sort()).toEqual([
      'respondent-1', 'respondent-2', 'respondent-3', 'respondent-4',
    ]);
    rows.forEach((row) => row.questionResults.forEach((question) => {
      expect(question.responses[0].studentUserId).toBe(row.studentId);
      expect(question.responses[0]).not.toHaveProperty('createdAt');
      expect(question.responses[0]).not.toHaveProperty('submittedIpAddress');
    }));
    expect(rows[0].questionResults.map((question) => question.questionId)).toEqual([firstQuestionId, secondQuestionId]);
    expectNoIdentity(result.json(), students);
  });

  it.each([false, true])('releases each ended question independently (quiz=%s) and counts sparse respondents without identifying them', async (quiz, ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, students } = await setupCourse({ studentCount: 5 });
    const sessionId = (await createSession(profToken, course._id, { anonymous: true, quiz })).json().session._id;
    const ids = [];
    for (const label of ['Released', 'Sparse', 'Unanswered']) {
      ids.push(await addMcQuestion(profToken, sessionId, course._id, label));
    }
    await Session.updateOne({ _id: sessionId }, { $set: { status: 'done' } });
    await Response.insertMany([
      ...students.slice(0, 4).map(({ user }) => ({
        questionId: ids[0], studentUserId: getAnonymousParticipantId(sessionId, user._id), attempt: 1, answer: '0',
      })),
      ...students.slice(2).map(({ user }) => ({
        questionId: ids[1], studentUserId: getAnonymousParticipantId(sessionId, user._id), attempt: 1, answer: 'private-answer',
      })),
    ]);
    await Question.updateOne({ _id: ids[1] }, { $set: {
      'sessionOptions.wordCloudData': { wordFrequencies: [{ text: 'private-answer', value: 3 }] },
      'sessionOptions.histogramData': { bins: [{ label: 'private-answer', count: 3 }] },
    } });
    const result = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, { token: profToken });
    expect(result.statusCode).toBe(200);
    const payload = result.json();
    expect(payload.anonymousSummary).toMatchObject({ respondentCount: 5, responsesWithheld: true });
    expect(payload.questions.map((q) => q.anonymousResponseAttempts[0])).toEqual([
      { attempt: 1, respondentCount: 4, responsesWithheld: false, minimumRespondents: 4 },
      { attempt: 1, respondentCount: 3, responsesWithheld: true, minimumRespondents: 4 },
      { attempt: 1, respondentCount: 0, responsesWithheld: false, minimumRespondents: 4 },
    ]);
    expect(payload.studentResults).toHaveLength(4); // The sparse-only respondent has no row.
    for (const row of payload.studentResults) {
      expect(row.questionResults.map((q) => q.responses.length)).toEqual([1, 0, 0]);
      expect(row.participation).toBeNull();
    }
    expect(JSON.stringify(payload)).not.toContain('private-answer');
    expectNoIdentity(payload, students);
    expect(JSON.stringify(payload)).not.toContain('anon_');
  });

  it('routes live events to joined students without exposing names to instructors', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { prof, profToken, course, students } = await setupCourse({ studentCount: 2 });
    const sessionId = (await createSession(profToken, course._id, { anonymous: true })).json().session._id;
    await addMcQuestion(profToken, sessionId, course._id);
    const shortAnswerRes = await authenticatedRequest(app, 'POST', '/api/v1/questions', {
      token: profToken,
      payload: {
        type: 2,
        content: '<p>Any comments?</p>',
        plainText: 'Any comments?',
        sessionId,
        courseId: course._id,
      },
    });
    await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/questions`, {
      token: profToken,
      payload: { questionId: shortAnswerRes.json().question._id },
    });
    const questionIds = (await Session.findById(sessionId).lean()).questions;
    await startLiveQuestion(profToken, sessionId);
    const earlyWordCloud = await authenticatedRequest(
      app, 'POST', `/api/v1/questions/${shortAnswerRes.json().question._id}/word-cloud`,
      { token: profToken, payload: {} }
    );
    expect(earlyWordCloud.statusCode).toBe(409);

    const joinSpy = vi.spyOn(app, 'wsSendToUsers');
    await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join`, {
      token: students[0].token,
      payload: {},
    });
    const joinCall = joinSpy.mock.calls.find(([, event]) => event === 'session:participant-joined');
    expect(joinCall[2]).toEqual(expect.objectContaining({ joinedCount: 1, anonymous: true }));
    expect(joinCall[2].joinedStudent).toBeUndefined();

    const visibilityRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/question-visibility`, {
      token: profToken,
      payload: { hidden: false, stats: true, correct: false },
    });
    expect(visibilityRes.statusCode).toBe(200);
    const visibilityCalls = joinSpy.mock.calls.filter(([, event]) => event === 'session:visibility-changed');
    const studentCall = visibilityCalls.find(([userIds]) => userIds.includes(String(students[0].user._id)));
    expect(studentCall).toBeDefined();
    // Only joined students receive session deltas.
    expect(visibilityCalls.some(([userIds]) => userIds.includes(String(students[1].user._id)))).toBe(false);

    const currentRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/current`, {
      token: profToken,
      payload: { questionId: questionIds[1] },
    });
    expect(currentRes.statusCode).toBe(200);
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/question-visibility`, {
      token: profToken,
      payload: { hidden: false, stats: true, correct: false },
    });

    joinSpy.mockClear();
    const respondRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/respond`, {
      token: students[0].token,
      payload: { answer: 'Private thought', answerWysiwyg: '<p>Private thought</p>' },
    });
    expect(respondRes.statusCode).toBe(201);
    const responseCalls = joinSpy.mock.calls.filter(([, event]) => event === 'session:response-added');
    const instructorResponseCall = responseCalls.find(([userIds]) => userIds.includes(String(prof._id)));
    expect(instructorResponseCall).toBeDefined();
    expect(instructorResponseCall[2].response).toBeUndefined();
    expect(instructorResponseCall[2].responseSubmittedAt).toBeUndefined();
    expect(instructorResponseCall[2].responseStats).toBeUndefined();
    expectNoIdentity(instructorResponseCall[2], students);

    joinSpy.mockClear();
    const sendToUserSpy = typeof app.wsSendToUser === 'function' ? vi.spyOn(app, 'wsSendToUser') : null;
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/current`, {
      token: profToken,
      payload: { questionId: questionIds[0] },
    });
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/current`, {
      token: profToken,
      payload: { questionId: questionIds[1] },
    });
    const questionChangedCalls = [
      ...joinSpy.mock.calls,
      ...(sendToUserSpy ? sendToUserSpy.mock.calls.map(([userId, event, payload]) => [[userId], event, payload]) : []),
    ].filter(([, event]) => event === 'session:question-changed');
    const ownResponseDelivery = questionChangedCalls.find(([userIds, , payload]) => (
      userIds.includes(String(students[0].user._id)) && payload.studentResponse
    ));
    expect(ownResponseDelivery?.[2].studentResponse).toEqual(expect.objectContaining({ answer: 'Private thought' }));
    const instructorSnapshot = questionChangedCalls.find(([userIds]) => userIds.includes(String(prof._id)));
    expect(instructorSnapshot[2].allResponses).toEqual([]);
    expect(instructorSnapshot[2].responseStats).toBeNull();
    expectNoIdentity(instructorSnapshot[2], students);
  });
});

describe('anonymous quizzes', () => {
  it.each(['running', 'visible'])('releases fixed batches for %s quizzes, hides identities and times, and includes unsent answers after ending', async (status) => {
    const { prof, profToken, course, students } = await setupCourse({ studentCount: 9 });
    const quizEnd = new Date(Date.now() + 3_600_000);
    const sessionId = (await createSession(profToken, course._id, {
      anonymous: true, quiz: true,
      quizStart: new Date(Date.now() - 3_600_000).toISOString(), quizEnd: quizEnd.toISOString(),
    })).json().session._id;
    const questionId = await addMcQuestion(profToken, sessionId, course._id);
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, { token: profToken, payload: { status } });
    const sent = vi.spyOn(app, 'wsSendToUsers');
    const results = () => authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, { token: profToken });
    const instructorEvents = () => sent.mock.calls.filter(([ids, event]) => ids.includes(String(prof._id)) && event === 'session:quiz-submitted');
    let firstBatch;
    for (let index = 0; index < students.length; index += 1) {
      const { token } = students[index];
      const saved = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/quiz-response`, {
        token, payload: { questionId, answer: index < 4 ? '0' : '1' },
      });
      expect(saved.statusCode).toBe(200);
      // The ninth student saves an answer but forgets to submit.
      if (index === 8) break;
      const submit = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/submit`, { token });
      expect(submit.statusCode).toBe(200);
      const reviewed = await results();
      if (index < 3) {
        expect(reviewed.statusCode).toBe(409);
        expect(instructorEvents()).toHaveLength(0);
        continue;
      }
      expect(reviewed.statusCode).toBe(200);
      const payload = reviewed.json();
      expect(payload.quizResultsRefreshAt).toBe(status === 'visible' ? quizEnd.getTime() : null);
      expect(payload.studentResults).toHaveLength(index < 7 ? 4 : 8);
      expectNoIdentity(payload, students);
      expect(JSON.stringify(payload.studentResults)).not.toMatch(/anon_|createdAt|updatedAt|submittedIpAddress/);
      if (index === 3) firstBatch = payload.studentResults;
      if (index > 3 && index < 7) {
        expect(payload.studentResults).toEqual(firstBatch);
        expect((await results()).json().studentResults).toEqual(firstBatch);
      }
      expect(instructorEvents()).toHaveLength(index < 7 ? 1 : 2);
    }
    expect((await results()).json().studentResults).toHaveLength(8);
    expect(instructorEvents().map(([, , data]) => data.submittedCount)).toEqual([4, 8]);
    for (const [, , data] of instructorEvents()) {
      expectNoIdentity(data, students);
      expect(data.anonymous).toBe(true);
    }
    const forbidden = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, { token: students[0].token });
    expect(forbidden.statusCode).toBe(403);
    const outsider = await createTestUser({ email: 'unrelated-prof@example.com', roles: ['professor'] });
    expect((await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, { token: await getAuthToken(app, outsider) })).statusCode).toBe(403);
    if (status === 'visible') {
      await Session.updateOne({ _id: sessionId }, { $set: { quizEnd: new Date(Date.now() - 1000) } });
    } else {
      await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, { token: profToken, payload: { status: 'done' } });
    }
    const ended = (await results()).json();
    expect(ended.session.status).toBe('done');
    expect(ended.studentResults).toHaveLength(9);
    expect(await Grade.countDocuments({ sessionId })).toBe(0);
    // Reopening preserves the submitted prefix instead of releasing the tail.
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, { token: profToken, payload: { status: 'running' } });
    expect((await results()).json().studentResults).toHaveLength(8);
  });

  it('keeps an optional question’s partial next batch hidden while releasing the next four quizzes', async () => {
    const { profToken, course, students } = await setupCourse({ studentCount: 8 });
    const sessionId = (await createSession(profToken, course._id, {
      anonymous: true, quiz: true, allowSkippingZeroPointQuestions: true,
    })).json().session._id;
    const requiredId = await addMcQuestion(profToken, sessionId, course._id);
    const optionalId = await addMcQuestion(profToken, sessionId, course._id, 'Optional feedback');
    await Question.updateOne({ _id: optionalId }, { $set: { 'sessionOptions.points': 0 } });
    await Session.updateOne({ _id: sessionId }, { $set: { status: 'running' } });
    let firstOptionalAnswers;
    for (let index = 0; index < students.length; index += 1) {
      const { token } = students[index];
      for (const questionId of index < 5 ? [requiredId, optionalId] : [requiredId]) {
        expect((await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/quiz-response`, {
          token, payload: { questionId, answer: index === 4 ? '1' : '0' },
        })).statusCode).toBe(200);
      }
      expect((await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/submit`, { token })).statusCode).toBe(200);
      if (index !== 3 && index !== 7) continue;
      const result = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, { token: profToken });
      expect(result.statusCode).toBe(200);
      expect(result.json().studentResults).toHaveLength(index + 1);
      const optionalAnswers = result.json().studentResults.flatMap((student) => student.questionResults
        .filter((question) => question.questionId === optionalId).flatMap((question) => question.responses.map((response) => response.answer)));
      if (index === 3) firstOptionalAnswers = optionalAnswers;
      else {
        expect(optionalAnswers).toEqual(firstOptionalAnswers);
        expect(optionalAnswers).toHaveLength(4);
        expect(result.json().questions.find((question) => question._id === optionalId).anonymousResponseAttempts[0])
          .toMatchObject({ respondentCount: 5, releasedRespondentCount: 4 });
      }
    }
  });

  it('batches sparse question/attempt groups independently and survives concurrent duplicate submissions', async () => {
    const { profToken, course, students } = await setupCourse({ studentCount: 8 });
    const sessionId = (await createSession(profToken, course._id, { anonymous: true, quiz: true })).json().session._id;
    const questionId = await addMcQuestion(profToken, sessionId, course._id);
    await Session.updateOne({ _id: sessionId }, { $set: { status: 'running' } });
    for (const { token } of students) {
      expect((await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/quiz-response`, { token, payload: { questionId, answer: '0' } })).statusCode).toBe(200);
    }
    const duplicate = await Promise.all([0, 1].map(() => authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/submit`, { token: students[0].token })));
    expect(duplicate.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    for (const { token } of students.slice(1)) await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/submit`, { token });
    const stored = await Session.findById(sessionId).lean();
    expect(stored.submittedQuiz).toHaveLength(8);
    // Model legacy/incomplete data: only five submitted respondents answered attempt 2.
    await Response.insertMany(stored.submittedQuiz.slice(0, 5).map((studentUserId) => ({ questionId, studentUserId, attempt: 2, answer: '1' })));
    const result = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, { token: profToken });
    expect(result.statusCode).toBe(200);
    expect(result.json().questions[0].anonymousResponseAttempts.find((entry) => entry.attempt === 2)).toMatchObject({ respondentCount: 5, releasedRespondentCount: 4 });
    const answers = result.json().studentResults.flatMap((student) => student.questionResults.flatMap((question) => question.responses));
    expect(answers.filter((answer) => answer.attempt === 2)).toHaveLength(4);
    expect(result.json().studentResults.every((student) => student.participation === null)).toBe(true);
  });

  it.each([
    { anonymous: false, shared: false },
    { anonymous: true, shared: false },
    { anonymous: false, shared: true },
    { anonymous: true, shared: true },
  ])('protects saved quiz answers before submission and results release: %j', async ({ anonymous, shared }) => {
    const { profToken, course, students } = await setupCourse({ studentCount: 1 });
    const sessionId = (await createSession(profToken, course._id, {
      anonymous, quiz: true, allowSkippingZeroPointQuestions: true,
    })).json().session._id;
    const questionId = await addMcQuestion(profToken, sessionId, course._id);
    const unansweredId = await addMcQuestion(profToken, sessionId, course._id, 'Optional question');
    await Question.updateOne({ _id: unansweredId }, { $set: { 'sessionOptions.points': 0 } });
    const call = (method, suffix, token = profToken, payload) => authenticatedRequest(
      app, method, `/api/v1/sessions/${sessionId}${suffix}`, { token, payload }
    );
    expect((await call('PATCH', '', profToken, { status: 'running' })).statusCode).toBe(200);
    let participantToken = students[0].token;
    const outsider = await createTestUser({ email: 'outsider-editor@example.com', roles: ['professor'] });
    const outsiderToken = await getAuthToken(app, outsider);
    expect((await call('GET', '/response-locks', outsiderToken)).statusCode).toBe(403);
    if (shared) {
      expect((await authenticatedRequest(app, 'PATCH', `/api/v1/courses/${course._id}`, {
        token: profToken, payload: { allowSharedActivities: true },
      })).statusCode).toBe(200);
      const share = await call('POST', '/activity-share', profToken, {});
      expect(share.statusCode).toBe(200);
      const redeemed = await authenticatedRequest(app, 'POST', '/api/v1/activity-codes/redeem', {
        token: outsiderToken, payload: { code: share.json().code },
      });
      expect(redeemed.statusCode).toBe(200);
      participantToken = outsiderToken;
    }
    expect((await call('GET', '/response-locks', students[0].token)).statusCode).toBe(403);
    expect((await call('GET', '/response-locks', outsiderToken)).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/response-locks` })).statusCode).toBe(401);
    expect((await call('GET', '/response-locks')).json()).toEqual({ responseBackedQuestionIds: [] });

    const saved = await call('PATCH', '/quiz-response', participantToken, { questionId, answer: '0' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().response.editable).toBe(true);
    expect((await Session.findById(sessionId).lean()).submittedQuiz).toEqual([]);
    // A single draft response must lock editing even though review has no answers.
    const draftResults = await call('GET', '/results');
    expect(draftResults.statusCode).toBe(anonymous ? 409 : 200);
    if (!anonymous) expect(draftResults.json().studentResults).toEqual([]);
    expect((await call('GET', '/response-locks')).json()).toEqual({ responseBackedQuestionIds: [questionId] });
    // Editing the answer does not create another response or change the locks.
    expect((await call('PATCH', '/quiz-response', participantToken, { questionId, answer: '1' })).statusCode).toBe(200);
    expect(await Response.countDocuments({ questionId })).toBe(1);

    const edit = (payload) => authenticatedRequest(app, 'PATCH', `/api/v1/questions/${questionId}`, { token: profToken, payload });
    expect((await edit({ type: 2 })).statusCode).toBe(409);
    expect((await edit({ options: [{ content: 'Only option', correct: true }] })).statusCode).toBe(409);
    expect((await call('DELETE', `/questions/${questionId}`)).statusCode).toBe(409);
    expect((await authenticatedRequest(app, 'DELETE', `/api/v1/questions/${questionId}`, { token: profToken })).statusCode).toBe(409);
    expect((await edit({ content: '<p>Clarified prompt</p>', options: [
      { content: 'Yes', correct: true }, { content: 'No', correct: false },
    ] })).statusCode).toBe(200);
    expect((await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${unansweredId}`, {
      token: profToken, payload: { type: 2 },
    })).statusCode).toBe(200);

    expect((await call('POST', '/submit', participantToken)).statusCode).toBe(200);
    expect((await call('GET', '/response-locks')).json()).toEqual({ responseBackedQuestionIds: [questionId] });
    expect((await call('PATCH', '', profToken, { status: 'done' })).statusCode).toBe(200);
    expect((await call('GET', '/response-locks')).json()).toEqual({ responseBackedQuestionIds: [questionId] });
    if (anonymous) {
      expect((await call('GET', '/results')).json().studentResults).toEqual([]);
      expect(await Grade.countDocuments({ sessionId })).toBe(0);
    }
  });

  it('allows one submission per student and keeps the course list status per student', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();
    const { profToken, course, students } = await setupCourse({ studentCount: 2 });
    const now = Date.now();
    const sessionId = (await createSession(profToken, course._id, {
      anonymous: true,
      quiz: true,
      quizStart: new Date(now - (30 * 60 * 1000)).toISOString(),
      quizEnd: new Date(now + (30 * 60 * 1000)).toISOString(),
    })).json().session._id;
    const questionId = await addMcQuestion(profToken, sessionId, course._id);
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}`, {
      token: profToken,
      payload: { status: 'visible' },
    });

    const [first, second] = students;
    const quizRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/quiz`, { token: first.token });
    expect(quizRes.statusCode).toBe(200);
    expect(quizRes.json().session.anonymous).toBe(true);

    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/quiz-response`, {
      token: first.token,
      payload: { questionId, answer: '1' },
    });
    const updateRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/quiz-response`, {
      token: first.token,
      payload: { questionId, answer: '0' },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(await Response.countDocuments({ questionId })).toBe(1);

    const submitRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/submit`, { token: first.token });
    expect(submitRes.statusCode).toBe(200);
    expect(submitRes.json().session.quizSubmittedByCurrentUser).toBe(true);

    const resubmitRes = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/submit`, { token: first.token });
    expect(resubmitRes.statusCode).toBe(409);
    const reenterRes = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/quiz`, { token: first.token });
    expect(reenterRes.statusCode).toBe(403);
    const lateEditRes = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/quiz-response`, {
      token: first.token,
      payload: { questionId, answer: '1' },
    });
    expect(lateEditRes.statusCode).toBe(403);

    const firstListRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/sessions`, { token: first.token });
    const firstListed = firstListRes.json().sessions.find((entry) => entry._id === sessionId);
    expect(firstListed.quizSubmittedByCurrentUser).toBe(true);
    expect(firstListed.quizAllQuestionsAnsweredByCurrentUser).toBe(true);

    const secondListRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/sessions`, { token: second.token });
    const secondListed = secondListRes.json().sessions.find((entry) => entry._id === sessionId);
    expect(secondListed.quizSubmittedByCurrentUser).toBe(false);
    expect(secondListed.quizHasResponsesByCurrentUser).toBe(false);

    const storedSession = await Session.findById(sessionId).lean();
    expect(storedSession.submittedQuiz).toEqual([getAnonymousParticipantId(sessionId, String(first.user._id))]);

    const profListRes = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/sessions`, { token: profToken });
    const profListed = profListRes.json().sessions.find((entry) => entry._id === sessionId);
    expect(profListed.submittedCount).toBe(1);
    expect(profListed.submittedQuiz).toBeUndefined();
    expectNoIdentity(profListRes.json(), students);
  });
});

describe('anonymous live statistics batches', () => {
  it.each([
    [0, 'distribution'], [1, 'distribution'], [2, 'shortAnswer'],
    [3, 'distribution'], [4, 'numerical'],
  ])('publishes type %i through cached HTTP and WebSocket snapshots in groups of four', async (type, statsType) => {
    const { prof, profToken, course, students } = await setupCourse({ studentCount: 8 });
    const sessionId = (await createSession(profToken, course._id, { anonymous: true })).json().session._id;
    const questionId = await addMcQuestion(profToken, sessionId, course._id);
    await Question.updateOne({ _id: questionId }, { $set: { type, ...([2, 4].includes(type) ? { options: [] } : {}) } });
    await startLiveQuestion(profToken, sessionId);
    for (const { token } of students) {
      expect((await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join`, { token, payload: {} })).statusCode).toBe(200);
    }
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/question-visibility`, {
      token: profToken, payload: { stats: true },
    });
    const sendSpy = vi.spyOn(app, 'wsSendToUsers');
    const findSpy = vi.spyOn(Response, 'find');
    for (let index = 0; index < students.length; index += 1) {
      sendSpy.mockClear();
      findSpy.mockClear();
      const answer = type === 2 ? `batchword${index}` : type === 4 ? String(index + 1) : type === 3 ? ['0', '1'] : String(index % 2);
      const res = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/respond`, {
        token: students[index].token, payload: { answer },
      });
      expect(res.statusCode).toBe(201);
      // No per-answer response-list reload: only the fourth and eighth answers rebuild.
      expect(findSpy.mock.calls.filter(([filter]) => filter.questionId === questionId)).toHaveLength((index + 1) % 4 === 0 ? 1 : 0);
      const events = sendSpy.mock.calls.filter(([, event]) => event === 'session:response-added');
      const professorEvent = events.find(([ids]) => ids.includes(String(prof._id)))?.[2];
      expect(professorEvent.response).toBeUndefined();
      expect(professorEvent.responseSubmittedAt).toBeUndefined();
      expectNoIdentity(professorEvent, students);
      expect(JSON.stringify(professorEvent)).not.toMatch(/anon_|createdAt|updatedAt|studentUserId/);
      if ((index + 1) % 4 === 0) {
        expect(professorEvent.responseStats).toMatchObject({ type: statsType, total: index + 1 });
        const studentEvent = events.find(([ids]) => ids.includes(String(students[0].user._id)))?.[2];
        expect(studentEvent.responseStats.total).toBe(index + 1);
        expect(professorEvent.audience.responseStats).toEqual(studentEvent.responseStats);
        if (statsType === 'distribution') {
          expect(studentEvent.responseStats.distribution.every((entry) => !('correct' in entry))).toBe(true);
        }
      } else {
        expect(professorEvent.responseStats).toBeUndefined();
      }
      const live = (await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/live`, { token: profToken })).json();
      expect(live.allResponses).toEqual([]);
      expect(live.responseStats?.total || 0).toBe(Math.floor((index + 1) / 4) * 4);
      if (index === 4) {
        // Closing/reopening the implicit first attempt must keep its released
        // cache: resetting it would expose just the fifth answer by subtraction.
        for (const closed of [true, false]) {
          const toggled = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/toggle-responses`, {
            token: profToken, payload: { closed },
          });
          expect(toggled.statusCode).toBe(200);
          expect(toggled.json().question.sessionOptions.attemptStats[0].total).toBe(4);
        }
        // Repeated visibility changes and navigation must not expose the fifth answer.
        await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/question-visibility`, {
          token: profToken, payload: { stats: false },
        });
        await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/question-visibility`, {
          token: profToken, payload: { stats: true },
        });
        await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/current`, {
          token: profToken, payload: { questionId },
        });
        const navigation = sendSpy.mock.calls.filter(([, event]) => event === 'session:question-changed');
        expect(navigation.find(([ids]) => ids.includes(String(prof._id)))[2].responseStats.total).toBe(4);
        for (const [token, suffix] of [[students[0].token, ''], [profToken, '?view=presentation']]) {
          const snapshot = (await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/live${suffix}`, { token })).json();
          expect(snapshot.showStats).toBe(true);
          expect(snapshot.responseStats.total).toBe(4);
          expect(JSON.stringify(snapshot.responseStats)).not.toMatch(/anon_|createdAt|updatedAt|studentUserId/);
        }
        if (type === 2) {
          const cloud = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/word-cloud`, { token: profToken, payload: {} });
          expect(cloud.statusCode).toBe(200);
          expect(JSON.stringify(cloud.json())).toContain('batchword0');
          expect(JSON.stringify(cloud.json())).not.toContain('batchword4');
        }
        if (type === 4) {
          const histogram = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/histogram`, { token: profToken, payload: {} });
          expect(histogram.statusCode).toBe(200);
          const data = histogram.json().histogramData;
          expect(data.bins.reduce((sum, bin) => sum + bin.count, data.overflowLow + data.overflowHigh)).toBe(4);
        }
      }
    }
    expect((await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/results`, { token: profToken })).statusCode).toBe(409);
    const cache = (await Question.findById(questionId).lean()).sessionOptions.attemptStats[0];
    expect(cache.total).toBe(8);
    expect(JSON.stringify(cache)).not.toMatch(/anon_|createdAt|updatedAt/);
    if (statsType === 'numerical') {
      const live = (await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/live`, { token: profToken })).json();
      expect(live.responseStats).toMatchObject({ total: 8, mean: 4.5, min: 1, max: 8 });
    }
    // Authoring metadata cannot cause an already-published attempt number to
    // be reused and its cache reset by the live new-attempt control.
    const edited = await authenticatedRequest(app, 'PATCH', `/api/v1/questions/${questionId}`, {
      token: profToken, payload: { sessionOptions: { attempts: [{ number: 0, closed: true }] } },
    });
    expect(edited.statusCode).toBe(200);
    const newAttempt = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/new-attempt`, { token: profToken });
    expect(newAttempt.json().attemptNumber).toBe(2);
    expect(newAttempt.json().question.sessionOptions.attemptStats.find((entry) => entry.number === 1).total).toBe(8);
    expect(newAttempt.statusCode).toBe(200);
    const fresh = (await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/live`, { token: profToken })).json();
    expect(fresh.responseStats).toBeNull();
    expect(fresh.wordCloudData.wordFrequencies).toEqual([]);
    expect(fresh.wordCloudData.visible).toBe(false);
    expect(fresh.histogramData.bins).toEqual([]);
    expect(fresh.histogramData.visible).toBe(false);
  });

  it.each([3, 7])('keeps counts consistent when an answer arrives during publication after %i responses', async (initialCount) => {
    const { prof, profToken, course, students } = await setupCourse({ studentCount: initialCount + 2 });
    const sessionId = (await createSession(profToken, course._id, { anonymous: true })).json().session._id;
    const questionId = await addMcQuestion(profToken, sessionId, course._id);
    await startLiveQuestion(profToken, sessionId);
    for (const { token } of students) {
      await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join`, { token, payload: {} });
    }
    await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${sessionId}/question-visibility`, {
      token: profToken, payload: { stats: true },
    });
    for (const { token } of students.slice(0, initialCount)) {
      expect((await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/respond`, {
        token, payload: { answer: '0' },
      })).statusCode).toBe(201);
    }
    const countDocuments = Response.countDocuments.bind(Response);
    // Reproduce a second request persisting its answer between the count query
    // and the publication query. The aggregate can legitimately include it.
    vi.spyOn(Response, 'countDocuments').mockImplementationOnce(async (filter) => {
      const count = await countDocuments(filter);
      await Response.create({ questionId, attempt: 1, answer: '1',
        studentUserId: getAnonymousParticipantId(sessionId, students[initialCount + 1].user._id),
        createdAt: new Date(), submittedAt: new Date() });
      return count;
    });
    const sendSpy = vi.spyOn(app, 'wsSendToUsers');
    expect((await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/respond`, {
      token: students[initialCount].token, payload: { answer: '0' },
    })).statusCode).toBe(201);
    const events = sendSpy.mock.calls.filter(([, event, data]) => event === 'session:response-added' && data.responseStats);
    expect(events.some(([ids]) => ids.includes(String(prof._id)))).toBe(true);
    expect(events.some(([ids]) => ids.includes(String(students[0].user._id)))).toBe(true);
    for (const [, , data] of events) {
      expect(data.responseStats.total).toBe(initialCount + 2);
      expect(data.responseCount).toBeGreaterThanOrEqual(data.responseStats.total);
      expectNoIdentity(data, students);
    }
    const stored = await Question.findById(questionId).lean();
    expect(stored.sessionProperties.lastAttemptResponseCount).toBe(initialCount + 2);
  });

  it('reserves batch rebuilds under concurrent submissions and repairs an interrupted publication', async () => {
    const { prof, profToken, course, students } = await setupCourse({ studentCount: 12 });
    const sessionId = (await createSession(profToken, course._id, { anonymous: true })).json().session._id;
    const questionId = await addMcQuestion(profToken, sessionId, course._id);
    await startLiveQuestion(profToken, sessionId);
    for (const { token } of students) {
      await authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/join`, { token, payload: {} });
    }
    const sendSpy = vi.spyOn(app, 'wsSendToUsers');
    const findSpy = vi.spyOn(Response, 'find');
    const results = await Promise.all(students.map(({ token }) => authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/respond`, {
      token, payload: { answer: '0' },
    })));
    expect(results.every((res) => res.statusCode === 201)).toBe(true);
    const publications = sendSpy.mock.calls.filter(([ids, event, data]) => (
      event === 'session:response-added' && ids.includes(String(prof._id)) && data.responseStats
    )).map(([, , data]) => data.responseStats.total).sort((a, b) => a - b);
    expect(publications.length).toBeGreaterThan(0);
    publications.forEach((total, index) => expect(total - (publications[index - 1] || 0)).toBeGreaterThanOrEqual(4));
    expect(findSpy.mock.calls.filter(([filter]) => filter.questionId === questionId).length).toBeLessThanOrEqual(3);
    // A process can stop after reserving a batch. An instructor snapshot repairs
    // from its already-loaded responses without requiring another student answer.
    await Question.updateOne({ _id: questionId }, { $set: { 'sessionOptions.attemptStats': [] } });
    const live = (await authenticatedRequest(app, 'GET', `/api/v1/sessions/${sessionId}/live`, { token: profToken })).json();
    expect(live.responseStats.total).toBe(12);
  });
});
