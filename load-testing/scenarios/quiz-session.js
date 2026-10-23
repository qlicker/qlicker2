/** Quiz load for the existing course-member flow, in named or anonymous mode. */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

const state = JSON.parse(open(__ENV.STATE_FILE || '/state/state.json'));
const students = new SharedArray('quiz students', () => state.students);
const API = `${__ENV.BASE_URL || 'http://localhost:3001'}/api/v1`;
const sessionId = state.session.id;
const anonymous = !!state.session.anonymous;
const external = !!state.session.external;
const questions = state.questions || [];
const loginSpreadSeconds = Math.max(0, Number(__ENV.STUDENT_LOGIN_SPREAD_S ?? 12));
const answerJitterMs = Math.max(0, Number(__ENV.RESPONSE_JITTER_MS ?? 2000));

if (!state.session.quiz) throw new Error('The quiz scenario requires a quiz fixture');

const courseListDuration = new Trend('quiz_course_list_duration', true);
const redeemDuration = new Trend('quiz_redeem_duration', true);
const openDuration = new Trend('quiz_open_duration', true);
const autosaveDuration = new Trend('quiz_autosave_duration', true);
const submitDuration = new Trend('quiz_submit_duration', true);
const resultsDuration = new Trend('quiz_results_duration', true);
const courseListSuccess = new Rate('quiz_course_list_success');
const redeemSuccess = new Rate('quiz_redeem_success');
const gradeContractSuccess = new Rate('quiz_grade_contract_success');
const openSuccess = new Rate('quiz_open_success');
const autosaveSuccess = new Rate('quiz_autosave_success');
const submitSuccess = new Rate('quiz_submit_success');
const resultsSuccess = new Rate('quiz_results_success');
const completedStudents = new Counter('quiz_completed_students');
const savedAnswers = new Counter('quiz_saved_answers');

export const options = {
  scenarios: {
    students: {
      executor: 'per-vu-iterations',
      vus: students.length,
      iterations: 1,
      exec: 'studentFlow',
      maxDuration: '20m',
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: 'rate==0', abortOnFail: true }],
    ...(external ? { quiz_redeem_success: ['rate==1'], quiz_grade_contract_success: ['rate==1'] }
      : { quiz_course_list_success: ['rate==1'] }),
    quiz_open_success: ['rate==1'],
    quiz_autosave_success: ['rate==1'],
    quiz_submit_success: ['rate==1'],
    quiz_results_success: ['rate==1'],
    quiz_completed_students: [`count==${students.length}`],
    quiz_saved_answers: [`count==${students.length * questions.length}`],
    ...(external ? { quiz_redeem_duration: ['p(95)<3000'] } : {}),
    quiz_open_duration: ['p(95)<3000'],
    quiz_autosave_duration: ['p(95)<3000'],
    quiz_submit_duration: ['p(95)<3000'],
    quiz_results_duration: ['p(95)<3000'],
  },
};

