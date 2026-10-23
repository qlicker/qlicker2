import { describe, expect, it } from 'vitest';

import { applyLiveResponseAddedDelta, mergeResponsesNewestFirst } from './responses';

it('merges a response received in both an anonymous HTTP snapshot and a websocket delta exactly once', () => {
  const anonymous = { answer: 'A shared response', createdAt: '2026-09-18T10:00:00.000Z' };
  const delta = { ...anonymous, _id: 'r1', questionId: 'q1', attempt: 1, answerWysiwyg: '' };
  const next = mergeResponsesNewestFirst([anonymous], [delta]);
  expect(next).toEqual([delta]);
  expect(mergeResponsesNewestFirst(next, [delta])).toEqual([delta]);
  // Two students may submit the same text at the same time.
  const second = { ...delta, _id: 'r2' };
  expect(mergeResponsesNewestFirst([anonymous, anonymous], [delta, second])).toHaveLength(2);
  expect(mergeResponsesNewestFirst([delta], [second])).toHaveLength(2);
});

describe('applyLiveResponseAddedDelta', () => {
  it('merges a compact numerical delta into the accumulated response list', () => {
    const previousResponse = {
      _id: 'response-1',
      answer: '5',
      createdAt: '2026-04-01T23:59:00.000Z',
      updatedAt: '2026-04-01T23:59:00.000Z',
    };
    const nextResponse = {
      _id: 'response-2',
      answer: '7.5',
      createdAt: '2026-04-02T00:00:00.000Z',
      updatedAt: '2026-04-02T00:00:00.000Z',
    };
    const prev = {
      currentQuestion: { _id: 'question-1' },
      currentAttempt: { number: 1 },
      responseCount: 1,
      session: { joinedCount: 2 },
      allResponses: [previousResponse],
      responseStats: {
        type: 'numerical',
        total: 1,
        answers: [previousResponse],
        mean: 5,
      },
    };

    const next = applyLiveResponseAddedDelta(prev, {
      questionId: 'question-1',
      attempt: 1,
      responseCount: 2,
      joinedCount: 2,
      response: nextResponse,
      responseStats: {
        type: 'numerical',
        total: 2,
        mean: 6.25,
        stdev: 1.25,
        median: 7.5,
        min: 5,
        max: 7.5,
      },
    });

    expect(next.allResponses.map(({ _id }) => _id)).toEqual(['response-2', 'response-1']);
    expect(next.responseStats.answers.map(({ _id }) => _id)).toEqual(['response-2', 'response-1']);
    expect(next.responseStats).toMatchObject({ total: 2, mean: 6.25, max: 7.5 });
  });

  it('keeps the full short-answer stats payload when it is included in the delta', () => {
    const createdAt = '2026-04-02T00:00:00.000Z';
    const prev = {
      currentQuestion: {
        _id: 'question-1',
        sessionOptions: { stats: true },
      },
      currentAttempt: { number: 1 },
      responseCount: 0,
      session: { joinedCount: 1 },
      allResponses: [],
      responseStats: null,
    };

    const next = applyLiveResponseAddedDelta(prev, {
      questionId: 'question-1',
      attempt: 1,
      responseCount: 2,
      joinedCount: 1,
      response: {
        _id: 'response-2',
        attempt: 1,
        questionId: 'question-1',
        answer: 'Newest answer',
        answerWysiwyg: '<p>Newest answer</p>',
        createdAt,
        updatedAt: createdAt,
        studentName: 'Student One',
      },
      responseStats: {
        type: 'shortAnswer',
        total: 2,
        answers: [
          {
            answer: 'Newest answer',
            answerWysiwyg: '<p>Newest answer</p>',
            createdAt,
            updatedAt: createdAt,
          },
          {
            answer: 'Older answer',
            answerWysiwyg: '<p>Older answer</p>',
            createdAt: '2026-04-01T23:59:00.000Z',
            updatedAt: '2026-04-01T23:59:00.000Z',
          },
        ],
      },
    });

    expect(next.responseCount).toBe(2);
    expect(next.responseStats).toEqual({
      type: 'shortAnswer',
      total: 2,
      answers: [
        {
          answer: 'Newest answer',
          answerWysiwyg: '<p>Newest answer</p>',
          createdAt,
          updatedAt: createdAt,
        },
        {
          answer: 'Older answer',
          answerWysiwyg: '<p>Older answer</p>',
          createdAt: '2026-04-01T23:59:00.000Z',
          updatedAt: '2026-04-01T23:59:00.000Z',
        },
      ],
    });
    expect(next.allResponses).toHaveLength(1);
  });

  it('keeps the full numerical stats payload when it is included in the delta', () => {
    const prev = {
      currentQuestion: {
        _id: 'question-1',
        sessionOptions: { stats: true },
      },
      currentAttempt: { number: 1 },
      responseCount: 1,
      session: { joinedCount: 1 },
      allResponses: [],
      responseStats: null,
    };

    const next = applyLiveResponseAddedDelta(prev, {
      questionId: 'question-1',
      attempt: 1,
      responseCount: 2,
      joinedCount: 1,
      response: {
        _id: 'response-2',
        attempt: 1,
        questionId: 'question-1',
        answer: '7.5',
        createdAt: '2026-04-02T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
      },
      responseStats: {
        type: 'numerical',
        total: 2,
        values: [5, 7.5],
        answers: [
          {
            answer: '7.5',
            createdAt: '2026-04-02T00:00:00.000Z',
            updatedAt: '2026-04-02T00:00:00.000Z',
          },
          {
            answer: '5',
            createdAt: '2026-04-01T23:59:00.000Z',
            updatedAt: '2026-04-01T23:59:00.000Z',
          },
        ],
        mean: 6.25,
        stdev: 1.25,
        median: 7.5,
        min: 5,
        max: 7.5,
      },
    });

    expect(next.responseCount).toBe(2);
    expect(next.responseStats).toEqual({
      type: 'numerical',
      total: 2,
      values: [5, 7.5],
      answers: [
        {
          answer: '7.5',
          createdAt: '2026-04-02T00:00:00.000Z',
          updatedAt: '2026-04-02T00:00:00.000Z',
        },
        {
          answer: '5',
          createdAt: '2026-04-01T23:59:00.000Z',
          updatedAt: '2026-04-01T23:59:00.000Z',
        },
      ],
      mean: 6.25,
      stdev: 1.25,
      median: 7.5,
      min: 5,
      max: 7.5,
    });
    expect(next.allResponses).toHaveLength(1);
  });
});

