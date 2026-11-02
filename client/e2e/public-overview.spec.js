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

test('the landing page has one llama greeting on hover and keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const llama = page.getByRole('button', { name: 'Llama', exact: true });
  const greeting = page.getByRole('tooltip');
  await expect(llama).toHaveCount(1);
  await expect(greeting).toHaveCount(0);
  // Move to its current position without waiting for a floating doodle to stop moving.
  const floatingBounds = await llama.boundingBox();
  await page.mouse.move(floatingBounds.x + floatingBounds.width / 2, floatingBounds.y + floatingBounds.height / 2);
  await expect(greeting).toHaveText('hello');
  await expect(llama).toHaveCSS('animation-play-state', 'paused');
  const llamaBounds = await llama.boundingBox();
  const greetingBounds = await greeting.boundingBox();
  expect(greetingBounds.x).toBeGreaterThan(llamaBounds.x + llamaBounds.width * 0.8);
  expect(greetingBounds.y).toBeGreaterThan(llamaBounds.y);
  expect(greetingBounds.y).toBeLessThan(llamaBounds.y + llamaBounds.height / 2);
  await page.mouse.move(0, 0);
  await expect(greeting).toHaveCount(0);
  await page.getByRole('button', { name: /get started/i }).focus();
  await page.keyboard.press('Tab');
  await expect(llama).toBeFocused();
  await expect(greeting).toHaveText('hello');
  await page.keyboard.press('Escape');
  await expect(greeting).toHaveCount(0);
  await expectNoCriticalAccessibilityViolations(page);
});

test('the landing page llama supports touch and reduced motion on mobile', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const llama = page.getByRole('button', { name: 'Llama', exact: true });
  const greeting = page.getByRole('tooltip');
  await expect(llama).toHaveCount(1);
  await expect(llama).toHaveCSS('animation-name', 'none');
  await expect(llama).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  const llamaBounds = await llama.boundingBox();
  const copyBounds = await page.getByRole('heading', { level: 1 }).boundingBox();
  expect(llamaBounds.y + llamaBounds.height < copyBounds.y || llamaBounds.y > copyBounds.y + copyBounds.height).toBe(true);
  await llama.dispatchEvent('touchstart', { touches: [{ identifier: 1 }] });
  await expect(greeting).toHaveText('hello');
  await llama.dispatchEvent('touchend', { touches: [] });
  await expect(greeting).toHaveCount(0);
});

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

test('anonymous live quiz review releases batches and handles answers without timestamps', async ({ page, request }) => {
  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token, { name: 'Anonymous quiz review' });
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  const participants = [student];
  for (let index = 1; index < 9; index += 1) {
    const registered = await apiJson(request, 'POST', '/auth/register', { payload: buildUser('batch-survey') });
    expect(registered.response.status()).toBe(201);
    participants.push(registered.body);
  }
  for (const participant of participants) await enrollStudentViaApi(request, participant.token, course.enrollmentCode);
  const session = await createSessionViaApi(request, professor.token, course._id, { quiz: true, anonymous: true, name: 'Anonymous concept quiz' });
  const question = await createQuestionViaApi(request, professor.token, {
    sessionId: session._id, courseId: course._id, type: 0,
    content: '<p>Which organelle produces most of a cell’s ATP?</p>',
    options: [{ content: 'Nucleus', correct: false }, { content: 'Mitochondrion', correct: true }],
  });
  await addQuestionToSessionViaApi(request, professor.token, session._id, question._id);
  await patchSessionViaApi(request, professor.token, session._id, { status: 'running' });
  const call = async (method, suffix, payload, token = professor.token) => {
    const result = await apiJson(request, method, `/sessions/${session._id}${suffix}`, { token, payload });
    expect(result.response.status(), JSON.stringify(result.body)).toBe(200);
    return result.body;
  };
  for (let index = 0; index < participants.length; index += 1) {
    await call('PATCH', '/quiz-response', { questionId: question._id, answer: index < 4 ? '1' : '0' }, participants[index].token);
    if (index < 3) await call('POST', '/submit', {}, participants[index].token);
  }
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.goto(`/prof/course/${course._id}`);
  await page.getByRole('tab', { name: /^Quizzes/ }).click();
  await expect(page.getByText('Live review needs at least 4 submitted quizzes.')).toBeVisible();
  await expect(page.getByRole('button', { name: /review live.*anonymous concept quiz/i })).toHaveCount(0);
  await call('POST', '/submit', {}, participants[3].token);
  await page.getByRole('button', { name: /review live.*anonymous concept quiz/i }).click();
  await expect(page.getByText(/Anonymous live review releases submitted quizzes in batches of 4/)).toBeVisible();
  await expect(page.getByRole('button', { name: /response timeline/i })).toHaveCount(0);
  await expectNoCriticalAccessibilityViolations(page);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await capture(page, 'professor-anonymous-live-review.png');
  const firstBatch = (await call('GET', '/results')).studentResults;
  expect(firstBatch).toHaveLength(4);
  expect(JSON.stringify(firstBatch)).not.toMatch(/createdAt|updatedAt|anon_/);
  await page.getByRole('tab', { name: 'Response Data', exact: true }).click();
  const table = page.getByRole('table', { name: 'Student results', exact: true });
  await expect(table.getByRole('row')).toHaveCount(5);
  for (const participant of participants.slice(4, 7)) {
    await call('POST', '/submit', {}, participant.token);
    expect((await call('GET', '/results')).studentResults).toEqual(firstBatch);
  }
  await page.reload();
  await page.getByRole('tab', { name: 'Response Data', exact: true }).click();
  await expect(table.getByRole('row')).toHaveCount(5);
  await call('POST', '/submit', {}, participants[7].token);
  await expect(table.getByRole('row')).toHaveCount(9);
  await call('PATCH', '', { status: 'done' });
  await expect(table.getByRole('row')).toHaveCount(10);
  await expect(page.getByRole('button', { name: /response timeline/i })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('combobox', { name: 'View', exact: true }).click();
  await page.getByRole('option', { name: 'Responses by question', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Anonymous responses', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
