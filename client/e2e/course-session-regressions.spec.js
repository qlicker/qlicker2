import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, enrollStudentViaApi,
  expectNoCriticalAccessibilityViolations, loginViaUi, patchSessionViaApi, patchSettingsViaApi, seedUsers,
} from './helpers.js';

test('course settings retain their tab and course searches start expanded', async ({ page, request, browser }) => {
  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  await enrollStudentViaApi(request, student.token, course.enrollmentCode);
  const interactive = await createSessionViaApi(request, admin.token, course._id, { name: 'Searchable interactive' });
  await patchSessionViaApi(request, admin.token, interactive._id, { status: 'visible' });
  const quiz = await createSessionViaApi(request, admin.token, course._id, { name: 'Searchable quiz', quiz: true });
  await patchSessionViaApi(request, admin.token, quiz._id, { status: 'done' });
  await patchSettingsViaApi(request, admin.token, {
    AI_Enabled: true, AI_EnabledCourses: [course._id], Jitsi_Enabled: true, Jitsi_EnabledCourses: [course._id],
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.goto(`/prof/course/${course._id}`);
  await page.getByRole('tab', { name: /^Course Settings$/i }).click();
  await expect(page).toHaveURL(/tab=settings/);
  const settingsTab = page.getByRole('tab', { name: /^Course Settings$/i });
  for (const label of ['Enable AI helper', 'Enable course chat', 'Enable AI helper', 'Enable course chat']) {
    await page.getByLabel(label, { exact: true }).click();
    await expect(settingsTab).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/tab=settings/);
    await page.reload();
    await expect(settingsTab).toHaveAttribute('aria-selected', 'true');
  }
  for (const name of [/^Interactive Sessions/, /^Quizzes/]) {
    await page.getByRole('tab', { name }).click();
    const search = page.getByPlaceholder('Search by session name');
    await expect(search).toBeVisible();
    await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await expect(search).not.toBeVisible();
    await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await expect(search).toBeVisible();
  }
  await page.getByRole('button', { name: /Searchable quiz/i }).first().click();
  await expect(page).toHaveURL(/returnTab=1/);
  await page.getByRole('button', { name: /back to course/i }).click();
  await expect(page.getByRole('tab', { name: /^Quizzes/ })).toHaveAttribute('aria-selected', 'true');
  await expectNoCriticalAccessibilityViolations(page);

  const studentContext = await browser.newContext();
  page = await studentContext.newPage();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginViaUi(page, student.email, student.password, /\/student$/);
  await page.goto(`/student/course/${course._id}`);
  for (const name of [/^Lectures/, /^Quizzes/]) {
    await page.getByRole('tab', { name }).click();
    const search = page.getByPlaceholder('Search by session name');
    await expect(search).toBeVisible();
    await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await expect(search).not.toBeVisible();
    await page.getByRole('button', { name: 'Search sessions', exact: true }).click();
    await expect(search).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoCriticalAccessibilityViolations(page);
  await studentContext.close();
});

test('an ended quiz stays ended for the professor while its extension student can answer', async ({ browser, request }) => {
  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  await enrollStudentViaApi(request, student.token, course.enrollmentCode);
  const now = Date.now();
  const quiz = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Ended with extension', quiz: true,
    quizStart: new Date(now - 7200000).toISOString(), quizEnd: new Date(now - 3600000).toISOString(),
  });
  const question = await createQuestionViaApi(request, admin.token, {
    sessionId: quiz._id, courseId: course._id, content: 'Extension question',
  });
  await addQuestionToSessionViaApi(request, admin.token, quiz._id, question._id);
  await patchSessionViaApi(request, admin.token, quiz._id, { status: 'done' });
  const extension = await apiJson(request, 'PATCH', `/sessions/${quiz._id}/extensions`, {
    token: professor.token,
    payload: { extensions: [{ userId: student.user._id, quizStart: new Date(now - 60000).toISOString(), quizEnd: new Date(now + 3600000).toISOString() }] },
  });
  expect(extension.response.status()).toBe(200);
  const professorContext = await browser.newContext();
  const studentContext = await browser.newContext();
  try {
    const profPage = await professorContext.newPage();
    await loginViaUi(profPage, professor.email, professor.password, /\/prof$/);
    await profPage.goto(`/prof/course/${course._id}?tab=1`);
    await expect(profPage.getByText('Extensions Active', { exact: true })).toBeVisible();
    await expect(profPage.getByRole('button', { name: /Ended with extension Ended/i })).toBeVisible();
    await expect(profPage.getByLabel('Reviewable', { exact: true })).toBeDisabled();
    await profPage.getByRole('button', { name: /Ended with extension/i }).first().click();
    await expect(profPage.getByRole('switch', { name: 'Toggle student review access', exact: true })).toBeDisabled();

    const studentPage = await studentContext.newPage();
    await loginViaUi(studentPage, student.email, student.password, /\/student$/);
    await studentPage.goto(`/student/course/${course._id}?tab=1`);
    await studentPage.getByRole('button', { name: /Ended with extension/i }).first().click();
    await expect(studentPage.getByText('Extension question', { exact: true })).toBeVisible();
    await studentPage.getByRole('radio').nth(1).check();
    await studentPage.getByRole('button', { name: /Submit quiz/i }).click();
    await expect(studentPage.getByText(/Quiz submitted/i).first()).toBeVisible();
  } finally {
    await professorContext.close();
    await studentContext.close();
  }
});

