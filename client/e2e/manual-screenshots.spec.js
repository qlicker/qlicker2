import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  addInstructorToCourseViaApi,
  addQuestionToSessionViaApi,
  apiJson,
  buildUser,
  createCourseViaApi,
  createQuestionViaApi,
  createSessionViaApi,
  enrollStudentViaApi,
  expectNoCriticalAccessibilityViolations,
  loginViaUi,
  patchSessionViaApi,
  patchSettingsViaApi,
  readE2eState,
  seedUsers,
} from './helpers.js';

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');
const docsOutputDir = path.join(repoRoot, 'docs/assets/manuals');
const publicOutputDir = path.join(repoRoot, 'client/public/manuals');
const require = createRequire(path.join(repoRoot, 'server/package.json'));
const { MongoClient } = require('mongodb');

async function capture(page, filename, height = 1000) {
  const selectedImages = process.env.QCLICKER_MANUAL_IMAGES?.split(',');
  if (selectedImages && !selectedImages.includes(filename)) return;
  await page.setViewportSize({ width: 1440, height });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);
  const docsPath = path.join(docsOutputDir, filename);
  await page.screenshot({ path: docsPath, fullPage: false });
  await fs.copyFile(docsPath, path.join(publicOutputDir, filename));
}

test('capture current user-manual screenshots', async ({ browser, request }) => {
  test.skip(process.env.QCLICKER_CAPTURE_MANUALS !== '1', 'Run with QCLICKER_CAPTURE_MANUALS=1.');
  test.setTimeout(360_000);

  await fs.mkdir(docsOutputDir, { recursive: true });
  await fs.mkdir(publicOutputDir, { recursive: true });

  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token, {
    name: 'Introduction to Biology',
    deptCode: 'BIOL',
    courseNumber: '101',
    section: '01',
    semester: 'Fall 2026',
  });
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  await enrollStudentViaApi(request, student.token, course.enrollmentCode);
  const courseUpdate = await apiJson(request, 'PATCH', `/courses/${course._id}`, {
    token: admin.token,
    payload: {
      allowStudentQuestions: true,
      courseChatEnabled: true,
      courseChatRetentionDays: 30,
      tags: [
        { value: 'Cell biology', label: 'Cell biology' },
        { value: 'Genetics', label: 'Genetics' },
        { value: 'Ecology', label: 'Ecology' },
      ],
    },
  });
  expect(courseUpdate.response.status(), JSON.stringify(courseUpdate.body)).toBe(200);

  await patchSettingsViaApi(request, admin.token, {
    AI_Enabled: true,
    AI_EnabledCourses: [course._id],
    AI_AllowCourseBackendCourses: [course._id],
    AI_Backends: [{
      id: 'campus-ai',
      name: 'Campus AI Service',
      type: 'openai',
      url: 'https://ai.example.edu/v1',
      apiToken: 'synthetic-manual-capture-token',
      models: [
        { id: 'teaching-assistant', name: 'teaching-assistant', displayName: 'Teaching Assistant', available: true },
        { id: 'grading-reviewer', name: 'grading-reviewer', displayName: 'Grading Reviewer', available: true },
      ],
    }],
    AI_DefaultBackendId: 'campus-ai',
    AI_DefaultModelId: 'teaching-assistant',
  });
  const aiCourseUpdate = await apiJson(request, 'PATCH', `/ai/courses/${course._id}/config`, {
    token: professor.token,
    payload: {
      enabled: true,
      defaultBackendId: 'campus-ai',
      defaultModelId: 'teaching-assistant',
      studentChatEnabled: true,
      studentChatGuidance: 'Explain biology concepts with guiding questions. Do not complete graded work for students.',
      studentDefaultBackendId: 'campus-ai',
      studentDefaultModelId: 'teaching-assistant',
      instructorChatMaxToolRounds: 20,
      studentChatMaxToolRounds: 5,
      modelPolicies: [
        { backendId: 'campus-ai', modelId: 'teaching-assistant', studentAvailable: true },
        { backendId: 'campus-ai', modelId: 'grading-reviewer', studentAvailable: false },
      ],
    },
  });
  expect(aiCourseUpdate.response.status(), JSON.stringify(aiCourseUpdate.body)).toBe(200);

  const courseChatPost = await apiJson(request, 'POST', `/courses/${course._id}/chat/posts`, {
    token: student.token,
    payload: {
      title: 'Week 2: cell membrane transport',
      body: 'Could someone explain how facilitated diffusion differs from active transport?',
      bodyWysiwyg: '<p>Could someone explain how <strong>facilitated diffusion</strong> differs from active transport?</p>',
      tags: ['Cell biology'],
    },
  });
  expect(courseChatPost.response.status(), JSON.stringify(courseChatPost.body)).toBe(201);
  const courseChatComment = await apiJson(
    request,
    'POST',
    `/courses/${course._id}/chat/posts/${courseChatPost.body.postId}/comments`,
    {
      token: professor.token,
      payload: { body: 'Start by comparing whether each process requires cellular energy.' },
    },
  );
  expect(courseChatComment.response.status(), JSON.stringify(courseChatComment.body)).toBe(200);

  const interactive = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Cell Structure Check-in',
    description: 'Interactive questions and discussion for Week 2.',
    status: 'visible',
    chatEnabled: true,
    richTextChatEnabled: true,
  });
  const interactiveQuestion = await createQuestionViaApi(request, admin.token, {
    courseId: course._id,
    content: '<p>Which organelle produces most of a cell\'s ATP?</p>',
    plainText: "Which organelle produces most of a cell's ATP?",
    solution: '<p>The <strong>mitochondrion</strong> produces most ATP during cellular respiration.</p>',
    solution_plainText: 'The mitochondrion produces most ATP during cellular respiration.',
    tags: [{ value: 'Cell biology', label: 'Cell biology' }],
    options: [
      { answer: 'Nucleus', correct: false },
      { answer: 'Mitochondrion', correct: true },
      { answer: 'Golgi apparatus', correct: false },
      { answer: 'Lysosome', correct: false },
    ],
  });
  await addQuestionToSessionViaApi(request, admin.token, interactive._id, interactiveQuestion._id);
  const shortAnswer = await createQuestionViaApi(request, admin.token, {
    type: 2,
    courseId: course._id,
    content: '<p>Describe one difference between plant and animal cells.</p>',
    plainText: 'Describe one difference between plant and animal cells.',
    solution: '<p>Plant cells have a cellulose cell wall; animal cells do not.</p>',
    solution_plainText: 'Plant cells have a cellulose cell wall; animal cells do not.',
    tags: [{ value: 'Cell biology', label: 'Cell biology' }],
    sessionOptions: { points: 3 },
  });
  await addQuestionToSessionViaApi(request, admin.token, interactive._id, shortAnswer._id);

  await createQuestionViaApi(request, admin.token, {
    type: 1,
    courseId: course._id,
    content: '<p>DNA is replicated before a cell divides.</p>',
    plainText: 'DNA is replicated before a cell divides.',
    public: true,
    publicOnQlickerForStudents: true,
    tags: [{ value: 'Genetics', label: 'Genetics' }],
    options: [
      { answer: 'True', correct: true },
      { answer: 'False', correct: false },
    ],
  });
  await createQuestionViaApi(request, admin.token, {
    type: 4,
    courseId: course._id,
    content: '<p>How many chromosomes are in a typical human somatic cell?</p>',
    plainText: 'How many chromosomes are in a typical human somatic cell?',
    correctNumerical: 46,
    toleranceNumerical: 0,
    public: true,
    publicOnQlickerForStudents: true,
    tags: [{ value: 'Genetics', label: 'Genetics' }],
  });

  const completedQuiz = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Cell Biology Review Quiz',
    description: 'A completed quiz with released feedback.',
    quiz: true,
    status: 'visible',
    quizStart: new Date(Date.now() - ONE_HOUR_MS).toISOString(),
    quizEnd: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
  });
  await patchSessionViaApi(request, professor.token, completedQuiz._id, {
    quiz: true,
    status: 'visible',
    quizStart: new Date(Date.now() - ONE_HOUR_MS).toISOString(),
    quizEnd: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
  });
  const quizQuestion = await createQuestionViaApi(request, admin.token, {
    courseId: course._id,
    content: '<p>Which structure controls what enters and leaves the cell?</p>',
    plainText: 'Which structure controls what enters and leaves the cell?',
    solution: '<p>The plasma membrane is selectively permeable.</p>',
    solution_plainText: 'The plasma membrane is selectively permeable.',
    options: [
      { answer: 'Cell membrane', correct: true },
      { answer: 'Ribosome', correct: false },
      { answer: 'Nucleolus', correct: false },
      { answer: 'Cytoskeleton', correct: false },
    ],
    sessionOptions: { points: 2 },
  });
  const completedWithQuestion = await addQuestionToSessionViaApi(
    request,
    admin.token,
    completedQuiz._id,
    quizQuestion._id,
  );
  const completedQuestionId = String(completedWithQuestion.questions.at(-1));
  const quizResponse = await apiJson(request, 'PATCH', `/sessions/${completedQuiz._id}/quiz-response`, {
    token: student.token,
    payload: { questionId: completedQuestionId, answer: '0' },
  });
  expect(quizResponse.response.status(), JSON.stringify(quizResponse.body)).toBe(200);
  const quizSubmission = await apiJson(request, 'POST', `/sessions/${completedQuiz._id}/submit`, {
    token: student.token,
  });
  expect(quizSubmission.response.status(), JSON.stringify(quizSubmission.body)).toBe(200);
  await patchSessionViaApi(request, professor.token, completedQuiz._id, {
    status: 'done',
    reviewable: true,
  });
  const gradeRecalculation = await apiJson(
    request,
    'POST',
    `/sessions/${completedQuiz._id}/grades/recalculate`,
    { token: professor.token, payload: { missingOnly: false } },
  );
  expect(gradeRecalculation.response.status(), JSON.stringify(gradeRecalculation.body)).toBe(200);

  const activeQuiz = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Unit 1 Quiz',
    description: 'Complete all questions before submitting.',
    quiz: true,
    status: 'visible',
    quizStart: new Date(Date.now() - ONE_MINUTE_MS).toISOString(),
    quizEnd: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
  });
  await patchSessionViaApi(request, professor.token, activeQuiz._id, {
    quiz: true,
    status: 'visible',
    quizStart: new Date(Date.now() - ONE_MINUTE_MS).toISOString(),
    quizEnd: new Date(Date.now() + ONE_HOUR_MS).toISOString(),
  });
  const activeQuizQuestion = await createQuestionViaApi(request, admin.token, {
    courseId: course._id,
    content: '<p>Which molecule carries genetic information?</p>',
    plainText: 'Which molecule carries genetic information?',
    options: [
      { answer: 'ATP', correct: false },
      { answer: 'DNA', correct: true },
      { answer: 'Glucose', correct: false },
      { answer: 'Lipid', correct: false },
    ],
  });
  await addQuestionToSessionViaApi(request, admin.token, activeQuiz._id, activeQuizQuestion._id);

  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  adminPage.setDefaultTimeout(15_000);
  await loginViaUi(adminPage, admin.email, admin.password, /\/admin$/);
  await expect(adminPage.getByRole('heading', { name: /admin dashboard/i })).toBeVisible();
  await capture(adminPage, 'admin-dashboard.png');
  await adminPage.getByRole('tab', { name: /^Storage$/i }).click();
  await expect(adminPage.getByText(/Storage provider settings are saved in the database/i)).toBeVisible();
  await capture(adminPage, 'admin-storage.png');
  await adminPage.getByRole('tab', { name: /^Users$/i }).click();
  await expect(adminPage.getByPlaceholder(/search by name or email/i)).toBeVisible();
  await capture(adminPage, 'admin-users.png');

  const professorContext = await browser.newContext();
  const professorPage = await professorContext.newPage();
  professorPage.setDefaultTimeout(15_000);
  await loginViaUi(professorPage, professor.email, professor.password, /\/prof$/);
  await expect(professorPage.getByText('BIOL 101: Introduction to Biology')).toBeVisible();
  await capture(professorPage, 'professor-dashboard.png');
  await professorPage.goto(`/prof/course/${course._id}`);
  await expect(professorPage.getByRole('heading', { name: /Introduction to Biology/i })).toBeVisible();
  await capture(professorPage, 'professor-course.png');
  await professorPage.getByRole('tab', { name: /^Course Settings$/i }).click();
  await expect(professorPage.getByText(new RegExp(course.enrollmentCode))).toBeVisible();
  await capture(professorPage, 'professor-course-settings.png');
  await professorPage.getByLabel('Allow activities to be shared by code').click();
  await expect(professorPage.getByLabel('Allow activities to be shared by code')).toBeChecked();
  await professorPage.getByRole('tab', { name: /^Course Chat/i }).click();
  await expect(professorPage.getByText(/facilitated diffusion differs from active transport/i)).toBeVisible();
  await capture(professorPage, 'professor-course-chat.png');
  await professorPage.getByRole('tab', { name: /^Question Library$/i }).click();
  await expect(professorPage.getByText(/DNA is replicated before a cell divides/i)).toBeVisible();
  await capture(professorPage, 'professor-question-library.png');
  await professorPage.getByRole('tab', { name: /^Groups$/i }).click();
  await professorPage.getByRole('button', { name: /^Create Category$/i }).click();
  await professorPage.getByLabel(/^Category Name$/i).fill('Lab Teams');
  await professorPage.getByLabel(/^Number of Groups$/i).fill('3');
  await professorPage.getByRole('button', { name: /^Create$/i }).click();
  await expect(professorPage.getByText(/^Group 1$/i)).toBeVisible();
  await capture(professorPage, 'professor-groups.png');
  await apiJson(request, 'PATCH', `/courses/${course._id}`, {
    token: admin.token, payload: { allowSharedActivities: false },
  });
  await professorPage.goto(`/prof/course/${course._id}/session/${interactive._id}`);
  await expect(professorPage.getByText('Cell Structure Check-in').first()).toBeVisible();
  await expect(professorPage.getByLabel('Enable sharing this activity outside the course')).toHaveCount(0);
  await capture(professorPage, 'session-editor-sharing-disabled.png', 1250);
  await apiJson(request, 'PATCH', `/courses/${course._id}`, {
    token: admin.token, payload: { allowSharedActivities: true },
  });
  await professorPage.reload();
  await professorPage.getByLabel('Enable sharing this activity outside the course').click();
  await expect(professorPage.getByTestId('activity-share-code')).toHaveText(/^S-[A-HJ-NP-Z2-9]{7}$/);
  await capture(professorPage, 'session-editor.png', 1250);

  await professorPage.goto(`/prof/course/${course._id}`);
  await professorPage.getByRole('button', { name: /Launch session Cell Structure Check-in/i }).click();
  await expect(professorPage).toHaveURL(new RegExp(`/session/${interactive._id}/live$`));
  const visibleToggle = professorPage.getByLabel(/^Visible$/i);
  if (!(await visibleToggle.isChecked())) await visibleToggle.click();
  const sessionChatToggle = professorPage.getByLabel(/^Enable session chat$/i);
  if (!(await sessionChatToggle.isChecked())) await sessionChatToggle.click();
  const richTextChatToggle = professorPage.getByLabel(/^Enable rich text chat$/i);
  if (!(await richTextChatToggle.isChecked())) await richTextChatToggle.click();
  await expect(professorPage.getByText(/Which organelle produces most of a cell's ATP/i)).toBeVisible();
  await expect(professorPage.getByTestId('activity-share-code')).toHaveText(/^S-[A-HJ-NP-Z2-9]{7}$/);
  await capture(professorPage, 'professor-live-session.png');
  const studentJoin = await apiJson(request, 'POST', `/sessions/${interactive._id}/join`, {
    token: student.token,
    payload: {},
  });
  expect(studentJoin.response.status(), JSON.stringify(studentJoin.body)).toBe(200);
  const sessionChatPost = await apiJson(request, 'POST', `/sessions/${interactive._id}/chat/posts`, {
    token: student.token,
    payload: {
      body: 'Why does the mitochondrion have a folded inner membrane?',
      bodyWysiwyg: '<p>Why does the mitochondrion have a folded inner membrane?</p>',
    },
  });
  expect(sessionChatPost.response.status(), JSON.stringify(sessionChatPost.body)).toBe(200);
  await professorPage.reload();
  await professorPage.getByRole('tab', { name: /^Chat$/i }).click();
  await expect(professorPage.getByText(/folded inner membrane/i)).toBeVisible();
  await capture(professorPage, 'professor-session-chat.png');

  await professorPage.goto(`/prof/course/${course._id}`);
  await professorPage.getByRole('tab', { name: /^Grades$/i }).click();
  await professorPage.getByRole('button', { name: /^Show Grade Table$/i }).click();
  const gradeDialog = professorPage.getByRole('dialog', { name: /select sessions for grade table/i });
  await expect(gradeDialog.getByText('No grade items').first()).toBeVisible();
  await expect(gradeDialog.getByRole('button', { name: 'Select sessions with grade items' })).toBeEnabled();
  await capture(professorPage, 'professor-grade-session-picker.png');
  await gradeDialog.getByRole('button', { name: 'Select sessions with grade items' }).click();
  await expect(gradeDialog.getByRole('checkbox', { name: 'Toggle selection for Cell Biology Review Quiz' })).toBeChecked();
  await gradeDialog.getByRole('button', { name: /^Show Table$/i }).click();
  await expect(professorPage.getByText(student.email)).toBeVisible();
  await capture(professorPage, 'professor-grades.png');
  await professorPage.goto(`/prof/course/${course._id}/session/${completedQuiz._id}/review`);
  await expect(professorPage.getByRole('switch', { name: 'Grades visible', exact: true })).toBeChecked();
  await expect(professorPage.getByRole('button', { name: 'Session response timeline', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await capture(professorPage, 'professor-session-review.png');
  await professorPage.getByRole('tab', { name: /^Response Data$/i }).click();
  await professorPage.getByRole('button', { name: /^Export results to CSV$/i }).click();
  const exportDialog = professorPage.getByRole('dialog', { name: /^Export results to CSV$/i });
  await expect(exportDialog.getByRole('checkbox', { name: /include response timestamps/i })).not.toBeChecked();
  await exportDialog.getByRole('checkbox', { name: /include response timestamps/i }).check();
  await expectNoCriticalAccessibilityViolations(professorPage);
  await capture(professorPage, 'professor-response-export.png');
  const downloadPromise = professorPage.waitForEvent('download');
  await exportDialog.getByRole('button', { name: /^Export CSV$/i }).click();
  const download = await downloadPromise;
  const csv = await fs.readFile(await download.path(), 'utf8');
  expect(csv).toContain('Q1 Time');
  expect(csv).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/);
  await professorPage.goto(`/prof/course/${course._id}`);
  await professorPage.getByRole('tab', { name: /^AI Settings$/i }).click();
  await expect(professorPage.getByLabel(/^Default model$/i)).toBeVisible();
  await capture(professorPage, 'professor-ai-settings.png');
  await professorPage.getByRole('tab', { name: /^AI Chat$/i }).click();
  await expect(professorPage.getByRole('button', { name: /^New conversation$/i })).toBeVisible();
  await capture(professorPage, 'professor-ai-chat.png');

  const studentContext = await browser.newContext();
  const studentPage = await studentContext.newPage();
  studentPage.setDefaultTimeout(15_000);
  await loginViaUi(studentPage, student.email, student.password, /\/student$/);
  await expect(studentPage.getByText('BIOL 101: Introduction to Biology', { exact: true })).toBeVisible();
  await capture(studentPage, 'student-dashboard.png');
  await studentPage.goto(`/student/course/${course._id}`);
  await expect(studentPage.getByRole('heading', { name: /Introduction to Biology/i })).toBeVisible();
  await capture(studentPage, 'student-course.png');
  await studentPage.getByRole('tab', { name: /^Course Chat/i }).click();
  await expect(studentPage.getByText(/facilitated diffusion differs from active transport/i)).toBeVisible();
  await capture(studentPage, 'student-course-chat.png');
  await studentPage.getByRole('tab', { name: /^AI Chat$/i }).click();
  await expect(studentPage.getByRole('button', { name: /^New conversation$/i })).toBeVisible();
  await capture(studentPage, 'student-ai-chat.png');
  await studentPage.getByRole('tab', { name: /^Lectures/i }).click();
  await studentPage.getByRole('button', { name: /Cell Structure Check-in/i }).first().click();
  await expect(studentPage.getByText(/Which organelle produces most of a cell's ATP/i)).toBeVisible();
  await capture(studentPage, 'student-live-session.png');
  await studentPage.getByRole('tab', { name: /^Chat$/i }).click();
  await expect(studentPage.getByText(/folded inner membrane/i)).toBeVisible();
  await capture(studentPage, 'student-session-chat.png');
  await studentPage.goto(`/student/course/${course._id}/session/${activeQuiz._id}/quiz`);
  await expect(studentPage.getByText(/Which molecule carries genetic information/i)).toBeVisible();
  await capture(studentPage, 'student-quiz.png');
  await studentPage.goto(`/student/course/${course._id}/session/${completedQuiz._id}/review`);
  await expect(studentPage.getByText(/Which structure controls what enters and leaves the cell/i)).toBeVisible();
  await capture(studentPage, 'student-review.png');
  await adminContext.close();
  await professorContext.close();
  await studentContext.close();
});

test('capture practice creation and session admission', async ({ browser, request }) => {
  test.skip(process.env.QCLICKER_CAPTURE_MANUALS !== '1', 'Run with QCLICKER_CAPTURE_MANUALS=1.');
  test.setTimeout(180_000);
  await fs.mkdir(docsOutputDir, { recursive: true });
  await fs.mkdir(publicOutputDir, { recursive: true });

  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token, {
    name: 'Introduction to Biology', deptCode: 'BIOL', courseNumber: '101',
    section: '01', semester: 'Fall 2026',
  });
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  await enrollStudentViaApi(request, student.token, course.enrollmentCode);
  const settings = await apiJson(request, 'PATCH', `/courses/${course._id}`, {
    token: admin.token,
    payload: { allowStudentQuestions: true, tags: [{ value: 'Cell biology', label: 'Cell biology' }] },
  });
  expect(settings.response.status(), JSON.stringify(settings.body)).toBe(200);
  const question = await createQuestionViaApi(request, student.token, {
    courseId: course._id,
    content: '<p>Which organelle produces most of a cell\'s ATP?</p>',
    plainText: "Which organelle produces most of a cell's ATP?",
    solution: '<p>The mitochondrion produces most ATP during cellular respiration.</p>',
    solution_plainText: 'The mitochondrion produces most ATP during cellular respiration.',
    options: [
      { answer: 'Nucleus', correct: false },
      { answer: 'Mitochondrion', correct: true },
      { answer: 'Golgi apparatus', correct: false },
      { answer: 'Lysosome', correct: false },
    ],
  });

  const studentContext = await browser.newContext();
  const studentPage = await studentContext.newPage();
  studentPage.setDefaultTimeout(15_000);
  studentPage.setDefaultNavigationTimeout(60_000);
  await loginViaUi(studentPage, student.email, student.password, /\/student$/);
  await studentPage.goto(`/student/course/${course._id}`);
  await studentPage.getByRole('tab', { name: /^Practice Sessions/i }).click();
  await studentPage.getByRole('button', { name: /^New practice session$/i }).click();
  await studentPage.getByRole('textbox', { name: 'Practice session name' }).fill('Cell biology — revision for Quiz 2');
  await studentPage.getByRole('button', { name: /^Add question$/i }).click();
  await studentPage.getByRole('button', { name: /^Copy from Question Library$/i }).click();
  await expect(studentPage.getByText(question.plainText, { exact: true })).toBeVisible();
  await studentPage.getByRole('spinbutton', { name: 'Random count' }).fill('1');
  await studentPage.getByRole('button', { name: /^Randomly add 1 questions from the list$/i }).click();
  await expect(studentPage.getByRole('dialog')).toHaveCount(0);
  await expect(studentPage.getByText(question.plainText, { exact: true })).toBeVisible();
  await capture(studentPage, 'student-practice-session.png', 1100);
  await studentPage.getByRole('button', { name: /^Save and start practice$/i }).click();
  await expect(studentPage).toHaveURL(/\/review\?returnTab=2$/);
  await studentPage.getByRole('button', { name: /^Show Solution$/i }).click();
  await expect(studentPage.getByText(question.solution_plainText, { exact: true })).toBeVisible();

  const session = await createSessionViaApi(request, admin.token, course._id, {
    name: 'Cell Structure Check-in', status: 'visible',
  });
  await patchSessionViaApi(request, professor.token, session._id, { joinCodeEnabled: true });
  const started = await apiJson(request, 'POST', `/sessions/${session._id}/start`, { token: professor.token });
  expect(started.response.status(), JSON.stringify(started.body)).toBe(200);
  const professorContext = await browser.newContext();
  const professorPage = await professorContext.newPage();
  professorPage.setDefaultTimeout(15_000);
  professorPage.setDefaultNavigationTimeout(60_000);
  await loginViaUi(professorPage, professor.email, professor.password, /\/prof$/);
  await professorPage.goto(`/prof/course/${course._id}/session/${session._id}/live`);
  await expect(professorPage.getByRole('switch', { name: 'Require Passcode' })).toBeChecked();
  await expect(professorPage.getByRole('switch', { name: 'Join Period' })).not.toBeChecked();
  await professorPage.getByRole('switch', { name: 'Join Period' }).click();
  await expect(professorPage.getByRole('switch', { name: 'Join Period' })).toBeChecked();
  await expect(professorPage.getByLabel(/Current join code: \d{6}/)).toBeVisible();
  await capture(professorPage, 'professor-join-code.png');
  await professorPage.getByRole('switch', { name: 'Join Period' }).click();
  await expect(professorPage.getByRole('switch', { name: 'Join Period' })).not.toBeChecked();
  await professorPage.getByRole('tab', { name: /Show students panel/i }).click();
  const waiting = professorPage.getByRole('button', { name: /Waiting to join/i });
  if (await waiting.getAttribute('aria-expanded') === 'false') await waiting.click();
  await expect(professorPage.getByRole('button', { name: /^Admit$/ })).toBeVisible();
  await capture(professorPage, 'professor-session-admission.png');
  await professorPage.getByRole('button', { name: /^Admit$/ }).click();
  await expect(professorPage.getByText('Students in Session (1)', { exact: true })).toBeVisible();
  const rejoined = await apiJson(request, 'POST', `/sessions/${session._id}/join`, {
    token: student.token, payload: {},
  });
  expect(rejoined.response.status(), JSON.stringify(rejoined.body)).toBe(200);
  expect(rejoined.body.alreadyJoined).toBe(true);
  await studentContext.close();
  await professorContext.close();
});


test('capture anonymous statistics privacy notice', async ({ page, request }) => {
  test.skip(process.env.QCLICKER_CAPTURE_MANUALS !== '1', 'Run with QCLICKER_CAPTURE_MANUALS=1.');
  await fs.mkdir(docsOutputDir, { recursive: true });
  await fs.mkdir(publicOutputDir, { recursive: true });
  const { admin, professor } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token, { name: 'Introduction to Biology' });
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  const session = await createSessionViaApi(request, professor.token, course._id, {
    name: 'Anonymous course feedback', anonymous: true,
  });
  const question = await createQuestionViaApi(request, professor.token, {
    courseId: course._id, sessionId: session._id, type: 2, options: [],
    content: '<p>What helped you learn this week?</p>',
  });
  await addQuestionToSessionViaApi(request, professor.token, session._id, question._id);
  const started = await apiJson(request, 'POST', `/sessions/${session._id}/start`, { token: professor.token });
  expect(started.response.status()).toBe(200);
  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.goto(`/prof/course/${course._id}/session/${session._id}/live`);
  await expect(page.getByRole('status').filter({ hasText: 'To protect anonymity' })).toBeVisible();
  await capture(page, 'professor-anonymous-stats-waiting.png', 1200);
});

test('review response timelines include all response times and work on narrow screens', async ({ browser, request }) => {
  const { admin, professor, student } = await seedUsers(request);
  const course = await createCourseViaApi(request, admin.token, { name: 'Introduction to Biology', deptCode: 'BIOL', courseNumber: '101' });
  await addInstructorToCourseViaApi(request, admin.token, course._id, professor.user._id);
  const session = await createSessionViaApi(request, professor.token, course._id, {
    name: 'Cell Biology Review Quiz', quiz: true, status: 'hidden',
    quizStart: '2026-10-02T19:00:00Z', quizEnd: '2026-10-02T19:10:00Z',
  });
  const questionIds = [];
  for (const content of ['Which structure controls what enters and leaves the cell?', 'Which structure contains most of the cell’s genetic material?']) {
    const question = await createQuestionViaApi(request, professor.token, {
      courseId: course._id, content: `<p>${content}</p>`, plainText: content,
      options: [{ answer: 'Cell membrane', correct: true }, { answer: 'Nucleus', correct: false }],
      sessionOptions: { points: 2 },
    });
    const updated = await addQuestionToSessionViaApi(request, professor.token, session._id, question._id);
    questionIds.push(String(updated.questions.at(-1)));
  }
  const participants = [student];
  for (let i = 1; i < 12; i += 1) {
    const registered = await apiJson(request, 'POST', '/auth/register', { payload: buildUser('timeline') });
    expect(registered.response.status()).toBe(201);
    participants.push(registered.body);
  }
  for (const participant of participants) await enrollStudentViaApi(request, participant.token, course.enrollmentCode);
  // Historical times and missing legacy dates are seeded only into the isolated
  // in-memory E2E database, never through production endpoints or real data.
  const { mongoUri } = await readE2eState();
  const mongo = await MongoClient.connect(mongoUri);
  try {
    const offsets = [0, 15, 15, 30, 90, 90, 90, 300, 360, 700, 720, 900];
    const responses = questionIds.flatMap((questionId, questionIndex) => participants.map((participant, index) => {
      const timestamp = new Date(Date.parse('2026-10-02T18:58:00Z') + (offsets[index] + questionIndex * 90) * 1000);
      return {
        _id: `timeline-${questionId}-${index}`, questionId, studentUserId: participant.user._id, attempt: 1,
        answer: String(index % 2), editable: false,
        ...(questionIndex === 1 && index === 0 ? {} : { submittedAt: timestamp, createdAt: timestamp, updatedAt: new Date('2026-10-02T20:00:00Z') }),
      };
    }));
    await mongo.db().collection('responses').insertMany(responses);
  } finally {
    await mongo.close();
  }
  await patchSessionViaApi(request, professor.token, session._id, { status: 'done' });
  const context = await browser.newContext({ timezoneId: 'America/Toronto', hasTouch: true });
  const page = await context.newPage();
  await loginViaUi(page, professor.email, professor.password, /\/prof$/);
  await page.setViewportSize({ width: 1440, height: 1500 });
  await page.goto(`/prof/course/${course._id}/session/${session._id}/review`);
  await expect(page.getByRole('button', { name: 'Session response timeline', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Session response timeline', exact: true }).click();
  const overview = page.getByRole('region', { name: 'Session response timeline', exact: true });
  await expect(overview.getByText('Responses plotted: 23', { exact: true })).toBeVisible();
  await expect(overview.getByText(/without a usable timestamp: 1/)).toBeVisible();
  const chart = overview.getByRole('img', { name: 'Session response timeline', exact: true });
  await chart.focus();
  await chart.press('Home');
  await expect(overview.getByRole('status')).toContainText('Oct 2, 2026');
  await expect(overview.getByRole('status')).toContainText('2:58:00 PM');
  await chart.press('End');
  await expect(overview.getByRole('status')).toContainText('3:14:');
  await chart.press('Escape');
  await expect(overview.getByRole('status')).toBeEmpty();
  await page.getByRole('button', { name: 'Response timeline — Q1, attempt 1', exact: true }).click();
  const question = page.getByRole('region', { name: 'Response timeline — Q1, attempt 1', exact: true });
  await expect(question.getByText('Responses plotted: 12', { exact: true })).toBeVisible();
  await expect(question.getByRole('switch')).toHaveCount(0);
  await expectNoCriticalAccessibilityViolations(page);
  if (process.env.QCLICKER_CAPTURE_MANUALS === '1') await capture(page, 'professor-response-timeline.png', 1900);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(question.getByRole('combobox', { name: 'Detail' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await chart.scrollIntoViewIfNeeded();
  await chart.tap({ position: { x: 90, y: 80 } });
  await expect(overview.getByRole('status')).not.toBeEmpty();
  await overview.getByRole('combobox', { name: 'Detail', exact: true }).click();
  await page.getByRole('option', { name: 'Fine', exact: true }).click();
  await expect(overview.getByText('Responses plotted: 23', { exact: true })).toBeVisible();
  await expectNoCriticalAccessibilityViolations(page);
  await context.close();
});
