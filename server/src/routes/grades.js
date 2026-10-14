import Course from '../models/Course.js';
import Grade from '../models/Grade.js';
import Question from '../models/Question.js';
import Response from '../models/Response.js';
import Session from '../models/Session.js';
import User from '../models/User.js';
import {
  getStudentSessionReviewRestriction,
  isCourseInstructorOrAdmin as isInstructorOrAdmin,
  isCourseMember,
  studentReviewableSessionQuery,
  studentVisibleGradeQuery,
} from '../utils/courseAccess.js';
import {
  calculateResponsePoints,
  ensureSessionMsScoringMethod,
  getSessionMsScoringMethod,
  getSessionGradingLockReason,
  getSessionUngradedSummary,
  hasNonEmptyFeedback,
  isQuestionAutoGradeable,
  normalizeGradesManualGradingState,
  recalculateSessionGrades,
  recomputeGradeAggregates,
  sanitizeStudentVisibleGrade,
  setSessionGradesVisibility,
} from '../services/grading.js';

function normalizeAnswerValue(answer) {
  if (answer === null || answer === undefined) return '';
  return String(answer).trim();
}

function parseBooleanLike(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return false;
}

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function formatUserDisplayName(user) {
  const first = normalizeAnswerValue(user?.profile?.firstname);
  const last = normalizeAnswerValue(user?.profile?.lastname);
  const fullName = `${first} ${last}`.trim();
  if (fullName) return fullName;
  return user?.emails?.[0]?.address || user?.email || 'Unknown Student';
}

function getGradeIdentityFilter(grade) {
  return {
    sessionId: String(grade?.sessionId || ''),
    courseId: String(grade?.courseId || ''),
    userId: String(grade?.userId || ''),
  };
}

function ensureSessionEndedForGrading(session, reply) {
  if (session?.anonymous) {
    reply.code(409).send({ error: 'Conflict', message: 'Anonymous sessions do not have grades' });
    return false;
  }
  const reason = getSessionGradingLockReason(session);
  if (!reason) return true;
  reply.code(409).send({
    error: 'Conflict',
    message: reason === 'extensions'
      ? 'Grading is locked until all quiz extensions have expired or been removed'
      : 'Session must be in Ended state before grades can be edited or recalculated',
  });
  return false;
}

function notifyFeedbackUpdatedForUser(app, userId, course, sessionId) {
  const normalizedUserId = normalizeAnswerValue(userId);
  if (!normalizedUserId || !course || !sessionId) return;
  if (typeof app.wsSendToUser === 'function') {
    app.wsSendToUser(normalizedUserId, 'session:feedback-updated', {
      courseId: String(course._id),
      sessionId: String(sessionId),
    });
    return;
  }
  if (typeof app.wsSendToUsers === 'function') {
    app.wsSendToUsers([normalizedUserId], 'session:feedback-updated', {
      courseId: String(course._id),
      sessionId: String(sessionId),
    });
  }
}

function parseSessionIds(queryValue) {
  if (!queryValue) return [];
  if (Array.isArray(queryValue)) {
    return [...new Set(queryValue.map((entry) => normalizeAnswerValue(entry)).filter(Boolean))];
  }
  return [...new Set(
    String(queryValue)
      .split(',')
      .map((entry) => normalizeAnswerValue(entry))
      .filter(Boolean)
  )];
}

function compareStudentsByLastName(a, b) {
  const aLast = normalizeAnswerValue(a?.profile?.lastname);
  const bLast = normalizeAnswerValue(b?.profile?.lastname);
  const lastCmp = aLast.localeCompare(bLast);
  if (lastCmp !== 0) return lastCmp;

  const aFirst = normalizeAnswerValue(a?.profile?.firstname);
  const bFirst = normalizeAnswerValue(b?.profile?.firstname);
  const firstCmp = aFirst.localeCompare(bFirst);
  if (firstCmp !== 0) return firstCmp;

  const aEmail = normalizeAnswerValue(a?.emails?.[0]?.address || a?.email);
  const bEmail = normalizeAnswerValue(b?.emails?.[0]?.address || b?.email);
  return aEmail.localeCompare(bEmail);
}

