import Response from '../models/Response.js';
import { MIN_ANONYMOUS_RESPONDENTS } from '../utils/anonymousSession.js';

// Analysis routes read across attempts and therefore retain an activity-wide
// release gate. The results endpoint independently filters each question/attempt;
// do not relax this gate without also scoping the analysis response queries.
export async function anonymousResponsesReleasable(session) {
  if (!session?.anonymous || session.status !== 'done') return false;
  const questionIds = (session.questions || []).map((id) => String(id));
  if (questionIds.length === 0) return false;
  const groups = await Response.aggregate([
    { $match: { questionId: { $in: questionIds } } },
    { $group: { _id: {
      questionId: '$questionId',
      attempt: '$attempt',
      studentUserId: '$studentUserId',
    } } },
    { $group: { _id: { questionId: '$_id.questionId', attempt: '$_id.attempt' }, count: { $sum: 1 } } },
  ]);
  return groups.length > 0
    && groups.every((group) => group.count >= MIN_ANONYMOUS_RESPONDENTS);
}
