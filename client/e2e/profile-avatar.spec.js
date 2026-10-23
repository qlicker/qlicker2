import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import {
  apiJson,
  loginViaUi,
  readE2eState,
  seedUsers,
} from './helpers.js';

const fixtureImagePath = fileURLToPath(new URL('../public/manuals/admin-dashboard.png', import.meta.url));

test('profile avatar editor saves a rotated existing profile image', async ({ page, request }) => {
  const { student } = await seedUsers(request, { admin: false, professor: false });

  await loginViaUi(page, student.email, student.password, /\/student$/);

  await page.getByLabel(/open account menu/i).click();
  await page.getByRole('menuitem', { name: /^profile$/i }).click();
  await expect(page).toHaveURL(/\/profile$/);

  await page.locator('input[type="file"]').setInputFiles(fixtureImagePath);
  await expect(page.getByRole('dialog', { name: /adjust profile photo/i })).toBeVisible();

  const initialImageUploadResponse = page.waitForResponse((response) => (
    response.url().includes('/api/v1/images') && response.request().method() === 'POST'
  ));
  const initialProfilePatchResponse = page.waitForResponse((response) => (
    response.url().includes('/api/v1/users/me/image') && response.request().method() === 'PATCH'
  ));
  await page.getByRole('button', { name: /^save$/i }).click();

  expect((await initialImageUploadResponse).status()).toBe(201);
  expect((await initialProfilePatchResponse).status()).toBe(200);
  await expect(page.getByRole('dialog', { name: /adjust profile photo/i })).toBeHidden();
  const profilePhotoEditorButton = page.getByRole('button', { name: /open profile photo editor/i });
  await expect(profilePhotoEditorButton).toBeVisible();
  const { response: currentUserResponse, body: currentUserBody } = await apiJson(request, 'GET', '/users/me', {
    token: student.token,
  });
  expect(currentUserResponse.status(), JSON.stringify(currentUserBody)).toBe(200);
  const { serverBaseUrl } = await readE2eState();
  const absoluteProfileImageUrl = `${serverBaseUrl}${currentUserBody.user.profile.profileImage}`;
  const absoluteProfileThumbnailUrl = `${serverBaseUrl}${currentUserBody.user.profile.profileThumbnail}`;
  const { response: absolutePatchResponse, body: absolutePatchBody } = await apiJson(request, 'PATCH', '/users/me/image', {
    token: student.token,
    payload: {
      profileImage: absoluteProfileImageUrl,
      profileThumbnail: absoluteProfileThumbnailUrl,
    },
  });
  expect(absolutePatchResponse.status(), JSON.stringify(absolutePatchBody)).toBe(200);

  await page.reload();
  await expect(page).toHaveURL(/\/profile$/);

  const { response: beforeRotateUserResponse, body: beforeRotateUserBody } = await apiJson(request, 'GET', '/users/me', {
    token: student.token,
  });
  expect(beforeRotateUserResponse.status(), JSON.stringify(beforeRotateUserBody)).toBe(200);
  const profileThumbnailBeforeRotate = beforeRotateUserBody.user.profile.profileThumbnail;
  expect(profileThumbnailBeforeRotate).toMatch(/\/uploads\//);

  await profilePhotoEditorButton.click();
  await expect(page.getByRole('dialog', { name: /adjust profile photo/i })).toBeVisible();
  const rotateButton = page.getByRole('button', { name: /rotate image right/i });
  await rotateButton.click();

  const rotatedThumbnailUploadResponse = page.waitForResponse((response) => (
    response.url().includes('/api/v1/images') && response.request().method() === 'POST'
  ));
  const rotatedProfilePatchResponse = page.waitForResponse((response) => (
    response.url().includes('/api/v1/users/me/image') && response.request().method() === 'PATCH'
  ));
  await page.getByRole('button', { name: /^save$/i }).click();

  expect((await rotatedThumbnailUploadResponse).status()).toBe(201);
  expect((await rotatedProfilePatchResponse).status()).toBe(200);
  await expect(page.getByRole('dialog', { name: /adjust profile photo/i })).toBeHidden();

  const { response: afterRotateUserResponse, body: afterRotateUserBody } = await apiJson(request, 'GET', '/users/me', {
    token: student.token,
  });
  expect(afterRotateUserResponse.status(), JSON.stringify(afterRotateUserBody)).toBe(200);
  expect(afterRotateUserBody.user.profile.profileThumbnail).toMatch(/\/uploads\//);
  expect(afterRotateUserBody.user.profile.profileThumbnail).not.toBe(profileThumbnailBeforeRotate);
});
