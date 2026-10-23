export function applyCurrentQuestionUpdate(prev, payload) {
  if (!prev) return prev;

  const nextQuestionId = String(payload?.questionId || '');
  const currentQuestionId = String(prev?.currentQuestion?._id || prev?.session?.currentQuestion || '');
  if (!nextQuestionId || currentQuestionId !== nextQuestionId) return prev;

  return {
    ...prev,
    currentQuestion: payload?.question ?? null,
    questionHidden: payload?.questionHidden ?? prev.questionHidden,
    showStats: payload?.showStats ?? prev.showStats,
    showCorrect: payload?.showCorrect ?? prev.showCorrect,
  };
}

export function applyAttemptChanged(prev, payload) {
  if (!prev) return prev;

  const nextQuestionId = String(payload?.questionId || '');
  const currentQuestionId = String(prev?.currentQuestion?._id || prev?.session?.currentQuestion || '');
  if (!nextQuestionId || currentQuestionId !== nextQuestionId) return prev;

  const previousAttemptNumber = prev?.currentAttempt?.number ?? null;
  const nextAttemptNumber = payload?.currentAttempt?.number ?? previousAttemptNumber;
  const resetResponses = !!payload?.resetResponses || nextAttemptNumber !== previousAttemptNumber;

  return {
    ...prev,
    currentAttempt: payload?.currentAttempt ?? prev.currentAttempt,
    showStats: payload?.stats ?? prev.showStats,
    showCorrect: payload?.correct ?? prev.showCorrect,
    currentQuestion: prev.currentQuestion
      ? {
        ...prev.currentQuestion,
        sessionOptions: {
          ...(prev.currentQuestion.sessionOptions || {}),
          stats: payload?.stats ?? prev.currentQuestion?.sessionOptions?.stats,
          correct: payload?.correct ?? prev.currentQuestion?.sessionOptions?.correct,
        },
      }
      : prev.currentQuestion,
    responseCount: resetResponses ? 0 : prev.responseCount,
    allResponses: resetResponses ? [] : prev.allResponses,
    responseStats: resetResponses ? null : prev.responseStats,
    wordCloudData: resetResponses ? null : prev.wordCloudData,
    histogramData: resetResponses ? null : prev.histogramData,
    studentResponse: resetResponses ? null : prev.studentResponse,
  };
}

export function applyVisibilityChanged(prev, payload) {
  if (!prev || !Object.prototype.hasOwnProperty.call(payload || {}, 'question')) return prev;

  if (payload.questionId && prev.session?.currentQuestion
    && String(payload.questionId) !== String(prev.session.currentQuestion)) return prev;
  const nextQuestion = payload.question;
  return {
    ...prev,
    currentQuestion: nextQuestion,
    currentAttempt: payload?.currentAttempt ?? prev.currentAttempt,
    questionHidden: payload?.questionHidden ?? payload?.hidden ?? prev.questionHidden,
    showStats: payload?.showStats ?? payload?.stats ?? prev.showStats,
    showCorrect: payload?.showCorrect ?? payload?.correct ?? prev.showCorrect,
    showResponseList: payload?.showResponseList ?? payload?.responseListVisible ?? prev.showResponseList,
    responseStats: payload?.responseStats ?? null,
    allResponses: [],
    wordCloudData: payload?.wordCloudData ?? null,
    histogramData: payload?.histogramData ?? null,
  };
}

export function applyQuestionChanged(prev, payload) {
  if (!prev || !Object.prototype.hasOwnProperty.call(payload || {}, 'question')) return prev;
  return {
    ...prev,
    session: prev.session ? { ...prev.session, currentQuestion: payload.questionId ?? prev.session.currentQuestion } : prev.session,
    currentQuestion: payload.question,
    currentAttempt: payload?.currentAttempt ?? null,
    studentResponse: payload?.studentResponse ?? null,
    responseStats: payload?.responseStats ?? null,
    allResponses: [],
    questionHidden: payload?.questionHidden ?? true,
    showStats: payload?.showStats ?? false,
    showCorrect: payload?.showCorrect ?? false,
    showResponseList: payload?.showResponseList ?? true,
    wordCloudData: payload?.wordCloudData ?? null,
    histogramData: payload?.histogramData ?? null,
    questionNumber: payload?.questionNumber ?? prev.questionNumber,
    questionCount: payload?.questionCount ?? prev.questionCount,
    pageProgress: payload?.pageProgress ?? prev.pageProgress,
    questionProgress: payload?.questionProgress ?? prev.questionProgress,
  };
}

export function applyJoinCodeChanged(prev, payload) {
  if (!prev?.session) return prev;
  return {
    ...prev,
    session: {
      ...prev.session,
      joinCodeEnabled: payload?.joinCodeEnabled ?? prev.session.joinCodeEnabled,
      joinCodeActive: payload?.joinCodeActive ?? prev.session.joinCodeActive,
      joinCodeInterval: payload?.joinCodeInterval ?? prev.session.joinCodeInterval,
      currentJoinCode: payload?.currentJoinCode ?? prev.session.currentJoinCode,
    },
  };
}

export function applyVisualizationChanged(prev, payload, field) {
  if (!prev) return prev;
  const questionId = prev.currentQuestion?._id || prev.session?.currentQuestion;
  if (payload?.questionId && String(payload.questionId) !== String(questionId)) return prev;
  const value = payload?.[field];
  return { ...prev, [field]: prev.showStats && value?.visible ? value : null };
}
