import { beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import Session from '../../src/models/Session.js';
import Question from '../../src/models/Question.js';
import Response from '../../src/models/Response.js';
import Grade from '../../src/models/Grade.js';
import Course from '../../src/models/Course.js';
import { runInteractiveRepairs } from '../../scripts/repair-question-references.js';
import { repairSessionQuestionReferences, getQuestionRepairActions, applyQuestionRepairDecision } from '../../src/services/questionReferenceRepair.js';

beforeEach((ctx) => {
  if (mongoose.connection.readyState !== 1) ctx.skip();
});

async function fixture() {
  await Course.collection.updateOne({ _id: 'course' }, { $setOnInsert: {
    name: 'Introductory Mechanics', deptCode: 'PHY', courseNumber: '101', section: 'A', semester: 'Fall 2026', students: ['student'],
  } }, { upsert: true });
  const session = await Session.create({ name: 'Repair draft', courseId: 'course', status: 'hidden' });
  const question = await Question.create({
    creator: 'professor', courseId: 'course', sessionId: session._id,
    type: 4, content: 'Enter a number', correctNumerical: 42, toleranceNumerical: 0.1,
    sessionOptions: { points: 3, maxAttempts: 2, attemptWeights: [0.5, 1] },
  });
  await Question.collection.updateOne({ _id: question._id }, { $set: { solutionHtml: '<p>Legacy solution</p>' } });
  await Session.updateOne({ _id: session._id }, { $set: {
    questions: [question._id, question._id, question._id], currentQuestion: question._id,
  } });
  return { session, question };
}

describe('question reference repair', () => {
  it('audits without writing and repairs duplicate positions independently and idempotently', async () => {
    const { session, question } = await fixture();
    const before = await Session.collection.findOne({ _id: session._id });
    const source = await Question.collection.findOne({ _id: question._id });
    const audit = await repairSessionQuestionReferences({ sessionId: session._id });
    expect(audit).toMatchObject({ status: 'would-repair', replacements: [
      { position: 2, sourceQuestionId: question._id }, { position: 3, sourceQuestionId: question._id },
    ] });
    expect(await Session.collection.findOne({ _id: session._id })).toEqual(before);
    expect(await Question.countDocuments()).toBe(1);

    const result = await repairSessionQuestionReferences({ sessionId: session._id, apply: true });
    expect(result.status).toBe('repaired');
    const repaired = await Session.findById(session._id).lean();
    expect(repaired.questions[0]).toBe(question._id);
    expect(new Set(repaired.questions).size).toBe(3);
    expect(repaired.currentQuestion).toBe(question._id);
    expect(repaired.questionResponseCounts).toEqual(Object.fromEntries(repaired.questions.map((id) => [id, 0])));
    for (const id of repaired.questions.slice(1)) {
      expect(await Question.collection.findOne({ _id: id })).toMatchObject({
        originalQuestion: question._id, sessionId: session._id, courseId: 'course',
        correctNumerical: 42, toleranceNumerical: 0.1, solutionHtml: '<p>Legacy solution</p>',
        sessionOptions: { points: 3, maxAttempts: 2, attemptWeights: [0.5, 1], attempts: [] },
      });
    }
    expect(await Question.collection.findOne({ _id: question._id })).toEqual(source);
    expect((await repairSessionQuestionReferences({ sessionId: session._id, apply: true })).status).toBe('unchanged');
    expect(await Question.countDocuments()).toBe(3);
  });

  it('preserves the default zero-point value of legacy short-answer questions', async () => {
    const { session, question } = await fixture();
    await Question.collection.updateOne({ _id: question._id }, { $set: { type: 2 }, $unset: { sessionOptions: '' } });
    await repairSessionQuestionReferences({ sessionId: session._id, apply: true });
    const repaired = await Session.findById(session._id).lean();
    expect((await Question.findById(repaired.questions[1])).sessionOptions.points).toBe(0);
  });

  it('runs the CLI as a read-only audit with a session filter', async () => {
    const { session } = await fixture();
    const before = await Session.collection.findOne({ _id: session._id });
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../../scripts/repair-question-references.js', import.meta.url)),
      '--session', session._id, '--json',
    ], { env: { ...process.env, MONGO_URI: `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}` } });
    const reports = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(reports[0]).toMatchObject({ sessionId: session._id, status: 'would-repair' });
    expect(reports[1].summary).toMatchObject({ mode: 'dry-run', scanned: 1 });
    expect(await Session.collection.findOne({ _id: session._id })).toEqual(before);
    expect(await Question.countDocuments()).toBe(1);
  });

  it('does not create collections when auditing an empty database', async () => {
    const databaseName = 'question_repair_empty_audit';
    const database = mongoose.connection.getClient().db(databaseName);
    expect(await database.listCollections().toArray()).toEqual([]);
    const result = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../../scripts/repair-question-references.js', import.meta.url)), '--json',
    ], { env: { ...process.env, MONGO_URI: `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${databaseName}` } }).catch((error) => error);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).summary).toMatchObject({ scanned: 0, mode: 'dry-run' });
    expect(await database.listCollections().toArray()).toEqual([]);
  });

  it('copies foreign references and leaves the source session unchanged', async () => {
    const { session, question } = await fixture();
    const target = await Session.create({ name: 'Other draft', courseId: 'other-course', status: 'hidden', questions: [question._id], currentQuestion: question._id });
    const sourceBefore = await Session.findById(session._id).lean();
    expect((await repairSessionQuestionReferences({ sessionId: target._id, apply: true })).status).toBe('repaired');
    const repaired = await Session.findById(target._id).lean();
    expect(repaired.questions[0]).not.toBe(question._id);
    expect(repaired.currentQuestion).toBe(repaired.questions[0]);
    expect(await Session.findById(session._id).lean()).toEqual(sourceBefore);
  });

  it.each(['response', 'grade', 'foreign-grade', 'joined', 'visible', 'done', 'missing-question'])('leaves %s cases untouched for manual review', async (condition) => {
    const { session, question } = await fixture();
    if (condition === 'response') await Response.create({ questionId: question._id, studentUserId: 'student', attempt: 1, answer: 42 });
    if (condition === 'grade') await Grade.create({ sessionId: session._id, userId: 'student', automatic: false, value: 90 });
    if (condition === 'foreign-grade') await Grade.create({ sessionId: 'other-session', userId: 'student', marks: [{ questionId: question._id, points: 2, automatic: false }] });
    if (condition === 'joined') await Session.updateOne({ _id: session._id }, { $set: { joined: ['student'] } });
    if (condition === 'visible' || condition === 'done') await Session.updateOne({ _id: session._id }, { $set: { status: condition } });
    if (condition === 'missing-question') await Question.deleteOne({ _id: question._id });
    const sessionsBefore = await Session.collection.find({}).toArray();
    const questionsBefore = await Question.collection.find({}).toArray();
    const gradesBefore = await Grade.collection.find({}).toArray();
    const responsesBefore = await Response.collection.find({}).toArray();
    expect((await repairSessionQuestionReferences({ sessionId: session._id, apply: true })).status).toBe('manual-review');
    expect(await Session.collection.find({}).toArray()).toEqual(sessionsBefore);
    expect(await Question.collection.find({}).toArray()).toEqual(questionsBefore);
    expect(await Grade.collection.find({}).toArray()).toEqual(gradesBefore);
    expect(await Response.collection.find({}).toArray()).toEqual(responsesBefore);
  });

  it('cleans up copies if the inspected session changes before replacement', async () => {
    const { session } = await fixture();
    const update = Session.collection.updateOne.bind(Session.collection);
    const spy = vi.spyOn(Session.collection, 'updateOne').mockImplementationOnce(async (filter, changes) => {
      await update({ _id: session._id }, { $set: { name: 'Concurrent edit' } });
      return update(filter, changes);
    });
    try {
      expect((await repairSessionQuestionReferences({ sessionId: session._id, apply: true })).status).toBe('conflict');
      expect(await Question.countDocuments()).toBe(1);
      expect((await Session.findById(session._id)).name).toBe('Concurrent edit');
    } finally {
      spy.mockRestore();
    }
  });

  it('retains copies after an uncertain acknowledgement of a successful session update', async () => {
    const { session } = await fixture();
    const update = Session.collection.updateOne.bind(Session.collection);
    const spy = vi.spyOn(Session.collection, 'updateOne').mockImplementationOnce(async (filter, changes) => {
      await update(filter, changes);
      throw new Error('Lost acknowledgement');
    });
    try {
      await expect(repairSessionQuestionReferences({ sessionId: session._id, apply: true })).rejects.toThrow('Lost acknowledgement');
      const repaired = await Session.findById(session._id).lean();
      expect(new Set(repaired.questions).size).toBe(3);
      expect(await Question.countDocuments({ _id: { $in: repaired.questions } })).toBe(3);
      expect((await repairSessionQuestionReferences({ sessionId: session._id, apply: true })).status).toBe('unchanged');
    } finally {
      spy.mockRestore();
    }
  });

  it('cleans up earlier copies if creating a later copy fails', async () => {
    const { session } = await fixture();
    const before = await Session.findById(session._id).lean();
    const insert = Question.collection.insertOne.bind(Question.collection);
    const spy = vi.spyOn(Question.collection, 'insertOne')
      .mockImplementationOnce(insert)
      .mockRejectedValueOnce(new Error('Simulated insertion failure'));
    try {
      await expect(repairSessionQuestionReferences({ sessionId: session._id, apply: true })).rejects.toThrow('Simulated insertion failure');
      expect(await Question.countDocuments()).toBe(1);
      expect(await Session.findById(session._id).lean()).toEqual(before);
    } finally {
      spy.mockRestore();
    }
  });
  it('diagnoses all sessions in English with course and session names without writing', async () => {
    const { session } = await fixture();
    await Session.create({ name: 'Healthy session', courseId: 'course', status: 'hidden' });
    const before = await Session.collection.find({}).toArray();
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../../scripts/repair-question-references.js', import.meta.url)),
    ], { env: { ...process.env, MONGO_URI: `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}` } });
    expect(stdout).toContain('Course: Introductory Mechanics (PHY 101 A Fall 2026)');
    expect(stdout).toContain('Session: Repair draft [hidden]');
    expect(stdout).toContain('Repeated question positions: 2, 3');
    expect(stdout).toContain('Scanned 2 sessions. Found 1 session needing review.');
    expect(stdout).toContain('Diagnostic only: no data was changed.');
    expect(stdout).toContain(session._id);
    expect(await Session.collection.find({}).toArray()).toEqual(before);
    expect(await Question.countDocuments()).toBe(1);
  });

  it('walks through removal while keeping historical grades and responses exactly unchanged', async () => {
    const { session, question } = await fixture();
    await Session.updateOne({ _id: session._id }, { $set: { status: 'done', joined: ['student'] } });
    await Response.create({ questionId: question._id, studentUserId: 'student', attempt: 1, answer: 42 });
    await Grade.create({ sessionId: session._id, courseId: 'course', userId: 'student', value: 80, automatic: false });
    const beforeGrades = await Grade.collection.find({}).toArray();
    const beforeResponses = await Response.collection.find({}).toArray();
    const report = await repairSessionQuestionReferences({ sessionId: session._id });
    const answers = ['1', 'REPAIR'];
    const output = [];
    const result = await runInteractiveRepairs([{ ...report, courseName: 'Introductory Mechanics' }], {
      ask: async () => answers.shift(), write: (line) => output.push(line),
    });
    expect(result).toEqual({ repaired: 1, skipped: 0 });
    expect(output.join('\n')).toContain('from 3 positions to 1');
    expect((await Session.findById(session._id)).questions).toEqual([question._id]);
    expect(await Grade.collection.find({}).toArray()).toEqual(beforeGrades);
    expect(await Response.collection.find({}).toArray()).toEqual(beforeResponses);
  });

  it('recalculates automatic totals for unique questions while retaining manual marks and feedback metadata', async () => {
    const { session, question } = await fixture();
    await Session.updateOne({ _id: session._id }, { $set: { status: 'done', joined: ['student'] } });
    await Response.create({ questionId: question._id, studentUserId: 'student', attempt: 1, answer: 42 });
    const feedbackUpdatedAt = new Date('2026-01-01');
    await Grade.create({ sessionId: session._id, courseId: 'course', userId: 'student', automatic: true, value: 10,
      marks: [
        { questionId: question._id, points: 2, outOf: 3, automatic: false, feedback: 'Instructor override', feedbackUpdatedAt },
        { questionId: question._id, points: 0, outOf: 3, automatic: true },
      ],
    });
    const state = await getQuestionRepairActions(session._id);
    expect(state.actions).toContain('remove-recalculate');
    const result = await applyQuestionRepairDecision({ sessionId: session._id, action: 'remove-recalculate', expectedQuestionIds: state.questionIds });
    expect(result.status).toBe('repaired');
    const grade = await Grade.findOne({ sessionId: session._id }).lean();
    expect(grade).toMatchObject({ points: 2, outOf: 3, numQuestions: 1 });
    expect(grade.value).toBeCloseTo(66.7, 1);
    expect(grade.marks).toHaveLength(1);
    expect(grade.marks[0]).toMatchObject({ points: 2, automatic: false, feedback: 'Instructor override', feedbackUpdatedAt });
    expect((await Session.findById(session._id)).questions).toEqual([question._id]);
  });

  it('requires confirmation and safely defaults to skipping', async () => {
    const { session } = await fixture();
    const report = { ...(await repairSessionQuestionReferences({ sessionId: session._id })), courseName: 'Mechanics' };
    for (const answers of [[''], ['q'], ['1', 'no']]) {
      const result = await runInteractiveRepairs([report], { ask: async () => answers.shift(), write: () => {} });
      expect(result).toEqual({ repaired: 0, skipped: 1 });
    }
    expect(new Set((await Session.findById(session._id)).questions).size).toBe(1);
    expect(await Question.countDocuments()).toBe(1);
  });

  it('rejects stale decisions and blocks recalculation of ambiguous manual marks', async () => {
    const { session, question } = await fixture();
    await Session.updateOne({ _id: session._id }, { $set: { status: 'done' } });
    await Grade.create({ sessionId: session._id, userId: 'student', marks: [
      { questionId: question._id, automatic: false, points: 1 },
      { questionId: question._id, automatic: false, points: 2 },
    ] });
    const state = await getQuestionRepairActions(session._id);
    expect(state.actions).toEqual(['remove-keep-grades']);
    expect((await applyQuestionRepairDecision({ sessionId: session._id, action: 'remove-recalculate', expectedQuestionIds: state.questionIds })).status).toBe('manual-review');
    expect((await applyQuestionRepairDecision({ sessionId: session._id, action: 'remove-keep-grades', expectedQuestionIds: [] })).status).toBe('conflict');
    expect((await Session.findById(session._id)).questions).toHaveLength(3);
  });

  it('does not offer historical repairs when the question is referenced by another session', async () => {
    const { session, question } = await fixture();
    await Response.create({ questionId: question._id, studentUserId: 'student', attempt: 1, answer: 42 });
    await Session.create({ name: 'Other session', courseId: 'course', status: 'done', questions: [question._id] });
    const state = await getQuestionRepairActions(session._id);
    expect(state.actions).toEqual([]);
    expect(state.blocks.join(' ')).toContain('individual review');
  });

  it('leaves failed recalculations detectable and supports retry without changing manual overall grades', async () => {
    const { session, question } = await fixture();
    await Session.updateOne({ _id: session._id }, { $set: { status: 'done', joined: ['student'] } });
    await Response.create({ questionId: question._id, studentUserId: 'student', attempt: 1, answer: 42 });
    await Grade.create({ sessionId: session._id, courseId: 'course', userId: 'student', automatic: false, value: 82 });
    const state = await getQuestionRepairActions(session._id);
    const spy = vi.spyOn(Grade.collection, 'updateMany').mockRejectedValueOnce(new Error('Interrupted grade write'));
    try {
      await expect(applyQuestionRepairDecision({ sessionId: session._id, action: 'remove-recalculate', expectedQuestionIds: state.questionIds })).rejects.toThrow('Interrupted grade write');
      expect((await Session.findById(session._id)).questions).toHaveLength(3);
    } finally { spy.mockRestore(); }
    const result = await applyQuestionRepairDecision({ sessionId: session._id, action: 'remove-recalculate', expectedQuestionIds: state.questionIds });
    expect(result.status).toBe('repaired');
    const grade = await Grade.findOne({ sessionId: session._id }).lean();
    // The fixture's first attempt carries half weight (0.5 × 3 points).
    expect(grade).toMatchObject({ automatic: false, value: 82, points: 1.5, outOf: 3 });
    expect((await repairSessionQuestionReferences({ sessionId: session._id })).status).toBe('unchanged');
  });

  it('allows unused visible sessions to be copied through an explicit interactive decision', async () => {
    const { session } = await fixture();
    await Session.updateOne({ _id: session._id }, { $set: { status: 'visible' } });
    const state = await getQuestionRepairActions(session._id);
    expect(state.actions).toContain('copy');
    expect((await applyQuestionRepairDecision({ sessionId: session._id, action: 'copy', expectedQuestionIds: state.questionIds })).status).toBe('repaired');
    const updated = await Session.findById(session._id).lean();
    expect(updated.status).toBe('visible');
    expect(new Set(updated.questions).size).toBe(3);
  });

});
