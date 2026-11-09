import { getQuizResultsParticipantIds, getQuizResultsResponseFilter } from '../utils/quizResults.js';
import crypto from 'crypto';
import Session from '../models/Session.js';
import Course from '../models/Course.js';
import Grade from '../models/Grade.js';
import LiveSessionTelemetry from '../models/LiveSessionTelemetry.js';
import Post from '../models/Post.js';
import Question from '../models/Question.js';
import Response from '../models/Response.js';
import User from '../models/User.js';
import {
  getStudentSessionReviewRestriction,
  isCourseInstructorOrAdmin as isInstructorOrAdmin,
  isCourseMember,
  isStudentOwnedSession,
  studentVisibleGradeQuery,
} from '../utils/courseAccess.js';
import { hasSessionParticipantAccess, getActivityRecipientUserIds } from '../services/activityAccess.js';
import { copySessionToCourse } from '../services/sessionCopy.js';
import { copyQuestionToSession } from '../services/questionCopy.js';
import {
  getNormalizedTagValue,
  mergeNormalizedTags,
  normalizeTags,
  sanitizeExportedQuestion,
  sanitizeImportedQuestion,
} from '../services/questionImportExport.js';
import { inheritSessionTagsForQuestions } from '../services/sessionQuestionTags.js';
import {
  ensureSessionMsScoringMethod,
  isQuestionResponseCollectionEnabled,
  isSlideQuestion,
  getQuestionPoints,
  getTimestampMs,
  isQuestionAutoGradeable,
  normalizeGradesManualGradingState,
  normalizeQuestionType,
  recalculateSessionGrades,
  sanitizeStudentVisibleGrade,
  summarizeGradeFeedback,
  setSessionGradesVisibility,
} from '../services/grading.js';
import {
  buildLiveTelemetryUpdate,
  LIVE_TELEMETRY_METRIC_PATHS,
  LIVE_TELEMETRY_ROLES,
  LIVE_TELEMETRY_TRANSPORTS,
  summarizeLiveTelemetryDocument,
} from '../services/liveTelemetry.js';
import { userCanViewQuestion } from './questions.js';
import { computeWordFrequencies } from '../utils/wordFrequency.js';
import { computeHistogramData } from '../utils/histogram.js';
import { getRequestIp } from '../utils/sessionAudit.js';
import {
  buildSessionResponseTracking,
  getSessionHasResponses,
  getSessionQuestionResponseCounts,
  normalizeQuestionIds,
  sessionResponseTrackingNeedsHydration,
} from '../utils/sessionResponseTracking.js';
import { getUserAccessFlags } from '../utils/userAccess.js';
import { generateMeteorId } from '../utils/meteorId.js';
import {
  buildAnonymousRespondentIndex,
  MIN_ANONYMOUS_RESPONDENTS,
  buildParticipantUserIdMap,
  getAnonymousRespondentKey,
  getSessionParticipantId,
  isAnonymousParticipantId,
  isAnonymousSession,
  redactAnonymousSessionAttendance,
  resolveSessionParticipantUserIds,
} from '../utils/anonymousSession.js';

const createSessionSchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      quiz: { type: 'boolean' },
      practiceQuiz: { type: 'boolean' },
      allowSkippingZeroPointQuestions: { type: 'boolean', description: 'Allow normal quiz submission with unanswered questions explicitly worth 0 points; defaults to false.' },
      anonymous: { type: 'boolean' },
      quizStart: { type: 'string', format: 'date-time' },
      quizEnd: { type: 'string', format: 'date-time' },
      date: { type: 'string', format: 'date-time' },
      msScoringMethod: { type: 'string', enum: ['right-minus-wrong', 'all-or-nothing', 'correctness-ratio'] },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            label: { type: 'string' },
            className: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
};

const updateSessionSchema = {
  body: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      quiz: { type: 'boolean' },
      practiceQuiz: { type: 'boolean' },
      allowSkippingZeroPointQuestions: { type: 'boolean', description: 'Allow normal quiz submission with unanswered questions explicitly worth 0 points; defaults to false.' },
      anonymous: { type: 'boolean' },
      quizStart: { type: 'string', format: 'date-time' },
      quizEnd: { type: 'string', format: 'date-time' },
      reviewable: { type: 'boolean' },
      status: { type: 'string', enum: ['hidden', 'visible', 'running', 'done'] },
      date: { type: 'string', format: 'date-time' },
      joinCodeEnabled: { type: 'boolean' },
      chatEnabled: { type: 'boolean' },
      richTextChatEnabled: { type: 'boolean' },
      joinCodeInterval: { type: 'number', minimum: 5, maximum: 120 },
      msScoringMethod: { type: 'string', enum: ['right-minus-wrong', 'all-or-nothing', 'correctness-ratio'] },
      tags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            label: { type: 'string' },
            className: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      acknowledgeNonAutoGradeable: { type: 'boolean' },
      zeroNonAutoGradeable: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const liveTelemetryMetricNames = Object.keys(LIVE_TELEMETRY_METRIC_PATHS);
const SESSION_CHAT_METADATA_CACHE_MAX = 200;
const SESSION_CHAT_QUICK_POST_CACHE_MAX = 200;
const sessionChatMetadataCache = new Map();
const sessionChatQuickPostCache = new Map();

const setCurrentQuestionSchema = {
  body: {
    type: 'object',
    required: ['questionId'],
    properties: {
      questionId: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
};

const toggleReviewableSchema = {
  body: {
    type: 'object',
    required: ['reviewable'],
    properties: {
      reviewable: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const setExtensionsSchema = {
  body: {
    type: 'object',
    required: ['extensions'],
    properties: {
      extensions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string', minLength: 1 },
            quizStart: { type: 'string', format: 'date-time' },
            quizEnd: { type: 'string', format: 'date-time' },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
};

const bulkSessionCopySchema = {
  body: {
    type: 'object',
    required: ['sessionIds'],
    properties: {
      sessionIds: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
    },
    additionalProperties: false,
  },
};

const importSessionSchema = {
  body: {
    type: 'object',
    required: ['session'],
    properties: {
      session: {
        type: 'object',
        required: ['name', 'questions'],
        properties: {
          name: { type: 'string', minLength: 1 },
          description: { type: 'string' },
          quiz: { type: 'boolean' },
          practiceQuiz: { type: 'boolean' },
          allowSkippingZeroPointQuestions: { type: 'boolean', description: 'Allow normal quiz submission with unanswered questions explicitly worth 0 points; defaults to false.' },
          anonymous: { type: 'boolean' },
          reviewable: { type: 'boolean' },
          joinCodeEnabled: { type: 'boolean' },
          joinCodeInterval: { type: 'number', minimum: 5, maximum: 120 },
          msScoringMethod: { type: 'string', enum: ['right-minus-wrong', 'all-or-nothing', 'correctness-ratio'] },
          tags: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                value: { type: 'string' },
                label: { type: 'string' },
                className: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              required: ['type'],
              properties: {
                type: { type: 'integer', minimum: 0, maximum: 6 },
                content: { type: 'string' },
                plainText: { type: 'string' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      wysiwyg: { type: 'boolean' },
                      correct: { type: 'boolean' },
                      answer: { type: 'string' },
                      content: { type: 'string' },
                      plainText: { type: 'string' },
                    },
                    additionalProperties: false,
                  },
                },
                toleranceNumerical: { type: 'number' },
                correctNumerical: { type: 'number' },
                solution: { type: 'string' },
                solution_plainText: { type: 'string' },
                public: { type: 'boolean' },
                creator: { type: 'string' },
                originalQuestion: { type: 'string' },
                originalCourse: { type: 'string' },
                imagePath: { type: 'string' },
                tags: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string' },
                      label: { type: 'string' },
                      className: { type: 'string' },
                    },
                    additionalProperties: false,
                  },
                },
                sessionOptions: {
                  type: 'object',
                  properties: {
                    hidden: { type: 'boolean' },
                    points: { type: 'number' },
                    maxAttempts: { type: 'number' },
                    attemptWeights: { type: 'array', items: { type: 'number' } },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      importTags: {
        type: 'array',
        items: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                value: { type: 'string' },
                label: { type: 'string' },
                className: { type: 'string' },
              },
              additionalProperties: false,
            },
          ],
        },
      },
      version: { type: 'integer' },
      exportedAt: { type: 'string', format: 'date-time' },
    },
    additionalProperties: false,
  },
};

function getAllowedCourseTagValues(course) {
  const values = new Set();
  (course?.tags || []).forEach((tag) => {
    const normalized = getNormalizedTagValue(tag);
    if (normalized) values.add(normalized);
  });
  return values;
}

function hasDisallowedTags(tags = [], allowedTagValues = new Set()) {
  const normalizedTags = normalizeTags(tags);
  return normalizedTags.some((tag) => !allowedTagValues.has(getNormalizedTagValue(tag)));
}

const saveQuizResponseSchema = {
  body: {
    type: 'object',
    required: ['questionId', 'answer'],
    properties: {
      questionId: { type: 'string', minLength: 1 },
      answer: {},
      answerWysiwyg: { type: 'string' },
    },
    additionalProperties: false,
  },
};

const submitQuizQuestionSchema = {
  body: {
    type: 'object',
    required: ['questionId'],
    properties: {
      questionId: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
};

const replacePracticeQuestionsSchema = {
  body: {
    type: 'object',
    required: ['questionIds'],
    properties: {
      questionIds: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
    },
    additionalProperties: false,
  },
};

// Generate a 6-digit numeric join code
function generateJoinCode() {
  return String(crypto.randomInt(100000, 999999));
}

function getParticipationQuestionPoints(question) {
  if (isSlideQuestion(question)) return 0;
  // Meteor behavior: default to 1 point per question, except SA defaults to 0 unless explicitly set.
  let points = normalizeQuestionType(question) === 2 ? 0 : 1;
  if (question?.sessionOptions && Object.prototype.hasOwnProperty.call(question.sessionOptions, 'points')) {
    points = Number(question.sessionOptions.points) || 0;
  }
  return points;
}

const QUESTION_TYPE_MULTIPLE_CHOICE = 0;

function countCorrectOptions(options = []) {
  if (!Array.isArray(options)) return 0;
  return options.reduce((count, option) => (option?.correct ? count + 1 : count), 0);
}

function multipleChoiceValidationError(type, options) {
  if (Number(type) !== QUESTION_TYPE_MULTIPLE_CHOICE) return null;
  if (countCorrectOptions(options) <= 1) return null;
  return {
    error: 'Bad Request',
    message: 'Multiple Choice questions can only have one correct option',
  };
}

function sanitizeExportedSession(session, orderedQuestions = []) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    session: {
      name: String(session?.name || '').trim(),
      description: session?.description || '',
      quiz: !!session?.quiz,
      practiceQuiz: !!session?.practiceQuiz,
      allowSkippingZeroPointQuestions: !!session?.allowSkippingZeroPointQuestions,
      anonymous: !!session?.anonymous && !session?.practiceQuiz,
      reviewable: !!session?.reviewable,
      joinCodeEnabled: !!session?.joinCodeEnabled,
      chatEnabled: !!session?.chatEnabled,
      richTextChatEnabled: session?.richTextChatEnabled !== false,
      joinCodeInterval: Number(session?.joinCodeInterval) || 10,
      msScoringMethod: session?.msScoringMethod || 'right-minus-wrong',
      tags: normalizeTags(session?.tags || []),
      questions: orderedQuestions.map((question) => sanitizeExportedQuestion(question, { includeSessionOptions: true })),
    },
  };
}

const liveSessionsQuerySchema = {
  querystring: {
    type: 'object',
    properties: {
      view: { type: 'string', enum: ['student', 'instructor', 'all'] },
    },
    additionalProperties: false,
  },
};

function buildImportedSessionPayload(sourceSession = {}, courseId = '') {
  const isPracticeQuiz = !!sourceSession?.practiceQuiz;
  const isQuiz = isPracticeQuiz || !!sourceSession?.quiz;

  return {
    name: String(sourceSession?.name || '').trim(),
    description: sourceSession?.description || '',
    courseId: String(courseId),
    creator: String(sourceSession?.creator || ''),
    studentCreated: !!sourceSession?.studentCreated,
    status: 'hidden',
    quiz: isQuiz,
    practiceQuiz: isPracticeQuiz,
    allowSkippingZeroPointQuestions: !!sourceSession?.allowSkippingZeroPointQuestions,
    anonymous: !!sourceSession?.anonymous && !isPracticeQuiz && !sourceSession?.studentCreated,
    reviewable: !!sourceSession?.reviewable,
    hasResponses: false,
    questionResponseCounts: {},
    joinCodeEnabled: !!sourceSession?.joinCodeEnabled,
    chatEnabled: !!sourceSession?.chatEnabled,
    richTextChatEnabled: sourceSession?.richTextChatEnabled !== false,
    joinCodeInterval: Number(sourceSession?.joinCodeInterval) || 10,
    msScoringMethod: sourceSession?.msScoringMethod || 'right-minus-wrong',
    tags: normalizeTags(sourceSession?.tags || []),
    date: undefined,
    quizStart: undefined,
    quizEnd: undefined,
    quizExtensions: [],
    currentQuestion: '',
    questions: [],
    joined: [],
    joinRecords: [],
    submittedQuiz: [],
    joinCodeActive: false,
    currentJoinCode: '',
    joinCodeExpiresAt: undefined,
    createdAt: new Date(),
  };
}

async function getSessionTypeCounts(filter = {}) {
  const [summary] = await Session.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        interactive: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ['$studentCreated', true] },
                  { $ne: ['$quiz', true] },
                ],
              },
              1,
              0,
            ],
          },
        },
        quizzes: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ['$studentCreated', true] },
                  { $eq: ['$quiz', true] },
                ],
              },
              1,
              0,
            ],
          },
        },
        practice: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $eq: ['$studentCreated', true] },
                  { $eq: ['$practiceQuiz', true] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    {
      $project: {
        _id: 0,
        total: 1,
        interactive: 1,
        quizzes: 1,
        practice: 1,
      },
    },
  ]);

  return {
    total: Number(summary?.total) || 0,
    interactive: Number(summary?.interactive) || 0,
    quizzes: Number(summary?.quizzes) || 0,
    practice: Number(summary?.practice) || 0,
  };
}

function optionDisplayContent(option, index) {
  return option?.content || option?.plainText || option?.answer || `Option ${index + 1}`;
}

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