test('numerical questions copied within a quiz keep independent student answers', async ({ page, request }) => {
  const { admin, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await enrollStudentViaApi(request, student.token, course.enrollmentCode);
  const now = Date.now();
  const quiz = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Independent numerical copies', quiz: true,
    quizStart: new Date(now - 60000).toISOString(), quizEnd: new Date(now + 3600000).toISOString(),
  });
  const source = await createQuestionViaApi(request, admin.token, {
    sessionId: quiz._id, courseId: course._id, type: 4, options: [],
    content: 'Enter a number', correctNumerical: 42, toleranceNumerical: 0,
  });
  await addQuestionToSessionViaApi(request, admin.token, quiz._id, source._id);
  const copied = await apiJson(request, 'POST', `/questions/${source._id}/copy-to-session`, {
    token: admin.token, payload: { sessionId: quiz._id },
  });
  expect(copied.response.status()).toBe(201);
  expect(copied.body.question._id).not.toBe(source._id);
  await patchSessionViaApi(request, admin.token, quiz._id, { status: 'visible' });
  await loginViaUi(page, student.email, student.password, /\/student$/);
  await page.goto(`/student/course/${course._id}?tab=1`);
  await page.getByRole('button', { name: /Independent numerical copies/i }).first().click();
  const answers = page.getByRole('spinbutton');
  await expect(answers).toHaveCount(2);
  await answers.nth(0).fill('42');
  await expect(answers.nth(1)).toHaveValue('');
  await answers.nth(1).fill('7');
  await expect(answers.nth(0)).toHaveValue('42');
  await expect(page.getByText('Saved', { exact: true })).toHaveCount(2);
  await page.reload();
  await expect(answers.nth(0)).toHaveValue('42');
  await expect(answers.nth(1)).toHaveValue('7');
});

for (const practiceQuiz of [false, true]) {
  test(`scrolling over numerical answers preserves values in a ${practiceQuiz ? 'practice' : 'normal'} quiz`, async ({ page, request }) => {
    const { admin, student } = await seedUsers(request);
    const course = await createCourseViaApi(request, admin.token);
    await enrollStudentViaApi(request, student.token, course.enrollmentCode);
    const now = Date.now();
    const quiz = await createSessionViaApi(request, admin.token, course._id, {
      name: 'Scroll-safe numerical quiz', quiz: true, practiceQuiz,
      quizStart: new Date(now - 60000).toISOString(), quizEnd: new Date(now + 3600000).toISOString(),
    });
    for (let index = 0; index < 6; index += 1) {
      const question = await createQuestionViaApi(request, admin.token, {
        sessionId: quiz._id, courseId: course._id, type: 4, options: [],
        content: `Numerical question ${index + 1}`, correctNumerical: 42, toleranceNumerical: 0,
      });
      await addQuestionToSessionViaApi(request, admin.token, quiz._id, question._id);
    }
    await patchSessionViaApi(request, admin.token, quiz._id, { status: 'visible' });
    await page.setViewportSize({ width: 1000, height: 600 });
    await loginViaUi(page, student.email, student.password, /\/student$/);
    await page.goto(`/student/course/${course._id}/session/${quiz._id}/quiz`);
    const input = page.getByRole('spinbutton', { name: 'Enter a number', exact: true }).nth(2);
    await input.fill('-1.25e-3');
    await expect(page.getByText('Saved', { exact: true })).toHaveCount(1);

    for (const focused of [true, false]) {
      for (const deltaY of [80, -80]) {
        await input.evaluate((element) => element.scrollIntoView({ block: 'center' }));
        if (focused) {
          await input.focus();
          await expect(input).toBeFocused();
        } else {
          await page.getByText('Numerical question 3', { exact: true }).click();
          await expect(input).not.toBeFocused();
        }
        await input.hover();
        const previousScroll = await page.evaluate(() => window.scrollY);
        await page.mouse.wheel(0, deltaY);
        await expect.poll(async () => {
          const nextScroll = await page.evaluate(() => window.scrollY);
          return deltaY > 0 ? nextScroll > previousScroll : nextScroll < previousScroll;
        }).toBe(true);
        await expect(input).not.toBeFocused();
        await expect(input).toHaveValue('-1.25e-3');
      }
    }

    await page.reload();
    await expect(input).toHaveValue('-1.25e-3');
    await input.fill('');
    await expect(page.getByText('Saved', { exact: true })).toHaveCount(1);
    await page.reload();
    await expect(input).toHaveValue('');
    await input.fill('42');
    await input.press('ArrowUp');
    await expect(input).toHaveValue('43');
    await expect(page.getByText('Saved', { exact: true })).toHaveCount(1);
    await page.reload();
    await expect(input).toHaveValue('43');
    await expectNoCriticalAccessibilityViolations(page);
  });
}

