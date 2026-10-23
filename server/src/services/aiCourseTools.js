import { getQuizResultsResponseFilter } from '../utils/quizResults.js';
import Course from '../models/Course.js';
import Grade from '../models/Grade.js';
import Question from '../models/Question.js';
import Response from '../models/Response.js';
import { anonymousResponsesReleasable } from './anonymousResponseRelease.js';
import Session from '../models/Session.js';
import User from '../models/User.js';
import {
  isCourseMember,
  resolveCourseAiAudience,
  studentReviewableSessionQuery,
  studentVisibleGradeQuery,
} from '../utils/courseAccess.js';
import { buildQuestionWithNormalizedOptions, getQuestionPoints } from './grading.js';
import {
  buildAnonymousRespondentIndex,
  getAnonymousRespondentKey,
  redactAnonymousSessionAttendance,
} from '../utils/anonymousSession.js';

const MAX_RESPONSE_PAGE_SIZE = 100;
const MAX_RESPONSE_CONTENT_CHARS = 30_000;
const MAX_GRADE_CELLS = 500;
const DEFAULT_PAGE_SIZE = 50;
const MAX_COURSE_GRADE_SESSION_COLUMNS = 25;
const DEFAULT_COURSE_GRADE_SESSION_LIMIT = 10;
const DEFAULT_STUDENT_SESSION_LIMIT = 25;
const MAX_STUDENT_SESSION_LIMIT = 50;
const STUDENT_OVERVIEW_SESSION_STATUSES = Object.freeze(['visible', 'running', 'done']);
const SESSION_STATUS_LABELS = Object.freeze({
  hidden: 'draft',
  visible: 'upcoming',
  running: 'live',
  done: 'ended',
});

function formatStudent(student) {
  const firstname = String(student?.profile?.firstname || '').trim();
  const lastname = String(student?.profile?.lastname || '').trim();
  const email = String(student?.emails?.[0]?.address || student?.email || '').trim();
  return {
    student_id: String(student?._id || ''),
    name: [firstname, lastname].filter(Boolean).join(' ') || email || 'Unknown student',
    email,
  };
}

function sessionSortTime(session) {
  return new Date(session?.date || session?.quizStart || session?.createdAt || 0).getTime();
}

function sessionOverviewStatus(session, { now = new Date(), userId = '', instructorView = false } = {}) {
  const storedStatus = String(session?.status || 'hidden');
  if (storedStatus !== 'visible' || !(session?.quiz || session?.practiceQuiz)) {
    return SESSION_STATUS_LABELS[storedStatus] || storedStatus || 'unknown';
  }

  const windows = [];
  const addWindow = (startValue, endValue) => {
    const start = startValue ? new Date(startValue) : null;
    const end = endValue ? new Date(endValue) : null;
    if (start && end && Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())) {
      windows.push({ start: start.getTime(), end: end.getTime() });
    }
  };
  addWindow(session.quizStart, session.quizEnd);
  (session.quizExtensions || []).forEach((extension) => {
    if (instructorView || String(extension?.userId || '') === String(userId || '')) {
      addWindow(extension?.quizStart, extension?.quizEnd);
    }
  });
  if (windows.length === 0) return 'upcoming';

  const nowMs = now.getTime();
  if (windows.some((window) => nowMs >= window.start && nowMs <= window.end)) return 'live';
  if (windows.every((window) => nowMs > window.end)) return 'ended';
  return 'upcoming';
}

function sessionOverviewTags(session) {
  return [...new Set((session?.tags || [])
    .map((tag) => String(tag?.label || tag?.value || tag || '').trim())
    .filter(Boolean))];
}

