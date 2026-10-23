import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, enrollStudentViaApi,
  loginViaUi, seedUsers,
} from './helpers.js';

for (const shared of [false, true]) {
  test(`live status changes hide questions and preserve responses for ${shared ? 'an anonymous guest' : 'an enrolled student'}`, async ({ page, request }) => {
    const { admin, professor, student } = await seedUsers(request);
    const course = await createCourseViaApi(request, admin.token);
    await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
    if (shared) {
      await apiJson(request, 'PATCH', `/courses/${course._id}`, { token: admin.token, payload: { allowSharedActivities: true } });
    } else {
      await enrollStudentViaApi(request, student.token, course.enrollmentCode);
    }
    const session = await createSessionViaApi(request, admin.token, course._id, { anonymous: shared, name: 'Status transition session' });
    const question = await createQuestionViaApi(request, admin.token, {
      sessionId: session._id, courseId: course._id, type: 2, content: 'Status transition question', options: [],
    });
    await addQuestionToSessionViaApi(request, admin.token, session._id, question._id);
    const call = async (method, suffix, payload, token = professor.token, status = 200) => {
      const result = await apiJson(request, method, `/sessions/${session._id}${suffix}`, { token, payload });
      expect(result.response.status(), JSON.stringify(result.body)).toBe(status);
      return result.body;
    };
    await call('POST', '/start');
    await call('PATCH', '/question-visibility', { hidden: false });
    if (shared) {
      const { code } = await call('POST', '/activity-share', {});
      const redeemed = await apiJson(request, 'POST', '/activity-codes/redeem', { token: student.token, payload: { code } });
      expect(redeemed.response.status()).toBe(200);
    }
    await call('POST', '/join', {}, student.token);
    await call('POST', '/respond', { answer: 'My saved answer' }, student.token, 201);
    await loginViaUi(page, student.email, student.password, /\/student$/);
    const route = shared ? `/activity/${course._id}/session/${session._id}/live`
      : `/student/course/${course._id}/session/${session._id}/live`;
    await page.goto(route);
    await expect(page.getByText('Status transition question')).toBeVisible();
    for (const [status, message] of [
      ['visible', 'This session has not started yet. Please wait for your instructor.'],
      ['done', 'Session has ended.'],
    ]) {
      await call('PATCH', '', { status });
      await expect(page.getByText(message)).toBeVisible();
      await expect(page.getByText('Status transition question')).toHaveCount(0);
      await expect(page.getByText('My saved answer', { exact: true })).toHaveCount(0);
      // A refresh must retain the waiting/ended state; the socket then restores Live.
      await page.reload();
      await expect(page.getByText(message)).toBeVisible();
      await call('PATCH', '', { status: 'running' });
      await expect(page.getByText('Status transition question')).toBeVisible();
      await expect(page.getByText('My saved answer', { exact: true })).toBeVisible();
    }
    await call('PATCH', '', { status: 'hidden' });
    await expect(page).toHaveURL(shared ? /\/student$/ : new RegExp(`/student/course/${course._id}$`));
    await expect(page.getByText('Status transition question')).toHaveCount(0);
    await page.goto(route);
    await expect(page).toHaveURL(shared ? /\/student$/ : new RegExp(`/student/course/${course._id}$`));
  });
}
