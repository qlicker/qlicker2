import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, loginViaUi, seedUsers,
} from './helpers.js';

for (const anonymous of [false, true]) {
  test(`shared live chat reaches guests and instructors (anonymous=${anonymous})`, async ({ page, browser, request }) => {
    const { admin, professor, student } = await seedUsers(request);
    const course = await createCourseViaApi(request, admin.token);
    await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
    expect((await apiJson(request, 'PATCH', `/courses/${course._id}`, {
      token: admin.token, payload: { allowSharedActivities: true },
    })).response.status()).toBe(200);
    const session = await createSessionViaApi(request, professor.token, course._id, { anonymous });
    const question = await createQuestionViaApi(request, professor.token, { courseId: course._id, sessionId: session._id });
    await addQuestionToSessionViaApi(request, professor.token, session._id, question._id);
    const call = async (method, suffix, payload, token = professor.token) => {
      const { response, body } = await apiJson(request, method, `/sessions/${session._id}${suffix}`, { token, payload });
      expect(response.status(), JSON.stringify(body)).toBe(200);
      return body;
    };
    await call('POST', '/start');
    const { code } = await call('POST', '/activity-share', {});
    expect((await apiJson(request, 'POST', '/activity-codes/redeem', {
      token: student.token, payload: { code },
    })).response.status()).toBe(200);
    await call('POST', '/join', {}, student.token);
    await loginViaUi(page, professor.email, professor.password, /\/prof$/);
    await page.goto(`/prof/course/${course._id}/session/${session._id}/live`);
    const guestContext = await browser.newContext();
    try {
      const guestPage = await guestContext.newPage();
      await loginViaUi(guestPage, student.email, student.password, /\/student$/);
      await guestPage.goto(`/activity/${course._id}/session/${session._id}/live`);
      await expect(guestPage.getByRole('button', { name: 'Back to dashboard' })).toBeVisible();
      await expect(guestPage.getByRole('tab', { name: /^Chat/ })).toHaveCount(0);
      await page.getByLabel('Enable session chat').click();
      await expect(page.getByLabel('Enable session chat')).toBeChecked();
      await guestPage.getByRole('tab', { name: /^Chat/ }).click();
      await page.getByRole('tab', { name: /^Chat/ }).click();
      const guestEditor = guestPage.getByRole('textbox', { name: 'Session chat post editor' });
      const writePost = guestPage.getByRole('button', { name: 'Write a post' });
      await expect(guestEditor.or(writePost)).toBeVisible();
      if (!(await guestEditor.isVisible())) await writePost.click();
      await guestEditor.fill('A question from a guest');
      await guestPage.getByRole('button', { name: 'Post', exact: true }).click();
      await expect(guestPage.getByText('A question from a guest', { exact: true })).toBeVisible();
      await expect(page.getByText('A question from a guest', { exact: true })).toBeVisible();
      // Instructor messages arrive through the existing delta stream without a reload.
      await call('POST', '/chat/posts', { body: 'A reply from the instructor' });
      await expect(guestPage.getByText('A reply from the instructor', { exact: true })).toBeVisible();
      // A fresh page must retain access as well as receiving live settings updates.
      await guestPage.reload();
      await guestPage.getByRole('tab', { name: /^Chat/ }).click();
      await expect(guestPage.getByText('A reply from the instructor', { exact: true })).toBeVisible();
      await page.getByLabel('Enable session chat').click();
      await expect(page.getByLabel('Enable session chat')).not.toBeChecked();
      await expect(guestPage.getByRole('tab', { name: /^Chat/ })).toHaveCount(0);
    } finally {
      await guestContext.close();
    }
  });
}
