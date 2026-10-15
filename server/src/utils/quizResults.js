// Practice quizzes submit per question; scheduled/live quizzes submit as a whole.
// Ending a quiz releases saved answers too, without changing submission records.
export function getQuizResultsParticipantIds(session) {
  if (!session?.quiz || session.practiceQuiz || session.status === 'done') return null;
  return [...new Set((session.submittedQuiz || []).map(String).filter(Boolean))];
}

export function getQuizResultsResponseFilter(session) {
  const ids = getQuizResultsParticipantIds(session);
  return ids === null ? {} : { studentUserId: { $in: ids } };
}
