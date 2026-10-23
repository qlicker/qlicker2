import { test, expect } from '@playwright/test';
import {
  expectNoCriticalAccessibilityViolations,
  findUserByEmailViaApi,
  logoutViaUi,
  patchSettingsViaApi,
  seedUsers,
} from '../e2e/helpers.js';
import {
  buildQlickerSsoSettingsPayload,
  getSsoConfig,
} from '../../ssoserver/scripts/lib/qlicker-sso-settings.mjs';

const ssoConfig = getSsoConfig();

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function enableSso(request, adminToken) {
  const payload = buildQlickerSsoSettingsPayload(ssoConfig);
  return patchSettingsViaApi(request, adminToken, payload);
}

async function loginViaSsoUi(page, username, password, expectedPathPattern) {
  await page.goto('/login');
  await page.getByRole('button', { name: /login through/i }).click();
  await expect(page).toHaveURL(new RegExp(`^${escapeRegex(ssoConfig.ssoserverBaseUrl)}`));
  await expect(page.locator('input[name="username"]')).toBeVisible();
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await expect(page).toHaveURL(expectedPathPattern);
}

test('SSO professor login creates an SSO-managed professor account and logout clears the IdP session', async ({ page, request }) => {
  const { admin } = await seedUsers(request, { professor: false, student: false });
  await enableSso(request, admin.token);

  const professor = ssoConfig.users.find((user) => user.role === 'professor');
  await loginViaSsoUi(page, professor.username, professor.password, /\/prof$/);

  const ssoUser = await findUserByEmailViaApi(request, admin.token, professor.email);
  expect(ssoUser).toBeTruthy();
  expect(ssoUser.profile.roles).toContain('professor');
  expect(ssoUser.isSSOCreatedUser).toBe(true);
  expect(ssoUser.allowEmailLogin).toBe(false);
  expect(ssoUser.lastAuthProvider).toBe('sso');
  await expectNoCriticalAccessibilityViolations(page);

  await logoutViaUi(page, /\/login$/);

  await page.getByRole('button', { name: /login through/i }).click();
  await expect(page).toHaveURL(new RegExp(`^${escapeRegex(ssoConfig.ssoserverBaseUrl)}`));
  await expect(page.locator('input[name="username"]')).toBeVisible();
  await page.locator('input[name="username"]').fill(professor.username);
  await page.locator('input[name="password"]').fill(professor.password);
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  await expect(page).toHaveURL(/\/prof$/);
});

test('SSO student login creates an SSO-managed student account', async ({ page, request }) => {
  const { admin } = await seedUsers(request, { professor: false, student: false });
  await enableSso(request, admin.token);

  const student = ssoConfig.users.find((user) => user.role === 'student');
  await loginViaSsoUi(page, student.username, student.password, /\/student$/);

  const ssoUser = await findUserByEmailViaApi(request, admin.token, student.email);
  expect(ssoUser).toBeTruthy();
  expect(ssoUser.profile.roles).toContain('student');
  expect(ssoUser.profile.roles).not.toContain('professor');
  expect(ssoUser.isSSOCreatedUser).toBe(true);
  expect(ssoUser.allowEmailLogin).toBe(false);
  expect(ssoUser.lastAuthProvider).toBe('sso');
  await expectNoCriticalAccessibilityViolations(page);

  await logoutViaUi(page, /\/login$/);
});
