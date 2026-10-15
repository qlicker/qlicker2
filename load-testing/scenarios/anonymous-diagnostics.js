// Pure validation shared by k6 and Node regression tests. Never return answer
// text, participant identifiers, or payloads in diagnostic details.
export const privacyFailureReasons = [
  'invalid_total', 'below_minimum', 'published_exceeds_count', 'answer_metadata',
  'publication_gap', 'response_identity', 'response_timestamp', 'missing_snapshot',
  'live_response_rows', 'live_joined_rows', 'participant_identity', 'result_identity',
];

export function createAnonymousStatsValidator() {
  const publishedTotals = new Map();
  return (stats, responseCount, questionId, attempt = 1) => {
    const reasons = [];
    if (stats == null) return { reasons };
    const total = Number(stats.total);
    const details = { total, responseCount };
    if (!Number.isInteger(total)) reasons.push('invalid_total');
    if (total < 4) reasons.push('below_minimum');
    if (total > responseCount) reasons.push('published_exceeds_count');
    if (!Array.isArray(stats.answers || []) || !(stats.answers || []).every((entry) =>
      entry && Object.keys(entry).every((key) => key === 'answer' || key === 'answerWysiwyg'))) {
      reasons.push('answer_metadata');
    }
    if (reasons.length) return { reasons, ...details };
    const key = `${questionId}:${attempt}`;
    const totals = publishedTotals.get(key) || new Set([0]);
    // Only the six nearest integer totals can violate the four-person gap.
    // Avoid scanning an ever-growing history for every broadcast to every VU.
    for (let gap = -3; gap <= 3; gap += 1) {
      if (gap !== 0 && totals.has(total + gap)) {
        return { reasons: ['publication_gap'], ...details, previousTotal: total + gap };
      }
    }
    totals.add(total);
    publishedTotals.set(key, totals);
    return { reasons, ...details };
  };
}
