import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, enrollStudentViaApi,
  expectNoCriticalAccessibilityViolations, loginViaUi, patchSessionViaApi, seedUsers,
} from './helpers.js';

for (const anonymous of [false, true]) {
  test(`quiz autosaves lock the open session editor (${anonymous ? 'shared anonymous' : 'named'})`, async ({ page, request }) => {
    const { admin, professor, student } = await seedUsers(request);
    const course = await createCourseViaApi(request, admin.token);
    await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
    if (anonymous) {
      const enabled = await apiJson(request, 'PATCH', `/courses/${course._id}`, {
        token: professor.token, payload: { allowSharedActivities: true },
      });
      expect(enabled.response.status()).toBe(200);
    } else {
      await enrollStudentViaApi(request, student.token, course.enrollmentCode);
    }
    const session = await createSessionViaApi(request, professor.token, course._id, { quiz: true, anonymous });
    const question = await createQuestionViaApi(request, professor.token, {
      sessionId: session._id, courseId: course._id, content: 'Original quiz prompt',
      options: [
        { content: 'First', correct: false },
        { content: 'Second', correct: true },
        { content: 'Third', correct: false },
      ],
    });
    await addQuestionToSessionViaApi(request, professor.token, session._id, question._id);
    await patchSessionViaApi(request, professor.token, session._id, { status: 'running' });
    if (anonymous) {
      const share = await apiJson(request, 'POST', `/sessions/${session._id}/activity-share`, {
        token: professor.token, payload: {},
      });
      expect(share.response.status()).toBe(200);
      const joined = await apiJson(request, 'POST', '/activity-codes/redeem', {
        token: student.token, payload: { code: share.body.code },
      });
      expect(joined.response.status()).toBe(200);
    }

    await loginViaUi(page, professor.email, professor.password, /\/prof$/);
    await page.goto(`/prof/course/${course._id}/session/${session._id}`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const typeSelect = page.getByRole('combobox').filter({ hasText: 'Multiple Choice' });
    await expect(typeSelect).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Add Option', exact: true })).toBeEnabled();

    // Saving an answer creates the response before the student submits the quiz.
    const saved = await apiJson(request, 'PATCH', `/sessions/${session._id}/quiz-response`, {
      token: student.token, payload: { questionId: question._id, answer: '1' },
    });
    expect(saved.response.status()).toBe(200);
    await expect(typeSelect).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add Option', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Remove option' }).first()).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
    const contentEditor = page.getByRole('textbox', { name: 'Rich text editor', exact: true }).first();
    await expect(contentEditor).toHaveText('Original quiz prompt');
    await contentEditor.fill('Clarified quiz prompt');
    await expect.poll(async () => {
      const result = await apiJson(request, 'GET', `/questions/${question._id}`, { token: professor.token });
      return result.body.question.content;
    }).toContain('Clarified quiz prompt');
    await expectNoCriticalAccessibilityViolations(page);

    const submitted = await apiJson(request, 'POST', `/sessions/${session._id}/submit`, { token: student.token });
    expect(submitted.response.status()).toBe(200);
    await patchSessionViaApi(request, professor.token, session._id, { status: 'done' });
    await page.reload();
    await page.getByRole('button', { name: 'Unlock Editing', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(typeSelect).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  });
}
