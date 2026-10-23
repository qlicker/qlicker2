import { test, expect } from '@playwright/test';
import { createCourseViaApi, loginViaUi, seedUsers } from './helpers.js';

test('course page opens exactly one websocket without churn', async ({ page, request }) => {
  const { professor } = await seedUsers(request, { admin: false, student: false });
  // Chat shifts the tab indices once the course loads, which used to be an
  // (unstable) dependency of the websocket effect.
  const course = await createCourseViaApi(request, professor.token, { courseChatEnabled: true });

  // Ensure course data lands only after the socket has started connecting,
  // like on production latencies — this is what used to trigger the churn.
  await page.route('**/api/v1/courses/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });

  const attempts = [];
  const closes = [];
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/ws?token=')) return; // ignore the vite HMR socket
    attempts.push(ws.url());
    ws.on('close', () => closes.push(ws.url()));
    ws.on('socketerror', (err) => closes.push(`error:${err}`));
  });

  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.goto(`/prof/course/${course._id}`);
  await expect(page).toHaveURL(new RegExp(`/prof/course/${course._id}`));
  // Let course data load and effect deps settle; churn would show extra attempts.
  await page.waitForTimeout(6000);

  expect(attempts.length, `ws attempts: ${JSON.stringify(attempts.map((u) => u.slice(0, 40)))}`).toBe(1);
  expect(closes, 'first socket must stay open (no churn, no errors)').toEqual([]);
});
