import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResponseMerger } from '../scenarios/response-merge.js';

function getTimestampMs(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

// Previous load-test implementation, retained as the behavioral reference.
function getResponseMergeKey(response = {}) {
  const responseId = String(response?._id || '').trim();
  if (responseId) return `id:${responseId}`;

  return [
    Number(response?.attempt || 0),
    String(response?.questionId || ''),
    String(response?.studentName || ''),
    String(response?.answer ?? ''),
    String(response?.answerWysiwyg ?? ''),
    getTimestampMs(response?.updatedAt || response?.createdAt),
  ].join('|');
}

function sortResponsesNewestFirst(responses = []) {
  return responses
    .map((response) => ({
      response,
      timestamp: getTimestampMs(response?.updatedAt || response?.createdAt),
      id: String(response?._id || ''),
    }))
    .sort((a, b) => {
      const timestampDiff = b.timestamp - a.timestamp;
      if (timestampDiff !== 0) return timestampDiff;
      return b.id.localeCompare(a.id);
    })
    .map(({ response }) => response);
}

function mergeResponsesNewestFirst(existingResponses = [], incomingResponses = []) {
  const mergedByKey = new Map();
  [...(Array.isArray(existingResponses) ? existingResponses : []), ...(Array.isArray(incomingResponses) ? incomingResponses : [])]
    .forEach((response) => {
      if (!response) return;
      mergedByKey.set(getResponseMergeKey(response), response);
    });
  return sortResponsesNewestFirst([...mergedByKey.values()]);
}


test('incremental k6 response merge matches prior ordering, deduplication and updates', () => {
  const merge = createResponseMerger();
  let actual = [];
  let expected = [];
  for (let i = 0; i < 2000; i += 1) {
    const response = Object.freeze({ _id: `response-${(i * 71) % 503}`, answer: `answer-${i}`,
      createdAt: new Date(1700000000000 + (i * 29) % 100).toISOString(),
      ...(i % 7 === 0 ? { updatedAt: new Date(1700000000200 + i).toISOString() } : {}),
    });
    Object.freeze(actual);
    expected = mergeResponsesNewestFirst(expected, [response]);
    actual = merge(actual, [response]);
    assert.deepEqual(actual, expected);
  }
});

test('snapshots and legacy responses preserve the canonical fallback rules', () => {
  const merge = createResponseMerger();
  const snapshots = [null, [], [null, { answer: 'legacy', createdAt: 'bad-date' },
    { _id: 'z', createdAt: '2026-01-01' }, { _id: 'a', createdAt: '2026-01-01' },
    { _id: 'z', answer: 'last wins', createdAt: '2026-01-01' },
    { answer: 'different legacy', createdAt: 'bad-date' }]];
  for (const initial of snapshots) {
    let actual = initial;
    let expected = initial;
    for (const added of [[], [null], [{ answer: 'legacy' }],
      [{ _id: 'a', answer: 'update' }], [{ _id: 'b' }, { _id: 'c' }], [{ _id: 'b', answer: 'updated' }]]) {
      expected = mergeResponsesNewestFirst(expected, added);
      actual = merge(actual, added);
      assert.deepEqual(actual, expected);
    }
  }
});

test('owned mutable histories match canonical sorting across every update without allocating new arrays', () => {
  const merge = createResponseMerger({ mutable: true });
  let actual = merge([], []);
  let expected = [];
  for (let i = 0; i < 2000; i += 1) {
    const response = { _id: `response-${(i * 71) % 503}`, answer: `answer-${i}`,
      createdAt: new Date(1700000000000 + (i * 29) % 100).toISOString() };
    expected = mergeResponsesNewestFirst(expected, [response]);
    const previous = actual;
    actual = merge(actual, [response]);
    assert.equal(actual, previous);
    assert.deepEqual(actual, expected);
  }
  const old = actual;
  const snapshot = [null, { answer: 'legacy' }, { _id: 'new-snapshot-entry' }];
  expected = mergeResponsesNewestFirst(expected, snapshot);
  actual = merge(actual, snapshot);
  assert.notEqual(actual, old);
  assert.deepEqual(actual, expected);
});

test('independent answer lists and new question snapshots do not share mutable histories', () => {
  const merge = createResponseMerger({ mutable: true });
  const source = Object.freeze([Object.freeze({ _id: 'seed' })]);
  const first = merge(source, [{ _id: 'first' }]);
  const second = merge(source, [{ _id: 'second' }]);
  merge(first, [{ _id: 'third' }]);
  assert.deepEqual(second.map((r) => r._id), ['seed', 'second']);
  assert.deepEqual(source, [{ _id: 'seed' }]);
  assert.deepEqual(merge([], [{ _id: 'new-question' }]), [{ _id: 'new-question' }]);
});
