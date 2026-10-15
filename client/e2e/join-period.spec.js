import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, addQuestionToSessionViaApi, apiJson,
  createCourseViaApi, createQuestionViaApi, createSessionViaApi, enrollStudentViaApi,
  loginViaUi, seedUsers,
} from './helpers.js';

for (const anonymous of [false, true]) {
  for (const shared of [false, true]) {
    test(`closing a mid-session join period restores questions (anonymous=${anonymous}, shared=${shared})`, async ({ page, browser, request }) => {
      const { admin, professor, student } = await seedUsers(request);
      const course = await createCourseViaApi(request, admin.token);
      await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
      if (shared) {
        await apiJson(request, 'PATCH', `/courses/${course._id}`, {
          token: admin.token, payload: { allowSharedActivities: true },
        });
      } else {
        await enrollStudentViaApi(request, student.token, course.enrollmentCode);
      }
      const session = await createSessionViaApi(request, professor.token, course._id, { anonymous });
      const questions = [];
      for (const content of ['Visible question before admission', 'Next visible question']) {
        const q = await createQuestionViaApi(request, professor.token, {
          sessionId: session._id, courseId: course._id, type: 2, content, options: [],
        });
        await addQuestionToSessionViaApi(request, professor.token, session._id, q._id);
        questions.push(q);
      }
      const call = async (method, suffix, payload) => {
        const res = await apiJson(request, method, `/sessions/${session._id}${suffix}`, { token: professor.token, payload });
        expect(res.response.status(), JSON.stringify(res.body)).toBe(200);
        return res.body;
      };
      await call('POST', '/start');
      await call('PATCH', '/question-visibility', { hidden: false });
      await call('PATCH', '', { joinCodeEnabled: true });
      if (shared) {
        const { code } = await call('POST', '/activity-share', {});
        const redeemed = await apiJson(request, 'POST', '/activity-codes/redeem', { token: student.token, payload: { code } });
        expect(redeemed.response.status()).toBe(200);
      }
      await loginViaUi(page, professor.email, professor.password, /\/prof$/);
      await page.goto(`/prof/course/${course._id}/session/${session._id}/live`);
      const studentContext = await browser.newContext();
      try {
        const studentPage = await studentContext.newPage();
        await loginViaUi(studentPage, student.email, student.password, /\/student$/);
        await studentPage.goto(`${shared ? '/activity' : '/student/course'}/${course._id}/session/${session._id}/live`);
        await expect(studentPage.getByText('Visible question before admission')).toHaveCount(0);
        const joinPeriod = page.getByRole('switch', { name: 'Join Period', exact: true });
        await joinPeriod.click();
        await expect(joinPeriod).toBeChecked();
        const live = await call('GET', '/live');
        await studentPage.getByRole('textbox', { name: 'Join code' }).fill(live.session.currentJoinCode);
        await studentPage.getByRole('button', { name: 'Join session', exact: true }).click();
        await expect(studentPage.getByText(/waiting for question/i)).toBeVisible();
        await joinPeriod.click();
        await expect(joinPeriod).not.toBeChecked();
        await expect(studentPage.getByText('Visible question before admission')).toBeVisible();
        await call('PATCH', '/question-visibility', { hidden: true });
        await expect(studentPage.getByText('Visible question before admission')).toHaveCount(0);
        await call('PATCH', '/question-visibility', { hidden: false });
        await expect(studentPage.getByText('Visible question before admission')).toBeVisible();
        await call('PATCH', '/current', { questionId: questions[1]._id });
        await call('PATCH', '/question-visibility', { hidden: false });
        await expect(studentPage.getByText('Next visible question')).toBeVisible();
      } finally {
        await studentContext.close();
      }
    });
  }
}
