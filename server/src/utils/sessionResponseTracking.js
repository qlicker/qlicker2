function normalizeQuestionId(questionId) {
  return String(questionId || '').trim();
}

function toSafeCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function normalizeQuestionIds(questionIds = []) {
  return [...new Set(
    (Array.isArray(questionIds) ? questionIds : [])
      .map((questionId) => normalizeQuestionId(questionId))
      .filter(Boolean)
  )];
}

export function getSessionQuestionResponseCounts(session = {}) {
  const rawCounts = session?.questionResponseCounts;
  if (!rawCounts || typeof rawCounts !== 'object') return {};

  if (rawCounts instanceof Map) {
    return Object.fromEntries(
      [...rawCounts.entries()]
        .map(([questionId, count]) => [normalizeQuestionId(questionId), toSafeCount(count)])
        .filter(([questionId]) => questionId)
    );
  }

  return Object.fromEntries(
    Object.entries(rawCounts)
      .map(([questionId, count]) => [normalizeQuestionId(questionId), toSafeCount(count)])
      .filter(([questionId]) => questionId)
  );
}

export function buildSessionResponseTracking(questionIds = [], existingCounts = {}) {
  const normalizedQuestionIds = normalizeQuestionIds(questionIds);
  const normalizedCounts = getSessionQuestionResponseCounts({ questionResponseCounts: existingCounts });
  const questionResponseCounts = {};

  normalizedQuestionIds.forEach((questionId) => {
    questionResponseCounts[questionId] = toSafeCount(normalizedCounts[questionId]);
  });

  return {
    questionResponseCounts,
    hasResponses: Object.values(questionResponseCounts).some((count) => count > 0),
  };
}

export function sessionResponseTrackingNeedsHydration(session = {}) {
  const normalizedQuestionIds = normalizeQuestionIds(session?.questions);
  const questionResponseCounts = getSessionQuestionResponseCounts(session);
  const storedQuestionIds = Object.keys(questionResponseCounts);
  const hasResponses = session?.hasResponses;

  if (typeof hasResponses !== 'boolean') return true;
  if (storedQuestionIds.length !== normalizedQuestionIds.length) return true;
  if (normalizedQuestionIds.some((questionId) => !Object.prototype.hasOwnProperty.call(questionResponseCounts, questionId))) {
    return true;
  }

  const computedHasResponses = Object.values(questionResponseCounts).some((count) => count > 0);
  return computedHasResponses !== hasResponses;
}

export function getSessionHasResponses(session = {}) {
  if (typeof session?.hasResponses === 'boolean') return session.hasResponses;
  const questionResponseCounts = getSessionQuestionResponseCounts(session);
  return Object.values(questionResponseCounts).some((count) => count > 0);
}

export function getTrackedQuestionAttemptState(question = {}) {
  const lastAttemptNumber = Number(question?.sessionProperties?.lastAttemptNumber) || 0;
  const lastAttemptResponseCount = toSafeCount(question?.sessionProperties?.lastAttemptResponseCount);
  return {
    lastAttemptNumber,
    lastAttemptResponseCount,
  };
}
