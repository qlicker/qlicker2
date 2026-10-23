import Course from '../models/Course.js';
import Question from '../models/Question.js';
import Session from '../models/Session.js';
import { copyQuestionToSession } from './questionCopy.js';

function buildSessionCopyPayload(sourceSession = {}, targetCourseId, userId) {
  return {
    name: `${sourceSession.name || 'Session'} (copy)`,
    description: sourceSession.description || '',
    courseId: targetCourseId,
    creator: String(userId || ''),
    studentCreated: false,
    status: 'hidden',
    quiz: !!sourceSession.quiz,
    practiceQuiz: !!sourceSession.practiceQuiz,
    anonymous: !!sourceSession.anonymous && !sourceSession.practiceQuiz,
    msScoringMethod: sourceSession.msScoringMethod,
    tags: Array.isArray(sourceSession.tags) ? sourceSession.tags : [],
    reviewable: false,
    hasResponses: false,
    questionResponseCounts: {},
    questions: [],
    joined: [],
    joinRecords: [],
    submittedQuiz: [],
    quizExtensions: [],
    currentQuestion: '',
    joinCodeEnabled: false,
    joinCodeActive: false,
    currentJoinCode: '',
  };
}

export async function copySessionToCourse({
  sourceSession,
  targetCourseId,
  userId,
  preservePoints = false,
}) {
  if (!sourceSession?._id) {
    throw new Error('Source session is required');
  }
  if (!targetCourseId) {
    throw new Error('Target course is required');
  }
  if (!userId) {
    throw new Error('User is required');
  }

  const sessionObject = sourceSession.toObject ? sourceSession.toObject() : sourceSession;
  const createdQuestions = [];
  let createdSession = null;

  try {
    createdSession = await Session.create(buildSessionCopyPayload(sessionObject, targetCourseId, userId));

    await Course.findByIdAndUpdate(targetCourseId, {
      $addToSet: { sessions: createdSession._id },
    });

    const sourceQuestionIds = Array.isArray(sessionObject.questions) ? sessionObject.questions : [];
    if (sourceQuestionIds.length > 0) {
      const sourceQuestions = await Question.find({ _id: { $in: sourceQuestionIds } });
      const sourceQuestionsById = new Map(sourceQuestions.map((question) => [String(question._id), question]));
      const copiedQuestionIds = [];

      for (const sourceQuestionId of sourceQuestionIds) {
        const sourceQuestion = sourceQuestionsById.get(String(sourceQuestionId));
        if (!sourceQuestion) continue;

        const copiedQuestion = await copyQuestionToSession({
          sourceQuestion,
          targetSessionId: createdSession._id,
          targetCourseId,
          userId,
          addToSession: false,
          preservePoints,
        });

        createdQuestions.push(String(copiedQuestion._id));
        copiedQuestionIds.push(String(copiedQuestion._id));
      }

      if (copiedQuestionIds.length > 0) {
        await Session.findByIdAndUpdate(createdSession._id, {
          $set: { questions: copiedQuestionIds },
        });
      }
    }

    const copiedSession = await Session.findById(createdSession._id);
    return copiedSession ? copiedSession.toObject() : createdSession.toObject();
  } catch (error) {
    if (createdQuestions.length > 0) {
      await Question.deleteMany({ _id: { $in: createdQuestions } });
    }
    if (createdSession?._id) {
      await Session.deleteOne({ _id: createdSession._id });
      await Course.findByIdAndUpdate(targetCourseId, {
        $pull: { sessions: createdSession._id },
      });
    }
    throw error;
  }
}
