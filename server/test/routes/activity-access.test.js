import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createApp, createTestUser, getAuthToken, authenticatedRequest } from '../helpers.js';
import ActivityGrant from '../../src/models/ActivityGrant.js';
import ActivityShare from '../../src/models/ActivityShare.js';
import Course from '../../src/models/Course.js';
import Grade from '../../src/models/Grade.js';
import Post from '../../src/models/Post.js';
import Question from '../../src/models/Question.js';
import Response from '../../src/models/Response.js';
import { getSessionParticipantId } from '../../src/utils/anonymousSession.js';
import Session from '../../src/models/Session.js';
import { getActivityRecipientUserIds } from '../../src/services/activityAccess.js';

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

async function fixture({ anonymous = false, quiz = true, status = 'visible' } = {}) {
  const professor = await createTestUser({ email: 'share-prof@example.com', roles: ['professor'] });
  const outsider = await createTestUser({ email: 'share-outsider@example.com', roles: ['student'] });
  const professorToken = await getAuthToken(app, professor);
  const outsiderToken = await getAuthToken(app, outsider);
  const courseResponse = await authenticatedRequest(app, 'POST', '/api/v1/courses', {
    token: professorToken,
    payload: {
      name: 'Survey Course', deptCode: 'SUR', courseNumber: '100',
      section: '001', semester: 'Fall 2026', allowSharedActivities: true,
    },
  });
  expect(courseResponse.statusCode).toBe(201);
  const course = courseResponse.json().course;
  const sessionResponse = await authenticatedRequest(app, 'POST', `/api/v1/courses/${course._id}/sessions`, {
    token: professorToken,
    payload: { name: 'External Survey', anonymous, quiz },
  });
  expect(sessionResponse.statusCode).toBe(201);
  const session = sessionResponse.json().session;
  await Session.updateOne({ _id: session._id }, { $set: { status } });
  session.status = status;
  return { professor, outsider, professorToken, outsiderToken, course, session };
}

async function issue(sessionId, professorToken, payload = {}) {
  return authenticatedRequest(app, 'POST', `/api/v1/sessions/${sessionId}/activity-share`, {
    token: professorToken, payload,
  });
}

async function redeem(code, outsiderToken) {
  return authenticatedRequest(app, 'POST', '/api/v1/activity-codes/redeem', {
    token: outsiderToken, payload: { code },
  });
}

