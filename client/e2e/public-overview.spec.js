import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson, buildUser,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, enrollStudentViaApi,
  expectNoCriticalAccessibilityViolations, loginViaUi, patchSessionViaApi, seedUsers,
} from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function capture(page, filename) {
  if (process.env.QCLICKER_CAPTURE_MANUALS !== '1') return;
  const docsPath = path.join(root, 'docs/assets/manuals', filename);
  await page.screenshot({ path: docsPath, animations: 'disabled' });
  await fs.copyFile(docsPath, path.join(root, 'client/public/manuals', filename));
}

test('capture the public landing page', async ({ page }) => {
  test.skip(process.env.QCLICKER_CAPTURE_MANUALS !== '1', 'Opt-in documentation capture.');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /get started/i })).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    const video = document.querySelector('video');
    if (video) {
      if (video.readyState < 2) await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }));
      video.pause();
    }
  });
  await capture(page, 'landing-page.png');
});

test('anonymous review shows the full grading preview without grade controls or invented points', async ({ page, request }) => {
  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token, { name: 'Introduction to Biology', deptCode: 'BIOL', courseNumber: '101' });
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  const participants = [student];
  for (let i = 1; i < 4; i += 1) {
    const registered = await apiJson(request, 'POST', '/auth/register', { payload: buildUser('review-survey') });
    expect(registered.response.status()).toBe(201);
    participants.push(registered.body);
  }
  for (const participant of participants) await enrollStudentViaApi(request, participant.token, course.enrollmentCode);
  const session = await createSessionViaApi(request, professor.token, course._id, { anonymous: true, name: 'Anonymous concept check' });
  const question = await createQuestionViaApi(request, professor.token, {
    sessionId: session._id, courseId: course._id, type: 0,
    content: '<p>Which organelle produces most of a cell’s ATP?</p>',
    options: [{ content: '<p>Nucleus</p>', correct: false }, { content: '<p>Mitochondrion</p>', correct: true }, { content: '<p>Ribosome</p>', correct: false }],
    solution: '<p>Mitochondria convert energy from nutrients into ATP.</p>',
  });
  await addQuestionToSessionViaApi(request, professor.token, session._id, question._id);
  expect((await apiJson(request, 'POST', `/sessions/${session._id}/start`, { token: professor.token })).response.status()).toBe(200);
  await apiJson(request, 'PATCH', `/sessions/${session._id}/question-visibility`, { token: professor.token, payload: { hidden: false } });
  for (const participant of participants) {
    expect((await apiJson(request, 'POST', `/sessions/${session._id}/join`, { token: participant.token, payload: {} })).response.status()).toBe(200);
    expect((await apiJson(request, 'POST', `/sessions/${session._id}/respond`, { token: participant.token, payload: { answer: '1' } })).response.status()).toBe(201);
  }
  // A sparse second attempt must not hide the first attempt's eligible rows.
  expect((await apiJson(request, 'POST', `/sessions/${session._id}/new-attempt`, { token: professor.token })).response.status()).toBe(200);
  await apiJson(request, 'PATCH', `/sessions/${session._id}/question-visibility`, { token: professor.token, payload: { hidden: false } });
  for (const participant of participants.slice(0, 3)) {
    expect((await apiJson(request, 'POST', `/sessions/${session._id}/respond`, { token: participant.token, payload: { answer: '0' } })).response.status()).toBe(201);
  }
  await patchSessionViaApi(request, professor.token, session._id, { status: 'done', reviewable: true });
  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  const gradeRequests = [];
  page.on('request', (req) => { if (new URL(req.url()).pathname.startsWith('/api/v1/') && /\/grades(?:\/|\?|$)/.test(new URL(req.url()).pathname)) gradeRequests.push(req.url()); });
  await page.setViewportSize({ width: 1440, height: 1440 });
  await page.goto(`/prof/course/${course._id}/session/${session._id}/review`);
  await expect(page.getByText('3 responses', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Response Data' }).click();
  const table = page.getByRole('table', { name: 'Student results' });
  await expect(table.getByRole('cell', { name: 'B', exact: true })).toHaveCount(4);
  await expect(table.getByText('B (0)', { exact: true })).toHaveCount(0);
  await expect(table.getByRole('cell', { name: 'Answers hidden — fewer than 4 respondents.', exact: true })).toHaveCount(4);
  await expect(table.getByRole('cell', { name: 'A', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Responses by question' }).click();
  await expect(page.getByText('3 responses', { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Anonymous responses' })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Attempt', exact: true }).click();
  await page.getByRole('option', { name: 'Attempt 1/2', exact: true }).click();
  await expect(page.getByText('4 responses', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Question navigator' })).toBeVisible();
  await expect(page.getByText('Nucleus', { exact: true })).toBeVisible();
  await expect(page.getByText('Ribosome', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show Solution' }).click();
  await expect(page.getByText('Mitochondria convert energy from nutrients into ATP.')).toBeVisible();
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  expect(gradeRequests).toEqual([]);
  await expectNoCriticalAccessibilityViolations(page);
  await capture(page, 'professor-anonymous-review.png');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('navigation', { name: 'Question navigator' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
