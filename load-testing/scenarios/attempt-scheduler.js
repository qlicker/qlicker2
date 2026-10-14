// Pure timer coordination for the protocol load client. Every live state change
// is reconsidered; an event must not leave a separate "window open" flag stale.
export function readLiveVisibilityFlag(data, key) {
  const field = { hidden: 'questionHidden', stats: 'showStats', correct: 'showCorrect' }[key];
  if (!field) return undefined;
  return Boolean(data?.[field] ?? data?.currentQuestion?.sessionOptions?.[key]);
}

export function getLiveAttemptKey(snapshot) {
  const questionId = String(snapshot?.currentQuestion?._id || '').trim();
  const attemptNumber = Number(snapshot?.currentAttempt?.number || 0);
  return questionId && attemptNumber > 0 ? `${questionId}:${attemptNumber}` : null;
}

export function canAnswer(snapshot, liveStatsDuringAnswers) {
  return Boolean(getLiveAttemptKey(snapshot)
    && snapshot?.session?.status === 'running'
    && snapshot?.isJoined
    && !snapshot.studentResponse
    && !snapshot.currentAttempt.closed
    && !readLiveVisibilityFlag(snapshot, 'hidden')
    && (liveStatsDuringAnswers || !readLiveVisibilityFlag(snapshot, 'stats'))
    && !readLiveVisibilityFlag(snapshot, 'correct'));
}

export function createAttemptScheduler({ getSnapshot, isOpen, delayFor, setTimeout,
  submit, onStale = () => {}, onTimer = () => {}, now = Date.now }) {
  const pending = new Set();
  const submitted = new Set();
  const consider = () => {
    const snapshot = getSnapshot();
    const key = getLiveAttemptKey(snapshot);
    if (!key || !isOpen(snapshot) || pending.has(key) || submitted.has(key)) return;
    pending.add(key);
    const delay = Math.max(1, Math.ceil(delayFor(snapshot)));
    const due = now() + delay;
    setTimeout(async () => {
      const latest = getSnapshot();
      onTimer(Math.max(0, now() - due));
      const changed = getLiveAttemptKey(latest) !== key;
      if (changed || !isOpen(latest)) {
        pending.delete(key);
        onStale(changed ? 'attempt_changed' : 'window_closed');
        consider();
        return;
      }
      try {
        if (await submit(latest)) submitted.add(key);
      } finally {
        pending.delete(key);
      }
    }, delay);
  };
  return consider;
}