describe('activity code foundation', () => {
  it('issues a hashed code and an idempotent session-only grant without enrollment or grades', async () => {
    const { professorToken, outsiderToken, outsider, course, session } = await fixture();
    const issued = await issue(session._id, professorToken);
    expect(issued.statusCode).toBe(200);
    const code = issued.json().code;
    const status = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/activity-share`, { token: professorToken });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ enabled: true, code, expiresAt: issued.json().expiresAt });
    expect(code).toMatch(/^S-[A-HJ-NP-Z2-9]{7}$/);
    const share = await ActivityShare.findOne({ sessionId: session._id }).lean();
    expect(share.codeHash).not.toBe(code);
    expect(JSON.stringify(share)).not.toContain(code);

    const first = await redeem(code.toLowerCase(), outsiderToken);
    const second = await redeem(code, outsiderToken);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toEqual({
      sessionId: session._id, courseId: course._id, name: session.name, quiz: true, anonymous: false,
    });
    expect(await ActivityGrant.countDocuments({ sessionId: session._id, userId: outsider._id })).toBe(1);
    const grant = await ActivityGrant.findOne({ sessionId: session._id, userId: outsider._id }).lean();
    expect(typeof grant._id).toBe('string');
    expect((await Session.findById(session._id).lean()).participationStarted).toBe(true);
    expect((await Course.findById(course._id).lean()).students).not.toContain(outsider._id);
    expect(await Grade.countDocuments({ sessionId: session._id, userId: outsider._id })).toBe(0);
    const sessionAccess = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}`, { token: outsiderToken });
    expect(sessionAccess.statusCode).toBe(200);

    const toggle = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}`, {
      token: professorToken, payload: { anonymous: true },
    });
    expect(toggle.statusCode).toBe(409);
  });

  it.each([
    { anonymous: false, quiz: false }, { anonymous: true, quiz: false },
    { anonymous: false, quiz: true }, { anonymous: true, quiz: true },
  ])('keeps Draft codes unavailable without side effects (anonymous=$anonymous, quiz=$quiz)', async (options) => {
    const { professorToken, outsiderToken, course, session } = await fixture({ ...options, status: 'hidden' });
    const student = await createTestUser({ email: 'draft-enrolled@example.com', roles: ['student'] });
    const studentToken = await getAuthToken(app, student);
    await Course.updateOne({ _id: course._id }, { $addToSet: { students: student._id } });
    const issued = await issue(session._id, professorToken);
    expect(issued.statusCode).toBe(200);
    const code = issued.json().code;
    const unknown = await redeem('S-AAAAAAA', outsiderToken);
    expect(unknown.statusCode).toBe(404);
    for (const token of [outsiderToken, studentToken]) {
      const denied = await redeem(code, token);
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toEqual(unknown.json());
    }
    expect(await ActivityGrant.countDocuments({ sessionId: session._id })).toBe(0);
    expect(await Grade.countDocuments({ sessionId: session._id })).toBe(0);
    const stored = await Session.findById(session._id).lean();
    expect(stored.participationStarted).toBeFalsy();
    expect(stored.joined).toEqual([]);
    expect(stored.joinRecords).toEqual([]);
    const editable = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}`, {
      token: professorToken, payload: { anonymous: !options.anonymous },
    });
    expect(editable.statusCode).toBe(200);
    await Session.updateOne({ _id: session._id }, { $set: { anonymous: options.anonymous, status: 'visible' } });
    // Publishing makes the same code usable; no regeneration is needed.
    for (const token of [outsiderToken, studentToken]) {
      expect((await redeem(code, token)).statusCode).toBe(200);
    }
    expect(await ActivityGrant.countDocuments({ sessionId: session._id })).toBe(2);
    await Session.updateOne({ _id: session._id }, { $set: { status: 'hidden' } });
    // Existing grants must not bypass Draft, including after code expiry.
    await ActivityShare.updateOne({ sessionId: session._id }, { $set: { expiresAt: new Date(0) } });
    for (const token of [outsiderToken, studentToken]) {
      const denied = await redeem(code, token);
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toEqual(unknown.json());
      const direct = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}`, { token });
      expect(direct.statusCode).toBe(403);
    }
  });

  it('rejects a redemption if the activity returns to Draft before participation is claimed', async () => {
    const { professorToken, outsiderToken, session } = await fixture();
    const code = (await issue(session._id, professorToken)).json().code;
    const updateOne = Session.updateOne.bind(Session);
    const race = vi.spyOn(Session, 'updateOne').mockImplementationOnce(async (...args) => {
      await updateOne({ _id: session._id }, { $set: { status: 'hidden' } });
      return updateOne(...args);
    });
    try {
      expect((await redeem(code, outsiderToken)).statusCode).toBe(404);
      expect(await ActivityGrant.countDocuments({ sessionId: session._id })).toBe(0);
      expect((await Session.findById(session._id).lean()).participationStarted).toBeFalsy();
    } finally {
      race.mockRestore();
    }
  });

  it('does not disclose metadata if the activity returns to Draft while saving its grant', async () => {
    const { professorToken, outsiderToken, session } = await fixture();
    const code = (await issue(session._id, professorToken)).json().code;
    const updateOne = ActivityGrant.updateOne.bind(ActivityGrant);
    const race = vi.spyOn(ActivityGrant, 'updateOne').mockImplementationOnce(async (...args) => {
      await Session.updateOne({ _id: session._id }, { $set: { status: 'hidden' } });
      return updateOne(...args);
    });
    try {
      const denied = await redeem(code, outsiderToken);
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toEqual({ error: 'Not Found', message: 'Invalid or unavailable activity code' });
    } finally {
      race.mockRestore();
    }
  });

  it('rejects unsupported code formats', async () => {
    const { outsiderToken } = await fixture();
    for (const code of ['S-AAAAAA', 'S-AAAAAAAA', `S-${'A'.repeat(10)}`, `S-${'A'.repeat(40)}`]) {
      expect((await redeem(code, outsiderToken)).statusCode).toBe(404);
    }
  });

  it('limits redemption to ten attempts per minute per account without blocking classmates', async () => {
    await app.close();
    app = await createApp({ disableRateLimits: false });
    const { professorToken, outsiderToken, session } = await fixture();
    const code = (await issue(session._id, professorToken)).json().code;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await redeem('S-AAAAAAA', outsiderToken)).statusCode).toBe(404);
    }
    const limited = await redeem(code, outsiderToken);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Same network address, different account: the student's attempts do not block others.
    expect((await redeem(code, professorToken)).statusCode).toBe(200);
  });

  it('creates a code on first enable, reuses it after disabling, and accepts only the enabled code', async () => {
    const { professorToken, outsiderToken, session } = await fixture();
    const first = await issue(session._id, professorToken);
    expect(first.statusCode).toBe(200);
    const firstCode = first.json().code;
    expect(firstCode).toMatch(/^S-[A-HJ-NP-Z2-9]{7}$/);
    expect((await issue(session._id, professorToken)).json().code).toBe(firstCode);
    expect(await ActivityShare.countDocuments({ sessionId: session._id })).toBe(1);

    const disabled = await authenticatedRequest(app, 'DELETE', `/api/v1/sessions/${session._id}/activity-share`, {
      token: professorToken,
    });
    expect(disabled.statusCode).toBe(200);
    expect((await ActivityShare.findOne({ sessionId: session._id }).lean()).enabled).toBe(false);
    expect((await redeem(firstCode, outsiderToken)).statusCode).toBe(404);
    const disabledStatus = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/activity-share`, {
      token: professorToken,
    });
    expect(disabledStatus.json()).toEqual({ enabled: false, code: null, expiresAt: null });

    const reenabled = await issue(session._id, professorToken);
    expect(reenabled.statusCode).toBe(200);
    expect(reenabled.json().code).toBe(firstCode);
    expect((await redeem(firstCode, outsiderToken)).statusCode).toBe(200);
    expect(await ActivityShare.countDocuments({ sessionId: session._id })).toBe(1);

    const regenerated = await issue(session._id, professorToken, { regenerate: true });
    expect(regenerated.statusCode).toBe(200);
    expect(regenerated.json().code).not.toBe(firstCode);
    expect((await redeem(firstCode, outsiderToken)).statusCode).toBe(404);
    expect((await redeem(regenerated.json().code, outsiderToken)).statusCode).toBe(200);
  });

  it('concurrent first enables expose the same single code', async () => {
    const { professorToken, session } = await fixture();
    const issued = await Promise.all([
      issue(session._id, professorToken), issue(session._id, professorToken), issue(session._id, professorToken),
    ]);
    expect(issued.every((response) => response.statusCode === 200)).toBe(true);
    expect(new Set(issued.map((response) => response.json().code)).size).toBe(1);
    expect(await ActivityShare.countDocuments({ sessionId: session._id })).toBe(1);
  });

  it('handles concurrent redemption as one grant', async () => {
    const { professorToken, outsiderToken, outsider, session } = await fixture();
    const code = (await issue(session._id, professorToken)).json().code;
    const responses = await Promise.all([
      redeem(code, outsiderToken), redeem(code, outsiderToken), redeem(code, outsiderToken),
    ]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(await ActivityGrant.countDocuments({ sessionId: session._id, userId: outsider._id })).toBe(1);
  });

  it('rotates the code while preserving grants, then disables access', async () => {
    const { professorToken, outsiderToken, outsider, session } = await fixture({ anonymous: true });
    const firstCode = (await issue(session._id, professorToken)).json().code;
    expect((await redeem(firstCode, outsiderToken)).statusCode).toBe(200);
    const { hasActivityGrant } = await import('../../src/services/activityAccess.js');
    expect(await hasActivityGrant(session._id, outsider._id)).toBe(true);

    const secondCode = (await issue(session._id, professorToken, { regenerate: true })).json().code;
    expect(secondCode).not.toBe(firstCode);
    expect((await redeem(firstCode, outsiderToken)).statusCode).toBe(404);
    expect((await redeem(secondCode, outsiderToken)).statusCode).toBe(200);
    expect(await hasActivityGrant(session._id, outsider._id)).toBe(true);

    const disabled = await authenticatedRequest(app, 'DELETE', `/api/v1/sessions/${session._id}/activity-share`, {
      token: professorToken,
    });
    expect(disabled.statusCode).toBe(200);
    expect(await hasActivityGrant(session._id, outsider._id)).toBe(false);
    expect((await redeem(secondCode, outsiderToken)).statusCode).toBe(404);
    const replacementCode = (await issue(session._id, professorToken)).json().code;
    expect(replacementCode).toBe(secondCode);
    expect(await hasActivityGrant(session._id, outsider._id)).toBe(false);
    expect((await redeem(replacementCode, outsiderToken)).statusCode).toBe(200);
    expect(await hasActivityGrant(session._id, outsider._id)).toBe(true);
    expect((await Session.findById(session._id).lean()).participationStarted).toBe(true);
  });

  it('rejects non-instructor management, expired codes, and unknown codes without disclosing a course', async () => {
    const { professorToken, outsiderToken, session, course } = await fixture();
    expect((await issue(session._id, outsiderToken)).statusCode).toBe(403);
    const status = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/activity-share`, {
      token: outsiderToken,
    });
    expect(status.statusCode).toBe(403);
    expect((await issue(session._id, professorToken, { expiresAt: '2020-01-01T00:00:00.000Z' })).statusCode).toBe(400);
    const invalid = await redeem('S-' + 'A'.repeat(7), outsiderToken);
    expect(invalid.statusCode).toBe(404);
    expect(JSON.stringify(invalid.json())).not.toContain(course.name);
    expect(await ActivityGrant.countDocuments({ sessionId: session._id })).toBe(0);
    const validCode = (await issue(session._id, professorToken)).json().code;
    await ActivityShare.updateOne({ sessionId: session._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await redeem(validCode, outsiderToken)).statusCode).toBe(404);
  });
});


describe('anonymous activity code boundary', () => {
  it('locks an anonymous survey after outsider redemption without exposing the respondent', async () => {
    const { professorToken, outsiderToken, outsider, course, session } = await fixture({ anonymous: true });
    const code = (await issue(session._id, professorToken)).json().code;
    const redeemed = await redeem(code, outsiderToken);
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json().anonymous).toBe(true);
    expect(JSON.stringify(redeemed.json())).not.toContain(outsider._id);
    const change = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}`, {
      token: professorToken, payload: { anonymous: false },
    });
    expect(change.statusCode).toBe(409);
    expect((await Course.findById(course._id).lean()).students).not.toContain(outsider._id);
    expect((await Session.findById(session._id).lean()).joined).toEqual([]);
  });
});


async function addQuestion({ session, course, professor, type = 2 }) {
  const question = await Question.create({
    type, creator: professor._id, sessionId: session._id, courseId: course._id,
    content: '<p>Survey question</p>', plainText: 'Survey question',
    options: type === 0 ? [{ content: 'Yes', correct: true }, { content: 'No', correct: false }] : [],
    sessionOptions: { hidden: false, attempts: [{ number: 1, closed: false }] },
  });
  await Session.updateOne({ _id: session._id }, { $addToSet: { questions: question._id } });
  return question;
}

