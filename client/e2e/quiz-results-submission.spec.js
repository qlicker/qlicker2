import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson, buildUser,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, enrollStudentViaApi,
  loginViaUi, seedUsers, expectNoCriticalAccessibilityViolations,
} from './helpers.js';

test('quiz review updates on submission and ending without a page refresh', async ({ page, request }) => {
  const { admin, professor, student } = await seedUsers(request);
  const otherUser = buildUser('forgotten', 'Forgotten');
  const registered = await apiJson(request, 'POST', '/auth/register', { payload: otherUser });
  expect(registered.response.status()).toBe(201);
  const other = { ...otherUser, ...registered.body };
  const course = await createCourseViaApi(request, admin.token);
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  for (const token of [student.token, other.token]) await enrollStudentViaApi(request, token, course.enrollmentCode);
  const session = await createSessionViaApi(request, professor.token, course._id, { quiz: true });
  const question = await createQuestionViaApi(request, professor.token, {
    courseId: course._id, sessionId: session._id, type: 2, content: 'Explain your choice',
  });
  await addQuestionToSessionViaApi(request, professor.token, session._id, question._id);
  const call = async (method, suffix, payload, token = professor.token) => {
    const { response, body } = await apiJson(request, method, `/sessions/${session._id}${suffix}`, { token, payload });
    expect(response.status(), JSON.stringify(body)).toBe(200);
    return body;
  };
  await call('PATCH', '', { status: 'running' });
  await call('PATCH', '/quiz-response', { questionId: question._id, answer: 'First draft answer' }, student.token);
  await call('PATCH', '/quiz-response', { questionId: question._id, answer: 'Forgotten saved answer' }, other.token);
  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.goto(`/prof/course/${course._id}/session/${session._id}/review`);
  await expect(page.getByText(/only submitted quizzes are shown/i)).toBeVisible();
  await page.getByRole('tab', { name: 'Response Data', exact: true }).click();
  await expect(page.getByText('First draft answer', { exact: true })).toHaveCount(0);
  await call('PATCH', '/quiz-response', { questionId: question._id, answer: 'Final revised answer' }, student.token);
  await call('POST', '/submit', {}, student.token);
  const results = page.getByRole('table', { name: 'Student results', exact: true });
  await expect(results.getByText(`${student.firstname} ${student.lastname}`, { exact: true })).toBeVisible();
  await expect(results.getByText(`${other.firstname} ${other.lastname}`, { exact: true })).toHaveCount(0);
  await call('PATCH', '', { status: 'done' });
  await expect(results.getByText(`${other.firstname} ${other.lastname}`, { exact: true })).toBeVisible();
  await expect(page.getByText(/only submitted quizzes are shown/i)).toHaveCount(0);
  const final = await call('GET', '/results');
  expect(final.studentResults.flatMap((row) => row.questionResults.flatMap((entry) => entry.responses.map((response) => response.answer))))
    .toEqual(expect.arrayContaining(['Final revised answer', 'Forgotten saved answer']));
});

test('instructor permits skipped zero-point questions without reducing grades or participation', async ({ page, request }) => {
  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  await enrollStudentViaApi(request, student.token, course.enrollmentCode);
  const session = await createSessionViaApi(request, professor.token, course._id, { name: 'Optional survey questions', quiz: true });
  const questions = [];
  for (const [content, points] of [['Scored number', 2], ['Optional feedback number', 0]]) {
    const question = await createQuestionViaApi(request, professor.token, {
      courseId: course._id, sessionId: session._id, type: 4, content, options: [],
      correctNumerical: 7, toleranceNumerical: 0, sessionOptions: { points },
    });
    await addQuestionToSessionViaApi(request, professor.token, session._id, question._id);
    questions.push(question);
  }
  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.goto(`/prof/course/${course._id}/session/${session._id}`);
  const optionalToggle = page.getByRole('switch', { name: 'Allow quiz submission with unanswered 0-point questions' });
  await expect(optionalToggle).not.toBeChecked();
  await optionalToggle.click();
  await expect(optionalToggle).toBeChecked();
  await page.reload();
  await expect(optionalToggle).toBeChecked();
  await expectNoCriticalAccessibilityViolations(page);
  const started = await apiJson(request, 'PATCH', `/sessions/${session._id}`, { token: professor.token, payload: { status: 'running' } });
  expect(started.response.status()).toBe(200);
  await loginViaUi(page, student.email, student.password, /\/student$/);
  await page.goto(`/student/course/${course._id}/session/${session._id}/quiz`);
  await expect(page.getByText('Optional (0 points)', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit Quiz', exact: true })).toHaveCount(0);
  await page.getByRole('spinbutton', { name: 'Enter a number' }).first().fill('7');
  const submit = page.getByRole('button', { name: 'Submit Quiz', exact: true });
  await expect(submit).toBeEnabled();
  await expectNoCriticalAccessibilityViolations(page);
  await submit.click();
  await expect(page).toHaveURL(new RegExp(`/student/course/${course._id}\\?`));
  const ended = await apiJson(request, 'PATCH', `/sessions/${session._id}`, { token: professor.token, payload: { status: 'done' } });
  expect(ended.response.status()).toBe(200);
  const grades = await apiJson(request, 'GET', `/sessions/${session._id}/grades`, { token: professor.token });
  expect(grades.response.status()).toBe(200);
  const grade = grades.body.grades.find((entry) => entry.userId === student.user._id);
  expect(grade).toMatchObject({ value: 100, points: 2, outOf: 2, participation: 100, numAnswered: 1, numQuestions: 1, needsGrading: false });
  expect(grade.marks.find((mark) => mark.questionId === questions[1]._id)).toMatchObject({ outOf: 0, responseId: '', needsGrading: false });
});
