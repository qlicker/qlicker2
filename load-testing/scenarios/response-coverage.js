// Notifications are not response records. Anonymous /live repair can publish
// another notification for the same count, without creating another answer.
export function createResponseCoverage(questionIds, expectedCount) {
  const observed = new Map();
  return {
    observe(data) {
      const count = Number(data?.responseCount);
      const attempt = Number(data?.attempt);
      if (!Number.isInteger(count) || count < 0 || !Number.isInteger(attempt) || attempt <= 0) return;
      const id = String(data.questionId || '');
      const previous = observed.get(id);
      if (!previous || attempt > previous.attempt) observed.set(id, { attempt, count });
      else if (attempt === previous.attempt) previous.count = Math.max(previous.count, count);
    },
    results() {
      return questionIds.map((id) => observed.get(String(id))?.count === expectedCount);
    },
  };
}

export function hasCompleteResultRows(rows, questionIds, participantIds, anonymous) {
  if (!Array.isArray(rows)) return false;
  const expectedRows = anonymous && participantIds.length < 4 ? 0 : participantIds.length;
  if (rows.length !== expectedRows) return false;
  const expectedIds = new Set(participantIds.map(String));
  const seen = new Set();
  return rows.every((row) => {
    const id = String(row?.studentId || '');
    if (!id || seen.has(id) || (!anonymous && !expectedIds.has(id))) return false;
    seen.add(id);
    if (!Array.isArray(row.questionResults)) return false;
    return questionIds.every((questionId) => {
      const results = row.questionResults.filter((result) => String(result?.questionId) === String(questionId));
      return results.length === 1 && Array.isArray(results[0].responses) && results[0].responses.length === 1;
    });
  });
}