const recalcSchema = {
  body: {
    type: 'object',
    properties: {
      missingOnly: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const visibilitySchema = {
  body: {
    type: 'object',
    required: ['visibleToStudents'],
    properties: {
      visibleToStudents: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const markUpdateSchema = {
  body: {
    type: 'object',
    properties: {
      points: { type: 'number', minimum: 0 },
      feedback: { type: 'string' },
      needsGrading: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const bulkMarkUpdateSchema = {
  body: {
    type: 'object',
    required: ['gradeIds'],
    properties: {
      gradeIds: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
      points: { type: 'number', minimum: 0 },
      feedback: { type: 'string' },
      needsGrading: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

function buildGradeUpdateSet(nextGrade) {
  return {
    marks: nextGrade.marks,
    points: nextGrade.points,
    value: nextGrade.value,
    automatic: nextGrade.automatic,
    needsGrading: nextGrade.needsGrading,
    participation: nextGrade.participation,
    numAnswered: nextGrade.numAnswered,
    numQuestions: nextGrade.numQuestions,
    numAnsweredTotal: nextGrade.numAnsweredTotal,
    numQuestionsTotal: nextGrade.numQuestionsTotal,
  };
}

function applyMarkUpdateToGrade(grade, questionId, updates) {
  const marks = Array.isArray(grade.marks) ? grade.marks.map((mark) => ({ ...mark })) : [];
  const markIndex = marks.findIndex((mark) => String(mark.questionId) === String(questionId));
  if (markIndex === -1) {
    return null;
  }

  const nextMark = { ...marks[markIndex] };
  let feedbackStateChanged = false;
  let scoreStateChanged = false;

  if (updates.points !== undefined) {
    nextMark.points = toFiniteNumber(updates.points, 0);
    nextMark.automatic = false;
    nextMark.needsGrading = updates.needsGrading !== undefined ? !!updates.needsGrading : false;
    scoreStateChanged = true;
  } else if (updates.needsGrading !== undefined) {
    nextMark.needsGrading = !!updates.needsGrading;
  }

  if (updates.feedback !== undefined) {
    const previousFeedback = nextMark.feedback || '';
    const nextFeedback = updates.feedback || '';
    const feedbackChanged = nextFeedback !== previousFeedback;
    nextMark.feedback = nextFeedback;

    if (hasNonEmptyFeedback(nextFeedback)) {
      if (feedbackChanged || !nextMark.feedbackUpdatedAt) {
        nextMark.feedbackUpdatedAt = new Date();
        feedbackStateChanged = true;
      }
    } else {
      if (hasNonEmptyFeedback(previousFeedback) || nextMark.feedbackUpdatedAt) {
        feedbackStateChanged = true;
      }
      nextMark.feedbackUpdatedAt = null;
    }
  }

  if (updates.points !== undefined || updates.feedback !== undefined) {
    nextMark.aiGraded = false;
  }

  marks[markIndex] = nextMark;

  const nextGrade = {
    ...grade,
    marks,
  };
  if (scoreStateChanged) {
    nextGrade.automatic = true;
  }
  recomputeGradeAggregates(nextGrade);

  return {
    nextGrade,
    feedbackStateChanged,
  };
}

const gradeValueSchema = {
  body: {
    type: 'object',
    required: ['value'],
    properties: {
      value: { type: 'number' },
    },
    additionalProperties: false,
  },
};

export default async function gradeRoutes(app) {
  const { authenticate } = app;

  app.post(
    '/sessions/:id/grades/recalculate',
    {
      preHandler: authenticate,
      schema: recalcSchema,
    },
    async (request, reply) => {
      const session = await Session.findById(request.params.id).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(session.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      if (!ensureSessionEndedForGrading(session, reply)) {
        return undefined;
      }

      const missingOnly = !!request.body?.missingOnly;
      const result = await recalculateSessionGrades({
        sessionId: session._id,
        sessionDoc: session,
        courseDoc: course,
        missingOnly,
        visibleToStudents: session.reviewable,
      });

      return {
        summary: result.summary,
      };
    }
  );

  app.get(
    '/sessions/:id/grades',
    {
      preHandler: authenticate,
      schema: {
        description: 'Read grades without creating missing rows. Instructor responses include gradingLockReason: not-ended, extensions, missing-grades, anonymous, or null. Anonymous sessions never have grades.',
      },
      config: {
        rateLimit: { max: 120, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const session = await Session.findById(request.params.id).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(session.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isCourseMember(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      const instructorView = isInstructorOrAdmin(course, request.user);

      if (!instructorView) {
        const restriction = getStudentSessionReviewRestriction(session, request.user, { allowOwnedStudentSession: false });
        if (restriction) {
          const message = restriction === 'not-finished' ? 'Session is not yet finished' : 'Session is not reviewable';
          return reply.code(403).send({ error: 'Forbidden', message });
        }
      }

      if (session.anonymous) {
        return {
          sessionId: String(session._id),
          courseId: String(course._id),
          instructorView,
          anonymous: !!session.anonymous,
          ...(instructorView ? { gradingLockReason: 'anonymous' } : {}),
          grades: [],
        };
      }

      const eligibleStudents = session.activityEverShared
        ? (course.students || [])
        : [];
      const gradeQuery = instructorView
        ? { sessionId: String(session._id), courseId: String(course._id),
          ...(session.activityEverShared ? { userId: { $in: eligibleStudents } } : {}) }
        : studentVisibleGradeQuery(course._id, session._id, request.user);

      let grades = await normalizeGradesManualGradingState(await Grade.find(gradeQuery).lean());
      if (!instructorView) grades = grades.map(sanitizeStudentVisibleGrade);

      return {
        sessionId: String(session._id),
        courseId: String(course._id),
        instructorView,
        ...(instructorView ? { gradingLockReason: getSessionGradingLockReason(session) || (grades.length ? null : 'missing-grades') } : {}),
        grades,
      };
    }
  );

  app.patch(
    '/sessions/:id/grades/visibility',
    {
      preHandler: authenticate,
      schema: visibilitySchema,
    },
    async (request, reply) => {
      const session = await Session.findById(request.params.id).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(session.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      await setSessionGradesVisibility({
        sessionId: session._id,
        visibleToStudents: request.body.visibleToStudents,
      });

      return {
        success: true,
        visibleToStudents: !!request.body.visibleToStudents,
      };
    }
  );

  app.patch(
    '/sessions/:id/grades/marks/:questionId',
    {
      preHandler: authenticate,
      schema: bulkMarkUpdateSchema,
      rateLimit: { max: 120, timeWindow: '1 minute' },
      config: {
        rateLimit: { max: 120, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const session = await Session.findById(request.params.id).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(session.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      if (!ensureSessionEndedForGrading(session, reply)) {
        return undefined;
      }

      const gradeIds = [...new Set(
        (Array.isArray(request.body?.gradeIds) ? request.body.gradeIds : [])
          .map((gradeId) => normalizeAnswerValue(gradeId))
          .filter(Boolean)
      )];
      if (gradeIds.length === 0) {
        return reply.code(400).send({ error: 'Bad Request', message: 'At least one grade is required' });
      }

      const grades = await Grade.find({
        _id: { $in: gradeIds },
        sessionId: session._id,
        courseId: course._id,
      }).lean();

      if (grades.length !== gradeIds.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'One or more grades were not found' });
      }

      const questionId = String(request.params.questionId);
      const nextGrades = [];
      const feedbackChangedUserIds = new Set();

      grades.forEach((grade) => {
        const result = applyMarkUpdateToGrade(grade, questionId, request.body);
        if (!result) {
          return;
        }
        if (result.feedbackStateChanged) {
          feedbackChangedUserIds.add(String(grade.userId));
        }
        nextGrades.push({
          originalGrade: grade,
          updatedGrade: result.nextGrade,
        });
      });

      if (nextGrades.length !== gradeIds.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'Mark not found for one or more grades' });
      }

      await Grade.bulkWrite(nextGrades.map(({ originalGrade, updatedGrade }) => ({
        updateMany: {
          filter: getGradeIdentityFilter(originalGrade),
          update: {
            $set: buildGradeUpdateSet(updatedGrade),
          },
        },
      })));

      const updatedGrades = await Grade.find({ _id: { $in: gradeIds } }).lean();
      feedbackChangedUserIds.forEach((userId) => {
        notifyFeedbackUpdatedForUser(app, userId, course, session._id);
      });

      return {
        updatedCount: updatedGrades.length,
        grades: await normalizeGradesManualGradingState(updatedGrades),
      };
    }
  );

  app.patch(
    '/grades/:gradeId/marks/:questionId',
    {
      preHandler: authenticate,
      schema: markUpdateSchema,
    },
    async (request, reply) => {
      const grade = await Grade.findById(request.params.gradeId).lean();
      if (!grade) {
        return reply.code(404).send({ error: 'Not Found', message: 'Grade not found' });
      }

      const course = await Course.findById(grade.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const session = await Session.findById(grade.sessionId).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!ensureSessionEndedForGrading(session, reply)) {
        return undefined;
      }

      const result = applyMarkUpdateToGrade(grade, request.params.questionId, request.body);
      if (!result) {
        return reply.code(404).send({ error: 'Not Found', message: 'Mark not found for question' });
      }

      await Grade.updateMany(
        getGradeIdentityFilter(grade),
        {
          $set: buildGradeUpdateSet(result.nextGrade),
        }
      );

      const updated = await Grade.findOne(getGradeIdentityFilter(grade)).lean();
      if (result.feedbackStateChanged) {
        notifyFeedbackUpdatedForUser(app, grade.userId, course, grade.sessionId);
      }
      return { grade: (await normalizeGradesManualGradingState([updated]))[0] };
    }
  );

  app.post(
    '/grades/:gradeId/marks/:questionId/set-automatic',
    { preHandler: authenticate },
    async (request, reply) => {
      const grade = await Grade.findById(request.params.gradeId).lean();
      if (!grade) {
        return reply.code(404).send({ error: 'Not Found', message: 'Grade not found' });
      }

      const course = await Course.findById(grade.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      let session = await Session.findById(grade.sessionId).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!ensureSessionEndedForGrading(session, reply)) {
        return undefined;
      }
      const msNormalization = await ensureSessionMsScoringMethod(session);
      session = msNormalization.session || session;

      const questionId = String(request.params.questionId);
      const marks = Array.isArray(grade.marks) ? grade.marks.map((mark) => ({ ...mark })) : [];
      const markIndex = marks.findIndex((mark) => String(mark.questionId) === questionId);

      if (markIndex === -1) {
        return reply.code(404).send({ error: 'Not Found', message: 'Mark not found for question' });
      }

      const question = await Question.findById(questionId).lean();
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      if (!isQuestionAutoGradeable(question.type)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Question type cannot be graded automatically',
        });
      }

      const mark = { ...marks[markIndex] };

      let response = null;
      if (mark.responseId) {
        response = await Response.findById(mark.responseId).lean();
      }

      if (!response) {
        response = await Response.findOne({
          questionId,
          studentUserId: grade.userId,
        })
          .sort({ attempt: -1, updatedAt: -1, createdAt: -1 })
          .lean();
      }

      mark.points = calculateResponsePoints(question, response, {
        msScoringMethod: getSessionMsScoringMethod(session),
      });
      mark.automatic = true;
      mark.needsGrading = false;
      mark.attempt = response ? toFiniteNumber(response.attempt, 1) : 0;
      mark.responseId = response ? String(response._id || '') : '';

      marks[markIndex] = mark;

      const nextGrade = {
        ...grade,
        marks,
        automatic: true,
      };
      recomputeGradeAggregates(nextGrade);

      await Grade.updateMany(
        getGradeIdentityFilter(grade),
        {
          $set: {
            marks: nextGrade.marks,
            points: nextGrade.points,
            value: nextGrade.value,
            automatic: nextGrade.automatic,
            needsGrading: nextGrade.needsGrading,
            participation: nextGrade.participation,
            numAnswered: nextGrade.numAnswered,
            numQuestions: nextGrade.numQuestions,
            numAnsweredTotal: nextGrade.numAnsweredTotal,
            numQuestionsTotal: nextGrade.numQuestionsTotal,
          },
        }
      );

      const updated = await Grade.findOne(getGradeIdentityFilter(grade)).lean();
      return { grade: (await normalizeGradesManualGradingState([updated]))[0] };
    }
  );

  app.patch(
    '/grades/:gradeId/value',
    {
      preHandler: authenticate,
      schema: gradeValueSchema,
    },
    async (request, reply) => {
      const grade = await Grade.findById(request.params.gradeId).lean();
      if (!grade) {
        return reply.code(404).send({ error: 'Not Found', message: 'Grade not found' });
      }

      const course = await Course.findById(grade.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const session = await Session.findById(grade.sessionId).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!ensureSessionEndedForGrading(session, reply)) {
        return undefined;
      }

      const value = toFiniteNumber(request.body.value, 0);
      await Grade.updateMany(
        getGradeIdentityFilter(grade),
        {
          $set: {
            value,
            automatic: false,
          },
        }
      );

      const updated = await Grade.findOne(getGradeIdentityFilter(grade)).lean();
      return { grade: (await normalizeGradesManualGradingState([updated]))[0] };
    }
  );

  app.post(
    '/grades/:gradeId/value/set-automatic',
    { preHandler: authenticate },
    async (request, reply) => {
      const grade = await Grade.findById(request.params.gradeId).lean();
      if (!grade) {
        return reply.code(404).send({ error: 'Not Found', message: 'Grade not found' });
      }

      const course = await Course.findById(grade.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const session = await Session.findById(grade.sessionId).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!ensureSessionEndedForGrading(session, reply)) {
        return undefined;
      }

      const nextGrade = {
        ...grade,
        automatic: true,
      };
      recomputeGradeAggregates(nextGrade);

      await Grade.updateMany(
        getGradeIdentityFilter(grade),
        {
          $set: {
            automatic: true,
            value: nextGrade.value,
          },
        }
      );

      const updated = await Grade.findOne(getGradeIdentityFilter(grade)).lean();
      return { grade: (await normalizeGradesManualGradingState([updated]))[0] };
    }
  );

  app.get(
    '/courses/:courseId/grades',
    { preHandler: authenticate },
    async (request, reply) => {
      const course = await Course.findById(request.params.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isCourseMember(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      const instructorView = isInstructorOrAdmin(course, request.user);
      const requestedSessionIds = parseSessionIds(request.query?.sessionIds);
      const requestedStudentId = normalizeAnswerValue(request.query?.studentId);

      // Anonymous sessions are never graded and stay out of the gradebook.
      const sessionQuery = { courseId: String(course._id), anonymous: { $ne: true } };
      if (requestedSessionIds.length > 0) {
        sessionQuery._id = { $in: requestedSessionIds };
      }

      if (instructorView) {
        sessionQuery.studentCreated = { $ne: true };
      } else {
        Object.assign(sessionQuery, studentReviewableSessionQuery({ includeStudentCreated: true }));
        sessionQuery.$or = [{ studentCreated: { $ne: true } }, { creator: request.user.userId }];
      }

      const sessions = await Session.find(sessionQuery)
        .select('_id name status date quizStart quizEnd quizExtensions createdAt reviewable quiz practiceQuiz questions joined submittedQuiz activityEverShared')
        .lean();

      sessions.sort((a, b) => {
        const aTime = new Date(a.date || a.quizStart || a.createdAt || 0).getTime();
        const bTime = new Date(b.date || b.quizStart || b.createdAt || 0).getTime();
        return bTime - aTime;
      });

      const sessionIds = sessions.map((session) => String(session._id));
      const uniqueQuestionIds = [...new Set(
        sessions.flatMap((session) => (
          Array.isArray(session?.questions)
            ? session.questions.map((questionId) => String(questionId)).filter(Boolean)
            : []
        ))
      )];
      const gradeQuery = {
        courseId: String(course._id),
        sessionId: { $in: sessionIds },
      };

      let studentIds = Array.isArray(course.students) ? course.students.map((studentId) => String(studentId)) : [];

      if (instructorView && requestedStudentId) {
        if (!studentIds.includes(requestedStudentId)) {
          return reply.code(404).send({ error: 'Not Found', message: 'Student not found in course' });
        }
        studentIds = [requestedStudentId];
      }

      if (!instructorView) {
        if (requestedStudentId && requestedStudentId !== request.user.userId) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Cannot view another student\'s grades' });
        }
        studentIds = [request.user.userId];
        gradeQuery.userId = request.user.userId;
        gradeQuery.visibleToStudents = true;
      }

      const [grades, students, ungradedSummaryBySessionId, questions] = await Promise.all([
        sessionIds.length > 0
          ? Grade.find(gradeQuery).lean()
          : Promise.resolve([]),
        studentIds.length > 0
          ? User.find({ _id: { $in: studentIds } }).select('_id profile emails email').lean()
          : Promise.resolve([]),
        getSessionUngradedSummary(sessionIds),
        uniqueQuestionIds.length > 0
          ? Question.find({ _id: { $in: uniqueQuestionIds } }).select('_id type').lean()
          : Promise.resolve([]),
      ]);

      const questionTypeByQuestionId = new Map();
      questions.forEach((question) => {
        const questionId = String(question?._id || '');
        const questionType = Number(question?.type);
        if (!questionId || !Number.isFinite(questionType)) return;
        questionTypeByQuestionId.set(questionId, questionType);
      });

      const autoGradeableQuestionIds = new Set(
        questions
          .filter((question) => isQuestionAutoGradeable(question?.type))
          .map((question) => String(question._id))
      );

      const gradeByStudentAndSession = new Map();
      const normalizedGrades = await normalizeGradesManualGradingState(grades);
      normalizedGrades.forEach((grade) => {
        const key = `${String(grade.userId)}::${String(grade.sessionId)}`;
        gradeByStudentAndSession.set(key, grade);
      });

      const studentMap = new Map(students.map((student) => [String(student._id), student]));
      const sortedStudents = studentIds
        .map((studentId) => studentMap.get(studentId))
        .filter(Boolean)
        .sort(compareStudentsByLastName);

      const rows = sortedStudents.map((student) => {
        const studentId = String(student._id);
        const firstname = normalizeAnswerValue(student?.profile?.firstname);
        const lastname = normalizeAnswerValue(student?.profile?.lastname);
        const email = normalizeAnswerValue(student?.emails?.[0]?.address || student?.email);

        const gradeEntries = sessions.map((session) => {
          const sessionId = String(session._id);
          const key = `${studentId}::${sessionId}`;
          const grade = gradeByStudentAndSession.get(key);
          const submitted = Array.isArray(session?.submittedQuiz) && session.submittedQuiz.includes(studentId);

          if (grade) {
            return {
              ...grade,
              hasGradeItem: true,
              ...(instructorView ? { gradingLockReason: getSessionGradingLockReason(session) } : {}),
              name: grade.name || session.name,
              submitted,
            };
          }

          return {
            sessionId,
            hasGradeItem: false,
            courseId: String(course._id),
            userId: studentId,
            name: session.name,
            value: 0,
            participation: 0,
            points: 0,
            outOf: 0,
            automatic: true,
            joined: false,
            submitted,
            needsGrading: false,
            visibleToStudents: !!session.reviewable,
            marks: [],
            numAnswered: 0,
            numQuestions: 0,
            numAnsweredTotal: 0,
            numQuestionsTotal: 0,
          };
        });

        // Missing/hidden items are not earned zeros. Actual zero-valued grade
        // items (including absences) still count; anonymous sessions are excluded above.
        const applicableGrades = gradeEntries.filter((grade) => grade.hasGradeItem && !grade.notApplicable);
        const average = (field) => applicableGrades.length > 0
          ? Math.round((applicableGrades.reduce((sum, grade) => sum + toFiniteNumber(grade[field], 0), 0) / applicableGrades.length) * 10) / 10
          : null;
        const avgParticipation = average('participation');
        const avgGrade = average('value');

        return {
          student: {
            studentId,
            firstname,
            lastname,
            email,
            displayName: formatUserDisplayName(student),
            profileImage: normalizeAnswerValue(student?.profile?.profileImage),
            profileThumbnail: normalizeAnswerValue(student?.profile?.profileThumbnail),
          },
          avgParticipation,
          avgGrade,
          grades: gradeEntries,
        };
      });

      const sessionsWithGradeItems = new Set(grades.map((grade) => String(grade.sessionId)));
      const sessionPayload = sessions.map((session) => {
        const sessionId = String(session._id);
        const ungraded = ungradedSummaryBySessionId[sessionId] || {
          studentsNeedingGrading: 0,
          marksNeedingGrading: 0,
        };
        const sessionQuestionTypeById = {};
        (session.questions || []).forEach((questionId) => {
          const normalizedQuestionId = String(questionId || '');
          if (!normalizedQuestionId) return;
          const questionType = questionTypeByQuestionId.get(normalizedQuestionId);
          if (!Number.isFinite(questionType)) return;
          sessionQuestionTypeById[normalizedQuestionId] = questionType;
        });
        return {
          _id: sessionId,
          name: session.name,
          createdAt: session.createdAt,
          hasGradeItems: sessionsWithGradeItems.has(sessionId),
          status: session.status,
          ...(instructorView ? { gradingLockReason: getSessionGradingLockReason(session) } : {}),
          reviewable: !!session.reviewable,
          quiz: !!session.quiz,
          practiceQuiz: !!session.practiceQuiz,
          joinedCount: Array.isArray(session.joined) ? session.joined.length : 0,
          date: session.date,
          quizStart: session.quizStart,
          studentsNeedingGrading: ungraded.studentsNeedingGrading,
          marksNeedingGrading: ungraded.marksNeedingGrading,
          autoGradeableQuestionIds: (session.questions || [])
            .map((questionId) => String(questionId))
            .filter((questionId) => autoGradeableQuestionIds.has(questionId)),
          questionTypeById: sessionQuestionTypeById,
        };
      });

      return {
        courseId: String(course._id),
        instructorView,
        sessions: sessionPayload,
        rows,
      };
    }
  );
}
