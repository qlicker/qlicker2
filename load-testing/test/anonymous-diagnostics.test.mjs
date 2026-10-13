import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAnonymousStatsValidator } from '../scenarios/anonymous-diagnostics.js';

test('anonymous batches allow repeated and out-of-order safe publications, isolate attempts', () => {
  const validate = createAnonymousStatsValidator();
  for (const total of [8, 4, 12, 8]) assert.deepEqual(validate({ total }, 15, 'question').reasons, []);
  assert.deepEqual(validate({ total: 5 }, 15, 'question').reasons, ['publication_gap']);
  assert.deepEqual(validate({ total: 5 }, 15, 'question', 2).reasons, []);
  assert.deepEqual(validate(null, 0, 'question').reasons, []);
});

test('diagnostics distinguish count races, small batches and exposed answer metadata', () => {
  const validate = createAnonymousStatsValidator();
  assert.deepEqual(validate({ total: 8 }, 7, 'q').reasons, ['published_exceeds_count']);
  assert.deepEqual(validate({ total: 3 }, 3, 'q').reasons, ['below_minimum']);
  const result = validate({ total: 4, answers: [{ answer: 'private text', studentId: 'private-id' }] }, 4, 'q');
  assert.deepEqual(result.reasons, ['answer_metadata']);
  assert.doesNotMatch(JSON.stringify(result), /private text|private-id/);
  assert.deepEqual(validate({ total: 4 }, 4, 'q').reasons, []);
  assert.deepEqual(validate({ total: 6 }, 6, 'q').reasons, ['publication_gap']);
  assert.deepEqual(validate({ total: 8 }, 8, 'q').reasons, []);
});

test('bounded neighbor lookup has the same gap decisions as full publication history', () => {
  const validate = createAnonymousStatsValidator();
  const totals = new Set([0]);
  for (let i = 0; i < 3000; i += 1) {
    const total = 4 + ((i * 71) % 500);
    const gap = [...totals].some((previous) => previous !== total && Math.abs(previous - total) < 4);
    assert.equal(validate({ total }, 600, 'q').reasons.includes('publication_gap'), gap);
    if (!gap) totals.add(total);
  }
});
