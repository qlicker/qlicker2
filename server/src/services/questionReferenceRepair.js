import Question from '../models/Question.js';
import Session from '../models/Session.js';
import Response from '../models/Response.js';
import Grade from '../models/Grade.js';
import Course from '../models/Course.js';
import { generateMeteorId } from '../utils/meteorId.js';
import { buildSessionResponseTracking } from '../utils/sessionResponseTracking.js';
import { buildCopiedSessionOptions } from './questionCopy.js';
import { mergeSessionQuestionTags } from './sessionQuestionTags.js';
import { getQuestionPoints, recalculateSessionGrades } from './grading.js';

// Run with application writers stopped. The snapshot check also rejects session
// edits between inspection and replacement; it is not a cross-collection lock.
export async function repairSessionQuestionReferences({ sessionId, apply = false, allowVisible = false, expectedQuestionIds }) {
  const session = await Session.collection.findOne({ _id: sessionId });
  if (!session) return { sessionId, status: 'missing-session' };
  const ids = session.questions || [];
  if (expectedQuestionIds && JSON.stringify(ids) !== JSON.stringify(expectedQuestionIds)) return { sessionId, status: 'conflict' };
  const questions = await Question.collection.find({ _id: { $in: ids } }).toArray();
  const byId = new Map(questions.map((question) => [question._id, question]));
  const seen = new Set();
  const replacements = [];
  const missingIds = [];
  ids.forEach((id, index) => {
    const question = byId.get(id);
    if (!question) missingIds.push(id);
    else if (seen.has(id) || question.sessionId !== sessionId || question.courseId !== session.courseId) {
      replacements.push({ position: index + 1, sourceQuestionId: id, reason: seen.has(id) ? 'duplicate' : 'foreign' });
    }
    seen.add(id);
  });
  const report = {
    sessionId, sessionName: session.name || '(unnamed session)', courseId: session.courseId,
    sessionStatus: session.status, questionCount: ids.length, replacements,
  };
  if (!replacements.length && !missingIds.length) return { ...report, status: 'unchanged' };

  const [responseCount, gradeCount] = await Promise.all([
    Response.collection.countDocuments({ questionId: { $in: ids } }),
    Grade.collection.countDocuments({ $or: [
      { sessionId }, { 'marks.questionId': { $in: ids } },
    ] }),
  ]);
  Object.assign(report, { responseCount, gradeCount });
  const reasons = [];
  if (missingIds.length) reasons.push('missing-question-documents');
  if ((session.status !== 'hidden' && !(allowVisible && session.status === 'visible')) || session.reviewable) reasons.push('session-not-hidden');
  if ((session.joined || []).length || (session.joinRecords || []).length
      || (session.submittedQuiz || []).length || session.hasResponses
      || Object.values(session.questionResponseCounts || {}).some((count) => Number(count) > 0)) {
    reasons.push('recorded-participation');
  }
  if (responseCount) reasons.push('existing-responses');
  if (gradeCount) reasons.push('existing-grades');
  if (reasons.length) return { ...report, status: 'manual-review', reasons, missingIds: [...new Set(missingIds)] };
  if (!apply) return { ...report, status: 'would-repair' };

  const createdIds = [];
  const nextIds = [...ids];
  try {
    for (const replacement of replacements) {
      const source = byId.get(replacement.sourceQuestionId);
      const copyId = generateMeteorId();
      // Raw insertion preserves unknown legacy question fields, including old
      // solution representations. Only identity, provenance and live state change.
      const copy = {
        ...source,
        _id: copyId,
        sessionId,
        courseId: session.courseId,
        originalQuestion: source.originalQuestion || source._id,
        originalCourse: source.originalCourse || source.courseId || session.courseId,
        createdAt: new Date(),
        lastEditedAt: new Date(),
        sessionOptions: buildCopiedSessionOptions({ ...source.sessionOptions, points: getQuestionPoints(source) }, { preservePoints: true }),
        tags: mergeSessionQuestionTags(source.tags, session.tags),
      };
      delete copy.sessionProperties;
      delete copy.__v;
      delete copy.updatedAt;
      await Question.collection.insertOne(copy);
      createdIds.push(copyId);
      nextIds[replacement.position - 1] = copyId;
      replacement.newQuestionId = copyId;
    }
  } catch (error) {
    await Question.collection.deleteMany({ _id: { $in: createdIds } });
    throw error;
  }

  const currentIndex = ids.indexOf(session.currentQuestion);
  // Match the inspected fields exactly, including legacy absence of optional
  // fields. An uncertain write failure deliberately leaves copies intact rather
  // than risking deletion of documents the session may now reference.
  const guard = { ...session };
  for (const field of ['joined', 'joinRecords', 'submittedQuiz', 'hasResponses', 'questionResponseCounts', 'reviewable']) {
    if (!(field in session)) guard[field] = { $exists: false };
  }
  const result = await Session.collection.updateOne(guard, { $set: {
    questions: nextIds,
    currentQuestion: currentIndex >= 0 ? nextIds[currentIndex] : (session.currentQuestion || ''),
    ...buildSessionResponseTracking(nextIds),
  } });
  if (!result.matchedCount) {
    await Question.collection.deleteMany({ _id: { $in: createdIds } });
    return { ...report, status: 'conflict', reasons: ['session-changed-during-repair'] };
  }
  return { ...report, status: 'repaired' };
}

