import { describe, expect, it } from 'vitest';
import { applyAttemptChanged } from '../../utils/liveSessionUpdates';
import { applyLiveResponseAddedDelta } from '../../utils/responses';

describe('presentation attempt updates', () => {
  const initial = {
    currentQuestion: { _id: 'q1', type: 0, sessionOptions: { stats: true, correct: true } },
    currentAttempt: { number: 1, closed: false },
    responseCount: 2,
    responseStats: { type: 'distribution', total: 2, distribution: [{ answer: '0', count: 2 }] },
    allResponses: [{ _id: 'old-response', attempt: 1 }],
  };

  it('clears old statistics, advances the attempt and accepts only the new response deltas', () => {
    const next = applyAttemptChanged(initial, {
      questionId: 'q1', currentAttempt: { number: 2, closed: false }, resetResponses: true, stats: false, correct: false,
    });
    expect(next).toMatchObject({ currentAttempt: { number: 2 }, responseCount: 0, allResponses: [],
      responseStats: null,
      currentQuestion: { sessionOptions: { stats: false, correct: false } } });
    const payload = { questionId: 'q1', attempt: 2, responseCount: 1,
      responseStats: { type: 'distribution', total: 1, distribution: [{ answer: '1', count: 1 }] } };
    expect(applyLiveResponseAddedDelta(next, payload).responseStats.total).toBe(1);
    expect(applyLiveResponseAddedDelta(next, { ...payload, attempt: 1 })).toBe(next);
  });

  it('also detects an attempt change without a reset flag and ignores other questions', () => {
    expect(applyAttemptChanged(initial, { questionId: 'q1', currentAttempt: { number: 2 } }).responseCount).toBe(0);
    expect(applyAttemptChanged(initial, { questionId: 'q2', currentAttempt: { number: 2 } })).toBe(initial);
    const closed = applyAttemptChanged(initial, { questionId: 'q1', currentAttempt: { number: 1, closed: true } });
    expect(closed.responseStats).toBe(initial.responseStats);
    expect(closed.currentAttempt.closed).toBe(true);
  });
});
