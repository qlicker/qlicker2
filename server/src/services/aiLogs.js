import AiLog from '../models/AiLog.js';

const GRADING_CATEGORY = 'grading';

export async function startAiGradingLogRun(job, startedAt = new Date()) {
  return AiLog.findOneAndUpdate(
    { category: GRADING_CATEGORY, recordType: 'run', jobId: String(job._id) },
    {
      $setOnInsert: {
        category: GRADING_CATEGORY,
        recordType: 'run',
        courseId: String(job.courseId),
        sessionId: String(job.sessionId),
        jobId: String(job._id),
        ownerId: String(job.ownerId || ''),
        startedAt,
        createdAt: startedAt,
        entryCount: 0,
      },
      $set: { status: 'running', completedAt: null, updatedAt: startedAt },
    },
    { upsert: true, returnDocument: 'after' }
  ).lean();
}

export async function appendAiGradingLogEntry(job, entry, timestamp = new Date()) {
  const run = await AiLog.findOneAndUpdate(
    { category: GRADING_CATEGORY, recordType: 'run', jobId: String(job._id) },
    { $inc: { entryCount: 1 }, $set: { updatedAt: timestamp } },
    { returnDocument: 'after' }
  ).lean();
  if (!run) throw new Error('AI grading log run is not initialized');
  const sequence = Number(run.entryCount) || 1;
  await AiLog.create({
    category: GRADING_CATEGORY,
    recordType: 'entry',
    courseId: String(job.courseId),
    sessionId: String(job.sessionId),
    questionId: String(entry.questionId || ''),
    jobId: String(job._id),
    ownerId: String(job.ownerId || ''),
    status: String(entry.status || ''),
    sequence,
    payload: { ...entry, timestamp },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export async function finishAiGradingLogRun(jobId, status, completedAt = new Date(), extra = {}) {
  return AiLog.findOneAndUpdate(
    { category: GRADING_CATEGORY, recordType: 'run', jobId: String(jobId) },
    { $set: { status, completedAt, updatedAt: completedAt, ...extra } },
    { returnDocument: 'after' }
  ).lean();
}

export async function getAiGradingLog(courseId, sessionId) {
  const runs = await AiLog.find({
    category: GRADING_CATEGORY,
    recordType: 'run',
    courseId: String(courseId),
    sessionId: String(sessionId),
  }).sort({ startedAt: 1, createdAt: 1 }).lean();
  if (runs.length === 0) return null;
  const entries = await AiLog.find({
    category: GRADING_CATEGORY,
    recordType: 'entry',
    courseId: String(courseId),
    sessionId: String(sessionId),
    jobId: { $in: runs.map((run) => run.jobId) },
  }).sort({ jobId: 1, sequence: 1 }).lean();
  const entriesByJob = new Map();
  entries.forEach((entry) => {
    if (!entriesByJob.has(entry.jobId)) entriesByJob.set(entry.jobId, []);
    entriesByJob.get(entry.jobId).push(entry.payload || {});
  });
  return {
    runs: runs.map((run) => ({
      jobId: run.jobId,
      startedAt: run.startedAt,
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
      ...(run.payload?.haltedAt ? { haltedAt: run.payload.haltedAt } : {}),
      status: run.status,
      entries: entriesByJob.get(run.jobId) || [],
    })),
    updatedAt: runs.reduce((latest, run) => (
      !latest || new Date(run.updatedAt) > new Date(latest) ? run.updatedAt : latest
    ), null),
  };
}

export async function clearAiGradingLogs(courseId, sessionId) {
  return AiLog.deleteMany({
    category: GRADING_CATEGORY,
    courseId: String(courseId),
    sessionId: String(sessionId),
  });
}
