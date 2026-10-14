import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResponseCoverage, hasCompleteResultRows } from '../scenarios/response-coverage.js';

test('repeated aggregate repair notifications and reordered counts do not inflate coverage', () => {
  const coverage = createResponseCoverage(['q1', 'q2'], 5);
  for (const count of [1, 3, 5, 4, 5, 5]) coverage.observe({ questionId: 'q1', attempt: 2, responseCount: count });
  assert.deepEqual(coverage.results(), [true, false]);
  coverage.observe({ questionId: 'q2', attempt: 2, responseCount: 5 });
  assert.deepEqual(coverage.results(), [true, true]);
});

test('missing or excess answers fail, and an old attempt cannot complete a newer one', () => {
  const coverage = createResponseCoverage(['q1', 'q2', 'q3'], 5);
  coverage.observe({ questionId: 'q1', attempt: 1, responseCount: 5 });
  coverage.observe({ questionId: 'q1', attempt: 2, responseCount: 4 });
  coverage.observe({ questionId: 'q1', attempt: 1, responseCount: 5 });
  coverage.observe({ questionId: 'q2', attempt: 1, responseCount: 6 });
  coverage.observe({ questionId: 'q3', attempt: 1, responseCount: 'invalid' });
  assert.deepEqual(coverage.results(), [false, false, false]);
});

function row(studentId) {
  return { studentId, questionResults: ['q1', 'q2'].map((questionId) => ({ questionId, responses: [{}] })) };
}

test('final results require unique participants and exactly one persisted answer for each question', () => {
  const valid = [row('s1'), row('s2')];
  assert.equal(hasCompleteResultRows(valid, ['q1', 'q2'], ['s1', 's2'], false), true);
  for (const invalid of [[row('s1'), row('s1')], [row('s1'), row('stranger')], [row('s1')]]) {
    assert.equal(hasCompleteResultRows(invalid, ['q1', 'q2'], ['s1', 's2'], false), false);
  }
  for (const responses of [[], [{}, {}], 'x']) {
    const invalid = [row('s1'), row('s2')];
    invalid[0].questionResults[0].responses = responses;
    assert.equal(hasCompleteResultRows(invalid, ['q1', 'q2'], ['s1', 's2'], false), false);
  }
  valid[0].questionResults.push(valid[0].questionResults[0]);
  assert.equal(hasCompleteResultRows(valid, ['q1', 'q2'], ['s1', 's2'], false), false);
});

test('anonymous results use unique anonymous labels, with suppression below four participants', () => {
  const ids = ['s1', 's2', 's3', 's4'];
  const rows = ['Respondent 1', 'Respondent 2', 'Respondent 3', 'Respondent 4'].map(row);
  assert.equal(hasCompleteResultRows(rows, ['q1', 'q2'], ids, true), true);
  rows[3] = rows[0];
  assert.equal(hasCompleteResultRows(rows, ['q1', 'q2'], ids, true), false);
  assert.equal(hasCompleteResultRows([], ['q1', 'q2'], ids.slice(0, 3), true), true);
  assert.equal(hasCompleteResultRows([row('Respondent 1')], ['q1', 'q2'], ids.slice(0, 3), true), false);
});
