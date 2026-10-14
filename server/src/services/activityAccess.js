import crypto from 'node:crypto';
import ActivityGrant from '../models/ActivityGrant.js';
import config from '../config/index.js';
import ActivityShare from '../models/ActivityShare.js';
import Course from '../models/Course.js';
import Session from '../models/Session.js';
import { isCourseMember } from '../utils/courseAccess.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /^(?:S-[A-HJ-NP-Z2-9]{10}|S-[A-F0-9]{40})$/;

export function normalizeActivityCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : '';
}

export function hashActivityCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export function deriveActivityCode(seed) {
  if (!/^[a-f0-9]{32}$/.test(String(seed || ''))) return null;
  const digest = crypto.createHmac('sha256', config.jwtSecret)
    .update(`qlicker-activity-code-v1:${seed}`).digest();
  return `S-${[...digest.subarray(0, 10)].map((byte) => CODE_ALPHABET[byte & 31]).join('')}`;
}

export function makeActivityCode() {
  const seed = crypto.randomBytes(16).toString('hex');
  return { seed, code: deriveActivityCode(seed) };
}

function getStoredActivityCode(share) {
  if (!share?.codeSeed) return null;
  const code = deriveActivityCode(share.codeSeed);
  return code && hashActivityCode(code) === share.codeHash ? code : null;
}

export function getDisplayActivityCode(share) {
  return share?.enabled ? getStoredActivityCode(share) : null;
}

export async function issueActivityCode(sessionId, expiresAt, { regenerate = false } = {}) {
  // Only an explicit regeneration replaces a recoverable code. Conditional
  // updates prevent an enable request from restoring a code rotated meanwhile.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const existing = await ActivityShare.findOne({ sessionId }).lean();
    const storedCode = !regenerate && getStoredActivityCode(existing);
    if (storedCode) {
      const share = await ActivityShare.findOneAndUpdate(
        { _id: existing._id, codeHash: existing.codeHash },
        { $set: { enabled: true, expiresAt, updatedAt: new Date() } },
        { returnDocument: 'after', runValidators: true }
      ).lean();
      if (share) return { code: storedCode, share };
      continue;
    }

    const { seed, code } = makeActivityCode();
    const now = new Date();
    if (existing) {
      const share = await ActivityShare.findOneAndUpdate(
        { _id: existing._id, codeHash: existing.codeHash },
        { $set: { codeHash: hashActivityCode(code), codeSeed: seed, enabled: true, expiresAt, updatedAt: now } },
        { returnDocument: 'after', runValidators: true }
      ).lean();
      if (share) return { code, share };
      continue;
    }

    try {
      const share = await ActivityShare.create({
        sessionId, codeHash: hashActivityCode(code), codeSeed: seed,
        enabled: true, expiresAt, createdAt: now, updatedAt: now,
      });
      return { code, share: share.toObject() };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      // Another request created this session's share (or hit a code collision).
    }
  }
  throw new Error('Activity code changed concurrently; retry the request');
}

export async function hasSessionParticipantAccess(course, session, user) {
  if (isCourseMember(course, user)) return true;
  if (course?.inactive || !course?.allowSharedActivities) return false;
  if (!session?.activityAccessEnabled) return false;
  return hasActivityGrant(String(session._id), String(user?.userId || ''));
}

export async function getActivityRecipientUserIds(session, course = null) {
  if (!session?.activityAccessEnabled) return [];
  const activityCourse = course || await Course.findById(session.courseId).select('allowSharedActivities').lean();
  if (!activityCourse?.allowSharedActivities) return [];
  const share = await ActivityShare.findOne({ sessionId: String(session._id), enabled: true })
    .select('accessEpoch').lean();
  if (!share) return [];
  const grants = await ActivityGrant.find({ sessionId: String(session._id), accessEpoch: share.accessEpoch })
    .select('userId').lean();
  return grants.map((grant) => String(grant.userId));
}

export async function hasActivityGrant(sessionId, userId) {
  const share = await ActivityShare.findOne({ sessionId, enabled: true })
    .select('accessEpoch').lean();
  if (!share) return false;
  return !!(await ActivityGrant.exists({ sessionId, userId, accessEpoch: share.accessEpoch }));
}

// Existing grants survive code rotation and expiry. Disabling the share
// increments accessEpoch, permanently revoking earlier grants. The eventual
// participant routes must call hasActivityGrant.
export async function redeemActivityCode(rawCode, userId) {
  const code = normalizeActivityCode(rawCode);
  if (!code || !userId) return null;
  const now = new Date();
  const share = await ActivityShare.findOne({
    codeHash: hashActivityCode(code), enabled: true,
  }).lean();
  if (!share) return null;
  if (share.expiresAt <= now && !await ActivityGrant.exists({
    sessionId: share.sessionId, userId: String(userId), accessEpoch: share.accessEpoch,
  })) return null;

  // A code may be prepared in Draft, but must not reveal the activity or
  // create participation records until the instructor publishes it.
  const visibleSessionFilter = { _id: share.sessionId, status: { $in: ['visible', 'running', 'done'] } };
  const session = await Session.findOne(visibleSessionFilter)
    .select('_id name courseId quiz practiceQuiz studentCreated anonymous participationStarted')
    .lean();
  if (!session || session.practiceQuiz || session.studentCreated) return null;
  const course = await Course.findById(session.courseId).select('inactive allowSharedActivities students').lean();
  if (!course || course.inactive || !course.allowSharedActivities) return null;

  // This claim races safely with an instructor changing identity mode: the
  // setting update requires participationStarted to remain false.
  const anonymityFilter = session.anonymous ? { anonymous: true } : { anonymous: { $ne: true } };
  const claimed = await Session.updateOne(
    { ...visibleSessionFilter, ...anonymityFilter },
    { $set: { participationStarted: true } }
  );
  if (!claimed.matchedCount) return null;

  // A concurrent disable must not issue an effective grant. Rotation can race
  // with a redemption already underway; that redemption may finish.
  const stillEnabled = await ActivityShare.exists({ _id: share._id, enabled: true });
  if (!stillEnabled) return null;
  const grantFilter = { sessionId: session._id, userId: String(userId) };
  try {
    await ActivityGrant.updateOne(
      grantFilter,
      { $max: { accessEpoch: share.accessEpoch }, $setOnInsert: {
        createdAt: now,
        guestAtRedemption: !(course.students || []).some((id) => String(id) === String(userId)),
      } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Two requests for the same account may race the unique grant index.
    await ActivityGrant.updateOne(grantFilter, { $max: { accessEpoch: share.accessEpoch } });
  }
  const [currentShare, stillVisible] = await Promise.all([
    ActivityShare.exists({ _id: share._id, enabled: true, accessEpoch: share.accessEpoch }),
    Session.exists(visibleSessionFilter),
  ]);
  if (!currentShare || !stillVisible) return null;
  return { sessionId: session._id, courseId: session.courseId, name: session.name, quiz: !!session.quiz, anonymous: !!session.anonymous };
}