test('quiz status controls agree across the course and editor and Live keeps the quiz editor open', async ({ page, request }) => {
  const { admin, professor } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  const now = Date.now();
  const quiz = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Quiz with an old deadline', quiz: true,
    quizStart: new Date(now - 7200000).toISOString(), quizEnd: new Date(now - 3600000).toISOString(),
  });
  const editorPath = `/prof/course/${course._id}/session/${quiz._id}`;
  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.goto(`/prof/course/${course._id}?tab=1`);
  // The course search also has a Status filter, initially set to All.
  const status = page.getByRole('combobox', { name: 'Status', exact: true }).filter({ hasNotText: /^All$/ });
  await status.click();
  await page.getByRole('option', { name: 'Live', exact: true }).click();
  await expect(status).toHaveText('Live');
  await expect(status).toBeEnabled();
  await page.getByRole('button', { name: /Quiz with an old deadline Live/i }).first().click();
  await expect(page).toHaveURL(new RegExp(`${editorPath}\\?`));
  await expect(status).toHaveText('Live');
  await page.reload();
  await expect(status).toHaveText('Live');

  await status.click();
  await page.getByRole('option', { name: 'Ended', exact: true }).click();
  await expect(status).toHaveText('Ended');
  await expect(status).toBeEnabled();
  await page.getByRole('button', { name: /back to course/i }).click();
  await expect(status).toHaveText('Ended');

  await page.goto(editorPath);
  await status.click();
  await page.getByRole('option', { name: 'Live', exact: true }).click();
  await expect(status).toHaveText('Live');
  await expect(status).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`${editorPath}$`));
  await page.getByRole('button', { name: 'Review Live Session Results', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${editorPath}/review`));

  await patchSessionViaApi(request, admin.token, quiz._id, {
    status: 'hidden',
    quizStart: new Date(now - 60000).toISOString(), quizEnd: new Date(now + 3600000).toISOString(),
  });
  await page.goto(`/prof/course/${course._id}?tab=1`);
  await status.click();
  await page.getByRole('option', { name: 'Switch to Live/Ended based on dates', exact: true }).click();
  await page.getByRole('button', { name: 'Make quiz live', exact: true }).click();
  await expect(status).toHaveText('Live');
  await expect(status).toBeEnabled();
  await page.reload();
  await expect(status).toHaveText('Live');
  await page.goto(editorPath);
  await expect(status).toHaveText('Live');
});

test('student status filters offer Reviewable instead of Draft for lectures and quizzes', async ({ page, request }) => {
  const { admin, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await enrollStudentViaApi(request, student.token, course.enrollmentCode);
  for (const quiz of [false, true]) {
    for (const [name, status, reviewable] of [
      ['Ready for review', 'done', true],
      ['Review disabled', 'done', false],
      ['Not started', 'visible', false],
      ['Private draft', 'hidden', false],
    ]) {
      const session = await createSessionViaApi(request, admin.token, course._id, { name, quiz });
      await patchSessionViaApi(request, admin.token, session._id, { status, reviewable });
    }
  }
  await loginViaUi(page, student.email, student.password, /\/student$/);
  await page.goto(`/student/course/${course._id}`);
  for (const name of [/^Lectures/, /^Quizzes/]) {
    await page.getByRole('tab', { name }).click();
    await expect(page.getByText('Private draft', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Review disabled', { exact: true })).toBeVisible();
    const status = page.getByRole('combobox', { name: 'Status', exact: true });
    await status.click();
    await expect(page.getByRole('option', { name: 'Draft', exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: 'Reviewable', exact: true }).click();
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible();
    await expect(page.getByText('Review disabled', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Not started', { exact: true })).toHaveCount(0);
    await status.click();
    await page.getByRole('option', { name: 'Ended', exact: true }).click();
    await expect(page.getByText('Review disabled', { exact: true })).toBeVisible();
    await expect(page.getByText('Ready for review', { exact: true })).toBeVisible();
  }
});