describe('outside activity participation', () => {
  for (const anonymous of [false, true]) {
    it(`${anonymous ? 'anonymous' : 'named'} outside quiz keeps response identity and grade isolation`, async () => {
      const context = await fixture({ anonymous });
      const { professor, professorToken, outsider, outsiderToken, course, session } = context;
      const questions = [
        await addQuestion(context), await addQuestion(context),
      ];
      const now = Date.now();
      await Session.updateOne({ _id: session._id }, { $set: {
        status: 'visible', quizStart: new Date(now - 60000), quizEnd: new Date(now + 600000),
      } });
      const code = (await issue(session._id, professorToken)).json().code;
      expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
      const opened = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/quiz`, { token: outsiderToken });
      expect(opened.statusCode).toBe(200);
      expect(opened.json().questions).toHaveLength(2);
      expect(opened.json().session.quizExtensions).toBeUndefined();
      for (const question of questions) {
        const saved = await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/quiz-response`, {
          token: outsiderToken, payload: { questionId: question._id, answer: 'survey answer' },
        });
        expect(saved.statusCode).toBe(200);
      }
      const beforeResults = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/results`, { token: professorToken });
      expect(beforeResults.statusCode).toBe(anonymous ? 409 : 200);
      if (!anonymous) expect(beforeResults.json().studentResults).toEqual([]);
      const sent = vi.spyOn(app, 'wsSendToUsers');
      const submitted = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/submit`, { token: outsiderToken });
      expect(submitted.statusCode).toBe(200);
      const afterResults = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/results`, { token: professorToken });
      expect(afterResults.statusCode).toBe(anonymous ? 409 : 200);
      if (!anonymous) expect(afterResults.json().studentResults.map((row) => row.studentId)).toEqual([String(outsider._id)]);
      expect(sent.mock.calls.some(([ids, event]) => ids.includes(String(professor._id)) && event === 'session:quiz-submitted')).toBe(!anonymous);
      const response = await Response.findOne({ questionId: questions[0]._id }).lean();
      expect(response.studentUserId === outsider._id).toBe(!anonymous);
      expect(await Grade.countDocuments({ sessionId: session._id })).toBe(0);
      await Session.updateOne({ _id: session._id }, { $set: { status: 'done', reviewable: true } });
      const review = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/review`, { token: outsiderToken });
      expect(review.statusCode).toBe(200);
      expect(review.json().grade).toBeNull();
      const gradebook = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/grades`, { token: professorToken });
      expect(gradebook.statusCode).toBe(200);
      if (anonymous) expect(JSON.stringify(gradebook.json())).not.toContain(session._id);
      else expect(gradebook.json().sessions.some((entry) => entry._id === session._id)).toBe(true);
      expect(gradebook.json().rows).toHaveLength(0);
      const recalculate = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, { token: professorToken, payload: {} });
      expect(recalculate.statusCode).toBe(anonymous ? 409 : 200);
      expect(await Grade.countDocuments({ sessionId: session._id })).toBe(0);
      expect((await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}`, { token: outsiderToken })).statusCode).toBe(403);
    });

    it(`${anonymous ? 'anonymous' : 'named'} outside live activity respects the rotating join code`, async () => {
      const context = await fixture({ anonymous, quiz: false });
      const { professorToken, outsider, outsiderToken, course, session } = context;
      const question = await addQuestion({ ...context, type: 0 });
      await Session.updateOne({ _id: session._id }, { $set: {
        status: 'running', currentQuestion: question._id,
        joinCodeEnabled: true, joinCodeActive: true, currentJoinCode: '123456',
        chatEnabled: true,
      } });
      const code = (await issue(session._id, professorToken)).json().code;
      expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
      const before = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/live`, { token: outsiderToken });
      expect(before.statusCode).toBe(200);
      expect(before.json().session.chatEnabled).toBe(false);
      expect((await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/join`, {
        token: outsiderToken, payload: {},
      })).statusCode).toBe(400);
      const joined = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/join`, {
        token: outsiderToken, payload: { joinCode: '123456' },
      });
      expect(joined.statusCode).toBe(200);
      const roster = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/live?includeJoinedStudents=true`, { token: professorToken });
      if (anonymous) {
        expect(roster.json().session.joinedStudents || []).toEqual([]);
        expect(JSON.stringify(roster.json())).not.toContain('participantRole');
      } else {
        expect(roster.json().session.joinedStudents[0]).toMatchObject({ participantRole: 'guest', isProfessor: false });
      }

      await Question.updateOne({ _id: question._id }, { $set: { 'sessionOptions.stats': true } });
      const sendSpy = vi.spyOn(app, 'wsSendToUsers');
      const answered = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/respond`, {
        token: outsiderToken, payload: { answer: '0' },
      });
      expect(answered.statusCode).toBe(201);
      expect(sendSpy.mock.calls.some(([ids, event]) => event === 'session:response-added' && ids.includes(String(outsider._id)))).toBe(true);
      const response = await Response.findOne({ questionId: question._id }).lean();
      expect(response.studentUserId === outsider._id).toBe(!anonymous);
      expect(await Grade.countDocuments({ sessionId: session._id })).toBe(0);
      await authenticatedRequest(app, 'DELETE', `/api/v1/sessions/${session._id}/activity-share`, { token: professorToken });
      expect((await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/live`, { token: outsiderToken })).statusCode).toBe(403);
      sendSpy.mockClear();
      await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/question-visibility`, {
        token: professorToken, payload: { hidden: true },
      });
      expect(sendSpy.mock.calls.some(([ids, event]) => event === 'session:visibility-changed' && ids.includes(String(outsider._id)))).toBe(false);
    });
  }
});


describe('shared activity safeguards', () => {
  it('requires course opt-in and revokes outside access when the setting is turned off', async () => {
    const { professorToken, outsiderToken, course, session } = await fixture();
    await Course.updateOne({ _id: course._id }, { $set: { allowSharedActivities: false } });
    expect((await issue(session._id, professorToken)).statusCode).toBe(400);
    expect(await ActivityShare.countDocuments({ sessionId: session._id })).toBe(0);
    const courseUrl = `/api/v1/courses/${course._id}`;
    expect((await authenticatedRequest(app, 'PATCH', courseUrl, {
      token: professorToken, payload: { allowSharedActivities: true },
    })).statusCode).toBe(200);
    const code = (await issue(session._id, professorToken)).json().code;
    await Session.updateOne({ _id: session._id }, { $set: { status: 'visible', quizStart: new Date(Date.now() - 60_000), quizEnd: new Date(Date.now() + 600_000) } });
    expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
    expect((await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/quiz`, { token: outsiderToken })).statusCode).toBe(200);
    expect((await authenticatedRequest(app, 'PATCH', courseUrl, {
      token: professorToken, payload: { allowSharedActivities: false },
    })).statusCode).toBe(200);
    expect((await redeem(code, outsiderToken)).statusCode).toBe(404);
    expect((await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/quiz`, { token: outsiderToken })).statusCode).toBe(403);
    expect((await ActivityShare.findOne({ sessionId: session._id }).lean()).enabled).toBe(false);
    expect((await Session.findById(session._id).lean()).activityAccessEnabled).toBe(false);
    expect((await authenticatedRequest(app, 'PATCH', courseUrl, {
      token: professorToken, payload: { allowSharedActivities: true },
    })).statusCode).toBe(200);
    expect((await redeem(code, outsiderToken)).statusCode).toBe(404);
    expect((await issue(session._id, professorToken)).json().code).toBe(code);
  });

  it('rejects existing extensions when sharing and blocks new extensions even after sharing is disabled', async () => {
    const { professorToken, outsider, course, session } = await fixture();
    const start = new Date(Date.now() + 60_000);
    const end = new Date(Date.now() + 3_600_000);
    await Course.updateOne({ _id: course._id }, { $addToSet: { students: outsider._id } });
    const extensionPayload = { extensions: [{ userId: outsider._id, quizStart: start.toISOString(), quizEnd: end.toISOString() }] };
    const extensionUrl = `/api/v1/sessions/${session._id}/extensions`;
    const first = await authenticatedRequest(app, 'PATCH', extensionUrl, { token: professorToken, payload: extensionPayload });
    expect(first.statusCode).toBe(200);
    expect((await issue(session._id, professorToken)).statusCode).toBe(409);
    expect((await Session.findById(session._id).lean()).activityEverShared).toBe(false);
    expect(await ActivityShare.countDocuments({ sessionId: session._id })).toBe(0);
    expect((await authenticatedRequest(app, 'PATCH', extensionUrl, { token: professorToken, payload: { extensions: [] } })).statusCode).toBe(200);
    expect((await issue(session._id, professorToken)).statusCode).toBe(200);
    expect((await authenticatedRequest(app, 'PATCH', extensionUrl, { token: professorToken, payload: extensionPayload })).statusCode).toBe(409);
    expect((await authenticatedRequest(app, 'DELETE', `/api/v1/sessions/${session._id}/activity-share`, { token: professorToken })).statusCode).toBe(200);
    expect((await authenticatedRequest(app, 'PATCH', extensionUrl, { token: professorToken, payload: extensionPayload })).statusCode).toBe(409);
  });

  it('refuses sharing when the session already has guest grades', async () => {
    const { professorToken, outsider, course, session } = await fixture();
    await Grade.create({ userId: outsider._id, sessionId: session._id, courseId: course._id });
    expect((await issue(session._id, professorToken)).statusCode).toBe(409);
    expect((await Session.findById(session._id).lean()).activityEverShared).toBe(false);
    expect(await ActivityShare.countDocuments({ sessionId: session._id })).toBe(0);
  });

  it('labels enrolled students and guest professors consistently in joins, rosters, and results', async () => {
    const { professorToken, outsider, outsiderToken, course, session } = await fixture({ quiz: false });
    const enrolled = await createTestUser({ email: 'roster-enrolled@example.com', roles: ['student'] });
    const visitor = await createTestUser({ email: 'roster-professor@example.com', roles: ['professor'] });
    const enrolledToken = await getAuthToken(app, enrolled);
    const visitorToken = await getAuthToken(app, visitor);
    await Course.updateOne({ _id: course._id }, { $addToSet: { students: enrolled._id } });
    await Session.updateOne({ _id: session._id }, { $set: { status: 'running' } });
    const code = (await issue(session._id, professorToken)).json().code;
    for (const token of [outsiderToken, visitorToken]) expect((await redeem(code, token)).statusCode).toBe(200);
    const sendSpy = vi.spyOn(app, 'wsSendToUsers');
    for (const token of [outsiderToken, visitorToken, enrolledToken]) {
      expect((await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/join`, { token, payload: {} })).statusCode).toBe(200);
    }
    const joins = sendSpy.mock.calls.filter(([, event]) => event === 'session:participant-joined').map(([, , payload]) => payload.joinedStudent);
    expect(joins.find((row) => row._id === enrolled._id)).toMatchObject({ participantRole: 'student', isProfessor: false });
    expect(joins.find((row) => row._id === visitor._id)).toMatchObject({ participantRole: 'guest', isProfessor: true });
    // Current course enrollment determines the displayed role.
    await Course.updateOne({ _id: course._id }, { $addToSet: { students: outsider._id } });
    const roster = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/live?includeJoinedStudents=true`, { token: professorToken });
    expect(roster.statusCode).toBe(200);
    const joined = roster.json().session.joinedStudents;
    expect(joined.find((row) => row._id === outsider._id).participantRole).toBe('student');
    expect(joined.find((row) => row._id === visitor._id)).toMatchObject({ participantRole: 'guest', isProfessor: true });
    const results = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/results`, { token: professorToken });
    expect(results.statusCode).toBe(200);
    expect(results.json().studentResults.find((row) => row.studentId === enrolled._id)).toMatchObject({ participantRole: 'student' });
    expect(results.json().studentResults.find((row) => row.studentId === visitor._id)).toMatchObject({ participantRole: 'guest', isProfessor: true, guest: true });
  });

  it('keeps enrolled grades while tracking a named guest without a grade row', async () => {
    const context = await fixture();
    const { professorToken, outsider, outsiderToken, course, session } = context;
    const enrolled = await createTestUser({ email: 'share-enrolled@example.com', roles: ['student'] });
    const enrolledToken = await getAuthToken(app, enrolled);
    await Course.updateOne({ _id: course._id }, { $addToSet: { students: enrolled._id } });
    const question = await Question.create({
      type: 0, creator: context.professor._id, sessionId: session._id, courseId: course._id,
      content: '<p>Choose one</p>', plainText: 'Choose one',
      options: [{ content: 'Yes', correct: true }, { content: 'No', correct: false }],
      sessionOptions: { hidden: false, attempts: [{ number: 1, closed: false }] },
    });
    await Session.updateOne({ _id: session._id }, { $set: {
      questions: [question._id], status: 'visible', reviewable: true,
      quizStart: new Date(Date.now() - 60_000), quizEnd: new Date(Date.now() + 600_000),
    } });
    const initialGrade = await Grade.create({ userId: enrolled._id, sessionId: session._id, courseId: course._id });
    expect((await issue(session._id, professorToken)).statusCode).toBe(200);
    const code = (await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/activity-share`, { token: professorToken })).json().code;
    expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
    expect((await redeem(code, enrolledToken)).statusCode).toBe(200);
    expect((await ActivityGrant.findOne({ sessionId: session._id, userId: enrolled._id }).lean()).guestAtRedemption).toBe(false);
    for (const token of [enrolledToken, outsiderToken]) {
      expect((await authenticatedRequest(app, 'PATCH', `/api/v1/sessions/${session._id}/quiz-response`, {
        token, payload: { questionId: question._id, answer: '0' },
      })).statusCode).toBe(200);
      expect((await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/submit`, { token })).statusCode).toBe(200);
    }
    await Session.updateOne({ _id: session._id }, { $set: { status: 'done' } });
    const recalculate = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: professorToken, payload: {},
    });
    expect(recalculate.statusCode).toBe(200);
    expect(await Grade.countDocuments({ sessionId: session._id, userId: outsider._id })).toBe(0);
    expect(await Grade.countDocuments({ sessionId: session._id, userId: enrolled._id })).toBe(1);
    const currentGrade = await Grade.findById(initialGrade._id).lean();
    expect(currentGrade.marks).toHaveLength(1);
    const results = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/results`, { token: professorToken });
    expect(results.statusCode).toBe(200);
    expect(results.json().studentResults.find((row) => row.studentId === outsider._id)?.guest).toBe(true);
    expect(results.json().studentResults.find((row) => row.studentId === enrolled._id)?.guest).toBe(false);
    const grades = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/grades`, { token: professorToken });
    expect(grades.json().grades.map((grade) => grade.userId)).toEqual([enrolled._id]);
    const gradebook = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/grades`, { token: professorToken });
    expect(gradebook.json().rows.some((row) => row.student.studentId === enrolled._id)).toBe(true);
    expect(gradebook.json().rows.some((row) => row.student.studentId === outsider._id)).toBe(false);
    const studentReview = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/review`, { token: enrolledToken });
    expect(studentReview.json().grade).not.toBeNull();
    const guestReview = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/review`, { token: outsiderToken });
    expect(guestReview.json().grade).toBeNull();
  });

  it.each([
    { quiz: false, role: 'student', byEmail: false },
    { quiz: true, role: 'student', byEmail: false },
    { quiz: false, role: 'professor', byEmail: true },
    { quiz: true, role: 'professor', byEmail: true },
  ])('backfills a former guest and missed work without changing saved data ($quiz, $role)', async ({ quiz, role, byEmail }) => {
    const { professorToken, outsiderToken, outsider, course, session, professor } = await fixture({ quiz });
    await mongoose.model('User').updateOne({ _id: outsider._id }, { $set: { 'profile.roles': [role] } });
    const code = (await issue(session._id, professorToken)).json().code;
    expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
    const mc = await Question.create({ creator: professor._id, type: 0, courseId: course._id, sessionId: session._id,
      options: [{ answer: 'Yes', correct: true }, { answer: 'No', correct: false }],
      sessionOptions: { points: 2, maxAttempts: 2, attemptWeights: [1, 0.5] } });
    const sa = await Question.create({ creator: professor._id, type: 2, courseId: course._id, sessionId: session._id,
      sessionOptions: { points: 4 } });
    await Response.create([
      { questionId: mc._id, studentUserId: outsider._id, attempt: 1, answer: '1' },
      { questionId: mc._id, studentUserId: outsider._id, attempt: 2, answer: '0' },
      { questionId: sa._id, studentUserId: outsider._id, attempt: 1, answer: 'My explanation' },
    ]);
    await Session.updateOne({ _id: session._id }, { $set: {
      questions: [mc._id, sa._id], joined: [outsider._id], status: 'done', reviewable: true,
      submittedQuiz: quiz ? [outsider._id] : [],
    } });
    const missedQuestion = await Question.create({ creator: professor._id, type: 2, courseId: course._id, sessionOptions: { points: 4 } });
    const missed = await Session.create({ name: 'Missed', courseId: course._id, status: 'done', questions: [missedQuestion._id] });
    const expired = await Session.create({ name: 'Expired scheduled quiz', courseId: course._id,
      quiz: true, status: 'visible', quizEnd: new Date(Date.now() - 60_000), questions: [missedQuestion._id] });
    const existingSession = await Session.create({ name: 'Existing marks', courseId: course._id, status: 'done' });
    const existingGrade = await Grade.create({ courseId: course._id, sessionId: existingSession._id,
      userId: outsider._id, automatic: false, value: 73, visibleToStudents: true,
      marks: [{ questionId: 'manual-question', automatic: false, points: 3, outOf: 4, feedback: 'Keep this feedback' }] });
    const otherStudent = await createTestUser({ email: 'existing-grade@example.com', roles: ['student'] });
    await Course.updateOne({ _id: course._id }, { $addToSet: { students: otherStudent._id } });
    const otherGrade = await Grade.create({ courseId: course._id, sessionId: session._id,
      userId: otherStudent._id, automatic: false, value: 62, visibleToStudents: false });
    const skipped = await Session.create([
      { name: 'Anonymous', courseId: course._id, status: 'done', anonymous: true },
      { name: 'Practice', courseId: course._id, status: 'done', practiceQuiz: true },
      { name: 'Student created', courseId: course._id, status: 'done', studentCreated: true },
      { name: 'Draft', courseId: course._id, status: 'hidden' },
      { name: 'Live', courseId: course._id, status: 'running' },
      { name: 'Future quiz', courseId: course._id, quiz: true, status: 'visible', quizEnd: new Date(Date.now() + 60_000) },
      { name: 'Extension', courseId: course._id, quiz: true, status: 'done',
        quizExtensions: [{ userId: otherStudent._id, quizEnd: new Date(Date.now() + 60_000) }] },
    ]);
    const responsesBefore = await Response.find({ studentUserId: outsider._id }).sort('_id').lean();
    const sessionBefore = await Session.findById(session._id).lean();
    const enroll = () => authenticatedRequest(app, 'POST', byEmail ? `/api/v1/courses/${course._id}/students` : '/api/v1/courses/enroll', {
      token: byEmail ? professorToken : outsiderToken,
      payload: byEmail ? { email: outsider.emails[0].address } : { enrollmentCode: course.enrollmentCode },
    });
    expect((await enroll()).statusCode).toBe(200);
    const grade = await Grade.findOne({ sessionId: session._id, userId: outsider._id }).lean();
    expect(grade).toMatchObject({ points: 1, outOf: 6, needsGrading: true, visibleToStudents: true });
    expect(grade.marks.find((mark) => mark.questionId === mc._id)).toMatchObject({ attempt: 2, points: 1, needsGrading: false });
    expect(grade.marks.find((mark) => mark.questionId === sa._id)).toMatchObject({ needsGrading: true });
    for (const missedSession of [missed, expired]) {
      const zero = await Grade.findOne({ sessionId: missedSession._id, userId: outsider._id }).lean();
      expect(zero).toMatchObject({ value: 0, needsGrading: false, joined: false });
      expect(zero.marks.every((mark) => mark.points === 0 && !mark.needsGrading)).toBe(true);
    }
    expect(await Grade.countDocuments({ sessionId: { $in: skipped.map((entry) => entry._id) }, userId: outsider._id })).toBe(0);
    expect((await enroll()).statusCode).toBe(409); // Retrying repairs missing rows but never duplicates them.
    expect(await Grade.countDocuments({ sessionId: session._id, userId: outsider._id })).toBe(1);
    expect(await Grade.findById(existingGrade._id).lean()).toEqual(existingGrade.toObject());
    expect(await Grade.findById(otherGrade._id).lean()).toEqual(otherGrade.toObject());
    expect(await Response.find({ studentUserId: outsider._id }).sort('_id').lean()).toEqual(responsesBefore);
    const sessionAfter = await Session.findById(session._id).lean();
    expect(sessionAfter.joined).toEqual(sessionBefore.joined);
    expect(sessionAfter.submittedQuiz).toEqual(sessionBefore.submittedQuiz);
    // Redemption history remains an audit fact, not a grading exclusion.
    expect((await ActivityGrant.findOne({ sessionId: session._id, userId: outsider._id }).lean()).guestAtRedemption).toBe(true);
    const results = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/results`, { token: professorToken });
    expect(results.json().studentResults.find((row) => row.studentId === outsider._id)).toMatchObject({ guest: false, participantRole: 'student', isProfessor: role === 'professor' });
    const grades = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/grades`, { token: outsiderToken });
    expect(grades.statusCode).toBe(200);
    expect(grades.json().grades).toHaveLength(1);
    expect(grades.json().grades[0]).toMatchObject({ points: 1, outOf: 6, needsGrading: true });
    const review = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/review`, { token: outsiderToken });
    expect(review.json().grade).not.toBeNull();
    const gradebook = await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/grades`, { token: professorToken });
    const row = gradebook.json().rows.find((entry) => entry.student.studentId === outsider._id);
    expect(row.grades.find((entry) => entry.sessionId === session._id)).toMatchObject({ _id: grade._id, needsGrading: true });
    expect(row.grades.some((entry) => entry.notApplicable)).toBe(false);
    // Also support already-enrolled guests from the earlier branch implementation.
    await Grade.deleteOne({ _id: grade._id });
    const repaired = await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/grades/recalculate`, {
      token: professorToken, payload: { missingOnly: true },
    });
    expect(repaired.statusCode).toBe(200);
    const repairedGrade = await Grade.findOne({ sessionId: session._id, userId: outsider._id }).lean();
    expect(repairedGrade).toMatchObject({ points: 1, outOf: 6, needsGrading: true });
    expect(await Grade.countDocuments({ sessionId: session._id, userId: outsider._id })).toBe(1);
    expect((await Grade.findById(otherGrade._id).lean()).value).toBe(62);
  });

  it('keeps anonymous guest responses pseudonymous and ungraded after enrollment', async () => {
    const { professorToken, outsiderToken, outsider, course, session } = await fixture({ anonymous: true });
    const code = (await issue(session._id, professorToken)).json().code;
    expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
    const respondentId = getSessionParticipantId(session, outsider._id);
    const question = await Question.create({ creator: course.owner, courseId: course._id, type: 2 });
    await Response.create({ questionId: question._id, studentUserId: respondentId, attempt: 1, answer: 'Private survey response' });
    await Session.updateOne({ _id: session._id }, { $set: { status: 'done', questions: [question._id], joined: [respondentId] } });
    const responses = await Response.find({ questionId: question._id }).lean();
    const enrolled = await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
      token: outsiderToken, payload: { enrollmentCode: course.enrollmentCode },
    });
    expect(enrolled.statusCode).toBe(200);
    expect(await Grade.countDocuments({ sessionId: session._id })).toBe(0);
    expect(await Response.find({ questionId: question._id }).lean()).toEqual(responses);
    expect((await Session.findById(session._id).lean()).joined).toEqual([respondentId]);
    const results = await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/results`, { token: professorToken });
    expect(results.json().studentResults).toEqual([]);
    expect(JSON.stringify(results.json())).not.toContain(outsider._id);
  });

  it('keeps an existing grant usable after code expiry without admitting new people', async () => {
    const { professorToken, outsiderToken, session } = await fixture();
    const code = (await issue(session._id, professorToken)).json().code;
    expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
    await ActivityShare.updateOne({ sessionId: session._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
    const newcomer = await createTestUser({ email: 'share-newcomer@example.com' });
    const newcomerToken = await getAuthToken(app, newcomer);
    expect((await redeem(code, newcomerToken)).statusCode).toBe(404);
  });

  it('releases anonymous shared-activity answers per question while withholding sparse answers', async () => {
    const { professor, professorToken, outsider, course, session } = await fixture({ anonymous: true });
    const users = [outsider];
    for (let index = 1; index < 4; index += 1) {
      users.push(await createTestUser({ email: `survey-person-${index}@example.com` }));
    }
    const questions = [];
    for (let index = 0; index < 2; index += 1) {
      const question = await Question.create({
        type: 2, creator: professor._id, sessionId: session._id, courseId: course._id,
        content: `<p>Question ${index + 1}</p>`, plainText: `Question ${index + 1}`,
        sessionOptions: { hidden: false, attempts: [{ number: 1 }] },
      });
      questions.push(question);
    }
    await Session.updateOne({ _id: session._id }, { $set: {
      questions: questions.map((question) => question._id), status: 'done', reviewable: true,
    } });
    const code = (await issue(session._id, professorToken)).json().code;
    for (const [index, user] of users.entries()) {
      const token = await getAuthToken(app, user);
      expect((await redeem(code, token)).statusCode).toBe(200);
      const participantId = getSessionParticipantId(session, user._id);
      if (index < 3) {
        await Response.create({ questionId: questions[0]._id, studentUserId: participantId, attempt: 1, answer: `first-${index}` });
        await Response.create({ questionId: questions[1]._id, studentUserId: participantId, attempt: 1, answer: `second-${index}` });
      }
    }
    const resultsUrl = `/api/v1/sessions/${session._id}/results`;
    const withheld = await authenticatedRequest(app, 'GET', resultsUrl, { token: professorToken });
    expect(withheld.statusCode).toBe(200);
    expect(withheld.json().studentResults).toEqual([]);
    expect(withheld.json().anonymousSummary.responsesWithheld).toBe(true);
    await Response.create({
      questionId: questions[0]._id, studentUserId: getSessionParticipantId(session, users[3]._id),
      attempt: 1, answer: 'first-3',
    });
    const partialResponse = await authenticatedRequest(app, 'GET', resultsUrl, { token: professorToken });
    expect(partialResponse.statusCode).toBe(200);
    const partial = partialResponse.json();
    expect(partial.anonymousSummary).toMatchObject({ respondentCount: 4, responsesWithheld: true, minimumRespondents: 4 });
    expect(partial.questions.map((question) => question.anonymousResponseAttempts)).toEqual([
      [{ attempt: 1, respondentCount: 4, responsesWithheld: false, minimumRespondents: 4 }],
      [{ attempt: 1, respondentCount: 3, responsesWithheld: true, minimumRespondents: 4 }],
    ]);
    expect(partial.studentResults).toHaveLength(4);
    expect(partial.studentResults.map((row) => row.questionResults[0].responses[0].answer).sort())
      .toEqual(['first-0', 'first-1', 'first-2', 'first-3']);
    for (const row of partial.studentResults) {
      expect(row.studentId).toMatch(/^respondent-[1-4]$/);
      expect(row.participation).toBeNull();
      expect(row.questionResults).toHaveLength(2);
      expect(row.questionResults[0].responses).toHaveLength(1);
      expect(row.questionResults[1]).toEqual({ questionId: questions[1]._id, responses: [] });
    }
    const partialSerialized = JSON.stringify(partial);
    expect(partialSerialized).not.toContain('second-');
    for (const user of users) {
      expect(partialSerialized).not.toContain(user._id);
      expect(partialSerialized).not.toContain(getSessionParticipantId(session, user._id));
    }
    await Response.create({
      questionId: questions[1]._id, studentUserId: getSessionParticipantId(session, users[3]._id),
      attempt: 1, answer: 'second-3',
    });
    const released = await authenticatedRequest(app, 'GET', resultsUrl, { token: professorToken });
    expect(released.statusCode).toBe(200);
    expect(released.json().anonymousSummary.responsesWithheld).toBe(false);
    expect(released.json().questions.map((question) => question.anonymousResponseAttempts)).toEqual([
      [{ attempt: 1, respondentCount: 4, responsesWithheld: false, minimumRespondents: 4 }],
      [{ attempt: 1, respondentCount: 4, responsesWithheld: false, minimumRespondents: 4 }],
    ]);
    expect(released.json().studentResults).toHaveLength(4);
    for (const row of released.json().studentResults) {
      expect(row.studentId).toMatch(/^respondent-[1-4]$/);
      expect(row).not.toHaveProperty('participantRole');
      expect(row).not.toHaveProperty('isProfessor');
      expect(row).not.toHaveProperty('guest');
      expect(row.questionResults).toHaveLength(2);
      expect(row.questionResults.every((entry) => entry.responses.length === 1)).toBe(true);
      const firstAnswer = row.questionResults[0].responses[0].answer;
      expect(row.questionResults[1].responses[0].answer).toBe(firstAnswer.replace('first-', 'second-'));
      expect(partial.studentResults.find((entry) => entry.studentId === row.studentId).questionResults[0].responses[0].answer)
        .toBe(firstAnswer);
    }
    const serialized = JSON.stringify(released.json());
    for (const user of users) expect(serialized).not.toContain(user._id);
    expect(await Grade.countDocuments({ sessionId: session._id })).toBe(0);
  });
});

describe('upcoming interactive admission', () => {
  for (const anonymous of [false, true]) {
    it.each([false, true])(`waiting does not admit participants and current join codes apply (anonymous=${anonymous}, enrolled=%s)`, async (enrolled) => {
      const context = await fixture({ anonymous, quiz: false });
      const { professorToken, outsiderToken, outsider, course, session } = context;
      await addQuestion({ ...context, type: 0 });
      const call = (method, path, token, payload) => authenticatedRequest(app, method, `/api/v1/sessions/${session._id}${path}`, { token, payload });
      expect((await call('PATCH', '', professorToken, { status: 'visible' })).statusCode).toBe(200);
      if (enrolled) {
        expect((await authenticatedRequest(app, 'POST', '/api/v1/courses/enroll', {
          token: outsiderToken, payload: { enrollmentCode: course.enrollmentCode },
        })).statusCode).toBe(200);
      } else {
        const code = (await issue(session._id, professorToken)).json().code;
        expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
      }
      for (let read = 0; read < 2; read += 1) {
        const waiting = (await call('GET', '/live', outsiderToken)).json();
        expect(waiting).toMatchObject({ session: { status: 'visible' }, isJoined: false, currentQuestion: null });
      }
      expect((await call('POST', '/join', outsiderToken, {})).statusCode).toBe(400);
      let stored = await Session.findById(session._id).lean();
      expect(stored.joined).toEqual([]);
      expect(stored.joinRecords).toEqual([]);
      expect(!!stored.participationStarted).toBe(!enrolled); // Only code redemption has locked identity.
      expect((await call('PATCH', '', professorToken, { name: 'Edited while waiting', joinCodeEnabled: true })).statusCode).toBe(200);
      expect((await call('POST', '/start', professorToken)).statusCode).toBe(200);
      const beforeAdmission = (await call('GET', '/live', outsiderToken)).json();
      expect(beforeAdmission).toMatchObject({ session: { joinCodeEnabled: true, joinCodeActive: false }, isJoined: false, currentQuestion: null });
      expect((await call('POST', '/join', outsiderToken, {})).statusCode).toBe(403);
      const open = await call('PATCH', '/join-code-settings', professorToken, { joinCodeActive: true });
      expect(open.statusCode).toBe(200);
      const firstCode = open.json().session.currentJoinCode;
      expect((await call('POST', '/join', outsiderToken, {})).statusCode).toBe(400);
      expect((await call('POST', '/join', outsiderToken, { joinCode: 'wrong' })).statusCode).toBe(403);
      const rotated = await call('POST', '/refresh-join-code', professorToken, { force: true });
      expect(rotated.statusCode).toBe(200);
      const current = await Session.findById(session._id).lean();
      if (current.currentJoinCode !== firstCode) {
        expect((await call('POST', '/join', outsiderToken, { joinCode: firstCode })).statusCode).toBe(403);
      }
      const live = (await call('GET', '/live', outsiderToken)).json();
      expect(live.session.currentJoinCode).toBeUndefined();
      expect(live.isJoined).toBe(false);
      expect((await call('POST', '/join', outsiderToken, { joinCode: current.currentJoinCode })).statusCode).toBe(200);
      stored = await Session.findById(session._id).lean();
      expect(stored.joined).toEqual([getSessionParticipantId(stored, outsider._id)]);
      expect(stored.joinRecords).toHaveLength(anonymous ? 0 : 1);
      await call('PATCH', '/join-code-settings', professorToken, { joinCodeActive: false });
      expect((await call('GET', '/live', outsiderToken)).json().isJoined).toBe(true);
    });
  }
});

describe('shared interactive session chat', () => {
  afterEach(() => vi.restoreAllMocks());
  async function chatFixture(anonymous, professorGuest = false) {
    const context = await fixture({ anonymous, quiz: false, status: 'running' });
    const question = await addQuestion(context);
    await Session.updateOne({ _id: context.session._id }, { $set: {
      currentQuestion: question._id, chatEnabled: true,
      joinCodeEnabled: true, joinCodeActive: true, currentJoinCode: '123456',
    } });
    if (professorGuest) {
      context.outsider.profile.roles = ['professor'];
      await context.outsider.save();
      context.outsiderToken = await getAuthToken(app, context.outsider);
    }
    const code = (await issue(context.session._id, context.professorToken)).json().code;
    expect((await redeem(code, context.outsiderToken)).statusCode).toBe(200);
    const call = (method, suffix, payload, token = context.outsiderToken) => authenticatedRequest(
      app, method, `/api/v1/sessions/${context.session._id}${suffix}`, { token, payload }
    );
    return { ...context, call, code };
  }

  it.each([
    { anonymous: false, professorGuest: false }, { anonymous: true, professorGuest: false },
    { anonymous: false, professorGuest: true }, { anonymous: true, professorGuest: true },
  ])('supports guest chat with protected identity (anonymous=$anonymous, professorGuest=$professorGuest)', async ({ anonymous, professorGuest }) => {
    const { call, outsider, professor, professorToken, course, session } = await chatFixture(anonymous, professorGuest);
    expect((await call('GET', '/chat')).statusCode).toBe(403);
    expect((await call('POST', '/chat/posts', { body: 'Too early' })).statusCode).toBe(403);
    expect((await call('POST', '/join', { joinCode: '123456' })).statusCode).toBe(200);
    const live = await call('GET', '/live');
    expect(live.json().session.chatEnabled).toBe(true);
    const chat = await call('GET', '/chat');
    expect(chat.statusCode).toBe(200);
    expect(chat.json()).toMatchObject({ canPost: true, canVote: true, canViewNames: false, canDismiss: false });

    const sent = vi.spyOn(app, 'wsSendToUsers');
    const created = await call('POST', '/chat/posts', { body: 'Guest discussion' });
    expect(created.statusCode).toBe(200);
    const postId = created.json().postId;
    const comment = await call('POST', `/chat/posts/${postId}/comments`, { body: 'Guest follow-up' });
    expect(comment.statusCode).toBe(200);
    expect((await call('PATCH', `/chat/posts/${postId}`, { body: 'Edited guest discussion' })).statusCode).toBe(200);
    expect((await call('POST', '/chat/quick-posts/1/toggle')).statusCode).toBe(200);

    const profPost = await call('POST', '/chat/posts', { body: 'Instructor discussion' }, professorToken);
    expect((await call('PATCH', `/chat/posts/${profPost.json().postId}/vote`, { upvoted: true })).statusCode).toBe(200);
    for (const view of ['', '?view=presentation', '?view=review']) {
      const review = await call('GET', `/chat${view}`, undefined, professorToken);
      expect(review.statusCode).toBe(200);
      const entry = review.json().posts.find((post) => post._id === postId);
      expect(entry.authorName).toBe(anonymous || view === '?view=presentation' ? null : 'Test User');
      expect(entry.comments[0].authorName).toBe(anonymous || view === '?view=presentation' ? null : 'Test User');
      if (anonymous) {
        expect(JSON.stringify(review.json())).not.toContain(String(outsider._id));
        expect(JSON.stringify(review.json())).not.toContain(getSessionParticipantId({ ...session, anonymous }, outsider._id));
        expect(review.json().posts.every((post) => post.upvoterUserIds === undefined)).toBe(true);
      }
    }
    // The existing fanout is asynchronous for shared activities; assert delivery
    // without introducing sleeps or changing production broadcasting patterns.
    await vi.waitFor(() => expect(sent.mock.calls.some(([ids, event, payload]) => (
      ids.includes(String(outsider._id)) && event === 'session:chat-updated' && payload.post?.body === 'Instructor discussion'
    ))).toBe(true));
    const instructorGuestEvents = sent.mock.calls.filter(([ids, event, payload]) => (
      ids.includes(String(professor._id)) && event === 'session:chat-updated' && payload.post?._id === postId
    ));
    expect(instructorGuestEvents.length).toBeGreaterThan(0);
    if (anonymous) {
      for (const [, , payload] of instructorGuestEvents) {
        expect(payload.post.authorName).toBeNull();
        expect(payload.post.comments.every((entry) => entry.authorName === null)).toBe(true);
        expect(JSON.stringify(payload)).not.toContain(String(outsider._id));
      }
    }
    // A professor account joining as a guest still has participant permissions.
    expect((await call('PATCH', '/chat-settings', { chatEnabled: false })).statusCode).toBe(403);
    expect((await call('PATCH', `/chat/posts/${postId}/dismiss`)).statusCode).toBe(403);
    expect((await call('PATCH', `/chat/posts/${profPost.json().postId}`, { body: 'Hijack' })).statusCode).toBe(403);
    expect((await call('DELETE', `/chat/posts/${profPost.json().postId}`)).statusCode).toBe(403);
    expect((await call('DELETE', `/chat/posts/${postId}/comments/${comment.json().commentId}`)).statusCode).toBe(200);
    expect((await call('DELETE', `/chat/posts/${postId}`)).statusCode).toBe(200);
    expect((await Course.findById(course._id).lean()).students).not.toContain(outsider._id);
    expect(await Grade.countDocuments({ sessionId: session._id })).toBe(0);
  });

  it.each([false, true])('orders discussion by latest post, comment, or vote for every viewer (anonymous=%s)', async (anonymous) => {
    const { call, professorToken } = await chatFixture(anonymous);
    await call('POST', '/join', { joinCode: '123456' });
    const firstId = (await call('POST', '/chat/posts', { body: 'Older popular post' }, professorToken)).json().postId;
    const secondId = (await call('POST', '/chat/posts', { body: 'Recent post' }, professorToken)).json().postId;
    await Post.updateOne({ _id: firstId }, { $set: { createdAt: new Date('2020-01-01'), updatedAt: new Date('2020-01-01'), upvoteCount: 20 } });
    await Post.updateOne({ _id: secondId }, { $set: { createdAt: new Date('2020-01-02'), updatedAt: new Date('2020-01-02') } });
    const expectOrder = async (ids) => {
      for (const [view, token] of [['', undefined], ['', professorToken], ['?view=presentation', professorToken], ['?view=review', professorToken]]) {
        const response = await call('GET', `/chat${view}`, undefined, token);
        expect(response.statusCode).toBe(200);
        expect(response.json().posts.filter((post) => !post.isQuickPost).map((post) => post._id)).toEqual(ids);
      }
    };
    await expectOrder([secondId, firstId]);
    expect((await call('POST', `/chat/posts/${firstId}/comments`, { body: 'New discussion on older post' })).statusCode).toBe(200);
    await expectOrder([firstId, secondId]);
    expect((await call('PATCH', `/chat/posts/${secondId}/vote`, { upvoted: true })).statusCode).toBe(200);
    await expectOrder([secondId, firstId]);
  });

  it('keeps ordinary enrolled chat off the activity-grant lookup path', async () => {
    const context = await fixture({ quiz: false, status: 'running' });
    const { professorToken, outsiderToken, outsider, session, course } = context;
    const question = await addQuestion(context);
    await Course.updateOne({ _id: course._id }, { $addToSet: { students: outsider._id } });
    await Session.updateOne({ _id: session._id }, { $set: {
      currentQuestion: question._id, chatEnabled: true, joined: [outsider._id],
    } });
    const shareLookup = vi.spyOn(ActivityShare, 'findOne');
    const grantLookup = vi.spyOn(ActivityGrant, 'exists');
    const grantRecipients = vi.spyOn(ActivityGrant, 'find');
    for (const token of [outsiderToken, professorToken]) {
      expect((await authenticatedRequest(app, 'GET', `/api/v1/sessions/${session._id}/chat`, { token })).statusCode).toBe(200);
      expect((await authenticatedRequest(app, 'POST', `/api/v1/sessions/${session._id}/chat/posts`, {
        token, payload: { body: 'Ordinary course discussion' },
      })).statusCode).toBe(200);
    }
    expect(shareLookup).not.toHaveBeenCalled();
    expect(grantLookup).not.toHaveBeenCalled();
    expect(grantRecipients).not.toHaveBeenCalled();
  });

  it.each([false, true])('enforces admission, scope, revocation and chat settings (anonymous=%s)', async (anonymous) => {
    const { call, outsiderToken, professorToken, session, course, code, outsider } = await chatFixture(anonymous);
    expect((await call('POST', '/join', { joinCode: '123456' })).statusCode).toBe(200);
    const postId = (await call('POST', '/chat/posts', { body: 'Own post' })).json().postId;
    const commentId = (await call('POST', `/chat/posts/${postId}/comments`, { body: 'Own comment' })).json().commentId;
    const operations = [
      ['GET', '/chat'], ['POST', '/chat/posts', { body: 'Forbidden post' }],
      ['POST', '/chat/quick-posts/1/toggle'], ['PATCH', `/chat/posts/${postId}`, { body: 'Forbidden edit' }],
      ['PATCH', `/chat/posts/${postId}/vote`, { upvoted: true }],
      ['POST', `/chat/posts/${postId}/comments`, { body: 'Forbidden comment' }],
      ['DELETE', `/chat/posts/${postId}`], ['DELETE', `/chat/posts/${postId}/comments/${commentId}`],
    ];
    const assertDenied = async () => {
      for (const [method, suffix, payload] of operations) {
        expect((await call(method, suffix, payload)).statusCode, `${method} ${suffix}`).toBe(403);
      }
    };
    for (const status of ['hidden', 'visible', 'done']) {
      await Session.updateOne({ _id: session._id }, { $set: { status } });
      await assertDenied();
    }
    await Session.updateOne({ _id: session._id }, { $set: { status: 'running' } });
    const unrelated = await Session.create({ name: 'Other activity', courseId: course._id, status: 'running', chatEnabled: true });
    expect((await authenticatedRequest(app, 'GET', `/api/v1/sessions/${unrelated._id}/chat`, { token: outsiderToken })).statusCode).toBe(403);
    expect((await authenticatedRequest(app, 'GET', `/api/v1/courses/${course._id}/chat`, { token: outsiderToken })).statusCode).toBe(403);

    // Disabled rich text still permits quick posts; disabling chat blocks writes.
    expect((await call('PATCH', '/chat-settings', { richTextChatEnabled: false }, professorToken)).statusCode).toBe(200);
    expect((await call('POST', '/chat/posts', { body: 'Unavailable' })).statusCode).toBe(403);
    expect((await call('POST', `/chat/posts/${postId}/comments`, { body: 'Unavailable' })).statusCode).toBe(403);
    expect((await call('POST', '/chat/quick-posts/1/toggle')).statusCode).toBe(200);
    expect((await call('PATCH', '/chat-settings', { chatEnabled: false }, professorToken)).statusCode).toBe(200);
    expect((await call('POST', '/chat/quick-posts/1/toggle')).statusCode).toBe(403);
    expect((await call('PATCH', '/chat-settings', { chatEnabled: true, richTextChatEnabled: true }, professorToken)).statusCode).toBe(200);
    for (const restriction of [{ allowSharedActivities: false }, { inactive: true }]) {
      await Course.updateOne({ _id: course._id }, { $set: restriction });
      await assertDenied();
      expect(await getActivityRecipientUserIds(await Session.findById(session._id).lean(), await Course.findById(course._id).lean())).toEqual([]);
      await Course.updateOne({ _id: course._id }, { $set: { allowSharedActivities: true, inactive: false } });
    }
    expect((await call('DELETE', '/activity-share', undefined, professorToken)).statusCode).toBe(200);
    await assertDenied();
    // Re-enabling does not restore an old grant, even though joined still contains the participant.
    expect((await issue(session._id, professorToken)).statusCode).toBe(200);
    await assertDenied();
    const enrolled = await createTestUser({ email: 'chat-enrolled@example.com' });
    await Course.updateOne({ _id: course._id }, { $addToSet: { students: enrolled._id } });
    await Session.updateOne({ _id: session._id }, { $addToSet: { joined: getSessionParticipantId({ ...session, anonymous }, enrolled._id) } });
    const sent = vi.spyOn(app, 'wsSendToUsers');
    expect((await call('POST', '/chat/posts', { body: 'Only current participants' }, professorToken)).statusCode).toBe(200);
    await call('PATCH', '/chat-settings', { chatEnabled: true }, professorToken);
    // Delivery to the enrolled participant confirms that asynchronous fanout finished.
    for (const expectedEvent of ['session:chat-updated', 'session:chat-settings-changed']) {
      await vi.waitFor(() => expect(sent.mock.calls.some(([ids, event]) => ids.includes(String(enrolled._id)) && event === expectedEvent)).toBe(true));
    }
    expect(sent.mock.calls.some(([ids, event]) => ids.includes(String(outsider._id)) && event.startsWith('session:chat-'))).toBe(false);
    expect((await redeem(code, outsiderToken)).statusCode).toBe(200);
    expect((await call('GET', '/chat')).statusCode).toBe(200);
  });
});
