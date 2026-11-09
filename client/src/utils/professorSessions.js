export function getProfessorSessionPrimaryPath(session, courseId, returnTab = 0) {
  const sessionId = String(session?._id || '');
  const tabSuffix = `?returnTab=${returnTab}`;
  const isQuiz = !!(session?.quiz || session?.practiceQuiz);

  if (String(session?.status || '') === 'done') {
    return `/prof/course/${courseId}/session/${sessionId}/review${tabSuffix}`;
  }

  if (String(session?.status || '') === 'running' && !isQuiz) {
    return `/prof/course/${courseId}/session/${sessionId}/live${tabSuffix}`;
  }

  return `/prof/course/${courseId}/session/${sessionId}${tabSuffix}`;
}

export function sessionCanShowLiveReviewAction(session) {
  return String(session?.status || '') === 'running' && anonymousReviewAvailable(session);
}

function anonymousReviewAvailable(session) {
  return !session?.anonymous || (!!session.quiz && !session.practiceQuiz && Number(session.submittedCount || 0) >= 4);
}

export function sessionWaitingForAnonymousReview(session) {
  return session?.status === 'running' && !!session.anonymous && !!session.quiz
    && !session.practiceQuiz && !anonymousReviewAvailable(session);
}

export function sessionCanShowListReviewAction(session) {
  const status = String(session?.status || '');
  if (!['hidden', 'visible'].includes(status)) return false;
  return !!session?.hasResponses && anonymousReviewAvailable(session);
}