it('applies anonymous batches without collapsing identical answers or regressing on late events', () => {
  const initial = {
    session: { anonymous: true }, currentQuestion: { _id: 'q1' }, currentAttempt: { number: 1 },
    responseStats: null, responseCount: 0,
  };
  const batch = (count) => ({
    questionId: 'q1', attempt: 1, responseCount: count,
    responseStats: { type: 'shortAnswer', total: count, answers: Array.from({ length: count }, () => ({ answer: 'Same answer' })) },
  });
  const first = applyLiveResponseAddedDelta(initial, batch(4));
  expect(first.responseStats.answers).toHaveLength(4);
  const fifth = applyLiveResponseAddedDelta(first, { questionId: 'q1', attempt: 1, responseCount: 5 });
  expect(fifth.responseCount).toBe(5);
  expect(fifth.responseStats).toEqual(first.responseStats);
  const eighth = applyLiveResponseAddedDelta(fifth, batch(8));
  expect(eighth.responseStats.answers).toHaveLength(8);
  const late = applyLiveResponseAddedDelta(eighth, batch(4));
  expect(late.responseStats).toEqual(eighth.responseStats);
  expect(late.responseCount).toBe(8);
  expect(applyLiveResponseAddedDelta(eighth, { ...batch(12), attempt: 2 })).toEqual(eighth);
});
