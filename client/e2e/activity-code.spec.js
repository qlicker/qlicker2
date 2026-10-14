import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, loginViaUi,
  patchSessionViaApi, seedUsers, expectNoCriticalAccessibilityViolations,
} from './helpers.js';

test('course opt-in and session switch expose a persistent code for an outside quiz', async ({ page, browser, request }) => {
  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  const quiz = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Outside quiz', quiz: true,
    quizStart: new Date(Date.now() - 60_000).toISOString(),
    quizEnd: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const question = await createQuestionViaApi(request, admin.token, {
    sessionId: quiz._id, courseId: course._id, content: 'Outside quiz question',
  });
  await addQuestionToSessionViaApi(request, admin.token, quiz._id, question._id);
  await patchSessionViaApi(request, admin.token, quiz._id, { status: 'visible' });

  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.goto(`/prof/course/${course._id}/session/${quiz._id}`);
  const sharing = page.getByLabel('Enable sharing this activity outside the course');
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Outside quiz');
  await expect(sharing).toHaveCount(0);
  await page.goto(`/prof/course/${course._id}`);
  await page.getByRole('tab', { name: /^Course Settings$/i }).click();
  await page.getByLabel('Allow activities to be shared by code').click();
  await expect(page.getByLabel('Allow activities to be shared by code')).toBeChecked();

  await page.goto(`/prof/course/${course._id}/session/${quiz._id}`);
  await expect(sharing).toBeEnabled();
  await sharing.click();
  await expect(sharing).toBeChecked();
  const codeField = page.getByTestId('activity-share-code');
  await expect(codeField).toHaveText(/^S-[A-HJ-NP-Z2-9]{10}$/);
  const code = await codeField.textContent();
  await page.reload();
  await expect(sharing).toBeChecked();
  await expect(codeField).toHaveText(code);
  await expect(page.getByRole('button', { name: 'Regenerate code' })).toBeVisible();

  await sharing.click();
  await expect(sharing).not.toBeChecked();
  expect((await apiJson(request, 'POST', '/activity-codes/redeem', {
    token: student.token, payload: { code },
  })).response.status()).toBe(404);
  await sharing.click();
  await expect(sharing).toBeChecked();
  await expect(codeField).toHaveText(code);
  await page.getByRole('button', { name: 'Regenerate code' }).click();
  await expect(codeField).not.toHaveText(code);
  const regeneratedCode = await codeField.textContent();
  expect(regeneratedCode).toMatch(/^S-[A-HJ-NP-Z2-9]{10}$/);
  expect((await apiJson(request, 'POST', '/activity-codes/redeem', {
    token: student.token, payload: { code },
  })).response.status()).toBe(404);

  const studentContext = await browser.newContext();
  try {
    const studentPage = await studentContext.newPage();
    await loginViaUi(studentPage, student.email, student.password, /\/student$/);
    await studentPage.getByRole('button', { name: 'Join activity' }).first().click();
    await expect(studentPage.getByRole('dialog').getByText(/starting with S-/)).toBeVisible();
    await studentPage.getByRole('textbox', { name: 'Activity code' }).fill(regeneratedCode);
    await studentPage.getByRole('dialog').getByRole('button', { name: 'Join activity' }).click();
    await expect(studentPage).toHaveURL(new RegExp(`/activity/${course._id}/session/${quiz._id}/quiz`));
    await expect(studentPage.getByText('Outside quiz question')).toBeVisible();
    await studentPage.getByRole('button', { name: 'Back to dashboard' }).click();
    await expect(studentPage).toHaveURL(/\/student$/);

    await sharing.click();
    await expect(sharing).not.toBeChecked();
    await expect(codeField).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Regenerate code' })).toHaveCount(0);
    const denied = await apiJson(request, 'GET', `/sessions/${quiz._id}/quiz`, { token: student.token });
    expect(denied.response.status()).toBe(403);
  } finally {
    await studentContext.close();
  }
});


test('a guest professor completes a quiz and later enrolls without losing their responses', async ({ page, request }) => {
  const { admin, professor } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await apiJson(request, 'PATCH', `/courses/${course._id}`, { token: admin.token, payload: { allowSharedActivities: true } });
  const quiz = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Guest professor quiz', quiz: true,
    quizStart: new Date(Date.now() - 60_000).toISOString(),
    quizEnd: new Date(Date.now() + 3_600_000).toISOString(),
  });
  const question = await createQuestionViaApi(request, admin.token, {
    sessionId: quiz._id, courseId: course._id, content: 'Guest professor question',
  });
  await addQuestionToSessionViaApi(request, admin.token, quiz._id, question._id);
  await patchSessionViaApi(request, admin.token, quiz._id, { status: 'visible' });
  const issued = await apiJson(request, 'POST', `/sessions/${quiz._id}/activity-share`, { token: admin.token, payload: {} });
  expect(issued.response.status()).toBe(200);
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await expect(page.getByRole('button', { name: 'Enroll in a Course as a Student' })).toBeVisible();
  await page.getByRole('button', { name: 'Join activity' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/starting with S-/)).toBeVisible();
  await expectNoCriticalAccessibilityViolations(page);
  await dialog.getByRole('textbox', { name: 'Activity code' }).fill(issued.body.code);
  await dialog.getByRole('button', { name: 'Join activity' }).click();
  await expect(page).toHaveURL(new RegExp(`/activity/${course._id}/session/${quiz._id}/quiz`));
  await expect(page.getByText('Guest professor question')).toBeVisible();
  await page.getByRole('radio').nth(1).check();
  const submitted = page.waitForResponse((response) => response.url().endsWith(`/sessions/${quiz._id}/submit`) && response.request().method() === 'POST');
  await page.getByRole('button', { name: /Submit quiz/i }).click();
  expect((await submitted).status()).toBe(200);
  await expect(page).toHaveURL(/\/prof$/);
  await patchSessionViaApi(request, admin.token, quiz._id, { status: 'done', reviewable: true });
  const before = await apiJson(request, 'GET', `/sessions/${quiz._id}/results`, { token: admin.token });
  const beforeRow = before.body.studentResults.find((row) => row.studentId === professor.user._id);
  expect(beforeRow.guest).toBe(true);
  const beforeGrades = await apiJson(request, 'GET', `/sessions/${quiz._id}/grades`, { token: admin.token });
  expect(beforeGrades.body.grades).toHaveLength(0);
  await page.getByRole('button', { name: 'Enroll in a Course as a Student' }).click();
  await page.getByRole('textbox', { name: /Enrollment Code/i }).fill(course.enrollmentCode);
  const enrollment = page.waitForResponse((response) => response.url().endsWith('/courses/enroll') && response.request().method() === 'POST');
  await page.getByRole('dialog').getByRole('button', { name: /^Enroll$/i }).click();
  expect((await enrollment).status()).toBe(200);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const after = await apiJson(request, 'GET', `/sessions/${quiz._id}/results`, { token: admin.token });
  const afterRow = after.body.studentResults.find((row) => row.studentId === professor.user._id);
  expect(afterRow).toMatchObject({ guest: false, participantRole: 'student', isProfessor: true });
  expect(afterRow.questionResults).toEqual(beforeRow.questionResults);
  const grades = await apiJson(request, 'GET', `/sessions/${quiz._id}/grades`, { token: professor.token });
  expect(grades.response.status()).toBe(200);
  expect(grades.body.grades).toHaveLength(1);
  expect(grades.body.grades[0]).toMatchObject({ value: 100, needsGrading: false });

});