function sessionOverviewRow(session, { includeJoinedCount = false, now, userId, instructorView } = {}) {
  const quiz = !!(session?.quiz || session?.practiceQuiz);
  const row = {
    session_id: String(session?._id || ''),
    name: session?.name || '',
    quiz,
    practice_quiz: !!session?.practiceQuiz,
    anonymous: !!session?.anonymous,
    status: sessionOverviewStatus(session, { now, userId, instructorView }),
    reviewable: !!session?.reviewable,
    quiz_start: quiz && session?.quizStart ? new Date(session.quizStart).toISOString() : null,
    quiz_end: quiz && session?.quizEnd ? new Date(session.quizEnd).toISOString() : null,
    date: !quiz && session?.date ? new Date(session.date).toISOString() : null,
    question_count: Array.isArray(session?.questions) ? session.questions.length : 0,
    tags: sessionOverviewTags(session),
  };
  if (includeJoinedCount) {
    row.joined_student_count = new Set([
      ...(session?.joined || []).map(String),
      ...(session?.joinRecords || []).map((record) => String(record?.userId || '')).filter(Boolean),
    ]).size;
  }
  return row;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function requireCourseSession(courseId, sessionId) {
  const session = await Session.findOne({ _id: String(sessionId), courseId: String(courseId) }).lean();
  if (!session || session.studentCreated) throw new Error('Session not found in this course');
  return session;
}

async function requireEnrolledStudent(courseId, userId) {
  const normalizedUserId = String(userId || '');
  if (!normalizedUserId) throw new Error('Student identity is required');
  const course = await Course.findById(courseId).select('students instructors inactive').lean();
  const user = { userId: normalizedUserId, roles: ['student'] };
  if (!course || !isCourseMember(course, user) || resolveCourseAiAudience(course, user) !== 'student') {
    throw new Error('Student is not enrolled in this course');
  }
}

async function requireStudentReviewableSession(courseId, sessionId, userId) {
  await requireEnrolledStudent(courseId, userId);
  const session = await Session.findOne({
    _id: String(sessionId),
    courseId: String(courseId),
    ...studentReviewableSessionQuery({ includeStudentCreated: false }),
  }).lean();
  if (!session) throw new Error('Reviewable session not found');
  return session;
}

async function loadOrderedQuestions(session) {
  const questionIds = Array.isArray(session.questions) ? session.questions.map(String) : [];
  if (questionIds.length === 0) return [];
  const questions = await Question.find({ _id: { $in: questionIds } }).lean();
  const byId = new Map(questions.map((question) => [String(question._id), question]));
  return questionIds.map((id) => byId.get(id)).filter(Boolean);
}

function serializeQuestion(question, index) {
  return {
    question_id: String(question._id),
    number: index + 1,
    type: question.type,
    prompt: question.plainText || question.content || '',
    options: (question.options || []).map((option, optionIndex) => ({
      index: optionIndex + 1,
      text: option.plainText || option.content || option.answer || '',
      correct: !!option.correct,
    })),
  };
}

function serializeStudentReviewQuestion(question, index) {
  const normalizedQuestion = buildQuestionWithNormalizedOptions(question);
  const solutionHtml = String(normalizedQuestion.solution || '');
  const solutionText = String(normalizedQuestion.solution_plainText || '').trim()
    || solutionHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    ...serializeQuestion(normalizedQuestion, index),
    content: normalizedQuestion.content || '',
    correct_numerical: normalizedQuestion.correctNumerical ?? null,
    tolerance_numerical: normalizedQuestion.toleranceNumerical ?? null,
    solution: solutionText,
    solution_html: solutionHtml,
    points: getQuestionPoints(normalizedQuestion),
  };
}

function serializeAnswer(answer) {
  if (typeof answer === 'string' || typeof answer === 'number' || typeof answer === 'boolean') return answer;
  if (answer === null || answer === undefined) return '';
  return JSON.stringify(answer);
}

function clampPageValue(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

function jsonSafeSessionValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([key, entry]) => [key, jsonSafeSessionValue(entry)]));
  }
  if (Array.isArray(value)) return value.map(jsonSafeSessionValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== '__v')
        .map(([key, entry]) => [key, jsonSafeSessionValue(entry)])
    );
  }
  return value;
}

