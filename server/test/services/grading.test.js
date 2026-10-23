import { describe, it, expect, vi } from 'vitest';
import {
  calculateResponsePoints,
  responseHasContent,
  getSessionGradingLockReason,
  DEFAULT_MS_SCORING_METHOD,
  ensureSessionMsScoringMethod,
  MS_SCORING_METHODS,
  getSessionMsScoringMethod,
  getQuestionPoints,
  normalizeQuestionType,
} from '../../src/services/grading.js';
import Session from '../../src/models/Session.js';

describe('grading service helpers', () => {
  it('uses Meteor-compatible right-minus-wrong scoring by default for multi-select', () => {
    const question = {
      type: 3,
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: true },
        { answer: 'C', correct: false },
        { answer: 'D', correct: false },
      ],
      sessionOptions: {
        points: 4,
        maxAttempts: 1,
        attempts: [{ number: 1, closed: false }],
      },
    };
    const response = {
      attempt: 1,
      answer: ['A'],
    };

    expect(DEFAULT_MS_SCORING_METHOD).toBe(MS_SCORING_METHODS.RIGHT_MINUS_WRONG);
    expect(calculateResponsePoints(question, response)).toBe(2);
  });

  it('supports all-or-nothing and correctness-ratio multi-select scoring modes', () => {
    const question = {
      type: 3,
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: true },
        { answer: 'C', correct: false },
        { answer: 'D', correct: false },
      ],
      sessionOptions: {
        points: 4,
        maxAttempts: 1,
        attempts: [{ number: 1, closed: false }],
      },
    };
    const response = {
      attempt: 1,
      answer: ['A'],
    };

    expect(
      calculateResponsePoints(question, response, { msScoringMethod: MS_SCORING_METHODS.ALL_OR_NOTHING })
    ).toBe(0);

    expect(
      calculateResponsePoints(question, response, { msScoringMethod: MS_SCORING_METHODS.CORRECTNESS_RATIO })
    ).toBe(3);
  });

  it('applies attempt weights when maxAttempts and attemptWeights are configured', () => {
    const question = {
      type: 0,
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: false },
      ],
      sessionOptions: {
        points: 4,
        maxAttempts: 2,
        attemptWeights: [1, 0.5],
      },
    };

    const firstAttempt = { attempt: 1, answer: 'A' };
    const secondAttempt = { attempt: 2, answer: 'A' };

    expect(calculateResponsePoints(question, firstAttempt)).toBe(4);
    expect(calculateResponsePoints(question, secondAttempt)).toBe(2);
  });

  it('keeps legacy default points behavior by question type', () => {
    expect(getQuestionPoints({ type: 2, sessionOptions: {} })).toBe(0);
    expect(getQuestionPoints({ type: 0, sessionOptions: {} })).toBe(1);
    expect(getQuestionPoints({ type: 6, sessionOptions: { points: 5 } })).toBe(0);
    expect(getQuestionPoints({ type: 2, sessionOptions: { points: 3 } })).toBe(3);
    expect(getQuestionPoints({ type: 0, sessionOptions: { points: 0 } })).toBe(0);
  });

  it('normalizes legacy numerical type 5 to canonical numerical', () => {
    expect(normalizeQuestionType({ type: 5, options: [] })).toBe(4);
  });

  it('normalizes malformed restored numerical rows with options back to option-based types', () => {
    expect(normalizeQuestionType({
      type: 4,
      options: [
        { answer: 'True', correct: true },
        { answer: 'False', correct: false },
      ],
    })).toBe(1);

    expect(normalizeQuestionType({
      type: 4,
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: true },
        { answer: 'C', correct: false },
      ],
    })).toBe(3);

    expect(normalizeQuestionType({
      type: 4,
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: false },
      ],
    })).toBe(0);
  });

  it('does not award points for zero-point questions even with a correct answer', () => {
    const question = {
      type: 0,
      options: [
        { answer: 'A', correct: true },
        { answer: 'B', correct: false },
      ],
      sessionOptions: {
        points: 0,
        maxAttempts: 1,
        attempts: [{ number: 1, closed: false }],
      },
    };
    const response = {
      attempt: 1,
      answer: 'A',
    };

    expect(calculateResponsePoints(question, response)).toBe(0);
  });

  it('normalizes session multi-select scoring strategy values', () => {
    expect(getSessionMsScoringMethod({ msScoringMethod: 'ALL-OR-NOTHING' }))
      .toBe(MS_SCORING_METHODS.ALL_OR_NOTHING);
    expect(getSessionMsScoringMethod({ msScoringMethod: 'unknown-mode' }))
      .toBe(DEFAULT_MS_SCORING_METHOD);
  });

  it('backfills missing session scoring mode to the default when persistence is enabled', async () => {
    const updateSpy = vi.spyOn(Session, 'updateOne')
      .mockResolvedValue({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
    const findByIdSpy = vi.spyOn(Session, 'findById')
      .mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'legacy-session',
          msScoringMethod: DEFAULT_MS_SCORING_METHOD,
        }),
      });

    const result = await ensureSessionMsScoringMethod({
      _id: 'legacy-session',
      msScoringMethod: undefined,
    });

    expect(result.changed).toBe(true);
    expect(result.msScoringMethod).toBe(DEFAULT_MS_SCORING_METHOD);
    expect(result.session.msScoringMethod).toBe(DEFAULT_MS_SCORING_METHOD);
    expect(updateSpy).toHaveBeenCalledWith(
      { _id: 'legacy-session', msScoringMethod: { $ne: DEFAULT_MS_SCORING_METHOD } },
      { $set: { msScoringMethod: DEFAULT_MS_SCORING_METHOD } }
    );
    expect(findByIdSpy).toHaveBeenCalledWith('legacy-session');

    updateSpy.mockRestore();
    findByIdSpy.mockRestore();
  });

  it('does not persist when session scoring mode is already valid', async () => {
    const updateSpy = vi.spyOn(Session, 'updateOne')
      .mockResolvedValue({ acknowledged: true, matchedCount: 0, modifiedCount: 0 });
    const findByIdSpy = vi.spyOn(Session, 'findById')
      .mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

    const result = await ensureSessionMsScoringMethod({
      _id: 'valid-session',
      msScoringMethod: MS_SCORING_METHODS.CORRECTNESS_RATIO,
    });

    expect(result.changed).toBe(false);
    expect(result.msScoringMethod).toBe(MS_SCORING_METHODS.CORRECTNESS_RATIO);
    expect(updateSpy).toHaveBeenCalledWith(
      { _id: 'valid-session', msScoringMethod: { $ne: MS_SCORING_METHODS.CORRECTNESS_RATIO } },
      { $set: { msScoringMethod: MS_SCORING_METHODS.CORRECTNESS_RATIO } }
    );
    expect(findByIdSpy).not.toHaveBeenCalled();

    updateSpy.mockRestore();
    findByIdSpy.mockRestore();
  });

  it('normalizes legacy uppercase values and persists canonical lowercase values', async () => {
    const updateSpy = vi.spyOn(Session, 'updateOne')
      .mockResolvedValue({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
    const findByIdSpy = vi.spyOn(Session, 'findById')
      .mockReturnValue({
        lean: vi.fn().mockResolvedValue({
          _id: 'legacy-uppercase',
          msScoringMethod: MS_SCORING_METHODS.ALL_OR_NOTHING,
        }),
      });

    const result = await ensureSessionMsScoringMethod({
      _id: 'legacy-uppercase',
      msScoringMethod: 'ALL-OR-NOTHING',
    });

    expect(result.changed).toBe(true);
    expect(result.msScoringMethod).toBe(MS_SCORING_METHODS.ALL_OR_NOTHING);
    expect(result.session.msScoringMethod).toBe(MS_SCORING_METHODS.ALL_OR_NOTHING);
    expect(updateSpy).toHaveBeenCalledWith(
      { _id: 'legacy-uppercase', msScoringMethod: { $ne: MS_SCORING_METHODS.ALL_OR_NOTHING } },
      { $set: { msScoringMethod: MS_SCORING_METHODS.ALL_OR_NOTHING } }
    );
    expect(findByIdSpy).toHaveBeenCalledWith('legacy-uppercase');

    updateSpy.mockRestore();
    findByIdSpy.mockRestore();
  });
});


describe('Grading content and readiness', () => {
  it.each([undefined, {}, { answer: '' }, { answer: '  ' }, { answer: '<p><br></p>', answerWysiwyg: '<p>&nbsp;</p>' }, { answer: [] }])('recognizes blank responses: %j', (response) => {
    expect(responseHasContent(response)).toBe(false);
  });
  it.each([{ answer: 0 }, { answer: '0' }, { answer: '', answerWysiwyg: '<p>Answer</p>' }, { answer: '', answerWysiwyg: '<img src="/image" />' }])('keeps real response content: %j', (response) => {
    expect(responseHasContent(response)).toBe(true);
  });
  it('unlocks grading when extensions expire, including the exact closing boundary', () => {
    const session = { status: 'done', quiz: true, quizExtensions: [{ quizEnd: new Date(1000) }] };
    expect(getSessionGradingLockReason(session, 1000)).toBe('extensions');
    expect(getSessionGradingLockReason(session, 1001)).toBe(null);
    expect(getSessionGradingLockReason({ ...session, status: 'running' }, 1001)).toBe('not-ended');
  });
});
