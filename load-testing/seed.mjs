#!/usr/bin/env node
/**
 * seed.mjs – Populate MongoDB with load-test fixtures.
 *
 * Creates:
 *   • 1 admin user
 *   • 1 professor user
 *   • N student users  (default 500)
 *   • 1 course with enrolled students and a configurable share of outside participants
 *   • 1 session with 5 questions (MC, MS, TF, SA, NU)
 *
 * Usage:
 *   MONGO_URL=mongodb://localhost:27017/qlicker node seed.mjs [--students 500] [--clean]
 *
 * The script writes load-testing/state.json which the k6 scenario reads.
 */

import mongoose from 'mongoose';
import { hash, Algorithm, Version } from '@node-rs/argon2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.STATE_DIR || __dirname;
const STATE_PATH = path.join(STATE_DIR, 'state.json');

function parseIntEnv(value, fallback, minValue = 0) {
  const parsed = parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed < minValue) return fallback;
  return parsed;
}

const MONGO_CONNECT_RETRIES = parseIntEnv(process.env.MONGO_CONNECT_RETRIES, 6, 1);
const MONGO_CONNECT_RETRY_DELAY_MS = parseIntEnv(process.env.MONGO_CONNECT_RETRY_DELAY_MS, 2000, 250);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function connectWithRetry(mongoUrl) {
  let lastError = null;

  for (let attempt = 1; attempt <= MONGO_CONNECT_RETRIES; attempt += 1) {
    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect().catch(() => {});
      }
      await mongoose.connect(mongoUrl, {
        autoIndex: false,
        maxPoolSize: 4,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
      });
      if (attempt > 1) {
        console.log(`MongoDB connection recovered on attempt ${attempt}.`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= MONGO_CONNECT_RETRIES) {
        break;
      }

      const delayMs = Math.min(MONGO_CONNECT_RETRY_DELAY_MS * attempt, 10000);
      console.warn(
        `MongoDB connection attempt ${attempt}/${MONGO_CONNECT_RETRIES} failed: ${error?.message || error}. Retrying in ${delayMs}ms …`
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/* ---------- helpers ---------------------------------------------------- */

/** Generate a 17-char random alphanumeric ID (Meteor-compatible) */
function meteorId() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz';
  let id = '';
  for (let i = 0; i < 17; i++) {
    id += chars[crypto.randomInt(chars.length)];
  }
  return id;
}

/** Hash a password using the same argon2 settings the server uses */
async function hashPassword(pw) {
  return hash(pw, {
    algorithm: Algorithm.Argon2id,
    version: Version.V0x13,
    memoryCost: 19456,
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  });
}

/* ---------- Mongoose schemas (minimal – matches server models) --------- */

const userSchema = new mongoose.Schema(
  {
    _id: { type: String, default: meteorId },
    emails: [
      {
        address: String,
        verified: { type: Boolean, default: false },
      },
    ],
    services: {
      password: {
        hash: String,
        bcrypt: String,
      },
    },
    profile: {
      firstname: String,
      lastname: String,
      roles: [String],
      profileImage: { type: String, default: '' },
    },
    allowEmailLogin: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    lastAuthProvider: { type: String, default: '' },
    refreshTokenVersion: { type: Number, default: 0 },
    failedLoginAttempts: { type: Number, default: 0 },
    loginLockedUntil: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    lastLogin: { type: Date, default: null },
    lastLoginIp: { type: String, default: '' },
  },
  { collection: 'users', versionKey: false },
);

const courseSchema = new mongoose.Schema(
  {
    _id: { type: String, default: meteorId },
    name: String,
    deptCode: { type: String, default: '' },
    courseNumber: { type: String, default: '' },
    section: { type: String, default: '' },
    semester: { type: String, default: '' },
    owner: String,
    instructors: [String],
    students: [String],
    allowSharedActivities: { type: Boolean, default: false },
    enrollmentCode: String,
    sessions: [String],
    inactive: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'courses', versionKey: false },
);

const sessionSchema = new mongoose.Schema(
  {
    _id: { type: String, default: meteorId },
    name: String,
    description: { type: String, default: '' },
    courseId: String,
    creator: String,
    status: { type: String, default: 'hidden' },
    quiz: { type: Boolean, default: false },
    practiceQuiz: { type: Boolean, default: false },
    anonymous: { type: Boolean, default: false },
    participationStarted: { type: Boolean, default: false },
    activityEverShared: { type: Boolean, default: false },
    activityAccessEnabled: { type: Boolean, default: false },
    quizStart: Date,
    quizEnd: Date,
    reviewable: { type: Boolean, default: false },
    questions: [String],
    currentQuestion: { type: String, default: '' },
    joined: [String],
    joinRecords: [
      {
        _id: false,
        userId: String,
        joinedAt: { type: Date, default: Date.now },
        joinedWithCode: { type: Boolean, default: false },
      },
    ],
    submittedQuiz: [String],
    hasResponses: { type: Boolean, default: false },
    questionResponseCounts: { type: Map, of: Number, default: {} },
    joinCodeEnabled: { type: Boolean, default: false },
    joinCodeActive: { type: Boolean, default: false },
    currentJoinCode: { type: String, default: '' },
    joinCodeInterval: { type: Number, default: 10 },
    joinCodeExpiresAt: { type: Date, default: null },
    date: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'sessions', versionKey: false },
);

const questionSchema = new mongoose.Schema(
  {
    _id: { type: String, default: meteorId },
    type: Number,
    content: { type: String, default: '' },
    plainText: { type: String, default: '' },
    courseId: { type: String, default: '' },
    sessionId: { type: String, default: '' },
    creator: String,
    owner: { type: String, default: '' },
    options: [
      {
        _id: false,
        answer: String,
        correct: Boolean,
        plainText: { type: String, default: '' },
        wysiwyg: { type: Boolean, default: false },
      },
    ],
    correctNumerical: { type: Number, default: null },
    toleranceNumerical: { type: Number, default: null },
    solution: { type: String, default: '' },
    solution_plainText: { type: String, default: '' },
    tags: [
      {
        _id: false,
        value: { type: String, default: '' },
        label: { type: String, default: '' },
        className: { type: String, default: '' },
      },
    ],
    public: { type: Boolean, default: false },
    sessionOptions: {
      hidden: { type: Boolean, default: true },
      stats: { type: Boolean, default: false },
      correct: { type: Boolean, default: false },
      points: { type: Number, default: 1 },
      maxAttempts: { type: Number, default: 1 },
      attempts: { type: Array, default: [] },
    },
    sessionProperties: {
      lastAttemptNumber: { type: Number, default: 0 },
      lastAttemptResponseCount: { type: Number, default: 0 },
    },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'questions', versionKey: false },
);

const User = mongoose.model('User', userSchema);
const Course = mongoose.model('Course', courseSchema);
const Session = mongoose.model('Session', sessionSchema);
const Question = mongoose.model('Question', questionSchema);

/* ---------- question definitions --------------------------------------- */

const QUESTIONS = [
  {
    type: 0, // MC
    content: '<p>Which planet is closest to the Sun?</p>',
    plainText: 'Which planet is closest to the Sun?',
    options: [
      { answer: 'Venus', correct: false, plainText: 'Venus' },
      { answer: 'Mercury', correct: true, plainText: 'Mercury' },
      { answer: 'Earth', correct: false, plainText: 'Earth' },
      { answer: 'Mars', correct: false, plainText: 'Mars' },
    ],
  },
  {
    type: 3, // MS
    content: '<p>Select all prime numbers.</p>',
    plainText: 'Select all prime numbers.',
    options: [
      { answer: '2', correct: true, plainText: '2' },
      { answer: '4', correct: false, plainText: '4' },
      { answer: '7', correct: true, plainText: '7' },
      { answer: '9', correct: false, plainText: '9' },
      { answer: '11', correct: true, plainText: '11' },
    ],
  },
  {
    type: 1, // TF
    content: '<p>True or False: Water boils at 100 °C at sea level.</p>',
    plainText: 'True or False: Water boils at 100 °C at sea level.',
    options: [
      { answer: 'True', correct: true, plainText: 'True' },
      { answer: 'False', correct: false, plainText: 'False' },
    ],
  },
  {
    type: 2, // SA
    content: '<p>What is the chemical symbol for gold?</p>',
    plainText: 'What is the chemical symbol for gold?',
    options: [],
    solution: 'Au',
    solution_plainText: 'Au',
  },
  {
    type: 4, // NU
    content: '<p>What is the value of π rounded to two decimal places?</p>',
    plainText: 'What is the value of π rounded to two decimal places?',
    options: [],
    correctNumerical: 3.14,
    toleranceNumerical: 0.01,
  },
];

/* ---------- main ------------------------------------------------------- */

async function main() {
  const args = process.argv.slice(2);
  const cleanOnly = args.includes('--clean');

  const studentsIdx = args.indexOf('--students');
  const numStudents = studentsIdx !== -1 ? parseInt(args[studentsIdx + 1], 10) : 500;
  const scenarioIdx = args.indexOf('--scenario');
  const scenario = scenarioIdx !== -1 ? args[scenarioIdx + 1] : 'live-named';
  if (!['live-named', 'live-anonymous', 'quiz-named', 'quiz-anonymous',
    'live-external-named', 'live-external-anonymous', 'quiz-external-named', 'quiz-external-anonymous'].includes(scenario)) {
    console.error('--scenario must name an ordinary or external live/quiz named/anonymous workload');
    process.exit(1);
  }
  if (Number.isNaN(numStudents) || numStudents < 1) {
    console.error('--students must be a positive integer');
    process.exit(1);
  }

  const enrolledIndex = args.indexOf('--enrolled-percent');
  const defaultPercent = scenario.includes('-external-') ? (scenario.endsWith('-anonymous') ? 0 : 50) : 100;
  const enrolledPercent = enrolledIndex < 0 ? defaultPercent : Number(args[enrolledIndex + 1]);
  if (!Number.isInteger(enrolledPercent) || enrolledPercent < 0 || enrolledPercent > 100
    || (!scenario.includes('-external-') && enrolledPercent !== 100)) {
    throw new Error('--enrolled-percent must be 0–100 (100 for ordinary sessions)');
  }

  const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017/qlicker';
  console.log('Connecting to the configured load-test MongoDB …');
  await connectWithRetry(mongoUrl);

  if (cleanOnly) {
    console.log('Cleaning load-test data …');
    await cleanup();
    await mongoose.disconnect();
    if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
    console.log('Done.');
    return;
  }

  console.log(`Seeding ${numStudents} students + professor + admin …`);
  const state = await seed(numStudents, scenario, enrolledPercent);

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`State written to ${STATE_PATH}`);
  await mongoose.disconnect();
  console.log('Done.');
}

/* ---------- seed logic ------------------------------------------------- */

const LOAD_TEST_TAG = '__loadtest__';
const PASSWORD = 'LoadTest1!';

async function seed(numStudents, scenario, enrolledPercent) {
  // Clean any previous run first
  await cleanup();

  const passwordHash = await hashPassword(PASSWORD);
  const external = scenario.includes('-external-');

  // --- Admin ---
  const admin = await User.create({
    emails: [{ address: 'loadtest-admin@example.com', verified: true }],
    services: { password: { hash: passwordHash } },
    profile: { firstname: 'LT', lastname: 'Admin', roles: ['admin'] },
    allowEmailLogin: true,
    lastAuthProvider: 'password',
    lastLogin: new Date(),
  });

  // --- Professor ---
  const professor = await User.create({
    emails: [{ address: 'loadtest-prof@example.com', verified: true }],
    services: { password: { hash: passwordHash } },
    profile: { firstname: 'LT', lastname: 'Professor', roles: ['professor'] },
    allowEmailLogin: true,
    lastAuthProvider: 'password',
    lastLogin: new Date(),
  });

  // --- Students (bulk) ---
  const studentDocs = [];
  for (let i = 1; i <= numStudents; i++) {
    studentDocs.push({
      _id: meteorId(),
      emails: [{ address: `loadtest-student${i}@example.com`, verified: true }],
      services: { password: { hash: passwordHash } },
      profile: {
        firstname: 'Student',
        lastname: `LT${String(i).padStart(4, '0')}`,
        roles: ['student'],
      },
      allowEmailLogin: true,
      lastAuthProvider: 'password',
      lastLogin: new Date(),
    });
  }
  await User.insertMany(studentDocs);
  const studentIds = studentDocs.map((s) => s._id);

  // --- Course ---
  const anonymous = scenario.endsWith('-anonymous');
  const enrolledStudentIds = studentIds.slice(0, Math.round(numStudents * enrolledPercent / 100));
  const enrolledStudentIdSet = new Set(enrolledStudentIds);
  const enrollmentCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  const course = await Course.create({
    name: `Load Test Course (${numStudents} students)`,
    deptCode: 'LT',
    courseNumber: '999',
    section: '001',
    semester: 'Load Test',
    owner: professor._id,
    instructors: [professor._id],
    students: enrolledStudentIds,
    allowSharedActivities: external,
    enrollmentCode,
    tags: [{
      value: LOAD_TEST_TAG,
      label: 'Load Test',
      className: 'load-test-tag',
    }],
  });

  // --- Questions ---
  const questionIds = [];
  for (const qDef of QUESTIONS) {
    const q = await Question.create({
      ...qDef,
      creator: professor._id,
      owner: professor._id,
      courseId: course._id,
      sessionId: '',
      tags: [{
        value: LOAD_TEST_TAG,
        label: 'Load Test',
        className: 'load-test-tag',
      }],
      sessionOptions: {
        hidden: true,
        stats: false,
        correct: false,
        points: 1,
        maxAttempts: 1,
        attempts: [],
      },
      sessionProperties: {
        lastAttemptNumber: 0,
        lastAttemptResponseCount: 0,
      },
    });
    questionIds.push(q._id);
  }

  // --- Session ---
  const isQuiz = scenario.startsWith('quiz-');
  const session = await Session.create({
    name: `Load Test Session (${scenario})`,
    description: `${LOAD_TEST_TAG} generated fixture`,
    courseId: course._id,
    creator: professor._id,
    status: isQuiz ? 'visible' : 'hidden',
    quiz: isQuiz,
    anonymous,
    activityEverShared: external,
    activityAccessEnabled: external,
    ...(isQuiz ? {
      quizStart: new Date(Date.now() - 60_000),
      quizEnd: new Date(Date.now() + 60 * 60_000),
    } : {}),
    questions: questionIds,
    tags: [{
      value: LOAD_TEST_TAG,
      label: 'Load Test',
      className: 'load-test-tag',
    }],
    hasResponses: false,
  });

  // Add session to course
  await Course.findByIdAndUpdate(course._id, { $push: { sessions: session._id } });
  await Question.updateMany(
    { _id: { $in: questionIds } },
    { $set: { sessionId: session._id } },
  );

  // Seed the same hashed code shape as the API. The plaintext lives only in
  // the ignored state file for k6; cleanup removes both sharing collections.
  let activityCode = '';
  if (external) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    activityCode = `S-${[...crypto.randomBytes(7)].map((byte) => alphabet[byte & 31]).join('')}`;
    await mongoose.connection.db.collection('activityShares').insertOne({
      _id: meteorId(), sessionId: session._id,
      codeHash: crypto.createHash('sha256').update(activityCode).digest('hex'),
      enabled: true, accessEpoch: 0,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdAt: new Date(), updatedAt: new Date(),
    });
  }

  // Build student credentials list for the k6 scenario
  const students = studentDocs.map((s, i) => ({
    email: `loadtest-student${i + 1}@example.com`,
    id: s._id,
    enrolled: enrolledStudentIdSet.has(s._id),
  }));

  return {
    password: PASSWORD,
    admin: { email: 'loadtest-admin@example.com', id: admin._id },
    professor: { email: 'loadtest-prof@example.com', id: professor._id },
    students,
    course: { id: course._id, enrollmentCode },
    session: { id: session._id, scenario, anonymous, quiz: isQuiz, external, activityCode, enrolledPercent },
    questions: questionIds.map((id, i) => ({
      id,
      type: QUESTIONS[i].type,
      label: ['MC', 'MS', 'TF', 'SA', 'NU'][i],
      optionCount: QUESTIONS[i].options.length,
    })),
  };
}

