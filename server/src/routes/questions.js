import { getQuizResultsParticipantIds, getQuizResultsResponseFilter } from '../utils/quizResults.js';
import Question from '../models/Question.js';
import Session from '../models/Session.js';
import Course from '../models/Course.js';
import Grade from '../models/Grade.js';
import Response from '../models/Response.js';
import { copyQuestionToSession } from '../services/questionCopy.js';
import {
  getNormalizedTagValue,
  normalizeTags,
  sanitizeExportedQuestion,
  sanitizeImportedQuestion,
} from '../services/questionImportExport.js';
import { isQuestionResponseCollectionEnabled, normalizeQuestionType } from '../services/grading.js';
import { computeWordFrequencies } from '../utils/wordFrequency.js';
import { computeHistogramData } from '../utils/histogram.js';
import { buildSessionResponseTracking } from '../utils/sessionResponseTracking.js';
import { anonymousResponsesReleasable } from '../services/anonymousResponseRelease.js';
import { isCourseInstructorOrAdmin as isInstructorOrAdmin } from '../utils/courseAccess.js';
import { inheritSessionTagsForQuestions, mergeSessionQuestionTags } from '../services/sessionQuestionTags.js';

const createQuestionSchema = {
  body: {
    type: 'object',
    required: ['type'],
    properties: {
      // Canonical mapping: MC=0 (single correct), TF=1, SA=2, MS=3 (multi-correct), NU=4, Slide=6.
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
      sessionId: { type: 'string' },
      courseId: { type: 'string' },
      solution: { type: 'string' },
      solution_plainText: { type: 'string' },
      public: { type: 'boolean' },
      publicOnQlicker: { type: 'boolean' },
      publicOnQlickerForStudents: { type: 'boolean' },
      sessionOptions: {
        type: 'object',
        properties: {
          hidden: { type: 'boolean' },
          stats: { type: 'boolean' },
          correct: { type: 'boolean' },
          responseListVisible: { type: 'boolean' },
          points: { type: 'number', minimum: 0 },
          maxAttempts: { type: 'number' },
          attemptWeights: { type: 'array', items: { type: 'number' } },
          attempts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                number: { type: 'number' },
                closed: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
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
      imagePath: { type: 'string' },
    },
    additionalProperties: false,
  },
};

const updateQuestionSchema = {
  body: {
    type: 'object',
    properties: {
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
      // Canonical mapping: MC=0 (single correct), TF=1, SA=2, MS=3 (multi-correct), NU=4, Slide=6.
      type: { type: 'integer', minimum: 0, maximum: 6 },
      toleranceNumerical: { type: 'number' },
      correctNumerical: { type: 'number' },
      solution: { type: 'string' },
      solution_plainText: { type: 'string' },
      public: { type: 'boolean' },
      publicOnQlicker: { type: 'boolean' },
      publicOnQlickerForStudents: { type: 'boolean' },
      approved: { type: 'boolean' },
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
      imagePath: { type: 'string' },
      sessionOptions: {
        type: 'object',
        properties: {
          hidden: { type: 'boolean' },
          stats: { type: 'boolean' },
          correct: { type: 'boolean' },
          responseListVisible: { type: 'boolean' },
          points: { type: 'number', minimum: 0 },
          maxAttempts: { type: 'number' },
          attemptWeights: { type: 'array', items: { type: 'number' } },
          attempts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                number: { type: 'number' },
                closed: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
};

const copyToSessionSchema = {
  body: {
    type: 'object',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
};

const addQuestionToSessionSchema = {
  body: {
    type: 'object',
    required: ['questionId'],
    properties: {
      questionId: { type: 'string', minLength: 1 },
    },
    additionalProperties: false,
  },
};

const listCourseQuestionsSchema = {
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      type: { type: 'integer', minimum: 0, maximum: 6 },
      tags: { type: 'string' },
      sessionIds: { type: 'string' },
      content: { type: 'string' },
      approved: { type: 'boolean' },
      idsOnly: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const courseQuestionTagsSchema = {
  querystring: {
    type: 'object',
    properties: {
      q: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  },
};

const bulkCopyQuestionsSchema = {
  body: {
    type: 'object',
    required: ['questionIds', 'targetCourseId'],
    properties: {
      questionIds: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
      targetCourseId: { type: 'string', minLength: 1 },
      targetSessionId: { type: 'string' },
    },
    additionalProperties: false,
  },
};

const bulkDeleteQuestionsSchema = {
  body: {
    type: 'object',
    required: ['questionIds'],
    properties: {
      questionIds: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
    },
    additionalProperties: false,
  },
};

const bulkVisibilityQuestionsSchema = {
  body: {
    type: 'object',
    required: ['questionIds'],
    properties: {
      questionIds: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
      public: { type: 'boolean' },
      publicOnQlicker: { type: 'boolean' },
      publicOnQlickerForStudents: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const exportQuestionsSchema = {
  body: {
    type: 'object',
    required: ['questionIds'],
    properties: {
      questionIds: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
    },
    additionalProperties: false,
  },
};

const importQuestionsSchema = {
  body: {
    type: 'object',
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
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
            publicOnQlicker: { type: 'boolean' },
            publicOnQlickerForStudents: { type: 'boolean' },
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
            creator: { type: 'string' },
            originalQuestion: { type: 'string' },
            originalCourse: { type: 'string' },
            imagePath: { type: 'string' },
          },
          additionalProperties: true,
        },
      },
      sessionId: { type: 'string' },
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
    },
    additionalProperties: false,
  },
};

const reorderQuestionsSchema = {
  body: {
    type: 'object',
    required: ['questions'],
    properties: {
      questions: { type: 'array', items: { type: 'string' }, uniqueItems: true },
    },
    additionalProperties: false,
  },
};

const setSessionQuestionPointsSchema = {
  body: {
    type: 'object',
    required: ['points'],
    properties: {
      points: { type: 'number', minimum: 0 },
    },
    additionalProperties: false,
  },
};

const attemptStatusSchema = {
  body: {
    type: 'object',
    required: ['attemptNumber', 'closed'],
    properties: {
      attemptNumber: { type: 'integer', minimum: 1 },
      closed: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const visibilitySchema = {
  body: {
    type: 'object',
    required: ['hidden'],
    properties: {
      hidden: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const statsSchema = {
  body: {
    type: 'object',
    required: ['stats'],
    properties: {
      stats: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const correctSchema = {
  body: {
    type: 'object',
    required: ['correct'],
    properties: {
      correct: { type: 'boolean' },
    },
    additionalProperties: false,
  },
};

const QUESTION_TYPE_MULTIPLE_CHOICE = 0;

function parseDelimitedValues(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseDelimitedValues(entry));
  }
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toDateOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function isQuestionOpenInLinkedQuiz(session, requestingUserId) {
  if (!session || (!session.quiz && !session.practiceQuiz)) return false;
  if (session.status === 'running') return true;
  if (session.status !== 'visible') return false;

  const nowMs = Date.now();
  const quizStart = toDateOrNull(session.quizStart);
  const quizEnd = toDateOrNull(session.quizEnd);
  const baseWindowActive = quizStart && quizEnd
    ? nowMs >= quizStart.getTime() && nowMs <= quizEnd.getTime()
    : false;
  if (baseWindowActive) return true;

  const userExtension = (session.quizExtensions || []).find((extension) => String(extension?.userId || '') === String(requestingUserId));
  const extensionStart = toDateOrNull(userExtension?.quizStart);
  const extensionEnd = toDateOrNull(userExtension?.quizEnd);
  return extensionStart && extensionEnd
    ? nowMs >= extensionStart.getTime() && nowMs <= extensionEnd.getTime()
    : false;
}

async function createLibraryQuestionCopy({
  sourceQuestion,
  targetCourseId,
  userId,
  forceStudentCopy = false,
}) {
  const sourceObject = sourceQuestion.toObject ? sourceQuestion.toObject() : sourceQuestion;
  const copiedPayload = { ...sourceObject };
  delete copiedPayload._id;
  delete copiedPayload.__v;
  delete copiedPayload.updatedAt;
  delete copiedPayload.sessionOptions;

  return Question.create({
    ...copiedPayload,
    creator: String(sourceObject.creator || userId),
    owner: userId,
    sessionId: '',
    courseId: String(targetCourseId || sourceObject.courseId || ''),
    originalQuestion: String(sourceObject.originalQuestion || sourceObject._id || ''),
    originalCourse: String(sourceObject.originalCourse || sourceObject.courseId || targetCourseId || ''),
    createdAt: new Date(),
    lastEditedAt: new Date(),
    public: forceStudentCopy ? false : !!sourceObject.public,
    publicOnQlicker: forceStudentCopy ? false : !!sourceObject.publicOnQlicker,
    publicOnQlickerForStudents: forceStudentCopy ? false : !!sourceObject.publicOnQlickerForStudents,
    approved: forceStudentCopy ? false : true,
    studentCreated: forceStudentCopy ? true : !!sourceObject.studentCreated,
    studentCopyOfPublic: forceStudentCopy ? true : !!sourceObject.studentCopyOfPublic,
  });
}

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

async function buildQuestionLibraryDetails(questionDocs = [], courseId = '') {
  const questionIds = [...new Set(
    (questionDocs || []).map((question) => String(question?._id || '').trim()).filter(Boolean)
  )];

  if (questionIds.length === 0) {
    return [];
  }

  const [responseStats, linkedSessions, directSessionDocs] = await Promise.all([
    Response.aggregate([
      { $match: { questionId: { $in: questionIds } } },
      { $group: { _id: '$questionId', count: { $sum: 1 } } },
    ]),
    Session.find({ courseId, questions: { $in: questionIds } })
      .select('_id name questions')
      .lean(),
    Session.find({
      courseId,
      _id: {
        $in: [...new Set(
          questionDocs
            .map((question) => String(question?.sessionId || '').trim())
            .filter(Boolean)
        )],
      },
    }).select('_id name').lean(),
  ]);

  const responseCountByQuestionId = new Map(
    responseStats.map((entry) => [String(entry?._id || ''), Number(entry?.count || 0)])
  );
  const sessionsByQuestionId = new Map();
  const seenSessionLinks = new Set();

  const addLinkedSession = (questionId, session) => {
    const normalizedQuestionId = String(questionId || '').trim();
    const normalizedSessionId = String(session?._id || '').trim();
    if (!normalizedQuestionId || !normalizedSessionId) return;

    const dedupeKey = `${normalizedQuestionId}:${normalizedSessionId}`;
    if (seenSessionLinks.has(dedupeKey)) return;
    seenSessionLinks.add(dedupeKey);

    if (!sessionsByQuestionId.has(normalizedQuestionId)) {
      sessionsByQuestionId.set(normalizedQuestionId, []);
    }
    sessionsByQuestionId.get(normalizedQuestionId).push({
      _id: normalizedSessionId,
      name: String(session?.name || '').trim(),
    });
  };

  linkedSessions.forEach((session) => {
    (session.questions || []).forEach((questionId) => {
      addLinkedSession(questionId, session);
    });
  });

  const directSessionMap = new Map(
    directSessionDocs.map((session) => [String(session._id), session])
  );

  return questionDocs.map((question) => {
    const questionId = String(question?._id || '').trim();
    const directSession = directSessionMap.get(String(question?.sessionId || '').trim());
    if (directSession) addLinkedSession(questionId, directSession);

    return {
      ...question,
      hasResponses: (responseCountByQuestionId.get(questionId) || 0) > 0,
      responseCount: responseCountByQuestionId.get(questionId) || 0,
      linkedSessions: sessionsByQuestionId.get(questionId) || [],
    };
  });
}

function sendToCourseMembers(app, course, event, payload) {
  if (typeof app.wsSendToUsers !== 'function') return;
  if (!course) return;
  const memberIds = [...new Set([
    ...(course.instructors || []),
    ...(course.students || []),
  ].map((userId) => String(userId)).filter(Boolean))];
  if (memberIds.length === 0) return;
  app.wsSendToUsers(memberIds, event, payload);
}

function sendToInstructors(app, course, event, payload) {
  if (typeof app.wsSendToUsers !== 'function') return;
  if (!course) return;
  const instructorIds = [...new Set(
    (course.instructors || []).map((userId) => String(userId)).filter(Boolean)
  )];
  if (instructorIds.length === 0) return;
  app.wsSendToUsers(instructorIds, event, payload);
}

function sendToStudents(app, course, event, payload) {
  if (typeof app.wsSendToUsers !== 'function') return;
  if (!course) return;
  const studentIds = [...new Set(
    (course.students || []).map((userId) => String(userId)).filter(Boolean)
  )];
  if (studentIds.length === 0) return;
  app.wsSendToUsers(studentIds, event, payload);
}

function toQuestionPayload(question) {
  if (!question) return null;
  return typeof question.toObject === 'function'
    ? question.toObject()
    : { ...question };
}

function stripAnswerRevealFields(questionPayload, { revealCorrectAnswers = false } = {}) {
  if (!questionPayload) return null;
  const sanitized = { ...questionPayload };
  if (!revealCorrectAnswers) {
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
    delete sanitized.solutionText;
    delete sanitized.solutionPlainText;
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

function buildStudentQuestionUpdate(question) {
  const questionPayload = toQuestionPayload(question);
  if (!questionPayload) {
    return {
      question: null,
      questionHidden: false,
      showStats: false,
      showCorrect: false,
    };
  }

  const questionHidden = !!questionPayload?.sessionOptions?.hidden;
  const collectsResponses = isQuestionResponseCollectionEnabled(questionPayload);
  const showStats = collectsResponses ? !!questionPayload?.sessionOptions?.stats : false;
  const showCorrect = collectsResponses ? !!questionPayload?.sessionOptions?.correct : false;

  return {
    question: questionHidden
      ? null
      : stripAnswerRevealFields(questionPayload, { revealCorrectAnswers: showCorrect }),
    questionHidden,
    showStats,
    showCorrect,
  };
}

async function getLinkedSessionsForQuestion(question) {
  const linkedSessions = [];
  const seenSessionIds = new Set();

  const addSession = (session) => {
    const sessionId = String(session?._id || '').trim();
    if (!sessionId || seenSessionIds.has(sessionId)) return;
    seenSessionIds.add(sessionId);
    linkedSessions.push({
      _id: sessionId,
      courseId: String(session?.courseId || '').trim(),
      currentQuestion: String(session?.currentQuestion || '').trim(),
    });
  };

  if (question?.sessionId) {
    const session = await Session.findById(question.sessionId)
      .select('_id courseId currentQuestion')
      .lean();
    if (session) addSession(session);
  }

  const normalizedQuestionId = String(question?._id || '').trim();
  if (normalizedQuestionId) {
    const sessions = await Session.find({ questions: normalizedQuestionId })
      .select('_id courseId currentQuestion')
      .lean();
    sessions.forEach(addSession);
  }

  return linkedSessions;
}

async function userCanManageQuestion(question, user) {
  if (!question || !user) return false;
  const roles = user.roles || [];
  if (roles.includes('admin')) return true;
  if (userOwnsQuestion(question, user)) return true;

  const candidateCourseIds = [
    question.courseId,
  ]
    .map((courseId) => String(courseId || '').trim())
    .filter(Boolean);

  const linkedSessionCourseIds = (await getLinkedSessionsForQuestion(question))
    .map((session) => String(session?.courseId || '').trim())
    .filter(Boolean);

  const allCourseIds = [...new Set([...candidateCourseIds, ...linkedSessionCourseIds])];
  if (allCourseIds.length === 0) return false;

  const courses = await Course.find({ _id: { $in: allCourseIds } })
    .select('_id instructors')
    .lean();

  return courses.some((course) => (course.instructors || []).includes(user.userId));
}

function isStudentAccount(user) {
  const roles = user?.roles || [];
  return roles.includes('student') && !roles.includes('professor') && !roles.includes('admin');
}

function shouldTreatUserAsStudentForCourse(user, course) {
  if (!course) return isStudentAccount(user);
  return (course.students || []).some((studentId) => String(studentId) === String(user?.userId || ''))
    && !isInstructorOrAdmin(course, user);
}

function isStudentPracticeAccessDisabled(course, user) {
  if (!course) return false;
  if (!(course.students || []).includes(user.userId)) return false;
  if (isInstructorOrAdmin(course, user)) return false;
  return !course.allowStudentQuestions;
}

function userOwnsQuestion(question, user) {
  if (!question || !user) return false;
  const ownerId = String(question.owner || '').trim();
  const creatorId = String(question.creator || '').trim();
  const userId = String(user.userId || '').trim();
  if (!userId) return false;
  if (isStudentAccount(user)) {
    return ownerId === userId;
  }
  return ownerId === userId || creatorId === userId;
}

function isQuestionVisibleOutsideCourse(question, user) {
  if (!question?.publicOnQlicker) return false;
  if (!isStudentAccount(user)) return true;
  return !!question?.publicOnQlickerForStudents;
}

function getAllowedCourseTagValues(course) {
  const values = new Set();
  (course?.tags || []).forEach((tag) => {
    const normalized = getNormalizedTagValue(tag);
    if (normalized) values.add(normalized);
  });
  return values;
}

function hasDisallowedCourseTags(tags = [], allowedTagValues = new Set()) {
  return normalizeTags(tags).some((tag) => !allowedTagValues.has(getNormalizedTagValue(tag)));
}

function hasNewDisallowedCourseTagsForUpdate(nextTags = [], currentTags = [], allowedTagValues = new Set()) {
  const currentLegacyValues = new Set(
    [...new Set(
      normalizeTags(currentTags)
        .map((tag) => getNormalizedTagValue(tag))
        .filter(Boolean)
    )].filter((value) => !allowedTagValues.has(value))
  );

  return normalizeTags(nextTags).some((tag) => {
    const normalizedValue = getNormalizedTagValue(tag);
    if (!normalizedValue) return false;
    if (allowedTagValues.has(normalizedValue)) return false;
    return !currentLegacyValues.has(normalizedValue);
  });
}

function courseTopicValidationMessage(label = 'Questions') {
  return `${label} can only use the course topics`;
}

export async function userCanViewQuestion(question, user) {
  if (!question || !user) return false;
  if (await userCanManageQuestion(question, user)) return true;
  if (userOwnsQuestion(question, user)) return true;
  if (isQuestionVisibleOutsideCourse(question, user)) return true;

  const linkedSessions = await getLinkedSessionsForQuestion(question);
  const normalizedCourseIds = [...new Set([
    String(question.courseId || '').trim(),
    ...linkedSessions.map((session) => String(session?.courseId || '').trim()),
  ].filter(Boolean))];
  const courses = normalizedCourseIds.length > 0
    ? await Course.find({ _id: { $in: normalizedCourseIds } }).lean()
    : [];
  const courseById = new Map(courses.map((course) => [String(course._id), course]));
  const isMemberOfLinkedCourse = normalizedCourseIds.some((courseId) => {
    const course = courseById.get(courseId);
    if (!course) return false;
    return (course.students || []).includes(user.userId) || (course.instructors || []).includes(user.userId);
  });

  if (question.public && isMemberOfLinkedCourse) return true;

  const memberSessionIds = linkedSessions
    .filter((session) => {
      const course = courseById.get(String(session?.courseId || '').trim());
      if (!course) return false;
      return (course.students || []).includes(user.userId) || (course.instructors || []).includes(user.userId);
    })
    .map((session) => session._id);

  if (memberSessionIds.length > 0) {
    const fullSessions = await Session.find({ _id: { $in: memberSessionIds } })
      .select('_id reviewable status quiz practiceQuiz quizStart quizEnd quizExtensions joined currentQuestion questions')
      .lean();
    for (const fullSession of fullSessions) {
      if (fullSession.reviewable) return true;
      if (isQuestionOpenInLinkedQuiz(fullSession, user.userId)) return true;
    }
  }

  return false;
}

async function notifyLinkedSessionQuestionUpdated(app, question) {
  const linkedSessions = await getLinkedSessionsForQuestion(question);
  if (linkedSessions.length === 0) return;

  const courseIds = [...new Set(
    linkedSessions
      .map((session) => String(session.courseId || '').trim())
      .filter(Boolean)
  )];
  if (courseIds.length === 0) return;

  const courses = await Course.find({ _id: { $in: courseIds } }).lean();
  const courseById = new Map(
    courses.map((course) => [String(course._id), course])
  );
  const questionId = String(question?._id || '').trim();
  const instructorQuestionPayload = toQuestionPayload(question);
  const studentQuestionUpdate = buildStudentQuestionUpdate(question);

  linkedSessions.forEach((session) => {
    const course = courseById.get(String(session.courseId || ''));
    if (!course) return;

    const payload = {
      courseId: String(course._id),
      sessionId: String(session._id),
      questionId,
    };
    const includeQuestionPayload = String(session.currentQuestion || '') === questionId;

    sendToInstructors(
      app,
      course,
      'session:question-updated',
      includeQuestionPayload
        ? { ...payload, question: instructorQuestionPayload, audience: { ...payload, ...studentQuestionUpdate } }
        : payload
    );
    sendToStudents(
      app,
      course,
      'session:question-updated',
      includeQuestionPayload
        ? { ...payload, ...studentQuestionUpdate }
        : payload
    );
  });
}

export default async function questionRoutes(app) {
  const { authenticate, requireRole } = app;

  // GET /courses/:courseId/questions - List course question library entries
  app.get(
    '/courses/:courseId/questions',
    {
      preHandler: authenticate,
      schema: listCourseQuestionsSchema,
      rateLimit: { max: 60, timeWindow: '1 minute' },
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const course = await Course.findById(request.params.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      const isInstructor = isInstructorOrAdmin(course, request.user);
      const isStudentMember = !isInstructor && (course.students || []).includes(request.user.userId);
      if (!isInstructor && !isStudentMember) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }
      if (isStudentPracticeAccessDisabled(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Student questions are disabled for this course' });
      }

      const page = Math.max(Number(request.query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(request.query.limit) || 10, 1), 100);
      const content = String(request.query.content || '').trim();
      const tagFilters = parseDelimitedValues(request.query.tags);
      const sessionIds = parseDelimitedValues(request.query.sessionIds);
      const idsOnly = !!request.query.idsOnly;

      const query = { courseId: String(course._id) };
      if (request.query.type !== undefined) {
        query.type = Number(request.query.type);
      }
      if (request.query.approved !== undefined) {
        query.approved = !!request.query.approved;
      }
      if (tagFilters.length > 0) {
        query['tags.value'] = { $all: tagFilters };
      }
      if (content) {
        query.$text = { $search: content };
      }
      if (sessionIds.length > 0) {
        const selectedSessions = await Session.find({
          _id: { $in: sessionIds },
          courseId: String(course._id),
        }).select('questions').lean();

        const sessionQuestionIds = [...new Set(
          selectedSessions.flatMap((session) => (session.questions || []).map((questionId) => String(questionId)))
        )];
        if (sessionQuestionIds.length === 0) {
          query.sessionId = { $in: sessionIds };
        } else {
          query.$or = [
            { _id: { $in: sessionQuestionIds } },
            { sessionId: { $in: sessionIds } },
          ];
        }
      }

      const sort = content
        ? { score: { $meta: 'textScore' }, createdAt: -1, _id: 1 }
        : { createdAt: -1, _id: 1 };

      let total;
      let questionDocs;
      let questionTypes;

      if (isInstructor) {
        if (idsOnly) {
          const questionIds = (await Question.find(query)
            .sort(sort)
            .select('_id')
            .lean())
            .map((question) => String(question._id));
          return {
            questionIds,
            total: questionIds.length,
          };
        }

        [total, questionDocs, questionTypes] = await Promise.all([
          Question.countDocuments(query),
          Question.find(query)
            .sort(sort)
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
          Question.distinct('type', { courseId: String(course._id) }),
        ]);
      } else {
        // Student path — build a DB-level visibility query so MongoDB only
        // returns questions the student is allowed to see.  This avoids
        // loading invisible questions into server memory and enables true
        // DB-level pagination (skip/limit).
        const courseIdStr = String(course._id);
        const userId = request.user.userId;

        // Pre-compute session-based visibility: find sessions in this course
        // that are reviewable or have an active quiz window for this student.
        const candidateSessions = await Session.find({
          courseId: courseIdStr,
          $or: [
            { reviewable: true },
            { status: 'running', $or: [{ quiz: true }, { practiceQuiz: true }] },
            { status: 'visible', $or: [{ quiz: true }, { practiceQuiz: true }] },
          ],
        }).select('_id questions reviewable status quiz practiceQuiz quizStart quizEnd quizExtensions').lean();

        const sessionVisibleQuestionIds = new Set();
        const eligibleSessionIds = [];
        for (const session of candidateSessions) {
          if (session.reviewable || isQuestionOpenInLinkedQuiz(session, userId)) {
            eligibleSessionIds.push(String(session._id));
            for (const qId of (session.questions || [])) {
              sessionVisibleQuestionIds.add(String(qId));
            }
          }
        }

        // Build the $or conditions expressing every way a student can see a question.
        const visibilityConditions = [
          { owner: userId },
          { publicOnQlicker: true, publicOnQlickerForStudents: true },
          { public: true },
        ];
        if (sessionVisibleQuestionIds.size > 0) {
          visibilityConditions.push({ _id: { $in: [...sessionVisibleQuestionIds] } });
        }
        if (eligibleSessionIds.length > 0) {
          visibilityConditions.push({ sessionId: { $in: eligibleSessionIds } });
        }

        // Combine user-supplied filters with visibility.
        const studentQuery = { $and: [query, { $or: visibilityConditions }] };

        if (idsOnly) {
          const questionIds = (await Question.find(studentQuery)
            .sort(sort)
            .select('_id')
            .lean())
            .map((question) => String(question._id));
          return {
            questionIds,
            total: questionIds.length,
          };
        }

        [total, questionDocs, questionTypes] = await Promise.all([
          Question.countDocuments(studentQuery),
          Question.find(studentQuery)
            .sort(sort)
            .skip((page - 1) * limit)
            .limit(limit)
            .lean(),
          Question.distinct('type', studentQuery),
        ]);
      }

      let questions = await buildQuestionLibraryDetails(questionDocs || [], String(course._id));
      if (!isInstructor) {
        questions = questions.map((question) => (
          userOwnsQuestion(question, request.user)
            ? question
            : stripAnswerRevealFields(question, { revealCorrectAnswers: false })
        ));
      }

      return {
        questions,
        total,
        page,
        limit,
        questionTypes: questionTypes
          .map((type) => Number(type))
          .filter((type) => Number.isInteger(type))
          .sort((a, b) => a - b),
      };
    }
  );

  // GET /courses/:courseId/question-tags - Autocomplete tag suggestions for question library filters
  app.get(
    '/courses/:courseId/question-tags',
    {
      preHandler: authenticate,
      schema: courseQuestionTagsSchema,
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const course = await Course.findById(request.params.courseId).lean();
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      const isInstructor = isInstructorOrAdmin(course, request.user);
      const isStudentMember = !isInstructor && (course.students || []).includes(request.user.userId);
      if (!isInstructor && !isStudentMember) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }
      if (isStudentPracticeAccessDisabled(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Student questions are disabled for this course' });
      }

      const search = String(request.query.q || '').trim().toLowerCase();
      const limit = Math.min(Math.max(Number(request.query.limit) || 20, 1), 100);
      const tagMap = new Map();
      const addTag = (tag) => {
        const value = String(tag?.value || tag?.label || '').trim();
        const label = String(tag?.label || tag?.value || '').trim();
        if (!value || !label) return;
        const matchesSearch = !search
          || value.toLowerCase().includes(search)
          || label.toLowerCase().includes(search);
        if (!matchesSearch) return;
        const key = value.toLowerCase();
        if (!tagMap.has(key)) {
          tagMap.set(key, { value, label });
        }
      };

      (course.tags || []).forEach(addTag);

      const tags = [...tagMap.values()]
        .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value))
        .slice(0, limit);
      return {
        tags,
      };
    }
  );

  // POST /questions - Create a question
  app.post(
    '/questions',
    {
      preHandler: authenticate,
      schema: createQuestionSchema,
      rateLimit: { max: 30, timeWindow: '1 minute' },
    },
    async (request, reply) => {
      const userId = request.user.userId;
      const {
        type, content, plainText, options, toleranceNumerical, correctNumerical,
        sessionId, courseId, solution, solution_plainText, sessionOptions, tags, imagePath,
      } = request.body;

      const createValidationError = multipleChoiceValidationError(type, options);
      if (createValidationError) {
        return reply.code(400).send(createValidationError);
      }

      const normalizedCourseId = String(courseId || '').trim();
      const normalizedSessionId = String(sessionId || '').trim();
      const roles = request.user.roles || [];
      let course = null;
      let targetSession = null;
      if (normalizedSessionId) {
        targetSession = await Session.findById(normalizedSessionId).lean();
        if (!targetSession && normalizedCourseId) {
          return reply.code(404).send({ error: 'Not Found', message: 'Session not found in this course' });
        }
        if (targetSession && normalizedCourseId && String(targetSession.courseId) !== normalizedCourseId) {
          return reply.code(404).send({ error: 'Not Found', message: 'Session not found in this course' });
        }
      }
      if (normalizedCourseId) {
        course = await Course.findById(normalizedCourseId).lean();
        if (!course) {
          return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
        }
      }
      const canManageCourseAsInstructor = !!course && isInstructorOrAdmin(course, request.user);
      const isStudent = shouldTreatUserAsStudentForCourse(request.user, course);

      if (!isStudent && !canManageCourseAsInstructor && !roles.includes('professor') && !roles.includes('admin')) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      if (isStudent) {
        if (!course || !(course.students || []).includes(userId)) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
        }
        if (!course.allowStudentQuestions) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Student questions are disabled for this course' });
        }
        if (normalizedSessionId) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Student library questions cannot be attached to a session' });
        }

        const allowedTagValues = getAllowedCourseTagValues(course);
        if (hasDisallowedCourseTags(tags || [], allowedTagValues)) {
          return reply.code(400).send({ error: 'Bad Request', message: courseTopicValidationMessage('Questions') });
        }
      } else if (course && !isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      } else if (course) {
        const allowedTagValues = getAllowedCourseTagValues(course);
        if (hasDisallowedCourseTags(tags || [], allowedTagValues)) {
          return reply.code(400).send({ error: 'Bad Request', message: courseTopicValidationMessage('Questions') });
        }
      }

      const questionData = {
        type,
        content: content || '',
        plainText: plainText || '',
        options: options || [],
        creator: userId,
        owner: userId,
        sessionId: isStudent ? '' : normalizedSessionId,
        courseId: normalizedCourseId,
        originalCourse: normalizedCourseId,
        solution: solution || '',
        solution_plainText: solution_plainText || '',
        sessionOptions,
        public: isStudent ? false : (request.body.public || request.body.publicOnQlicker || false),
        publicOnQlicker: isStudent ? false : (request.body.publicOnQlicker || false),
        publicOnQlickerForStudents: isStudent ? false : (request.body.publicOnQlicker ? !!request.body.publicOnQlickerForStudents : false),
        tags: mergeSessionQuestionTags(tags || [], targetSession?.tags || []),
        imagePath: imagePath || '',
        approved: !isStudent,
        studentCreated: isStudent,
      };

      if (toleranceNumerical !== undefined) questionData.toleranceNumerical = toleranceNumerical;
      if (correctNumerical !== undefined) questionData.correctNumerical = correctNumerical;

      const question = await Question.create(questionData);

      return reply.code(201).send({ question: question.toObject() });
    }
  );

  // GET /questions/:id - Get a single question
  app.get(
    '/questions/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const question = await Question.findById(request.params.id);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      const course = question.courseId ? await Course.findById(question.courseId).lean() : null;
      if (isStudentPracticeAccessDisabled(course, request.user) && question.studentCreated && userOwnsQuestion(question, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Student questions are disabled for this course' });
      }

      const hasPermission = await userCanViewQuestion(question, request.user);
      if (!hasPermission) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const canManage = await userCanManageQuestion(question, request.user);
      const ownsQuestion = userOwnsQuestion(question, request.user);
      const questionPayload = canManage || ownsQuestion
        ? question.toObject()
        : stripAnswerRevealFields(question.toObject(), { revealCorrectAnswers: false });

      return { question: questionPayload };
    }
  );

  // PATCH /questions/:id - Update a question
  app.patch(
    '/questions/:id',
    {
      preHandler: authenticate,
      schema: updateQuestionSchema,
      rateLimit: { max: 30, timeWindow: '1 minute' },
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const question = await Question.findById(request.params.id);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      const hasPermission = await userCanManageQuestion(question, request.user);
      if (!hasPermission) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const course = question.courseId ? await Course.findById(question.courseId).lean() : null;
      const isStudent = shouldTreatUserAsStudentForCourse(request.user, course);
      if (isStudent) {
        if (isStudentPracticeAccessDisabled(course, request.user)) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Student questions are disabled for this course' });
        }
        if (request.body.tags !== undefined) {
          const allowedTagValues = getAllowedCourseTagValues(course);
          if (hasNewDisallowedCourseTagsForUpdate(request.body.tags, question.tags, allowedTagValues)) {
            return reply.code(400).send({ error: 'Bad Request', message: courseTopicValidationMessage('Questions') });
          }
        }
      } else if (course && request.body.tags !== undefined) {
        const allowedTagValues = getAllowedCourseTagValues(course);
        if (hasNewDisallowedCourseTagsForUpdate(request.body.tags, question.tags, allowedTagValues)) {
          return reply.code(400).send({ error: 'Bad Request', message: courseTopicValidationMessage('Questions') });
        }
      }

      const requestedType = request.body.type;
      if (requestedType !== undefined && Number(requestedType) !== Number(question.type)) {
        const hasResponses = await Response.exists({ questionId: String(question._id) });
        if (hasResponses) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'Question type cannot be changed because this question has response data',
          });
        }
      }

      const hasResponses = await Response.exists({ questionId: String(question._id) });
      if (hasResponses && request.body.options !== undefined) {
        const currentOptionCount = Array.isArray(question.options) ? question.options.length : 0;
        const nextOptionCount = Array.isArray(request.body.options) ? request.body.options.length : 0;
        if (nextOptionCount !== currentOptionCount) {
          return reply.code(409).send({
            error: 'Conflict',
            message: 'Question options cannot be added or removed because this question has response data',
          });
        }
      }

      const nextType = request.body.type !== undefined ? request.body.type : question.type;
      const nextOptions = request.body.options !== undefined ? request.body.options : question.options;
      const updateValidationError = multipleChoiceValidationError(nextType, nextOptions);
      if (updateValidationError) {
        return reply.code(400).send(updateValidationError);
      }

      const allowed = [
        'content', 'plainText', 'options', 'type', 'toleranceNumerical', 'correctNumerical',
        'solution', 'solution_plainText', 'public', 'publicOnQlicker', 'publicOnQlickerForStudents',
        'approved', 'tags', 'imagePath', 'sessionOptions',
      ];
      const updates = {};
      for (const key of allowed) {
        if (request.body[key] !== undefined) {
          updates[key] = request.body[key];
        }
      }
      if (isStudent) {
        delete updates.public;
        delete updates.publicOnQlicker;
        delete updates.publicOnQlickerForStudents;
        delete updates.approved;
      }
      if (updates.publicOnQlicker === true) {
        updates.public = true;
      }
      if (updates.public === false) {
        updates.publicOnQlicker = false;
        updates.publicOnQlickerForStudents = false;
      }
      if (updates.publicOnQlicker === false) {
        updates.publicOnQlickerForStudents = false;
      }

      const requestedPoints = request.body.sessionOptions?.points;
      const pointsChanged = requestedPoints !== undefined
        && Number(requestedPoints) !== Number(question.sessionOptions?.points ?? 1);
      const gradingAffected = pointsChanged && !!(await Grade.exists({
        'marks.questionId': String(question._id),
      }));

      // sessionOptions contains live-session state as well as authoring fields.
      // Patch individual supplied properties so changing points or question text
      // cannot reset visibility, attempts, or cached review data.
      const sessionOptionUpdates = updates.sessionOptions;
      delete updates.sessionOptions;
      const updateFields = {
        ...updates,
        owner: request.user.userId,
        lastEditedAt: new Date(),
        ...(updates.tags !== undefined ? { tags: normalizeTags(updates.tags) } : {}),
      };
      if (sessionOptionUpdates) {
        Object.entries(sessionOptionUpdates).forEach(([key, value]) => {
          updateFields[`sessionOptions.${key}`] = value;
        });
      }

      const updated = await Question.findByIdAndUpdate(
        request.params.id,
        {
          $set: updateFields,
        },
        { returnDocument: 'after' }
      );

      await notifyLinkedSessionQuestionUpdated(app, updated || question);

      return { question: updated.toObject(), gradingAffected };
    }
  );

  // DELETE /questions/:id - Delete a question
  app.delete(
    '/questions/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const question = await Question.findById(request.params.id);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      const hasPermission = await userCanManageQuestion(question, request.user);
      if (!hasPermission) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const hasResponses = await Response.exists({ questionId: String(question._id) });
      if (hasResponses) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Questions with response data cannot be deleted',
        });
      }

      await Session.updateMany(
        { questions: String(question._id) },
        { $pull: { questions: String(question._id) } }
      );

      await Question.findByIdAndDelete(request.params.id);

      return { success: true };
    }
  );

  // POST /questions/:id/copy - Copy question to personal library
  app.post(
    '/questions/:id/copy',
    { preHandler: authenticate },
    async (request, reply) => {
      const userId = request.user.userId;

      const question = await Question.findById(request.params.id);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      const hasPermission = await userCanViewQuestion(question, request.user);
      if (!hasPermission) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }
      const course = question.courseId ? await Course.findById(question.courseId).select('_id instructors students allowStudentQuestions').lean() : null;
      if (shouldTreatUserAsStudentForCourse(request.user, course) && isStudentPracticeAccessDisabled(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Student questions are disabled for this course' });
      }

      const copy = await createLibraryQuestionCopy({
        sourceQuestion: question,
        targetCourseId: String(question.courseId || ''),
        userId,
        forceStudentCopy: shouldTreatUserAsStudentForCourse(request.user, course),
      });

      return reply.code(201).send({ question: copy.toObject() });
    }
  );

  // POST /questions/:id/approve - Approve a question in a course library
  app.post(
    '/questions/:id/approve',
    {
      preHandler: authenticate,
      rateLimit: { max: 30, timeWindow: '1 minute' },
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const question = await Question.findById(request.params.id);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      const course = question.courseId ? await Course.findById(question.courseId).select('_id instructors').lean() : null;
      if (shouldTreatUserAsStudentForCourse(request.user, course)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const hasPermission = await userCanManageQuestion(question, request.user);
      if (!hasPermission) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const updated = await Question.findByIdAndUpdate(
        request.params.id,
        {
          $set: {
            approved: true,
            owner: request.user.userId,
            lastEditedAt: new Date(),
          },
        },
        { returnDocument: 'after' }
      );

      return { question: updated.toObject() };
    }
  );

  app.post(
    '/questions/:id/make-public',
    {
      preHandler: authenticate,
      rateLimit: { max: 30, timeWindow: '1 minute' },
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const question = await Question.findById(request.params.id);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }
      const course = question.courseId ? await Course.findById(question.courseId).select('_id instructors').lean() : null;
      if (shouldTreatUserAsStudentForCourse(request.user, course)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const hasPermission = await userCanManageQuestion(question, request.user);
      if (!hasPermission) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const updated = await Question.findByIdAndUpdate(
        request.params.id,
        {
          $set: {
            public: true,
            publicOnQlicker: false,
            publicOnQlickerForStudents: false,
            approved: true,
            owner: request.user.userId,
            lastEditedAt: new Date(),
          },
        },
        { returnDocument: 'after' }
      );

      return { question: updated.toObject() };
    }
  );

  // POST /questions/bulk-copy - Copy selected questions to a course and optional session
  app.post(
    '/questions/bulk-copy',
    {
      preHandler: authenticate,
      schema: bulkCopyQuestionsSchema,
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const { questionIds, targetCourseId, targetSessionId = '' } = request.body;

      const targetCourse = await Course.findById(targetCourseId);
      if (!targetCourse) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!isInstructorOrAdmin(targetCourse, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      let targetSession = null;
      if (targetSessionId) {
        targetSession = await Session.findById(targetSessionId);
        if (!targetSession || String(targetSession.courseId) !== String(targetCourse._id)) {
          return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
        }
      }

      const questions = await Question.find({ _id: { $in: questionIds } });
      if (questions.length !== questionIds.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'One or more questions were not found' });
      }

      for (const question of questions) {
        // eslint-disable-next-line no-await-in-loop
        const hasPermission = await userCanManageQuestion(question, request.user);
        if (!hasPermission) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
        }
      }

      const copiedQuestions = [];
      for (const questionId of questionIds) {
        const question = questions.find((entry) => String(entry._id) === String(questionId));
        if (!question) continue;

        let copy;
        if (targetSession) {
          // eslint-disable-next-line no-await-in-loop
          copy = await copyQuestionToSession({
            sourceQuestion: question,
            targetSessionId: String(targetSession._id),
            targetCourseId: String(targetCourse._id),
            userId: request.user.userId,
          });
        } else {
          // eslint-disable-next-line no-await-in-loop
          copy = await createLibraryQuestionCopy({
            sourceQuestion: question,
            targetCourseId: String(targetCourse._id),
            userId: request.user.userId,
          });
        }
        copiedQuestions.push(copy.toObject());
      }

      return reply.code(201).send({ questions: copiedQuestions });
    }
  );

  // POST /questions/bulk-delete - Delete selected questions with response safeguards
  app.post(
    '/questions/bulk-delete',
    {
      preHandler: authenticate,
      schema: bulkDeleteQuestionsSchema,
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const questionIds = [...new Set(request.body.questionIds.map((questionId) => String(questionId)))];
      const questions = await Question.find({ _id: { $in: questionIds } });

      if (questions.length !== questionIds.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'One or more questions were not found' });
      }

      for (const question of questions) {
        // eslint-disable-next-line no-await-in-loop
        const hasPermission = await userCanManageQuestion(question, request.user);
        if (!hasPermission) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
        }
      }

      const responseBackedQuestionIds = await Response.distinct('questionId', { questionId: { $in: questionIds } });
      if (responseBackedQuestionIds.length > 0) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Questions with response data cannot be deleted',
          questionIds: responseBackedQuestionIds,
        });
      }

      await Session.updateMany(
        { questions: { $in: questionIds } },
        { $pull: { questions: { $in: questionIds } } }
      );
      await Question.deleteMany({ _id: { $in: questionIds } });

      return { deletedQuestionIds: questionIds };
    }
  );

  // POST /questions/bulk-visibility - Update library visibility for selected questions
  app.post(
    '/questions/bulk-visibility',
    {
      preHandler: requireRole(['professor', 'admin']),
      schema: bulkVisibilityQuestionsSchema,
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const questionIds = [...new Set(request.body.questionIds.map((questionId) => String(questionId)))];
      if (
        request.body?.public === undefined
        && request.body?.publicOnQlicker === undefined
        && request.body?.publicOnQlickerForStudents === undefined
      ) {
        return reply.code(400).send({ error: 'Bad Request', message: 'At least one visibility field is required' });
      }

      const questions = await Question.find({ _id: { $in: questionIds } });
      if (questions.length !== questionIds.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'One or more questions were not found' });
      }

      for (const question of questions) {
        // eslint-disable-next-line no-await-in-loop
        const hasPermission = await userCanManageQuestion(question, request.user);
        if (!hasPermission) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
        }
      }

      const updates = {};
      if (request.body?.public !== undefined) {
        updates.public = !!request.body.public;
      }
      if (request.body?.publicOnQlicker !== undefined) {
        updates.publicOnQlicker = !!request.body.publicOnQlicker;
      }
      if (request.body?.publicOnQlickerForStudents !== undefined) {
        updates.publicOnQlickerForStudents = !!request.body.publicOnQlickerForStudents;
      }
      if (updates.publicOnQlicker === true) {
        updates.public = true;
      }
      if (updates.public === false) {
        updates.publicOnQlicker = false;
        updates.publicOnQlickerForStudents = false;
      }
      if (updates.publicOnQlicker === false) {
        updates.publicOnQlickerForStudents = false;
      }

      await Question.updateMany(
        { _id: { $in: questionIds } },
        { $set: updates }
      );

      return { updatedQuestionIds: questionIds };
    }
  );

  // POST /questions/export - Export selected questions as JSON-safe records
  app.post(
    '/questions/export',
    {
      preHandler: authenticate,
      schema: exportQuestionsSchema,
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const questionIds = [...new Set(request.body.questionIds.map((questionId) => String(questionId)))];
      const questions = await Question.find({ _id: { $in: questionIds } }).lean();

      if (questions.length !== questionIds.length) {
        return reply.code(404).send({ error: 'Not Found', message: 'One or more questions were not found' });
      }

      for (const question of questions) {
        // eslint-disable-next-line no-await-in-loop
        const hasPermission = await userCanManageQuestion(question, request.user);
        if (!hasPermission) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
        }
      }

      return {
        questions: questionIds
          .map((questionId) => questions.find((question) => String(question._id) === String(questionId)))
          .filter(Boolean)
          .map((question) => sanitizeExportedQuestion(question)),
      };
    }
  );

  // POST /courses/:courseId/questions/import - Import question JSON into a course and optional session
  app.post(
    '/courses/:courseId/questions/import',
    {
      preHandler: authenticate,
      schema: importQuestionsSchema,
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const course = await Course.findById(request.params.courseId);
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }
      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      let targetSession = null;
      if (request.body.sessionId) {
        targetSession = await Session.findById(request.body.sessionId);
        if (!targetSession || String(targetSession.courseId) !== String(course._id)) {
          return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
        }
      }

      const importTags = normalizeTags(request.body.importTags || []);

      const importedPayloads = request.body.questions.map((question) => {
        const payload = sanitizeImportedQuestion(question, {
          courseId: String(course._id),
          sessionId: String(targetSession?._id || ''),
          userId: request.user.userId,
          importTags,
        });
        return { ...payload, tags: mergeSessionQuestionTags(payload.tags, targetSession?.tags || []) };
      });

      const validationError = importedPayloads
        .map((question) => multipleChoiceValidationError(question.type, question.options))
        .find(Boolean);
      if (validationError) {
        return reply.code(400).send(validationError);
      }

      const importedQuestions = await Question.insertMany(importedPayloads);

      if (targetSession && importedQuestions.length > 0) {
        const importedIds = importedQuestions.map((question) => String(question._id));
        const nextQuestionIds = [...new Set([
          ...((targetSession.questions || []).map((questionId) => String(questionId))),
          ...importedIds,
        ])];
        await Session.findByIdAndUpdate(targetSession._id, {
          $set: { questions: nextQuestionIds },
        });
      }

      return reply.code(201).send({
        questions: importedQuestions.map((question) => question.toObject()),
      });
    }
  );

  // POST /questions/:id/copy-to-session - Copy question to a session
  app.post(
    '/questions/:id/copy-to-session',
    {
      preHandler: authenticate,
      schema: copyToSessionSchema,
    },
    async (request, reply) => {
      const userId = request.user.userId;

      const question = await Question.findById(request.params.id).lean();
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      const session = await Session.findById(request.body.sessionId).lean();
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

      const copy = await copyQuestionToSession({
        sourceQuestion: question,
        targetSessionId: String(session._id),
        targetCourseId: String(course._id),
        userId,
      });

      return reply.code(201).send({ question: copy.toObject() });
    }
  );

  // POST /sessions/:sessionId/questions - Add existing question to session
  app.post(
    '/sessions/:sessionId/questions',
    {
      preHandler: authenticate,
      schema: addQuestionToSessionSchema,
    },
    async (request, reply) => {
      const session = await Session.findById(request.params.sessionId).lean();
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
      const question = await Question.findById(questionId).lean();
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      const normalizedSessionQuestionId = String(question.sessionId || '').trim();
      const normalizedSessionId = String(session._id);
      const normalizedCourseId = String(course._id);

      // Only attach a newly created, unattached question in place. Selecting a
      // question already in this session must create another independent copy.
      if (
        !(session.questions || []).includes(String(question._id))
        && normalizedSessionQuestionId === normalizedSessionId
        && String(question.courseId || '').trim() === normalizedCourseId
      ) {
        const nextQuestionIds = [...new Set([
          ...((session.questions || []).map((existingQuestionId) => String(existingQuestionId))),
          String(question._id),
        ])];
        const responseTracking = buildSessionResponseTracking(
          nextQuestionIds,
          session.questionResponseCounts
        );
        const updated = await Session.findByIdAndUpdate(
          session._id,
          {
            $set: {
              questions: nextQuestionIds,
              hasResponses: responseTracking.hasResponses,
              questionResponseCounts: responseTracking.questionResponseCounts,
            },
          },
          { returnDocument: 'after' }
        ).lean();

        await inheritSessionTagsForQuestions(session, [question._id]);
        return { session: updated, copiedQuestionId: String(question._id) };
      }

      const copy = await copyQuestionToSession({
        sourceQuestion: question,
        targetSessionId: String(session._id),
        targetCourseId: String(course._id),
        userId: request.user.userId,
      });

      const updated = await Session.findById(session._id).lean();
      return { session: updated, copiedQuestionId: String(copy._id) };
    }
  );

  // DELETE /sessions/:sessionId/questions/:questionId - Remove question from session
  app.delete(
    '/sessions/:sessionId/questions/:questionId',
    { preHandler: authenticate },
    async (request, reply) => {
      const session = await Session.findById(request.params.sessionId).lean();
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

      const hasResponses = await Response.exists({ questionId: String(request.params.questionId) });
      if (hasResponses) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Questions with response data cannot be removed from this session',
        });
      }

      const nextQuestionIds = (session.questions || []).filter((questionId) => String(questionId) !== String(request.params.questionId));
      const responseTracking = buildSessionResponseTracking(nextQuestionIds, session.questionResponseCounts);
      const updated = await Session.findByIdAndUpdate(
        session._id,
        {
          $set: {
            questions: nextQuestionIds,
            hasResponses: responseTracking.hasResponses,
            questionResponseCounts: responseTracking.questionResponseCounts,
          },
        },
        { returnDocument: 'after' }
      );

      return { session: updated.toObject() };
    }
  );

  // PATCH /sessions/:sessionId/questions/order - Reorder questions in session
  app.patch(
    '/sessions/:sessionId/questions/order',
    {
      preHandler: authenticate,
      schema: reorderQuestionsSchema,
    },
    async (request, reply) => {
      const session = await Session.findById(request.params.sessionId);
      if (!session) {
        return reply.code(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const course = await Course.findById(session.courseId);
      if (!course) {
        return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
      }

      if (!isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const newOrder = request.body.questions;
      const existingIds = new Set((session.questions || []).map(String));
      const addedIds = newOrder.filter((questionId) => !existingIds.has(questionId));
      if (addedIds.length > 0) {
        const ownedCount = await Question.countDocuments({
          _id: { $in: addedIds },
          sessionId: String(session._id),
        });
        if (ownedCount !== addedIds.length) {
          return reply.code(400).send({
            error: 'Bad Request',
            message: 'New questions must belong to this session; copy library questions first',
          });
        }
      }

      const updated = await Session.findByIdAndUpdate(
        session._id,
        { $set: { questions: newOrder } },
        { returnDocument: 'after' }
      );

      await inheritSessionTagsForQuestions(updated.toObject(), newOrder);

      return { session: updated.toObject() };
    }
  );

  // PATCH /sessions/:sessionId/questions/points - Set every gradable question's points
  app.patch(
    '/sessions/:sessionId/questions/points',
    {
      preHandler: authenticate,
      schema: setSessionQuestionPointsSchema,
    },
    async (request, reply) => {
      const session = await Session.findById(request.params.sessionId).lean();
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

      const sessionQuestionIds = (session.questions || []).map((questionId) => String(questionId));
      const gradableQuestions = sessionQuestionIds.length > 0
        ? await Question.find({
          _id: { $in: sessionQuestionIds },
          type: { $ne: 6 },
        }).lean()
        : [];
      const points = Number(request.body.points);
      const changedQuestionIds = gradableQuestions
        .filter((question) => Number(question.sessionOptions?.points ?? 1) !== points)
        .map((question) => String(question._id));

      const gradingAffected = changedQuestionIds.length > 0 && !!(await Grade.exists({
        sessionId: String(session._id),
        courseId: String(course._id),
        'marks.questionId': { $in: changedQuestionIds },
      }));

      if (changedQuestionIds.length > 0) {
        await Question.updateMany(
          { _id: { $in: changedQuestionIds } },
          {
            $set: {
              'sessionOptions.points': points,
              owner: request.user.userId,
              lastEditedAt: new Date(),
            },
          }
        );
      }

      const updatedQuestions = changedQuestionIds.length > 0
        ? await Question.find({ _id: { $in: changedQuestionIds } })
        : [];
      await Promise.all(updatedQuestions.map((question) => notifyLinkedSessionQuestionUpdated(app, question)));

      return {
        points,
        updatedCount: updatedQuestions.length,
        updatedQuestionIds: changedQuestionIds,
        gradingAffected,
      };
    }
  );

  // POST /questions/:id/attempt - Start new attempt on question
  app.post(
    '/questions/:id/attempt',
    { preHandler: authenticate },
    async (request, reply) => {
      const question = await Question.findById(request.params.id);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      // Must be instructor of question's course or admin
      if (question.courseId) {
        const course = await Course.findById(question.courseId);
        if (!course) {
          return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
        }
        if (!isInstructorOrAdmin(course, request.user)) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
        }
      } else {
        const roles = request.user.roles || [];
        if (!roles.includes('admin')) {
          return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
        }
      }

      const attempts = question.sessionOptions?.attempts || [];
      const nextNumber = attempts.length > 0
        ? Math.max(...attempts.map(a => a.number)) + 1
        : 1;

      const updated = await Question.findByIdAndUpdate(
        request.params.id,
        { $push: { 'sessionOptions.attempts': { number: nextNumber, closed: false } } },
        { returnDocument: 'after' }
      );

      return { question: updated.toObject() };
    }
  );

  // PATCH /questions/:id/attempt-status - Open/close an attempt
  app.patch(
    '/questions/:id/attempt-status',
    {
      preHandler: authenticate,
      schema: attemptStatusSchema,
    },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');

      const question = await Question.findById(request.params.id);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      let hasPermission = isAdmin;
      if (!hasPermission && question.courseId) {
        const course = await Course.findById(question.courseId);
        if (course && course.instructors.includes(userId)) {
          hasPermission = true;
        }
      }

      if (!hasPermission) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const { attemptNumber, closed } = request.body;

      const updated = await Question.findOneAndUpdate(
        { _id: request.params.id, 'sessionOptions.attempts.number': attemptNumber },
        { $set: { 'sessionOptions.attempts.$.closed': closed } },
        { returnDocument: 'after' }
      );

      if (!updated) {
        return reply.code(404).send({ error: 'Not Found', message: 'Attempt not found' });
      }

      return { question: updated.toObject() };
    }
  );

  // PATCH /questions/:id/visibility - Toggle question visibility
  app.patch(
    '/questions/:id/visibility',
    {
      preHandler: authenticate,
      schema: visibilitySchema,
    },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');

      const question = await Question.findById(request.params.id);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      let hasPermission = isAdmin;
      if (!hasPermission && question.courseId) {
        const course = await Course.findById(question.courseId);
        if (course && course.instructors.includes(userId)) {
          hasPermission = true;
        }
      }

      if (!hasPermission) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const updated = await Question.findByIdAndUpdate(
        request.params.id,
        { $set: { 'sessionOptions.hidden': request.body.hidden } },
        { returnDocument: 'after' }
      );

      return { question: updated.toObject() };
    }
  );

  // PATCH /questions/:id/stats - Show/hide stats
  app.patch(
    '/questions/:id/stats',
    {
      preHandler: authenticate,
      schema: statsSchema,
    },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');

      const question = await Question.findById(request.params.id);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      let hasPermission = isAdmin;
      if (!hasPermission && question.courseId) {
        const course = await Course.findById(question.courseId);
        if (course && course.instructors.includes(userId)) {
          hasPermission = true;
        }
      }

      if (!hasPermission) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const updated = await Question.findByIdAndUpdate(
        request.params.id,
        { $set: { 'sessionOptions.stats': request.body.stats } },
        { returnDocument: 'after' }
      );

      return { question: updated.toObject() };
    }
  );

  // PATCH /questions/:id/correct - Show/hide correct answer
  app.patch(
    '/questions/:id/correct',
    {
      preHandler: authenticate,
      schema: correctSchema,
    },
    async (request, reply) => {
      const roles = request.user.roles || [];
      const userId = request.user.userId;
      const isAdmin = roles.includes('admin');

      const question = await Question.findById(request.params.id);
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      let hasPermission = isAdmin;
      if (!hasPermission && question.courseId) {
        const course = await Course.findById(question.courseId);
        if (course && course.instructors.includes(userId)) {
          hasPermission = true;
        }
      }

      if (!hasPermission) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }

      const updated = await Question.findByIdAndUpdate(
        request.params.id,
        { $set: { 'sessionOptions.correct': request.body.correct } },
        { returnDocument: 'after' }
      );

      return { question: updated.toObject() };
    }
  );

  // POST /questions/:id/word-cloud - Generate word cloud data for a question (prof review)
  app.post(
    '/questions/:id/word-cloud',
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
      const question = await Question.findById(request.params.id).lean();
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      if (normalizeQuestionType(question) !== 2) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Word cloud is only supported for short-answer questions' });
      }

      // Authorization: must be instructor/admin of the course containing this question
      const courseId = question.courseId || '';
      const sessionId = question.sessionId || '';
      let course = null;
      if (courseId) {
        course = await Course.findById(courseId).lean();
      } else if (sessionId) {
        const session = await Session.findById(sessionId).lean();
        if (session?.courseId) {
          course = await Course.findById(session.courseId).lean();
        }
      }
      if (!course || !isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }
      const analysisSessions = await Session.find({
        courseId: String(course._id),
        $or: [
          { questions: String(question._id) },
          ...(sessionId ? [{ _id: sessionId }] : []),
        ],
      }).lean();
      if ((await Promise.all(analysisSessions.filter((session) => session.anonymous).map(anonymousResponsesReleasable))).some((released) => !released)) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Anonymous analysis is available after four respondents answer each answered question and attempt',
        });
      }

      const quizFilters = analysisSessions
        .filter((session) => getQuizResultsParticipantIds(session) !== null)
        .map(getQuizResultsResponseFilter);
      const responses = await Response.find({
        questionId: question._id, ...(quizFilters.length ? { $and: quizFilters } : {}),
      }).lean();
      const texts = [];
      responses.forEach((response) => {
        if (response.answerWysiwyg && typeof response.answerWysiwyg === 'string') {
          texts.push(response.answerWysiwyg);
        } else if (typeof response.answer === 'string') {
          texts.push(response.answer);
        }
      });

      const stopWords = Array.isArray(request.body?.stopWords) ? request.body.stopWords : [];
      const wordFrequencies = computeWordFrequencies(texts, stopWords, 100);

      const updatedQuestion = await Question.findByIdAndUpdate(
        question._id,
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

      return { wordCloudData };
    }
  );

  // POST /questions/:id/histogram - Generate histogram data for a question (prof review)
  app.post(
    '/questions/:id/histogram',
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
      const question = await Question.findById(request.params.id).lean();
      if (!question) {
        return reply.code(404).send({ error: 'Not Found', message: 'Question not found' });
      }

      if (normalizeQuestionType(question) !== 4) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Histogram is only supported for numerical questions' });
      }

      // Authorization: must be instructor/admin of the course containing this question
      const courseId = question.courseId || '';
      const sessionId = question.sessionId || '';
      let course = null;
      if (courseId) {
        course = await Course.findById(courseId).lean();
      } else if (sessionId) {
        const session = await Session.findById(sessionId).lean();
        if (session?.courseId) {
          course = await Course.findById(session.courseId).lean();
        }
      }
      if (!course || !isInstructorOrAdmin(course, request.user)) {
        return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
      }
      const analysisSessions = await Session.find({
        courseId: String(course._id),
        $or: [
          { questions: String(question._id) },
          ...(sessionId ? [{ _id: sessionId }] : []),
        ],
      }).lean();
      if ((await Promise.all(analysisSessions.filter((session) => session.anonymous).map(anonymousResponsesReleasable))).some((released) => !released)) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'Anonymous analysis is available after four respondents answer each answered question and attempt',
        });
      }

      const quizFilters = analysisSessions
        .filter((session) => getQuizResultsParticipantIds(session) !== null)
        .map(getQuizResultsResponseFilter);
      const responses = await Response.find({
        questionId: question._id, ...(quizFilters.length ? { $and: quizFilters } : {}),
      }).lean();
      const values = [];
      responses.forEach((response) => {
        const numeric = Number(response.answer);
        if (!Number.isNaN(numeric)) values.push(numeric);
      });

      const histOpts = {};
      if (request.body?.numBins != null) histOpts.numBins = request.body.numBins;
      if (request.body?.rangeMin != null) histOpts.rangeMin = request.body.rangeMin;
      if (request.body?.rangeMax != null) histOpts.rangeMax = request.body.rangeMax;

      const computed = computeHistogramData(values, histOpts);

      const updatedQuestion = await Question.findByIdAndUpdate(
        question._id,
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

      return { histogramData };
    }
  );
}
