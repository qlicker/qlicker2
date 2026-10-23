export function buildReviewableWarningMessage(t, warning) {
  const manualCount = Number(warning?.nonAutoGradeableCount) || 0;
  const noResponseCount = Number(warning?.noResponseCount) || 0;

  if (manualCount > 0 && noResponseCount > 0) {
    return t('professor.liveSession.reviewableWarningCombined', {
      manualCount,
      noResponseCount,
    });
  }
  if (manualCount > 0) {
    return t('professor.liveSession.reviewableWarningManualOnly', {
      count: manualCount,
    });
  }
  return t('professor.liveSession.reviewableWarningNoResponsesOnly', {
    count: noResponseCount,
  });
}

export async function toggleSessionReviewable({
  apiClient,
  sessionId,
  reviewable,
}) {
  const response = await apiClient.patch(`/sessions/${sessionId}/reviewable`, { reviewable });
  return response.data;
}
