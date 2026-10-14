import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canAnswer, createAttemptScheduler } from '../scenarios/attempt-scheduler.js';

function fixture(liveStats = false) {
  let snapshot = { session: { status: 'running' }, isJoined: true,
    currentQuestion: { _id: 'q1' }, currentAttempt: { number: 2, closed: false }, questionHidden: true };
  let now = 0;
  const timers = [];
  const answers = [];
  const stale = [];
  const lag = [];
  const consider = createAttemptScheduler({
    getSnapshot: () => snapshot, isOpen: (value) => canAnswer(value, liveStats),
    delayFor: () => 100, now: () => now,
    setTimeout: (callback, delay) => timers.push({ callback, due: now + delay }),
    submit: (value) => { answers.push([value.currentQuestion._id, value.currentAttempt.number]); return true; },
    onStale: (reason) => stale.push(reason), onTimer: (value) => lag.push(value),
  });
  return { answers, stale, lag, timers,
    update: (patch) => { snapshot = { ...snapshot, ...patch }; consider(); },
    wake: (late = 0) => { const timer = timers.shift(); now = timer.due + late; return timer.callback(); },
  };
}

test('visibility followed by an attempt event still submits once for that open attempt', async () => {
  const f = fixture();
  f.update({ questionHidden: false });
  f.update({ currentAttempt: { number: 2, closed: false } });
  assert.equal(f.timers.length, 1);
  await f.wake();
  f.update({ currentAttempt: { number: 2, closed: false } });
  assert.deepEqual(f.answers, [['q1', 2]]);
  assert.equal(f.timers.length, 0);
  assert.deepEqual(f.stale, []);
});

test('new attempt while a timer is pending cannot submit the old timer against the new attempt', async () => {
  const f = fixture();
  f.update({ questionHidden: false });
  f.update({ currentAttempt: { number: 3, closed: false } });
  await f.wake();
  assert.deepEqual(f.answers, []);
  assert.deepEqual(f.stale, ['attempt_changed']);
  await f.wake();
  assert.deepEqual(f.answers, [['q1', 3]]);
});

test('navigation drops an old-question timer and schedules the newly exposed question', async () => {
  const f = fixture();
  f.update({ questionHidden: false });
  f.update({ questionHidden: true, currentQuestion: { _id: 'q2' } });
  await f.wake();
  assert.deepEqual(f.answers, []);
  f.update({ questionHidden: false });
  await f.wake();
  assert.deepEqual(f.answers, [['q2', 2]]);
});

for (const patch of [{ questionHidden: true }, { showCorrect: true }, { showStats: true },
  { currentAttempt: { number: 2, closed: true } }, { session: { status: 'done' } },
  { session: { status: 'upcoming' } }, { session: { status: 'draft' } }, { isJoined: false },
  { studentResponse: { answer: 'already answered' } }]) {
  test(`pending answers respect the latest gate: ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    f.update({ questionHidden: false });
    f.update(patch);
    await f.wake();
    assert.deepEqual(f.answers, []);
  });
}

test('stats-on workload answers visible questions and records local timer lateness', async () => {
  const f = fixture(true);
  f.update({ questionHidden: false, showStats: true });
  await f.wake(321);
  assert.deepEqual(f.answers, [['q1', 2]]);
  assert.deepEqual(f.lag, [321]);
});

test('hidden sessionOptions fallback prevents joining an answer window prematurely', async () => {
  const f = fixture();
  f.update({ questionHidden: undefined, currentQuestion: { _id: 'q1', sessionOptions: { hidden: true } } });
  assert.equal(f.timers.length, 0);
});

test('in-flight HTTP submission allows state updates but prevents duplicate submissions', async () => {
  const snapshot = { currentQuestion: { _id: 'q1' }, currentAttempt: { number: 1 } };
  let callback;
  let finish;
  let submissions = 0;
  const consider = createAttemptScheduler({
    getSnapshot: () => snapshot, isOpen: () => true, delayFor: () => 1,
    setTimeout: (value) => { callback = value; },
    submit: () => { submissions += 1; return new Promise((resolve) => { finish = resolve; }); },
  });
  consider();
  const active = callback();
  callback = null;
  consider();
  assert.equal(callback, null);
  assert.equal(submissions, 1);
  finish(true);
  await active;
  consider();
  assert.equal(callback, null);
});