// Interactive decisions are deliberately separate from the unattended draft
// repair. They never invent answers or move response rows between sessions.
export async function getQuestionRepairActions(sessionId) {
  const report = await repairSessionQuestionReferences({ sessionId, allowVisible: true });
  if (report.status === 'unchanged' || report.status === 'missing-session') return { report, actions: [] };
  const actions = [];
  const blocks = [];
  if (report.status === 'would-repair') actions.push('copy');
  const session = await Session.collection.findOne({ _id: sessionId });
  const ids = session.questions || [];
  const uniqueIds = [...new Set(ids)];
  const questions = await Question.collection.find({ _id: { $in: uniqueIds } }).toArray();
  const ownsAll = questions.length === uniqueIds.length && questions.every((question) => (
    question.sessionId === sessionId && question.courseId === session.courseId
  ));
  const sharedElsewhere = await Session.collection.findOne({ _id: { $ne: sessionId }, questions: { $in: uniqueIds } });
  const foreignGrade = await Grade.collection.findOne({ sessionId: { $ne: sessionId }, 'marks.questionId': { $in: uniqueIds } });
  if (uniqueIds.length < ids.length && ownsAll && !sharedElsewhere && !foreignGrade) {
    actions.push('remove-keep-grades');
    if (session.status === 'done') {
      const course = await Course.collection.findOne({ _id: session.courseId });
      const grades = await Grade.collection.find({ sessionId }).toArray();
      const students = new Set();
      let ambiguousGrades = false;
      for (const grade of grades) {
        if (students.has(grade.userId)) ambiguousGrades = true;
        students.add(grade.userId);
        const manualIds = new Set();
        for (const mark of grade.marks || []) {
          if (mark.automatic !== false) continue;
          if (manualIds.has(mark.questionId)) ambiguousGrades = true;
          manualIds.add(mark.questionId);
        }
      }
      if (course && !ambiguousGrades) actions.push('remove-recalculate');
      else blocks.push('Automatic recalculation is unavailable: the course is missing or duplicate grade rows/manual marks need review.');
    } else blocks.push('Automatic recalculation is available only for ended sessions.');
  } else if (uniqueIds.length < ids.length) {
    blocks.push('Answers or questions may belong to another session, or question documents are missing. Duplicate removal needs individual review.');
  }
  return { report, actions, blocks, questionIds: ids };
}

export async function applyQuestionRepairDecision({ sessionId, action, expectedQuestionIds }) {
  const state = await getQuestionRepairActions(sessionId);
  if (JSON.stringify(state.questionIds) !== JSON.stringify(expectedQuestionIds)) {
    return { status: 'conflict', sessionId };
  }
  if (!state.actions.includes(action)) return { status: 'manual-review', sessionId };
  if (action === 'copy') return repairSessionQuestionReferences({ sessionId, apply: true, allowVisible: true, expectedQuestionIds });

  const session = await Session.collection.findOne({ _id: sessionId });
  if (!session || JSON.stringify(session.questions) !== JSON.stringify(expectedQuestionIds)) return { sessionId, status: 'conflict' };
  const questions = [...new Set(session.questions)];
  let grading = null;
  if (action === 'remove-recalculate') {
    // Grade the proposed order first. If calculation fails, the duplicate array
    // remains detectable so an offline retry can finish any partial grade writes.
    // Existing manual marks must take precedence over stale automatic duplicates.
    const grades = await Grade.find({ sessionId }).lean();
    for (const grade of grades) {
      const byId = new Map();
      for (const mark of grade.marks || []) {
        const previous = byId.get(mark.questionId);
        if (!previous || previous.automatic !== false) byId.set(mark.questionId, mark);
      }
      if (byId.size !== (grade.marks || []).length) {
        await Grade.updateOne({ _id: grade._id }, { $set: { marks: [...byId.values()] } });
      }
    }
    grading = (await recalculateSessionGrades({
      sessionId, sessionDoc: { ...session, questions }, preserveManualMarks: true,
    })).summary;
  }
  const result = await Session.collection.updateOne({ ...session }, { $set: {
    questions,
    ...buildSessionResponseTracking(questions, session.questionResponseCounts),
  } });
  if (!result.matchedCount) return { status: 'conflict', sessionId, grading };
  return { status: 'repaired', sessionId, removedPositions: session.questions.length - questions.length, grading };
}
