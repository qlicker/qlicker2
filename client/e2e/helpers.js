import fs from 'fs/promises';
import path from 'node:path';
import os from 'node:os';
import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';

const STATE_FILE = process.env.QCLICKER_E2E_STATE_FILE || path.join(os.tmpdir(), 'qlicker-e2e-state.json');
const ADMIN_STATE_FILE = process.env.QCLICKER_E2E_ADMIN_STATE_FILE || path.join(os.tmpdir(), 'qlicker-e2e-admin.json');
const AUTH_STATE_DIR = process.env.QCLICKER_E2E_AUTH_STATE_DIR || path.join(os.tmpdir(), 'qlicker-e2e-auth');
const CSRF_HEADERS = { 'X-Requested-With': 'XMLHttpRequest' };

let cachedState = null;
let cachedAdmin = null;
let cachedProfessor = null;
let cachedStudent = null;

export const PASSWORD = 'Password123!';

function buildHeaders(token) {
  return token
    ? { ...CSRF_HEADERS, Authorization: `Bearer ${token}` }
    : { ...CSRF_HEADERS };
}

function authStateFileForEmail(email) {
  const slug = String(email || 'user')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return path.join(AUTH_STATE_DIR, `${slug || 'user'}.json`);
}

export async function clearCachedAuthState(email) {
  await fs.rm(authStateFileForEmail(email), { force: true }).catch(() => {});
}

function routeFromExpectedPath(expectedPathPattern) {
  const source = typeof expectedPathPattern?.source === 'string' ? expectedPathPattern.source : String(expectedPathPattern || '');
  if (source.includes('/admin')) return '/admin';
  if (source.includes('/student')) return '/student';
  return '/prof';
}

