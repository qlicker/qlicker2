// Keep URLs, headers, bodies and raw errors out of diagnostics: WebSocket URLs
// contain access tokens, and login bodies contain passwords.
export function connectionFailureDetails(response, role) {
  const numberOrZero = (value) => Number.isFinite(value) ? value : 0;
  return {
    role,
    status: numberOrZero(response?.status),
    errorCode: numberOrZero(response?.error_code),
    timings: {
      blocked: numberOrZero(response?.timings?.blocked),
      connecting: numberOrZero(response?.timings?.connecting),
      tlsHandshaking: numberOrZero(response?.timings?.tls_handshaking),
      waiting: numberOrZero(response?.timings?.waiting),
      duration: numberOrZero(response?.timings?.duration),
    },
  };
}

// Classify failures without printing raw errors (which can include token URLs).
export function connectionErrorKind(error) {
  const message = String(error || '').toLowerCase();
  if (message.includes('context canceled')) return 'execution_canceled';
  if (message.includes('broken pipe')) return 'broken_pipe';
  if (message.includes('connection reset')) return 'connection_reset';
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout';
  return 'other';
}

export function answerFailureDetails(response, { startedAt, completedAt, previousCompletedAt = 0, questionType, attemptNumber }) {
  return {
    ...connectionFailureDetails(response, 'student'),
    kind: connectionErrorKind(response?.error),
    protocol: ['HTTP/1.0', 'HTTP/1.1', 'HTTP/2.0'].includes(response?.proto) ? response.proto : 'unknown',
    elapsedMs: Math.max(0, completedAt - startedAt),
    sincePreviousAnswerMs: previousCompletedAt > 0 ? Math.max(0, startedAt - previousCompletedAt) : null,
    sendingMs: Number.isFinite(response?.timings?.sending) ? response.timings.sending : 0,
    receivingMs: Number.isFinite(response?.timings?.receiving) ? response.timings.receiving : 0,
    questionType,
    attemptNumber,
  };
}
