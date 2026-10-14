import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerFailureDetails, connectionErrorKind, connectionFailureDetails } from '../scenarios/connection-diagnostics.js';

test('connection failures expose timing phases without leaking credentials', () => {
  const details = connectionFailureDetails({
    status: 0,
    error_code: 1050,
    error: 'timeout wss://example.com/ws?token=secret-token',
    url: 'wss://example.com/ws?token=secret-token',
    request: { body: '{"password":"secret-password"}' },
    headers: { Authorization: 'Bearer secret-token' },
    timings: { blocked: 60000, connecting: 60000, tls_handshaking: 0, waiting: 0, duration: 0 },
  }, 'student');
  assert.deepEqual(details, {
    role: 'student', status: 0, errorCode: 1050,
    timings: { blocked: 60000, connecting: 60000, tlsHandshaking: 0, waiting: 0, duration: 0 },
  });
  assert.doesNotMatch(JSON.stringify(details), /secret|password|token|example\.com/);
});

test('an absent WebSocket response still produces safe diagnostics', () => {
  assert.deepEqual(connectionFailureDetails(undefined, 'professor'), {
    role: 'professor', status: 0, errorCode: 0,
    timings: { blocked: 0, connecting: 0, tlsHandshaking: 0, waiting: 0, duration: 0 },
  });
});

test('answer failure diagnostics distinguish transport errors without leaking request data', () => {
  const details = answerFailureDetails({
    status: 0, error_code: 1201, proto: 'HTTP/2.0',
    error: 'write: broken pipe https://example.com/ws?token=secret',
    request: { body: 'private answer', headers: { Authorization: 'Bearer secret' } },
    timings: { sending: 12, receiving: 0, waiting: 3 },
  }, { startedAt: 100000, completedAt: 104000, previousCompletedAt: 40000, questionType: 2, attemptNumber: 1 });
  assert.equal(details.kind, 'broken_pipe');
  assert.equal(details.elapsedMs, 4000);
  assert.equal(details.sincePreviousAnswerMs, 60000);
  assert.equal(details.protocol, 'HTTP/2.0');
  assert.equal(details.sendingMs, 12);
  assert.doesNotMatch(JSON.stringify(details), /secret|private|example|Authorization/);
  assert.equal(answerFailureDetails(undefined, { startedAt: 1, completedAt: 2 }).sincePreviousAnswerMs, null);
});

test('shutdown cancellation is distinguishable from connection failures', () => {
  assert.equal(connectionErrorKind('context canceled at recordSyncTiming'), 'execution_canceled');
  assert.equal(connectionErrorKind('read: connection reset by peer'), 'connection_reset');
  assert.equal(connectionErrorKind('request timed out'), 'timeout');
  assert.equal(connectionErrorKind('wss://example.com/?token=secret'), 'other');
});