async function cleanup() {
  // Collect load-test user IDs before deleting them (needed to clean responses)
  const loadTestUsers = await User.find(
    { 'emails.address': /^loadtest-/ },
    { _id: 1 },
  ).lean();
  const userIds = loadTestUsers.map((u) => u._id);
  const loadTestCourses = await Course.find(
    { deptCode: 'LT', courseNumber: '999' },
    { _id: 1 },
  ).lean();
  const courseIds = loadTestCourses.map((course) => course._id);
  const loadTestSessions = await Session.find(
    {
      $or: [
        { description: new RegExp(LOAD_TEST_TAG) },
        { name: 'Load Test Session' },
      ],
    },
    { _id: 1, courseId: 1 },
  ).lean();
  const sessionIds = loadTestSessions.map((session) => session._id);
  const loadTestQuestions = await Question.find(
    { 'tags.value': LOAD_TEST_TAG },
    { _id: 1 },
  ).lean();
  const questionIds = loadTestQuestions.map((question) => question._id);

  const db = mongoose.connection.db;
  if (db && sessionIds.length > 0) {
    await db.collection('activityShares').deleteMany({ sessionId: { $in: sessionIds } });
    await db.collection('activityGrants').deleteMany({ sessionId: { $in: sessionIds } });
  }

  // Remove users with loadtest emails
  await User.deleteMany({ 'emails.address': /^loadtest-/ });
  // Remove courses tagged as load test
  await Course.deleteMany({ deptCode: 'LT', courseNumber: '999' });
  // Remove questions tagged for load test
  await Question.deleteMany({ 'tags.value': LOAD_TEST_TAG });
  // Remove sessions created by the load test professor
  await Session.deleteMany({
    $or: [
      { description: new RegExp(LOAD_TEST_TAG) },
      { name: 'Load Test Session' },
    ],
  });

  // Clean responses from load test students
  if (db) {
    if (questionIds.length > 0 || userIds.length > 0) {
      await db.collection('responses').deleteMany({
        $or: [
          ...(questionIds.length > 0 ? [{ questionId: { $in: questionIds } }] : []),
          ...(userIds.length > 0 ? [{ studentUserId: { $in: userIds } }] : []),
        ],
      });
    }
    if (sessionIds.length > 0 || courseIds.length > 0 || userIds.length > 0) {
      await db
        .collection('posts')
        .deleteMany({
          $or: [
            ...(sessionIds.length > 0 ? [{ sessionId: { $in: sessionIds } }] : []),
            ...(courseIds.length > 0 ? [{ courseId: { $in: courseIds } }] : []),
            { authorId: { $in: userIds } },
            { upvoteUserIds: { $in: userIds } },
            { 'comments.authorId': { $in: userIds } },
          ],
        })
        .catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