function headers(token) {
  return {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function request(method, path, token, payload, name) {
  return http.request(method, `${API}${path}`, payload === undefined ? null : JSON.stringify(payload), {
    headers: headers(token),
    tags: { name },
  });
}

function body(response) {
  try { return response.json(); } catch { return {}; }
}

function answerFor(question, index) {
  switch (Number(question.type)) {
    case 0: return '1';
    case 1: return '0';
    case 2: return `Load-test survey answer ${index % 8}`;
    case 3: return ['0', '2', '4'];
    case 4: return '3.14';
    default: return '0';
  }
}

export function studentFlow() {
  const index = exec.scenario.iterationInTest;
  const student = students[index];
  if (!student) throw new Error(`Missing student for VU ${index + 1}`);
  if (loginSpreadSeconds) sleep((index % 101) / 101 * loginSpreadSeconds);

  const login = request('POST', '/auth/login', '', {
    email: student.email, password: state.password,
  }, 'quiz_login');
  const token = body(login).token;
  if (login.status !== 200 || !token) {
    openSuccess.add(false);
    console.error(`Quiz login failed for student ${index + 1}: ${login.status}`);
    return;
  }

  if (external) {
    const redeemed = request('POST', '/activity-codes/redeem', token, {
      code: state.session.activityCode,
    }, 'quiz_activity_redeem');
    redeemDuration.add(redeemed.timings.duration);
    const accepted = redeemed.status === 200
      && body(redeemed).sessionId === sessionId;
    redeemSuccess.add(accepted);
    if (!accepted) {
      console.error(`Quiz code redemption failed for participant ${index + 1}: ${redeemed.status}`);
      return;
    }
  } else {
    const courseList = request('GET', `/courses/${state.course.id}/sessions`, token, undefined, 'quiz_course_sessions');
    courseListDuration.add(courseList.timings.duration);
    courseListSuccess.add(courseList.status === 200);
    check(courseList, { 'course session list available': (response) => response.status === 200 });
  }

  const opened = request('GET', `/sessions/${sessionId}/quiz`, token, undefined, 'quiz_open');
  openDuration.add(opened.timings.duration);
  const openedOk = opened.status === 200 && body(opened).session?.anonymous === anonymous;
  openSuccess.add(openedOk);
  if (!openedOk) {
    console.error(`Quiz open failed for student ${index + 1}: ${opened.status}`);
    return;
  }

  for (const [questionIndex, question] of questions.entries()) {
    if (answerJitterMs) sleep(((index * 17 + questionIndex * 31) % 101) / 101 * answerJitterMs / 1000);
    const saved = request('PATCH', `/sessions/${sessionId}/quiz-response`, token, {
      questionId: question.id,
      answer: answerFor(question, index),
    }, 'quiz_autosave');
    autosaveDuration.add(saved.timings.duration);
    const ok = saved.status === 200;
    autosaveSuccess.add(ok);
    if (!ok) {
      console.error(`Quiz autosave failed for student ${index + 1}, question ${questionIndex + 1}: ${saved.status}`);
      return;
    }
    savedAnswers.add(1);
  }

  const submitted = request('POST', `/sessions/${sessionId}/submit`, token, {}, 'quiz_submit');
  submitDuration.add(submitted.timings.duration);
  const submittedOk = submitted.status === 200;
  submitSuccess.add(submittedOk);
  if (submittedOk) completedStudents.add(1);
  else console.error(`Quiz submit failed for student ${index + 1}: ${submitted.status}`);
}

export function teardown() {
  const login = request('POST', '/auth/login', '', {
    email: state.professor.email, password: state.password,
  }, 'quiz_professor_login');
  const token = body(login).token;
  if (login.status !== 200 || !token) {
    resultsSuccess.add(false);
    return;
  }
  const ended = request('PATCH', `/sessions/${sessionId}`, token, { status: 'done' }, 'quiz_end');
  if (ended.status !== 200) {
    resultsSuccess.add(false);
    console.error(`Quiz end failed: ${ended.status}`);
    return;
  }
  const results = request('GET', `/sessions/${sessionId}/results`, token, undefined, 'quiz_results');
  resultsDuration.add(results.timings.duration);
  const payload = body(results);
  const expectedRows = anonymous && students.length < 4 ? 0 : students.length;
  const rows = payload.studentResults || [];
  const privacyOk = !anonymous || (
    JSON.stringify(payload).indexOf('anon_') === -1
    && JSON.stringify(payload).indexOf(students[0].id) === -1
    && JSON.stringify(payload).indexOf(students[0].email) === -1
  );
  const answersCorrelate = rows.length === 0 || rows.every((row) =>
    questions.every((question) => row.questionResults?.some((result) =>
      String(result.questionId) === String(question.id) && result.responses?.length === 1)));
  const ok = results.status === 200 && rows.length === expectedRows && privacyOk && answersCorrelate;
  resultsSuccess.add(ok);
  check(results, { 'final quiz results match participants and privacy mode': () => ok });
  if (!ok) console.error(`Quiz results failed: status ${results.status}, rows ${rows.length}, expected ${expectedRows}`);
  if (external) {
    const grades = request('GET', `/sessions/${sessionId}/grades`, token, undefined, 'quiz_grades');
    const gradeRows = body(grades).grades || [];
    const enrolledIds = new Set(students.filter((student) => student.enrolled).map((student) => student.id));
    const gradesMatchRoster = grades.status === 200
      && gradeRows.length === (anonymous ? 0 : enrolledIds.size)
      && gradeRows.every((grade) => enrolledIds.has(grade.userId));
    const resultsMatchRoster = anonymous || rows.every((row) => row.guest === !enrolledIds.has(row.studentId));
    const contractOk = gradesMatchRoster && resultsMatchRoster;
    gradeContractSuccess.add(contractOk);
    check(grades, { 'shared quiz grades only enrolled students': () => contractOk });
  }
}
