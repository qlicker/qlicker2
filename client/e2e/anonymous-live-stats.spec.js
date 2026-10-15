import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson, buildUser,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, enrollStudentViaApi,
  loginViaUi, seedUsers,
} from './helpers.js';

test('anonymous live results update in batches without a refresh and Show Stats controls the presentation', async ({ page, browser, request }) => {
  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  const participants = [student];
  for (let index = 1; index < 8; index += 1) {
    const { response, body } = await apiJson(request, 'POST', '/auth/register', { payload: buildUser('anon-stats') });
    expect(response.status()).toBe(201);
    participants.push(body);
  }
  for (const person of participants) await enrollStudentViaApi(request, person.token, course.enrollmentCode);
  const session = await createSessionViaApi(request, admin.token, course._id, { anonymous: true, name: 'Anonymous live batches' });
  const question = await createQuestionViaApi(request, admin.token, {
    sessionId: session._id, courseId: course._id, type: 2, content: 'Anonymous feedback', options: [],
  });
  await addQuestionToSessionViaApi(request, admin.token, session._id, question._id);
  const control = async (method, path, payload, token = professor.token, expectedStatus = 200) => {
    const result = await apiJson(request, method, `/sessions/${session._id}${path}`, { token, payload });
    expect(result.response.status(), JSON.stringify(result.body)).toBe(expectedStatus);
    return result.body;
  };
  await control('POST', '/start');
  await control('PATCH', '/question-visibility', { hidden: false, stats: false });
  await control('POST', '/join', {}, participants[0].token);
  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.goto(`/prof/course/${course._id}/session/${session._id}`);
  await expect(page.getByLabel('Anonymous responses', { exact: true })).toBeDisabled();
  // Exactly one join, no answers: server and editor both lock the setting.
  await control('PATCH', '', { anonymous: false }, professor.token, 409);
  for (const person of participants.slice(1)) await control('POST', '/join', {}, person.token);
  await page.goto(`/prof/course/${course._id}/session/${session._id}/live`);
  await expect(page.getByText('Anonymous feedback')).toBeVisible();
  const privacyNotice = page.getByRole('status').filter({ hasText: 'To protect anonymity' });
  await expect(privacyNotice).toContainText('at least four different participants');
  const presentation = await page.context().newPage();
  const studentContext = await browser.newContext();
  try {
    await presentation.goto(`/prof/course/${course._id}/session/${session._id}/present`);
    const studentPage = await studentContext.newPage();
    await loginViaUi(studentPage, student.email, student.password, /\/student$/);
    await studentPage.goto(`/student/course/${course._id}/session/${session._id}/live`);
    await expect(studentPage.getByText('Anonymous feedback')).toBeVisible();
    const liveReads = [];
    page.on('request', (req) => { if (req.method() === 'GET' && new URL(req.url()).pathname.endsWith(`/sessions/${session._id}/live`)) liveReads.push(req.url()); });
    for (let index = 0; index < 3; index += 1) {
      await control('POST', '/respond', { answer: `Anonymous comment ${index + 1}` }, participants[index].token, 201);
    }
    await expect(page.getByText('Anonymous comment 2', { exact: true })).toHaveCount(0);
    await expect(privacyNotice).toBeVisible();
    await control('POST', '/respond', { answer: 'Anonymous comment 4' }, participants[3].token, 201);
    await expect(page.getByText('Anonymous comment 4', { exact: true })).toBeVisible();
    await expect(page.getByText(/Showing 4 responses/)).toBeVisible();
    await expect(privacyNotice).toHaveCount(0);
    await expect(presentation.getByText('Anonymous comment 4', { exact: true })).toHaveCount(0);
    const statsSwitch = page.getByRole('switch', { name: 'Show Stats', exact: true });
    await statsSwitch.click();
    await expect(statsSwitch).toBeChecked();
    await expect(presentation.getByText('Anonymous comment 4', { exact: true })).toBeVisible();
    await expect(studentPage.getByText('Anonymous comment 4', { exact: true })).toBeVisible();
    await control('POST', '/respond', { answer: 'Anonymous comment 5' }, participants[4].token, 201);
    await expect(page.getByText('Anonymous comment 5', { exact: true })).toHaveCount(0);
    await statsSwitch.click();
    await expect(statsSwitch).not.toBeChecked();
    await expect(presentation.getByText('Anonymous comment 4', { exact: true })).toHaveCount(0);
    await statsSwitch.click();
    await expect(statsSwitch).toBeChecked();
    await expect(presentation.getByText('Anonymous comment 4', { exact: true })).toBeVisible();
    await expect(presentation.getByText('Anonymous comment 5', { exact: true })).toHaveCount(0);
    for (let index = 5; index < 8; index += 1) {
      await control('POST', '/respond', { answer: `Anonymous comment ${index + 1}` }, participants[index].token, 201);
    }
    await expect(page.getByText(/Showing 8 responses/)).toBeVisible();
    await expect(presentation.getByText('Anonymous comment 8', { exact: true })).toBeVisible();
    await expect(studentPage.getByText('Anonymous comment 8', { exact: true })).toBeVisible();
    expect(liveReads).toEqual([]);
  } finally {
    await presentation.close();
    await studentContext.close();
  }
});
