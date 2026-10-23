import Question from '../models/Question.js';
import { mergeNormalizedTags } from './questionImportExport.js';

export function mergeSessionQuestionTags(questionTags = [], sessionTags = []) {
  return mergeNormalizedTags(questionTags, sessionTags);
}

export async function inheritSessionTagsForQuestions(session, questionIds = session?.questions || []) {
  const normalizedQuestionIds = [...new Set((questionIds || []).map(String).filter(Boolean))];
  if (!session || normalizedQuestionIds.length === 0 || !Array.isArray(session.tags) || session.tags.length === 0) return;

  const questions = await Question.find({ _id: { $in: normalizedQuestionIds } }).select('_id tags').lean();
  if (questions.length === 0) return;
  await Question.bulkWrite(questions.map((question) => ({
    updateOne: {
      filter: { _id: question._id },
      update: { $set: { tags: mergeSessionQuestionTags(question.tags, session.tags) } },
    },
  })));
}
