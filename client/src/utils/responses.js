export function getResponseTimestampMs(response) {
  const timestamp = new Date(response?.updatedAt || response?.createdAt || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function getLatestResponse(responses = []) {
  if (!Array.isArray(responses) || responses.length === 0) return null;

  let latestResponse = null;
  responses.forEach((response) => {
    if (!response) return;
    if (!latestResponse) {
      latestResponse = response;
      return;
    }

    const attemptDiff = (Number(response?.attempt) || 0) - (Number(latestResponse?.attempt) || 0);
    if (attemptDiff > 0) {
      latestResponse = response;
      return;
    }
    if (attemptDiff < 0) {
      return;
    }

    if (getResponseTimestampMs(response) >= getResponseTimestampMs(latestResponse)) {
      latestResponse = response;
    }
  });

  return latestResponse;
}

export function sortResponsesNewestFirst(responses = []) {
  if (!Array.isArray(responses) || responses.length === 0) return [];
  return responses
    .map((response) => ({
      response,
      timestamp: getResponseTimestampMs(response),
      id: String(response?._id || ''),
    }))
    .sort((a, b) => {
      const timestampDiff = b.timestamp - a.timestamp;
      if (timestampDiff !== 0) return timestampDiff;
      return b.id.localeCompare(a.id);
    })
    .map(({ response }) => response);
}

function getResponseMergeKey(response = {}) {
  return [
    String(response?.studentName || ''),
    String(response?.answer ?? ''),
    String(response?.answerWysiwyg ?? ''),
    getResponseTimestampMs(response),
  ].join('|');
}

export function mergeResponsesNewestFirst(existingResponses = [], incomingResponses = []) {
  const merged = [...(Array.isArray(existingResponses) ? existingResponses : [])].filter(Boolean);
  for (const response of (Array.isArray(incomingResponses) ? incomingResponses : [])) {
    if (!response) continue;
    let index = response._id ? merged.findIndex((entry) => entry._id === response._id) : -1;
    if (index < 0) {
      // Anonymous aggregate snapshots omit response IDs, while live deltas
      // include them. Match one snapshot entry before appending, without
      // collapsing distinct identified responses with identical text/times.
      const key = getResponseMergeKey(response);
      index = merged.findIndex((entry) => (!entry._id || !response._id)
        && getResponseMergeKey(entry) === key);
    }
    if (index < 0) merged.push(response);
    else merged[index] = response;
  }
  return sortResponsesNewestFirst(merged);
}

export function applyLiveResponseAddedDelta(prev, payload = {}) {
  if (!prev) return prev;

  const currentQuestionId = String(prev?.currentQuestion?._id || prev?.session?.currentQuestion || '');
  const payloadQuestionId = String(payload?.questionId || '');
  if (currentQuestionId && payloadQuestionId && payloadQuestionId !== currentQuestionId) {
    return prev;
  }

  const currentAttemptNumber = Number(prev?.currentAttempt?.number || 0);
  const payloadAttemptNumber = Number(payload?.attempt || currentAttemptNumber || 0);
  if (currentAttemptNumber > 0 && payloadAttemptNumber > 0 && payloadAttemptNumber !== currentAttemptNumber) {
    return prev;
  }

  const nextResponse = payload?.response || null;
  const nextAllResponses = nextResponse
    ? mergeResponsesNewestFirst(prev?.allResponses || [], [nextResponse])
    : (Array.isArray(prev?.allResponses) ? prev.allResponses : []);

  const currentStats = prev?.responseStats;
  let nextResponseStats = currentStats;

  const staleAnonymousStats = prev.session?.anonymous
    && Number(payload?.responseStats?.total || 0) < Number(currentStats?.total || 0);
  if (payload?.responseStats && typeof payload.responseStats === 'object' && !staleAnonymousStats) {
    if (payload.responseStats.type === 'distribution') {
      nextResponseStats = payload.responseStats;
    } else {
      const existingAnswers = Array.isArray(currentStats?.answers) ? currentStats.answers : [];
      const payloadAnswers = Array.isArray(payload.responseStats.answers) ? payload.responseStats.answers : null;
      const mergedAnswers = payloadAnswers
        ? payloadAnswers
        : nextResponse
          ? mergeResponsesNewestFirst(existingAnswers, [nextResponse])
          : existingAnswers;
      nextResponseStats = {
        ...(currentStats || {}),
        ...payload.responseStats,
        ...(mergedAnswers.length > 0 || payloadAnswers ? { answers: mergedAnswers } : {}),
      };
    }
  } else if (currentStats && nextResponse && ['shortAnswer', 'numerical'].includes(currentStats.type)) {
    nextResponseStats = {
      ...currentStats,
      total: payload?.responseCount ?? currentStats.total,
      answers: mergeResponsesNewestFirst(currentStats.answers || [], [nextResponse]),
    };
  }

  return {
    ...prev,
    responseCount: prev.session?.anonymous
      ? Math.max(Number(payload?.responseCount || 0), Number(prev?.responseCount || 0))
      : payload?.responseCount ?? prev?.responseCount,
    session: prev?.session
      ? {
        ...prev.session,
        joinedCount: payload?.joinedCount ?? prev.session?.joinedCount,
      }
      : prev?.session,
    allResponses: nextAllResponses,
    responseStats: nextResponseStats,
  };
}
