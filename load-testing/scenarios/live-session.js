/**
 * live-session.js — k6 load test for a realistic Qlicker interactive session.
 *
 * The professor drives a five-question live session through the same REST
 * endpoints the real UI uses. Students:
 *   • log in with seeded accounts
 *   • fetch /sessions/:id/live
 *   • join the running session
 *   • keep a WebSocket open for live deltas
 *   • re-fetch /live when the app would refresh its state
 *   • submit responses for each open attempt
 *   • create and upvote chat activity on selected question waves
 *
 * This exercises both the real-time transport and the "device stays in sync"
 * path the browser actually uses during class.
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import { connectionFailureDetails } from './connection-diagnostics.js';
import { createAnonymousStatsValidator, privacyFailureReasons } from './anonymous-diagnostics.js';

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveFloat(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return fallback;
}

function clampFraction(value, fallback) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return 0;
  if (parsed >= 1) return 1;
  return parsed;
}

function seededRatio(a = 0, b = 0, c = 0) {
  const hash = (((a + 1) * 73856093) ^ ((b + 1) * 19349663) ^ ((c + 1) * 83492791)) >>> 0;
  return (hash % 1000) / 1000;
}

function shouldParticipate(fraction, a = 0, b = 0, c = 0) {
  if (fraction <= 0) return false;
  if (fraction >= 1) return true;
  return seededRatio(a, b, c) < fraction;
}

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const API = `${BASE_URL}/api/v1`;
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';
const STATE_FILE = __ENV.STATE_FILE || '../state.json';
const LIVE_STATS_DURING_ANSWERS = parseBoolean(__ENV.LIVE_STATS_DURING_ANSWERS, false);

const ANSWER_WINDOW_S = parseNonNegativeInt(__ENV.ANSWER_WINDOW_S || '30', 30);
const STATS_PAUSE_S = parseNonNegativeInt(__ENV.STATS_PAUSE_S || '15', 15);
const CORRECT_PAUSE_S = parseNonNegativeInt(__ENV.CORRECT_PAUSE_S || '15', 15);
const JOIN_GRACE_S = parseNonNegativeInt(__ENV.JOIN_GRACE_S || '5', 5);
const RESPONSE_JITTER_MS = parseNonNegativeInt(__ENV.RESPONSE_JITTER_MS || '2000', 2000);
const RESPONSE_ADDED_REFRESH_MS = parseNonNegativeInt(__ENV.RESPONSE_ADDED_REFRESH_MS || '2000', 2000);
const STUDENT_LOGIN_SPREAD_S = parsePositiveFloat(__ENV.STUDENT_LOGIN_SPREAD_S || '12', 12);
const CHAT_ACTIVITY_EVERY_N_QUESTIONS = parsePositiveInt(__ENV.CHAT_ACTIVITY_EVERY_N_QUESTIONS || '2', 2);
const CHAT_VIEWER_STUDENT_FRACTION = clampFraction(__ENV.CHAT_VIEWER_STUDENT_FRACTION || '0.2', 0.2);
const CHAT_QUICK_POST_STUDENT_FRACTION = clampFraction(__ENV.CHAT_QUICK_POST_STUDENT_FRACTION || '0.15', 0.15);
const CHAT_RANDOM_POST_STUDENT_FRACTION = clampFraction(__ENV.CHAT_RANDOM_POST_STUDENT_FRACTION || '0.03', 0.03);
const CHAT_RANDOM_UPVOTE_STUDENT_FRACTION = clampFraction(__ENV.CHAT_RANDOM_UPVOTE_STUDENT_FRACTION || '0.08', 0.08);
const CHAT_ACTION_JITTER_MS = parseNonNegativeInt(__ENV.CHAT_ACTION_JITTER_MS || '1500', 1500);
const CHAT_REPLY_PROFESSOR_LIMIT = parseNonNegativeInt(__ENV.CHAT_REPLY_PROFESSOR_LIMIT || '3', 3);
const PROFESSOR_REPLY_DELAY_MS = parseNonNegativeInt(__ENV.PROFESSOR_REPLY_DELAY_MS || '1500', 1500);
const CHAT_EVENT_REFRESH_DEBOUNCE_MS = 150;
const PROFESSOR_OBSERVER_TICK_MS = 250;

const state = JSON.parse(open(STATE_FILE));
const external = !!state.session.external;
const anonymous = !!state.session.anonymous;
const SESSION_CHAT_ENABLED = parseBoolean(__ENV.SESSION_CHAT_ENABLED, !external && !anonymous);
if (state.session.quiz) throw new Error('The live workload requires an interactive fixture');
if (SESSION_CHAT_ENABLED && (external || anonymous)) {
  throw new Error('Use SESSION_CHAT_ENABLED=false for shared/anonymous comparisons and their baseline');
}
if (external && __ENV.ENROLLED_PERCENT !== undefined
  && Number(__ENV.ENROLLED_PERCENT) !== state.session.enrolledPercent) {
  throw new Error('Enrollment mix differs from the fixture; reseed before comparing runs');
}
let participantKind = 'enrolled';
const students = new SharedArray('students', () => state.students);
const responseQuestionCount = (Array.isArray(state.questions) ? state.questions : [])
  .filter((question) => normalizeQuestionType(question) !== 6)
  .length;
const expectedResponseCount = students.length * responseQuestionCount;

const redeemDuration = new Trend('activity_redeem_duration', true);
const redeemSuccess = new Rate('activity_redeem_success');
const resultsDuration = new Trend('results_duration', true);
const resultsSuccess = new Rate('results_success');
const gradeContractSuccess = new Rate('grade_contract_success');
const privacySuccess = new Rate('anonymous_privacy_success');
const privacyFailures = new Counter('anonymous_privacy_failures');
const responseEventChars = new Trend('response_event_chars');
const anonymousBatchStatsSuccess = new Rate('anonymous_batch_stats_success');
const questionResponseCountSuccess = new Rate('question_response_count_success');

const loginDuration = new Trend('login_duration', true);
const loginBlockedDuration = new Trend('login_blocked_duration', true);
const loginConnectingDuration = new Trend('login_connecting_duration', true);
const loginTlsHandshakingDuration = new Trend('login_tls_handshaking_duration', true);
const loginWaitingDuration = new Trend('login_waiting_duration', true);
const joinDuration = new Trend('join_duration', true);
const respondDuration = new Trend('respond_duration', true);
const liveRefreshDuration = new Trend('live_refresh_duration', true);
const eventSyncDuration = new Trend('event_sync_duration', true);
const eventDeliveryDuration = new Trend('event_delivery_duration', true);
const eventApplyDuration = new Trend('event_apply_duration', true);
const chatRefreshDuration = new Trend('chat_refresh_duration', true);
const chatEventSyncDuration = new Trend('chat_event_sync_duration', true);
const chatEventDeliveryDuration = new Trend('chat_event_delivery_duration', true);
const chatEventApplyDuration = new Trend('chat_event_apply_duration', true);
const professorActionDuration = new Trend('professor_action_duration', true);
const responseToProfessorDuration = new Trend('response_to_professor_duration', true);
const responseServerProcessingDuration = new Trend('response_server_processing_duration', true);
const responseDeliveryToProfessorDuration = new Trend('response_delivery_to_professor_duration', true);
const professorObserverLoopLag = new Trend('professor_observer_loop_lag', true);

const wsConnections = new Counter('ws_connections');
const wsErrors = new Counter('ws_errors');
const wsHandshakeFailures = new Counter('ws_handshake_failures');
const responseAddedRefreshes = new Counter('response_added_refreshes');
const professorResponseEvents = new Counter('professor_response_events');
const professorDriverCompletions = new Counter('professor_driver_completions');
const professorViewerCompletions = new Counter('professor_viewer_completions');
const studentFlowCompletions = new Counter('student_flow_completions');
const respondAttempts = new Counter('respond_attempts');
const respondSuccessfulSubmissions = new Counter('respond_successful_submissions');
const respondConflictFailures = new Counter('respond_conflict_failures');
const respondRejectedFailures = new Counter('respond_rejected_failures');
const respondServerFailures = new Counter('respond_server_failures');
const respondStaleTimerSkips = new Counter('respond_stale_timer_skips');
const invalidServerTimestamps = new Counter('invalid_server_timestamps');
const chatQuickPostToggles = new Counter('chat_quick_post_toggles');
const chatPostsCreated = new Counter('chat_posts_created');
const chatVotesApplied = new Counter('chat_votes_applied');
const chatRepliesCreated = new Counter('chat_replies_created');

const loginSuccess = new Rate('login_success');
const joinSuccess = new Rate('join_success');
const respondSuccess = new Rate('respond_success');
const liveRefreshSuccess = new Rate('live_refresh_success');
const eventSyncSuccess = new Rate('event_sync_success');
const wsConnectSuccess = new Rate('ws_connect_success');
const professorActionSuccess = new Rate('professor_action_success');
const sessionCompletion = new Rate('session_completion');
const chatRefreshSuccess = new Rate('chat_refresh_success');
const chatEventSyncSuccess = new Rate('chat_event_sync_success');
const chatActionSuccess = new Rate('chat_action_success');

const thresholds = {
  http_req_failed: [{ threshold: 'rate==0', abortOnFail: true }],
  ws_errors: ['count==0'],
  ws_handshake_failures: ['count==0'],
  'login_success{role:student}': ['rate==1'],
  'login_success{role:professor}': ['rate==1'],
  join_success: ['rate==1'],
  respond_success: ['rate==1'],
  professor_driver_completions: ['count==1'],
  professor_viewer_completions: ['count==1'],
  student_flow_completions: [`count==${students.length}`],
  professor_response_events: [`count==${expectedResponseCount}`],
  respond_attempts: [`count==${expectedResponseCount}`],
  respond_successful_submissions: [`count==${expectedResponseCount}`],
  respond_conflict_failures: ['count==0'],
  respond_rejected_failures: ['count==0'],
  respond_server_failures: ['count==0'],
  respond_stale_timer_skips: ['count==0'],
  invalid_server_timestamps: ['count==0'],
  'live_refresh_success{role:student}': ['rate==1'],
  'live_refresh_success{role:professor}': ['rate==1'],
  'event_sync_success{role:student}': ['rate==1'],
  'event_sync_success{role:professor}': ['rate==1'],
  'ws_connect_success{role:student}': ['rate==1'],
  'ws_connect_success{role:professor}': ['rate==1'],
  professor_action_success: ['rate==1'],
  professor_action_duration: ['p(95)<3000'],
  ...(!anonymous ? { response_to_professor_duration: ['p(95)<3000'] } : {}),
  response_delivery_to_professor_duration: ['p(99)<3000'],
  results_success: ['rate==1'],
  grade_contract_success: ['rate==1'],
  question_response_count_success: ['rate==1'],
  results_duration: ['p(95)<3000'],
  ...(anonymous ? { anonymous_privacy_success: ['rate==1'], anonymous_batch_stats_success: ['rate==1'],
    ...Object.fromEntries(privacyFailureReasons.map((reason) => [`anonymous_privacy_failures{reason:${reason}}`, ['count==0']])),
  } : {}),
  ...(external ? { activity_redeem_success: ['rate==1'], activity_redeem_duration: ['p(95)<3000'] } : {}),
  session_completion: ['rate==1'],
  'login_duration{role:student}': ['p(95)<3000'],
  'login_duration{role:professor}': ['p(95)<3000'],
  join_duration: ['p(95)<3000'],
  respond_duration: ['p(95)<3000'],
  'live_refresh_duration{role:student}': ['p(99)<3000'],
  'live_refresh_duration{role:professor}': ['p(99)<3000'],
  'event_sync_duration{role:student}': ['p(99)<3000'],
  'event_sync_duration{role:professor}': ['p(99)<3000'],
};

for (const kind of ['enrolled', 'guest']) {
  if (!students.some((student) => (student.enrolled === false ? 'guest' : 'enrolled') === kind)) continue;
  for (const metric of ['join_duration', 'respond_duration', 'live_refresh_duration', 'event_sync_duration']) {
    thresholds[`${metric}{participant:${kind}}`] = ['p(95)<3000', 'p(99)<3000'];
  }
}

if (SESSION_CHAT_ENABLED) {
  Object.assign(thresholds, {
    chat_action_success: ['rate==1'],
    'chat_refresh_success{role:student}': ['rate==1'],
    'chat_refresh_success{role:professor}': ['rate==1'],
    'chat_event_sync_success{role:student}': ['rate==1'],
    'chat_event_sync_success{role:professor}': ['rate==1'],
    'chat_refresh_duration{role:student}': ['p(99)<3000'],
    'chat_refresh_duration{role:professor}': ['p(99)<3000'],
    'chat_event_sync_duration{role:student}': ['p(99)<3000'],
    'chat_event_sync_duration{role:professor}': ['p(99)<3000'],
  });
}

export const options = {
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  tags: {
    scenario_name: state.session.scenario,
    enrolled_percent: String(state.session.enrolledPercent ?? 100),
    shared: String(external), anonymous: String(anonymous),
    live_stats: String(LIVE_STATS_DURING_ANSWERS),
  },
  scenarios: {
    professor: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      exec: 'professorFlow',
      maxDuration: '20m',
    },
    professor_viewer: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      exec: 'professorViewerFlow',
      maxDuration: '20m',
      startTime: '1s',
    },
    students: {
      executor: 'per-vu-iterations',
      vus: students.length,
      iterations: 1,
      exec: 'studentFlow',
      maxDuration: '20m',
      startTime: '3s',
    },
  },
  thresholds,
};

function metricTags(role, extra = {}) {
  return { role, ...(role === 'student' ? { participant: participantKind } : {}), ...extra };
}

function apiHeaders(token) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function login(email, password, role) {
  const response = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: apiHeaders(), tags: { name: 'login' } },
  );
  const details = connectionFailureDetails(response, role);
  const tags = metricTags(role);
  loginBlockedDuration.add(details.timings.blocked, tags);
  loginConnectingDuration.add(details.timings.connecting, tags);
  loginTlsHandshakingDuration.add(details.timings.tlsHandshaking, tags);
  loginWaitingDuration.add(details.timings.waiting, tags);
  if (response.status !== 200) {
    console.warn(`Login failed: ${JSON.stringify(details)}`);
  }
  return response;
}

function jsonRequest(method, path, token, payload, tagName) {
  const body = payload === undefined ? null : JSON.stringify(payload);
  return http.request(method, `${API}${path}`, body, {
    headers: apiHeaders(token),
    tags: { name: tagName },
  });
}

function parseJson(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function parseTimestampMs(value) {
  if (value == null || value === '') return null;
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function normalizeSocketTimeoutMs(value) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 1;
  return Math.max(1, Math.ceil(timeoutMs));
}

function recordSyncTiming({
  endToEndMetric,
  deliveryMetric,
  applyMetric,
  role,
  reason,
  syncContext,
  startedAtMs,
  completedAtMs,
}) {
  const tags = metricTags(role, { event: reason });
  const receivedAtMs = Number(syncContext?.receivedAtMs || startedAtMs || completedAtMs);
  const emittedAtMs = parseTimestampMs(syncContext?.emittedAt);

  if (Number.isFinite(receivedAtMs) && completedAtMs >= receivedAtMs) {
    applyMetric.add(completedAtMs - receivedAtMs, tags);
  }

  let baselineMs = receivedAtMs;
  if (emittedAtMs != null) {
    if (Number.isFinite(receivedAtMs) && emittedAtMs <= receivedAtMs) {
      deliveryMetric.add(receivedAtMs - emittedAtMs, tags);
      baselineMs = emittedAtMs;
    } else {
      invalidServerTimestamps.add(1, { event: reason, relation: 'emitted_after_received' });
    }
  }

  if (Number.isFinite(baselineMs) && completedAtMs >= baselineMs) {
    endToEndMetric.add(completedAtMs - baselineMs, tags);
  }
}

function isTrueFalseOptions(options = []) {
  if (!Array.isArray(options) || options.length !== 2) return false;
  const labels = options.map((option) => String(option?.answer || option?.plainText || option?.content || '')
    .replace(/<[^>]*>/g, ' ')
    .trim()
    .toUpperCase());
  return labels.includes('TRUE') && labels.includes('FALSE');
}

function countCorrectOptions(options = []) {
  return (Array.isArray(options) ? options : []).filter((option) => !!option?.correct).length;
}

function normalizeQuestionType(question = {}) {
  const rawType = Number(question?.type);
  const options = Array.isArray(question?.options) ? question.options : [];

  if ([0, 1, 2, 3, 6].includes(rawType)) return rawType;
  if (rawType === 4) {
    if (options.length > 1) {
      if (isTrueFalseOptions(options)) return 1;
      return countCorrectOptions(options) > 1 ? 3 : 0;
    }
    return 4;
  }
  if (rawType === 5) return 4;
  return 2;
}

function fetchLive(token, role, reason = 'live_refresh') {
  const startedAtMs = Date.now();
  const res = http.get(`${API}/sessions/${state.session.id}/live`, {
    headers: apiHeaders(token),
    tags: { name: reason },
  });
  const completedAtMs = Date.now();
  liveRefreshDuration.add(completedAtMs - startedAtMs, metricTags(role));

  const ok = res.status === 200;
  liveRefreshSuccess.add(ok, metricTags(role));
  if (!ok) {
    return {
      ok: false,
      data: null,
      res,
      startedAtMs,
      completedAtMs,
    };
  }

  return {
    ok: true,
    data: checkLivePrivacy(parseJson(res), role),
    res,
    startedAtMs,
    completedAtMs,
  };
}

// k6 module state is private to each VU. Preserve checks across out-of-order
// events and reconnects, but keep failure samples bounded and identity-free.
const validateAnonymousStats = createAnonymousStatsValidator();
const privacySamples = new Map();
function recordPrivacy(reasons, details = {}) {
  privacySuccess.add(reasons.length === 0);
  for (const reason of reasons) {
    privacyFailures.add(1, { reason });
    const samples = privacySamples.get(reason) || 0;
    // The professor observer sees all publications; one student VU supplies a
    // participant view. Never log thousands of copies of the same failure.
    if ((details.role === 'professor' || exec.vu.idInTest <= 3) && samples < 3) {
      privacySamples.set(reason, samples + 1);
      console.warn(`Anonymous privacy check failed: ${JSON.stringify({ reason, ...details })}`);
    }
  }
}

function checkResponsePrivacy(data, role) {
  const { reasons, ...counts } = validateAnonymousStats(data.responseStats, data.responseCount, data.questionId, data.attempt);
  if (data.response != null) reasons.push('response_identity');
  if (data.responseSubmittedAt != null) reasons.push('response_timestamp');
  if (reasons.length === 0) { privacySuccess.add(true); return; }
  recordPrivacy(reasons, { role, source: 'response_event',
    question: state.questions.findIndex((question) => String(question.id) === String(data.questionId)) + 1,
    attempt: data.attempt, ...counts });
}

function checkLivePrivacy(snapshot, role) {
  if (anonymous && role === 'professor') {
    const serialized = JSON.stringify(snapshot);
    const { reasons, ...counts } = validateAnonymousStats(snapshot?.responseStats, snapshot?.responseCount,
      snapshot?.currentQuestion?._id, snapshot?.currentAttempt?.number);
    if (!snapshot) reasons.push('missing_snapshot');
    if ((snapshot?.allResponses || []).length !== 0) reasons.push('live_response_rows');
    if ((snapshot?.session?.joinedStudents || []).length !== 0) reasons.push('live_joined_rows');
    if (students.some((student) => serialized?.includes(student.id))) reasons.push('participant_identity');
    recordPrivacy(reasons, { role, source: 'live_snapshot', ...counts });
  }
  return snapshot;
}

export function setup() {
  if (anonymous) privacyFailureReasons.forEach((reason) => privacyFailures.add(0, { reason }));
  console.log(JSON.stringify({ workload: state.session.scenario, participants: students.length,
    enrolled: students.filter((student) => student.enrolled !== false).length,
    anonymous, shared: external, chat: SESSION_CHAT_ENABLED, liveStats: LIVE_STATS_DURING_ANSWERS }));
}

function verifyFinalResults(token) {
  const response = jsonRequest('GET', `/sessions/${state.session.id}/results`, token, undefined, 'final_results');
  resultsDuration.add(response.timings.duration);
  const payload = parseJson(response) || {};
  const rows = payload.studentResults || [];
  const expectedRows = anonymous && students.length < 4 ? 0 : students.length;
  const questions = state.questions.filter((question) => normalizeQuestionType(question) !== 6);
  const complete = response.status === 200 && rows.length === expectedRows && rows.every((row) =>
    questions.every((question) => row.questionResults?.some((result) =>
      String(result.questionId) === String(question.id) && result.responses?.length === 1)));
  resultsSuccess.add(complete);
  check(response, { 'all participants have correlated, complete result rows': () => complete });
  if (anonymous) {
    const serialized = JSON.stringify(payload);
    recordPrivacy(!serialized.includes('anon_') && students.every((student) =>
      !serialized.includes(student.id) && !serialized.includes(student.email)) ? [] : ['result_identity'],
    { role: 'professor', source: 'final_results' });
  }
  const grades = jsonRequest('GET', `/sessions/${state.session.id}/grades`, token, undefined, 'final_grades');
  const gradeRows = parseJson(grades)?.grades || [];
  const enrolledIds = new Set(students.filter((student) => student.enrolled !== false).map((student) => student.id));
  const contractOk = grades.status === 200
    && gradeRows.length === (anonymous ? 0 : enrolledIds.size)
    && gradeRows.every((grade) => enrolledIds.has(grade.userId))
    && (anonymous || rows.every((row) => !!row.guest === !enrolledIds.has(row.studentId)));
  gradeContractSuccess.add(contractOk);
  check(grades, { 'only eligible enrolled participants receive grades': () => contractOk });
}

function readLiveVisibilityFlag(data, key) {
  if (key === 'hidden') {
    if (data?.questionHidden !== undefined) return Boolean(data.questionHidden);
    return Boolean(data?.currentQuestion?.sessionOptions?.hidden);
  }
  if (key === 'stats') {
    if (data?.showStats !== undefined) return Boolean(data.showStats);
    return Boolean(data?.currentQuestion?.sessionOptions?.stats);
  }
  if (key === 'correct') {
    if (data?.showCorrect !== undefined) return Boolean(data.showCorrect);
    return Boolean(data?.currentQuestion?.sessionOptions?.correct);
  }
  return undefined;
}

function validateLiveState(data, expectation = {}) {
  if (!data) return false;

  if (expectation.status !== undefined && String(data?.session?.status || '') !== String(expectation.status)) {
    return false;
  }
  if (expectation.isJoined !== undefined && Boolean(data?.isJoined) !== Boolean(expectation.isJoined)) {
    return false;
  }
  if (expectation.questionNumber !== undefined && Number(data?.questionNumber || 0) !== Number(expectation.questionNumber)) {
    return false;
  }
  if (expectation.hidden !== undefined && readLiveVisibilityFlag(data, 'hidden') !== Boolean(expectation.hidden)) {
    return false;
  }
  if (expectation.stats !== undefined && readLiveVisibilityFlag(data, 'stats') !== Boolean(expectation.stats)) {
    return false;
  }
  if (expectation.correct !== undefined && readLiveVisibilityFlag(data, 'correct') !== Boolean(expectation.correct)) {
    return false;
  }
  if (
    expectation.attemptNumber !== undefined
    && Number(data?.currentAttempt?.number || 0) !== Number(expectation.attemptNumber)
  ) {
    return false;
  }
  if (
    expectation.attemptClosed !== undefined
    && Boolean(data?.currentAttempt?.closed) !== Boolean(expectation.attemptClosed)
  ) {
    return false;
  }
  if (expectation.requireWordCloud && !data?.wordCloudData) {
    return false;
  }
  if (expectation.requireHistogram && !data?.histogramData) {
    return false;
  }

  return true;
}

function refreshLiveAfterEvent(token, role, reason, expectation = {}, syncContext = null) {
  const result = fetchLive(token, role, `live_${reason}`);
  const ok = result.ok && validateLiveState(result.data, expectation);
  recordSyncTiming({
    endToEndMetric: eventSyncDuration,
    deliveryMetric: eventDeliveryDuration,
    applyMetric: eventApplyDuration,
    role,
    reason,
    syncContext,
    startedAtMs: result.startedAtMs,
    completedAtMs: result.completedAtMs,
  });
  eventSyncSuccess.add(ok, metricTags(role));
  return result.ok ? result.data : null;
}

function syncLiveAfterEvent(currentData, role, updater, expectation = {}, syncContext = null, reason = 'delta') {
  const startedAtMs = Date.now();
  const nextData = updater(currentData);
  const completedAtMs = Date.now();
  const ok = Boolean(nextData) && validateLiveState(nextData, expectation);
  recordSyncTiming({
    endToEndMetric: eventSyncDuration,
    deliveryMetric: eventDeliveryDuration,
    applyMetric: eventApplyDuration,
    role,
    reason,
    syncContext,
    startedAtMs,
    completedAtMs,
  });
  eventSyncSuccess.add(ok, metricTags(role));
  return nextData;
}

function buildQueryString(params = {}) {
  const entries = Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (entries.length === 0) return '';
  return `?${entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&')}`;
}

function getTimestampMs(value) {
  if (!value) return 0;
  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortChatPosts(posts = []) {
  return [...posts].sort((a, b) => {
    const voteDiff = (Number(b?.upvoteCount) || 0) - (Number(a?.upvoteCount) || 0);
    if (voteDiff !== 0) return voteDiff;
    const createdDiff = getTimestampMs(a?.createdAt) - getTimestampMs(b?.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return String(a?._id || '').localeCompare(String(b?._id || ''));
  });
}

function sortQuickPostOptions(options = []) {
  return [...options]
    .filter((option) => Number(option?.questionNumber) > 0)
    .sort((a, b) => {
      const questionDiff = Number(b?.questionNumber || 0) - Number(a?.questionNumber || 0);
      if (questionDiff !== 0) return questionDiff;
      const voteDiff = (Number(b?.upvoteCount) || 0) - (Number(a?.upvoteCount) || 0);
      if (voteDiff !== 0) return voteDiff;
      return String(a?.postId || '').localeCompare(String(b?.postId || ''));
    });
}

function buildQuickPostsFromOptions(options = []) {
  return sortQuickPostOptions(options)
    .filter((option) => Number(option?.upvoteCount || 0) > 0)
    .map((option) => ({
      postId: option.postId,
      questionNumber: option.questionNumber,
      label: option.label,
      upvoteCount: option.upvoteCount,
      viewerHasUpvoted: !!option.viewerHasUpvoted,
    }));
}

function mergeChatPost(existingPost = {}, incomingPost = {}) {
  return {
    ...existingPost,
    ...incomingPost,
    comments: incomingPost?.comments ?? existingPost?.comments ?? [],
    viewerHasUpvoted: incomingPost?.viewerHasUpvoted ?? existingPost?.viewerHasUpvoted ?? false,
    isOwnPost: incomingPost?.isOwnPost ?? existingPost?.isOwnPost ?? false,
  };
}

function mergeQuickPostOption(existingOption = {}, incomingOption = {}) {
  return {
    ...existingOption,
    ...incomingOption,
    viewerHasUpvoted: incomingOption?.viewerHasUpvoted ?? existingOption?.viewerHasUpvoted ?? false,
  };
}

function applyChatEventData(previousData, eventPayload) {
  if (!previousData || !eventPayload) return null;

  const nextData = { ...previousData };
  let posts = Array.isArray(previousData?.posts) ? [...previousData.posts] : [];
  let quickPostOptions = Array.isArray(previousData?.quickPostOptions)
    ? [...previousData.quickPostOptions]
    : Array.isArray(previousData?.quickPosts)
      ? [...previousData.quickPosts]
      : [];

  const postId = String(
    eventPayload?.postId
      || eventPayload?.post?._id
      || eventPayload?.quickPostOption?.postId
      || ''
  );

  if (eventPayload?.currentQuestionNumber !== undefined && eventPayload?.currentQuestionNumber !== null) {
    nextData.currentQuestionNumber = eventPayload.currentQuestionNumber;
  }

  if (eventPayload?.post !== undefined) {
    if (eventPayload.post) {
      const incomingPost = eventPayload.post;
      const existingIndex = posts.findIndex((post) => String(post?._id || '') === String(incomingPost?._id || ''));
      if (existingIndex >= 0) {
        posts[existingIndex] = mergeChatPost(posts[existingIndex], incomingPost);
      } else {
        posts.push(mergeChatPost({}, incomingPost));
      }
    } else if (postId) {
      posts = posts.filter((post) => String(post?._id || '') !== postId);
    }
  }

  if (eventPayload?.quickPostOption !== undefined) {
    if (eventPayload.quickPostOption) {
      const incomingOption = eventPayload.quickPostOption;
      const existingIndex = quickPostOptions.findIndex((option) => String(option?.postId || '') === String(incomingOption?.postId || ''));
      if (existingIndex >= 0) {
        quickPostOptions[existingIndex] = mergeQuickPostOption(quickPostOptions[existingIndex], incomingOption);
      } else {
        quickPostOptions.push(mergeQuickPostOption({}, incomingOption));
      }
    } else if (postId) {
      quickPostOptions = quickPostOptions.filter((option) => String(option?.postId || '') !== postId);
    }
  }

  const currentQuestionNumber = nextData?.currentQuestionNumber ?? null;
  nextData.posts = sortChatPosts(posts);
  nextData.quickPostOptions = sortQuickPostOptions(quickPostOptions).filter((option) => (
    currentQuestionNumber === null || Number(option?.questionNumber || 0) < Number(currentQuestionNumber)
  ));
  nextData.quickPosts = buildQuickPostsFromOptions(nextData.quickPostOptions);

  return nextData;
}

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

function applyLiveResponseAddedDelta(previousData, eventPayload = {}) {
  if (!previousData) return previousData;

  const currentQuestionId = String(previousData?.currentQuestion?._id || previousData?.session?.currentQuestion || '');
  const payloadQuestionId = String(eventPayload?.questionId || '');
  if (currentQuestionId && payloadQuestionId && payloadQuestionId !== currentQuestionId) {
    return previousData;
  }

  const currentAttemptNumber = Number(previousData?.currentAttempt?.number || 0);
  const payloadAttemptNumber = Number(eventPayload?.attempt || currentAttemptNumber || 0);
  if (currentAttemptNumber > 0 && payloadAttemptNumber > 0 && payloadAttemptNumber !== currentAttemptNumber) {
    return previousData;
  }

  const nextResponse = eventPayload?.response || null;
  const nextAllResponses = nextResponse
    ? mergeResponsesNewestFirst(previousData?.allResponses || [], [nextResponse])
    : (Array.isArray(previousData?.allResponses) ? previousData.allResponses : []);

  const currentStats = previousData?.responseStats;
  let nextResponseStats = currentStats;

  const staleAnonymousStats = previousData.session?.anonymous
    && Number(eventPayload?.responseStats?.total || 0) < Number(currentStats?.total || 0);
  if (eventPayload?.responseStats && typeof eventPayload.responseStats === 'object' && !staleAnonymousStats) {
    if (eventPayload.responseStats.type === 'distribution') {
      nextResponseStats = eventPayload.responseStats;
    } else {
      const existingAnswers = Array.isArray(currentStats?.answers) ? currentStats.answers : [];
      const payloadAnswers = Array.isArray(eventPayload.responseStats.answers)
        ? eventPayload.responseStats.answers
        : null;
      const mergedAnswers = payloadAnswers
        ? payloadAnswers
        : nextResponse
          ? mergeResponsesNewestFirst(existingAnswers, [nextResponse])
          : existingAnswers;
      nextResponseStats = {
        ...(currentStats || {}),
        ...eventPayload.responseStats,
        ...(mergedAnswers.length > 0 || payloadAnswers ? { answers: mergedAnswers } : {}),
      };
    }
  } else if (currentStats && nextResponse && ['shortAnswer', 'numerical'].includes(currentStats.type)) {
    nextResponseStats = {
      ...currentStats,
      total: eventPayload?.responseCount ?? currentStats.total,
      answers: mergeResponsesNewestFirst(currentStats.answers || [], [nextResponse]),
    };
  }

  return {
    ...previousData,
    responseCount: previousData.session?.anonymous
      ? Math.max(Number(eventPayload?.responseCount || 0), Number(previousData?.responseCount || 0))
      : eventPayload?.responseCount ?? previousData?.responseCount,
    session: previousData?.session
      ? {
        ...previousData.session,
        joinedCount: eventPayload?.joinedCount ?? previousData.session?.joinedCount,
      }
      : previousData?.session,
    allResponses: nextAllResponses,
    responseStats: nextResponseStats,
  };
}

function applyAttemptChangedDelta(previousData, eventPayload = {}) {
  if (!previousData) return previousData;
  const currentQuestionId = String(previousData?.currentQuestion?._id || '');
  const eventQuestionId = String(eventPayload?.questionId || '');
  if (currentQuestionId && eventQuestionId && currentQuestionId !== eventQuestionId) return previousData;

  const previousAttemptNumber = previousData?.currentAttempt?.number ?? null;
  const nextAttemptNumber = eventPayload?.currentAttempt?.number ?? previousAttemptNumber;
  const resetResponses = !!eventPayload?.resetResponses || nextAttemptNumber !== previousAttemptNumber;
  return {
    ...previousData,
    currentAttempt: eventPayload?.currentAttempt ?? previousData.currentAttempt,
    showStats: eventPayload?.stats ?? previousData.showStats,
    showCorrect: eventPayload?.correct ?? previousData.showCorrect,
    responseStats: resetResponses ? null : previousData.responseStats,
    studentResponse: resetResponses ? null : previousData.studentResponse,
    allResponses: resetResponses ? [] : previousData.allResponses,
    responseCount: resetResponses ? 0 : previousData.responseCount,
  };
}

function applyVisibilityChangedDelta(previousData, eventPayload = {}) {
  if (!previousData || !Object.prototype.hasOwnProperty.call(eventPayload || {}, 'question')) return null;
  return {
    ...previousData,
    currentQuestion: eventPayload.question,
    currentAttempt: eventPayload?.currentAttempt ?? previousData.currentAttempt,
    questionHidden: eventPayload?.questionHidden ?? eventPayload?.hidden ?? previousData.questionHidden,
    showStats: eventPayload?.showStats ?? eventPayload?.stats ?? previousData.showStats,
    showCorrect: eventPayload?.showCorrect ?? eventPayload?.correct ?? previousData.showCorrect,
    showResponseList: eventPayload?.showResponseList ?? eventPayload?.responseListVisible ?? previousData.showResponseList,
    responseStats: eventPayload?.responseStats ?? null,
    wordCloudData: eventPayload?.wordCloudData ?? null,
    histogramData: eventPayload?.histogramData ?? null,
  };
}

function applyInstructorVisibilityChangedDelta(previousData, eventPayload = {}) {
  if (!previousData?.currentQuestion) return previousData;
  const currentQuestionId = String(previousData.currentQuestion?._id || '');
  const eventQuestionId = String(eventPayload?.questionId || '');
  if (currentQuestionId && eventQuestionId && currentQuestionId !== eventQuestionId) {
    return previousData;
  }

  const questionHidden = eventPayload?.hidden ?? previousData.questionHidden;
  const showStats = eventPayload?.stats ?? previousData.showStats;
  const showCorrect = eventPayload?.correct ?? previousData.showCorrect;
  const showResponseList = eventPayload?.responseListVisible ?? previousData.showResponseList;

  return {
    ...previousData,
    questionHidden,
    showStats,
    showCorrect,
    showResponseList,
    currentQuestion: {
      ...previousData.currentQuestion,
      sessionOptions: {
        ...(previousData.currentQuestion.sessionOptions || {}),
        hidden: questionHidden,
        stats: showStats,
        correct: showCorrect,
        responseListVisible: showResponseList,
      },
    },
  };
}

function applyQuestionChangedDelta(previousData, eventPayload = {}) {
  if (!previousData || !Object.prototype.hasOwnProperty.call(eventPayload || {}, 'question')) return null;
  return {
    ...previousData,
    session: previousData.session
      ? { ...previousData.session, currentQuestion: eventPayload?.questionId ?? previousData.session.currentQuestion }
      : previousData.session,
    currentQuestion: eventPayload.question,
    currentAttempt: eventPayload?.currentAttempt ?? null,
    studentResponse: eventPayload?.studentResponse ?? null,
    responseStats: eventPayload?.responseStats ?? null,
    responseCount: eventPayload?.responseCount ?? 0,
    allResponses: eventPayload?.allResponses ?? [],
    questionHidden: eventPayload?.questionHidden ?? previousData.questionHidden,
    showStats: eventPayload?.showStats ?? previousData.showStats,
    showCorrect: eventPayload?.showCorrect ?? previousData.showCorrect,
    showResponseList: eventPayload?.showResponseList ?? previousData.showResponseList,
    wordCloudData: eventPayload?.wordCloudData ?? null,
    histogramData: eventPayload?.histogramData ?? null,
    questionNumber: eventPayload?.questionNumber ?? previousData.questionNumber,
    questionCount: eventPayload?.questionCount ?? previousData.questionCount,
    pageProgress: eventPayload?.pageProgress ?? previousData.pageProgress,
    questionProgress: eventPayload?.questionProgress ?? previousData.questionProgress,
  };
}

function collectChatPostIds(chatData = {}) {
  const ids = new Set();
  (Array.isArray(chatData?.posts) ? chatData.posts : []).forEach((post) => {
    if (post?._id) ids.add(String(post._id));
  });
  (Array.isArray(chatData?.quickPosts) ? chatData.quickPosts : []).forEach((post) => {
    if (post?.postId) ids.add(String(post.postId));
  });
  (Array.isArray(chatData?.quickPostOptions) ? chatData.quickPostOptions : []).forEach((post) => {
    if (post?.postId) ids.add(String(post.postId));
  });
  return ids;
}

function validateChatState(data, expectation = {}) {
  if (!data) return false;

  if (expectation.enabled !== undefined && Boolean(data?.enabled) !== Boolean(expectation.enabled)) {
    return false;
  }
  if (expectation.postId) {
    const ids = collectChatPostIds(data);
    if (!ids.has(String(expectation.postId))) return false;
  }
  if (expectation.quickPostQuestionNumber !== undefined) {
    const quickPostMatches = [
      ...(Array.isArray(data?.quickPosts) ? data.quickPosts : []),
      ...(Array.isArray(data?.quickPostOptions) ? data.quickPostOptions : []),
    ].some((post) => Number(post?.questionNumber) === Number(expectation.quickPostQuestionNumber));
    if (!quickPostMatches) return false;
  }
  if (expectation.minPosts !== undefined && (Array.isArray(data?.posts) ? data.posts.length : 0) < Number(expectation.minPosts)) {
    return false;
  }

  return true;
}

function fetchChat(token, role, reason = 'chat_refresh', view = 'live') {
  const startedAtMs = Date.now();
  const queryString = buildQueryString(view && view !== 'live' ? { view } : {});
  const res = http.get(`${API}/sessions/${state.session.id}/chat${queryString}`, {
    headers: apiHeaders(token),
    tags: { name: reason },
  });
  const completedAtMs = Date.now();
  chatRefreshDuration.add(completedAtMs - startedAtMs, metricTags(role));

  const ok = res.status === 200;
  chatRefreshSuccess.add(ok, metricTags(role));
  if (!ok) {
    return {
      ok: false,
      data: null,
      res,
      startedAtMs,
      completedAtMs,
    };
  }

  return {
    ok: true,
    data: parseJson(res),
    res,
    startedAtMs,
    completedAtMs,
  };
}

function refreshChatAfterEvent(token, role, reason, expectation = {}, syncContext = null, view = 'live') {
  const result = fetchChat(token, role, `chat_${reason}`, view);
  const ok = result.ok && validateChatState(result.data, expectation);
  recordSyncTiming({
    endToEndMetric: chatEventSyncDuration,
    deliveryMetric: chatEventDeliveryDuration,
    applyMetric: chatEventApplyDuration,
    role,
    reason,
    syncContext,
    startedAtMs: result.startedAtMs,
    completedAtMs: result.completedAtMs,
  });
  chatEventSyncSuccess.add(ok, metricTags(role));
  return result.ok ? result.data : null;
}

function syncChatAfterEvent(currentData, role, eventPayload, expectation = {}, syncContext = null, reason = 'delta') {
  const startedAtMs = Date.now();
  const nextData = applyChatEventData(currentData, eventPayload);
  const completedAtMs = Date.now();
  const ok = Boolean(nextData) && validateChatState(nextData, expectation);
  recordSyncTiming({
    endToEndMetric: chatEventSyncDuration,
    deliveryMetric: chatEventDeliveryDuration,
    applyMetric: chatEventApplyDuration,
    role,
    reason,
    syncContext,
    startedAtMs,
    completedAtMs,
  });
  chatEventSyncSuccess.add(ok, metricTags(role));
  return nextData;
}

function mergeSyncContext(existing = null, next = null) {
  if (!existing) return next;
  if (!next) return existing;

  const existingEmittedAtMs = parseTimestampMs(existing?.emittedAt);
  const nextEmittedAtMs = parseTimestampMs(next?.emittedAt);
  let emittedAt = existing?.emittedAt || next?.emittedAt || null;

  if (existingEmittedAtMs != null && nextEmittedAtMs != null) {
    emittedAt = new Date(Math.min(existingEmittedAtMs, nextEmittedAtMs)).toISOString();
  } else if (nextEmittedAtMs != null) {
    emittedAt = next.emittedAt;
  }

  const existingReceivedAtMs = Number(existing?.receivedAtMs || 0);
  const nextReceivedAtMs = Number(next?.receivedAtMs || 0);
  const validReceivedAtMs = [existingReceivedAtMs, nextReceivedAtMs]
    .filter((value) => Number.isFinite(value) && value > 0);

  return {
    emittedAt,
    receivedAtMs: validReceivedAtMs.length > 0 ? Math.min(...validReceivedAtMs) : undefined,
  };
}

function createSocketDebouncer(socket, delayMs, callback) {
  let scheduled = false;
  let pendingReason = '';
  let pendingExpectation = {};
  let pendingSyncContext = null;
  let pendingView = 'live';

  return (reason, expectation = {}, syncContext = null, view = 'live') => {
    pendingReason = reason || pendingReason;
    pendingExpectation = { ...pendingExpectation, ...expectation };
    pendingSyncContext = mergeSyncContext(pendingSyncContext, syncContext);
    pendingView = view || pendingView;

    if (scheduled) return;

    scheduled = true;
    socket.setTimeout(() => {
      scheduled = false;
      const nextReason = pendingReason;
      const nextExpectation = pendingExpectation;
      const nextSyncContext = pendingSyncContext;
      const nextView = pendingView;

      pendingReason = '';
      pendingExpectation = {};
      pendingSyncContext = null;
      pendingView = 'live';

      callback(nextReason, nextExpectation, nextSyncContext, nextView);
    }, normalizeSocketTimeoutMs(delayMs));
  };
}

function recordChatAction(ok, role, action) {
  chatActionSuccess.add(ok, metricTags(role, { action }));
}

function createChatPost(token, role, body, tagName = 'chat_post') {
  const res = jsonRequest('POST', `/sessions/${state.session.id}/chat/posts`, token, {
    body,
    bodyWysiwyg: body,
  }, tagName);
  const ok = res.status === 200 || res.status === 201;
  recordChatAction(ok, role, 'post');
  if (ok) chatPostsCreated.add(1, metricTags(role));
  return { ok, res, data: parseJson(res) };
}

function toggleQuickPost(token, role, questionNumber, tagName = 'chat_quick_post_toggle') {
  const res = jsonRequest('POST', `/sessions/${state.session.id}/chat/quick-posts/${questionNumber}/toggle`, token, {}, tagName);
  const ok = res.status === 200;
  recordChatAction(ok, role, 'quick_post');
  if (ok) chatQuickPostToggles.add(1, metricTags(role));
  return { ok, res, data: parseJson(res) };
}

function voteChatPost(token, role, postId, upvoted = true, tagName = 'chat_vote') {
  const res = jsonRequest('PATCH', `/sessions/${state.session.id}/chat/posts/${postId}/vote`, token, { upvoted }, tagName);
  const ok = res.status === 200;
  recordChatAction(ok, role, 'vote');
  if (ok) chatVotesApplied.add(1, metricTags(role));
  return { ok, res, data: parseJson(res) };
}

function replyToChatPost(token, role, postId, body, tagName = 'chat_reply') {
  const res = jsonRequest('POST', `/sessions/${state.session.id}/chat/posts/${postId}/comments`, token, {
    body,
    bodyWysiwyg: body,
  }, tagName);
  const ok = res.status === 200 || res.status === 201;
  recordChatAction(ok, role, 'reply');
  if (ok) chatRepliesCreated.add(1, metricTags(role));
  return { ok, res, data: parseJson(res) };
}

function optionId(question, index) {
  return String(question?.options?.[index]?._id ?? index);
}

function randomOptionIds(question, minSelections = 1) {
  const picks = new Set();
  const optionCount = Array.isArray(question?.options) ? question.options.length : 0;
  const maxSelections = Math.min(optionCount, Math.max(minSelections, 3));
  const selectionCount = Math.max(
    minSelections,
    Math.min(maxSelections, Math.floor(Math.random() * maxSelections) + 1),
  );

  while (picks.size < selectionCount && picks.size < optionCount) {
    picks.add(optionId(question, Math.floor(Math.random() * optionCount)));
  }

  return [...picks].sort();
}

function buildResponsePayload(question) {
  const type = normalizeQuestionType(question);
  const optionCount = Array.isArray(question?.options) ? question.options.length : 0;

  if ((type === 0 || type === 1) && optionCount > 0) {
    return { answer: optionId(question, Math.floor(Math.random() * optionCount)) };
  }

  if (type === 3 && optionCount > 0) {
    return { answer: randomOptionIds(question, 1) };
  }

  if (type === 2) {
    return { answer: 'Au' };
  }

  if (type === 4) {
    return { answer: String((3.14 + (Math.random() - 0.5) * 0.1).toFixed(2)) };
  }

  return { answer: '' };
}

function getLiveAttemptKey(snapshot) {
  const questionId = String(snapshot?.currentQuestion?._id || '').trim();
  const attemptNumber = Number(snapshot?.currentAttempt?.number || 0);
  if (!questionId || attemptNumber <= 0) return null;
  return `${questionId}:${attemptNumber}`;
}

function recordResponseFailure(res) {
  const status = Number(res?.status || 0);
  if (status === 409) {
    respondConflictFailures.add(1);
    return;
  }
  if (status >= 400 && status < 500) {
    respondRejectedFailures.add(1, { status: String(status) });
    return;
  }
  respondServerFailures.add(1, { status: String(status || 'network') });
}

function submitResponse(token, liveData) {
  const question = liveData?.currentQuestion;
  const attemptNumber = Number(liveData?.currentAttempt?.number || 0);
  if (!question || !attemptNumber) {
    return { ok: false, key: null };
  }

  const payload = buildResponsePayload(question);
  const start = Date.now();
  respondAttempts.add(1);
  const res = http.post(
    `${API}/sessions/${state.session.id}/respond`,
    JSON.stringify(payload),
    { headers: apiHeaders(token), tags: { name: 'respond' } },
  );
  respondDuration.add(Date.now() - start, metricTags('student'));

  const ok = res.status === 200 || res.status === 201;
  respondSuccess.add(ok);
  if (ok) {
    respondSuccessfulSubmissions.add(1);
  } else {
    recordResponseFailure(res);
  }
  return {
    ok,
    key: `${String(question._id || '')}:${attemptNumber}`,
    response: ok ? parseJson(res) : null,
    res,
  };
}

function professorRequest(method, path, token, payload, tagName, expectedStatuses = [200]) {
  const startedAtMs = Date.now();
  const res = jsonRequest(method, path, token, payload, tagName);
  professorActionDuration.add(Date.now() - startedAtMs, { action: tagName });
  const ok = expectedStatuses.includes(res.status);
  professorActionSuccess.add(ok, { action: tagName, status: String(res.status || 'network') });
  if (!ok) {
    const responseDetail = String(res?.body || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    console.warn(
      `Professor action failed: ${tagName} ${method} ${path} returned HTTP ${res.status || 'network'}`
      + (responseDetail ? ` — ${responseDetail}` : ''),
    );
  }
  check(res, { [`${tagName} ok`]: () => ok });
  return res;
}

function isChatWave(questionNumber) {
  return questionNumber > 1 && ((questionNumber - 2) % CHAT_ACTIVITY_EVERY_N_QUESTIONS === 0);
}

function pickQuickPostQuestionNumber(currentQuestionNumber, studentIndex) {
  const priorQuestionCount = Math.max(0, currentQuestionNumber - 1);
  if (priorQuestionCount <= 0) return null;
  const recentWindow = Math.min(priorQuestionCount, 2);
  return currentQuestionNumber - 1 - (studentIndex % recentWindow);
}

function buildStudentChatBody(questionNumber, studentIndex) {
  const templates = [
    'Could you walk through the reasoning for question %QUESTION%?',
    'I am still unsure how to start question %QUESTION%.',
    'Can we revisit the main idea behind question %QUESTION%?',
  ];
  return templates[(questionNumber + studentIndex) % templates.length]
    .replace('%QUESTION%', String(questionNumber));
}

function buildProfessorReplyBody(post, currentQuestionNumber) {
  if (post?.isQuickPost && Number(post?.quickPostQuestionNumber) > 0) {
    return `Thanks for flagging question ${post.quickPostQuestionNumber}. I will go back over that one.`;
  }
  return `Thanks for the question. I will add a bit more explanation around question ${currentQuestionNumber}.`;
}

function chooseVotableRegularPost(chatData = {}) {
  return (Array.isArray(chatData?.posts) ? chatData.posts : []).find(
    (post) => !post?.dismissed && !post?.isQuickPost && !post?.isOwnPost && !post?.viewerHasUpvoted,
  ) || null;
}

function maybeProfessorReplyToChat(token, currentQuestionNumber, repliedPostIds) {
  if (!SESSION_CHAT_ENABLED) return false;
  if (!isChatWave(currentQuestionNumber)) return false;

  sleep(PROFESSOR_REPLY_DELAY_MS / 1000);
  const chatResult = fetchChat(token, 'professor', `professor_chat_review_${currentQuestionNumber}`);
  const chatData = chatResult.data;
  if (!chatResult.ok || !chatData?.enabled) return false;

  const targetPost = (Array.isArray(chatData?.posts) ? chatData.posts : []).find(
    (post) => !post?.dismissed && !repliedPostIds.has(String(post?._id || '')) && (post?.comments?.length || 0) === 0,
  );
  if (!targetPost?._id) return false;

  const replyResult = replyToChatPost(
    token,
    'professor',
    targetPost._id,
    buildProfessorReplyBody(targetPost, currentQuestionNumber),
    `professor_chat_reply_${currentQuestionNumber}`,
  );
  if (!replyResult.ok) return false;

  repliedPostIds.add(String(targetPost._id));
  fetchChat(token, 'professor', `professor_chat_after_reply_${currentQuestionNumber}`);
  return true;
}

export function professorFlow() {
  const sessionId = state.session.id;
  const questions = state.questions;
  const role = 'professor';
  let professorToken = null;
  let professorReplyCount = 0;
  const repliedPostIds = new Set();

  group('professor_login', () => {
    const start = Date.now();
    const res = login(state.professor.email, state.password, role);
    loginDuration.add(Date.now() - start, metricTags(role));
    const ok = res.status === 200;
    loginSuccess.add(ok, metricTags(role));
    check(res, { 'professor login 200': (r) => r.status === 200 });
    if (ok) {
      professorToken = parseJson(res)?.token;
    }
  });

  if (!professorToken) {
    return;
  }

  fetchLive(professorToken, role, 'professor_initial_live');

  group('configure_chat', () => {
    const chatSettingActionTag = SESSION_CHAT_ENABLED ? 'enable_chat' : 'disable_chat';
    professorRequest(
      'PATCH',
      `/sessions/${sessionId}/chat-settings`,
      professorToken,
      { chatEnabled: SESSION_CHAT_ENABLED },
      chatSettingActionTag,
    );
    if (SESSION_CHAT_ENABLED) {
      fetchChat(professorToken, role, 'professor_initial_chat');
    }
  });

  group('start_session', () => {
    // Reset the current question explicitly so this setup is deterministic for
    // both freshly seeded runs and --test-only reruns of an existing fixture.
    professorRequest(
      'PATCH',
      `/sessions/${sessionId}/current`,
      professorToken,
      { questionId: questions[0].id },
      'select_initial_question',
    );

    // Hide it before students can join to prevent timers for the seed attempt
    // from racing the first attempt opened by the professor flow.
    professorRequest(
      'PATCH',
      `/sessions/${sessionId}/question-visibility`,
      professorToken,
      { hidden: true, stats: false, correct: false },
      'hide_initial_question',
    );
    professorRequest('POST', `/sessions/${sessionId}/start`, professorToken, {}, 'start_session');
  });

  sleep(JOIN_GRACE_S);

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const questionNumber = index + 1;

    group(`question_${questionNumber}_open`, () => {
      if (index > 0) {
        // Make question transitions atomic from the simulated students'
        // perspective. The server carries the current visibility flags to the
        // next question, so hide the old question before navigating and only
        // expose the new one after its attempt has been opened.
        professorRequest(
          'PATCH',
          `/sessions/${sessionId}/question-visibility`,
          professorToken,
          { hidden: true, stats: false, correct: false },
          'hide_between_questions',
        );
        professorRequest(
          'PATCH',
          `/sessions/${sessionId}/current`,
          professorToken,
          { questionId: question.id },
          'navigate_question',
        );
      }

      professorRequest(
        'POST',
        `/sessions/${sessionId}/new-attempt`,
        professorToken,
        {},
        'open_attempt',
      );

      professorRequest(
        'PATCH',
        `/sessions/${sessionId}/question-visibility`,
        professorToken,
        { hidden: false, stats: LIVE_STATS_DURING_ANSWERS, correct: false },
        'show_question',
      );
    });

    sleep(ANSWER_WINDOW_S);

    group(`question_${questionNumber}_close`, () => {
      professorRequest(
        'PATCH',
        `/sessions/${sessionId}/toggle-responses`,
        professorToken,
        { closed: true },
        'close_responses',
      );
    });

    const snapshot = fetchLive(professorToken, role, 'question_final_count').data;
    questionResponseCountSuccess.add(snapshot?.responseCount === students.length);
    if (anonymous) {
      const published = Number(snapshot?.responseStats?.total || 0);
      anonymousBatchStatsSuccess.add(students.length < 4 ? published === 0
        : published >= 4 && students.length - published >= 0 && students.length - published < 4);
    }

    group(`question_${questionNumber}_stats`, () => {
      professorRequest(
        'PATCH',
        `/sessions/${sessionId}/question-visibility`,
        professorToken,
        { hidden: false, stats: true, correct: false },
        'show_stats',
      );

      if ((!anonymous || students.length >= 4) && Number(question.type) === 2) {
        professorRequest(
          'POST',
          `/sessions/${sessionId}/word-cloud`,
          professorToken,
          { stopWords: [] },
          'generate_word_cloud',
        );
      }

      if ((!anonymous || students.length >= 4) && Number(question.type) === 4) {
        professorRequest(
          'POST',
          `/sessions/${sessionId}/histogram`,
          professorToken,
          {},
          'generate_histogram',
        );
      }

      if (professorReplyCount < CHAT_REPLY_PROFESSOR_LIMIT && maybeProfessorReplyToChat(professorToken, questionNumber, repliedPostIds)) {
        professorReplyCount += 1;
      }
    });

    sleep(STATS_PAUSE_S);

    group(`question_${questionNumber}_correct`, () => {
      professorRequest(
        'PATCH',
        `/sessions/${sessionId}/question-visibility`,
        professorToken,
        { hidden: false, stats: true, correct: true },
        'show_correct',
      );
    });

    sleep(CORRECT_PAUSE_S);
  }

  group('end_session', () => {
    professorRequest('POST', `/sessions/${sessionId}/end`, professorToken, {}, 'end_session');
  });
  verifyFinalResults(professorToken);
  professorDriverCompletions.add(1);
}

export function professorViewerFlow() {
  const sessionId = state.session.id;
  const role = 'professor';
  let token = null;
  let liveData = null;
  let chatData = null;
  let chatEnabled = false;
  let sessionEnded = false;
  let nextObserverTickAtMs = null;

  group('professor_viewer_login', () => {
    const start = Date.now();
    const res = login(state.professor.email, state.password, role);
    loginDuration.add(Date.now() - start, metricTags(role));
    const ok = res.status === 200;
    loginSuccess.add(ok, metricTags(role));
    if (ok) {
      token = parseJson(res)?.token;
    }
  });

  if (!token) return;

  liveData = fetchLive(token, role, 'professor_viewer_initial_live').data;
  chatEnabled = SESSION_CHAT_ENABLED && Boolean(liveData?.session?.chatEnabled);
  if (chatEnabled) {
    chatData = fetchChat(token, role, 'professor_viewer_initial_chat').data;
  }

  const response = ws.connect(`${WS_URL}?token=${encodeURIComponent(token)}`, {}, (socket) => {
    const refreshLiveObserver = (reason, expectation = {}, syncContext = null) => {
      const refreshed = refreshLiveAfterEvent(token, role, reason, expectation, syncContext);
      if (refreshed) {
        liveData = refreshed;
        chatEnabled = SESSION_CHAT_ENABLED && Boolean(refreshed?.session?.chatEnabled);
      }
    };
    const refreshChatObserver = (reason, expectation = {}, syncContext = null, view = 'live') => {
      const refreshed = refreshChatAfterEvent(token, role, reason, expectation, syncContext, view);
      if (refreshed) {
        chatData = refreshed;
      }
    };
    const applyChatObserver = (eventPayload, reason, expectation = {}, syncContext = null, view = 'live') => {
      const updated = chatData
        ? syncChatAfterEvent(chatData, role, eventPayload, expectation, syncContext, reason)
        : null;
      if (updated) {
        chatData = updated;
        return;
      }
      refreshChatObserver(reason, expectation, syncContext, view);
    };
    const scheduleChatObserver = createSocketDebouncer(
      socket,
      CHAT_EVENT_REFRESH_DEBOUNCE_MS,
      refreshChatObserver,
    );

    socket.on('open', () => {
      wsConnections.add(1, metricTags(role));
      wsConnectSuccess.add(true, metricTags(role));
      liveData = refreshLiveAfterEvent(token, role, 'professor_viewer_ws_open', {}, null) || liveData;
      chatEnabled = SESSION_CHAT_ENABLED && Boolean(liveData?.session?.chatEnabled);
      if (chatEnabled) {
        chatData = fetchChat(token, role, 'professor_viewer_ws_open_chat').data || chatData;
      }
      nextObserverTickAtMs = Date.now() + PROFESSOR_OBSERVER_TICK_MS;
      socket.setInterval(() => {
        const nowMs = Date.now();
        if (nextObserverTickAtMs != null) {
          professorObserverLoopLag.add(Math.max(0, nowMs - nextObserverTickAtMs));
        }
        nextObserverTickAtMs = nowMs + PROFESSOR_OBSERVER_TICK_MS;
      }, PROFESSOR_OBSERVER_TICK_MS);
      socket.setInterval(() => {
        socket.send(JSON.stringify({ event: 'ping' }));
      }, 15000);
    });

    socket.on('message', (raw) => {
      const receivedAtMs = Date.now();
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }

      const event = message?.event;
      const data = message?.data || {};
      if (!event || String(data?.sessionId || '') !== String(sessionId)) {
        return;
      }
      const syncContext = {
        emittedAt: data?.emittedAt,
        receivedAtMs,
      };

      switch (event) {
        case 'session:status-changed':
          refreshLiveObserver('professor_status_changed', { status: data.status }, syncContext);
          if (data.status === 'done') {
            sessionEnded = true;
            socket.close();
          }
          break;
        case 'session:question-changed':
          if (Object.prototype.hasOwnProperty.call(data || {}, 'question')) {
            liveData = syncLiveAfterEvent(
              liveData,
              role,
              (snapshot) => applyQuestionChangedDelta(snapshot, data),
              { questionNumber: data.questionNumber },
              syncContext,
              'question_changed',
            ) || liveData;
          } else {
            refreshLiveObserver('professor_question_changed', { questionNumber: data.questionNumber }, syncContext);
          }
          break;
        case 'session:visibility-changed':
          liveData = syncLiveAfterEvent(
            liveData,
            role,
            (snapshot) => applyInstructorVisibilityChangedDelta(snapshot, data),
            { hidden: data.hidden, stats: data.stats, correct: data.correct },
            syncContext,
            'visibility_changed',
          ) || liveData;
          break;
        case 'session:attempt-changed':
          liveData = syncLiveAfterEvent(
            liveData,
            role,
            (snapshot) => applyAttemptChangedDelta(snapshot, data),
            {
              attemptNumber: data?.currentAttempt?.number,
              attemptClosed: data?.currentAttempt?.closed,
            },
            syncContext,
            'attempt_changed',
          ) || liveData;
          break;
        case 'session:word-cloud-updated':
          refreshLiveObserver('professor_word_cloud_updated', { requireWordCloud: true }, syncContext);
          break;
        case 'session:histogram-updated':
          refreshLiveObserver('professor_histogram_updated', { requireHistogram: true }, syncContext);
          break;
        case 'session:response-added':
          {
            professorResponseEvents.add(1);
            if (anonymous) checkResponsePrivacy(data, role);
            responseEventChars.add(raw.length, metricTags(role));
            const submittedAtMs = parseTimestampMs(data?.responseSubmittedAt);
            const emittedAtMs = parseTimestampMs(data?.emittedAt);
            if (submittedAtMs != null && submittedAtMs <= receivedAtMs) {
              responseToProfessorDuration.add(receivedAtMs - submittedAtMs);
            }
            if (submittedAtMs != null && emittedAtMs != null) {
              if (submittedAtMs <= emittedAtMs) {
                responseServerProcessingDuration.add(emittedAtMs - submittedAtMs);
              } else {
                invalidServerTimestamps.add(1, {
                  event: 'response_added',
                  relation: 'submitted_after_emitted',
                });
              }
            }
            if (emittedAtMs != null) {
              if (emittedAtMs <= receivedAtMs) {
                responseDeliveryToProfessorDuration.add(receivedAtMs - emittedAtMs);
              } else {
                invalidServerTimestamps.add(1, {
                  event: 'response_added',
                  relation: 'emitted_after_professor_received',
                });
              }
            }
          }
          liveData = syncLiveAfterEvent(
            liveData,
            role,
            (snapshot) => applyLiveResponseAddedDelta(snapshot, data),
            {},
            syncContext,
            'response_added',
          ) || liveData;
          chatEnabled = SESSION_CHAT_ENABLED && Boolean(liveData?.session?.chatEnabled);
          break;
        case 'session:metadata-changed':
        case 'session:join-code-changed':
          refreshLiveObserver('professor_metadata_changed', {}, syncContext);
          break;
        case 'session:chat-settings-changed':
          chatEnabled = SESSION_CHAT_ENABLED && Boolean(data?.chatEnabled);
          if (chatEnabled) {
            scheduleChatObserver('professor_chat_settings_changed', { enabled: true }, syncContext);
          }
          break;
        case 'session:chat-updated':
          if (chatEnabled) {
            if (chatData && (data?.post !== undefined || data?.quickPostOption !== undefined)) {
              applyChatObserver(data, 'professor_chat_updated', {}, syncContext);
            } else {
              scheduleChatObserver('professor_chat_updated', {}, syncContext);
            }
          }
          break;
        default:
          break;
      }
    });

    socket.on('error', (err) => {
      wsErrors.add(1, metricTags(role));
      console.warn(`Professor viewer WebSocket error: ${String(err)}`);
    });

    socket.setTimeout(() => {
      socket.close();
    }, normalizeSocketTimeoutMs(18 * 60 * 1000));
  });

  check(response, { 'professor viewer ws connected': (res) => res && res.status === 101 });
  if (!response || response.status !== 101) {
    wsHandshakeFailures.add(1, metricTags(role));
    console.warn(`WebSocket handshake failed: ${JSON.stringify(connectionFailureDetails(response, role))}`);
    wsConnectSuccess.add(false, metricTags(role));
    return;
  }

  if (!sessionEnded && liveData?.session?.status !== 'done') {
    chatData = chatData || null;
  }
  professorViewerCompletions.add(1);
}

export function studentFlow() {
  const studentIndex = exec.scenario.iterationInTest;
  if (studentIndex < 0 || studentIndex >= students.length) {
    return;
  }

  const student = students[studentIndex];
  participantKind = student.enrolled === false ? 'guest' : 'enrolled';
  const sessionId = state.session.id;
  const role = 'student';
  const watchesChat = SESSION_CHAT_ENABLED
    && shouldParticipate(CHAT_VIEWER_STUDENT_FRACTION, studentIndex, students.length, 11);
  const usesChat = SESSION_CHAT_ENABLED && (watchesChat
    || CHAT_QUICK_POST_STUDENT_FRACTION > 0
    || CHAT_RANDOM_POST_STUDENT_FRACTION > 0
    || CHAT_RANDOM_UPVOTE_STUDENT_FRACTION > 0);
  let token = null;
  let liveData = null;
  let chatData = null;
  let chatEnabled = false;

  if (STUDENT_LOGIN_SPREAD_S > 0) {
    sleep(seededRatio(studentIndex, students.length, 19) * STUDENT_LOGIN_SPREAD_S);
  }

  group('student_login', () => {
    const start = Date.now();
    const res = login(student.email, state.password, role);
    loginDuration.add(Date.now() - start, metricTags(role));
    const ok = res.status === 200;
    loginSuccess.add(ok, metricTags(role));
    if (ok) {
      token = parseJson(res)?.token;
    }
  });

  if (!token) {
    joinSuccess.add(false);
    respondSuccess.add(false);
    liveRefreshSuccess.add(false, metricTags(role));
    sessionCompletion.add(false);
    return;
  }

  if (external) {
    const redeemed = jsonRequest('POST', '/activity-codes/redeem', token,
      { code: state.session.activityCode }, 'activity_redeem');
    redeemDuration.add(redeemed.timings.duration, metricTags(role));
    const okay = redeemed.status === 200 && parseJson(redeemed)?.sessionId === sessionId;
    redeemSuccess.add(okay, metricTags(role));
    if (!okay) { sessionCompletion.add(false); return; }
  }

  liveData = fetchLive(token, role, 'student_initial_live').data;
  chatEnabled = SESSION_CHAT_ENABLED && Boolean(liveData?.session?.chatEnabled);

  let joined = false;
  group('student_join', () => {
    for (let attempt = 0; attempt < 30 && !joined; attempt += 1) {
      const start = Date.now();
      const res = http.post(
        `${API}/sessions/${sessionId}/join`,
        JSON.stringify({}),
        { headers: apiHeaders(token), tags: { name: 'join_session' } },
      );
      joinDuration.add(Date.now() - start, metricTags(role));

      if (res.status === 200) {
        joined = true;
        break;
      }

      liveData = fetchLive(token, role, 'student_join_retry').data || liveData;
      chatEnabled = SESSION_CHAT_ENABLED && Boolean(liveData?.session?.chatEnabled);
      sleep(1);
    }

    if (joined) {
      liveData = refreshLiveAfterEvent(token, role, 'post_join', { isJoined: true, status: 'running' }) || liveData;
      joined = Boolean(liveData?.isJoined);
      chatEnabled = SESSION_CHAT_ENABLED && Boolean(liveData?.session?.chatEnabled);
      if (chatEnabled && watchesChat) {
        chatData = fetchChat(token, role, 'student_initial_chat').data;
      }
    }

    joinSuccess.add(joined);
  });

  if (!joined) {
    respondSuccess.add(false);
    sessionCompletion.add(false);
    return;
  }

  let studentFlowCompleted = false;
  group('student_ws_session', () => {
    const wsUrl = `${WS_URL}?token=${encodeURIComponent(token)}`;
    const submittedAttempts = {};
    const scheduledAttempts = {};
    const completedChatWaves = new Set();
    const ownPostIds = new Set();
    let createdRandomPostCount = 0;
    let sessionEnded = false;
    let responseWindowAttemptKey = null;

    const response = ws.connect(wsUrl, {}, (socket) => {
      const ensureChatSnapshot = (reason) => {
        if (!chatEnabled || !usesChat) return chatData;
        const refreshed = fetchChat(token, role, reason).data;
        if (refreshed) {
          chatData = refreshed;
        }
        return chatData;
      };

      const updateResponseWindow = (snapshot) => {
        const attemptKey = getLiveAttemptKey(snapshot);
        const responseWindowIsOpen = Boolean(
          attemptKey
          && snapshot?.currentQuestion
          && snapshot?.currentAttempt
          && !readLiveVisibilityFlag(snapshot, 'hidden')
          && (LIVE_STATS_DURING_ANSWERS || !readLiveVisibilityFlag(snapshot, 'stats'))
          && !readLiveVisibilityFlag(snapshot, 'correct')
          && !snapshot.currentAttempt.closed
        );
        responseWindowAttemptKey = responseWindowIsOpen ? attemptKey : null;
        return responseWindowAttemptKey;
      };

      const maybeSubmitCurrentAttempt = (snapshot) => {
        const currentQuestion = snapshot?.currentQuestion;
        const currentAttempt = snapshot?.currentAttempt;
        if (!currentQuestion || !currentAttempt) return;
        if (snapshot?.questionHidden) return;
        if (currentAttempt.closed) return;
        if (snapshot?.studentResponse) return;

        const attemptKey = getLiveAttemptKey(snapshot);
        if (
          !attemptKey
          || responseWindowAttemptKey !== attemptKey
          || submittedAttempts[attemptKey]
          || scheduledAttempts[attemptKey]
        ) {
          return;
        }

        scheduledAttempts[attemptKey] = true;
        const responseDelayMs = seededRatio(
          studentIndex,
          Number(snapshot?.questionNumber || 0),
          Number(currentAttempt?.number || 0),
        ) * RESPONSE_JITTER_MS;
        socket.setTimeout(() => {
          // Match the browser: submit from the websocket-synchronized snapshot
          // instead of issuing an extra /live request immediately beforehand.
          const latest = liveData || snapshot;
          liveData = latest;
          chatEnabled = SESSION_CHAT_ENABLED && Boolean(latest?.session?.chatEnabled);

          // A timer may have been created from a visibility event immediately
          // before the professor opened a new attempt. Never let that stale
          // timer submit against whichever attempt happens to be current when
          // it wakes; schedule the current attempt through the normal path.
          if (getLiveAttemptKey(latest) !== attemptKey || responseWindowAttemptKey !== attemptKey) {
            respondStaleTimerSkips.add(1);
            delete scheduledAttempts[attemptKey];
            maybeSubmitCurrentAttempt(latest);
            return;
          }

          if (
            !latest?.currentQuestion
            || latest?.questionHidden
            || latest?.currentAttempt?.closed
            || latest?.studentResponse
          ) {
            delete scheduledAttempts[attemptKey];
            return;
          }

          const submitted = submitResponse(token, latest);
          if (submitted.ok) {
            submittedAttempts[attemptKey] = true;
            if (submitted.response?.response) {
              liveData = {
                ...latest,
                studentResponse: submitted.response.response,
              };
            }
          } else if (submitted.res?.status === 409) {
            // A conflict means this student already has a response for this
            // attempt. Treat it as submitted so later events do not retry it.
            submittedAttempts[attemptKey] = true;
          }

          delete scheduledAttempts[attemptKey];
        }, normalizeSocketTimeoutMs(responseDelayMs));
      };

      const refreshForEvent = (reason, expectation = {}, syncContext = null) => {
        const refreshed = refreshLiveAfterEvent(token, role, reason, expectation, syncContext);
        if (refreshed) {
          liveData = refreshed;
          chatEnabled = SESSION_CHAT_ENABLED && Boolean(refreshed?.session?.chatEnabled);
        }
        return liveData;
      };

      const runChatWave = (questionNumber) => {
        if (!chatEnabled || !usesChat || !isChatWave(questionNumber)) return;

        const currentQuestionNumber = Number(liveData?.questionNumber || questionNumber || 0);
        if (currentQuestionNumber <= 1) return;

        const quickPostQuestionNumber = pickQuickPostQuestionNumber(currentQuestionNumber, studentIndex);
        const wantsQuickPost = !!quickPostQuestionNumber
          && shouldParticipate(CHAT_QUICK_POST_STUDENT_FRACTION, studentIndex, currentQuestionNumber, 31);
        const wantsRandomPost = createdRandomPostCount < 1
          && shouldParticipate(CHAT_RANDOM_POST_STUDENT_FRACTION, studentIndex, currentQuestionNumber, 43);
        const wantsRandomUpvote = shouldParticipate(CHAT_RANDOM_UPVOTE_STUDENT_FRACTION, studentIndex, currentQuestionNumber, 59);
        if (!wantsQuickPost && !wantsRandomPost && !wantsRandomUpvote) return;

        let snapshot = ensureChatSnapshot(`student_chat_wave_${questionNumber}_start`);
        if (!snapshot?.enabled) return;

        if (wantsQuickPost) {
          const quickPostOption = (Array.isArray(snapshot?.quickPostOptions) ? snapshot.quickPostOptions : []).find(
            (option) => Number(option?.questionNumber) === Number(quickPostQuestionNumber),
          );
          if (quickPostOption && !quickPostOption.viewerHasUpvoted) {
            const result = toggleQuickPost(token, role, quickPostQuestionNumber, `student_quick_post_${currentQuestionNumber}`);
            if (result.ok) {
              snapshot = ensureChatSnapshot(`student_chat_after_quick_post_${currentQuestionNumber}`) || snapshot;
            }
          }
        }

        if (wantsRandomPost) {
          const result = createChatPost(
            token,
            role,
            buildStudentChatBody(currentQuestionNumber, studentIndex),
            `student_chat_post_${currentQuestionNumber}`,
          );
          if (result.ok) {
            if (result.data?.postId) {
              ownPostIds.add(String(result.data.postId));
            }
            createdRandomPostCount += 1;
            snapshot = ensureChatSnapshot(`student_chat_after_post_${currentQuestionNumber}`) || snapshot;
          }
        }

        if (wantsRandomUpvote) {
          const targetPost = chooseVotableRegularPost(snapshot);
          if (targetPost?._id && !ownPostIds.has(String(targetPost._id))) {
            const result = voteChatPost(token, role, targetPost._id, true, `student_chat_vote_${currentQuestionNumber}`);
            if (result.ok) {
              snapshot = ensureChatSnapshot(`student_chat_after_vote_${currentQuestionNumber}`) || snapshot;
            }
          }
        }
      };

      const scheduleChatWave = (questionNumber) => {
        if (!chatEnabled || !usesChat || !isChatWave(questionNumber) || completedChatWaves.has(questionNumber)) {
          return;
        }
        completedChatWaves.add(questionNumber);
        socket.setTimeout(() => {
          runChatWave(questionNumber);
        }, normalizeSocketTimeoutMs(
          seededRatio(studentIndex, questionNumber, 71) * CHAT_ACTION_JITTER_MS,
        ));
      };
      const refreshChatObserver = (reason, expectation = {}, syncContext = null, view = 'live') => {
        const refreshed = refreshChatAfterEvent(token, role, reason, expectation, syncContext, view);
        if (refreshed) {
          chatData = refreshed;
        }
      };
      const applyChatObserver = (eventPayload, reason, expectation = {}, syncContext = null, view = 'live') => {
        const updated = chatData
          ? syncChatAfterEvent(chatData, role, eventPayload, expectation, syncContext, reason)
          : null;
        if (updated) {
          chatData = updated;
          return;
        }
        refreshChatObserver(reason, expectation, syncContext, view);
      };
      const scheduleChatObserver = createSocketDebouncer(
        socket,
        CHAT_EVENT_REFRESH_DEBOUNCE_MS,
        refreshChatObserver,
      );

      socket.on('open', () => {
        wsConnections.add(1, metricTags(role));
        wsConnectSuccess.add(true, metricTags(role));
        liveData = refreshLiveAfterEvent(token, role, 'ws_open', { isJoined: true }) || liveData;
        chatEnabled = SESSION_CHAT_ENABLED && Boolean(liveData?.session?.chatEnabled);
        if (chatEnabled && watchesChat) {
          chatData = fetchChat(token, role, 'student_ws_open_chat').data || chatData;
        }
        updateResponseWindow(liveData);
        maybeSubmitCurrentAttempt(liveData);
        socket.setInterval(() => {
          socket.send(JSON.stringify({ event: 'ping' }));
        }, 15000);
      });

      socket.on('message', (raw) => {
        const receivedAtMs = Date.now();
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          return;
        }

        const event = message?.event;
        const data = message?.data || {};
        if (!event || String(data?.sessionId || '') !== String(sessionId)) {
          return;
        }
        const syncContext = {
          emittedAt: data?.emittedAt,
          receivedAtMs,
        };

        switch (event) {
          case 'session:status-changed':
            responseWindowAttemptKey = null;
            liveData = refreshLiveAfterEvent(
              token,
              role,
              'status_changed',
              { status: data.status },
              syncContext,
            ) || liveData;
            chatEnabled = SESSION_CHAT_ENABLED && Boolean(liveData?.session?.chatEnabled);
            if (data.status === 'done') {
              sessionEnded = true;
              socket.close();
            }
            break;

          case 'session:question-changed':
            responseWindowAttemptKey = null;
            if (Object.prototype.hasOwnProperty.call(data || {}, 'question')) {
              liveData = syncLiveAfterEvent(
                liveData,
                role,
                (snapshot) => applyQuestionChangedDelta(snapshot, data),
                { questionNumber: data.questionNumber },
                syncContext,
                'question_changed',
              ) || liveData;
            } else {
              refreshForEvent('question_changed', { questionNumber: data.questionNumber }, syncContext);
            }
            scheduleChatWave(Number(data?.questionNumber || liveData?.questionNumber || 0));
            break;

          case 'session:visibility-changed':
            if (Object.prototype.hasOwnProperty.call(data || {}, 'question')) {
              liveData = syncLiveAfterEvent(
                liveData,
                role,
                (snapshot) => applyVisibilityChangedDelta(snapshot, data),
                {
                  hidden: data.questionHidden,
                  stats: data.showStats,
                  correct: data.showCorrect,
                },
                syncContext,
                'visibility_changed',
              ) || liveData;
            } else {
              refreshForEvent('visibility_changed', {
                hidden: data.hidden,
                stats: data.stats,
                correct: data.correct,
              }, syncContext);
            }
            updateResponseWindow(liveData);
            maybeSubmitCurrentAttempt(liveData);
            break;

          case 'session:attempt-changed':
            responseWindowAttemptKey = null;
            liveData = syncLiveAfterEvent(
              liveData,
              role,
              (snapshot) => applyAttemptChangedDelta(snapshot, data),
              {
                attemptNumber: data?.currentAttempt?.number,
                attemptClosed: data?.currentAttempt?.closed,
              },
              syncContext,
              'attempt_changed',
            ) || liveData;
            break;

          case 'session:word-cloud-updated':
            liveData = syncLiveAfterEvent(
              liveData,
              role,
              (snapshot) => snapshot ? { ...snapshot, wordCloudData: data?.wordCloudData ?? null } : snapshot,
              { requireWordCloud: true },
              syncContext,
              'word_cloud_updated',
            ) || liveData;
            break;

          case 'session:histogram-updated':
            liveData = syncLiveAfterEvent(
              liveData,
              role,
              (snapshot) => snapshot ? { ...snapshot, histogramData: data?.histogramData ?? null } : snapshot,
              { requireHistogram: true },
              syncContext,
              'histogram_updated',
            ) || liveData;
            break;

          case 'session:chat-settings-changed':
            chatEnabled = SESSION_CHAT_ENABLED && Boolean(data?.chatEnabled);
            if (chatEnabled && watchesChat) {
              scheduleChatObserver('settings_changed', { enabled: true }, syncContext);
            }
            break;

          case 'session:chat-updated':
            if (chatEnabled && watchesChat) {
              if (chatData && (data?.post !== undefined || data?.quickPostOption !== undefined)) {
                applyChatObserver(data, 'updated', {}, syncContext);
              } else {
                scheduleChatObserver('updated', {}, syncContext);
              }
            }
            break;

          case 'session:response-added':
            if (anonymous) checkResponsePrivacy(data, role);
            responseEventChars.add(raw.length, metricTags(role));
            if (data?.responseStats || data?.response || data?.responseCount !== undefined || data?.joinedCount !== undefined) {
              liveData = syncLiveAfterEvent(
                liveData,
                role,
                (snapshot) => applyLiveResponseAddedDelta(snapshot, data),
                {},
                syncContext,
                'response_added',
              ) || liveData;
              chatEnabled = SESSION_CHAT_ENABLED && Boolean(liveData?.session?.chatEnabled);
              break;
            }
            responseAddedRefreshes.add(1, metricTags(role));
            liveData = refreshLiveAfterEvent(token, role, 'response_added_live', {}, syncContext) || liveData;
            chatEnabled = SESSION_CHAT_ENABLED && Boolean(liveData?.session?.chatEnabled);
            break;

          default:
            break;
        }
      });

      socket.on('error', (err) => {
        wsErrors.add(1, metricTags(role));
        console.warn(`WebSocket error for ${student.email}: ${String(err)}`);
      });

      socket.setTimeout(() => {
        socket.close();
      }, normalizeSocketTimeoutMs(18 * 60 * 1000));
    });

    check(response, { 'ws connected': (res) => res && res.status === 101 });
    if (!response || response.status !== 101) {
      wsHandshakeFailures.add(1, metricTags(role));
      console.warn(`WebSocket handshake failed: ${JSON.stringify(connectionFailureDetails(response, role))}`);
      wsConnectSuccess.add(false, metricTags(role));
      sessionCompletion.add(false);
      return;
    }

    sessionCompletion.add(sessionEnded || liveData?.session?.status === 'done');
    studentFlowCompleted = true;
  });

  if (studentFlowCompleted) {
    studentFlowCompletions.add(1);
  }
}
