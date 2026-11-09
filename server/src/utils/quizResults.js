import { MIN_ANONYMOUS_RESPONDENTS } from './anonymousSession.js';

// Practice quizzes submit per question; scheduled/live quizzes submit as a whole.
// Ending a quiz releases saved answers too, without changing submission records.
export function getQuizResultsParticipantIds(session) {
  if (!session?.quiz || session.practiceQuiz || session.status === 'done') return null;
  const submitted = [...new Set((session.submittedQuiz || []).map(String).filter(Boolean))];
  // Submission order is append-only. Never sort before taking this prefix:
  // refreshing between batches must return the same people and answers.
  return session.anonymous
    ? submitted.slice(0, submitted.length - (submitted.length % MIN_ANONYMOUS_RESPONDENTS))
    : submitted;
}

export function getQuizResultsResponseFilter(session) {
  const ids = getQuizResultsParticipantIds(session);
  return ids === null ? {} : { studentUserId: { $in: ids } };
}
