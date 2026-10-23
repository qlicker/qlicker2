import crypto from 'crypto';
import config from '../config/index.js';

// Anonymous sessions store responses and attendance under a per-session
// pseudonym instead of the student's user id. The pseudonym is an HMAC keyed
// by a server secret, so it can be recomputed for the signed-in student (to
// enforce one answer and show their own responses) but cannot be reversed
// from database contents alone.
export const ANONYMOUS_PARTICIPANT_PREFIX = 'anon_';
export const MIN_ANONYMOUS_RESPONDENTS = 4;

const PSEUDONYM_CACHE_MAX = 20000;
const pseudonymCache = new Map();

function getAnonymizationKey() {
  return process.env.ANONYMOUS_SESSION_SECRET || config.jwtSecret;
}

export function isAnonymousSession(session) {
  return !!session?.anonymous;
}

export function isAnonymousParticipantId(value) {
  return typeof value === 'string' && value.startsWith(ANONYMOUS_PARTICIPANT_PREFIX);
}

export function getAnonymousParticipantId(sessionId, userId) {
  const normalizedSessionId = String(sessionId || '');
  const normalizedUserId = String(userId || '');
  if (!normalizedSessionId || !normalizedUserId) return '';

  const cacheKey = `${normalizedSessionId}:${normalizedUserId}`;
  const cached = pseudonymCache.get(cacheKey);
  if (cached) return cached;

  const digest = crypto
    .createHmac('sha256', getAnonymizationKey())
    .update(`anonymous-session:${normalizedSessionId}:${normalizedUserId}`)
    .digest('hex')
    .slice(0, 32);
  const pseudonym = `${ANONYMOUS_PARTICIPANT_PREFIX}${digest}`;

  if (pseudonymCache.size >= PSEUDONYM_CACHE_MAX) {
    pseudonymCache.delete(pseudonymCache.keys().next().value);
  }
  pseudonymCache.set(cacheKey, pseudonym);
  return pseudonym;
}

/**
 * Identifier used for this user's responses, joined, and submittedQuiz
 * entries in the given session. Non-anonymous sessions keep the user id.
 */
export function getSessionParticipantId(session, userId) {
  const normalizedUserId = String(userId || '');
  if (!isAnonymousSession(session)) return normalizedUserId;
  return getAnonymousParticipantId(session?._id, normalizedUserId);
}

/**
 * Map from stored participant id back to user id for the given roster, used
 * only to deliver live events to the right sockets. Returns null for
 * non-anonymous sessions, where participant ids already are user ids. The
 * mapping is computed in memory and never persisted or sent to clients.
 */
export function buildParticipantUserIdMap(session, rosterUserIds = []) {
  if (!isAnonymousSession(session)) return null;
  const map = new Map();
  new Set((rosterUserIds || []).map((id) => String(id || '')).filter(Boolean)).forEach((userId) => {
    map.set(getAnonymousParticipantId(session._id, userId), userId);
  });
  return map;
}

export function resolveSessionParticipantUserIds(session, participantIds = [], rosterUserIds = []) {
  const normalizedParticipantIds = [...new Set(
    (participantIds || []).map((id) => String(id || '')).filter(Boolean)
  )];
  const participantUserIds = buildParticipantUserIdMap(session, rosterUserIds);
  if (!participantUserIds) return normalizedParticipantIds;
  return normalizedParticipantIds
    .map((participantId) => participantUserIds.get(participantId))
    .filter(Boolean);
}

/**
 * Stable, identity-free labels for anonymous respondents. Ordering by the
 * pseudonym avoids leaking name order or response timing.
 */
export function buildAnonymousRespondentIndex(participantIds = []) {
  const sorted = [...new Set((participantIds || []).map((id) => String(id || '')).filter(Boolean))].sort();
  return new Map(sorted.map((participantId, index) => [participantId, index + 1]));
}

export function getAnonymousRespondentKey(index) {
  return `respondent-${Number(index) || 0}`;
}

/**
 * Instructor-facing session payload for anonymous sessions: attendance is
 * reduced to counts so join/submission order cannot be correlated with
 * individual students (for example through quiz extensions).
 */
export function redactAnonymousSessionAttendance(session) {
  if (!isAnonymousSession(session) || !session) return session;
  const redacted = { ...session };
  redacted.joinedCount = Array.isArray(session.joined) ? session.joined.length : Number(session.joinedCount || 0);
  redacted.submittedCount = Array.isArray(session.submittedQuiz)
    ? session.submittedQuiz.length
    : Number(session.submittedCount || 0);
  delete redacted.joined;
  delete redacted.joinRecords;
  delete redacted.submittedQuiz;
  return redacted;
}
