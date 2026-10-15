import ActivityShare from '../models/ActivityShare.js';
import Course from '../models/Course.js';
import Grade from '../models/Grade.js';
import AiGradingJob from '../models/AiGradingJob.js';
import Session from '../models/Session.js';
import { getDisplayActivityCode, issueActivityCode, redeemActivityCode } from '../services/activityAccess.js';
import { isCourseInstructorOrAdmin } from '../utils/courseAccess.js';

const sessionParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1 } },
};
const codeStatus = {
  type: 'object',
  required: ['enabled', 'code'],
  properties: {
    enabled: { type: 'boolean' },
    code: { type: ['string', 'null'] },
    expiresAt: { type: ['string', 'null'], format: 'date-time' },
  },
};

async function loadInstructorSession(request, reply) {
  const session = await Session.findById(request.params.id).lean();
  if (!session) {
    reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
    return null;
  }
  const course = await Course.findById(session.courseId).lean();
  if (!course || !isCourseInstructorOrAdmin(course, request.user)) {
    reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
    return null;
  }
  return { session, course };
}

export default async function activityAccessRoutes(app) {
  app.get('/sessions/:id/activity-share', {
    preHandler: app.authenticate,
    schema: { params: sessionParams, response: { 200: codeStatus } },
  }, async (request, reply) => {
    const context = await loadInstructorSession(request, reply);
    if (!context) return;
    const share = await ActivityShare.findOne({ sessionId: request.params.id })
      .select('enabled expiresAt codeHash codeSeed').lean();
    const enabled = !!share?.enabled && !!context.course.allowSharedActivities;
    return { enabled, code: enabled ? getDisplayActivityCode(share) : null, expiresAt: enabled ? share.expiresAt : null };
  });

  app.post('/sessions/:id/activity-share', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      params: sessionParams,
      body: {
        type: 'object',
        properties: { expiresAt: { type: 'string', format: 'date-time' }, regenerate: { type: 'boolean' } },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          required: ['code', 'expiresAt'],
          properties: {
            code: { type: 'string' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const context = await loadInstructorSession(request, reply);
    if (!context) return;
    if (context.session.practiceQuiz || context.session.studentCreated || context.course.inactive || !context.course.allowSharedActivities) {
      return reply.code(400).send({ error: 'Bad Request', message: 'This session cannot be shared by activity code' });
    }
    const now = Date.now();
    const expiresAt = request.body?.expiresAt
      ? new Date(request.body.expiresAt)
      : new Date(now + 30 * 24 * 60 * 60 * 1000);
    if (expiresAt.getTime() <= now || expiresAt.getTime() > now + 365 * 24 * 60 * 60 * 1000) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Expiry must be within the next year' });
    }
    if (context.session.anonymous && await Grade.exists({ sessionId: context.session._id })) {
      return reply.code(409).send({ error: 'Conflict', message: 'Remove existing grades before sharing this anonymous activity' });
    }
    if (!context.session.anonymous && await Grade.exists({
      sessionId: context.session._id,
      userId: { $nin: context.course.students || [] },
    })) {
      return reply.code(409).send({ error: 'Conflict', message: 'Remove existing grades for people outside the course before sharing this activity' });
    }
    if (await AiGradingJob.exists({ sessionId: context.session._id, status: { $in: ['queued', 'running'] } })) {
      return reply.code(409).send({ error: 'Conflict', message: 'Wait for AI grading to finish before sharing this activity' });
    }
    const updated = await Session.updateOne(
      { _id: context.session._id, 'quizExtensions.0': { $exists: false } },
      { $set: { activityEverShared: true, activityAccessEnabled: true } }
    );
    if (!updated.matchedCount) {
      return reply.code(409).send({ error: 'Conflict', message: 'Remove individual quiz extensions before sharing this activity' });
    }
    const issued = await issueActivityCode(context.session._id, expiresAt, { regenerate: request.body?.regenerate === true });
    // A course switch can be turned off while issuance is in flight. Fail
    // closed and revoke this code before returning it to the instructor.
    const stillAllowed = await Course.exists({ _id: context.course._id, allowSharedActivities: true, inactive: { $ne: true } });
    if (!stillAllowed) {
      const revoked = await ActivityShare.updateOne(
        { sessionId: context.session._id, codeHash: issued.share.codeHash },
        { $set: { enabled: false, updatedAt: new Date() }, $inc: { accessEpoch: 1 } }
      );
      if (revoked.matchedCount) {
        await Session.updateOne({ _id: context.session._id }, { $set: { activityAccessEnabled: false } });
      }
      return reply.code(409).send({ error: 'Conflict', message: 'Activity sharing is disabled for this course' });
    }
    // The code is derived from a random seed and the server secret; only its hash and seed are persisted.
    return { code: issued.code, expiresAt: issued.share.expiresAt.toISOString() };
  });

  app.delete('/sessions/:id/activity-share', {
    preHandler: app.authenticate,
    schema: { params: sessionParams, response: { 200: codeStatus } },
  }, async (request, reply) => {
    if (!await loadInstructorSession(request, reply)) return;
    await ActivityShare.updateOne(
      { sessionId: request.params.id },
      { $set: { enabled: false, updatedAt: new Date() }, $inc: { accessEpoch: 1 } }
    );
    await Session.updateOne({ _id: request.params.id }, { $set: { activityAccessEnabled: false } });
    return { enabled: false, code: null, expiresAt: null };
  });

  app.post('/activity-codes/redeem', {
    preHandler: app.authenticate,
    config: { rateLimit: {
      max: 10, timeWindow: '1 minute', hook: 'preHandler',
      keyGenerator: (request) => String(request.user?.userId || request.ip),
    } },
    schema: {
      body: {
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string', minLength: 1, maxLength: 80 } },
        additionalProperties: false,
      },
      response: {
        200: {
          type: 'object',
          required: ['sessionId', 'courseId', 'name', 'quiz', 'anonymous'],
          properties: {
            sessionId: { type: 'string' },
            courseId: { type: 'string' },
            name: { type: 'string' },
            quiz: { type: 'boolean' },
            anonymous: { type: 'boolean' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const activity = await redeemActivityCode(request.body.code, request.user.userId);
    if (!activity) {
      return reply.code(404).send({ error: 'Not Found', message: 'Invalid or unavailable activity code' });
    }
    return activity;
  });
}
