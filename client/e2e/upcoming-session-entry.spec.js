import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, enrollStudentViaApi,
  loginViaUi, seedUsers,
} from './helpers.js';

for (const [anonymous, enrolled, requireCode] of [
  [false, true, true], [true, true, true], [false, false, true], [true, false, true],
  [false, true, false], [true, false, false],
]) {
  test(`Upcoming entry: anonymous=${anonymous}, enrolled=${enrolled}, passcode=${requireCode}`, async ({ page, request }) => {
    const { admin, professor, student } = await seedUsers(request);
    const course = await createCourseViaApi(request, admin.token);
    await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
    await apiJson(request, 'PATCH', `/courses/${course._id}`, { token: admin.token, payload: { allowSharedActivities: true } });
    if (enrolled) await enrollStudentViaApi(request, student.token, course.enrollmentCode);
    const session = await createSessionViaApi(request, admin.token, course._id, { name: 'Waiting page session', anonymous });
    const question = await createQuestionViaApi(request, admin.token, {
      sessionId: session._id, courseId: course._id, content: 'Question after admission',
    });
    await addQuestionToSessionViaApi(request, admin.token, session._id, question._id);
    const call = async (method, suffix, payload, token = professor.token, status = 200) => {
      const result = await apiJson(request, method, `/sessions/${session._id}${suffix}`, { token, payload });
      expect(result.response.status(), JSON.stringify(result.body)).toBe(status);
      return result.body;
    };
    await call('PATCH', '', { status: 'visible' });
    const shared = enrolled ? null : await call('POST', '/activity-share', {});
    await loginViaUi(page, student.email, student.password, /\/student$/);
    const joinRequests = [];
    page.on('request', (req) => {
      if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith(`/sessions/${session._id}/join`)) joinRequests.push(req);
    });
    if (enrolled) {
      await page.goto(`/student/course/${course._id}`);
      await expect(page.getByText('Open waiting page')).toBeVisible();
      await page.getByRole('button', { name: /Waiting page session/ }).click();
    } else {
      await page.getByRole('button', { name: 'Join activity', exact: true }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('textbox', { name: 'Activity code' }).fill(shared.code);
      await dialog.getByRole('button', { name: 'Join activity', exact: true }).click();
    }
    const waiting = page.getByText('This session has not started yet. Please wait for your instructor.');
    await expect(waiting).toBeVisible();
    await page.reload();
    await expect(waiting).toBeVisible();
    expect(joinRequests).toHaveLength(0);
    expect((await call('GET', '')).session.joinedCount || 0).toBe(0);
    expect((await call('GET', '/live', undefined, student.token)).isJoined).toBe(false);
    // Configure admission after people already have the waiting page open.
    await call('PATCH', '', { name: 'Edited before launch', joinCodeEnabled: requireCode });
    await expect(waiting).toBeVisible();
    expect(joinRequests).toHaveLength(0);
    await call('POST', '/start');
    if (requireCode) {
      await expect(page.getByText('Waiting for the instructor to open passcode entry…')).toBeVisible();
      expect(joinRequests).toHaveLength(0);
      const opened = await call('PATCH', '/join-code-settings', { joinCodeActive: true });
      const code = opened.session.currentJoinCode;
      await page.getByRole('textbox', { name: 'Join code', exact: true }).fill(code === '111111' ? '222222' : '111111');
      const rejected = page.waitForResponse((res) => res.url().endsWith(`/sessions/${session._id}/join`));
      await page.getByRole('button', { name: 'Join session', exact: true }).click();
      expect((await rejected).status()).toBe(403);
      expect((await call('GET', '/live', undefined, student.token)).isJoined).toBe(false);
      await page.getByRole('textbox', { name: 'Join code', exact: true }).fill(code);
      await page.getByRole('button', { name: 'Join session', exact: true }).click();
      await expect(page.getByText('Waiting for question…')).toBeVisible();
      await call('PATCH', '/join-code-settings', { joinCodeActive: false });
    }
    await expect(page.getByText('Waiting for question…')).toBeVisible();
    expect((await call('GET', '/live', undefined, student.token)).isJoined).toBe(true);
    await call('PATCH', '/question-visibility', { hidden: false });
    await expect(page.getByText('Question after admission')).toBeVisible();
  });
}
