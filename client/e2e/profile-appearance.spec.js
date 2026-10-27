import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  apiJson, clearCachedAuthState, expectNoCriticalAccessibilityViolations,
  loginViaUi, logoutViaUi, seedUsers,
} from './helpers.js';

test('appearance persists across reloads and fresh sign-ins without leaking to another account', async ({ page, browser, request }) => {
  const { student, professor } = await seedUsers(request, { admin: false });
  await loginViaUi(page, student.email, student.password, /\/student$/);
  await page.goto('/profile');
  const appearance = page.getByRole('combobox', { name: 'Appearance' });
  await expect(appearance).toHaveText('Light');
  await appearance.click();
  await page.getByRole('option', { name: 'Dark', exact: true }).click();
  await expect(appearance).toHaveText('Dark');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  const saved = await apiJson(request, 'GET', '/users/me', { token: student.token });
  expect(saved.body.user.themeMode).toBe('dark');

  await page.reload();
  await expect(appearance).toHaveText('Dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(16, 24, 32)');
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoCriticalAccessibilityViolations(page);
  const contrast = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  expect(contrast.violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // A failed save must leave the saved appearance active and report the error.
  await page.route('**/api/v1/users/me', async (route) => {
    if (route.request().method() === 'PATCH') return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    return route.continue();
  });
  await appearance.click();
  await page.getByRole('option', { name: 'Light', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/could not be saved/i);
  await expect(appearance).toHaveText('Dark');
  await page.unroute('**/api/v1/users/me');

  await logoutViaUi(page);
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');

  await clearCachedAuthState(student.email);
  const freshContext = await browser.newContext();
  try {
    const freshPage = await freshContext.newPage();
    await loginViaUi(freshPage, student.email, student.password, /\/student$/);
    await expect(freshPage.locator('html')).toHaveCSS('color-scheme', 'dark');
    await freshPage.goto('/profile');
    await freshPage.getByRole('combobox', { name: 'Appearance' }).click();
    await freshPage.getByRole('option', { name: 'Light', exact: true }).click();
    await expect(freshPage.locator('html')).toHaveCSS('color-scheme', 'light');
    await freshPage.reload();
    await expect(freshPage.getByRole('combobox', { name: 'Appearance' })).toHaveText('Light');
  } finally {
    await freshContext.close();
  }
});