export async function readE2eState() {
  if (cachedState) return cachedState;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const raw = await fs.readFile(STATE_FILE, 'utf8');
      cachedState = JSON.parse(raw);
      return cachedState;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Timed out waiting for E2E state file: ${STATE_FILE}`);
}

export async function apiJson(request, method, path, { token, payload } = {}) {
  const { serverBaseUrl } = await readE2eState();
  const response = await request.fetch(`${serverBaseUrl}/api/v1${path}`, {
    method,
    headers: buildHeaders(token),
    data: payload,
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

export function uniqueSuffix(prefix = 'e2e') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildUser(prefix, roleLabel = prefix) {
  const suffix = uniqueSuffix(prefix);
  return {
    firstname: 'E2E',
    lastname: roleLabel,
    email: `${suffix}@example.com`,
    password: PASSWORD,
  };
}

export async function seedUsers(request, options = {}) {
  if (!cachedAdmin) {
    try {
      const rawAdmin = await fs.readFile(ADMIN_STATE_FILE, 'utf8');
      const persistedAdmin = JSON.parse(rawAdmin);
      const loginBody = await loginViaApi(request, persistedAdmin.email, persistedAdmin.password);
      cachedAdmin = {
        ...persistedAdmin,
        token: loginBody.token,
        user: loginBody.user,
      };
    } catch {
      // Fall back to provisioning a new admin for a fresh in-memory database.
    }
  }

  if (!cachedAdmin) {
    const adminUser = buildUser('admin', 'Admin');
    const { response: registerResponse, body: registerBody } = await apiJson(request, 'POST', '/auth/register', {
      payload: adminUser,
    });
    expect(registerResponse.status(), JSON.stringify(registerBody)).toBe(201);
    cachedAdmin = {
      ...adminUser,
      token: registerBody.token,
      user: registerBody.user,
    };
    await fs.writeFile(ADMIN_STATE_FILE, `${JSON.stringify(adminUser, null, 2)}\n`, 'utf8');
  }

  const admin = cachedAdmin;

  const result = { admin };

  if (options.professor !== false) {
    if (!cachedProfessor) {
      const professorUser = buildUser('professor', 'Professor');
      const { response, body } = await apiJson(request, 'POST', '/auth/register', {
        payload: professorUser,
      });
      expect(response.status(), JSON.stringify(body)).toBe(201);
      const promoteProfessor = await apiJson(request, 'PATCH', `/users/${body.user._id}/role`, {
        token: admin.token,
        payload: { role: 'professor' },
      });
      expect(promoteProfessor.response.status(), JSON.stringify(promoteProfessor.body)).toBe(200);
      cachedProfessor = {
        ...professorUser,
        token: body.token,
        user: promoteProfessor.body,
      };
    }

    result.professor = {
      ...cachedProfessor,
    };
  }

  if (options.student !== false) {
    if (!cachedStudent) {
      const studentUser = buildUser('student', 'Student');
      const { response, body } = await apiJson(request, 'POST', '/auth/register', {
        payload: studentUser,
      });
      expect(response.status(), JSON.stringify(body)).toBe(201);
      cachedStudent = {
        ...studentUser,
        token: body.token,
        user: body.user,
      };
    }

    result.student = {
      ...cachedStudent,
    };
  }

  return result;
}

async function saveAuthState(page, authStateFile) {
  await fs.mkdir(AUTH_STATE_DIR, { recursive: true });
  const state = await page.context().storageState();
  await fs.writeFile(authStateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export async function loginViaUi(page, email, password, expectedPathPattern) {
  const authStateFile = authStateFileForEmail(email);
  try {
    const rawState = await fs.readFile(authStateFile, 'utf8');
    const state = JSON.parse(rawState);
    if (!Array.isArray(state.cookies) || state.cookies.length === 0) {
      throw new Error('No cached auth cookies');
    }
    await page.context().addCookies(state.cookies);
    const route = routeFromExpectedPath(expectedPathPattern);
    await page.goto(route);
    // The protected route renders at the requested URL while the app is still
    // exchanging the refresh cookie, so the URL alone does not prove the
    // cached session is valid. Refresh tokens rotate on every use, so a saved
    // cookie goes stale as soon as the browser that saved it refreshes again.
    // Wait until the app settles on either the signed-in shell or the login form.
    const accountMenu = page.getByLabel(/open account menu/i);
    const loginButton = page.getByRole('button', { name: /^Login$/ });
    await expect(accountMenu.or(loginButton)).toBeVisible();
    if (!(await accountMenu.isVisible())) {
      throw new Error('Cached auth state is stale');
    }
    await expect(page).toHaveURL(expectedPathPattern);
    // The refresh above rotated the session; keep the saved cookie current.
    await saveAuthState(page, authStateFile);
    return;
  } catch {
    // Fall back to a real UI login when there is no cached browser state yet or
    // when the cached state is stale (rotated refresh token or restarted server).
    await page.context().clearCookies();
  }

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /^Login$/ }).click();
  await expect(page).toHaveURL(expectedPathPattern);
  await saveAuthState(page, authStateFile);
}

export async function logoutViaUi(page, expectedPathPattern = /\/login$/) {
  await page.getByLabel(/open account menu/i).click();
  await page.getByRole('menuitem', { name: /^logout$/i }).click();
  await expect(page).toHaveURL(expectedPathPattern);
}

export async function expectNoCriticalAccessibilityViolations(page) {
  const results = await new AxeBuilder({ page }).analyze();
  // Fail the regression checks on critical issues first; serious violations can
  // be triaged separately without making the existing suite too brittle.
  const criticalViolations = results.violations.filter((violation) => violation.impact === 'critical');

  expect(
    criticalViolations,
    criticalViolations.length
      ? `Critical accessibility violations:\n${JSON.stringify(criticalViolations, null, 2)}`
      : undefined
  ).toEqual([]);
}

export async function loginViaApi(request, email, password) {
  const { response, body } = await apiJson(request, 'POST', '/auth/login', {
    payload: { email, password },
  });
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body;
}

export async function patchSettingsViaApi(request, token, payload) {
  const { response, body } = await apiJson(request, 'PATCH', '/settings', {
    token,
    payload,
  });
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body;
}

export async function findUserByEmailViaApi(request, token, email) {
  const { response, body } = await apiJson(
    request,
    'GET',
    `/users?search=${encodeURIComponent(email)}`,
    { token }
  );
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return (body.users || []).find((user) => user?.emails?.some((entry) => entry.address === email));
}

export async function createCourseViaApi(request, token, overrides = {}) {
  const payload = {
    name: overrides.name || `Course ${uniqueSuffix('course')}`,
    deptCode: overrides.deptCode || 'CS',
    courseNumber: overrides.courseNumber || '101',
    section: overrides.section || '001',
    semester: overrides.semester || 'Fall 2026',
  };
  const { response, body } = await apiJson(request, 'POST', '/courses', {
    token,
    payload,
  });
  expect(response.status(), JSON.stringify(body)).toBe(201);
  return body.course;
}

export async function addInstructorToCourseViaApi(request, token, courseId, userId) {
  const { response, body } = await apiJson(request, 'POST', `/courses/${courseId}/instructors`, {
    token,
    payload: { userId },
  });
  expect(response.status(), JSON.stringify(body)).toBe(200);
}

export async function createSessionViaApi(request, token, courseId, overrides = {}) {
  const payload = {
    name: overrides.name || `Session ${uniqueSuffix('session')}`,
    ...overrides,
  };
  const { response, body } = await apiJson(request, 'POST', `/courses/${courseId}/sessions`, {
    token,
    payload,
  });
  expect(response.status(), JSON.stringify(body)).toBe(201);
  return body.session;
}

export async function patchSessionViaApi(request, token, sessionId, payload) {
  const { response, body } = await apiJson(request, 'PATCH', `/sessions/${sessionId}`, {
    token,
    payload,
  });
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body.session || body;
}

export async function createQuestionViaApi(request, token, payload = {}) {
  const { response, body } = await apiJson(request, 'POST', '/questions', {
    token,
    payload: {
      type: 0,
      content: payload.content || 'What is 2 + 2?',
      options: payload.options || [
        { answer: '3', correct: false },
        { answer: '4', correct: true },
      ],
      ...payload,
    },
  });
  expect(response.status(), JSON.stringify(body)).toBe(201);
  return body.question;
}

export async function addQuestionToSessionViaApi(request, token, sessionId, questionId) {
  const { response, body } = await apiJson(request, 'POST', `/sessions/${sessionId}/questions`, {
    token,
    payload: { questionId },
  });
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body.session || body;
}

export async function enrollStudentViaApi(request, token, enrollmentCode) {
  const { response, body } = await apiJson(request, 'POST', '/courses/enroll', {
    token,
    payload: { enrollmentCode },
  });
  expect(response.status(), JSON.stringify(body)).toBe(200);
}
