import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi, apiJson, createCourseViaApi, enrollStudentViaApi,
  loginViaUi, seedUsers,
} from './helpers.js';

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`admin and course instructors can compose and route notifications at ${viewport.width}px`, async ({ browser, request }) => {
    const { admin, professor, student } = await seedUsers(request);
    const course = await createCourseViaApi(request, admin.token, { name: 'Introduction to Computing' });
    await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
    await enrollStudentViaApi(request, student.token, course.enrollmentCode);
    for (const scope of ['system', 'course']) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const user = scope === 'system' ? admin : professor;
      await loginViaUi(page, user.email, user.password, scope === 'system' ? /\/admin$/ : /\/prof$/);
      if (scope === 'system') {
        if (viewport.width < 600) {
          await page.getByRole('combobox', { name: 'View', exact: true }).click();
          await page.getByRole('option', { name: 'Users', exact: true }).click();
        } else {
          await page.getByRole('tab', { name: 'Users', exact: true }).click();
        }
      } else {
        await page.goto(`/prof/course/${course._id}?tab=3`);
      }
      await page.getByRole('button', { name: 'Manage notifications', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByLabel('Title', { exact: false })).toBeInViewport();
      await expect(dialog.getByLabel('Message', { exact: false })).toBeInViewport();
      const title = `${scope === 'system' ? 'Scheduled maintenance' : 'Quiz deadline reminder'}${viewport.width < 600 ? ' (mobile)' : ''}`;
      const message = scope === 'system'
        ? 'Qlicker will be unavailable on Saturday from 08:00 to 09:00 for scheduled maintenance.'
        : 'Please submit the chapter 3 quiz by Friday at 17:00. Bring your questions to the next class.';
      await dialog.getByLabel('Title', { exact: false }).fill(title);
      await dialog.getByLabel('Message', { exact: false }).fill(message);
      if (process.env.QCLICKER_CAPTURE_MANUALS === '1' && viewport.width === 1280) {
        const filename = `${scope === 'system' ? 'admin' : 'professor'}-notifications.png`;
        const imagePath = path.resolve('../docs/assets/manuals', filename);
        await dialog.screenshot({ path: imagePath, animations: 'disabled' });
        await fs.copyFile(imagePath, path.resolve('public/manuals', filename));
      }
      await dialog.getByRole('button', { name: 'Post notification', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(dialog.getByText(title, { exact: true })).toBeVisible();
      for (const recipient of [professor, student]) {
        const received = await apiJson(request, 'GET', '/notifications', { token: recipient.token });
        expect(received.response.status()).toBe(200);
        expect(received.body.notifications).toEqual(expect.arrayContaining([
          expect.objectContaining({ title, message }),
        ]));
      }
      await context.close();
    }
  });
}