function questionPrompt(question) {
  return String(question?.plainText || question?.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function compareStudentRows(left, right, sortBy, order) {
  const direction = order === 'asc' ? 1 : -1;
  if (sortBy === 'total_points') {
    const pointsDifference = Number(left.total_points || 0) - Number(right.total_points || 0);
    if (pointsDifference !== 0) return direction * pointsDifference;
  }
  if (sortBy === 'total_percentage') {
    const leftPercentage = left.total_out_of > 0 ? left.total_points / left.total_out_of : -1;
    const rightPercentage = right.total_out_of > 0 ? right.total_points / right.total_out_of : -1;
    const percentageDifference = leftPercentage - rightPercentage;
    if (percentageDifference !== 0) return direction * percentageDifference;
  }
  return left.student.name.localeCompare(right.student.name) * (sortBy === 'name' ? direction : 1);
}

export async function listCourseStudents(courseId, { offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
  const course = await Course.findById(courseId).select('students').lean();
  if (!course) throw new Error('Course not found');
  const studentIds = (course.students || []).map(String);
  const pageOffset = clampPageValue(offset, 0, Number.MAX_SAFE_INTEGER);
  const pageSize = clampPageValue(limit, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const query = { _id: { $in: studentIds } };
  const [total, students] = studentIds.length > 0
    ? await Promise.all([
      User.countDocuments(query),
      User.find(query)
        .select('_id profile emails email')
        .sort({ 'profile.firstname': 1, 'profile.lastname': 1, _id: 1 })
        .skip(pageOffset)
        .limit(pageSize)
        .lean(),
    ])
    : [0, []];
  return {
    student_count: total,
    offset: pageOffset,
    returned_count: students.length,
    next_offset: pageOffset + students.length < total ? pageOffset + students.length : null,
    students: students.map(formatStudent).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function listCourseSessions(courseId, { query = '', offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
  const filter = { courseId: String(courseId), studentCreated: { $ne: true } };
  const search = String(query || '').trim();
  if (search) {
    const pattern = { $regex: escapeRegex(search), $options: 'i' };
    filter.$or = [{ name: pattern }, { description: pattern }];
  }
  const pageOffset = clampPageValue(offset, 0, Number.MAX_SAFE_INTEGER);
  const pageSize = clampPageValue(limit, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const [total, sessions] = await Promise.all([
    Session.countDocuments(filter),
    Session.find(filter)
      .select('_id name description status date quiz quizStart quizEnd practiceQuiz reviewable createdAt questions')
      .sort({ date: -1, quizStart: -1, createdAt: -1 })
      .skip(pageOffset)
      .limit(pageSize)
      .lean(),
  ]);
  return {
    session_count: total,
    offset: pageOffset,
    returned_count: sessions.length,
    next_offset: pageOffset + sessions.length < total ? pageOffset + sessions.length : null,
    sessions: sessions.map((session) => ({
      session_id: String(session._id),
      name: session.name || '',
      description: session.description || '',
      status: session.status || '',
      date: session.date || session.quizStart || session.createdAt || null,
      quiz: !!session.quiz,
      practice_quiz: !!session.practiceQuiz,
      reviewable: !!session.reviewable,
      question_count: Array.isArray(session.questions) ? session.questions.length : 0,
    })),
  };
}

export async function getCourseSessionOverview(courseId, { now = new Date() } = {}) {
  const sessions = await Session.find({
    courseId: String(courseId),
    studentCreated: { $ne: true },
  })
    .select('_id name status date quiz quizStart quizEnd quizExtensions practiceQuiz anonymous reviewable createdAt questions joined joinRecords tags')
    .sort({ date: -1, quizStart: -1, createdAt: -1 })
    .lean();
  return {
    session_count: sessions.length,
    sessions: sessions.map((session) => sessionOverviewRow(session, {
      includeJoinedCount: true,
      instructorView: true,
      now,
    })),
  };
}

export async function getStudentSessionOverview(courseId, userId, { now = new Date() } = {}) {
  await requireEnrolledStudent(courseId, userId);
  // This visibility rule is intentionally enforced in the database query.
  // Student AI prompts and model-supplied arguments cannot broaden it to
  // draft sessions or sessions created privately by another student.
  const sessions = await Session.find({
    courseId: String(courseId),
    studentCreated: { $ne: true },
    status: { $in: STUDENT_OVERVIEW_SESSION_STATUSES },
  })
    .select('_id name status date quiz quizStart quizEnd quizExtensions practiceQuiz anonymous reviewable createdAt questions tags')
    .sort({ date: -1, quizStart: -1, createdAt: -1 })
    .lean();
  return {
    session_count: sessions.length,
    sessions: sessions.map((session) => sessionOverviewRow(session, {
      userId,
      now,
    })),
  };
}

export async function listStudentReviewableSessions(
  courseId,
  userId,
  { offset = 0, limit = DEFAULT_STUDENT_SESSION_LIMIT } = {}
) {
  await requireEnrolledStudent(courseId, userId);
  const query = {
    courseId: String(courseId),
    ...studentReviewableSessionQuery({ includeStudentCreated: false }),
  };
  const pageOffset = clampPageValue(offset, 0, Number.MAX_SAFE_INTEGER);
  const pageSize = clampPageValue(limit, DEFAULT_STUDENT_SESSION_LIMIT, MAX_STUDENT_SESSION_LIMIT)
    || DEFAULT_STUDENT_SESSION_LIMIT;
  const [total, sessions] = await Promise.all([
    Session.countDocuments(query),
    Session.find(query)
      .select('_id name description status date quiz quizStart quizEnd practiceQuiz reviewable createdAt questions')
      .sort({ date: -1, quizStart: -1, createdAt: -1 })
      .skip(pageOffset)
      .limit(pageSize)
      .lean(),
  ]);
  return {
    session_count: total,
    offset: pageOffset,
    returned_count: sessions.length,
    next_offset: pageOffset + sessions.length < total ? pageOffset + sessions.length : null,
    sessions: sessions.map((session) => ({
      session_id: String(session._id),
      name: session.name || '',
      description: session.description || '',
      date: session.date || session.quizStart || session.createdAt || null,
      quiz: !!session.quiz,
      practice_quiz: !!session.practiceQuiz,
      question_count: Array.isArray(session.questions) ? session.questions.length : 0,
    })),
  };
}

export async function getStudentReviewableSessionQuestions(courseId, sessionId, userId) {
  const session = await requireStudentReviewableSession(courseId, sessionId, userId);
  const questions = await loadOrderedQuestions(session);
  return {
    session: { session_id: String(session._id), name: session.name || '' },
    questions: questions.map(serializeStudentReviewQuestion),
  };
}

export async function getStudentReviewableSessionGrade(courseId, sessionId, userId) {
  const session = await requireStudentReviewableSession(courseId, sessionId, userId);
  const questions = await loadOrderedQuestions(session);
  const grade = await Grade.findOne(
    studentVisibleGradeQuery(courseId, session._id, { userId })
  ).select('userId sessionId value participation points outOf joined needsGrading marks').lean();
  if (!grade) {
    return {
      session: { session_id: String(session._id), name: session.name || '' },
      grade: null,
    };
  }
  const marksByQuestionId = new Map((grade.marks || []).map((mark) => [String(mark.questionId), mark]));
  return {
    session: { session_id: String(session._id), name: session.name || '' },
    grade: {
      percentage: Number(grade.value || 0),
      participation: Number(grade.participation || 0),
      points: Number(grade.points || 0),
      out_of: Number(grade.outOf || 0),
      joined: !!grade.joined,
      needs_grading: !!grade.needsGrading,
      marks: questions.map((question, index) => {
        const mark = marksByQuestionId.get(String(question._id));
        return {
          question_id: String(question._id),
          number: index + 1,
          points: mark ? Number(mark.points || 0) : null,
          out_of: mark ? Number(mark.outOf ?? getQuestionPoints(question)) : getQuestionPoints(question),
          needs_grading: !!mark?.needsGrading,
          feedback: mark?.feedback || '',
          feedback_updated_at: mark?.feedbackUpdatedAt || null,
        };
      }),
    },
  };
}

export async function getSessionQuestions(courseId, sessionId) {
  const session = await requireCourseSession(courseId, sessionId);
  const questions = await loadOrderedQuestions(session);
  return {
    session: { session_id: String(session._id), name: session.name || '' },
    questions: questions.map(serializeQuestion),
  };
}

export async function getSessionDetails(
  courseId,
  sessionId,
  { participantOffset = 0, participantLimit = DEFAULT_PAGE_SIZE } = {}
) {
  const session = await requireCourseSession(courseId, sessionId);
  if (session.anonymous) {
    // Attendance in anonymous sessions is stored under pseudonyms and must
    // not be listed per student.
    const redactedSession = redactAnonymousSessionAttendance(session);
    return {
      session: jsonSafeSessionValue(redactedSession),
      anonymous: true,
      joined_student_count: redactedSession.joinedCount,
      submitted_quiz_student_count: redactedSession.submittedCount,
      participant_count: redactedSession.joinedCount,
      participant_offset: 0,
      returned_participant_count: 0,
      next_participant_offset: null,
      participants: [],
    };
  }
  const joinedIds = [...new Set([
    ...(session.joined || []).map(String),
    ...(session.joinRecords || []).map((record) => String(record.userId || '')).filter(Boolean),
  ])];
  const submittedIds = (session.submittedQuiz || []).map(String);
  const extensionIds = (session.quizExtensions || []).map((extension) => String(extension.userId || '')).filter(Boolean);
  const participantIds = [...new Set([...joinedIds, ...submittedIds, ...extensionIds])];
  const pageOffset = clampPageValue(participantOffset, 0, Number.MAX_SAFE_INTEGER);
  const pageSize = clampPageValue(participantLimit, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const pageIds = participantIds.slice(pageOffset, pageOffset + pageSize);
  const users = pageIds.length > 0
    ? await User.find({ _id: { $in: pageIds } }).select('_id profile emails email').lean()
    : [];
  const userById = new Map(users.map((user) => [String(user._id), formatStudent(user)]));
  const joinedSet = new Set(joinedIds);
  const submittedSet = new Set(submittedIds);
  const extensionSet = new Set(extensionIds);
  const joinRecordByUserId = new Map(
    (session.joinRecords || []).map((record) => [String(record.userId || ''), record])
  );

  return {
    // Keep the model's field names so every persisted session property is
    // available, including future schema additions, without maintaining a
    // second lossy serializer for the AI tool.
    session: jsonSafeSessionValue(session),
    joined_student_count: joinedIds.length,
    submitted_quiz_student_count: submittedIds.length,
    participant_count: participantIds.length,
    participant_offset: pageOffset,
    returned_participant_count: pageIds.length,
    next_participant_offset: pageOffset + pageIds.length < participantIds.length
      ? pageOffset + pageIds.length
      : null,
    participants: pageIds.map((participantId) => {
      const joinRecord = joinRecordByUserId.get(participantId);
      return {
        student: userById.get(participantId) || {
          student_id: participantId,
          name: 'Unknown student',
          email: '',
        },
        joined: joinedSet.has(participantId),
        joined_at: joinRecord?.joinedAt ? new Date(joinRecord.joinedAt).toISOString() : null,
        joined_with_code: !!joinRecord?.joinedWithCode,
        submitted_quiz: submittedSet.has(participantId),
        has_quiz_extension: extensionSet.has(participantId),
      };
    }),
  };
}

export async function getQuestionResponses(courseId, sessionId, questionId, { offset = 0, limit = DEFAULT_PAGE_SIZE } = {}) {
  const session = await requireCourseSession(courseId, sessionId);
  if (session.anonymous && session.status !== 'done') {
    throw new Error('Anonymous responses are available after the session ends');
  }
  const orderedQuestions = await loadOrderedQuestions(session);
  const question = orderedQuestions.find((entry) => String(entry._id) === String(questionId));
  if (!question) throw new Error('Question not found in this session');

  const pageOffset = clampPageValue(offset, 0, Number.MAX_SAFE_INTEGER);
  const pageSize = clampPageValue(limit, DEFAULT_PAGE_SIZE, MAX_RESPONSE_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const responseFilter = { questionId: String(question._id), ...getQuizResultsResponseFilter(session) };
  const highestAttemptResponse = await Response.findOne(responseFilter)
    .sort({ attempt: -1 })
    .select('attempt')
    .lean();
  const highestAttempt = Number(highestAttemptResponse?.attempt) || 0;
  const [responsePage = { metadata: [], responses: [] }] = highestAttempt > 0
    ? await Response.aggregate([
      { $match: { ...responseFilter, attempt: highestAttempt } },
      { $sort: { studentUserId: 1, updatedAt: -1, submittedAt: -1, createdAt: -1 } },
      { $group: { _id: '$studentUserId', response: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$response' } },
      { $sort: session.anonymous
        ? { studentUserId: 1 }
        : { updatedAt: -1, submittedAt: -1, createdAt: -1 } },
      { $facet: {
        metadata: [{ $count: 'total' }],
        responses: [{ $skip: pageOffset }, { $limit: pageSize }],
      } },
    ])
    : [{ metadata: [], responses: [] }];
  const responseCount = Number(responsePage.metadata?.[0]?.total || 0);
  const displayedResponses = responsePage.responses || [];
  const anonymousSession = !!session.anonymous;
  if (anonymousSession && !await anonymousResponsesReleasable(session)) {
    throw new Error('At least four respondents are required before anonymous answers are available');
  }
  const respondentIndexById = anonymousSession
    ? buildAnonymousRespondentIndex(await Response.distinct('studentUserId', {
      questionId: { $in: orderedQuestions.map((entry) => String(entry._id)) },
    }))
    : null;
  const users = !anonymousSession && displayedResponses.length > 0
    ? await User.find({ _id: { $in: displayedResponses.map((response) => response.studentUserId) } }).select('_id profile emails email').lean()
    : [];
  const studentById = new Map(users.map((student) => [String(student._id), formatStudent(student)]));

  const serializedResponses = displayedResponses.map((response) => {
    if (anonymousSession) {
      const respondentIndex = respondentIndexById.get(String(response.studentUserId || '')) || 0;
      return {
        student: {
          student_id: getAnonymousRespondentKey(respondentIndex),
          name: `Anonymous respondent ${respondentIndex}`,
          email: '',
        },
        answer: serializeAnswer(response.answer),
        answer_wysiwyg: response.answerWysiwyg || '',
        correct: response.correct,
        mark: response.mark,
      };
    }
    return {
      student: studentById.get(String(response.studentUserId)) || { student_id: String(response.studentUserId || ''), name: 'Unknown student', email: '' },
      answer: serializeAnswer(response.answer),
      answer_wysiwyg: response.answerWysiwyg || '',
      correct: response.correct,
      mark: response.mark,
      submitted_at: response.submittedAt || response.updatedAt || response.createdAt || null,
    };
  });
  const boundedResponses = [];
  let contentSize = 0;
  let contentTruncated = false;
  for (const response of serializedResponses) {
    const responseSize = JSON.stringify(response).length;
    if (contentSize + responseSize > MAX_RESPONSE_CONTENT_CHARS) {
      contentTruncated = true;
      break;
    }
    boundedResponses.push(response);
    contentSize += responseSize;
  }
  if (boundedResponses.length === 0 && serializedResponses.length > 0) {
    const response = serializedResponses[0];
    boundedResponses.push({
      ...response,
      answer: String(response.answer || '').slice(0, 10_000),
      answer_wysiwyg: String(response.answer_wysiwyg || '').slice(0, 10_000),
    });
    contentTruncated = true;
  }

  return {
    session: { session_id: String(session._id), name: session.name || '' },
    question: serializeQuestion(question, orderedQuestions.indexOf(question)),
    attempt: highestAttempt || null,
    response_count: responseCount,
    offset: pageOffset,
    returned_count: boundedResponses.length,
    next_offset: pageOffset + boundedResponses.length < responseCount ? pageOffset + boundedResponses.length : null,
    content_truncated: contentTruncated,
    responses: boundedResponses,
  };
}

export async function getSessionGradeTable(courseId, sessionId, { offset = 0, limit = DEFAULT_PAGE_SIZE, sortBy = 'name', order = 'asc' } = {}) {
  const session = await requireCourseSession(courseId, sessionId);
  const questions = await loadOrderedQuestions(session);
  const course = await Course.findById(courseId).select('students').lean();
  if (!course) throw new Error('Course not found');

  const [grades, students] = await Promise.all([
    Grade.find({ courseId: String(courseId), sessionId: String(sessionId) }).select('userId marks points outOf needsGrading').lean(),
    User.find({ _id: { $in: course.students || [] } }).select('_id profile emails email').lean(),
  ]);
  const gradeByStudentId = new Map(grades.map((grade) => [String(grade.userId), grade]));
  const questionColumns = questions.map((question, index) => ({
    question_id: String(question._id),
    number: index + 1,
    prompt: questionPrompt(question),
    out_of: getQuestionPoints(question),
  }));
  const questionIndexById = new Map(questionColumns.map((question, index) => [question.question_id, index]));
  const allRows = students.map((student) => {
    const grade = gradeByStudentId.get(String(student._id));
    const marksByQuestionId = new Map((grade?.marks || []).map((mark) => [String(mark.questionId), mark]));
    const scores = questionColumns.map((question) => {
      const mark = marksByQuestionId.get(question.question_id);
      return mark ? {
        points: Number(mark.points || 0),
        out_of: Number(mark.outOf ?? question.out_of),
        needs_grading: !!mark.needsGrading,
      } : { points: null, out_of: question.out_of, needs_grading: false };
    });
    const totalPoints = scores.reduce((total, score) => total + (score.points === null ? 0 : score.points), 0);
    const totalOutOf = scores.reduce((total, score) => total + (score.points === null ? 0 : score.out_of), 0);
    return { student: formatStudent(student), total_points: totalPoints, total_out_of: totalOutOf, scores };
  }).sort((left, right) => compareStudentRows(left, right, sortBy, order));

  const questionSummaries = questionColumns.map((question) => {
    const questionIndex = questionIndexById.get(question.question_id);
    const scores = allRows.map((row) => row.scores[questionIndex]).filter((score) => score.points !== null);
    const pointsEarned = scores.reduce((total, score) => total + score.points, 0);
    const pointsPossible = scores.reduce((total, score) => total + score.out_of, 0);
    return {
      question_id: question.question_id,
      number: question.number,
      graded_students: scores.length,
      average_points: scores.length ? pointsEarned / scores.length : null,
      average_percentage: pointsPossible > 0 ? pointsEarned / pointsPossible * 100 : null,
      needs_grading: scores.filter((score) => score.needs_grading).length,
    };
  });

  const pageOffset = clampPageValue(offset, 0, Number.MAX_SAFE_INTEGER);
  const requestedPageSize = clampPageValue(limit, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.max(1, Math.min(requestedPageSize, Math.floor(MAX_GRADE_CELLS / Math.max(questionColumns.length, 1))));
  const studentRows = allRows.slice(pageOffset, pageOffset + pageSize);
  return {
    session: { session_id: String(session._id), name: session.name || '' },
    questions: questionColumns,
    question_summaries: questionSummaries,
    student_count: allRows.length,
    offset: pageOffset,
    returned_count: studentRows.length,
    next_offset: pageOffset + studentRows.length < allRows.length ? pageOffset + studentRows.length : null,
    page_limited_to_preserve_context: pageSize < requestedPageSize,
    students: studentRows,
  };
}

export async function getCourseGradeTable(
  courseId,
  {
    studentOffset = 0,
    studentLimit = DEFAULT_PAGE_SIZE,
    sessionOffset = 0,
    sessionLimit = DEFAULT_COURSE_GRADE_SESSION_LIMIT,
    sortBy = 'name',
    order = 'asc',
  } = {}
) {
  const course = await Course.findById(courseId).select('name students').lean();
  if (!course) throw new Error('Course not found');

  const sessions = await Session.find({ courseId: String(courseId), studentCreated: { $ne: true }, anonymous: { $ne: true } })
    .select('_id name status date quizStart createdAt quiz practiceQuiz submittedQuiz')
    .lean();
  sessions.sort((left, right) => sessionSortTime(right) - sessionSortTime(left));

  const studentIds = (course.students || []).map(String);
  const sessionIds = sessions.map((session) => String(session._id));
  const students = studentIds.length > 0
    ? await User.find({ _id: { $in: studentIds } }).select('_id profile emails email').lean()
    : [];
  const participationByStudent = new Map();
  if (sortBy === 'average_participation' && sessionIds.length > 0) {
    const participationRows = await Grade.aggregate([
      { $match: { courseId: String(courseId), sessionId: { $in: sessionIds }, userId: { $in: studentIds } } },
      { $group: { _id: '$userId', participationTotal: { $sum: { $ifNull: ['$participation', 0] } } } },
    ]);
    participationRows.forEach((row) => participationByStudent.set(String(row._id), Number(row.participationTotal || 0)));
  }
  const allRows = students.map((student) => {
    const serializedStudent = formatStudent(student);
    return {
      student: serializedStudent,
      average_participation: sessions.length > 0
        ? Number(participationByStudent.get(serializedStudent.student_id) || 0) / sessions.length
        : 0,
    };
  }).sort((left, right) => {
    const direction = order === 'desc' ? -1 : 1;
    if (sortBy === 'average_participation') {
      const difference = left.average_participation - right.average_participation;
      if (difference !== 0) return direction * difference;
    }
    return left.student.name.localeCompare(right.student.name) * (sortBy === 'name' ? direction : 1);
  });

  const boundedSessionOffset = clampPageValue(sessionOffset, 0, Number.MAX_SAFE_INTEGER);
  const requestedSessionLimit = clampPageValue(
    sessionLimit,
    DEFAULT_COURSE_GRADE_SESSION_LIMIT,
    MAX_COURSE_GRADE_SESSION_COLUMNS
  ) || DEFAULT_COURSE_GRADE_SESSION_LIMIT;
  const selectedSessions = sessions.slice(boundedSessionOffset, boundedSessionOffset + requestedSessionLimit);
  const boundedStudentOffset = clampPageValue(studentOffset, 0, Number.MAX_SAFE_INTEGER);
  const requestedStudentLimit = clampPageValue(studentLimit, DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const studentPageSize = Math.max(
    1,
    Math.min(requestedStudentLimit, Math.floor(MAX_GRADE_CELLS / Math.max(selectedSessions.length, 1)))
  );
  const selectedRows = allRows.slice(boundedStudentOffset, boundedStudentOffset + studentPageSize);
  const selectedStudentIds = selectedRows.map((row) => row.student.student_id);
  if (sortBy !== 'average_participation' && selectedStudentIds.length > 0 && sessionIds.length > 0) {
    const selectedParticipation = await Grade.aggregate([
      { $match: { courseId: String(courseId), sessionId: { $in: sessionIds }, userId: { $in: selectedStudentIds } } },
      { $group: { _id: '$userId', participationTotal: { $sum: { $ifNull: ['$participation', 0] } } } },
    ]);
    const selectedParticipationByStudent = new Map(
      selectedParticipation.map((row) => [String(row._id), Number(row.participationTotal || 0)])
    );
    selectedRows.forEach((row) => {
      row.average_participation = Number(selectedParticipationByStudent.get(row.student.student_id) || 0) / sessions.length;
    });
  }
  const selectedSessionIds = selectedSessions.map((session) => String(session._id));
  const grades = selectedStudentIds.length > 0 && selectedSessionIds.length > 0
    ? await Grade.find({
      courseId: String(courseId),
      userId: { $in: selectedStudentIds },
      sessionId: { $in: selectedSessionIds },
    }).select('userId sessionId value participation points outOf joined needsGrading').lean()
    : [];
  const gradeByStudentAndSession = new Map(
    grades.map((grade) => [`${String(grade.userId)}::${String(grade.sessionId)}`, grade])
  );

  return {
    course: { course_id: String(course._id), name: course.name || '' },
    student_count: allRows.length,
    session_count: sessions.length,
    student_offset: boundedStudentOffset,
    returned_student_count: selectedRows.length,
    next_student_offset: boundedStudentOffset + selectedRows.length < allRows.length
      ? boundedStudentOffset + selectedRows.length
      : null,
    session_offset: boundedSessionOffset,
    returned_session_count: selectedSessions.length,
    next_session_offset: boundedSessionOffset + selectedSessions.length < sessions.length
      ? boundedSessionOffset + selectedSessions.length
      : null,
    student_page_limited_to_preserve_context: studentPageSize < requestedStudentLimit,
    sessions: selectedSessions.map((session) => ({
      session_id: String(session._id),
      name: session.name || '',
      date: session.date || session.quizStart || session.createdAt || null,
      status: session.status || '',
      quiz: !!session.quiz,
      practice_quiz: !!session.practiceQuiz,
    })),
    students: selectedRows.map((row) => ({
      ...row,
      session_grades: selectedSessions.map((session) => {
        const grade = gradeByStudentAndSession.get(`${row.student.student_id}::${String(session._id)}`);
        return {
          session_id: String(session._id),
          has_grade: !!grade,
          grade_percentage: grade ? Number(grade.value || 0) : null,
          participation_percentage: grade ? Number(grade.participation || 0) : null,
          points: grade ? Number(grade.points || 0) : null,
          out_of: grade ? Number(grade.outOf || 0) : null,
          joined: !!grade?.joined,
          submitted: Array.isArray(session.submittedQuiz)
            ? session.submittedQuiz.map(String).includes(row.student.student_id)
            : false,
          needs_grading: !!grade?.needsGrading,
        };
      }),
    })),
  };
}