function normalizeComparableText(answer) {
  return normalizeAnswerValue(answer)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function toPlainText(value) {
  return normalizeAnswerValue(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getResponseStudentId(response) {
  return normalizeAnswerValue(
    response?.studentUserId || response?.userId || response?.studentId
  );
}

async function sessionHasParticipationData(session) {
  if (session?.participationStarted || (session?.joined || []).length > 0
    || (session?.joinRecords || []).length > 0 || (session?.submittedQuiz || []).length > 0) return true;
  if (getSessionHasResponses(session)) return true;
  const questionIds = normalizeQuestionIds(session?.questions || []);
  if (questionIds.length === 0) return false;
  return !!(await Response.exists({ questionId: { $in: questionIds } }));
}

function expectedAnonymityFilter(session) {
  return session?.anonymous ? { anonymous: true } : { anonymous: { $ne: true } };
}

async function claimSessionParticipation(session) {
  if (session.participationStarted) return true;
  const result = await Session.updateOne(
    { _id: session._id, ...expectedAnonymityFilter(session) },
    { $set: { participationStarted: true } }
  );
  return result.matchedCount > 0;
}

// Cached live stats keep answer lists; anonymous pseudonyms are omitted so the
// cache cannot tie answers across questions to one respondent.
function getStatsStudentId(response) {
  const studentId = getResponseStudentId(response);
  return isAnonymousParticipantId(studentId) ? '' : studentId;
}

// A student's responses are keyed by user id, except in anonymous sessions
// where each session uses its own pseudonym.
function getStudentResponseOwnerIds(sessions = [], userId = '') {
  return [...new Set([
    String(userId || ''),
    ...sessions.map((session) => getSessionParticipantId(session, userId)),
  ].filter(Boolean))];
}

function parseBooleanQuery(value) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeAnswerValue(value).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function toDateOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function isQuizLikeSession(session) {
  return !!(session?.quiz || session?.practiceQuiz);
}

async function initializeActiveQuestion(session, updates) {
  const firstQuestionId = session.questions?.[0];
  if (session.currentQuestion || !firstQuestionId) return;
  updates.currentQuestion = firstQuestionId;
  // Match Launch: select the first question or slide without revealing it yet.
  await Question.findByIdAndUpdate(firstQuestionId, {
    $set: { 'sessionOptions.hidden': true },
  });
}

async function getNonAutoGradeableQuestions(session) {
  const questionIds = Array.isArray(session?.questions) ? session.questions : [];
  if (questionIds.length === 0) return [];

  const questionDocs = await Question.find({ _id: { $in: questionIds } }).lean();
  return questionDocs.filter((question) => (
    !isQuestionAutoGradeable(question?.type) && getQuestionPoints(question) > 0
  ));
}

async function filterToActuallyUngradedQuestions(questions, sessionId) {
  if (questions.length === 0) return [];

  const grades = await normalizeGradesManualGradingState(await Grade.find({ sessionId: String(sessionId) })
    .select('userId marks')
    .lean());

  // If no grades exist yet, all questions potentially need grading
  if (grades.length === 0) return questions;

  const questionIds = new Set(questions.map((q) => String(q._id)));
  const ungradedQuestionIds = new Set();
  grades.forEach((grade) => {
    (grade.marks || []).forEach((mark) => {
      if (mark?.needsGrading && questionIds.has(String(mark.questionId))) {
        ungradedQuestionIds.add(String(mark.questionId));
      }
    });
  });

  return questions.filter((q) => ungradedQuestionIds.has(String(q._id)));
}

async function getNoResponseQuestions(session) {
  const questionIds = Array.isArray(session?.questions) ? session.questions : [];
  if (questionIds.length === 0) return [];

  const questionDocs = await Question.find({ _id: { $in: questionIds } }).lean();
  const questionResponseCounts = getSessionQuestionResponseCounts(session);

  return questionDocs.filter((question) => (
    isQuestionResponseCollectionEnabled(question)
      && getQuestionPoints(question) > 0
      && !questionResponseCounts[String(question._id)]
  ));
}

function buildReviewableWarning({ nonAutoGradeable = [], noResponses = [] } = {}) {
  const questionMap = new Map();
  [...nonAutoGradeable, ...noResponses].forEach((question) => {
    const questionId = String(question?._id || '');
    if (!questionId || questionMap.has(questionId)) return;
    questionMap.set(questionId, question);
  });

  return {
    questionCount: questionMap.size,
    questionNames: [...questionMap.values()].map((question) => (
      question?.plainText || question?.question || question?.name || 'Untitled'
    )),
    nonAutoGradeableCount: nonAutoGradeable.length,
    noResponseCount: noResponses.length,
  };
}

async function zeroQuestionPoints(questionDocs = []) {
  const questionIds = questionDocs
    .map((question) => String(question?._id || ''))
    .filter(Boolean);

  if (questionIds.length === 0) return;

  await Question.updateMany(
    { _id: { $in: questionIds } },
    { $set: { 'sessionOptions.points': 0 } }
  );
}

function getQuizWindowValidationMessage(session, updates = {}) {
  const hasQuiz = Object.prototype.hasOwnProperty.call(updates, 'quiz');
  const hasPracticeQuiz = Object.prototype.hasOwnProperty.call(updates, 'practiceQuiz');
  const hasQuizStart = Object.prototype.hasOwnProperty.call(updates, 'quizStart');
  const hasQuizEnd = Object.prototype.hasOwnProperty.call(updates, 'quizEnd');

  const nextQuiz = hasQuiz ? !!updates.quiz : !!session?.quiz;
  const nextPracticeQuiz = hasPracticeQuiz ? !!updates.practiceQuiz : !!session?.practiceQuiz;
  if (!nextQuiz && !nextPracticeQuiz) return null;

  const nextQuizStart = hasQuizStart ? updates.quizStart : session?.quizStart;
  const nextQuizEnd = hasQuizEnd ? updates.quizEnd : session?.quizEnd;
  const quizStart = toDateOrNull(nextQuizStart);
  const quizEnd = toDateOrNull(nextQuizEnd);
  if (quizStart && quizEnd && quizEnd.getTime() <= quizStart.getTime()) {
    return 'Quiz end time must be later than quiz start time';
  }

  return null;
}

function normalizeQuizExtension(extension, session) {
  const userId = normalizeAnswerValue(extension?.userId);
  if (!userId) return null;

  const fallbackStart = toDateOrNull(session?.quizStart);
  const fallbackEnd = toDateOrNull(session?.quizEnd);
  const quizStart = toDateOrNull(extension?.quizStart) || fallbackStart;
  const quizEnd = toDateOrNull(extension?.quizEnd) || fallbackEnd;
  if (!quizStart || !quizEnd) return null;
  if (quizEnd.getTime() <= quizStart.getTime()) return null;

  return { userId, quizStart, quizEnd };
}

function getNormalizedQuizExtensions(session) {
  if (!Array.isArray(session?.quizExtensions)) return [];
  return session.quizExtensions
    .map((extension) => normalizeQuizExtension(extension, session))
    .filter(Boolean);
}

function getLatestQuizWindowEndMs(session, normalizedExtensions = null) {
  const extensions = normalizedExtensions || getNormalizedQuizExtensions(session);
  let latestEndMs = Number.NEGATIVE_INFINITY;

  const quizEnd = toDateOrNull(session?.quizEnd);
  if (quizEnd) {
    latestEndMs = Math.max(latestEndMs, quizEnd.getTime());
  }

  extensions.forEach((extension) => {
    latestEndMs = Math.max(latestEndMs, extension.quizEnd.getTime());
  });

  return Number.isFinite(latestEndMs) ? latestEndMs : null;
}

function extensionIsActive(extension, nowMs) {
  if (!extension) return false;
  const startMs = extension.quizStart.getTime();
  const endMs = extension.quizEnd.getTime();
  return nowMs >= startMs && nowMs <= endMs;
}

function extensionIsUpcoming(extension, nowMs) {
  if (!extension) return false;
  return nowMs < extension.quizStart.getTime();
}

function extensionHasRemainingWindow(extension, nowMs) {
  if (!extension) return false;
  return nowMs <= extension.quizEnd.getTime();
}

function getQuizRuntimeState(session, { userId = '', instructorView = false, now = new Date() } = {}) {
  const defaultState = {
    effectiveStatus: session?.status || 'hidden',
    isOpenForUser: false,
    isUpcomingForUser: false,
    isClosedForUser: (session?.status || 'hidden') === 'done',
    quizHasActiveExtensions: false,
    quizHasRemainingExtensions: false,
    activeExtensionsCount: 0,
    userHasActiveQuizExtension: false,
    userHasUpcomingQuizExtension: false,
    userHasRemainingQuizExtension: false,
  };

  if (!isQuizLikeSession(session)) return defaultState;

  const nowMs = now.getTime();
  const normalizedExtensions = getNormalizedQuizExtensions(session);
  const userExtension = normalizedExtensions.find((extension) => extension.userId === String(userId)) || null;
  const activeExtensions = normalizedExtensions.filter((extension) => extensionIsActive(extension, nowMs));
  const quizHasActiveExtensions = activeExtensions.length > 0;
  const anyExtensionsRemaining = normalizedExtensions.some((extension) => extensionHasRemainingWindow(extension, nowMs));

  const quizStart = toDateOrNull(session?.quizStart);
  const quizEnd = toDateOrNull(session?.quizEnd);
  const startMs = quizStart ? quizStart.getTime() : null;
  const endMs = quizEnd ? quizEnd.getTime() : null;
  const hasBaseWindow = Number.isFinite(startMs) && Number.isFinite(endMs);
  const baseWindowActive = hasBaseWindow && nowMs >= startMs && nowMs <= endMs;
  const baseWindowEnded = Number.isFinite(endMs) ? nowMs > endMs : false;

  const userHasActiveQuizExtension = extensionIsActive(userExtension, nowMs);
  const userHasUpcomingQuizExtension = extensionIsUpcoming(userExtension, nowMs);
  const userHasRemainingQuizExtension = extensionHasRemainingWindow(userExtension, nowMs);

  const latestWindowEndMs = getLatestQuizWindowEndMs(session, normalizedExtensions);
  const allQuizWindowsElapsed = Number.isFinite(latestWindowEndMs) ? nowMs > latestWindowEndMs : false;

  let effectiveStatus = session?.status || 'hidden';

  if (effectiveStatus === 'visible') {
    if (instructorView) {
      if (baseWindowActive || quizHasActiveExtensions) {
        effectiveStatus = 'running';
      } else if (allQuizWindowsElapsed || (baseWindowEnded && !anyExtensionsRemaining)) {
        effectiveStatus = 'done';
      } else {
        effectiveStatus = 'visible';
      }
    } else if (baseWindowActive || userHasActiveQuizExtension) {
      effectiveStatus = 'running';
    } else if (allQuizWindowsElapsed || (baseWindowEnded && !userHasRemainingQuizExtension)) {
      effectiveStatus = 'done';
    } else {
      effectiveStatus = 'visible';
    }
  }

  // Ending the class-wide quiz must not cancel individual accommodations.
  // Instructors still see Ended; only the assigned student gets access.
  if (session?.status === 'done' && !instructorView) {
    if (userHasActiveQuizExtension) effectiveStatus = 'running';
    else if (userHasUpcomingQuizExtension) effectiveStatus = 'visible';
  }

  if (effectiveStatus === 'running') {
    if (session?.status === 'running') {
      defaultState.isOpenForUser = true;
    } else {
      defaultState.isOpenForUser = (session?.status !== 'done' && baseWindowActive) || userHasActiveQuizExtension;
    }
  }

  defaultState.effectiveStatus = effectiveStatus;
  defaultState.isUpcomingForUser = !defaultState.isOpenForUser && effectiveStatus === 'visible';
  defaultState.isClosedForUser = !defaultState.isOpenForUser && effectiveStatus === 'done';
  defaultState.quizHasActiveExtensions = quizHasActiveExtensions;
  defaultState.quizHasRemainingExtensions = anyExtensionsRemaining;
  defaultState.activeExtensionsCount = activeExtensions.length;
  defaultState.userHasActiveQuizExtension = userHasActiveQuizExtension;
  defaultState.userHasUpcomingQuizExtension = userHasUpcomingQuizExtension;
  defaultState.userHasRemainingQuizExtension = userHasRemainingQuizExtension;

  return defaultState;
}

async function maybeAutoCloseScheduledQuiz(session, { course = null } = {}) {
  if (!isQuizLikeSession(session)) {
    return { session, changed: false };
  }
  if (session?.status !== 'visible') {
    return { session, changed: false };
  }

  const normalizedExtensions = getNormalizedQuizExtensions(session);
  const latestEndMs = getLatestQuizWindowEndMs(session, normalizedExtensions);
  if (!Number.isFinite(latestEndMs)) {
    return { session, changed: false };
  }
  if (Date.now() <= latestEndMs) {
    return { session, changed: false };
  }

  const updated = await Session.findByIdAndUpdate(
    session._id,
    { $set: { status: 'done' } },
    { returnDocument: 'after' }
  ).lean();

  const nextSession = updated || { ...session, status: 'done' };

  if (course) {
    await seedSessionGradesIfNeeded(nextSession, course, {
      visibleToStudents: !!(nextSession.reviewable || nextSession.gradesVisible),
    });
  }

  return { session: nextSession, changed: true };
}

function formatUserDisplayName(user) {
  const first = normalizeAnswerValue(user?.profile?.firstname);
  const last = normalizeAnswerValue(user?.profile?.lastname);
  const fullName = `${first} ${last}`.trim();
  if (fullName) return fullName;
  return user?.emails?.[0]?.address || user?.email || 'Unknown Student';
}

function participantRoles(user, course, guest = false) {
  const userId = String(user?._id || '');
  return {
    participantRole: (course?.instructors || []).some((id) => String(id) === userId)
      ? 'instructor' : guest ? 'guest' : 'student',
    isProfessor: (user?.profile?.roles || []).includes('professor'),
  };
}

function serializeLiveStudent(user, { joinedAt = null, course, guest = false } = {}) {
  const userId = normalizeAnswerValue(user?._id);
  return {
    _id: userId,
    firstname: normalizeAnswerValue(user?.profile?.firstname),
    lastname: normalizeAnswerValue(user?.profile?.lastname),
    email: normalizeAnswerValue(user?.emails?.[0]?.address || user?.email),
    profileImage: normalizeAnswerValue(user?.profile?.profileImage),
    profileThumbnail: normalizeAnswerValue(user?.profile?.profileThumbnail),
    displayName: formatUserDisplayName(user),
    ...(course ? participantRoles(user, course, guest) : {}),
    joinedAt,
  };
}

function stripHtmlToPlainText(value) {
  const input = normalizeAnswerValue(value);
  if (!input) return '';

  let result = '';
  let insideTag = false;
  for (const char of input) {
    if (char === '<') {
      insideTag = true;
      result += ' ';
      continue;
    }
    if (char === '>') {
      insideTag = false;
      result += ' ';
      continue;
    }
    if (!insideTag) {
      result += char;
    }
  }

  return result.replace(/\s+/g, ' ').trim();
}

function getChatAuthorRole(course, user) {
  if (!course || !user) return 'student';
  if ((user.roles || []).includes('admin')) return 'admin';
  if ((course.instructors || []).includes(user.userId)) return 'instructor';
  return 'student';
}

function buildQuickPostBody(questionNumber) {
  return `I didn't understand question ${questionNumber}`;
}

function setBoundedCacheEntry(cache, key, value, maxSize) {
  if (!cache.has(key) && cache.size >= maxSize) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, value);
}

function getSessionQuestionListSignature(session) {
  return Array.isArray(session?.questions)
    ? session.questions.map((questionId) => String(questionId)).filter(Boolean).join(',')
    : '';
}

function getSessionChatMetadataSignature(session) {
  return `${getSessionQuestionListSignature(session)}::${normalizeAnswerValue(session?.currentQuestion)}`;
}

function getSessionQuickPostSignature(session, totalQuestionCount = null) {
  const normalizedCount = Number(totalQuestionCount);
  const countPart = Number.isFinite(normalizedCount) ? normalizedCount : '';
  return `${getSessionQuestionListSignature(session)}::${countPart}`;
}

async function loadSessionChatQuestionMetadata(session) {
  const sessionId = normalizeAnswerValue(session?._id);
  const signature = getSessionChatMetadataSignature(session);
  const cached = sessionId ? sessionChatMetadataCache.get(sessionId) : null;
  if (cached?.signature === signature) {
    return cached.metadata;
  }

  const orderedQuestionIds = Array.isArray(session?.questions)
    ? session.questions.map((questionId) => String(questionId)).filter(Boolean)
    : [];
  const questionDocs = orderedQuestionIds.length > 0
    ? await Question.find({ _id: { $in: orderedQuestionIds } })
      .select('_id type')
      .lean()
    : [];
  const questionById = new Map(questionDocs.map((question) => [String(question._id), question]));
  const orderedQuestions = orderedQuestionIds
    .map((questionId) => questionById.get(questionId))
    .filter(Boolean);
  const currentQuestionId = normalizeAnswerValue(session?.currentQuestion);
  const responseQuestionEntries = [];
  let questionsBeforeCurrentPage = 0;
  let currentQuestionNumber = null;

  orderedQuestions.forEach((question, index) => {
    const questionId = normalizeAnswerValue(question?._id);
    const responseCollectionEnabled = isQuestionResponseCollectionEnabled(question);
    if (currentQuestionId && questionId === currentQuestionId) {
      currentQuestionNumber = questionsBeforeCurrentPage + (responseCollectionEnabled ? 1 : 0);
    }

    if (!responseCollectionEnabled) return;

    const questionNumber = responseQuestionEntries.length + 1;
    responseQuestionEntries.push({
      questionId,
      pageNumber: index + 1,
      questionNumber,
    });
    questionsBeforeCurrentPage += 1;
  });

  const metadata = {
    currentQuestionNumber,
    totalQuestionCount: responseQuestionEntries.length,
    responseQuestionEntries,
  };
  if (sessionId) {
    setBoundedCacheEntry(
      sessionChatMetadataCache,
      sessionId,
      { signature, metadata },
      SESSION_CHAT_METADATA_CACHE_MAX
    );
  }
  return metadata;
}

async function ensureSessionQuickPosts(session, questionMetadata = null) {
  const metadata = questionMetadata || await loadSessionChatQuestionMetadata(session);
  const questionCount = Number(metadata?.totalQuestionCount || 0);
  if (!session?._id || !session?.courseId || questionCount <= 0) return;
  const sessionId = String(session._id);
  const signature = getSessionQuickPostSignature(session, questionCount);
  if (sessionChatQuickPostCache.get(sessionId) === signature) {
    return;
  }

  const existingQuickPosts = await Post.find({
    scopeType: 'session',
    sessionId,
    isQuickPost: true,
  })
    .select('_id quickPostQuestionNumber body')
    .lean();
  const existingPositiveNumbers = existingQuickPosts
    .map((post) => Number(post?.quickPostQuestionNumber))
    .filter((value) => Number.isInteger(value) && value > 0);
  const hasLegacyPageBasedQuickPosts = existingPositiveNumbers.length > questionCount
    || existingPositiveNumbers.some((value) => value > questionCount);

  if (hasLegacyPageBasedQuickPosts) {
    const now = new Date();
    const questionNumberByPageNumber = new Map(
      (metadata?.responseQuestionEntries || []).map((entry) => [entry.pageNumber, entry.questionNumber])
    );
    const updates = existingQuickPosts.map((post) => {
      const pageNumber = Number(post?.quickPostQuestionNumber);
      const nextQuestionNumber = questionNumberByPageNumber.get(pageNumber);

      if (nextQuestionNumber) {
        return {
          updateOne: {
            filter: { _id: post._id },
            update: {
              $set: {
                quickPostQuestionNumber: nextQuestionNumber,
                body: buildQuickPostBody(nextQuestionNumber),
                updatedAt: now,
              },
            },
          },
        };
      }

      return {
        updateOne: {
          filter: { _id: post._id },
          update: {
            $set: {
              quickPostQuestionNumber: 0,
              updatedAt: now,
            },
          },
        },
      };
    });

    if (updates.length > 0) {
      await Post.bulkWrite(updates, { ordered: false }).catch(() => {});
    }
  }

  const refreshedQuickPosts = hasLegacyPageBasedQuickPosts
    ? await Post.find({
      scopeType: 'session',
      sessionId: String(session._id),
      isQuickPost: true,
    })
      .select('_id quickPostQuestionNumber')
      .lean()
    : existingQuickPosts;
  const existingNumbers = new Set(
    refreshedQuickPosts
      .map((post) => Number(post?.quickPostQuestionNumber))
      .filter((value) => Number.isInteger(value) && value > 0)
  );

  const missingPosts = [];
  for (let questionNumber = 1; questionNumber <= questionCount; questionNumber += 1) {
    if (existingNumbers.has(questionNumber)) continue;
    missingPosts.push({
      scopeType: 'session',
      courseId: String(session.courseId),
      sessionId: String(session._id),
      authorId: '',
      authorRole: 'system',
      body: buildQuickPostBody(questionNumber),
      bodyWysiwyg: '',
      isQuickPost: true,
      quickPostQuestionNumber: questionNumber,
      upvoteUserIds: [],
      upvoteCount: 0,
      comments: [],
      dismissedAt: null,
      dismissedBy: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  if (missingPosts.length > 0) {
    await Post.insertMany(missingPosts, { ordered: false }).catch(() => {});
  }

  setBoundedCacheEntry(
    sessionChatQuickPostCache,
    sessionId,
    signature,
    SESSION_CHAT_QUICK_POST_CACHE_MAX
  );
}

function getChatViewMode(request, isInstructorView) {
  const requestedView = normalizeAnswerValue(request.query?.view).toLowerCase();
  if (requestedView === 'presentation' && isInstructorView) return 'presentation';
  if (requestedView === 'review' && isInstructorView) return 'review';
  return 'live';
}

function isRichTextChatEnabled(session) {
  return session?.richTextChatEnabled !== false;
}

function getChatPermissionFlags({ session, course, request, viewMode }) {
  const isInstructorView = isInstructorOrAdmin(course, request.user);
  const participantId = getSessionParticipantId(session, request.user?.userId);
  const isJoined = (session?.joined || []).some((joinedId) => String(joinedId) === participantId);
  const isRunning = session?.status === 'running';

  const canViewLive = isInstructorView || (viewMode === 'live' && isRunning && isJoined);
  const canWrite = viewMode === 'live' && session?.chatEnabled && canViewLive && isRunning;

  return {
    isInstructorView,
    isJoined,
    canViewLive,
    canWrite,
    canModerate: isInstructorView && viewMode === 'live' && isRunning,
    canViewNames: isInstructorView && viewMode !== 'presentation' && !isAnonymousSession(session),
  };
}

async function buildChatAuthorMetadataMap(posts, { includeAllAuthors = false } = {}) {
  const userIds = new Set();

  posts.forEach((post) => {
    if (!post) return;
    const displayAuthor = getChatPostDisplayAuthor(post);
    if (displayAuthor.authorId) userIds.add(String(displayAuthor.authorId));
    if (includeAllAuthors) {
      (post.upvoteUserIds || []).forEach((userId) => {
        if (userId) userIds.add(String(userId));
      });
    }
    (post.comments || []).forEach((comment) => {
      if (comment.authorId) userIds.add(String(comment.authorId));
    });
  });

  const ids = [...userIds];
  if (ids.length === 0) return new Map();

  const users = await User.find({ _id: { $in: ids } })
    .select('_id profile emails email roles')
    .lean();

  return new Map(users.map((user) => [
    String(user._id),
    {
      displayName: formatUserDisplayName(user),
      canExposeName: userHasPublicChatAuthorRole(user),
    },
  ]));
}

function userHasPublicChatAuthorRole(user) {
  return (user?.roles || []).some((role) => role === 'professor' || role === 'admin');
}

function getChatAuthorDisplayName(authorMetadataMap, authorId) {
  return authorMetadataMap.get(authorId)?.displayName || null;
}

function shouldExposeChatAuthorName({
  authorId,
  authorRole,
  includeNames,
  viewerUserId,
  authorMetadataMap,
  allowRoleBasedExposure = true,
}) {
  if (includeNames) return true;
  if (!authorId) return false;
  if (authorId === viewerUserId) return true;
  if (!allowRoleBasedExposure) return false;
  if (authorRole === 'student') return false;
  return !!authorMetadataMap.get(authorId)?.canExposeName;
}

function isChatPostVisible(post, { includeDismissed = false } = {}) {
  if (!post) return false;
  if (!includeDismissed && post?.dismissedAt) return false;
  if (post?.isQuickPost && Number(post?.upvoteCount || 0) <= 0) return false;
  return true;
}

function isQuickPostOptionVisible(post, { includeDismissed = false, currentQuestionNumber = null } = {}) {
  if (!post?.isQuickPost) return false;
  if (!includeDismissed && post?.dismissedAt) return false;
  const questionNumber = Number(post?.quickPostQuestionNumber) || 0;
  if (questionNumber <= 0) return false;
  return currentQuestionNumber === null || questionNumber <= currentQuestionNumber;
}

function compareChatPosts(a, b) {
  const aDismissed = !!a?.dismissedAt;
  const bDismissed = !!b?.dismissedAt;
  if (aDismissed !== bDismissed) return aDismissed ? 1 : -1;

  // Posts, comments, and votes already update updatedAt. Reuse it so both
  // initial snapshots and live deltas keep the latest discussion first.
  const activityDiff = getTimestampMs(b?.updatedAt || b?.createdAt) - getTimestampMs(a?.updatedAt || a?.createdAt);
  if (activityDiff !== 0) return activityDiff;
  const createdDiff = getTimestampMs(b?.createdAt) - getTimestampMs(a?.createdAt);
  if (createdDiff !== 0) return createdDiff;
  return String(a?._id || '').localeCompare(String(b?._id || ''));
}

function getChatPostDisplayAuthor(post) {
  const upvoteUserIds = Array.isArray(post?.upvoteUserIds) ? post.upvoteUserIds.map((id) => String(id)) : [];
  if (post?.isQuickPost) {
    const firstUpvoterId = upvoteUserIds[0] || '';
    return {
      authorId: firstUpvoterId,
      authorRole: firstUpvoterId ? 'student' : 'system',
    };
  }

  return {
    authorId: normalizeAnswerValue(post?.authorId),
    authorRole: normalizeAnswerValue(post?.authorRole) || 'student',
  };
}

function serializeChatComment(comment, {
  includeNames = false,
  viewerUserId = '',
  authorMetadataMap = new Map(),
  allowRoleBasedExposure = true,
}) {
  const authorRole = normalizeAnswerValue(comment?.authorRole) || 'student';
  const authorId = normalizeAnswerValue(comment?.authorId);
  return {
    _id: String(comment?._id || ''),
    body: normalizeAnswerValue(comment?.body),
    bodyWysiwyg: normalizeAnswerValue(comment?.bodyWysiwyg),
    createdAt: comment?.createdAt || null,
    updatedAt: comment?.updatedAt || null,
    isOwnComment: authorId && authorId === viewerUserId,
    authorRole,
    authorName: shouldExposeChatAuthorName({
      authorId,
      authorRole,
      includeNames,
      viewerUserId,
      authorMetadataMap,
      allowRoleBasedExposure,
    })
      ? getChatAuthorDisplayName(authorMetadataMap, authorId)
      : null,
  };
}

function serializeChatPost(post, {
  includeNames = false,
  includeDismissed = false,
  viewerUserId = '',
  authorMetadataMap = new Map(),
  allowRoleBasedExposure = true,
}) {
  const upvoteUserIds = Array.isArray(post?.upvoteUserIds) ? post.upvoteUserIds.map((id) => String(id)) : [];
  const upvoteCount = Number(post?.upvoteCount);
  const comments = Array.isArray(post?.comments) ? post.comments : [];
  const displayAuthor = getChatPostDisplayAuthor(post);
  const authorId = displayAuthor.authorId;
  const authorRole = displayAuthor.authorRole;
  return {
    _id: String(post?._id || ''),
    body: normalizeAnswerValue(post?.body),
    bodyWysiwyg: normalizeAnswerValue(post?.bodyWysiwyg),
    createdAt: post?.createdAt || null,
    updatedAt: post?.updatedAt || null,
    upvoteCount: Number.isFinite(upvoteCount) ? upvoteCount : upvoteUserIds.length,
    viewerHasUpvoted: upvoteUserIds.includes(viewerUserId),
    isOwnPost: authorId && authorId === viewerUserId,
    isQuickPost: !!post?.isQuickPost,
    quickPostQuestionNumber: Number(post?.quickPostQuestionNumber) || null,
    dismissed: !!post?.dismissedAt,
    dismissedAt: includeDismissed ? (post?.dismissedAt || null) : null,
    authorRole,
    authorName: shouldExposeChatAuthorName({
      authorId,
      authorRole,
      includeNames,
      viewerUserId,
      authorMetadataMap,
      allowRoleBasedExposure,
    })
      ? getChatAuthorDisplayName(authorMetadataMap, authorId)
      : null,
    upvoterUserIds: includeNames ? upvoteUserIds : undefined,
    upvoterNames: includeNames
      ? upvoteUserIds
        .map((userId) => getChatAuthorDisplayName(authorMetadataMap, userId))
        .filter(Boolean)
      : undefined,
    comments: comments.map((comment) => serializeChatComment(comment, {
      includeNames,
      viewerUserId,
      authorMetadataMap,
      allowRoleBasedExposure,
    })),
  };
}

function serializeQuickPostOption(post) {
  const upvoteUserIds = Array.isArray(post?.upvoteUserIds) ? post.upvoteUserIds.map((id) => String(id)) : [];
  const upvoteCount = Number(post?.upvoteCount);
  return {
    postId: String(post?._id || ''),
    questionNumber: Number(post?.quickPostQuestionNumber) || null,
    label: normalizeAnswerValue(post?.body),
    upvoteCount: Number.isFinite(upvoteCount) ? upvoteCount : upvoteUserIds.length,
  };
}

function buildChatEventDelta(post, {
  includeNames = false,
  includeDismissed = false,
  currentQuestionNumber = null,
  authorMetadataMap = new Map(),
  allowRoleBasedExposure = true,
} = {}) {
  const delta = {};

  if (post !== undefined) {
    if (isChatPostVisible(post, { includeDismissed })) {
      const serializedPost = serializeChatPost(post, {
        includeNames,
        includeDismissed,
        viewerUserId: '',
        authorMetadataMap,
        allowRoleBasedExposure,
      });
      delete serializedPost.viewerHasUpvoted;
      delete serializedPost.isOwnPost;
      delete serializedPost.upvoterUserIds;
      delete serializedPost.upvoterNames;
      delta.post = serializedPost;
    } else {
      delta.post = null;
    }
  }

  if (post?.isQuickPost) {
    delta.quickPostOption = isQuickPostOptionVisible(post, { includeDismissed, currentQuestionNumber })
      ? serializeQuickPostOption(post)
      : null;
  }

  return delta;
}

async function loadSessionChatPayload({ session, course, request }) {
  const flags = getChatPermissionFlags({
    session,
    course,
    request,
    viewMode: getChatViewMode(request, isInstructorOrAdmin(course, request.user)),
  });
  const viewMode = getChatViewMode(request, flags.isInstructorView);

  if (viewMode === 'review' && !flags.isInstructorView) {
    return { forbidden: true };
  }

  if (viewMode !== 'review' && !flags.canViewLive) {
    return { forbidden: true };
  }

  const questionMetadata = await loadSessionChatQuestionMetadata(session);
  await ensureSessionQuickPosts(session, questionMetadata);

  const query = {
    scopeType: 'session',
    sessionId: String(session._id),
  };

  const posts = await Post.find(query)
    .select('authorId authorRole body bodyWysiwyg isQuickPost quickPostQuestionNumber upvoteUserIds upvoteCount comments dismissedAt createdAt updatedAt')
    .lean();

  const includeDismissed = viewMode === 'review' || (flags.isInstructorView && viewMode === 'live');
  const visiblePosts = posts
    .filter((post) => isChatPostVisible(post, { includeDismissed }))
    .sort(compareChatPosts);

  const authorMetadataMap = await buildChatAuthorMetadataMap(visiblePosts, {
    includeAllAuthors: flags.canViewNames,
  });
  const currentQuestionNumber = questionMetadata.currentQuestionNumber;
  const viewerUserId = String(request.user?.userId || '');
  const allowRoleBasedExposure = viewMode !== 'presentation';
  const serializedPosts = visiblePosts.map((post) => serializeChatPost(post, {
    includeNames: flags.canViewNames,
    includeDismissed,
    viewerUserId,
    authorMetadataMap,
    allowRoleBasedExposure,
  }));

  const quickPosts = serializedPosts
    .filter((post) => post.isQuickPost)
    .map((post) => ({
      postId: post._id,
      questionNumber: post.quickPostQuestionNumber,
      label: post.body,
      upvoteCount: post.upvoteCount,
      viewerHasUpvoted: post.viewerHasUpvoted,
    }))
    .filter((post) => Number(post.questionNumber) > 0 && (
      currentQuestionNumber === null || post.questionNumber <= currentQuestionNumber
    ))
    .sort((a, b) => b.questionNumber - a.questionNumber);
  const quickPostOptions = posts
    .filter((post) => isQuickPostOptionVisible(post, { includeDismissed, currentQuestionNumber }))
    .map((post) => ({
      ...serializeQuickPostOption(post),
      viewerHasUpvoted: Array.isArray(post?.upvoteUserIds)
        ? post.upvoteUserIds.map((id) => String(id)).includes(viewerUserId)
        : false,
    }))
    .sort((a, b) => b.questionNumber - a.questionNumber);

  return {
    enabled: !!session?.chatEnabled,
    richTextChatEnabled: isRichTextChatEnabled(session),
    viewMode,
    currentQuestionNumber,
    canPost: flags.canWrite,
    canComment: flags.canWrite,
    canVote: flags.canWrite && !flags.isInstructorView,
    canEditOwnPost: flags.canWrite && isRichTextChatEnabled(session),
    canDeleteOwnPost: flags.canWrite,
    canDeleteOwnComment: flags.canWrite,
    canDeleteAnyComment: flags.canModerate,
    canDismiss: flags.canModerate,
    canViewNames: flags.canViewNames,
    posts: serializedPosts,
    quickPosts,
    quickPostOptions,
  };
}

async function loadSessionChatContext(sessionId) {
  const session = await Session.findById(sessionId)
    .select('courseId status anonymous joined questions currentQuestion chatEnabled richTextChatEnabled activityAccessEnabled activityEverShared')
    .lean();
  if (!session) return { session: null, course: null };
  const course = await Course.findById(session.courseId)
    .select('students instructors allowSharedActivities inactive')
    .lean();
  return { session, course };
}

function collectCorrectAnswerHints(question) {
  const hints = [];
  const candidateFields = [
    question?.correctAnswer,
    question?.correctAnswers,
    question?.correctOption,
    question?.correctOptions,
    question?.correctIndex,
    question?.correctIndexes,
    question?.answerKey,
    question?.answerKeys,
    question?.rightAnswer,
    question?.rightAnswers,
  ];

  for (const candidate of candidateFields) {
    if (Array.isArray(candidate)) {
      candidate.forEach((entry) => {
        if (entry !== undefined && entry !== null && entry !== '') hints.push(entry);
      });
    } else if (candidate !== undefined && candidate !== null && candidate !== '') {
      hints.push(candidate);
    }
  }

  return hints;
}

function normalizeQuestionForReview(question) {
  if (!question) return question;
  const normalized = { ...question };
  const options = Array.isArray(normalized.options) ? normalized.options.map((opt) => ({ ...opt })) : [];

  if (options.length > 0) {
    const hintedIndices = new Set(
      collectCorrectAnswerHints(normalized)
        .map((hint) => resolveOptionIndex(hint, options))
        .filter((idx) => idx >= 0 && idx < options.length)
    );

    normalized.options = options.map((opt, idx) => ({
      ...opt,
      correct: parseBooleanLike(opt?.correct) || parseBooleanLike(opt?.isCorrect) || hintedIndices.has(idx),
    }));
  } else {
    normalized.options = options;
  }

  const solutionHtml = normalizeAnswerValue(
    normalized.solution
      || normalized.solutionHtml
      || normalized.explanation
      || normalized.explanationHtml
      || normalized.rationale
  );
  const solutionPlain = normalizeAnswerValue(
    normalized.solution_plainText
      || normalized.solutionPlainText
      || normalized.solutionText
      || normalized.explanation_plainText
      || normalized.explanationPlainText
      || normalized.rationaleText
  );

  if (solutionHtml) {
    normalized.solution = solutionHtml;
  }
  if (solutionPlain) {
    normalized.solution_plainText = solutionPlain;
  } else if (solutionHtml) {
    normalized.solution_plainText = toPlainText(solutionHtml);
  }

  return normalized;
}

function resolveOptionIndex(answer, options) {
  if (answer && typeof answer === 'object') {
    if (Array.isArray(answer)) return -1;
    if (answer.optionId !== undefined) return resolveOptionIndex(answer.optionId, options);
    if (answer._id !== undefined) return resolveOptionIndex(answer._id, options);
    if (answer.id !== undefined) return resolveOptionIndex(answer.id, options);
    if (answer.index !== undefined) return resolveOptionIndex(answer.index, options);
    if (answer.value !== undefined) return resolveOptionIndex(answer.value, options);
    if (answer.answer !== undefined) return resolveOptionIndex(answer.answer, options);
    if (answer.text !== undefined) return resolveOptionIndex(answer.text, options);
  }

  if (typeof answer === 'number' && Number.isInteger(answer)) {
    if (answer >= 0 && answer < options.length) return answer;
    if (answer >= 1 && answer <= options.length) return answer - 1;
    return -1;
  }

  const normalizedRaw = normalizeAnswerValue(answer);
  if (!normalizedRaw) return -1;
  const normalized = normalizedRaw.toLowerCase();

  // Current student UI may submit option index as a string (e.g. "0", "1").
  if (/^-?\d+$/.test(normalizedRaw)) {
    const parsed = Number(normalizedRaw);
    if (parsed >= 0 && parsed < options.length) return parsed;
    if (parsed >= 1 && parsed <= options.length) return parsed - 1;
  }

  // Legacy payloads may store option letters (e.g., "A", "B").
  if (/^[a-z]$/.test(normalized)) {
    const idx = normalized.charCodeAt(0) - 97;
    if (idx >= 0 && idx < options.length) return idx;
  }

  return options.findIndex((opt) => {
    if (normalizeAnswerValue(opt?._id).toLowerCase() === normalized) return true;
    if (normalizeComparableText(opt?.answer) === normalizeComparableText(normalizedRaw)) return true;
    if (normalizeComparableText(opt?.content) === normalizeComparableText(normalizedRaw)) return true;
    if (normalizeComparableText(opt?.plainText) === normalizeComparableText(normalizedRaw)) return true;
    return false;
  });
}

function sanitizeQuizQuestionForStudent(question, { revealAnswers = false } = {}) {
  if (!question) return question;
  const sanitized = { ...question };

  if (!revealAnswers) {
    if (Array.isArray(sanitized.options)) {
      sanitized.options = sanitized.options.map((option) => ({
        ...option,
        correct: undefined,
      }));
    }
    delete sanitized.correctNumerical;
    delete sanitized.solution;
    delete sanitized.solution_plainText;
    delete sanitized.solutionText;
    delete sanitized.solutionPlainText;
    delete sanitized.solutionHtml;
  }

  // Strip word cloud data and histogram data — students should not see it during quizzes.
  if (sanitized.sessionOptions) {
    sanitized.sessionOptions = { ...sanitized.sessionOptions };
    delete sanitized.sessionOptions.attemptStats;
    delete sanitized.sessionOptions.wordCloudData;
    delete sanitized.sessionOptions.histogramData;
  }

  return sanitized;
}

function sanitizeStudentReviewSession(session) {
  return {
    _id: session._id,
    name: session.name || '',
    description: session.description || '',
    quiz: !!session.quiz,
    practiceQuiz: !!session.practiceQuiz,
    anonymous: isAnonymousSession(session),
    studentCreated: !!session.studentCreated,
  };
}

function sanitizeStudentReviewQuestion(question) {
  const normalized = normalizeQuestionForReview(question);
  return {
    _id: normalized._id,
    type: normalized.type,
    content: normalized.content || '',
    plainText: normalized.plainText || '',
    options: (normalized.options || []).map((option) => ({
      answer: option.answer || '',
      content: option.content || '',
      plainText: option.plainText || '',
      correct: !!option.correct,
    })),
    correctNumerical: normalized.correctNumerical ?? null,
    toleranceNumerical: normalized.toleranceNumerical ?? null,
    solution: normalized.solution || '',
    solution_plainText: normalized.solution_plainText || '',
    sessionOptions: { points: Number(normalized.sessionOptions?.points || 0) },
  };
}

function sanitizeStudentReviewResponse(response) {
  return {
    questionId: response.questionId,
    attempt: response.attempt,
    answer: response.answer,
    answerWysiwyg: response.answerWysiwyg || '',
  };
}

// Anonymous review responses keep answer content only: no stored identity,
// timestamps (which could be matched to join times or extensions), or IP.
function sanitizeAnonymousReviewResponse(response, respondentKey) {
  return {
    _id: response._id,
    questionId: response.questionId,
    studentUserId: respondentKey,
    attempt: response.attempt,
    answer: response.answer,
    answerWysiwyg: response.answerWysiwyg || '',
    correct: response.correct,
    mark: response.mark,
    editable: response.editable,
  };
}

function buildOptionIndexCounts(answer, options = []) {
  const counts = new Map();
  const values = Array.isArray(answer) ? answer : [answer];

  values.forEach((value) => {
    const idx = resolveOptionIndex(value, options);
    if (idx < 0) return;
    counts.set(idx, (counts.get(idx) || 0) + 1);
  });

  return counts;
}

function buildAttemptStatsEntry(question, attemptNumber, responses = []) {
  if (!question) return null;
  if (isSlideQuestion(question)) return null;

  const normalizedAttemptNumber = Number(attemptNumber) || 1;
  const type = normalizeQuestionType(question);
  const options = question.options || [];
  const entry = {
    number: normalizedAttemptNumber,
    type: 'unknown',
    total: 0,
    distribution: [],
    answers: [],
    values: [],
    sum: 0,
    sumSquares: 0,
    min: null,
    max: null,
  };

  if ([0, 1, 3].includes(type) && options.length > 0) {
    entry.type = 'distribution';
    entry.distribution = options.map((opt, index) => ({
      index,
      answer: optionDisplayContent(opt, index),
      correct: !!opt.correct,
      count: 0,
    }));
  } else if (type === 2) {
    entry.type = 'shortAnswer';
  } else if (type === 4) {
    entry.type = 'numerical';
  }

  (responses || []).forEach((response) => {
    mergeResponseIntoAttemptStatsEntry(entry, question, response);
  });

  return entry;
}

function getResponseTimestampValue(response) {
  const timestamp = new Date(response?.updatedAt || response?.createdAt || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortResponseEntriesNewestFirst(entries = []) {
  return [...entries].sort((a, b) => {
    const timestampDiff = getResponseTimestampValue(b) - getResponseTimestampValue(a);
    if (timestampDiff !== 0) return timestampDiff;
    return String(b?._id || '').localeCompare(String(a?._id || ''));
  });
}

function mergeResponseIntoAttemptStatsEntry(entry, question, response) {
  if (!entry || !question || !response) return entry;

  entry.total = Number(entry.total || 0) + 1;
  const type = normalizeQuestionType(question);

  if ([0, 1, 3].includes(type) && Array.isArray(entry.distribution)) {
    const counts = buildOptionIndexCounts(response.answer, question.options || []);
    counts.forEach((count, index) => {
      if (!entry.distribution[index]) return;
      entry.distribution[index].count = Number(entry.distribution[index].count || 0) + count;
    });
    return entry;
  }

  if (type === 2) {
    entry.answers = [
      ...(Array.isArray(entry.answers) ? entry.answers : []),
      {
        studentUserId: getStatsStudentId(response),
        answer: response.answer,
        answerWysiwyg: response.answerWysiwyg || '',
        createdAt: response.createdAt || null,
        updatedAt: response.updatedAt || null,
      },
    ];
    return entry;
  }

  if (type === 4) {
    entry.answers = [
      ...(Array.isArray(entry.answers) ? entry.answers : []),
      {
        studentUserId: getStatsStudentId(response),
        answer: response.answer,
        createdAt: response.createdAt || null,
        updatedAt: response.updatedAt || null,
      },
    ];

    const numeric = Number(response.answer);
    if (!Number.isNaN(numeric)) {
      entry.values = [...(Array.isArray(entry.values) ? entry.values : []), numeric];
      entry.sum = Number(entry.sum || 0) + numeric;
      entry.sumSquares = Number(entry.sumSquares || 0) + (numeric * numeric);
      entry.min = entry.min == null ? numeric : Math.min(Number(entry.min), numeric);
      entry.max = entry.max == null ? numeric : Math.max(Number(entry.max), numeric);
    }
  }

  return entry;
}

function materializeAttemptStatsEntry(entry) {
  if (!entry) return null;

  const total = Number(entry.total || 0);
  if (entry.type === 'distribution') {
    return {
      type: 'distribution',
      distribution: (entry.distribution || []).map((item) => ({
        index: Number(item?.index) || 0,
        answer: item?.answer || '',
        correct: !!item?.correct,
        count: Number(item?.count || 0),
      })),
      total,
    };
  }

  if (entry.type === 'shortAnswer') {
    const answers = sortResponseEntriesNewestFirst(entry.answers || []);
    return {
      type: 'shortAnswer',
      answers: answers.map((item) => ({
        studentUserId: getStatsStudentId(item),
        answer: item?.answer,
        answerWysiwyg: item?.answerWysiwyg || '',
        createdAt: item?.createdAt || null,
        updatedAt: item?.updatedAt || null,
      })),
      total,
    };
  }

  if (entry.type === 'numerical') {
    const values = (entry.values || [])
      .map((value) => Number(value))
      .filter((value) => !Number.isNaN(value))
      .sort((a, b) => a - b);
    const totalValues = total || values.length;
    const sum = Number.isFinite(Number(entry.sum))
      ? Number(entry.sum)
      : values.reduce((acc, value) => acc + value, 0);
    const sumSquares = Number.isFinite(Number(entry.sumSquares))
      ? Number(entry.sumSquares)
      : values.reduce((acc, value) => acc + (value * value), 0);
    const mean = totalValues > 0 ? sum / totalValues : 0;
    const variance = totalValues > 0 ? Math.max(0, (sumSquares / totalValues) - (mean ** 2)) : 0;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
    const min = sorted.length > 0 ? (entry.min == null ? sorted[0] : Number(entry.min)) : 0;
    const max = sorted.length > 0 ? (entry.max == null ? sorted[sorted.length - 1] : Number(entry.max)) : 0;

    return {
      type: 'numerical',
      values,
      answers: sortResponseEntriesNewestFirst(entry.answers || []).map((item) => ({
        studentUserId: getStatsStudentId(item),
        answer: item?.answer,
        createdAt: item?.createdAt || null,
        updatedAt: item?.updatedAt || null,
      })),
      mean: Math.round(mean * 100) / 100,
      stdev: Math.round(Math.sqrt(variance) * 100) / 100,
      median,
      min,
      max,
      total: totalValues,
    };
  }

  return { type: entry.type || 'unknown', total };
}

function getAttemptStatsEntry(question, attemptNumber) {
  const normalizedAttemptNumber = Number(attemptNumber) || 1;
  return (question?.sessionOptions?.attemptStats || []).find(
    (entry) => Number(entry?.number) === normalizedAttemptNumber
  ) || null;
}

function isCanonicalAttemptStatsEntry(question, entry, responseCount) {
  if (!entry) return false;

  const expectedCount = Number(responseCount || 0);
  if (Number(entry.total || 0) !== expectedCount) return false;

  const type = normalizeQuestionType(question);
  const options = Array.isArray(question?.options) ? question.options : [];

  if ([0, 1, 3].includes(type) && options.length > 0) {
    return entry.type === 'distribution'
      && Array.isArray(entry.distribution)
      && entry.distribution.length === options.length;
  }

  if (type === 2) {
    return entry.type === 'shortAnswer'
      && Array.isArray(entry.answers)
      && entry.answers.length === expectedCount
      && entry.answers.every((answerEntry) => (
        answerEntry?.createdAt != null || answerEntry?.updatedAt != null
      ));
  }

  if (type === 4) {
    return entry.type === 'numerical'
      && Array.isArray(entry.answers)
      && entry.answers.length === expectedCount;
  }

  return entry.type !== 'unknown' || expectedCount === 0;
}

async function loadCanonicalAttemptStatsEntries(question, attemptNumber = null) {
  if (!question) return [];

  if (attemptNumber == null) {
    return getAttemptStatsEntries(question)
      .map((entry) => materializeAttemptStatsEntry(entry))
      .filter(Boolean);
  }

  const normalizedAttemptNumber = Number(attemptNumber) || 1;
  const cachedEntry = getAttemptStatsEntry(question, normalizedAttemptNumber);
  const responseCount = await Response.countDocuments({
    questionId: question._id,
    attempt: normalizedAttemptNumber,
  });

  if (isCanonicalAttemptStatsEntry(question, cachedEntry, responseCount)) {
    const materialized = materializeAttemptStatsEntry(cachedEntry);
    return materialized ? [materialized] : [];
  }

  const responses = responseCount > 0
    ? await Response.find({
      questionId: question._id,
      attempt: normalizedAttemptNumber,
    }).lean()
    : [];
  const rebuilt = buildResponseStats(question, responses, normalizedAttemptNumber);
  return rebuilt ? [rebuilt] : [];
}

async function getQuestionAttemptStats(question, attemptNumber) {
  const entries = await loadCanonicalAttemptStatsEntries(question, attemptNumber);
  return entries[0] || null;
}

function getAttemptStatsEntries(question, attemptNumber = null) {
  const entries = Array.isArray(question?.sessionOptions?.attemptStats)
    ? question.sessionOptions.attemptStats
    : [];
  if (attemptNumber == null) return entries;

  const entry = getAttemptStatsEntry(question, attemptNumber);
  return entry ? [entry] : [];
}

async function collectShortAnswerTextsFromAttemptStats(question, attemptNumber = null) {
  const entries = await loadCanonicalAttemptStatsEntries(question, attemptNumber);
  return entries.flatMap((entry) => (
    Array.isArray(entry?.answers) ? entry.answers : []
  )).map((answerEntry) => {
    if (answerEntry?.answerWysiwyg && typeof answerEntry.answerWysiwyg === 'string') {
      return answerEntry.answerWysiwyg;
    }
    if (typeof answerEntry?.answer === 'string') return answerEntry.answer;
    return '';
  }).filter(Boolean);
}

async function collectNumericalValuesFromAttemptStats(question, attemptNumber = null) {
  const values = [];
  const entries = await loadCanonicalAttemptStatsEntries(question, attemptNumber);
  entries.forEach((entry) => {
    if (Array.isArray(entry?.values) && entry.values.length > 0) {
      entry.values.forEach((value) => {
        const numeric = Number(value);
        if (!Number.isNaN(numeric)) values.push(numeric);
      });
      return;
    }

    (entry?.answers || []).forEach((answerEntry) => {
      const numeric = Number(answerEntry?.answer);
      if (!Number.isNaN(numeric)) values.push(numeric);
    });
  });
  return values;
}

function buildClearedWordCloudData() {
  return {
    wordFrequencies: [],
    visible: false,
    generatedAt: null,
  };
}

function buildClearedHistogramData() {
  return {
    bins: [],
    overflowLow: 0,
    overflowHigh: 0,
    rangeMin: null,
    rangeMax: null,
    numBins: null,
    visible: false,
    generatedAt: null,
  };
}

function buildResetGeneratedVisualizationUpdate() {
  const clearedWordCloud = buildClearedWordCloudData();
  const clearedHistogram = buildClearedHistogramData();
  return {
    'sessionOptions.wordCloudData.wordFrequencies': clearedWordCloud.wordFrequencies,
    'sessionOptions.wordCloudData.visible': clearedWordCloud.visible,
    'sessionOptions.wordCloudData.generatedAt': clearedWordCloud.generatedAt,
    'sessionOptions.histogramData.bins': clearedHistogram.bins,
    'sessionOptions.histogramData.overflowLow': clearedHistogram.overflowLow,
    'sessionOptions.histogramData.overflowHigh': clearedHistogram.overflowHigh,
    'sessionOptions.histogramData.rangeMin': clearedHistogram.rangeMin,
    'sessionOptions.histogramData.rangeMax': clearedHistogram.rangeMax,
    'sessionOptions.histogramData.numBins': clearedHistogram.numBins,
    'sessionOptions.histogramData.visible': clearedHistogram.visible,
    'sessionOptions.histogramData.generatedAt': clearedHistogram.generatedAt,
  };
}

function buildResponseStats(question, responses, attemptNumber = 1) {
  return materializeAttemptStatsEntry(buildAttemptStatsEntry(question, attemptNumber, responses));
}

function formatInstructorLiveResponseStats(responseStats, studentNameById = {}, includeStudentNames = false, anonymous = false) {
  if (!responseStats) return responseStats;

  if (responseStats.type === 'shortAnswer' && Array.isArray(responseStats.answers)) {
    const answers = sortResponseEntriesNewestFirst(responseStats.answers);
    return {
      ...responseStats,
      answers: answers.map((entry) => ({
        answer: entry.answer,
        answerWysiwyg: entry.answerWysiwyg,
        ...(!anonymous ? { createdAt: entry.createdAt || null, updatedAt: entry.updatedAt || null } : {}),
        ...(includeStudentNames
          ? { studentName: studentNameById[getResponseStudentId(entry)] || 'Unknown Student' }
          : {}),
      })),
    };
  }

  if (responseStats.type === 'numerical' && Array.isArray(responseStats.answers)) {
    const answers = sortResponseEntriesNewestFirst(responseStats.answers);
    return {
      ...responseStats,
      answers: answers.map((entry) => ({
        answer: entry.answer,
        ...(!anonymous ? { createdAt: entry.createdAt || null, updatedAt: entry.updatedAt || null } : {}),
        ...(includeStudentNames
          ? { studentName: studentNameById[getResponseStudentId(entry)] || 'Unknown Student' }
          : {}),
      })),
    };
  }

  return responseStats;
}

function formatStudentLiveResponseStats(responseStats, { showCorrect = false, showResponseList = true, anonymous = false } = {}) {
  if (!responseStats) return responseStats;

  if (responseStats.type === 'distribution' && Array.isArray(responseStats.distribution)) {
    return {
      ...responseStats,
      distribution: responseStats.distribution.map((entry) => {
        const sanitized = {
          index: entry?.index,
          answer: entry?.answer,
          count: Number(entry?.count || 0),
        };
        if (showCorrect) sanitized.correct = !!entry?.correct;
        return sanitized;
      }),
    };
  }

  if (responseStats.type === 'shortAnswer' && Array.isArray(responseStats.answers)) {
    const answers = sortResponseEntriesNewestFirst(responseStats.answers);
    return {
      ...responseStats,
      answers: showResponseList
        ? answers.map((entry) => ({
          answer: entry.answer,
          answerWysiwyg: entry.answerWysiwyg,
          ...(!anonymous ? { createdAt: entry.createdAt || null, updatedAt: entry.updatedAt || null } : {}),
        }))
        : [],
    };
  }

  if (responseStats.type === 'numerical' && Array.isArray(responseStats.answers)) {
    const answers = sortResponseEntriesNewestFirst(responseStats.answers);
    return {
      ...responseStats,
      answers: showResponseList
        ? answers.map((entry) => ({
          answer: entry.answer,
          ...(!anonymous ? { createdAt: entry.createdAt || null, updatedAt: entry.updatedAt || null } : {}),
        }))
        : [],
    };
  }

  return responseStats;
}

function toPlainObject(value) {
  if (!value) return null;
  return typeof value.toObject === 'function' ? value.toObject() : { ...value };
}

function sanitizeStudentLiveQuestion(question, { showCorrect = false } = {}) {
  const questionPayload = toPlainObject(question);
  if (!questionPayload) return null;

  const sanitized = { ...questionPayload };
  if (!showCorrect) {
    if (Array.isArray(sanitized.options)) {
      sanitized.options = sanitized.options.map((option) => {
        const nextOption = { ...option };
        delete nextOption.correct;
        return nextOption;
      });
    }
    delete sanitized.correctNumerical;
    delete sanitized.solution;
    delete sanitized.solution_plainText;
    delete sanitized.solutionPlainText;
    delete sanitized.solutionText;
    delete sanitized.solutionHtml;
  }

  if (sanitized.sessionOptions) {
    sanitized.sessionOptions = { ...sanitized.sessionOptions };
    delete sanitized.sessionOptions.attemptStats;
    delete sanitized.sessionOptions.wordCloudData;
    delete sanitized.sessionOptions.histogramData;
  }
  delete sanitized.sessionProperties;
  return sanitized;
}

function sanitizeStudentOwnResponse(response) {
  if (!response) return null;
  return {
    _id: response._id,
    questionId: response.questionId,
    attempt: response.attempt,
    answer: response.answer,
    answerWysiwyg: response.answerWysiwyg || '',
    createdAt: response.createdAt || null,
    updatedAt: response.updatedAt || null,
    editable: !!response.editable,
  };
}

function buildStudentLiveQuestionSnapshot(question, extra = {}, { responseStats: resolvedResponseStats, anonymous = false } = {}) {
  const questionHidden = !!question?.sessionOptions?.hidden;
  const collectsResponses = isQuestionResponseCollectionEnabled(question);
  const showStats = collectsResponses && !!question?.sessionOptions?.stats;
  const showCorrect = collectsResponses && !!question?.sessionOptions?.correct;
  const showResponseList = question?.sessionOptions?.responseListVisible !== false;
  const currentAttempt = collectsResponses ? getCurrentAttempt(question) : null;
  const cachedStats = resolvedResponseStats !== undefined
    ? resolvedResponseStats
    : currentAttempt
      ? (anonymous ? getAnonymousLiveResponseStats(question, currentAttempt.number)
        : materializeAttemptStatsEntry(getAttemptStatsEntry(question, currentAttempt.number)))
      : null;
  const responseStats = showStats
    ? formatStudentLiveResponseStats(cachedStats, { showCorrect, showResponseList, anonymous })
    : null;
  const wordCloudData = showStats && question?.sessionOptions?.wordCloudData?.visible
    ? question.sessionOptions.wordCloudData
    : null;
  const histogramData = showStats && question?.sessionOptions?.histogramData?.visible
    ? question.sessionOptions.histogramData
    : null;

  return {
    questionId: String(question?._id || ''),
    question: questionHidden ? null : sanitizeStudentLiveQuestion(question, { showCorrect }),
    currentAttempt,
    questionHidden,
    showStats,
    showCorrect,
    showResponseList,
    responseStats,
    wordCloudData,
    histogramData,
    ...extra,
  };
}

function serializeLiveResponseEntry(response, { studentName = null, anonymous = false } = {}) {
  if (!response) return null;

  const entry = {
    _id: response._id,
    attempt: response.attempt,
    questionId: response.questionId,
    answer: response.answer,
    answerWysiwyg: response.answerWysiwyg,
    correct: response.correct,
    mark: response.mark,
    ...(!anonymous ? { createdAt: response.createdAt || null, updatedAt: response.updatedAt || null } : {}),
    editable: response.editable,
  };

  if (studentName) {
    entry.studentName = studentName;
  }

  return entry;
}

async function buildResponseAddedStatsDelta(question, attemptNumber, responseCount = null, { force = false } = {}) {
  if (!force && !question?.sessionOptions?.stats) return null;

  const normalizedAttemptNumber = Number(attemptNumber) || 1;
  const cachedEntry = getAttemptStatsEntry(question, normalizedAttemptNumber);
  const expectedCount = Number(responseCount);
  const responseStats = cachedEntry
    && (responseCount == null || isCanonicalAttemptStatsEntry(question, cachedEntry, expectedCount))
    ? materializeAttemptStatsEntry(cachedEntry)
    : await getQuestionAttemptStats(question, normalizedAttemptNumber);
  if (!responseStats) return null;

  if (responseStats.type === 'shortAnswer') {
    return {
      type: 'shortAnswer',
      total: Number(responseStats.total || 0),
    };
  }

  if (responseStats.type === 'numerical') {
    return {
      type: 'numerical',
      mean: responseStats.mean,
      stdev: responseStats.stdev,
      median: responseStats.median,
      min: responseStats.min,
      max: responseStats.max,
      total: Number(responseStats.total || 0),
    };
  }

  return responseStats;
}

async function ensureQuestionAttemptStatsEntry(question, attemptNumber) {
  const normalizedAttemptNumber = Number(attemptNumber) || 1;
  if (!question?._id) return;
  if (getAttemptStatsEntry(question, normalizedAttemptNumber)) return;

  const entry = buildAttemptStatsEntry(question, normalizedAttemptNumber);
  if (!entry) return;

  await Question.updateOne(
    {
      _id: question._id,
      'sessionOptions.attemptStats.number': { $ne: normalizedAttemptNumber },
    },
    {
      $push: { 'sessionOptions.attemptStats': entry },
    }
  );
}

async function upsertQuestionAttemptStatsEntry(questionId, attemptNumber, entry) {
  if (!questionId || !entry) return;
  const normalizedAttemptNumber = Number(attemptNumber) || 1;

  const replaceResult = await Question.updateOne(
    {
      _id: questionId,
      'sessionOptions.attemptStats.number': normalizedAttemptNumber,
    },
    {
      $set: { 'sessionOptions.attemptStats.$': entry },
    }
  );

  const modifiedCount = Number(
    replaceResult?.modifiedCount ?? replaceResult?.nModified ?? 0
  );
  if (modifiedCount > 0) return;

  await Question.updateOne(
    {
      _id: questionId,
      'sessionOptions.attemptStats.number': { $ne: normalizedAttemptNumber },
    },
    {
      $push: { 'sessionOptions.attemptStats': entry },
    }
  );
}

// Anonymous live results use the same attempt cache and calculations as ordinary
// sessions, but only published batches are readable. Never use the canonical
// cache repair helper here: it includes answers not yet eligible for release.
function getAnonymousLiveResponseStats(question, attemptNumber) {
  const entry = getAttemptStatsEntry(question, attemptNumber);
  if (!entry || entry.total < MIN_ANONYMOUS_RESPONDENTS) return null;
  return formatInstructorLiveResponseStats(materializeAttemptStatsEntry(entry), {}, false, true);
}

async function publishAnonymousAttemptStats(question, attemptNumber, responses) {
  // First response wins if concurrent submissions created duplicate documents.
  // Count people, not documents; discard identity and arrival order before caching.
  const distinctResponses = new Map();
  for (const response of responses) {
    const participantId = getResponseStudentId(response);
    if (participantId && !distinctResponses.has(participantId)) distinctResponses.set(participantId, response);
  }
  const total = distinctResponses.size;
  const previousTotal = Number(getAttemptStatsEntry(question, attemptNumber)?.total || 0);
  if (total - previousTotal < MIN_ANONYMOUS_RESPONDENTS) return { question, published: false };

  const entry = buildAttemptStatsEntry(question, attemptNumber, [...distinctResponses.values()]);
  entry.answers = entry.answers.map(({ answer, answerWysiwyg }) => ({ answer, answerWysiwyg }))
    .sort((a, b) => JSON.stringify([a.answer, a.answerWysiwyg]).localeCompare(JSON.stringify([b.answer, b.answerWysiwyg])));
  entry.values.sort((a, b) => a - b);

  // More responses may have arrived since the count used to reserve this batch.
  // Advance the count in the same write so the published snapshot is coherent.
  const countUpdate = { 'sessionProperties.lastAttemptResponseCount': total };

  // Compare-and-set protects the minimum gap even when different replicas build
  // overlapping batches. A late writer cannot replace a newer published cache.
  let updated = await Question.findOneAndUpdate({
    _id: question._id,
    'sessionOptions.attemptStats': { $elemMatch: {
      number: attemptNumber, total: { $lte: total - MIN_ANONYMOUS_RESPONDENTS },
    } },
  }, { $set: { 'sessionOptions.attemptStats.$': entry }, $max: countUpdate }, { returnDocument: 'after' }).lean();
  if (!updated) {
    updated = await Question.findOneAndUpdate({
      _id: question._id,
      'sessionOptions.attemptStats.number': { $ne: attemptNumber },
    }, { $push: { 'sessionOptions.attemptStats': entry }, $max: countUpdate }, { returnDocument: 'after' }).lean();
  }
  return { question: updated || question, published: !!updated };
}

async function appendAnonymousResponseToQuestionAttemptStats(question, attemptNumber) {
  const count = await Response.countDocuments({ questionId: question._id, attempt: attemptNumber });
  const tracked = await Question.findByIdAndUpdate(question._id, {
    $set: { 'sessionProperties.lastAttemptNumber': attemptNumber },
    $max: { 'sessionProperties.lastAttemptResponseCount': count, 'sessionProperties.lastAttemptAggregateCount': 0 },
  }, { returnDocument: 'after' }).lean();
  if (!tracked) return { question, published: false };

  // Reserve at most one rebuild per batch, across replicas. Most submissions
  // keep the existing count-only fast path and never load response documents.
  const reservedCount = Number(tracked.sessionProperties?.lastAttemptAggregateCount || 0);
  const responseCount = Number(tracked.sessionProperties?.lastAttemptResponseCount || 0);
  if (responseCount - reservedCount < MIN_ANONYMOUS_RESPONDENTS) return { question: tracked, published: false };
  const reserved = await Question.updateOne({
    _id: question._id,
    'sessionProperties.lastAttemptNumber': attemptNumber,
    'sessionProperties.lastAttemptAggregateCount': reservedCount,
  }, { $set: { 'sessionProperties.lastAttemptAggregateCount': responseCount } });
  if (!reserved.modifiedCount) return { question: tracked, published: false };

  try {
    const responses = await Response.find({ questionId: question._id, attempt: attemptNumber })
      .select('studentUserId answer answerWysiwyg').sort({ createdAt: 1, _id: 1 }).lean();
    return await publishAnonymousAttemptStats(tracked, attemptNumber, responses);
  } catch (error) {
    await Question.updateOne({
      _id: question._id,
      'sessionProperties.lastAttemptNumber': attemptNumber,
      'sessionProperties.lastAttemptAggregateCount': responseCount,
    }, { $set: { 'sessionProperties.lastAttemptAggregateCount': reservedCount } });
    throw error;
  }
}

async function appendResponseToQuestionAttemptStats(question, attemptNumber, response) {
  const normalizedAttemptNumber = Number(attemptNumber) || 1;
  if (!question?._id || !response) return null;

  const cachedEntry = getAttemptStatsEntry(question, normalizedAttemptNumber);
  const trackedCount = Number(question?.sessionProperties?.lastAttemptResponseCount || 0);
  const aggregateCount = Number(question?.sessionProperties?.lastAttemptAggregateCount || 0);
  if (aggregateCount !== trackedCount || !isCanonicalAttemptStatsEntry(question, cachedEntry, trackedCount)) {
    const responses = await Response.find({
      questionId: question._id,
      attempt: normalizedAttemptNumber,
    }).sort({ updatedAt: -1, createdAt: -1, _id: -1 }).lean();
    const rebuilt = buildAttemptStatsEntry(question, normalizedAttemptNumber, responses);
    await upsertQuestionAttemptStatsEntry(question._id, normalizedAttemptNumber, rebuilt);
    return Question.findByIdAndUpdate(
      question._id,
      {
        $set: {
          'sessionProperties.lastAttemptNumber': normalizedAttemptNumber,
          'sessionProperties.lastAttemptResponseCount': responses.length,
          'sessionProperties.lastAttemptAggregateCount': responses.length,
        },
      },
      { returnDocument: 'after' }
    ).lean();
  }

  await ensureQuestionAttemptStatsEntry(question, normalizedAttemptNumber);

  const filter = {
    _id: question._id,
    'sessionOptions.attemptStats.number': normalizedAttemptNumber,
    'sessionProperties.lastAttemptNumber': normalizedAttemptNumber,
  };
  const attemptArrayFilter = [{ 'attempt.number': normalizedAttemptNumber }];
  const type = normalizeQuestionType(question);
  let update = {
    $inc: {
      'sessionOptions.attemptStats.$[attempt].total': 1,
      'sessionProperties.lastAttemptResponseCount': 1,
      'sessionProperties.lastAttemptAggregateCount': 1,
    },
  };
  let arrayFilters = attemptArrayFilter;

  if ([0, 1, 3].includes(type) && Array.isArray(question.options) && question.options.length > 0) {
    const optionCounts = buildOptionIndexCounts(response.answer, question.options);
    arrayFilters = [...attemptArrayFilter];
    let filterIndex = 0;

    optionCounts.forEach((count, index) => {
      const filterName = `dist${filterIndex}`;
      update.$inc[`sessionOptions.attemptStats.$[attempt].distribution.$[${filterName}].count`] = count;
      arrayFilters.push({ [`${filterName}.index`]: index });
      filterIndex += 1;
    });

  } else if (type === 2) {
    update = {
      ...update,
      $push: {
        'sessionOptions.attemptStats.$[attempt].answers': {
          studentUserId: getStatsStudentId(response),
          answer: response.answer,
          answerWysiwyg: response.answerWysiwyg || '',
          createdAt: response.createdAt || null,
          updatedAt: response.updatedAt || null,
        },
      },
    };
  } else if (type === 4) {
    const numeric = Number(response.answer);
    update = {
      ...update,
      $push: {
        'sessionOptions.attemptStats.$[attempt].answers': {
          studentUserId: getStatsStudentId(response),
          answer: response.answer,
          createdAt: response.createdAt || null,
          updatedAt: response.updatedAt || null,
        },
      },
    };

    if (!Number.isNaN(numeric)) {
      update.$push['sessionOptions.attemptStats.$[attempt].values'] = numeric;
      update.$inc['sessionOptions.attemptStats.$[attempt].sum'] = numeric;
      update.$inc['sessionOptions.attemptStats.$[attempt].sumSquares'] = numeric * numeric;
      update.$min = { 'sessionOptions.attemptStats.$[attempt].min': numeric };
      update.$max = { 'sessionOptions.attemptStats.$[attempt].max': numeric };
    }
  }

  const updatedQuestion = await Question.findOneAndUpdate(
    filter,
    update,
    { arrayFilters, returnDocument: 'after' }
  ).lean();
  if (updatedQuestion) return updatedQuestion;

  // Legacy questions may not have initialized attempt statistics/tracking.
  // Repair that uncommon state once; the normal concurrent submission path
  // above remains a single atomic Question update with no count query.
  const responses = await Response.find({
    questionId: question._id,
    attempt: normalizedAttemptNumber,
  }).sort({ updatedAt: -1, createdAt: -1, _id: -1 }).lean();
  const rebuilt = buildAttemptStatsEntry(question, normalizedAttemptNumber, responses);
  await upsertQuestionAttemptStatsEntry(question._id, normalizedAttemptNumber, rebuilt);
  return Question.findByIdAndUpdate(
    question._id,
    {
      $set: {
        'sessionProperties.lastAttemptNumber': normalizedAttemptNumber,
        'sessionProperties.lastAttemptResponseCount': responses.length,
        'sessionProperties.lastAttemptAggregateCount': responses.length,
      },
    },
    { returnDocument: 'after' }
  ).lean();
}

async function loadOrderedQuestions(questionIds = []) {
  if (!Array.isArray(questionIds) || questionIds.length === 0) return [];
  const questions = await Question.find({ _id: { $in: questionIds } }).lean();
  const byId = new Map(questions.map((question) => [String(question._id), question]));
  return questionIds.map((questionId) => byId.get(String(questionId))).filter(Boolean);
}

async function loadSessionProgress(questionIds = [], currentQuestionId = null) {
  const orderedIds = Array.isArray(questionIds)
    ? questionIds.map((questionId) => String(questionId)).filter(Boolean)
    : [];
  if (orderedIds.length === 0) {
    return {
      pageProgress: null,
      questionProgress: null,
    };
  }

  const currentId = currentQuestionId ? String(currentQuestionId) : '';
  const currentIndex = currentId ? orderedIds.findIndex((questionId) => questionId === currentId) : -1;
  const questions = await Question.find({ _id: { $in: orderedIds } })
    .select('_id type')
    .lean();
  const questionById = new Map(questions.map((question) => [String(question._id), question]));

  let questionsSeen = 0;
  const totalQuestions = orderedIds.reduce((count, questionId) => {
    const question = questionById.get(questionId);
    return count + (question && isQuestionResponseCollectionEnabled(question) ? 1 : 0);
  }, 0);

  orderedIds.forEach((questionId, index) => {
    if (currentIndex >= 0 && index > currentIndex) return;
    const question = questionById.get(questionId);
    if (question && isQuestionResponseCollectionEnabled(question)) {
      questionsSeen += 1;
    }
  });

  return {
    pageProgress: currentIndex >= 0
      ? { current: currentIndex + 1, total: orderedIds.length }
      : null,
    questionProgress: { current: questionsSeen, total: totalQuestions },
  };
}

async function loadAnswerableQuestionIdsBySession(sessionDocs = []) {
  const allQuestionIds = [...new Set(
    (sessionDocs || [])
      .flatMap((session) => (Array.isArray(session?.questions) ? session.questions : []))
      .map((questionId) => String(questionId))
      .filter(Boolean)
  )];

  if (allQuestionIds.length === 0) return new Map();

  const questions = await Question.find({ _id: { $in: allQuestionIds } })
    .select('_id type')
    .lean();
  const questionById = new Map(questions.map((question) => [String(question._id), question]));

  const answerableBySessionId = new Map();
  (sessionDocs || []).forEach((session) => {
    const sessionId = String(session?._id || '');
    if (!sessionId) return;
    const answerableIds = (session.questions || [])
      .map((questionId) => String(questionId))
      .filter((questionId) => {
        const question = questionById.get(questionId);
        return question && isQuestionResponseCollectionEnabled(question);
      });
    answerableBySessionId.set(sessionId, answerableIds);
  });

  return answerableBySessionId;
}

async function hydrateSessionResponseTracking(sessionDocs = []) {
  const sessionsToHydrate = (sessionDocs || []).filter((session) => sessionResponseTrackingNeedsHydration(session));
  if (sessionsToHydrate.length === 0) {
    return sessionDocs;
  }

  const questionIds = [...new Set(
    sessionsToHydrate.flatMap((session) => normalizeQuestionIds(session?.questions))
  )];
  const responseCountsByQuestionId = questionIds.length > 0
    ? new Map(
      (await Response.aggregate([
        { $match: { questionId: { $in: questionIds } } },
        { $group: { _id: '$questionId', count: { $sum: 1 } } },
      ]))
        .map((entry) => [String(entry?._id || ''), Number(entry?.count || 0)])
        .filter(([questionId]) => questionId)
    )
    : new Map();

  const hydratedBySessionId = new Map();
  const bulkOps = [];

  sessionsToHydrate.forEach((session) => {
    const questionResponseCounts = Object.fromEntries(
      normalizeQuestionIds(session?.questions).map((questionId) => [
        questionId,
        Number(responseCountsByQuestionId.get(questionId) || 0),
      ])
    );
    const hydratedSession = {
      ...session,
      questionResponseCounts,
      hasResponses: Object.values(questionResponseCounts).some((count) => count > 0),
    };
    hydratedBySessionId.set(String(session?._id || ''), hydratedSession);
    bulkOps.push({
      updateOne: {
        filter: { _id: session._id },
        update: {
          $set: {
            questionResponseCounts,
            hasResponses: hydratedSession.hasResponses,
          },
        },
      },
    });
  });

  if (bulkOps.length > 0) {
    await Session.bulkWrite(bulkOps, { ordered: false });
  }

  return (sessionDocs || []).map((session) => hydratedBySessionId.get(String(session?._id || '')) || session);
}

async function hydrateSingleSessionResponseTracking(session) {
  if (!session) return session;
  const [hydratedSession] = await hydrateSessionResponseTracking([session]);
  return hydratedSession || session;
}

async function incrementQuestionAttemptResponseTracking(questionId, attemptNumber) {
  const normalizedQuestionId = normalizeAnswerValue(questionId);
  const normalizedAttemptNumber = Number(attemptNumber) || 1;
  const incrementedQuestion = await Question.findOneAndUpdate(
    {
      _id: normalizedQuestionId,
      'sessionProperties.lastAttemptNumber': normalizedAttemptNumber,
    },
    {
      $inc: {
        'sessionProperties.lastAttemptResponseCount': 1,
        'sessionProperties.lastAttemptAggregateCount': 1,
      },
    },
    { returnDocument: 'after' }
  ).lean();

  if (incrementedQuestion) {
    return incrementedQuestion;
  }

  const currentAttemptCount = await Response.countDocuments({
    questionId: normalizedQuestionId,
    attempt: normalizedAttemptNumber,
  });

  return Question.findByIdAndUpdate(
    normalizedQuestionId,
    {
      $set: {
        'sessionProperties.lastAttemptNumber': normalizedAttemptNumber,
        'sessionProperties.lastAttemptResponseCount': currentAttemptCount,
        'sessionProperties.lastAttemptAggregateCount': currentAttemptCount,
      },
    },
    { returnDocument: 'after' }
  ).lean();
}

async function incrementSessionResponseTracking(session, questionId) {
  const normalizedQuestionId = normalizeAnswerValue(questionId);
  const questionResponseCounts = getSessionQuestionResponseCounts(session);

  if (
    !sessionResponseTrackingNeedsHydration(session)
    && Object.prototype.hasOwnProperty.call(questionResponseCounts, normalizedQuestionId)
  ) {
    return Session.findByIdAndUpdate(
      session._id,
      {
        $inc: { [`questionResponseCounts.${normalizedQuestionId}`]: 1 },
        $set: { hasResponses: true },
      },
      { returnDocument: 'after' }
    ).lean();
  }

  return hydrateSingleSessionResponseTracking(session);
}

function buildSessionForUser(session, user, { instructorView = false, outsideActivity = false } = {}) {
  const normalized = { ...(session || {}) };
  const runtime = getQuizRuntimeState(normalized, {
    userId: user?.userId,
    instructorView,
  });
  normalized.status = runtime.effectiveStatus;

  if (isQuizLikeSession(normalized)) {
    const submittedQuiz = Array.isArray(normalized.submittedQuiz) ? normalized.submittedQuiz : [];
    const joined = Array.isArray(normalized.joined) ? normalized.joined : [];
    const participantId = getSessionParticipantId(normalized, user?.userId);
    normalized.quizSubmittedByCurrentUser = submittedQuiz.includes(participantId);
    normalized.quizStartedByCurrentUser = joined.includes(participantId);
    normalized.quizHasActiveExtensions = runtime.quizHasActiveExtensions;
    normalized.quizHasRemainingExtensions = runtime.quizHasRemainingExtensions;
    normalized.activeExtensionsCount = runtime.activeExtensionsCount;
    normalized.userHasActiveQuizExtension = runtime.userHasActiveQuizExtension;
    normalized.userHasUpcomingQuizExtension = runtime.userHasUpcomingQuizExtension;
    if (runtime.quizHasRemainingExtensions) normalized.reviewable = false;
    if (!instructorView && (runtime.userHasActiveQuizExtension || runtime.userHasUpcomingQuizExtension)) {
      const extension = getNormalizedQuizExtensions(session).find((entry) => entry.userId === String(user?.userId));
      // Student dates and course-card labels must describe their own window,
      // not an already elapsed class-wide deadline.
      normalized.quizStart = extension.quizStart;
      normalized.quizEnd = extension.quizEnd;
    }
  }

  normalized.hasResponses = getSessionHasResponses(normalized);
  normalized.anonymous = isAnonymousSession(normalized);

  if (!instructorView) {
    delete normalized.submittedQuiz;
    delete normalized.joinRecords;
    delete normalized.joined;
    delete normalized.currentJoinCode;
  }
  if (outsideActivity) {
    delete normalized.quizExtensions;
    delete normalized.creator;
    delete normalized.activeExtensionsCount;
    delete normalized.quizHasActiveExtensions;
    delete normalized.quizHasRemainingExtensions;
    delete normalized.userHasActiveQuizExtension;
    delete normalized.userHasUpcomingQuizExtension;
  }
  delete normalized.questionResponseCounts;
  // AI logs are stored separately and are always instructor-only. Remove any
  // legacy field defensively so old database documents cannot leak it.
  delete normalized.aiGradingLog;

  return instructorView ? redactAnonymousSessionAttendance(normalized) : normalized;
}

/** Instructor payload for raw session documents returned by mutation routes. */
function serializeInstructorSession(session) {
  if (!session) return session;
  const plain = typeof session.toObject === 'function' ? session.toObject() : { ...session };
  return redactAnonymousSessionAttendance(plain);
}

function getDefaultFeedbackSummary() {
  return {
    feedbackSeenAt: null,
    feedbackQuestionIds: [],
    feedbackCount: 0,
    newFeedbackQuestionIds: [],
    newFeedbackCount: 0,
    hasNewFeedback: false,
  };
}

function summarizeFeedbackFromGrades(grades = []) {
  if (!Array.isArray(grades) || grades.length === 0) {
    return getDefaultFeedbackSummary();
  }

  const combinedMarks = [];
  let latestFeedbackSeenAtMs = Number.NaN;

  grades.forEach((grade) => {
    const marks = Array.isArray(grade?.marks) ? grade.marks : [];
    combinedMarks.push(...marks);

    const feedbackSeenAtMs = getTimestampMs(grade?.feedbackSeenAt);
    if (!Number.isFinite(feedbackSeenAtMs)) return;
    if (!Number.isFinite(latestFeedbackSeenAtMs) || feedbackSeenAtMs > latestFeedbackSeenAtMs) {
      latestFeedbackSeenAtMs = feedbackSeenAtMs;
    }
  });

  const summary = summarizeGradeFeedback({
    marks: combinedMarks,
    feedbackSeenAt: Number.isFinite(latestFeedbackSeenAtMs)
      ? new Date(latestFeedbackSeenAtMs)
      : null,
  });

  return {
    ...getDefaultFeedbackSummary(),
    ...summary,
  };
}

// ---------------------------------------------------------------------------
// WebSocket notification helpers
// ---------------------------------------------------------------------------

function sendToUsersById(app, userIds, event, payload) {
  if (typeof app.wsSendToUsers !== 'function') return;
  const normalizedUserIds = [...new Set((userIds || []).map((userId) => String(userId)).filter(Boolean))];
  if (normalizedUserIds.length === 0) return;
  app.wsSendToUsers(normalizedUserIds, event, {
    emittedAt: payload?.emittedAt || new Date().toISOString(),
    ...payload,
  });
}

function sendToCourseMembers(app, course, event, payload) {
  if (!course) return;
  sendToUsersById(app, [
    ...(course.instructors || []),
    ...(course.students || []),
  ], event, payload);
}

function sendToInstructors(app, course, event, payload) {
  if (!course) return;
  sendToUsersById(app, course.instructors || [], event, payload);
}

function sendToStudents(app, course, event, payload) {
  if (!course) return;
  sendToUsersById(app, course.students || [], event, payload);
}

async function sendToJoinedStudents(app, course, session, event, payload) {
  if (!session) return;
  // Ordinary course sessions keep their existing zero-query fanout path.
  let grantIds = [];
  if (session.activityAccessEnabled) {
    try { grantIds = await getActivityRecipientUserIds(session, course); }
    catch (error) {
      app.log?.warn?.({ err: error }, 'Failed to resolve activity recipients');
      return;
    }
  }
  const eligibleIds = [...(course?.students || []), ...grantIds];
  const eligibleIdSet = new Set(eligibleIds.map(String));
  const recipients = isAnonymousSession(session)
    ? resolveSessionParticipantUserIds(session, session.joined || [], eligibleIds)
    : session.activityEverShared
      ? (session.joined || []).filter((id) => eligibleIdSet.has(String(id)))
      : session.joined || [];
  sendToUsersById(app, recipients, event, payload);
}

function sendToUser(app, userId, event, payload) {
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) return;
  if (typeof app.wsSendToUser === 'function') {
    app.wsSendToUser(normalizedUserId, event, {
      emittedAt: payload?.emittedAt || new Date().toISOString(),
      ...payload,
    });
    return;
  }
  if (typeof app.wsSendToUsers === 'function') {
    app.wsSendToUsers([normalizedUserId], event, {
      emittedAt: payload?.emittedAt || new Date().toISOString(),
      ...payload,
    });
  }
}

/** Delta: session metadata changed (name/description/reviewable/extensions/etc). */
function sendToActivityRecipients(app, sessionId, event, payload) {
  void Session.findById(sessionId).select('activityAccessEnabled courseId').lean().then(async (session) => {
    if (!session?.activityAccessEnabled) return;
    const recipients = await getActivityRecipientUserIds({ ...session, _id: sessionId });
    sendToUsersById(app, recipients, event, payload);
  }).catch((error) => app.log?.warn?.({ err: error }, 'Failed to broadcast activity event'));
}

function notifySessionMetadataChanged(app, course, sessionId) {
  if (!sessionId) return;
  const payload = { courseId: String(course._id), sessionId: String(sessionId) };
  sendToCourseMembers(app, course, 'session:metadata-changed', payload);
  sendToActivityRecipients(app, sessionId, 'session:metadata-changed', payload);
}

/** Delta: new response submitted. Students only receive it when live stats are visible and they are joined. */
async function notifyResponseAdded(app, course, session, data, { includeStudents = false } = {}) {
  if (!session?._id) return;
  const question = data?.question || null;
  const response = data?.response || null;
  const attempt = Number(data?.attempt || response?.attempt || 1);
  const questionType = normalizeQuestionType(question);
  const includesResponseEntry = [2, 4].includes(questionType);
  const showCorrect = !!question?.sessionOptions?.correct;
  const showResponseList = question?.sessionOptions?.responseListVisible !== false;

  // Instructors always receive response stats so distribution bars update in
  // real-time regardless of whether live stats are shown to students.
  const anonymousSession = isAnonymousSession(session);
  const instructorStats = anonymousSession
    ? (data.anonymousStatsPublished ? getAnonymousLiveResponseStats(question, attempt) : null)
    : await buildResponseAddedStatsDelta(question, attempt, data?.responseCount, { force: true });
  // Students only receive stats when the instructor has enabled live stats.
  const rawStudentStats = includeStudents
    ? (anonymousSession ? instructorStats : await buildResponseAddedStatsDelta(question, attempt, data?.responseCount))
    : null;
  const studentStats = rawStudentStats
    ? formatStudentLiveResponseStats(rawStudentStats, { showCorrect, showResponseList, anonymous: anonymousSession })
    : null;

  let instructorResponse = null;
  if (response && includesResponseEntry && !anonymousSession) {
    let studentName = null;
    const studentId = isAnonymousSession(session) ? '' : getResponseStudentId(response);
    if (studentId) {
      const student = await User.findById(studentId)
        .select('_id profile emails email')
        .lean();
      studentName = formatUserDisplayName(student);
    }
    instructorResponse = serializeLiveResponseEntry(response, { studentName });
  }

  const studentResponse = response && includesResponseEntry && showResponseList && !anonymousSession
    ? serializeLiveResponseEntry(response)
    : null;

  const payload = {
    courseId: String(course._id),
    sessionId: String(session._id),
    questionId: String(data?.questionId || question?._id || response?.questionId || ''),
    attempt,
    responseCount: Number(data?.responseCount || 0),
    joinedCount: Number(data?.joinedCount || 0),
    ...(anonymousSession ? { anonymous: true } : { responseSubmittedAt: response?.submittedAt || response?.createdAt || null }),
  };
  sendToInstructors(app, course, 'session:response-added', {
    ...payload,
    audience: includeStudents ? {
      ...payload,
      ...(studentStats ? { responseStats: studentStats } : {}),
      ...(studentResponse ? { response: studentResponse } : {}),
    } : null,
    ...(instructorStats ? { responseStats: instructorStats } : {}),
    ...(instructorResponse ? { response: instructorResponse } : {}),
  });
  if (includeStudents) {
    await sendToJoinedStudents(app, course, session, 'session:response-added', {
      ...payload,
      ...(studentStats ? { responseStats: studentStats } : {}),
      ...(studentResponse ? { response: studentResponse } : {}),
    });
  }
}

function buildInstructorQuestionSnapshot(
  question,
  responses = [],
  studentNameById = {},
  extra = {},
  { includeStudentNames = true, anonymous = false } = {}
) {
  const currentAttempt = isQuestionResponseCollectionEnabled(question)
    ? getCurrentAttempt(question)
    : null;
  const cachedStats = currentAttempt
    ? getAttemptStatsEntry(question, currentAttempt.number)
    : null;
  const rawResponseStats = anonymous ? getAnonymousLiveResponseStats(question, currentAttempt?.number || 1) : cachedStats
    && isCanonicalAttemptStatsEntry(question, cachedStats, responses.length)
    ? materializeAttemptStatsEntry(cachedStats)
    : buildResponseStats(question, responses, currentAttempt?.number || 1);
  const responseStats = formatInstructorLiveResponseStats(rawResponseStats, studentNameById, includeStudentNames, anonymous);
  const questionPayload = toPlainObject(question);
  if (questionPayload?.sessionOptions) {
    questionPayload.sessionOptions = { ...questionPayload.sessionOptions };
    delete questionPayload.sessionOptions.attemptStats;
    delete questionPayload.sessionOptions.wordCloudData;
    delete questionPayload.sessionOptions.histogramData;
  }

  return {
    questionId: String(question?._id || ''),
    question: questionPayload,
    currentAttempt,
    responseStats,
    responseCount: responses.length,
    allResponses: anonymous ? [] : responses.map((response) => serializeLiveResponseEntry(response, {
      studentName: includeStudentNames ? (studentNameById[getResponseStudentId(response)] || null) : null,
    })),
    wordCloudData: question?.sessionOptions?.wordCloudData || null,
    histogramData: question?.sessionOptions?.histogramData || null,
    ...extra,
  };
}

/** Role-safe snapshot: professor navigated to a different question. */
async function notifyQuestionChanged(app, course, session, question, data) {
  if (!session?._id || !question?._id) return;
  const currentAttempt = isQuestionResponseCollectionEnabled(question)
    ? getCurrentAttempt(question)
    : null;
  const [responses, progress] = await Promise.all([
    currentAttempt
      ? Response.find({
        questionId: String(question._id),
        attempt: currentAttempt.number,
      }).sort({ updatedAt: -1, createdAt: -1, _id: -1 }).lean()
      : [],
    loadSessionProgress(session.questions || [], question._id),
  ]);
  const anonymousSession = isAnonymousSession(session);
  const responderIds = anonymousSession
    ? []
    : [...new Set(responses.map(getResponseStudentId).filter(Boolean))];
  const responderUsers = responderIds.length > 0
    ? await User.find({ _id: { $in: responderIds } }).select('_id profile emails email').lean()
    : [];
  const studentNameById = Object.fromEntries(
    responderUsers.map((user) => [String(user._id), formatUserDisplayName(user)])
  );
  const { pageProgress, questionProgress } = progress;
  const progressPayload = {
    ...data,
    pageProgress,
    questionProgress,
  };
  const basePayload = {
    courseId: String(course._id),
    sessionId: String(session._id),
  };

  // Navigation must carry the same canonical aggregate snapshot as a direct
  // stats-visibility change. A cached attempt entry can be absent or stale
  // when returning to an earlier question, while the responses loaded above
  // are already the authoritative current-attempt set.
  const studentResponseStats = question?.sessionOptions?.stats && currentAttempt
    ? (anonymousSession ? getAnonymousLiveResponseStats(question, currentAttempt.number)
      : buildResponseStats(question, responses, currentAttempt.number))
    : null;
  const studentBasePayload = {
    ...basePayload,
    ...buildStudentLiveQuestionSnapshot(question, progressPayload, {
      responseStats: studentResponseStats,
      anonymous: anonymousSession,
    }),
  };
  sendToInstructors(app, course, 'session:question-changed', {
    ...basePayload,
    audience: studentBasePayload,
    ...buildInstructorQuestionSnapshot(question, responses, studentNameById, progressPayload, {
      includeStudentNames: !anonymousSession,
      anonymous: anonymousSession,
    }),
  });

  const responseByStudentId = new Map();
  responses.forEach((response) => {
    const studentId = getResponseStudentId(response);
    if (studentId && !responseByStudentId.has(studentId)) {
      responseByStudentId.set(studentId, response);
    }
  });

  // Ids here are participant ids: user ids, or pseudonyms in anonymous sessions.
  const grantIds = session.activityAccessEnabled ? await getActivityRecipientUserIds(session, course) : [];
  const eligibleIds = [...(course?.students || []), ...grantIds];
  const eligibleIdSet = new Set(eligibleIds.map(String));
  const participantUserIds = buildParticipantUserIdMap(session, eligibleIds);
  const toUserId = (participantId) => (
    participantUserIds ? (participantUserIds.get(participantId) || '') : participantId
  );
  const joinedStudentIds = [...new Set((session.joined || []).map((id) => String(id)).filter(Boolean))]
    .filter((id) => !session.activityEverShared || isAnonymousSession(session) || eligibleIdSet.has(id));
  const joinedStudentIdSet = new Set(joinedStudentIds);
  const studentsWithoutResponse = joinedStudentIds
    .filter((id) => !responseByStudentId.has(id))
    .map(toUserId)
    .filter(Boolean);
  sendToUsersById(app, studentsWithoutResponse, 'session:question-changed', {
    ...studentBasePayload,
    studentResponse: null,
  });
  responseByStudentId.forEach((response, studentId) => {
    if (!joinedStudentIdSet.has(studentId)) return;
    const recipientUserId = toUserId(studentId);
    if (!recipientUserId) return;
    sendToUser(app, recipientUserId, 'session:question-changed', {
      ...studentBasePayload,
      studentResponse: sanitizeStudentOwnResponse(response),
    });
  });
}

/** Role-safe delta: question visibility/stats/correct toggled. */
async function notifyVisibilityChanged(app, course, session, question) {
  if (!session?._id || !question?._id) return;
  const basePayload = {
    courseId: String(course._id),
    sessionId: String(session._id),
  };
  const instructorPayload = {
    ...basePayload,
    questionId: String(question._id),
    hidden: !!question?.sessionOptions?.hidden,
    stats: !!question?.sessionOptions?.stats,
    correct: !!question?.sessionOptions?.correct,
    responseListVisible: question?.sessionOptions?.responseListVisible !== false,
  };

  const currentAttempt = isQuestionResponseCollectionEnabled(question)
    ? getCurrentAttempt(question)
    : null;
  const responseStats = question?.sessionOptions?.stats && currentAttempt
    ? (isAnonymousSession(session) ? getAnonymousLiveResponseStats(question, currentAttempt.number)
      : await getQuestionAttemptStats(question, currentAttempt.number))
    : null;
  const audience = {
    ...basePayload,
    ...buildStudentLiveQuestionSnapshot(question, {}, { responseStats, anonymous: isAnonymousSession(session) }),
  };
  sendToInstructors(app, course, 'session:visibility-changed', { ...instructorPayload, audience });
  await sendToJoinedStudents(app, course, session, 'session:visibility-changed', audience);
}

function notifyVisualizationUpdated(app, course, session, question, event, fieldName, value) {
  if (!session?._id || !question?._id) return;
  const basePayload = {
    courseId: String(course._id),
    sessionId: String(session._id),
    questionId: String(question._id),
  };
  sendToInstructors(app, course, event, { ...basePayload, [fieldName]: value });

  const visibleToStudents = !!question?.sessionOptions?.stats && !!value?.visible;
  void sendToJoinedStudents(app, course, session, event, {
    ...basePayload,
    [fieldName]: visibleToStudents ? value : null,
  });
}

/** Delta: session started or ended. */
function notifyStatusChanged(app, course, sessionId, data) {
  if (!sessionId) return;
  sendToActivityRecipients(app, sessionId, 'session:status-changed', {
    courseId: String(course._id), sessionId: String(sessionId), ...data,
  });
  sendToCourseMembers(app, course, 'session:status-changed', {
    courseId: String(course._id),
    sessionId: String(sessionId),
    ...data,
  });
}

function getCurrentAttempt(question) {
  const attempts = Array.isArray(question?.sessionOptions?.attempts)
    ? question.sessionOptions.attempts
    : [];
  if (attempts.length > 0) {
    const latestAttempt = attempts[attempts.length - 1];
    return {
      number: Number(latestAttempt?.number) || 1,
      closed: !!latestAttempt?.closed,
    };
  }
  return { number: 1, closed: false };
}

/** Delta: current attempt opened/closed/reset on the live question. */
function notifyAttemptChanged(app, course, sessionId, question, data = {}) {
  if (!sessionId || !question?._id) return;
  const payload = {
    courseId: String(course._id),
    sessionId: String(sessionId),
    questionId: String(question._id),
    currentAttempt: getCurrentAttempt(question),
    stats: !!question?.sessionOptions?.stats,
    correct: !!question?.sessionOptions?.correct,
    resetResponses: false,
    ...data,
  };
  sendToCourseMembers(app, course, 'session:attempt-changed', payload);
  sendToActivityRecipients(app, sessionId, 'session:attempt-changed', payload);
}

/** Delta: student submitted a quiz. Target only the submitting user for dashboard/session refresh. */
function notifyQuizSubmitted(app, course, sessionId, userId) {
  if (!sessionId || !userId) return;
  sendToUser(app, userId, 'session:quiz-submitted', {
    courseId: String(course._id),
    sessionId: String(sessionId),
  });
}

/** Delta: a student joined the live session. Instructors only need the roster/count update. */
function notifyParticipantJoined(app, course, sessionId, data) {
  if (!sessionId) return;
  sendToInstructors(app, course, 'session:participant-joined', {
    courseId: String(course._id),
    sessionId: String(sessionId),
    ...data,
  });
}

function buildJoinCodePayload(session, { includeInstructorFields = false } = {}) {
  const payload = {
    joinCodeEnabled: !!session?.joinCodeEnabled,
    joinCodeActive: !!session?.joinCodeActive,
  };
  if (includeInstructorFields) {
    payload.joinCodeInterval = Number(session?.joinCodeInterval || 10);
    payload.currentJoinCode = normalizeAnswerValue(session?.currentJoinCode);
  }
  return payload;
}

/** Delta: join-code requirement/availability changed. */
function notifyJoinCodeChanged(app, course, session) {
  if (!session?._id) return;
  const basePayload = {
    courseId: String(course._id),
    sessionId: String(session._id),
  };
  sendToStudents(app, course, 'session:join-code-changed', {
    ...basePayload,
    ...buildJoinCodePayload(session),
  });
  if (session.activityAccessEnabled) {
    void getActivityRecipientUserIds(session, course).then((recipients) => {
      sendToUsersById(app, recipients, 'session:join-code-changed', {
        ...basePayload, ...buildJoinCodePayload(session),
      });
    }).catch((error) => app.log?.warn?.({ err: error }, 'Failed to broadcast activity join code'));
  }
  sendToInstructors(app, course, 'session:join-code-changed', {
    ...basePayload,
    ...buildJoinCodePayload(session, { includeInstructorFields: true }),
  });
}

function notifyChatSettingsChanged(app, course, session) {
  if (!session?._id) return;
  sendToInstructors(app, course, 'session:chat-settings-changed', {
    courseId: String(course._id),
    sessionId: String(session._id),
    chatEnabled: !!session?.chatEnabled,
    richTextChatEnabled: isRichTextChatEnabled(session),
  });
  sendToJoinedStudents(app, course, session, 'session:chat-settings-changed', {
    courseId: String(course._id),
    sessionId: String(session._id),
    chatEnabled: !!session?.chatEnabled,
    richTextChatEnabled: isRichTextChatEnabled(session),
  });
}

async function notifyChatUpdated(app, course, session, payload = {}) {
  if (!session?._id) return;
  const post = payload?.post || null;
  let currentQuestionNumber = payload?.currentQuestionNumber ?? null;
  if (post?.isQuickPost && currentQuestionNumber == null) {
    currentQuestionNumber = (await loadSessionChatQuestionMetadata(session)).currentQuestionNumber;
  }

  const instructorsSeeNames = !isAnonymousSession(session);
  const authorMetadataMap = post
    ? await buildChatAuthorMetadataMap([post], { includeAllAuthors: instructorsSeeNames })
    : new Map();
  const basePayload = {
    courseId: String(course._id),
    sessionId: String(session._id),
    ...payload,
  };

  if (post) {
    basePayload.postId = String(post._id || payload?.postId || '');
  }
  if (currentQuestionNumber !== undefined) {
    basePayload.currentQuestionNumber = currentQuestionNumber;
  }
  delete basePayload.post;

  sendToInstructors(app, course, 'session:chat-updated', {
    ...basePayload,
    ...buildChatEventDelta(post, {
      includeNames: instructorsSeeNames,
      includeDismissed: true,
      currentQuestionNumber,
      authorMetadataMap,
      allowRoleBasedExposure: true,
    }),
  });
  sendToJoinedStudents(app, course, session, 'session:chat-updated', {
    ...basePayload,
    ...buildChatEventDelta(post, {
      includeNames: false,
      includeDismissed: false,
      currentQuestionNumber,
      authorMetadataMap,
      allowRoleBasedExposure: true,
    }),
  });
}

// Voting on the same post can generate a large burst during a live session. Send
// the first change immediately, then collapse the rest of that short burst into
// one trailing update containing the latest persisted post state.
const chatUpdateBroadcastWindows = new WeakMap();

async function notifyChatUpdatedCoalesced(app, course, session, payload = {}) {
  if (!session?._id || !payload?.postId || !payload?.changeType) {
    return notifyChatUpdated(app, course, session, payload);
  }

  let appWindows = chatUpdateBroadcastWindows.get(app);
  if (!appWindows) {
    appWindows = new Map();
    chatUpdateBroadcastWindows.set(app, appWindows);
  }

  const key = `${session._id}:${payload.changeType}:${payload.postId}`;
  const activeWindow = appWindows.get(key);
  if (activeWindow) {
    activeWindow.latest = { course, session, payload };
    return;
  }

  const window = { latest: null, timer: null };
  window.timer = setTimeout(async () => {
    appWindows.delete(key);
    if (!window.latest) return;
    try {
      await notifyChatUpdated(
        app,
        window.latest.course,
        window.latest.session,
        window.latest.payload
      );
    } catch (error) {
      app.log?.warn?.({ err: error, sessionId: String(session._id) }, 'Failed to broadcast coalesced session chat update');
    }
  }, 125);
  window.timer.unref?.();
  appWindows.set(key, window);

  return notifyChatUpdated(app, course, session, payload);
}

async function seedSessionGradesIfNeeded(session, course, { visibleToStudents = null } = {}) {
  if (!session || session.status !== 'done') return null;
  const gradingResult = await recalculateSessionGrades({
    sessionId: session._id,
    sessionDoc: session,
    courseDoc: course,
    // Refresh automatic marks after restarts/extensions while retaining confirmed scores.
    preserveManualMarks: true,
    visibleToStudents: visibleToStudents ?? !!(session.reviewable || session.gradesVisible),
  });
  return gradingResult.summary;
}

export default async function sessionRoutes(app) {
  const { authenticate } = app;

  // POST /courses/:courseId/sessions - Create a session in a course
  app.post(
    '/courses/:courseId/sessions',
    {
      preHandler: authenticate,
      schema: createSessionSchema,
    },
    async (request, reply) => {
      const course = await Course.findById(request.params.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      const isInstructor = isInstructorOrAdmin(course, request.user);
      const isStudentOwner = (course.students || []).includes(request.user.userId);
      const isStudentPracticeCreation = !isInstructor && isStudentOwner;
      if (!isInstructor && !isStudentPracticeCreation) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const {
        name,
        description,
        quiz,
        practiceQuiz,
        allowSkippingZeroPointQuestions,
        quizStart,
        quizEnd,
        date,
        msScoringMethod,
        tags,
        anonymous,
      } = request.body;
      const isPracticeQuiz = !!practiceQuiz;
      const isQuiz = isPracticeQuiz ? true : !!quiz;
      const isAnonymous = !!anonymous;
      if (isAnonymous && (isPracticeQuiz || isStudentPracticeCreation)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Practice sessions cannot be anonymous' });
      }
      const allowedTagValues = getAllowedCourseTagValues(course);
      if (isStudentPracticeCreation && !isPracticeQuiz) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Students can only create practice sessions' });
      }
      if (isStudentPracticeCreation && !course.allowStudentQuestions) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Student practice is disabled for this course' });
      }
      if (hasDisallowedTags(tags || [], allowedTagValues)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Sessions can only use the course topics' });
      }
      const quizWindowValidationError = getQuizWindowValidationMessage(null, {
        quiz: isQuiz,
        practiceQuiz: isPracticeQuiz,
        quizStart,
        quizEnd,
      });
      if (quizWindowValidationError) {
        return reply.code(400).send({ error: 'Bad Request', message: quizWindowValidationError });
      }

      const session = await Session.create({
        name,
        description: description || '',
        courseId: course._id,
        creator: request.user.userId,
        studentCreated: isStudentPracticeCreation,
        status: isStudentPracticeCreation ? 'running' : 'hidden',
        quiz: isQuiz,
        practiceQuiz: isPracticeQuiz,
        allowSkippingZeroPointQuestions: isInstructor && !!allowSkippingZeroPointQuestions,
        anonymous: isAnonymous,
        quizStart: quizStart ? new Date(quizStart) : undefined,
        quizEnd: quizEnd ? new Date(quizEnd) : undefined,
        date: date ? new Date(date) : undefined,
        msScoringMethod: msScoringMethod || undefined,
        tags: normalizeTags(tags || []),
        hasResponses: false,
        questionResponseCounts: {},
        richTextChatEnabled: true,
      });

      await Course.findByIdAndUpdate(course._id, {
        $addToSet: { sessions: session._id },
      });

      return reply.code(201).send({ session: session.toObject() });
    }
  );

  // GET /sessions/live - List running sessions across all courses for the current user
  app.get(
    '/sessions/live',
    {
      preHandler: authenticate,
      schema: liveSessionsQuerySchema,
      rateLimit: { max: 120, timeWindow: '1 minute' },
    },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');
      const resolvedView = request.query.view || (roles.includes('professor') || isAdmin ? 'instructor' : 'student');
      const isInstructorView = resolvedView !== 'student';
      const isAllView = resolvedView === 'all';

      if (isAllView && !isAdmin) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      if (resolvedView === 'instructor' && !isAdmin && !roles.includes('professor')) {
        const { hasInstructorCourses } = await getUserAccessFlags({
          _id: userId,
          profile: { roles },
        }, { forceInstructorLookup: true });
        if (!hasInstructorCourses) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
        }
      }

      const courseFilter = {};
      if (resolvedView === 'instructor') {
        if (isAdmin) {
          courseFilter.$or = [
            { instructors: userId },
            { owner: userId },
          ];
        } else {
          courseFilter.instructors = userId;
        }
      } else if (resolvedView === 'student') {
        courseFilter.students = userId;
        courseFilter.inactive = { $ne: true };
      }

      const courses = await Course.find(courseFilter)
        .select('_id deptCode courseNumber name')
        .lean();
      if (courses.length === 0) return { liveSessions: [] };

      const courseIds = courses.map((c) => String(c._id));
      const courseById = new Map(courses.map((c) => [String(c._id), c]));

      const statusConditions = [
        { status: 'running' },
        {
          status: 'done',
          quizExtensions: { $elemMatch: { userId, quizStart: { $lte: new Date() }, quizEnd: { $gte: new Date() } } },
          $or: [{ quiz: true }, { practiceQuiz: true }],
        },
        {
          status: 'visible',
          $or: [
            { quiz: true },
            { practiceQuiz: true },
          ],
        },
      ];

      const sessionFilter = {
        courseId: { $in: courseIds },
        $and: [
          { $or: statusConditions },
        ],
      };

      if (isAllView) {
        // Admin view sees all running sessions across all accessible courses.
      } else if (isInstructorView) {
        // Instructors never see student-created sessions
        sessionFilter.studentCreated = { $ne: true };
      } else {
        // Students see non-student-created sessions + their own student-created sessions
        sessionFilter.$and.push({
          $or: [
            { studentCreated: { $ne: true } },
            { creator: userId },
          ],
        });
      }

      const sessions = await Session.find(sessionFilter)
        .select('_id name courseId status quiz practiceQuiz anonymous quizStart quizEnd quizExtensions submittedQuiz joined studentCreated creator questions')
        .lean();

      const normalizedSessions = sessions
        .map((session) => buildSessionForUser(session, request.user, {
          instructorView: isInstructorView,
        }));

      if (!isInstructorView) {
        const runningQuizSessions = normalizedSessions.filter((session) => (
          isQuizLikeSession(session) && session.status === 'running'
        ));

        if (runningQuizSessions.length > 0) {
          const answerableQuestionIdsBySessionId = await loadAnswerableQuestionIdsBySession(runningQuizSessions);
          const questionToSessionId = new Map();
          runningQuizSessions.forEach((session) => {
            const answerableQuestionIds = answerableQuestionIdsBySessionId.get(String(session._id)) || [];
            session.quizResponseCountByCurrentUser = 0;
            session.quizHasResponsesByCurrentUser = false;
            session.quizAllQuestionsAnsweredByCurrentUser = answerableQuestionIds.length === 0;
            answerableQuestionIds.forEach((questionId) => {
              questionToSessionId.set(String(questionId), String(session._id));
            });
          });

          if (questionToSessionId.size > 0) {
            const responses = await Response.find({
              studentUserId: { $in: getStudentResponseOwnerIds(runningQuizSessions, userId) },
              questionId: { $in: [...questionToSessionId.keys()] },
            })
              .select('questionId')
              .lean();

            const answeredBySessionId = {};
            responses.forEach((response) => {
              const questionId = String(response?.questionId || '');
              const sessionId = questionToSessionId.get(questionId);
              if (!sessionId) return;
              if (!answeredBySessionId[sessionId]) {
                answeredBySessionId[sessionId] = new Set();
              }
              answeredBySessionId[sessionId].add(questionId);
            });

            runningQuizSessions.forEach((session) => {
              const answeredSet = answeredBySessionId[String(session._id)] || new Set();
              const answerableQuestionIds = answerableQuestionIdsBySessionId.get(String(session._id)) || [];
              session.quizResponseCountByCurrentUser = answeredSet.size;
              session.quizHasResponsesByCurrentUser = answeredSet.size > 0;
              session.quizAllQuestionsAnsweredByCurrentUser = answerableQuestionIds.length === 0
                || answeredSet.size >= answerableQuestionIds.length;
            });
          }
        }
      }

      const liveSessions = normalizedSessions
        .filter((session) => session.status === 'running')
        .filter((session) => (
          isAllView
            || isInstructorView
            || (
              !session.studentCreated
              && (
                !isQuizLikeSession(session)
                || session.practiceQuiz
                || !session.quizSubmittedByCurrentUser
              )
            )
        ))
        .map((s) => {
        const c = courseById.get(String(s.courseId));
        return {
          _id: s._id,
          name: s.name,
          courseId: s.courseId,
          courseName: c ? [c.deptCode, c.courseNumber, c.name].filter(Boolean).join(' – ') : '',
          status: s.status,
          quiz: !!s.quiz,
          practiceQuiz: !!s.practiceQuiz,
          quizSubmittedByCurrentUser: !!s.quizSubmittedByCurrentUser,
          quizHasResponsesByCurrentUser: !!s.quizHasResponsesByCurrentUser,
          quizAllQuestionsAnsweredByCurrentUser: !!s.quizAllQuestionsAnsweredByCurrentUser,
        };
        });

      return { liveSessions };
    }
  );

  function buildIfNullChain(expressions) {
    return expressions.reduceRight((fallback, expression) => (
      fallback === null ? expression : { $ifNull: [expression, fallback] }
    ), null);
  }

  function buildSessionSortBucketExpression() {
    return {
      $switch: {
        branches: [
          { case: { $eq: ['$status', 'running'] }, then: 0 },
          { case: { $eq: ['$status', 'hidden'] }, then: 1 },
          { case: { $eq: ['$status', 'visible'] }, then: 2 },
          { case: { $eq: ['$status', 'done'] }, then: 3 },
        ],
        default: 4,
      },
    };
  }

  function buildSessionSortTimeExpression() {
    const isQuizExpression = {
      $or: [
        { $eq: ['$quiz', true] },
        { $eq: ['$practiceQuiz', true] },
      ],
    };

    return {
      $switch: {
        branches: [
          {
            case: {
              $and: [
                isQuizExpression,
                { $eq: ['$status', 'visible'] },
              ],
            },
            then: buildIfNullChain(['$quizStart', '$date', '$createdAt', '$quizEnd']),
          },
          {
            case: {
              $and: [
                isQuizExpression,
                { $eq: ['$status', 'done'] },
              ],
            },
            then: buildIfNullChain(['$quizEnd', '$date', '$quizStart', '$createdAt']),
          },
          {
            case: isQuizExpression,
            then: buildIfNullChain(['$quizStart', '$date', '$createdAt', '$quizEnd']),
          },
        ],
        default: buildIfNullChain(['$date', '$createdAt', '$quizStart', '$quizEnd']),
      },
    };
  }

  async function listCourseSessions(filter, { page, limit, usePagination }) {
    const pipeline = [
      { $match: filter },
      {
        $addFields: {
          __sortBucket: buildSessionSortBucketExpression(),
          __sortTime: buildSessionSortTimeExpression(),
        },
      },
      { $sort: { __sortBucket: 1, __sortTime: -1, _id: 1 } },
    ];

    if (usePagination) {
      pipeline.push(
        { $skip: (page - 1) * limit },
        { $limit: limit },
      );
    }

    pipeline.push({
      $project: {
        __sortBucket: 0,
        __sortTime: 0,
      },
    });

    return Session.aggregate(pipeline);
  }

  // GET /courses/:courseId/sessions - List sessions for a course
  const listSessionsSchema = {
    querystring: {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  };

  app.get(
    '/courses/:courseId/sessions',
    {
      preHandler: authenticate,
      schema: listSessionsSchema,
      rateLimit: { max: 60, timeWindow: '1 minute' },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const course = await Course.findById(request.params.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isCourseMember(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      const isInstrOrAdmin = isInstructorOrAdmin(course, request.user);

      const usePagination = request.query.page !== undefined || request.query.limit !== undefined;
      const page = Math.max(Number(request.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100);

      const filter = { courseId: course._id };
      if (isInstrOrAdmin) {
        filter.studentCreated = { $ne: true };
      } else {
        filter.$or = [
          { status: { $ne: 'hidden' }, studentCreated: { $ne: true } },
          { studentCreated: true, creator: request.user.userId },
        ];
      }

      let total;
      let sessionTypeCounts;
      let sessions;
      if (usePagination) {
        [sessionTypeCounts, sessions] = await Promise.all([
          getSessionTypeCounts(filter),
          listCourseSessions(filter, { page, limit, usePagination: true }),
        ]);
        total = sessionTypeCounts.total;
      } else {
        [sessionTypeCounts, sessions] = await Promise.all([
          getSessionTypeCounts(filter),
          listCourseSessions(filter, { page, limit, usePagination: false }),
        ]);
        total = sessionTypeCounts.total;
      }
      const normalizedSessions = [];

      for (const rawSession of sessions) {
        const { session: normalizedSession, changed } = await maybeAutoCloseScheduledQuiz(rawSession, { course });
        if (changed) {
          notifyStatusChanged(app, course, normalizedSession?._id || rawSession?._id, { status: 'done' });
        }
        normalizedSessions.push(normalizedSession);
      }
      const trackedSessions = await hydrateSessionResponseTracking(normalizedSessions);

      const feedbackBySessionId = {};
      const quizProgressBySessionId = {};
      let answerableQuestionIdsBySessionId = new Map();
      if (!isInstrOrAdmin && trackedSessions.length > 0) {
        const sessionIds = trackedSessions
          .filter((session) => !getStudentSessionReviewRestriction(session, request.user))
          .map((session) => String(session?._id || ''))
          .filter(Boolean);

        const feedbackGrades = await Grade.find({
          sessionId: { $in: sessionIds },
          courseId: String(course._id),
          userId: request.user.userId,
          visibleToStudents: true,
        })
          .select('sessionId feedbackSeenAt marks.questionId marks.feedback marks.feedbackUpdatedAt')
          .lean();

        const feedbackGradesBySessionId = {};
        feedbackGrades.forEach((grade) => {
          const sessionId = String(grade?.sessionId || '');
          if (!sessionId) return;
          if (!feedbackGradesBySessionId[sessionId]) {
            feedbackGradesBySessionId[sessionId] = [];
          }
          feedbackGradesBySessionId[sessionId].push(grade);
        });

        Object.entries(feedbackGradesBySessionId).forEach(([sessionId, grades]) => {
          feedbackBySessionId[sessionId] = summarizeFeedbackFromGrades(grades);
        });

        const quizSessions = trackedSessions.filter((session) => isQuizLikeSession(session));
        answerableQuestionIdsBySessionId = await loadAnswerableQuestionIdsBySession(quizSessions);
        const questionToSessionId = new Map();
        quizSessions.forEach((session) => {
          const sessionId = String(session?._id || '');
          const questionIds = answerableQuestionIdsBySessionId.get(sessionId) || [];
          questionIds.forEach((questionId) => {
            if (!questionToSessionId.has(questionId)) {
              questionToSessionId.set(questionId, sessionId);
            }
          });
          quizProgressBySessionId[sessionId] = {
            questionCount: questionIds.length,
            answeredQuestionCount: 0,
            hasResponses: false,
            allQuestionsAnswered: questionIds.length === 0,
          };
        });

        const questionIds = [...questionToSessionId.keys()];
        if (questionIds.length > 0) {
          const responses = await Response.find({
            studentUserId: { $in: getStudentResponseOwnerIds(quizSessions, request.user.userId) },
            questionId: { $in: questionIds },
          })
            .select('questionId')
            .lean();

          const answeredBySessionId = {};
          responses.forEach((response) => {
            const questionId = String(response?.questionId || '');
            const sessionId = questionToSessionId.get(questionId);
            if (!sessionId) return;
            if (!answeredBySessionId[sessionId]) {
              answeredBySessionId[sessionId] = new Set();
            }
            answeredBySessionId[sessionId].add(questionId);
          });

          Object.entries(answeredBySessionId).forEach(([sessionId, questionIdSet]) => {
            const progress = quizProgressBySessionId[sessionId] || {
              questionCount: 0,
              answeredQuestionCount: 0,
              hasResponses: false,
              allQuestionsAnswered: true,
            };
            progress.answeredQuestionCount = questionIdSet.size;
            progress.hasResponses = questionIdSet.size > 0;
            progress.allQuestionsAnswered = progress.questionCount > 0
              && questionIdSet.size >= progress.questionCount;
            quizProgressBySessionId[sessionId] = progress;
          });
        }
      }

      const hydratedSessions = trackedSessions.map((session) => {
        const sessionForUser = buildSessionForUser(session, request.user, {
          instructorView: isInstrOrAdmin,
        });

        if (!isInstrOrAdmin) {
          const sessionId = String(sessionForUser?._id || '');
          const feedbackSummary = feedbackBySessionId[String(sessionForUser?._id || '')] || getDefaultFeedbackSummary();
          sessionForUser.feedback = feedbackSummary;
          sessionForUser.hasNewFeedback = feedbackSummary.hasNewFeedback;
          sessionForUser.newFeedbackQuestionIds = feedbackSummary.newFeedbackQuestionIds;

          if (isQuizLikeSession(sessionForUser)) {
            const progress = quizProgressBySessionId[sessionId] || {
              questionCount: answerableQuestionIdsBySessionId.get(sessionId)?.length || 0,
              answeredQuestionCount: 0,
              hasResponses: false,
              allQuestionsAnswered: (answerableQuestionIdsBySessionId.get(sessionId)?.length || 0) === 0,
            };
            sessionForUser.quizResponseCountByCurrentUser = progress.answeredQuestionCount;
            sessionForUser.quizHasResponsesByCurrentUser = progress.hasResponses;
            sessionForUser.quizAllQuestionsAnsweredByCurrentUser = progress.allQuestionsAnswered;
          }
        }

        return sessionForUser;
      });

      const result = { sessions: hydratedSessions, total, sessionTypeCounts };
      if (usePagination) {
        result.page = page;
        result.pages = Math.ceil(total / limit);
      }
      return result;
    }
  );

  // Editing protections depend on stored answers, not review visibility or
  // final quiz submission. Return only question IDs, including for anonymous
  // activities below the results-release threshold.
  app.get(
    '/sessions/:id/response-locks',
    {
      preHandler: authenticate,
      schema: {
        description: 'Instructor-only question edit locks, including autosaved and withheld anonymous responses.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            required: ['responseBackedQuestionIds'],
            properties: {
              responseBackedQuestionIds: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
      },
    },
    async (request, reply) => {
      const session = await Session.findById(request.params.id).select('courseId questions').lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      const course = await Course.findById(session.courseId).select('instructors').lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }
      const questionIds = normalizeQuestionIds(session.questions);
      const responseBackedQuestionIds = questionIds.length > 0
        ? await Response.distinct('questionId', { questionId: { $in: questionIds } })
        : [];
      return { responseBackedQuestionIds };
    }
  );

  // GET /sessions/:id - Get a single session
  app.get(
    '/sessions/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const session = await Session.findById(request.params.id).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(session.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      const isInstrOrAdmin = isInstructorOrAdmin(course, request.user);
      if (!isInstrOrAdmin && session.studentCreated && !isStudentOwnedSession(session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session is not available' });
      }
      let { session: normalizedSession, changed } = await maybeAutoCloseScheduledQuiz(session, { course });
      normalizedSession = await hydrateSingleSessionResponseTracking(normalizedSession);
      if (isInstrOrAdmin) {
        const msNormalization = await ensureSessionMsScoringMethod(normalizedSession);
        normalizedSession = msNormalization.session || normalizedSession;
      }
      if (changed) {
        notifyStatusChanged(app, course, normalizedSession?._id || session._id, { status: 'done' });
      }

      // For students, hide certain fields if session is hidden.
      if (!isInstrOrAdmin && normalizedSession.status === 'hidden' && !isStudentOwnedSession(normalizedSession, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session is not available' });
      }

      return {
        session: buildSessionForUser(normalizedSession, request.user, {
          instructorView: isInstrOrAdmin,
          outsideActivity: !isCourseMember(course, request.user),
        }),
      };
    }
  );

  // PATCH /sessions/:id - Update a session
  app.patch(
    '/sessions/:id',
    {
      preHandler: authenticate,
      schema: updateSessionSchema,
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

      const isInstructor = isInstructorOrAdmin(course, request.user);
      const isStudentOwner = isStudentOwnedSession(session, request.user);
      if (!isInstructor && !isStudentOwner) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }
      if (isStudentOwner && session.practiceQuiz && !course.allowStudentQuestions) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Student practice is disabled for this course' });
      }

      const allowed = isStudentOwner
        ? ['name', 'description']
        : ['name', 'description', 'quiz', 'practiceQuiz', 'allowSkippingZeroPointQuestions', 'anonymous', 'quizStart', 'quizEnd', 'reviewable', 'status', 'date', 'joinCodeEnabled', 'chatEnabled', 'richTextChatEnabled', 'joinCodeInterval', 'msScoringMethod', 'tags'];
      const updates = {};
      for (const key of allowed) {
        if (request.body[key] !== undefined) {
          updates[key] = request.body[key];
        }
      }
      if (updates.tags !== undefined) {
        const allowedTagValues = getAllowedCourseTagValues(course);
        if (hasDisallowedTags(updates.tags, allowedTagValues)) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Sessions can only use the course topics' });
        }
        updates.tags = normalizeTags(updates.tags);
      }

      // Practice quizzes are a subset of quizzes.
      if (updates.practiceQuiz === true) {
        updates.quiz = true;
      }
      if (updates.quiz === false) {
        updates.practiceQuiz = false;
      }

      const nextAnonymous = updates.anonymous !== undefined ? !!updates.anonymous : !!session.anonymous;
      const nextPracticeQuiz = updates.practiceQuiz !== undefined ? !!updates.practiceQuiz : !!session.practiceQuiz;
      if (nextAnonymous && nextPracticeQuiz) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Practice sessions cannot be anonymous' });
      }
      const changingAnonymity = updates.anonymous !== undefined && !!updates.anonymous !== !!session.anonymous;
      const changingAnonymousMode = !!session.anonymous && (
        (updates.quiz !== undefined && !!updates.quiz !== !!session.quiz)
        || (updates.practiceQuiz !== undefined && !!updates.practiceQuiz !== !!session.practiceQuiz)
      );
      if (nextAnonymous && (session.quizExtensions || []).length > 0) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Remove quiz extensions before enabling anonymity' });
      }
      if ((changingAnonymity || changingAnonymousMode) && await sessionHasParticipationData(session)) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Anonymity and session mode cannot change after participation has started',
        });
      }

      const quizWindowValidationError = getQuizWindowValidationMessage(session, updates);
      if (quizWindowValidationError) {
        return reply.code(400).send({ error: 'Bad Request', message: quizWindowValidationError });
      }

      // If passcode requirement is disabled through the generic session patch,
      // also close any active join period for consistent behavior.
      if (updates.joinCodeEnabled === false) {
        updates.joinCodeActive = false;
        updates.currentJoinCode = '';
        updates.joinCodeExpiresAt = null;
      }

      // Reviewable can only be set to true when session is ended
      // Allow if session is already done or if status is being set to done in this request
      if (!isStudentOwner && updates.reviewable === true && (updates.status ?? session.status) !== 'done') {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Session must be in ended state to be made reviewable',
        });
      }

      if (!isStudentOwner && updates.reviewable === true) {
        const previewSession = {
          ...session,
          ...updates,
        };
        const runtime = getQuizRuntimeState(previewSession, {
          instructorView: true,
        });
        if (isQuizLikeSession(previewSession) && runtime.quizHasRemainingExtensions) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Session cannot be made reviewable while quiz extensions are active',
          });
        }
      }

      if (!isStudentOwner && updates.status && updates.status !== 'done') updates.reviewable = false;
      if (!isStudentOwner && updates.reviewable !== undefined) updates.gradesVisible = !!updates.reviewable && !nextAnonymous;
      if (nextAnonymous) updates.gradesVisible = false;

      if (!isStudentOwner && updates.reviewable === true && !session.reviewable && !nextAnonymous) {
        const nonAutoGradeable = await getNonAutoGradeableQuestions(session);
        const ungradedNonAuto = await filterToActuallyUngradedQuestions(nonAutoGradeable, session._id);
        if (ungradedNonAuto.length > 0 && !request.body.acknowledgeNonAutoGradeable) {
          return {
            session,
            grading: null,
            nonAutoGradeableWarning: buildReviewableWarning({ nonAutoGradeable: ungradedNonAuto }),
          };
        }

        if (request.body.zeroNonAutoGradeable) {
          await zeroQuestionPoints(nonAutoGradeable);
        }
      }

      if (updates.status === 'running' && !isQuizLikeSession({ ...session, ...updates })) {
        await initializeActiveQuestion(session, updates);
      }

      const guardedSettingsChange = changingAnonymity || changingAnonymousMode;
      const updateFilter = { _id: request.params.id };
      if (guardedSettingsChange) {
        Object.assign(updateFilter, expectedAnonymityFilter(session), {
          participationStarted: { $ne: true },
          'joined.0': { $exists: false },
          'joinRecords.0': { $exists: false },
          'submittedQuiz.0': { $exists: false },
        });
        if (nextAnonymous) updateFilter['quizExtensions.0'] = { $exists: false };
      }
      if (nextAnonymous && updates.practiceQuiz !== false) {
        updateFilter.practiceQuiz = { $ne: true };
      }
      if (nextPracticeQuiz && updates.anonymous !== false) {
        updateFilter.anonymous = { $ne: true };
      }
      const updated = await Session.findOneAndUpdate(
        updateFilter,
        { $set: updates },
        { returnDocument: 'after' }
      );
      if (!updated) {
        return reply.code(409).send({ error: 'Conflict', message: 'Session settings changed; reload and retry' });
      }

      if (updates.tags !== undefined) {
        await inheritSessionTagsForQuestions(updated.toObject());
      }

      if (changingAnonymity && updated.anonymous) {
        // Only reachable before any participation, so these rows hold no
        // student work; anonymous sessions must not appear in the gradebook.
        await Grade.deleteMany({ sessionId: String(updated._id) });
      }

      let grading = null;
      const removingReviewable = updates.reviewable === false;
      const markingDone = updates.status === 'done' && session.status !== 'done';

      if (!isStudentOwner && (updates.reviewable === true || markingDone)) {
        grading = await seedSessionGradesIfNeeded(updated, course, {
          visibleToStudents: !!(updated.reviewable || updated.gradesVisible),
        });
      } else if (!isStudentOwner && removingReviewable) {
        await setSessionGradesVisibility({
          sessionId: updated._id,
          visibleToStudents: false,
        });
      }

      notifySessionMetadataChanged(app, course, updated?._id || request.params.id);

      // Use the same effective status and extension flags as GET and course
      // lists, including when a PATCH enables a currently active quiz schedule.
      return {
        session: buildSessionForUser(updated.toObject(), request.user, { instructorView: isInstructor }),
        grading,
        nonAutoGradeableWarning: null,
      };
    }
  );

  // DELETE /sessions/:id - Delete a session
  app.delete(
    '/sessions/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const session = await Session.findById(request.params.id).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(session.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      const isInstructor = isInstructorOrAdmin(course, request.user);
      const isStudentOwner = isStudentOwnedSession(session, request.user);
      if (!isInstructor && !isStudentOwner) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      await Course.findByIdAndUpdate(course._id, {
        $pull: { sessions: session._id },
      });

      await Session.findByIdAndDelete(request.params.id);

      return { success: true };
    }
  );

  app.patch(
    '/sessions/:id/practice-questions',
    {
      preHandler: authenticate,
      schema: replacePracticeQuestionsSchema,
      rateLimit: { max: 30, timeWindow: '1 minute' },
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

      if (!isStudentOwnedSession(session, request.user) || !session.practiceQuiz) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }
      if (!course.allowStudentQuestions) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Student practice is disabled for this course' });
      }

      const questionIds = [...new Set((request.body.questionIds || []).map((questionId) => String(questionId)).filter(Boolean))];
      const questions = questionIds.length > 0
        ? await Question.find({ _id: { $in: questionIds } }).lean()
        : [];
      if (questions.length !== questionIds.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'One or more questions were not found' });
      }

      const visibilityResults = await Promise.all(
        questions.map((question) => userCanViewQuestion(question, request.user))
      );
      if (visibilityResults.some((canView) => !canView)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'One or more questions are not available to this student' });
      }

      const sourceQuestionsById = new Map(questions.map((question) => [String(question._id), question]));
      const copiedQuestionIds = [];
      for (const sourceQuestionId of questionIds) {
        const sourceQuestion = sourceQuestionsById.get(String(sourceQuestionId));
        if (!sourceQuestion) continue;
        // eslint-disable-next-line no-await-in-loop
        const copiedQuestion = await copyQuestionToSession({
          sourceQuestion,
          targetSessionId: String(session._id),
          targetCourseId: String(course._id),
          userId: request.user.userId,
          addToSession: false,
        });
        copiedQuestionIds.push(String(copiedQuestion._id));
      }

      const responseTracking = buildSessionResponseTracking(copiedQuestionIds);
      const updated = await Session.findByIdAndUpdate(
        request.params.id,
        {
          $set: {
            questions: copiedQuestionIds,
            currentQuestion: copiedQuestionIds[0] || '',
            hasResponses: responseTracking.hasResponses,
            questionResponseCounts: responseTracking.questionResponseCounts,
          },
        },
        { returnDocument: 'after' }
      ).lean();

      return { session: updated };
    }
  );

  // POST /sessions/:id/start - Start (launch) a session
  app.post(
    '/sessions/:id/start',
    { preHandler: authenticate },
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

      const now = new Date();
      const updates = {
        status: 'running',
        reviewable: false,
        gradesVisible: false,
        date: now,
        // Join period is always explicit; starting a session does not auto-open passcode entry.
        joinCodeActive: false,
        currentJoinCode: '',
        joinCodeExpiresAt: null,
      };
      await initializeActiveQuestion(session, updates);

      const updated = await Session.findByIdAndUpdate(
        request.params.id,
        { $set: updates },
        { returnDocument: 'after' }
      );

      await setSessionGradesVisibility({ sessionId: session._id, visibleToStudents: false });
      notifyStatusChanged(app, course, updated?._id || request.params.id, { status: 'running' });

      return { session: serializeInstructorSession(updated) };
    }
  );

  // POST /sessions/:id/end - End a session
  app.post(
    '/sessions/:id/end',
    { preHandler: authenticate },
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

      const makingReviewable = request.body?.reviewable === true && !session.reviewable;
      let nonAutoGradeableWarning = null;
      if (makingReviewable) {
        if (isQuizLikeSession(session)) {
          const runtime = getQuizRuntimeState(session, {
            instructorView: true,
          });
          if (runtime.quizHasRemainingExtensions) {
            return reply.code(400).send({
              error: 'Bad Request',
              message: 'Session cannot be made reviewable while quiz extensions are active',
            });
          }
        }

        const [nonAutoGradeable, noResponseQuestions] = isAnonymousSession(session)
          // Anonymous sessions are never graded, so grading warnings do not apply.
          ? [[], []]
          : await Promise.all([
            getNonAutoGradeableQuestions(session),
            getNoResponseQuestions(session),
          ]);
        const ungradedNonAuto = await filterToActuallyUngradedQuestions(nonAutoGradeable, session._id);
        const needsReviewableWarning = ungradedNonAuto.length > 0 || noResponseQuestions.length > 0;
        if (needsReviewableWarning && !request.body?.acknowledgeNonAutoGradeable) {
          return {
            session: serializeInstructorSession(session),
            grading: null,
            nonAutoGradeableWarning: buildReviewableWarning({
              nonAutoGradeable: ungradedNonAuto,
              noResponses: noResponseQuestions,
            }),
          };
        }

        if (request.body?.zeroNonAutoGradeable) {
          await zeroQuestionPoints([...nonAutoGradeable, ...noResponseQuestions]);
        }
      }

      const updates = {
        status: 'done',
        date: new Date(),
        joinCodeActive: false,
        currentJoinCode: '',
        joinCodeExpiresAt: null,
      };
      if (request.body?.reviewable !== undefined) {
        updates.reviewable = request.body.reviewable;
        updates.gradesVisible = !!request.body.reviewable && !session.anonymous;
      }

      const updated = await Session.findByIdAndUpdate(
        request.params.id,
        { $set: updates },
        { returnDocument: 'after' }
      );

      let grading = null;
      grading = await seedSessionGradesIfNeeded(updated, course, {
        visibleToStudents: !!(updated.reviewable || updated.gradesVisible),
      });
      if (request.body?.reviewable === false) {
        await setSessionGradesVisibility({
          sessionId: updated._id,
          visibleToStudents: false,
        });
      }

      notifyStatusChanged(app, course, updated?._id || request.params.id, { status: 'done' });

      return { session: serializeInstructorSession(updated), grading, nonAutoGradeableWarning };
    }
  );
  // PATCH /sessions/:id/current - Set current question in a live session
  app.patch(
    '/sessions/:id/current',
    {
      preHandler: authenticate,
      schema: setCurrentQuestionSchema,
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

      const { questionId } = request.body;
      if (!(session.questions || []).includes(questionId)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Question not found in this session' });
      }

      // Carry over visibility state from previous question to the new one
      if (session.currentQuestion && session.currentQuestion !== questionId) {
        const prevQ = await Question.findById(session.currentQuestion).lean();
        const prevHidden = prevQ?.sessionOptions?.hidden ?? true;
        await Question.findByIdAndUpdate(questionId, {
          $set: { 'sessionOptions.hidden': prevHidden },
        });
      }

      const updated = await Session.findByIdAndUpdate(
        request.params.id,
        { $set: { currentQuestion: questionId } },
        { returnDocument: 'after' }
      );

      const qIndex = (session.questions || []).findIndex((id) => String(id) === String(questionId));
      const currentQuestion = await Question.findById(questionId).lean();
      await notifyQuestionChanged(app, course, updated, currentQuestion, {
        questionId: String(questionId),
        questionIndex: qIndex,
        questionNumber: qIndex >= 0 ? qIndex + 1 : null,
        questionCount: (session.questions || []).length,
      });

      return { session: serializeInstructorSession(updated) };
    }
  );
  app.patch(
    '/sessions/:id/reviewable',
    {
      preHandler: authenticate,
      schema: toggleReviewableSchema,
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

      // Reviewable can only be set to true when session is ended
      if (request.body.reviewable === true && session.status !== 'done') {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Session must be in ended state to be made reviewable',
        });
      }

      if (request.body.reviewable === true && isQuizLikeSession(session)) {
        const runtime = getQuizRuntimeState(session, {
          instructorView: true,
        });
        if (runtime.quizHasRemainingExtensions) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Session cannot be made reviewable while quiz extensions are active',
          });
        }
      }

      const updated = await Session.findByIdAndUpdate(
        request.params.id,
        { $set: { reviewable: request.body.reviewable, gradesVisible: !!request.body.reviewable && !session.anonymous } },
        { returnDocument: 'after' }
      );

      let grading = null;
      if (request.body.reviewable === true) {
        grading = await seedSessionGradesIfNeeded(updated, course, {
          visibleToStudents: true,
        });
      } else if (request.body.reviewable === false) {
        await setSessionGradesVisibility({
          sessionId: updated._id,
          visibleToStudents: false,
        });
      }

      notifySessionMetadataChanged(app, course, updated?._id || request.params.id);

      return { session: serializeInstructorSession(updated), grading, nonAutoGradeableWarning: null };
    }
  );

  // PATCH /sessions/:id/extensions - Set quiz extensions
  app.patch(
    '/sessions/:id/extensions',
    {
      preHandler: authenticate,
      schema: setExtensionsSchema,
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

      if (!isQuizLikeSession(session)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Session is not a quiz' });
      }
      if (session.anonymous && request.body.extensions.length > 0) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Anonymous quizzes cannot have individual extensions' });
      }
      if (session.activityEverShared && request.body.extensions.length > 0) {
        return reply.code(409).send({ error: 'Conflict', message: 'Code-accessible quizzes cannot have individual extensions' });
      }

      const baseQuizStart = toDateOrNull(session.quizStart);
      const baseQuizEnd = toDateOrNull(session.quizEnd);

      const normalizedExtensionsByUser = new Map();
      const extensionStudents = new Set((course.students || []).map((studentId) => String(studentId)));

      for (const rawExtension of request.body.extensions || []) {
        const userId = normalizeAnswerValue(rawExtension?.userId);
        if (!userId) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Each extension requires a userId' });
        }
        if (!extensionStudents.has(userId)) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: `User ${userId} is not enrolled as a student in this course`,
          });
        }

        const quizStart = toDateOrNull(rawExtension?.quizStart) || baseQuizStart;
        const quizEnd = toDateOrNull(rawExtension?.quizEnd) || baseQuizEnd;
        if (!quizStart || !quizEnd) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Each extension requires a valid start and end time (or quiz defaults)',
          });
        }
        if (quizEnd.getTime() <= quizStart.getTime()) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Extension end time must be later than extension start time',
          });
        }

        normalizedExtensionsByUser.set(userId, {
          userId,
          quizStart,
          quizEnd,
        });
      }

      const normalizedExtensions = [...normalizedExtensionsByUser.values()].sort(
        (a, b) => a.quizEnd.getTime() - b.quizEnd.getTime()
      );
      const hasRemainingExtensions = normalizedExtensions.some((extension) => extensionHasRemainingWindow(extension, Date.now()));

      const updated = await Session.findOneAndUpdate(
        {
          _id: request.params.id,
          ...(normalizedExtensions.length > 0 ? { anonymous: { $ne: true }, activityEverShared: { $ne: true } } : {}),
        },
        { $set: { quizExtensions: normalizedExtensions, ...(hasRemainingExtensions ? { reviewable: false, gradesVisible: false } : {}) } },
        { returnDocument: 'after' }
      );
      if (!updated) {
        return reply.code(409).send({ error: 'Conflict', message: 'Session settings changed; reload and retry' });
      }

      if (hasRemainingExtensions) {
        await setSessionGradesVisibility({ sessionId: session._id, visibleToStudents: false });
      }

      notifySessionMetadataChanged(app, course, updated?._id || request.params.id);

      return { session: buildSessionForUser(updated.toObject(), request.user, { instructorView: true }) };
    }
  );

  app.post(
    '/courses/:courseId/sessions/copy',
    {
      preHandler: authenticate,
      schema: bulkSessionCopySchema,
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const targetCourse = await Course.findById(request.params.courseId).lean();
      if (!targetCourse) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isInstructorOrAdmin(targetCourse, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const requestedSessionIds = [...new Set((request.body.sessionIds || []).map((sessionId) => String(sessionId)))];
      const sourceSessions = await Session.find({ _id: { $in: requestedSessionIds } });
      const sourceSessionsById = new Map(sourceSessions.map((session) => [String(session._id), session]));
      const copiedSessions = [];

      for (const sessionId of requestedSessionIds) {
        const sourceSession = sourceSessionsById.get(sessionId);
        if (!sourceSession) {
          return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
        }

        const sourceCourse = await Course.findById(sourceSession.courseId).lean();
        if (!sourceCourse) {
          return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
        }

        if (!isInstructorOrAdmin(sourceCourse, request.user)) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
        }

        const copiedSession = await copySessionToCourse({
          sourceSession,
          targetCourseId: targetCourse._id,
          userId: request.user.userId,
          preservePoints: request.body?.preservePoints === true,
        });
        copiedSessions.push(copiedSession);
      }

      return reply.code(201).send({ sessions: copiedSessions });
    }
  );

  // POST /sessions/:id/copy - Copy a session
  app.post(
    '/sessions/:id/copy',
    {
      preHandler: authenticate,
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute' },
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

      const targetCourseId = request.body?.targetCourseId || session.courseId;
      const targetCourse = String(targetCourseId) === String(course._id)
        ? course
        : await Course.findById(targetCourseId).lean();
      if (!targetCourse) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!isInstructorOrAdmin(targetCourse, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const copiedSession = await copySessionToCourse({
        sourceSession: session,
        targetCourseId: targetCourse._id,
        userId: request.user.userId,
        preservePoints: request.body?.preservePoints === true,
      });

      return reply.code(201).send({
        session: copiedSession,
      });
    }
  );

  app.get(
    '/sessions/:id/export',
    {
      preHandler: authenticate,
      rateLimit: { max: 60, timeWindow: '1 minute' },
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
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

      const questionIds = Array.isArray(session.questions) ? session.questions : [];
      const questions = questionIds.length > 0
        ? await Question.find({ _id: { $in: questionIds } }).lean()
        : [];
      const questionsById = new Map(questions.map((question) => [String(question._id), question]));
      const orderedQuestions = questionIds
        .map((questionId) => questionsById.get(String(questionId)))
        .filter(Boolean);

      return sanitizeExportedSession(session, orderedQuestions);
    }
  );

  app.post(
    '/courses/:courseId/sessions/import',
    {
      preHandler: authenticate,
      schema: importSessionSchema,
      rateLimit: { max: 20, timeWindow: '1 minute' },
      config: {
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const course = await Course.findById(request.params.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const sourceSession = request.body.session || {};
      const importedSessionPayload = {
        ...buildImportedSessionPayload(sourceSession, course._id),
        creator: request.user.userId,
        studentCreated: false,
      };
      if (!importedSessionPayload.name) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Imported session requires a name' });
      }

      const importedQuestions = Array.isArray(sourceSession.questions) ? sourceSession.questions : [];
      const allowedTagValues = getAllowedCourseTagValues(course);
      if (hasDisallowedTags(sourceSession.tags || [], allowedTagValues)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Sessions can only use the course topics' });
      }
      const validationError = importedQuestions
        .map((question) => multipleChoiceValidationError(question?.type, question?.options))
        .find(Boolean);
      if (validationError) {
        return reply.code(400).send(validationError);
      }

      const session = await Session.create(importedSessionPayload);
      const importTags = normalizeTags(request.body.importTags || []);

      const importedQuestionPayloads = importedQuestions.map((question) => {
        const payload = sanitizeImportedQuestion(question, {
          courseId: String(course._id),
          sessionId: String(session._id),
          userId: request.user.userId,
          includeSessionOptions: true,
          importTags,
        });
        return { ...payload, tags: mergeNormalizedTags(payload.tags, session.tags) };
      });
      const createdQuestions = importedQuestionPayloads.length > 0
        ? await Question.insertMany(importedQuestionPayloads)
        : [];
      const createdQuestionIds = createdQuestions.map((question) => String(question._id));

      const responseTracking = buildSessionResponseTracking(createdQuestionIds);
      const updatedSession = await Session.findByIdAndUpdate(
        session._id,
        {
          $set: {
            questions: createdQuestionIds,
            hasResponses: responseTracking.hasResponses,
            questionResponseCounts: responseTracking.questionResponseCounts,
          },
        },
        { returnDocument: 'after' }
      );

      await Course.findByIdAndUpdate(course._id, {
        $addToSet: { sessions: session._id },
      });

      return reply.code(201).send({
        session: updatedSession.toObject(),
        questionCount: createdQuestionIds.length,
      });
    }
  );

  // GET /sessions/:id/review - Get session review data for a student
  app.get(
    '/sessions/:id/review',
    { preHandler: authenticate },
    async (request, reply) => {
      const session = await Session.findById(request.params.id).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(session.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      const { session: normalizedSession, changed } = await maybeAutoCloseScheduledQuiz(session, { course });
      if (changed) {
        notifyStatusChanged(app, course, normalizedSession?._id || session._id, { status: 'done' });
      }

      // Students can only review if the session is reviewable and done
      const isInstrOrAdmin = isInstructorOrAdmin(course, request.user);
      if (!isInstrOrAdmin) {
        const restriction = getStudentSessionReviewRestriction(normalizedSession, request.user);
        if (restriction === 'unavailable') {
          return reply.code(403).send({ error: 'Forbidden', message: 'Session is not available' });
        }
        if (restriction === 'not-reviewable') {
          return reply.code(403).send({ error: 'Forbidden', message: 'Session is not reviewable' });
        }
        if (restriction === 'not-finished') {
          return reply.code(403).send({ error: 'Forbidden', message: 'Session is not yet finished' });
        }
      }

      // Fetch questions in session order
      const questionIds = normalizedSession.questions || [];
      const questions = await Question.find({ _id: { $in: questionIds } }).lean();

      // Maintain session question order
      const questionMap = {};
      for (const q of questions) {
        questionMap[String(q._id)] = q;
      }
      const orderedQuestions = questionIds
        .map((id) => questionMap[String(id)])
        .filter(Boolean);
      const normalizedQuestions = orderedQuestions.map(sanitizeStudentReviewQuestion);

      // Fetch this student's responses for these questions
      const responses = await Response.find({
        questionId: { $in: questionIds },
        studentUserId: getSessionParticipantId(normalizedSession, request.user.userId),
      }).lean();

      // Group responses by questionId
      const responsesByQuestion = {};
      for (const r of responses) {
        const questionId = normalizeAnswerValue(r.questionId);
        if (!questionId) continue;
        if (!responsesByQuestion[questionId]) {
          responsesByQuestion[questionId] = [];
        }
        responsesByQuestion[questionId].push(sanitizeStudentReviewResponse(r));
      }

      let feedbackSummary = getDefaultFeedbackSummary();
      let studentGrade = null;
      if (!isInstrOrAdmin && !normalizedSession.anonymous
        && (course.students || []).some((id) => String(id) === String(request.user.userId))) {
        const grade = await Grade.findOne(
          studentVisibleGradeQuery(course._id, normalizedSession._id, request.user)
        ).select('value participation points outOf needsGrading feedbackSeenAt marks').lean();
        feedbackSummary = summarizeFeedbackFromGrades(grade ? [grade] : []);
        studentGrade = sanitizeStudentVisibleGrade(grade);
      }

      return {
        session: sanitizeStudentReviewSession(normalizedSession),
        questions: normalizedQuestions,
        responses: responsesByQuestion,
        grade: studentGrade,
        feedback: feedbackSummary,
      };
    }
  );

  app.post(
    '/sessions/:id/review/feedback/dismiss',
    { preHandler: authenticate },
    async (request, reply) => {
      const sessionDoc = await Session.findById(request.params.id).lean();
      if (!sessionDoc) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(sessionDoc.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isCourseMember(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      const { session: normalizedSession, changed } = await maybeAutoCloseScheduledQuiz(sessionDoc, { course });
      if (changed) {
        notifyStatusChanged(app, course, normalizedSession?._id || sessionDoc._id, { status: 'done' });
      }

      if (isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only students can dismiss feedback notifications' });
      }

      const restriction = getStudentSessionReviewRestriction(normalizedSession, request.user);
      if (restriction === 'unavailable') {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session is not available' });
      }
      if (restriction === 'not-reviewable') {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session is not reviewable' });
      }
      if (restriction === 'not-finished') {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session is not yet finished' });
      }

      const seenAt = new Date();
      const updateResult = await Grade.updateMany(
        studentVisibleGradeQuery(course._id, normalizedSession._id, request.user),
        { $set: { feedbackSeenAt: seenAt } }
      );

      const grades = await Grade.find(
        studentVisibleGradeQuery(course._id, normalizedSession._id, request.user)
      )
        .select('feedbackSeenAt marks.questionId marks.feedback marks.feedbackUpdatedAt')
        .lean();
      const feedbackSummary = summarizeFeedbackFromGrades(grades);

      const modifiedCount = Number(updateResult?.modifiedCount ?? updateResult?.nModified ?? 0);
      if (modifiedCount > 0) {
        sendToUser(app, request.user.userId, 'session:feedback-updated', {
          courseId: String(course._id),
          sessionId: String(normalizedSession._id),
        });
      }

      return {
        success: true,
        feedback: feedbackSummary,
      };
    }
  );

  // GET /sessions/:id/quiz - Get quiz payload for student quiz mode
  app.get(
    '/sessions/:id/quiz',
    { preHandler: authenticate },
    async (request, reply) => {
      const sessionDoc = await Session.findById(request.params.id).lean();
      if (!sessionDoc) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(sessionDoc.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!await hasSessionParticipantAccess(course, sessionDoc, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      if (isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only students can access quiz mode' });
      }

      const { session: normalizedSession, changed } = await maybeAutoCloseScheduledQuiz(sessionDoc, { course });
      if (changed) {
        notifyStatusChanged(app, course, normalizedSession?._id || sessionDoc._id, { status: 'done' });
      }

      if (!isQuizLikeSession(normalizedSession)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Session is not a quiz' });
      }
      if (normalizedSession.studentCreated && !isStudentOwnedSession(normalizedSession, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session is not available' });
      }

      if (normalizedSession.status === 'hidden' && !isStudentOwnedSession(normalizedSession, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session is not available' });
      }

      const runtime = getQuizRuntimeState(normalizedSession, {
        userId: request.user.userId,
        instructorView: false,
      });

      const participantId = getSessionParticipantId(normalizedSession, request.user.userId);
      const anonymousSession = isAnonymousSession(normalizedSession);
      const submittedByCurrentUser = Array.isArray(normalizedSession.submittedQuiz)
        && normalizedSession.submittedQuiz.includes(participantId);
      if (submittedByCurrentUser && !normalizedSession.practiceQuiz) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Quiz already submitted' });
      }

      if (!runtime.isOpenForUser) {
        if (runtime.isUpcomingForUser) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Quiz is not open yet' });
        }
        return reply.code(403).send({ error: 'Forbidden', message: 'Quiz is closed' });
      }

      // Mark the student as participating once they open an active quiz.
      // Anonymous sessions record only the pseudonym, without join records.
      const userId = participantId;
      const now = new Date();
      const joined = Array.isArray(normalizedSession.joined) ? normalizedSession.joined : [];
      if (!joined.includes(userId)) {
        if (!await claimSessionParticipation(normalizedSession)) {
          return reply.code(409).send({ error: 'Conflict', message: 'Session settings changed; reload and retry' });
        }
        const existingRecord = (normalizedSession.joinRecords || []).find((record) => record.userId === userId);
        if (anonymousSession) {
          await Session.findByIdAndUpdate(request.params.id, { $addToSet: { joined: userId } });
        } else if (existingRecord) {
          await Session.findOneAndUpdate(
            { _id: request.params.id, 'joinRecords.userId': userId },
            {
              $addToSet: { joined: userId },
              $set: { 'joinRecords.$.joinedAt': now },
            },
          );
        } else {
          await Session.findByIdAndUpdate(request.params.id, {
            $addToSet: { joined: userId },
            $push: {
              joinRecords: {
                userId,
                joinedAt: now,
                joinedWithCode: false,
              },
            },
          });
        }
      }

      const questionIds = normalizedSession.questions || [];
      const orderedQuestions = await loadOrderedQuestions(questionIds);
      const answerableQuestionIds = orderedQuestions
        .filter((question) => isQuestionResponseCollectionEnabled(question))
        .map((question) => String(question._id));

      const responses = questionIds.length > 0
        ? await Response.find({
          questionId: { $in: questionIds },
          studentUserId: userId,
          attempt: 1,
        }).lean()
        : [];

      const latestResponseByQuestionId = {};
      responses.forEach((response) => {
        const questionId = String(response.questionId);
        const current = latestResponseByQuestionId[questionId];
        if (!current) {
          latestResponseByQuestionId[questionId] = response;
          return;
        }
        const currentTs = current.updatedAt ? new Date(current.updatedAt).getTime() : new Date(current.createdAt || 0).getTime();
        const nextTs = response.updatedAt ? new Date(response.updatedAt).getTime() : new Date(response.createdAt || 0).getTime();
        if (nextTs >= currentTs) {
          latestResponseByQuestionId[questionId] = response;
        }
      });

      const questionPayload = orderedQuestions.map((question) => {
        const response = latestResponseByQuestionId[String(question._id)];
        const revealAnswers = !!normalizedSession.practiceQuiz && !!response && response.editable === false;
        return sanitizeQuizQuestionForStudent(question, { revealAnswers });
      });

      const answeredQuestionIds = new Set(Object.keys(latestResponseByQuestionId));
      const allAnswered = answerableQuestionIds.every((questionId) => answeredQuestionIds.has(String(questionId)));

      return {
        session: buildSessionForUser(normalizedSession, request.user, {
          instructorView: false, outsideActivity: !isCourseMember(course, request.user),
        }),
        questions: questionPayload,
        responses: latestResponseByQuestionId,
        allAnswered,
        submitted: submittedByCurrentUser,
      };
    }
  );

  // PATCH /sessions/:id/quiz-response - Auto-save/update a quiz response
  app.patch(
    '/sessions/:id/quiz-response',
    {
      preHandler: authenticate,
      schema: saveQuizResponseSchema,
    },
    async (request, reply) => {
      const sessionDoc = await Session.findById(request.params.id).lean();
      if (!sessionDoc) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(sessionDoc.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!await hasSessionParticipantAccess(course, sessionDoc, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      if (isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only students can submit quiz responses' });
      }

      const { session: normalizedSession, changed } = await maybeAutoCloseScheduledQuiz(sessionDoc, { course });
      if (changed) {
        notifyStatusChanged(app, course, normalizedSession?._id || sessionDoc._id, { status: 'done' });
      }

      if (!isQuizLikeSession(normalizedSession)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Session is not a quiz' });
      }
      if (normalizedSession.studentCreated && !isStudentOwnedSession(normalizedSession, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session is not available' });
      }

      const runtime = getQuizRuntimeState(normalizedSession, {
        userId: request.user.userId,
        instructorView: false,
      });
      if (!runtime.isOpenForUser) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Quiz is closed' });
      }

      const participantId = getSessionParticipantId(normalizedSession, request.user.userId);
      if (
        Array.isArray(normalizedSession.submittedQuiz)
        && normalizedSession.submittedQuiz.includes(participantId)
        && !normalizedSession.practiceQuiz
      ) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Quiz already submitted' });
      }

      const questionId = request.body.questionId;
      if (!Array.isArray(normalizedSession.questions) || !normalizedSession.questions.includes(questionId)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Question not found in this quiz' });
      }

      const question = await Question.findById(questionId).lean();
      const questionBelongsToPracticeSession = isStudentOwnedSession(normalizedSession, request.user)
        && normalizedSession.practiceQuiz
        && (normalizedSession.questions || []).includes(String(question?._id || ''));
      if (!question || (!questionBelongsToPracticeSession && String(question.sessionId) !== String(normalizedSession._id))) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }
      if (!isQuestionResponseCollectionEnabled(question)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Slides do not accept quiz responses' });
      }

      const userId = participantId;
      if (!await claimSessionParticipation(normalizedSession)) {
        return reply.code(409).send({ error: 'Conflict', message: 'Session settings changed; reload and retry' });
      }
      const existing = await Response.findOne({
        questionId,
        studentUserId: userId,
        attempt: 1,
      }).lean();

      if (existing && existing.editable === false) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: normalizedSession.practiceQuiz
            ? 'This question has already been submitted'
            : 'Quiz answer is already locked',
        });
      }

      const now = new Date();
      const editable = true;
      // IP addresses would identify anonymous respondents.
      const submittedIpAddress = isAnonymousSession(normalizedSession) ? '' : getRequestIp(request);
      const payload = {
        answer: request.body.answer,
        answerWysiwyg: request.body.answerWysiwyg || '',
        updatedAt: now,
        submittedAt: now,
        submittedIpAddress,
        editable,
      };

      let response;
      if (existing) {
        response = await Response.findByIdAndUpdate(existing._id, { $set: payload }, { returnDocument: 'after' }).lean();
      } else {
        response = await Response.create({
          questionId,
          studentUserId: userId,
          attempt: 1,
          answer: request.body.answer,
          answerWysiwyg: request.body.answerWysiwyg || '',
          createdAt: now,
          updatedAt: now,
          submittedAt: now,
          submittedIpAddress,
          editable,
        });
        await Promise.all([
          incrementSessionResponseTracking(normalizedSession, questionId),
          incrementQuestionAttemptResponseTracking(questionId, 1),
        ]);
      }

      return { response: response?.toObject ? response.toObject() : response };
    }
  );

  // POST /sessions/:id/quiz-question-submit - Lock a practice-quiz question answer
  app.post(
    '/sessions/:id/quiz-question-submit',
    {
      preHandler: authenticate,
      schema: submitQuizQuestionSchema,
    },
    async (request, reply) => {
      const sessionDoc = await Session.findById(request.params.id).lean();
      if (!sessionDoc) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(sessionDoc.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!await hasSessionParticipantAccess(course, sessionDoc, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      if (isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only students can submit quiz responses' });
      }

      const { session: normalizedSession, changed } = await maybeAutoCloseScheduledQuiz(sessionDoc, { course });
      if (changed) {
        notifyStatusChanged(app, course, normalizedSession?._id || sessionDoc._id, { status: 'done' });
      }

      if (!isQuizLikeSession(normalizedSession)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Session is not a quiz' });
      }
      if (normalizedSession.studentCreated && !isStudentOwnedSession(normalizedSession, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session is not available' });
      }
      if (!normalizedSession.practiceQuiz) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Per-question submission is only available for practice quizzes' });
      }

      const runtime = getQuizRuntimeState(normalizedSession, {
        userId: request.user.userId,
        instructorView: false,
      });
      if (!runtime.isOpenForUser) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Quiz is closed' });
      }

      const questionId = request.body.questionId;
      if (!Array.isArray(normalizedSession.questions) || !normalizedSession.questions.includes(questionId)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Question not found in this quiz' });
      }

      const question = await Question.findById(questionId).lean();
      const questionBelongsToPracticeSession = isStudentOwnedSession(normalizedSession, request.user)
        && normalizedSession.practiceQuiz
        && (normalizedSession.questions || []).includes(String(question?._id || ''));
      if (!question || (!questionBelongsToPracticeSession && String(question.sessionId) !== String(normalizedSession._id))) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }
      if (!isQuestionResponseCollectionEnabled(question)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Slides cannot be submitted as quiz answers' });
      }

      const response = await Response.findOne({
        questionId,
        studentUserId: getSessionParticipantId(normalizedSession, request.user.userId),
        attempt: 1,
      });
      if (!response) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Answer this question before submitting it' });
      }

      if (response.editable === false) {
        return { response: response.toObject(), alreadySubmitted: true };
      }

      const locked = await Response.findByIdAndUpdate(
        response._id,
        { $set: { editable: false, updatedAt: new Date() } },
        { returnDocument: 'after' }
      );

      return { response: locked.toObject(), alreadySubmitted: false };
    }
  );

  // POST /sessions/:id/submit - Submit a quiz (locks all answers)
  app.post(
    '/sessions/:id/submit',
    { preHandler: authenticate },
    async (request, reply) => {
      const sessionDoc = await Session.findById(request.params.id).lean();
      if (!sessionDoc) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(sessionDoc.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!await hasSessionParticipantAccess(course, sessionDoc, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      if (isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Only students can submit quizzes' });
      }

      const { session: normalizedSession, changed } = await maybeAutoCloseScheduledQuiz(sessionDoc, { course });
      if (changed) {
        notifyStatusChanged(app, course, normalizedSession?._id || sessionDoc._id, { status: 'done' });
      }

      if (!isQuizLikeSession(normalizedSession)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Session is not a quiz' });
      }
      if (normalizedSession.studentCreated && !isStudentOwnedSession(normalizedSession, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session is not available' });
      }
      if (normalizedSession.practiceQuiz) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Practice quizzes are submitted per question' });
      }

      const anonymousSession = isAnonymousSession(normalizedSession);
      const userId = getSessionParticipantId(normalizedSession, request.user.userId);
      if (Array.isArray(normalizedSession.submittedQuiz) && normalizedSession.submittedQuiz.includes(userId)) {
        return reply.code(409).send({ error: 'Conflict', message: 'Quiz already submitted' });
      }

      const runtime = getQuizRuntimeState(normalizedSession, {
        userId: request.user.userId,
        instructorView: false,
      });
      if (!runtime.isOpenForUser) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Quiz is closed' });
      }

      const orderedQuestions = await loadOrderedQuestions(normalizedSession.questions || []);
      const answerableQuestionIds = orderedQuestions
        .filter((question) => isQuestionResponseCollectionEnabled(question))
        .map((question) => String(question._id));
      const responses = answerableQuestionIds.length > 0
        ? await Response.find({
          questionId: { $in: answerableQuestionIds },
          studentUserId: userId,
          attempt: 1,
        }).lean()
        : [];

      const answeredQuestionIds = new Set(responses.map((response) => String(response.questionId)));
      const hasAllAnswers = orderedQuestions.every((question) => (
        !isQuestionResponseCollectionEnabled(question)
        || (normalizedSession.allowSkippingZeroPointQuestions === true && question.sessionOptions?.points === 0)
        || answeredQuestionIds.has(String(question._id))
      ));
      if (!hasAllAnswers) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Must answer all questions to submit quiz' });
      }

      if (!await claimSessionParticipation(normalizedSession)) {
        return reply.code(409).send({ error: 'Conflict', message: 'Session settings changed; reload and retry' });
      }
      const now = new Date();
      await Response.updateMany(
        {
          questionId: { $in: answerableQuestionIds },
          studentUserId: userId,
          attempt: 1,
          editable: true,
        },
        { $set: { editable: false, updatedAt: now } }
      );

      const hasJoinRecord = Array.isArray(normalizedSession.joinRecords)
        && normalizedSession.joinRecords.some((record) => record.userId === userId);
      const updateOps = {
        $addToSet: { submittedQuiz: userId, joined: userId },
      };
      if (anonymousSession) {
        // Keep a durable append-only order for anonymous review batches.
        // The update predicate below prevents duplicate concurrent submissions.
        delete updateOps.$addToSet.submittedQuiz;
        updateOps.$push = { submittedQuiz: userId };
      } else if (hasJoinRecord) {
        updateOps.$set = { 'joinRecords.$[student].joinedAt': now };
      } else {
        updateOps.$push = {
          joinRecords: {
            userId,
            joinedAt: now,
            joinedWithCode: false,
          },
        };
      }

      const updated = await Session.findOneAndUpdate(
        anonymousSession
          ? { _id: request.params.id, submittedQuiz: { $ne: userId } }
          : { _id: request.params.id },
        updateOps,
        hasJoinRecord && !anonymousSession
          ? {
            returnDocument: 'after',
            arrayFilters: [{ 'student.userId': userId }],
          }
          : { returnDocument: 'after' }
      );

      if (!updated) {
        return reply.code(409).send({ error: 'Conflict', message: 'Quiz already submitted' });
      }
      notifyQuizSubmitted(app, course, updated?._id || request.params.id, request.user.userId);
      if (!anonymousSession || updated.submittedQuiz.length % MIN_ANONYMOUS_RESPONDENTS === 0) {
        // No answers or participant IDs in the notification. Review clients
        // coalesce submissions before loading the submitted-only snapshot.
        sendToInstructors(app, course, 'session:quiz-submitted', {
          courseId: String(course._id), sessionId: String(updated._id),
          ...(anonymousSession ? { anonymous: true, submittedCount: updated.submittedQuiz.length } : {}),
        });
      }

      return {
        success: true,
        session: updated ? buildSessionForUser(updated.toObject(), request.user, {
          instructorView: false, outsideActivity: !isCourseMember(course, request.user),
        }) : undefined,
      };
    }
  );

  // ─── Interactive Session Routes ──────────────────────────────────────────

  // POST /sessions/:id/join - Student joins a live session
  app.post(
    '/sessions/:id/join',
    {
      preHandler: authenticate,
      rateLimit: { max: 30, timeWindow: '1 minute' },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          properties: {
            joinCode: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const session = await Session.findById(request.params.id).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      if (session.status !== 'running') {
        return reply.code(400).send({ error: 'Bad Request', message: 'Session is not live' });
      }

      const course = await Course.findById(session.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      const anonymousSession = isAnonymousSession(session);
      const userId = getSessionParticipantId(session, request.user.userId);

      // Check if already joined
      const alreadyInList = (session.joined || []).includes(userId);
      const existingRecord = (session.joinRecords || []).find((r) => r.userId === userId);

      // Already joined students remain joined even if passcode settings change later.
      if (alreadyInList) {
        return { success: true, alreadyJoined: true };
      }

      // Enforce passcode requirement only at join time.
      const joinCodeRequired = !!session.joinCodeEnabled;
      if (joinCodeRequired && !session.joinCodeActive) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Join period is closed. Please wait for your instructor.',
        });
      }
      if (joinCodeRequired) {
        const providedCode = String(request.body?.joinCode || '').trim();
        if (!providedCode) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Join code is required' });
        }
        if (providedCode !== session.currentJoinCode) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Invalid join code' });
        }
      }

      if (!await claimSessionParticipation(session)) {
        return reply.code(409).send({ error: 'Conflict', message: 'Session settings changed; reload and retry' });
      }
      const now = new Date();
      const joinedWithCode = joinCodeRequired && session.joinCodeActive;

      if (anonymousSession) {
        // Attendance is stored only as the session pseudonym, with no join time.
        await Session.findByIdAndUpdate(request.params.id, { $addToSet: { joined: userId } });
      } else if (existingRecord) {
        // Upgrade existing record to mark joinedWithCode
        await Session.findOneAndUpdate(
          { _id: request.params.id, 'joinRecords.userId': userId },
          {
            $addToSet: { joined: userId },
            $set: {
              'joinRecords.$.joinedWithCode': joinedWithCode || existingRecord.joinedWithCode,
              'joinRecords.$.joinedAt': now,
            },
          },
        );
      } else {
        await Session.findByIdAndUpdate(request.params.id, {
          $addToSet: { joined: userId },
          $push: {
            joinRecords: {
              userId,
              joinedAt: now,
              joinedWithCode,
            },
          },
        });
      }

      const updatedSession = await Session.findById(request.params.id)
        .select('joined')
        .lean();
      const joinedCount = Array.isArray(updatedSession?.joined)
        ? updatedSession.joined.length
        : ((session.joined || []).length + 1);
      if (anonymousSession) {
        notifyParticipantJoined(app, course, request.params.id, { joinedCount, anonymous: true });
        return { success: true, alreadyJoined: false };
      }
      const joinedUser = await User.findById(userId)
        .select('_id profile emails email')
        .lean();

      const enrolled = (course.students || []).some((id) => String(id) === String(userId));
      const guest = !enrolled;
      notifyParticipantJoined(app, course, request.params.id, {
        joinedCount,
        joinedStudent: serializeLiveStudent({ ...joinedUser, _id: userId }, { joinedAt: now, course, guest }),
      });

      return { success: true, alreadyJoined: false };
    }
  );

  // POST /sessions/:id/join/:studentId - Instructor admits an enrolled student
  // at any point while a live session requires a passcode. The student-facing
  // join period does not restrict instructor admission.
  app.post(
    '/sessions/:id/join/:studentId',
    {
      preHandler: authenticate,
      rateLimit: { max: 60, timeWindow: '1 minute' },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        params: {
          type: 'object',
          required: ['id', 'studentId'],
          properties: {
            id: { type: 'string', minLength: 1 },
            studentId: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
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
      if (session.status !== 'running') {
        return reply.code(400).send({ error: 'Bad Request', message: 'Session is not live' });
      }
      if (!session.joinCodeEnabled) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Passcode is not required for this session' });
      }
      if (isAnonymousSession(session)) {
        // Admission results would reveal whether a named student has joined.
        return reply.code(400).send({ error: 'Bad Request', message: 'Students cannot be admitted individually in anonymous sessions' });
      }

      const studentId = normalizeAnswerValue(request.params.studentId);
      const enrolledStudentIds = new Set((course.students || []).map((id) => String(id)));
      if (!enrolledStudentIds.has(studentId)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Student is not enrolled in this course',
        });
      }

      const student = await User.findById(studentId)
        .select('_id profile emails email')
        .lean();
      if (!student) {
        return reply.code(404).send({ error: 'Not Found', message: 'Student not found' });
      }

      if ((session.joined || []).some((id) => String(id) === studentId)) {
        return { success: true, alreadyJoined: true };
      }

      const now = new Date();
      const existingRecord = (session.joinRecords || [])
        .find((record) => String(record?.userId || '') === studentId);
      const admissionFilter = {
        _id: request.params.id,
        status: 'running',
        joinCodeEnabled: true,
        joined: { $ne: studentId },
      };
      let updatedSession;
      if (existingRecord) {
        updatedSession = await Session.findOneAndUpdate(
          { ...admissionFilter, 'joinRecords.userId': studentId },
          {
            $addToSet: { joined: studentId },
            $set: {
              'joinRecords.$.joinedAt': now,
              'joinRecords.$.joinedWithCode': false,
            },
          },
          { returnDocument: 'after' },
        ).lean();
      } else {
        updatedSession = await Session.findOneAndUpdate(
          admissionFilter,
          {
            $addToSet: { joined: studentId },
            $push: {
              joinRecords: {
                userId: studentId,
                joinedAt: now,
                joinedWithCode: false,
              },
            },
          },
          { returnDocument: 'after' },
        ).lean();
      }

      if (!updatedSession) {
        const currentSession = await Session.findById(request.params.id)
          .select('status joinCodeEnabled joined')
          .lean();
        if ((currentSession?.joined || []).some((id) => String(id) === studentId)) {
          return { success: true, alreadyJoined: true };
        }
        return reply.code(400).send({
          error: 'Bad Request',
          message: currentSession?.status === 'running'
            ? 'Passcode is not required for this session'
            : 'Session is not live',
        });
      }

      const joinedStudent = serializeLiveStudent(student, { joinedAt: now, course });
      const participantPayload = {
        joinedCount: Array.isArray(updatedSession?.joined)
          ? updatedSession.joined.length
          : ((session.joined || []).length + 1),
        joinedStudent,
        admittedByInstructor: true,
      };

      notifyParticipantJoined(app, course, request.params.id, participantPayload);
      sendToUser(app, studentId, 'session:participant-admitted', {
        courseId: String(course._id),
        sessionId: String(session._id),
      });

      return {
        success: true,
        alreadyJoined: false,
        ...participantPayload,
      };
    }
  );

  // GET /sessions/:id/live - Get live session data
  app.get(
    '/sessions/:id/live',
    { preHandler: authenticate },
    async (request, reply) => {
      const session = await Session.findById(request.params.id).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(session.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      const isInstrOrAdmin = isInstructorOrAdmin(course, request.user);
      const anonymousSession = isAnonymousSession(session);
      const presentationView = isInstrOrAdmin
        && normalizeAnswerValue(request.query?.view).toLowerCase() === 'presentation';
      // Anonymous sessions never attach names to responses or list attendees.
      const includeStudentNames = isInstrOrAdmin
        && !presentationView
        && !anonymousSession
        && parseBooleanQuery(request.query?.includeStudentNames);
      const includeJoinedStudents = isInstrOrAdmin
        && !presentationView
        && !anonymousSession
        && parseBooleanQuery(request.query?.includeJoinedStudents);
      const userId = getSessionParticipantId(session, request.user.userId);
      let isJoined = (session.joined || []).includes(userId);

      // Inactive interactive sessions expose only enough state for participants
      // to leave a draft or display Upcoming/Ended. Do not load questions or
      // responses until the instructor returns the session to Live.
      if (!isInstrOrAdmin && !session.quiz && session.status !== 'running') {
        return {
          session: { _id: session._id, name: session.name, status: session.status, anonymous: anonymousSession, chatEnabled: false },
          isJoined,
          currentQuestion: null, currentAttempt: null, studentResponse: null,
          responseStats: null, wordCloudData: null, histogramData: null,
          questionHidden: true, showStats: false, showCorrect: false,
        };
      }

      // Fetch current question
      let currentQuestion = null;
      if (session.currentQuestion) {
        currentQuestion = await Question.findById(session.currentQuestion).lean();
      }
      const questionCount = Array.isArray(session.questions) ? session.questions.length : 0;
      const questionIndex = session.currentQuestion
        ? (session.questions || []).findIndex((id) => String(id) === String(session.currentQuestion))
        : -1;
      const questionNumber = questionIndex >= 0 ? questionIndex + 1 : null;
      const { pageProgress, questionProgress } = await loadSessionProgress(
        session.questions || [],
        session.currentQuestion,
      );
      const currentItemCollectsResponses = isQuestionResponseCollectionEnabled(currentQuestion);

      // For students: strip answer info and limit data
      const questionHidden = currentQuestion?.sessionOptions?.hidden ?? true;
      const showStats = currentItemCollectsResponses
        ? (currentQuestion?.sessionOptions?.stats ?? false) : false;
      const showCorrect = currentItemCollectsResponses ? (currentQuestion?.sessionOptions?.correct ?? false) : false;
      const attempts = currentQuestion?.sessionOptions?.attempts || [];
      const currentAttempt = currentItemCollectsResponses
        ? (attempts.length > 0 ? attempts[attempts.length - 1] : { number: 1, closed: false })
        : null;

      let responseStats = null;
      let studentResponse = null;
      let allResponses = null;
      let instructorResponseCount = 0;
      const questionId = currentQuestion?._id;

      if (questionId && currentItemCollectsResponses) {
        if (isInstrOrAdmin) {
          // Prof still needs individual responses for live review, but can reuse
          // cached aggregate stats instead of rebuilding them on every refresh.
          const responses = await Response.find({
            questionId,
            attempt: currentAttempt.number,
          }).sort({ updatedAt: -1, createdAt: -1, _id: -1 }).lean();
          instructorResponseCount = responses.length;
          const cachedResponseStats = currentAttempt
            ? getAttemptStatsEntry(currentQuestion, currentAttempt.number)
            : null;
          // Repair interrupted/older anonymous publication using the responses
          // already loaded for this instructor snapshot, with the same atomic gap.
          if (anonymousSession) {
            const published = await publishAnonymousAttemptStats(currentQuestion, currentAttempt.number,
              [...responses].reverse());
            currentQuestion = published.question;
            if (published.published) {
              await notifyResponseAdded(app, course, session, {
                question: currentQuestion, attempt: currentAttempt.number,
                responseCount: responses.length, joinedCount: (session.joined || []).length,
                anonymousStatsPublished: true,
              }, { includeStudents: !!currentQuestion.sessionOptions?.stats });
            }
          }
          responseStats = anonymousSession ? getAnonymousLiveResponseStats(currentQuestion, currentAttempt.number) : cachedResponseStats
            && isCanonicalAttemptStatsEntry(currentQuestion, cachedResponseStats, responses.length)
            ? materializeAttemptStatsEntry(cachedResponseStats)
            : buildResponseStats(currentQuestion, responses, currentAttempt.number);

          const includeNamesInPayload = includeStudentNames
            && ['shortAnswer', 'numerical'].includes(responseStats?.type);
          let studentNameById = {};
          if (includeNamesInPayload) {
            const responderIds = [...new Set(
              responses
                .map((response) => getResponseStudentId(response))
                .filter(Boolean)
            )];
            if (responderIds.length > 0) {
              const users = await User.find({ _id: { $in: responderIds } })
                .select('_id profile emails email')
                .lean();
              users.forEach((user) => {
                studentNameById[String(user._id)] = formatUserDisplayName(user);
              });
            }
          }

          // Keep response content but strip raw student identifiers from live payloads.
          allResponses = anonymousSession ? [] : responses.map((response) => {
            const base = {
              _id: response._id,
              attempt: response.attempt,
              questionId: response.questionId,
              answer: response.answer,
              answerWysiwyg: response.answerWysiwyg,
              correct: response.correct,
              mark: response.mark,
              createdAt: response.createdAt,
              updatedAt: response.updatedAt,
              editable: response.editable,
            };
            if (!includeNamesInPayload) return base;
            return {
              ...base,
              studentName: studentNameById[getResponseStudentId(response)] || 'Unknown Student',
            };
          });

          responseStats = formatInstructorLiveResponseStats(
            responseStats,
            studentNameById,
            includeNamesInPayload,
            anonymousSession
          );
        } else if (isJoined && !questionHidden) {
          if (showStats) {
            responseStats = formatStudentLiveResponseStats(
              anonymousSession ? getAnonymousLiveResponseStats(currentQuestion, currentAttempt.number)
                : await getQuestionAttemptStats(currentQuestion, currentAttempt.number),
              {
                showCorrect,
                showResponseList: currentQuestion?.sessionOptions?.responseListVisible !== false,
                anonymous: anonymousSession,
              }
            );
            studentResponse = await Response.findOne({
              questionId,
              studentUserId: userId,
              attempt: currentAttempt.number,
            }).lean();
          } else {
            // Only need student's own response
            studentResponse = await Response.findOne({
              questionId,
              studentUserId: userId,
              attempt: currentAttempt.number,
            }).lean();
          }
        }
      }

      let joinedStudents = [];
      let enrolledStudents = [];
      if (includeJoinedStudents) {
        const joinedIds = [...new Set((session.joined || []).map((id) => String(id)).filter(Boolean))];
        const enrolledIds = [...new Set((course.students || []).map((id) => String(id)).filter(Boolean))];
        const enrolledIdSet = new Set(enrolledIds);
        const rosterIds = [...new Set([...joinedIds, ...enrolledIds])];
        const rosterUsers = rosterIds.length > 0
          ? await User.find({ _id: { $in: rosterIds } })
            .select('_id profile emails email')
            .lean()
          : [];
        const rosterUserMap = new Map(rosterUsers.map((user) => [String(user._id), user]));

        const latestJoinByStudentId = new Map();
        (session.joinRecords || []).forEach((record) => {
          const studentId = normalizeAnswerValue(record?.userId);
          if (!studentId) return;
          const joinedAt = record?.joinedAt ? new Date(record.joinedAt) : null;
          if (!joinedAt || Number.isNaN(joinedAt.getTime())) return;
          const existing = latestJoinByStudentId.get(studentId);
          if (!existing || joinedAt > existing) {
            latestJoinByStudentId.set(studentId, joinedAt);
          }
        });

        joinedStudents = joinedIds.map((studentId) => {
          const user = rosterUserMap.get(studentId);
          return serializeLiveStudent({ ...user, _id: studentId }, {
            joinedAt: latestJoinByStudentId.get(studentId) || null,
            course, guest: !enrolledIdSet.has(studentId),
          });
        }).sort((a, b) => {
          const lastCmp = a.lastname.localeCompare(b.lastname);
          if (lastCmp !== 0) return lastCmp;
          const firstCmp = a.firstname.localeCompare(b.firstname);
          if (firstCmp !== 0) return firstCmp;
          return a.email.localeCompare(b.email);
        });

        enrolledStudents = enrolledIds
          .map((studentId) => serializeLiveStudent({
            ...rosterUserMap.get(studentId),
            _id: studentId,
          }, { course }))
          .sort((a, b) => {
            const lastCmp = a.lastname.localeCompare(b.lastname);
            if (lastCmp !== 0) return lastCmp;
            const firstCmp = a.firstname.localeCompare(b.firstname);
            if (firstCmp !== 0) return firstCmp;
            return a.email.localeCompare(b.email);
          });
      }

      const showResponseList = currentQuestion?.sessionOptions?.responseListVisible !== false;

      // Build response payload.
      // Student payload is intentionally minimal and only includes fields needed for live participation.
      const result = {
        course: {
          _id: course._id,
          name: course.name,
          deptCode: course.deptCode,
          courseNumber: course.courseNumber,
          section: course.section,
          semester: course.semester,
        },
        session: isInstrOrAdmin
          ? {
            _id: session._id,
            name: session.name,
            description: session.description,
            courseId: session.courseId,
            status: session.status,
            questions: session.questions,
            currentQuestion: session.currentQuestion,
            anonymous: anonymousSession,
            joinedCount: (session.joined || []).length,
            ...(!presentationView && !anonymousSession
              ? { joined: Array.isArray(session.joined) ? session.joined : [] }
              : {}),
            joinCodeActive: session.joinCodeActive,
            joinCodeEnabled: session.joinCodeEnabled,
            chatEnabled: session.chatEnabled,
            richTextChatEnabled: isRichTextChatEnabled(session),
            reviewable: session.reviewable,
          }
          : {
            _id: session._id,
            name: session.name,
            status: session.status,
            anonymous: anonymousSession,
            joinCodeActive: session.joinCodeActive,
            joinCodeEnabled: session.joinCodeEnabled,
            chatEnabled: isJoined && session.chatEnabled,
            richTextChatEnabled: isJoined && isRichTextChatEnabled(session),
          },
        currentQuestion: null,
        currentAttempt,
        responseStats,
        questionNumber,
        questionCount,
        pageProgress,
        questionProgress,
        showResponseList,
      };

      if (isInstrOrAdmin) {
        result.responseCount = instructorResponseCount;
      }

      if (isInstrOrAdmin) {
        if (presentationView && ['shortAnswer', 'numerical'].includes(responseStats?.type) && !showResponseList) {
          result.responseStats = {
            ...responseStats,
            answers: [],
          };
        }
        if (!presentationView) {
          // Anonymous sessions report the roster as loaded but empty, so the
          // client does not keep requesting names it cannot receive.
          result.session.joinedStudentsLoaded = includeJoinedStudents || anonymousSession;
          if (includeJoinedStudents) {
            result.session.joined = session.joined;
            result.session.joinRecords = session.joinRecords;
            result.session.joinedStudents = joinedStudents;
            result.session.enrolledStudents = enrolledStudents;
          }
        }
        result.session.joinCodeInterval = session.joinCodeInterval;
        result.session.currentJoinCode = session.currentJoinCode;
        result.allResponses = allResponses;

        if (currentQuestion) {
          const instructorQuestion = {
            ...currentQuestion,
            sessionOptions: currentQuestion.sessionOptions
              ? { ...currentQuestion.sessionOptions }
              : currentQuestion.sessionOptions,
          };
          if (instructorQuestion.sessionOptions) {
            delete instructorQuestion.sessionOptions.attemptStats;
            delete instructorQuestion.sessionOptions.wordCloudData;
            delete instructorQuestion.sessionOptions.histogramData;
          }
          result.currentQuestion = instructorQuestion;
          // Include word cloud data for instructors (always)
          if (currentQuestion.sessionOptions?.wordCloudData) {
            result.wordCloudData = currentQuestion.sessionOptions.wordCloudData;
          }
          // Include histogram data for instructors (always)
          if (currentQuestion.sessionOptions?.histogramData) {
            result.histogramData = currentQuestion.sessionOptions.histogramData;
          }
        }
      } else {
        // Student view
        if (isJoined && currentQuestion && !questionHidden) {
          // Strip correct answer info unless showCorrect is enabled
          result.currentQuestion = sanitizeStudentLiveQuestion(currentQuestion, { showCorrect });

          // Students/presentation only see word cloud when stats are visible AND cloud is visible
          if (showStats && currentQuestion.sessionOptions?.wordCloudData?.visible) {
            result.wordCloudData = currentQuestion.sessionOptions.wordCloudData;
          }
          // Students/presentation only see histogram when stats are visible AND histogram is visible
          if (showStats && currentQuestion.sessionOptions?.histogramData?.visible) {
            result.histogramData = currentQuestion.sessionOptions.histogramData;
          }
        }
        if (['shortAnswer', 'numerical'].includes(responseStats?.type) && !showResponseList) {
          result.responseStats = {
            ...responseStats,
            answers: [],
          };
        }
        result.studentResponse = sanitizeStudentOwnResponse(studentResponse);
        result.isJoined = isJoined;
        result.showStats = showStats;
        result.showResponseList = showResponseList;
        result.showCorrect = showCorrect;
        result.questionHidden = questionHidden;
      }

      if (presentationView) {
        const { question, ...snapshot } = buildStudentLiveQuestionSnapshot(currentQuestion, {}, {
          responseStats,
          anonymous: anonymousSession,
        });
        Object.assign(result, snapshot, {
          currentQuestion: question,
          allResponses: snapshot.responseStats?.answers || [],
        });
      }

      return result;
    }
  );

  app.post(
    '/sessions/:id/live-telemetry',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['role', 'samples'],
          properties: {
            role: { type: 'string', enum: LIVE_TELEMETRY_ROLES },
            samples: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                required: ['metric', 'durationMs'],
                properties: {
                  metric: { type: 'string', enum: liveTelemetryMetricNames },
                  durationMs: { type: 'number', minimum: 0 },
                  success: { type: 'boolean' },
                  transport: { type: 'string', enum: LIVE_TELEMETRY_TRANSPORTS },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
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

      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      const role = request.body.role;
      const isInstrOrAdmin = isInstructorOrAdmin(course, request.user);
      if (role === 'student' && isInstrOrAdmin) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Role mismatch for telemetry submission' });
      }
      if (role !== 'student' && !isInstrOrAdmin) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const update = buildLiveTelemetryUpdate({
        sessionId: session._id,
        courseId: course._id,
        role,
        samples: request.body.samples,
        updatedAt: new Date(),
      });

      if (!update) {
        return { accepted: 0 };
      }

      await LiveSessionTelemetry.findOneAndUpdate(
        { sessionId: String(session._id) },
        update,
        { upsert: true }
      );

      return {
        accepted: Number(update?.$inc?.[`${role}.sampleCount`] || 0),
      };
    }
  );

  app.get(
    '/sessions/:id/live-telemetry',
    { preHandler: authenticate },
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

      const telemetryDoc = await LiveSessionTelemetry.findOne({ sessionId: String(session._id) }).lean();
      const telemetry = summarizeLiveTelemetryDocument(
        telemetryDoc || {
          sessionId: String(session._id),
          courseId: String(course._id),
          updatedAt: null,
          student: {},
          professor: {},
          presentation: {},
        }
      );

      return { telemetry };
    }
  );

  // POST /sessions/:id/respond - Submit a response
  app.post(
    '/sessions/:id/respond',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['answer'],
          properties: {
            answer: {},
            answerWysiwyg: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const session = await Session.findById(request.params.id).lean();
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      if (session.status !== 'running') {
        return reply.code(400).send({ error: 'Bad Request', message: 'Session is not live' });
      }

      const userId = getSessionParticipantId(session, request.user.userId);
      if (!(session.joined || []).includes(userId)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'You have not joined this session' });
      }

      const course = await Course.findById(session.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
      }

      const questionId = session.currentQuestion;
      if (!questionId) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No current question' });
      }

      const question = await Question.findById(questionId).lean();
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }
      if (!isQuestionResponseCollectionEnabled(question)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Slides do not accept live responses' });
      }

      // Check if question is hidden
      if (question.sessionOptions?.hidden) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Question is not visible' });
      }

      // Get current attempt
      const attempts = question.sessionOptions?.attempts || [];
      const currentAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : { number: 1, closed: false };

      if (currentAttempt.closed) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Responses are closed for this attempt' });
      }

      // Check if student already responded to this attempt
      const existingResponse = await Response.findOne({
        questionId,
        studentUserId: userId,
        attempt: currentAttempt.number,
      }).lean();

      if (existingResponse) {
        return reply.code(409).send({ error: 'Conflict', message: 'You have already responded to this attempt' });
      }

      if (!await claimSessionParticipation(session)) {
        return reply.code(409).send({ error: 'Conflict', message: 'Session settings changed; reload and retry' });
      }
      const now = new Date();
      const response = await Response.create({
        questionId,
        studentUserId: userId,
        attempt: currentAttempt.number,
        answer: request.body.answer,
        answerWysiwyg: request.body.answerWysiwyg || '',
        submittedAt: now,
        // IP addresses would identify anonymous respondents.
        submittedIpAddress: isAnonymousSession(session) ? '' : getRequestIp(request),
        createdAt: now,
      });

      const anonymousUpdate = isAnonymousSession(session)
        ? await appendAnonymousResponseToQuestionAttemptStats(question, currentAttempt.number) : null;
      const trackedQuestion = anonymousUpdate ? anonymousUpdate.question : await appendResponseToQuestionAttemptStats(
        question,
        currentAttempt.number,
        response
      );
      const responseCount = Number(trackedQuestion?.sessionProperties?.lastAttemptResponseCount || 0);

      // Session response tracking is used as a presence signal by session lists
      // and review warnings. Only the first response for an attempt needs to
      // touch the shared Session document; every response is counted atomically
      // on the Question document above.
      const storedSessionCount = Number(getSessionQuestionResponseCounts(session)?.[String(questionId)] || 0);
      if ((isAnonymousSession(session) ? responseCount > 0 : responseCount === 1) && storedSessionCount === 0) {
        await Session.updateOne(
          { _id: session._id },
          {
            $set: {
              hasResponses: true,
              [`questionResponseCounts.${String(questionId)}`]: 1,
            },
          }
        );
      }

      // Keep the response event minimal; joined students only receive it while live stats are visible.
      await notifyResponseAdded(app, course, session, {
        questionId: String(questionId),
        question: trackedQuestion || question,
        anonymousStatsPublished: anonymousUpdate?.published || false,
        response: response.toObject ? response.toObject() : { ...response },
        attempt: currentAttempt.number,
        responseCount,
        joinedCount: (session.joined || []).length,
      }, {
        includeStudents: !!question?.sessionOptions?.stats,
      });

      return reply.code(201).send({ response: response.toObject() });
    }
  );

  // PATCH /sessions/:id/question-visibility - Toggle question visibility/stats/correct
  app.patch(
    '/sessions/:id/question-visibility',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          properties: {
            hidden: { type: 'boolean' },
            stats: { type: 'boolean' },
            correct: { type: 'boolean' },
            responseListVisible: { type: 'boolean' },
          },
          additionalProperties: false,
        },
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

      const questionId = session.currentQuestion;
      if (!questionId) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No current question' });
      }

      const question = await Question.findById(questionId).lean();
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      const updates = {};
      if (request.body.hidden !== undefined) updates['sessionOptions.hidden'] = request.body.hidden;
      if (isQuestionResponseCollectionEnabled(question)) {
        if (request.body.stats !== undefined) updates['sessionOptions.stats'] = request.body.stats;
        if (request.body.correct !== undefined) updates['sessionOptions.correct'] = request.body.correct;
        if (request.body.responseListVisible !== undefined) {
          updates['sessionOptions.responseListVisible'] = request.body.responseListVisible;
        }
      } else {
        updates['sessionOptions.stats'] = false;
        updates['sessionOptions.correct'] = false;
      }

      const updatedQuestion = await Question.findByIdAndUpdate(
        questionId,
        { $set: updates },
        { returnDocument: 'after' }
      );

      await notifyVisibilityChanged(app, course, session, updatedQuestion);

      return { question: updatedQuestion?.toObject() };
    }
  );

  // POST /sessions/:id/word-cloud - Generate / refresh word cloud data for current SA question
  app.post(
    '/sessions/:id/word-cloud',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          properties: {
            stopWords: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          additionalProperties: false,
        },
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

      const questionId = session.currentQuestion;
      if (!questionId) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No current question' });
      }

      const question = await Question.findById(questionId).lean();
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      if (normalizeQuestionType(question) !== 2) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Word cloud is only supported for short-answer questions' });
      }

      const attempts = question.sessionOptions?.attempts || [];
      const currentAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : { number: 1 };
      const texts = isAnonymousSession(session)
        ? (getAnonymousLiveResponseStats(question, currentAttempt.number)?.answers || [])
          .map((entry) => entry.answerWysiwyg || normalizeAnswerValue(entry.answer)).filter(Boolean)
        : await collectShortAnswerTextsFromAttemptStats(question, currentAttempt.number);

      const stopWords = Array.isArray(request.body?.stopWords) ? request.body.stopWords : [];
      const wordFrequencies = computeWordFrequencies(texts, stopWords, 100);

      const updatedQuestion = await Question.findByIdAndUpdate(
        questionId,
        {
          $set: {
            'sessionOptions.wordCloudData.wordFrequencies': wordFrequencies,
            'sessionOptions.wordCloudData.visible': true,
            'sessionOptions.wordCloudData.generatedAt': new Date(),
          },
        },
        { returnDocument: 'after' }
      );

      const wordCloudData = updatedQuestion?.sessionOptions?.wordCloudData?.toObject
        ? updatedQuestion.sessionOptions.wordCloudData.toObject()
        : updatedQuestion?.sessionOptions?.wordCloudData;

      notifyVisualizationUpdated(
        app,
        course,
        session,
        updatedQuestion,
        'session:word-cloud-updated',
        'wordCloudData',
        wordCloudData
      );

      return { wordCloudData };
    }
  );

  // PATCH /sessions/:id/word-cloud-visibility - Toggle word cloud visibility
  app.patch(
    '/sessions/:id/word-cloud-visibility',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['visible'],
          properties: {
            visible: { type: 'boolean' },
          },
          additionalProperties: false,
        },
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

      const questionId = session.currentQuestion;
      if (!questionId) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No current question' });
      }

      const updatedQuestion = await Question.findByIdAndUpdate(
        questionId,
        { $set: { 'sessionOptions.wordCloudData.visible': request.body.visible } },
        { returnDocument: 'after' }
      );

      const wordCloudData = updatedQuestion?.sessionOptions?.wordCloudData?.toObject
        ? updatedQuestion.sessionOptions.wordCloudData.toObject()
        : updatedQuestion?.sessionOptions?.wordCloudData;

      notifyVisualizationUpdated(
        app,
        course,
        session,
        updatedQuestion,
        'session:word-cloud-updated',
        'wordCloudData',
        wordCloudData
      );

      return { wordCloudData };
    }
  );

  // POST /sessions/:id/histogram - Generate / refresh histogram data for current NU question
  app.post(
    '/sessions/:id/histogram',
    {
      preHandler: authenticate,
      rateLimit: { max: 20, timeWindow: '1 minute' },
      schema: {
        body: {
          type: 'object',
          properties: {
            numBins: { type: 'number' },
            rangeMin: { type: 'number' },
            rangeMax: { type: 'number' },
          },
          additionalProperties: false,
        },
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

      const questionId = session.currentQuestion;
      if (!questionId) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No current question' });
      }

      const question = await Question.findById(questionId).lean();
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      if (normalizeQuestionType(question) !== 4) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Histogram is only supported for numerical questions' });
      }

      const attempts = question.sessionOptions?.attempts || [];
      const currentAttempt = attempts.length > 0 ? attempts[attempts.length - 1] : { number: 1 };
      const values = isAnonymousSession(session)
        ? (getAnonymousLiveResponseStats(question, currentAttempt.number)?.values || [])
        : await collectNumericalValuesFromAttemptStats(question, currentAttempt.number);

      const histOpts = {};
      if (request.body?.numBins != null) histOpts.numBins = request.body.numBins;
      if (request.body?.rangeMin != null) histOpts.rangeMin = request.body.rangeMin;
      if (request.body?.rangeMax != null) histOpts.rangeMax = request.body.rangeMax;

      const computed = computeHistogramData(values, histOpts);

      const updatedQuestion = await Question.findByIdAndUpdate(
        questionId,
        {
          $set: {
            'sessionOptions.histogramData.bins': computed.bins,
            'sessionOptions.histogramData.overflowLow': computed.overflowLow,
            'sessionOptions.histogramData.overflowHigh': computed.overflowHigh,
            'sessionOptions.histogramData.rangeMin': computed.rangeMin,
            'sessionOptions.histogramData.rangeMax': computed.rangeMax,
            'sessionOptions.histogramData.numBins': computed.numBins,
            'sessionOptions.histogramData.visible': true,
            'sessionOptions.histogramData.generatedAt': new Date(),
          },
        },
        { returnDocument: 'after' }
      );

      const histogramData = updatedQuestion?.sessionOptions?.histogramData?.toObject
        ? updatedQuestion.sessionOptions.histogramData.toObject()
        : updatedQuestion?.sessionOptions?.histogramData;

      notifyVisualizationUpdated(
        app,
        course,
        session,
        updatedQuestion,
        'session:histogram-updated',
        'histogramData',
        histogramData
      );

      return { histogramData };
    }
  );

  // PATCH /sessions/:id/histogram-visibility - Toggle histogram visibility
  app.patch(
    '/sessions/:id/histogram-visibility',
    {
      preHandler: authenticate,
      rateLimit: { max: 20, timeWindow: '1 minute' },
      schema: {
        body: {
          type: 'object',
          required: ['visible'],
          properties: {
            visible: { type: 'boolean' },
          },
          additionalProperties: false,
        },
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

      const questionId = session.currentQuestion;
      if (!questionId) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No current question' });
      }

      const updatedQuestion = await Question.findByIdAndUpdate(
        questionId,
        { $set: { 'sessionOptions.histogramData.visible': request.body.visible } },
        { returnDocument: 'after' }
      );

      const histogramData = updatedQuestion?.sessionOptions?.histogramData?.toObject
        ? updatedQuestion.sessionOptions.histogramData.toObject()
        : updatedQuestion?.sessionOptions?.histogramData;

      notifyVisualizationUpdated(
        app,
        course,
        session,
        updatedQuestion,
        'session:histogram-updated',
        'histogramData',
        histogramData
      );

      return { histogramData };
    }
  );

  app.post(
    '/sessions/:id/new-attempt',
    { preHandler: authenticate },
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

      const questionId = session.currentQuestion;
      if (!questionId) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No current question' });
      }

      const question = await Question.findById(questionId);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }
      if (!isQuestionResponseCollectionEnabled(question)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Slides do not support attempts' });
      }

      const attempts = question.sessionOptions?.attempts || [];
      const trackedAttemptNumber = Number(question.sessionProperties?.lastAttemptNumber) || 0;
      const trackedAttemptResponseCount = Number(question.sessionProperties?.lastAttemptResponseCount) || 0;
      const hasImplicitFirstAttempt = attempts.length === 0
        && (trackedAttemptNumber > 0 || trackedAttemptResponseCount > 0);
      const attemptsToClose = attempts.length > 0
        ? attempts
        : (hasImplicitFirstAttempt ? [{ number: trackedAttemptNumber || 1, closed: false }] : []);

      // Close current attempt
      const closedAttempts = attemptsToClose.map((a) => ({ ...a.toObject ? a.toObject() : a, closed: true }));
      const previousAttemptNumber = attemptsToClose.length > 0
        ? Math.max(...attemptsToClose.map((a) => Number(a?.number) || 1))
        : 0;
      // Published anonymous batches must survive authoring edits to attempt
      // metadata. Never reuse an attempt number that already has a cache.
      const anonymousAttemptNumbers = isAnonymousSession(session)
        ? (question.sessionOptions?.attemptStats || []).map((entry) => Number(entry.number) || 0)
        : [];
      const newAttemptNumber = Math.max(previousAttemptNumber, ...anonymousAttemptNumbers) + 1;
      closedAttempts.push({ number: newAttemptNumber, closed: false });
      const nextAttemptStats = [
        ...((question.sessionOptions?.attemptStats || []).map((entry) => (entry.toObject ? entry.toObject() : { ...entry }))),
      ].filter((entry) => Number(entry?.number) !== newAttemptNumber);
      const newAttemptStatsEntry = buildAttemptStatsEntry(question, newAttemptNumber);
      if (newAttemptStatsEntry) {
        nextAttemptStats.push(newAttemptStatsEntry);
      }
      const resetGeneratedVisualizationUpdate = buildResetGeneratedVisualizationUpdate();

      const anonymousSession = isAnonymousSession(session);
      const updatedQuestion = await Question.findOneAndUpdate(
        {
          _id: questionId,
          ...(anonymousSession ? { 'sessionOptions.attemptStats.number': { $ne: newAttemptNumber } } : {}),
        },
        {
          $set: {
            'sessionOptions.attempts': closedAttempts,
            ...(!anonymousSession ? { 'sessionOptions.attemptStats': nextAttemptStats } : {}),
            'sessionOptions.stats': false,
            'sessionOptions.correct': false,
            ...resetGeneratedVisualizationUpdate,
            'sessionProperties.lastAttemptNumber': newAttemptNumber,
            'sessionProperties.lastAttemptResponseCount': 0,
            'sessionProperties.lastAttemptAggregateCount': 0,
          },
          // Append atomically so a concurrent response publication cannot be
          // overwritten by the older question document loaded above.
          ...(anonymousSession ? { $push: { 'sessionOptions.attemptStats': newAttemptStatsEntry } } : {}),
        },
        { returnDocument: 'after' }
      );
      if (!updatedQuestion) {
        return reply.code(409).send({ error: 'Conflict', message: 'Attempt changed; reload and retry' });
      }

      notifyAttemptChanged(app, course, session._id, updatedQuestion, { resetResponses: true });

      return { question: updatedQuestion?.toObject(), attemptNumber: newAttemptNumber };
    }
  );

  // PATCH /sessions/:id/toggle-responses - Toggle allowing responses
  app.patch(
    '/sessions/:id/toggle-responses',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          required: ['closed'],
          properties: {
            closed: { type: 'boolean' },
          },
          additionalProperties: false,
        },
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

      const questionId = session.currentQuestion;
      if (!questionId) {
        return reply.code(400).send({ error: 'Bad Request', message: 'No current question' });
      }

      const question = await Question.findById(questionId).lean();
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }
      if (!isQuestionResponseCollectionEnabled(question)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Slides do not accept responses' });
      }

      const attempts = question.sessionOptions?.attempts || [];
      if (attempts.length === 0) {
        // Anonymous answers may already belong to the implicit first attempt.
        // Closing/reopening it must preserve its published privacy boundary.
        const anonymousSession = isAnonymousSession(session);
        // Initialize with first attempt
        const firstAttemptStatsEntry = buildAttemptStatsEntry(question, 1);
        const resetGeneratedVisualizationUpdate = buildResetGeneratedVisualizationUpdate();
        const updatedQuestion = await Question.findByIdAndUpdate(
          questionId,
          {
            $set: {
              'sessionOptions.attempts': [{ number: 1, closed: request.body.closed }],
              ...(!anonymousSession ? {
                'sessionOptions.attemptStats': firstAttemptStatsEntry ? [firstAttemptStatsEntry] : [],
                ...resetGeneratedVisualizationUpdate,
                'sessionProperties.lastAttemptNumber': 1,
                'sessionProperties.lastAttemptResponseCount': 0,
                'sessionProperties.lastAttemptAggregateCount': 0,
              } : {}),
            },
          },
          { returnDocument: 'after' }
        );
        notifyAttemptChanged(app, course, session._id, updatedQuestion, { resetResponses: !anonymousSession });
        return { question: updatedQuestion?.toObject() };
      }

      // Update the last attempt's closed status
      const updated = attempts.map((a, i) => {
        const obj = a.toObject ? a.toObject() : { ...a };
        if (i === attempts.length - 1) obj.closed = request.body.closed;
        return obj;
      });

      const updatedQuestion = await Question.findByIdAndUpdate(
        questionId,
        { $set: { 'sessionOptions.attempts': updated } },
        { returnDocument: 'after' }
      );

      notifyAttemptChanged(app, course, session._id, updatedQuestion);

      return { question: updatedQuestion?.toObject() };
    }
  );

  // POST /sessions/:id/refresh-join-code - Generate a new join code
  app.post(
    '/sessions/:id/refresh-join-code',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          properties: {
            force: { type: 'boolean' },
          },
          additionalProperties: false,
        },
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

      if (session.status !== 'running') {
        return reply.code(400).send({ error: 'Bad Request', message: 'Session is not live' });
      }
      if (!session.joinCodeEnabled) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Passcode is not required for this session' });
      }
      if (!session.joinCodeActive) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Join period is closed' });
      }

      const force = !!request.body?.force;
      const now = new Date();
      const currentExpiryMs = new Date(session.joinCodeExpiresAt || 0).getTime();
      if (!force && session.currentJoinCode && currentExpiryMs > now.getTime()) {
        return { joinCode: session.currentJoinCode, expiresAt: session.joinCodeExpiresAt };
      }

      const updated = await Session.findOneAndUpdate(
        force
          ? {
            _id: request.params.id,
            status: 'running',
            joinCodeEnabled: true,
            joinCodeActive: true,
            currentJoinCode: session.currentJoinCode || '',
            joinCodeExpiresAt: session.joinCodeExpiresAt || null,
          }
          : {
            _id: request.params.id,
            status: 'running',
            joinCodeEnabled: true,
            joinCodeActive: true,
            $or: [
              { currentJoinCode: { $in: ['', null] } },
              { joinCodeExpiresAt: null },
              { joinCodeExpiresAt: { $lte: now } },
            ],
          },
        {
          $set: {
            currentJoinCode: generateJoinCode(),
            joinCodeExpiresAt: new Date(now.getTime() + (session.joinCodeInterval || 10) * 1000),
          },
        },
        { returnDocument: 'after' }
      );

      if (!updated) {
        const currentSession = await Session.findById(request.params.id).lean();
        if (!currentSession) {
          return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
        }
        if (currentSession.status !== 'running') {
          return reply.code(400).send({ error: 'Bad Request', message: 'Session is not live' });
        }
        if (!currentSession.joinCodeEnabled) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Passcode is not required for this session' });
        }
        if (!currentSession.joinCodeActive) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Join period is closed' });
        }
        return {
          joinCode: currentSession.currentJoinCode,
          expiresAt: currentSession.joinCodeExpiresAt,
        };
      }

      // Rotation changes only the displayed code. A delayed rotation event must
      // not restore stale admission flags after another request closes the period.
      // Participants never need code rotations (and must not receive the code).
      sendToInstructors(app, course, 'session:join-code-changed', {
        courseId: String(course._id),
        sessionId: String(updated._id),
        currentJoinCode: normalizeAnswerValue(updated.currentJoinCode),
      });

      return { joinCode: updated.currentJoinCode, expiresAt: updated.joinCodeExpiresAt };
    }
  );

  // PATCH /sessions/:id/join-code-settings - Update join code settings
  app.patch(
    '/sessions/:id/join-code-settings',
    {
      preHandler: authenticate,
      schema: {
        body: {
          type: 'object',
          properties: {
            joinCodeEnabled: { type: 'boolean' },
            joinCodeActive: { type: 'boolean' },
            joinCodeInterval: { type: 'number', minimum: 5, maximum: 120 },
          },
          additionalProperties: false,
        },
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

      const updates = {};
      const nextJoinCodeEnabled = request.body.joinCodeEnabled ?? session.joinCodeEnabled;
      const nextJoinCodeInterval = request.body.joinCodeInterval ?? session.joinCodeInterval ?? 10;

      if (request.body.joinCodeEnabled !== undefined) {
        updates.joinCodeEnabled = request.body.joinCodeEnabled;
      }
      if (request.body.joinCodeInterval !== undefined) {
        updates.joinCodeInterval = request.body.joinCodeInterval;
      }

      if (!nextJoinCodeEnabled) {
        if (request.body.joinCodeActive === true) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'Passcode requirement must be enabled before opening a join period',
          });
        }
        updates.joinCodeActive = false;
        updates.currentJoinCode = '';
        updates.joinCodeExpiresAt = null;
      } else if (request.body.joinCodeActive !== undefined) {
        updates.joinCodeActive = request.body.joinCodeActive;
        if (request.body.joinCodeActive) {
          const now = new Date();
          updates.currentJoinCode = generateJoinCode();
          updates.joinCodeExpiresAt = new Date(now.getTime() + nextJoinCodeInterval * 1000);
        } else {
          updates.currentJoinCode = '';
          updates.joinCodeExpiresAt = null;
        }
      }

      const updated = await Session.findByIdAndUpdate(
        request.params.id,
        { $set: updates },
        { returnDocument: 'after' }
      );

      notifyJoinCodeChanged(app, course, updated);

      return { session: serializeInstructorSession(updated) };
    }
  );

  app.patch(
    '/sessions/:id/chat-settings',
    {
      preHandler: authenticate,
      rateLimit: { max: 20, timeWindow: '1 minute' },
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          properties: {
            chatEnabled: { type: 'boolean' },
            richTextChatEnabled: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { session, course } = await loadSessionChatContext(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      if (request.body?.chatEnabled === undefined && request.body?.richTextChatEnabled === undefined) {
        return reply.code(400).send({ error: 'Bad Request', message: 'At least one chat setting is required' });
      }

      const sessionUpdates = {};
      if (request.body?.chatEnabled !== undefined) {
        sessionUpdates.chatEnabled = !!request.body.chatEnabled;
      }
      if (request.body?.richTextChatEnabled !== undefined) {
        sessionUpdates.richTextChatEnabled = !!request.body.richTextChatEnabled;
      }

      const updated = await Session.findByIdAndUpdate(
        request.params.id,
        { $set: sessionUpdates },
        { returnDocument: 'after' }
      ).lean();

      if (updated?.chatEnabled) {
        await ensureSessionQuickPosts(updated);
      }

      notifyChatSettingsChanged(app, course, updated);

      return {
        session: {
          _id: updated?._id,
          chatEnabled: !!updated?.chatEnabled,
          richTextChatEnabled: isRichTextChatEnabled(updated),
        },
      };
    }
  );

  app.get(
    '/sessions/:id/chat',
    {
      preHandler: authenticate,
      rateLimit: { max: 90, timeWindow: '1 minute' },
      config: { rateLimit: { max: 90, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { session, course } = await loadSessionChatContext(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session chat is not available' });
      }

      const payload = await loadSessionChatPayload({ session, course, request });
      if (payload?.forbidden) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session chat is not available' });
      }
      return payload;
    }
  );

  app.post(
    '/sessions/:id/chat/posts',
    {
      preHandler: authenticate,
      rateLimit: { max: 40, timeWindow: '1 minute' },
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          properties: {
            body: { type: 'string' },
            bodyWysiwyg: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { session, course } = await loadSessionChatContext(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session chat is not available' });
      }

      const viewMode = getChatViewMode(request, isInstructorOrAdmin(course, request.user));
      const flags = getChatPermissionFlags({ session, course, request, viewMode });
      if (!flags.canWrite || !session.chatEnabled || !isRichTextChatEnabled(session)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session chat is not available' });
      }

      const bodyWysiwyg = normalizeAnswerValue(request.body?.bodyWysiwyg);
      const body = normalizeAnswerValue(request.body?.body || stripHtmlToPlainText(bodyWysiwyg));
      if (!body && !bodyWysiwyg) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Post content is required' });
      }

      const created = await Post.create({
        scopeType: 'session',
        courseId: String(course._id),
        sessionId: String(session._id),
        authorId: String(request.user.userId),
        authorRole: getChatAuthorRole(course, request.user),
        body,
        bodyWysiwyg,
        isQuickPost: false,
        quickPostQuestionNumber: null,
        upvoteUserIds: [],
        upvoteCount: 0,
        comments: [],
        dismissedAt: null,
        dismissedBy: '',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await notifyChatUpdated(app, course, session, {
        changeType: 'post-created',
        postId: String(created._id),
        post: created.toObject ? created.toObject() : { ...created },
      });

      return { success: true, postId: String(created._id) };
    }
  );

  app.post(
    '/sessions/:id/chat/quick-posts/:questionNumber/toggle',
    {
      preHandler: authenticate,
      rateLimit: { max: 40, timeWindow: '1 minute' },
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { session, course } = await loadSessionChatContext(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session chat is not available' });
      }

      const viewMode = getChatViewMode(request, isInstructorOrAdmin(course, request.user));
      const flags = getChatPermissionFlags({ session, course, request, viewMode });
      if (!flags.canWrite || flags.isInstructorView || !session.chatEnabled) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Quick posts are not available' });
      }

      const questionNumber = Number.parseInt(request.params.questionNumber, 10);
      const questionMetadata = await loadSessionChatQuestionMetadata(session);
      const currentQuestionNumber = questionMetadata.currentQuestionNumber;
      if (!Number.isInteger(questionNumber) || questionNumber <= 0) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Invalid quick-post question number' });
      }
      if (currentQuestionNumber != null && questionNumber > currentQuestionNumber) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Quick posts are only available for the current or earlier questions' });
      }

      await ensureSessionQuickPosts(session, questionMetadata);
      const post = await Post.findOne({
        scopeType: 'session',
        sessionId: String(session._id),
        isQuickPost: true,
        quickPostQuestionNumber: questionNumber,
      }).lean();

      if (!post) {
        return reply.code(404).send({ error: 'Not Found', message: 'Quick post not found' });
      }
      if (post.dismissedAt) {
        return reply.code(403).send({ error: 'Forbidden', message: 'This post was dismissed by the instructor' });
      }

      const userId = String(request.user.userId);
      const upvoteUserIds = Array.isArray(post.upvoteUserIds) ? post.upvoteUserIds.map((id) => String(id)) : [];
      const hasUpvoted = upvoteUserIds.includes(userId);
      const nextUpvoteUserIds = hasUpvoted
        ? upvoteUserIds.filter((id) => id !== userId)
        : [...upvoteUserIds, userId];

      const updated = await Post.findByIdAndUpdate(
        post._id,
        {
          $set: {
            upvoteUserIds: nextUpvoteUserIds,
            upvoteCount: nextUpvoteUserIds.length,
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after' }
      ).lean();

      await notifyChatUpdatedCoalesced(app, course, session, {
        changeType: 'quick-post-toggled',
        becameVisible: Number(post.upvoteCount || 0) <= 0 && Number(updated?.upvoteCount || 0) > 0,
        postId: String(post._id),
        post: updated,
        currentQuestionNumber,
      });

      return {
        success: true,
        postId: String(post._id),
        viewerHasUpvoted: !hasUpvoted,
        upvoteCount: Number(updated?.upvoteCount || 0),
      };
    }
  );

  app.patch(
    '/sessions/:id/chat/posts/:postId',
    {
      preHandler: authenticate,
      rateLimit: { max: 40, timeWindow: '1 minute' },
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          properties: {
            body: { type: 'string' },
            bodyWysiwyg: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { session, course } = await loadSessionChatContext(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session chat is not available' });
      }

      const viewMode = getChatViewMode(request, isInstructorOrAdmin(course, request.user));
      const flags = getChatPermissionFlags({ session, course, request, viewMode });
      if (!flags.canWrite || !session.chatEnabled || !isRichTextChatEnabled(session)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Post editing is not available' });
      }

      const post = await Post.findOne({
        _id: request.params.postId,
        scopeType: 'session',
        sessionId: String(session._id),
      }).lean();
      if (!post) {
        return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
      }
      if (String(post.authorId || '') !== String(request.user.userId || '')) {
        return reply.code(403).send({ error: 'Forbidden', message: 'You can only edit your own posts' });
      }
      if (post.isQuickPost) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Quick posts cannot be edited' });
      }
      if (post.dismissedAt) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Dismissed posts cannot be edited' });
      }

      const bodyWysiwyg = normalizeAnswerValue(request.body?.bodyWysiwyg);
      const body = normalizeAnswerValue(request.body?.body || stripHtmlToPlainText(bodyWysiwyg));
      if (!body && !bodyWysiwyg) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Post content is required' });
      }

      const updated = await Post.findByIdAndUpdate(
        post._id,
        { $set: { body, bodyWysiwyg, updatedAt: new Date() } },
        { returnDocument: 'after' }
      ).lean();

      await notifyChatUpdated(app, course, session, {
        changeType: 'post-edited',
        postId: String(post._id),
        post: updated,
      });

      return { success: true, postId: String(post._id) };
    }
  );

  app.patch(
    '/sessions/:id/chat/posts/:postId/vote',
    {
      preHandler: authenticate,
      rateLimit: { max: 40, timeWindow: '1 minute' },
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['upvoted'],
          properties: {
            upvoted: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { session, course } = await loadSessionChatContext(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session chat is not available' });
      }

      const viewMode = getChatViewMode(request, isInstructorOrAdmin(course, request.user));
      const flags = getChatPermissionFlags({ session, course, request, viewMode });
      if (!flags.canWrite || flags.isInstructorView || !session.chatEnabled) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Voting is not available' });
      }

      const post = await Post.findOne({
        _id: request.params.postId,
        scopeType: 'session',
        sessionId: String(session._id),
      }).lean();
      if (!post) {
        return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
      }
      if (post.dismissedAt) {
        return reply.code(403).send({ error: 'Forbidden', message: 'This post was dismissed by the instructor' });
      }
      if (post.authorId && String(post.authorId) === String(request.user.userId)) {
        return reply.code(400).send({ error: 'Bad Request', message: 'You cannot vote on your own post' });
      }

      const questionMetadata = await loadSessionChatQuestionMetadata(session);
      const currentQuestionNumber = questionMetadata.currentQuestionNumber;
      if (post.isQuickPost && currentQuestionNumber != null && Number(post.quickPostQuestionNumber) > currentQuestionNumber) {
        return reply.code(400).send({ error: 'Bad Request', message: 'This quick post is not available yet' });
      }

      const userId = String(request.user.userId);
      const upvoteUserIds = Array.isArray(post.upvoteUserIds) ? post.upvoteUserIds.map((id) => String(id)) : [];
      const hasUpvoted = upvoteUserIds.includes(userId);
      const nextUpvoteUserIds = request.body.upvoted
        ? (hasUpvoted ? upvoteUserIds : [...upvoteUserIds, userId])
        : upvoteUserIds.filter((id) => id !== userId);

      const updated = await Post.findByIdAndUpdate(
        post._id,
        {
          $set: {
            upvoteUserIds: [...new Set(nextUpvoteUserIds)],
            upvoteCount: [...new Set(nextUpvoteUserIds)].length,
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after' }
      ).lean();

      await notifyChatUpdatedCoalesced(app, course, session, {
        changeType: 'post-voted',
        postId: String(post._id),
        post: updated,
        currentQuestionNumber: post.isQuickPost ? currentQuestionNumber : null,
      });

      return {
        success: true,
        postId: String(post._id),
        viewerHasUpvoted: !!request.body.upvoted,
        upvoteCount: Number(updated?.upvoteCount || 0),
      };
    }
  );

  app.post(
    '/sessions/:id/chat/posts/:postId/comments',
    {
      preHandler: authenticate,
      rateLimit: { max: 40, timeWindow: '1 minute' },
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          properties: {
            body: { type: 'string' },
            bodyWysiwyg: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { session, course } = await loadSessionChatContext(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session chat is not available' });
      }

      const viewMode = getChatViewMode(request, isInstructorOrAdmin(course, request.user));
      const flags = getChatPermissionFlags({ session, course, request, viewMode });
      if (!flags.canWrite || !session.chatEnabled || !isRichTextChatEnabled(session)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Comments are not available' });
      }

      const post = await Post.findOne({
        _id: request.params.postId,
        scopeType: 'session',
        sessionId: String(session._id),
      }).lean();
      if (!post) {
        return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
      }
      if (post.dismissedAt && !flags.isInstructorView) {
        return reply.code(403).send({ error: 'Forbidden', message: 'This post was dismissed by the instructor' });
      }

      const bodyWysiwyg = normalizeAnswerValue(request.body?.bodyWysiwyg);
      const body = normalizeAnswerValue(request.body?.body || stripHtmlToPlainText(bodyWysiwyg));
      if (!body && !bodyWysiwyg) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Comment content is required' });
      }

      const comment = {
        _id: generateMeteorId(),
        authorId: String(request.user.userId),
        authorRole: getChatAuthorRole(course, request.user),
        body,
        bodyWysiwyg,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const updated = await Post.findByIdAndUpdate(
        post._id,
        {
          $push: { comments: comment },
          $set: { updatedAt: new Date() },
        },
        { returnDocument: 'after' }
      ).lean();

      await notifyChatUpdated(app, course, session, {
        changeType: 'comment-added',
        postId: String(post._id),
        post: updated,
      });

      return { success: true, postId: String(post._id), commentId: comment._id };
    }
  );

  app.patch(
    '/sessions/:id/chat/posts/:postId/dismiss',
    {
      preHandler: authenticate,
      rateLimit: { max: 40, timeWindow: '1 minute' },
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { session, course } = await loadSessionChatContext(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }
      if (session.status !== 'running') {
        return reply.code(403).send({ error: 'Forbidden', message: 'Posts can only be dismissed during a live session' });
      }

      const post = await Post.findOne({
        _id: request.params.postId,
        scopeType: 'session',
        sessionId: String(session._id),
      }).lean();
      if (!post) {
        return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
      }

      const updated = await Post.findByIdAndUpdate(
        post._id,
        {
          $set: {
            dismissedAt: post.dismissedAt || new Date(),
            dismissedBy: String(request.user.userId),
            updatedAt: new Date(),
          },
        },
        { returnDocument: 'after' }
      ).lean();

      await notifyChatUpdated(app, course, session, {
        changeType: 'post-dismissed',
        postId: String(post._id),
        post: updated,
      });

      return {
        success: true,
        postId: String(post._id),
        dismissed: !!updated?.dismissedAt,
      };
    }
  );

  app.delete(
    '/sessions/:id/chat/posts/:postId',
    {
      preHandler: authenticate,
      rateLimit: { max: 40, timeWindow: '1 minute' },
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { session, course } = await loadSessionChatContext(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session chat is not available' });
      }

      const viewMode = getChatViewMode(request, isInstructorOrAdmin(course, request.user));
      const flags = getChatPermissionFlags({ session, course, request, viewMode });
      if (!flags.canWrite && !flags.isInstructorView) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Post deletion is not available' });
      }

      const post = await Post.findOne({
        _id: request.params.postId,
        scopeType: 'session',
        sessionId: String(session._id),
      }).lean();
      if (!post) {
        return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
      }

      const ownsPost = String(post.authorId || '') === String(request.user.userId || '');
      if (!flags.isInstructorView && !ownsPost) {
        return reply.code(403).send({ error: 'Forbidden', message: 'You can only delete your own posts' });
      }
      if (post.isQuickPost && !flags.isInstructorView) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Quick posts cannot be deleted' });
      }

      await Post.deleteOne({ _id: post._id });
      await notifyChatUpdated(app, course, session, {
        changeType: 'post-deleted',
        postId: String(post._id),
        post: null,
      });

      return { success: true };
    }
  );

  app.delete(
    '/sessions/:id/chat/posts/:postId/comments/:commentId',
    {
      preHandler: authenticate,
      rateLimit: { max: 40, timeWindow: '1 minute' },
      config: { rateLimit: { max: 40, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { session, course } = await loadSessionChatContext(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!await hasSessionParticipantAccess(course, session, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Session chat is not available' });
      }

      const viewMode = getChatViewMode(request, isInstructorOrAdmin(course, request.user));
      const flags = getChatPermissionFlags({ session, course, request, viewMode });
      if (!flags.canWrite && !flags.isInstructorView) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Comment deletion is not available' });
      }

      const post = await Post.findOne({
        _id: request.params.postId,
        scopeType: 'session',
        sessionId: String(session._id),
      }).lean();
      if (!post) {
        return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
      }

      const comment = (post.comments || []).find(
        (entry) => String(entry?._id || '') === String(request.params.commentId || '')
      );
      if (!comment) {
        return reply.code(404).send({ error: 'Not Found', message: 'Comment not found' });
      }

      const ownsComment = String(comment.authorId || '') === String(request.user.userId || '');
      if (!flags.isInstructorView && !ownsComment) {
        return reply.code(403).send({ error: 'Forbidden', message: 'You can only delete your own comments' });
      }

      const updated = await Post.findByIdAndUpdate(
        post._id,
        {
          $pull: { comments: { _id: String(comment._id) } },
          $set: { updatedAt: new Date() },
        },
        { returnDocument: 'after' }
      ).lean();

      await notifyChatUpdated(app, course, session, {
        changeType: 'comment-deleted',
        postId: String(post._id),
        post: updated,
      });

      return { success: true, postId: String(post._id), commentId: String(comment._id) };
    }
  );

  // GET /sessions/:id/results - Get full session results (prof only) for review/CSV
  app.get(
    '/sessions/:id/results',
    {
      preHandler: authenticate,
      schema: {
        description: 'Instructor results and CSV data. Active named quizzes include submitted answers only. Active anonymous quizzes require four submissions and release fixed batches of four submissions and respondents per question/attempt, without identities or timestamps. Ended quizzes include saved unsubmitted answers; anonymous question/attempt groups still require at least four respondents.',
      },
      rateLimit: { max: 30, timeWindow: '1 minute' },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      let session = await Session.findById(request.params.id).lean();
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
      if (session.studentCreated) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const { session: normalizedSession, changed } = await maybeAutoCloseScheduledQuiz(session, { course });
      session = normalizedSession;
      if (changed) {
        notifyStatusChanged(app, course, session?._id || request.params.id, { status: 'done' });
      }
      const quizResultParticipantIds = getQuizResultsParticipantIds(session);
      const anonymousLiveQuiz = isAnonymousSession(session) && session.quiz && !session.practiceQuiz && session.status !== 'done';
      if (isAnonymousSession(session) && session.status !== 'done'
        && (!anonymousLiveQuiz || quizResultParticipantIds.length < MIN_ANONYMOUS_RESPONDENTS)) {
        return reply.code(409).send({
          error: 'Conflict',
          message: anonymousLiveQuiz
            ? 'Anonymous live review requires at least four submitted quizzes'
            : 'Anonymous results are available after the session ends',
        });
      }

      // Fetch questions in session order and normalize legacy fields for review.
      const questionIds = session.questions || [];
      const questions = questionIds.length > 0
        ? await Question.find({ _id: { $in: questionIds } }).lean()
        : [];
      const questionMap = new Map(
        questions.map((question) => [String(question._id), normalizeQuestionForReview(question)])
      );
      const orderedQuestions = questionIds
        .map((id) => questionMap.get(String(id)))
        .filter(Boolean)
        .map((question) => {
          if ((!isAnonymousSession(session) && !(session.quiz && !session.practiceQuiz)) || !question.sessionOptions) return question;
          const sessionOptions = { ...question.sessionOptions };
          delete sessionOptions.attemptStats;
          if (isAnonymousSession(session) || (session.quiz && !session.practiceQuiz)) {
            // Anonymous caches must not bypass per-attempt release checks.
            // Quiz chart snapshots can become stale on submission or ending;
            // regenerate on demand using the currently visible responses.
            delete sessionOptions.wordCloudData;
            delete sessionOptions.histogramData;
          }
          return { ...question, sessionOptions };
        });

      // Active quizzes expose submitted attempts only. Ended quizzes retain
      // every saved answer, including students who forgot to submit.
      let allResponses = questionIds.length > 0
        ? await Response.find({ questionId: { $in: questionIds }, ...getQuizResultsResponseFilter(session) }).lean()
        : [];
      const anonymousSession = isAnonymousSession(session);
      const joinedUserIds = new Set((session.joined || []).map((id) => String(id)).filter(Boolean));
      const courseStudentIds = new Set((course.students || []).map((id) => String(id)).filter(Boolean));
      let anonymousRespondentCount = 0;
      let responsesWithheld = false;
      if (anonymousSession) {
        const respondentIds = new Set();
        const respondentsByQuestion = new Map();
        allResponses.forEach((response) => {
          const respondentId = getResponseStudentId(response);
          if (!respondentId) return;
          respondentIds.add(respondentId);
          const questionId = String(response.questionId);
          if (!respondentsByQuestion.has(questionId)) respondentsByQuestion.set(questionId, new Map());
          const attempts = respondentsByQuestion.get(questionId);
          const attempt = Number(response.attempt) || 1;
          if (!attempts.has(attempt)) attempts.set(attempt, new Set());
          attempts.get(attempt).add(respondentId);
        });
        anonymousRespondentCount = respondentIds.size;
        const releasedByQuestion = new Map();
        orderedQuestions.forEach((question) => {
          const attempts = respondentsByQuestion.get(String(question._id)) || new Map();
          const attemptNumbers = new Set([
            ...attempts.keys(),
            ...(question.sessionOptions?.attempts || []).map((entry) => Number(entry.number)),
          ].filter((number) => Number.isInteger(number) && number > 0));
          if (!attemptNumbers.size) attemptNumbers.add(1);
          // Aggregate counts are safe below the threshold. Never include who
          // answered a withheld attempt, even as an empty respondent row.
          question.anonymousResponseAttempts = [...attemptNumbers].sort((a, b) => a - b).map((attempt) => {
            const respondents = attempts.get(attempt) || new Set();
            const respondentCount = respondents.size;
            // Question edits/legacy data can leave unequal answer counts even
            // among submitted quizzes. Batch each attempt independently too.
            const orderedRespondents = anonymousLiveQuiz
              ? quizResultParticipantIds.filter((id) => respondents.has(id))
              : [...respondents];
            const releasedCount = anonymousLiveQuiz
              ? respondentCount - (respondentCount % MIN_ANONYMOUS_RESPONDENTS)
              : respondentCount >= MIN_ANONYMOUS_RESPONDENTS ? respondentCount : 0;
            releasedByQuestion.set(`${question._id}:${attempt}`, new Set(orderedRespondents.slice(0, releasedCount)));
            const withheld = respondentCount > 0 && releasedCount === 0;
            responsesWithheld ||= releasedCount < respondentCount;
            return {
              attempt, respondentCount, responsesWithheld: withheld, minimumRespondents: MIN_ANONYMOUS_RESPONDENTS,
              ...(anonymousLiveQuiz ? { releasedRespondentCount: releasedCount } : {}),
            };
          });
        });
        // Filter before building rows or participation totals so sparse answers
        // cannot leak through derived per-respondent fields or exports.
        allResponses = allResponses.filter((response) => (
          releasedByQuestion.get(`${response.questionId}:${Number(response.attempt) || 1}`)?.has(getResponseStudentId(response))
        ));
      }

      const responsesByStudentQuestion = new Map();
      const responderUserIds = new Set();
      allResponses.forEach((response) => {
        const studentId = getResponseStudentId(response);
        if (!studentId) return;
        responderUserIds.add(studentId);

        const key = `${studentId}::${String(response.questionId)}`;
        if (!responsesByStudentQuestion.has(key)) {
          responsesByStudentQuestion.set(key, []);
        }
        responsesByStudentQuestion.get(key).push(response);
      });
      responsesByStudentQuestion.forEach((responses) => {
        responses.sort((a, b) => {
          const attemptDiff = (Number(a?.attempt) || 0) - (Number(b?.attempt) || 0);
          if (attemptDiff !== 0) return attemptDiff;
          const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
          return aTime - bTime;
        });
      });

      if (anonymousSession && responderUserIds.size === 0) {
        return {
          session: buildSessionForUser(session, request.user, { instructorView: true }),
          questions: orderedQuestions,
          studentResults: [],
          chatPosts: [],
          quizResultsRefreshAt: session.quiz && !session.practiceQuiz && session.status === 'visible'
            ? getLatestQuizWindowEndMs(session, getNormalizedQuizExtensions(session)) : null,
          anonymousSummary: {
            respondentCount: anonymousRespondentCount,
            joinedCount: joinedUserIds.size,
            enrolledCount: courseStudentIds.size,
            responsesWithheld,
            minimumRespondents: MIN_ANONYMOUS_RESPONDENTS,
          },
        };
      }
      // Anonymous results list respondents only, under stable generic labels.
      const respondentIndexById = anonymousSession
        ? buildAnonymousRespondentIndex([...responderUserIds])
        : null;
      const resultUserIds = anonymousSession
        ? [...respondentIndexById.keys()]
        : quizResultParticipantIds ?? [...new Set([
          ...courseStudentIds,
          ...joinedUserIds,
          ...responderUserIds,
        ])];

      const students = !anonymousSession && resultUserIds.length > 0
        ? await User.find({ _id: { $in: resultUserIds } })
          .select('_id profile emails email')
          .lean()
        : [];
      const studentMap = {};
      for (const student of students) {
        studentMap[String(student._id)] = student;
      }

      const latestJoinByStudentId = {};
      (session.joinRecords || []).forEach((record) => {
        const studentId = String(record?.userId || '');
        if (!studentId) return;
        const joinedAt = record?.joinedAt ? new Date(record.joinedAt) : null;
        if (!joinedAt) return;
        if (!latestJoinByStudentId[studentId] || joinedAt > latestJoinByStudentId[studentId]) {
          latestJoinByStudentId[studentId] = joinedAt;
        }
      });

      const questionsWithPoints = orderedQuestions.filter((q) => getParticipationQuestionPoints(q) > 0);
      const chatDataExists = !!session.chatEnabled || !!(await Post.exists({
        scopeType: 'session',
        sessionId: String(session._id),
      }));
      if (chatDataExists) {
        await ensureSessionQuickPosts(session);
      }

      let chatPosts = [];
      if (chatDataExists) {
        const posts = await Post.find({
          scopeType: 'session',
          sessionId: String(session._id),
        })
          .select('authorId authorRole body bodyWysiwyg isQuickPost quickPostQuestionNumber upvoteUserIds upvoteCount comments dismissedAt createdAt updatedAt')
          .lean();
        const visiblePosts = posts
          .filter((post) => !(post?.isQuickPost && Number(post?.upvoteCount || 0) <= 0))
          .sort(compareChatPosts);
        const authorMetadataMap = await buildChatAuthorMetadataMap(visiblePosts, { includeAllAuthors: !anonymousSession });
        chatPosts = visiblePosts.map((post) => serializeChatPost(post, {
          includeNames: !anonymousSession,
          includeDismissed: true,
          viewerUserId: String(request.user.userId || ''),
          authorMetadataMap,
        }));
      }

      // Build per-student results (include all course students plus extra responders/joined users).
      const studentResults = resultUserIds.map((studentId) => {
        const student = studentMap[String(studentId)];
        const firstname = student?.profile?.firstname || '';
        const lastname = student?.profile?.lastname || '';
        const email = student?.emails?.[0]?.address || student?.email || '';
        const anonymousIndex = anonymousSession ? respondentIndexById.get(String(studentId)) : null;
        const respondentKey = anonymousSession ? getAnonymousRespondentKey(anonymousIndex) : '';

        const questionResults = orderedQuestions.map((question) => {
          const key = `${studentId}::${String(question._id)}`;
          const responses = responsesByStudentQuestion.get(key) || [];
          return {
            questionId: question._id,
            responses: anonymousSession
              ? responses.map((response) => sanitizeAnonymousReviewResponse(response, respondentKey))
              : responses,
          };
        });

        const answeredCount = questionsWithPoints.filter((question) => {
          const key = `${studentId}::${String(question._id)}`;
          const responses = responsesByStudentQuestion.get(key);
          return Array.isArray(responses) && responses.length > 0;
        }).length;

        let participation = 0;
        if (answeredCount > 0) {
          participation = questionsWithPoints.length > 0
            ? Math.round((1000 * answeredCount) / questionsWithPoints.length) / 10
            : 100;
        }
        if (questionsWithPoints.length === 0) {
          participation = 100;
        }

        if (anonymousSession) {
          return {
            studentId: respondentKey,
            anonymousIndex,
            firstname: '',
            lastname: '',
            email: '',
            profileImage: '',
            profileThumbnail: '',
            inSession: true,
            joinedAt: null,
            participation: responsesWithheld ? null : participation,
            questionResults,
          };
        }

        return {
          studentId,
          guest: !!session.activityEverShared && (!courseStudentIds.has(String(studentId))),
          ...participantRoles({ ...student, _id: studentId }, course, !courseStudentIds.has(String(studentId))),
          firstname,
          lastname,
          email,
          profileImage: student?.profile?.profileImage || '',
          profileThumbnail: student?.profile?.profileThumbnail || '',
          inSession: joinedUserIds.has(String(studentId)),
          joinedAt: latestJoinByStudentId[String(studentId)] || null,
          participation,
          questionResults,
        };
      }).sort((a, b) => {
        if (anonymousSession) return a.anonymousIndex - b.anonymousIndex;
        const lastCmp = normalizeAnswerValue(a.lastname).localeCompare(normalizeAnswerValue(b.lastname));
        if (lastCmp !== 0) return lastCmp;
        const firstCmp = normalizeAnswerValue(a.firstname).localeCompare(normalizeAnswerValue(b.firstname));
        if (firstCmp !== 0) return firstCmp;
        return normalizeAnswerValue(a.email).localeCompare(normalizeAnswerValue(b.email));
      });

      return {
        session: buildSessionForUser(session, request.user, { instructorView: true }),
        questions: orderedQuestions,
        studentResults,
        chatPosts,
        // Date-controlled quizzes have no background status broadcast. Let the
        // review page refresh once at the final deadline, without polling.
        quizResultsRefreshAt: session.quiz && !session.practiceQuiz && session.status === 'visible'
          ? getLatestQuizWindowEndMs(session, getNormalizedQuizExtensions(session)) : null,
        ...(anonymousSession
          ? {
            anonymousSummary: {
              respondentCount: anonymousRespondentCount,
              responsesWithheld,
              minimumRespondents: MIN_ANONYMOUS_RESPONDENTS,
              joinedCount: joinedUserIds.size,
              enrolledCount: courseStudentIds.size,
            },
          }
          : {}),
      };
    }
  );
}
