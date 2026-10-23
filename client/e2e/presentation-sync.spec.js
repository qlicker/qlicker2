import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, enrollStudentViaApi,
  loginViaUi, patchSessionViaApi, seedUsers,
} from './helpers.js';

test('presentation keeps response and chat names private while live visibility and navigation change', async ({ browser, request }) => {
  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token);
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  await enrollStudentViaApi(request, student.token, course.enrollmentCode);
  const session = await createSessionViaApi(request, admin.token, course._id);
  const ids = [];
  for (const content of ['Explain the first concept', 'Explain the next concept']) {
    const question = await createQuestionViaApi(request, admin.token, {
      sessionId: session._id, courseId: course._id, type: 2, content, options: [],
    });
    const updated = await addQuestionToSessionViaApi(request, admin.token, session._id, question._id);
    ids.push(updated.questions.at(-1));
  }
  await patchSessionViaApi(request, admin.token, session._id, { chatEnabled: true });
  const control = async (method, path, payload, token = professor.token, expectedStatus = 200) => {
    const result = await apiJson(request, method, `/sessions/${session._id}${path}`, { token, payload });
    expect(result.response.status(), JSON.stringify(result.body)).toBe(expectedStatus);
    return result.body;
  };
  await control('POST', '/start');
  await control('PATCH', '/question-visibility', { hidden: false, stats: true });
  await control('POST', '/join', {}, student.token);

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginViaUi(page, professor.email, professor.password, /\/prof$/);
    await page.goto(`/prof/course/${course._id}/session/${session._id}/present`);
    await expect(page.getByText('Explain the first concept')).toBeVisible();
    await control('POST', '/respond', { answer: 'An anonymous live response' }, student.token, 201);
    await expect(page.getByText('An anonymous live response')).toBeVisible();
    await expect(page.getByText(`${student.firstname} ${student.lastname}`, { exact: true })).toHaveCount(0);
    await control('PATCH', '/question-visibility', { responseListVisible: false });
    await expect(page.getByText('An anonymous live response')).toHaveCount(0);
    await control('PATCH', '/question-visibility', { responseListVisible: true });
    await expect(page.getByText('An anonymous live response')).toBeVisible();

    await page.getByRole('tab', { name: /^Chat$/ }).click();
    await control('POST', '/chat/posts', { body: 'Anonymous classroom chat', bodyWysiwyg: '<p>Anonymous classroom chat</p>' }, student.token);
    await expect(page.getByText('Anonymous classroom chat')).toBeVisible();
    await expect(page.getByText(`${student.firstname} ${student.lastname}`, { exact: true })).toHaveCount(0);
    // Navigation while the other panel is open must still update the live state.
    await control('PATCH', '/current', { questionId: ids[1] });
    await page.getByRole('tab', { name: /Current Question/i }).click();
    await expect(page.getByText('Explain the next concept')).toBeVisible();
    await expect(page.getByText('An anonymous live response')).toHaveCount(0);
    await control('PATCH', '/current', { questionId: ids[0] });
    await expect(page.getByText('An anonymous live response')).toBeVisible();
    await expect(page.getByText(`${student.firstname} ${student.lastname}`, { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
