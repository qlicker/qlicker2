import { describe, expect, it } from 'vitest';
import { parseGrade } from '../../src/services/aiGradingRunner.js';

describe('AI grading response parsing', () => {
  it('recovers model JSON containing unescaped LaTeX backslashes', () => {
    const content = String.raw`{"points":3,"feedback":"Use \(x + 1\) here.","justification":"The response applies \alpha correctly."}`;

    expect(parseGrade(content, 5)).toEqual({
      points: 3,
      feedback: String.raw`Use \(x + 1\) here.`,
      justification: String.raw`The response applies \alpha correctly.`,
    });
  });

  it('continues to reject grades outside the allowed range', () => {
    expect(() => parseGrade('{"points":6,"feedback":"","justification":"Too high"}', 5))
      .toThrow('AI returned an invalid grade');
  });

  it('captures a quoted inappropriate-response flag', () => {
    const result = parseGrade(JSON.stringify({
      points: 1,
      feedback: 'Revise this response.',
      justification: 'The response does not answer the question.',
      inappropriate: { flagged: true, quote: 'quoted comment', reason: 'Abusive language' },
    }), 5);

    expect(result.inappropriate).toEqual({ quote: 'quoted comment', reason: 'Abusive language' });
  });
});
