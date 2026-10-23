import Course from '../models/Course.js';
import CourseChatView from '../models/CourseChatView.js';
import Post from '../models/Post.js';
import User from '../models/User.js';
import { getNormalizedTagValue, normalizeTags } from '../services/questionImportExport.js';
import { generateMeteorId } from '../utils/meteorId.js';
import { isCourseInstructorOrAdmin as isInstructorOrAdmin, isCourseMember } from '../utils/courseAccess.js';

const DEFAULT_RETENTION_DAYS = 14;
const COURSE_CHAT_READ_RATE_LIMIT = { max: 90, timeWindow: '1 minute' };
const COURSE_CHAT_WRITE_RATE_LIMIT = { max: 40, timeWindow: '1 minute' };
const COURSE_CHAT_ARCHIVE_RATE_LIMIT = { max: 30, timeWindow: '1 minute' };
const DAY_IN_MS = 24 * 60 * 60 * 1000;

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function stripHtmlToPlainText(value) {
  const input = normalizeText(value);
  let insideTag = false;
  let plain = '';

  for (const character of input) {
    if (character === '<') {
      insideTag = true;
      plain += ' ';
      continue;
    }
    if (character === '>') {
      insideTag = false;
      plain += ' ';
      continue;
    }
    if (!insideTag) plain += character;
  }

  return plain.trim().split(/\s+/).filter(Boolean).join(' ');
}

function getTimestampMs(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortCourseChatPosts(posts = []) {
  return [...posts].sort((a, b) => {
    const createdDiff = getTimestampMs(b?.createdAt) - getTimestampMs(a?.createdAt);
    if (createdDiff !== 0) return createdDiff;
    const upvoteDiff = Number(b?.upvoteCount || 0) - Number(a?.upvoteCount || 0);
    if (upvoteDiff !== 0) return upvoteDiff;
    return String(b?._id || '').localeCompare(String(a?._id || ''));
  });
}

function sortCourseChatComments(comments = []) {
  return [...comments].sort((a, b) => {
    const createdDiff = getTimestampMs(a?.createdAt) - getTimestampMs(b?.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return String(a?._id || '').localeCompare(String(b?._id || ''));
  });
}

function getChatAuthorRole(course, user) {
  return isInstructorOrAdmin(course, user) ? 'instructor' : 'student';
}

function formatUserDisplayName(user) {
  const first = normalizeText(user?.profile?.firstname || user?.firstname);
  const last = normalizeText(user?.profile?.lastname || user?.lastname);
  const email = normalizeText(user?.emails?.[0]?.address || user?.email);
  return `${first} ${last}`.trim() || email || 'Unknown User';
}

function userHasPublicChatAuthorRole(user) {
  return (user?.roles || user?.profile?.roles || []).some((role) => role === 'professor' || role === 'admin');
}

function normalizeAuthorSummary(user) {
  if (!user?._id) return null;
  return {
    _id: String(user._id),
    profile: {
      firstname: normalizeText(user?.profile?.firstname),
      lastname: normalizeText(user?.profile?.lastname),
      profileImage: normalizeText(user?.profile?.profileImage),
      profileThumbnail: normalizeText(user?.profile?.profileThumbnail),
    },
    emails: [{ address: normalizeText(user?.emails?.[0]?.address || user?.email) }],
    email: normalizeText(user?.emails?.[0]?.address || user?.email),
    displayName: formatUserDisplayName(user),
  };
}

function shouldExposeAuthorName({ includeNames, viewerUserId, authorId }) {
  // Course chat is an anonymised forum. Instructors/admins see every name via
  // includeNames; everyone else only ever sees their own name. Author roles
  // (student/instructor) are surfaced separately, so instructor posts are
  // labelled as such without revealing the individual's identity to students.
  if (includeNames) return true;
  if (!authorId) return false;
  return authorId === viewerUserId;
}

async function buildAuthorMetadataMap(posts = []) {
  const userIds = new Set();
  posts.forEach((post) => {
    if (post?.authorId) userIds.add(String(post.authorId));
    (post?.upvoteUserIds || []).forEach((userId) => {
      if (userId) userIds.add(String(userId));
    });
    (post?.comments || []).forEach((comment) => {
      if (comment?.authorId) userIds.add(String(comment.authorId));
      (comment?.upvoteUserIds || []).forEach((userId) => {
        if (userId) userIds.add(String(userId));
      });
    });
  });

  if (userIds.size === 0) return new Map();

  const users = await User.find({ _id: { $in: [...userIds] } })
    .select('_id profile emails email roles')
    .lean();

  return new Map(users.map((user) => [
    String(user._id),
    {
      displayName: formatUserDisplayName(user),
      canExposeName: userHasPublicChatAuthorRole(user),
      user: normalizeAuthorSummary(user),
    },
  ]));
}

function serializeCourseChatComment(comment, {
  postAuthorId = '',
  includeNames = false,
  viewerUserId = '',
  authorMetadataMap = new Map(),
}) {
  const authorId = normalizeText(comment?.authorId);
  const authorRole = normalizeText(comment?.authorRole) || 'student';
  const upvoteUserIds = Array.isArray(comment?.upvoteUserIds) ? comment.upvoteUserIds.map(String) : [];
  const exposeName = shouldExposeAuthorName({
    includeNames,
    viewerUserId,
    authorId,
    authorRole,
    authorMetadataMap,
  });

  return {
    _id: String(comment?._id || ''),
    body: normalizeText(comment?.body),
    bodyWysiwyg: normalizeText(comment?.bodyWysiwyg),
    createdAt: comment?.createdAt || null,
    updatedAt: comment?.updatedAt || null,
    upvoteCount: Number.isFinite(Number(comment?.upvoteCount)) ? Number(comment.upvoteCount) : upvoteUserIds.length,
    viewerHasUpvoted: upvoteUserIds.includes(viewerUserId),
    isOwnComment: authorId && authorId === viewerUserId,
    isOriginalPoster: !!postAuthorId && !!authorId && postAuthorId === authorId,
    authorRole,
    authorName: exposeName ? (authorMetadataMap.get(authorId)?.displayName || null) : null,
    ...(includeNames ? {
      authorId,
      author: authorMetadataMap.get(authorId)?.user || null,
    } : {}),
  };
}

function serializeCourseChatPost(post, {
  includeNames = false,
  viewerUserId = '',
  authorMetadataMap = new Map(),
}) {
  const authorId = normalizeText(post?.authorId);
  const authorRole = normalizeText(post?.authorRole) || 'student';
  const upvoteUserIds = Array.isArray(post?.upvoteUserIds) ? post.upvoteUserIds.map(String) : [];
  const exposeName = shouldExposeAuthorName({
    includeNames,
    viewerUserId,
    authorId,
    authorRole,
    authorMetadataMap,
  });

  return {
    _id: String(post?._id || ''),
    title: normalizeText(post?.title),
    body: normalizeText(post?.body),
    bodyWysiwyg: normalizeText(post?.bodyWysiwyg),
    tags: Array.isArray(post?.tags) ? post.tags.map(String).filter(Boolean) : [],
    createdAt: post?.createdAt || null,
    updatedAt: post?.updatedAt || null,
    archivedAt: post?.archivedAt || null,
    isArchived: !!post?.archivedAt,
    upvoteCount: Number.isFinite(Number(post?.upvoteCount)) ? Number(post.upvoteCount) : upvoteUserIds.length,
    viewerHasUpvoted: upvoteUserIds.includes(viewerUserId),
    isOwnPost: authorId && authorId === viewerUserId,
    authorRole,
    authorName: exposeName ? (authorMetadataMap.get(authorId)?.displayName || null) : null,
    ...(includeNames ? {
      authorId,
      author: authorMetadataMap.get(authorId)?.user || null,
    } : {}),
    comments: sortCourseChatComments(post?.comments || []).map((comment) => serializeCourseChatComment(comment, {
      postAuthorId: authorId,
      includeNames,
      viewerUserId,
      authorMetadataMap,
    })),
  };
}

function buildCourseChatEventDelta(post, options = {}) {
  if (!post) return { post: null };
  const serializedPost = serializeCourseChatPost(post, {
    includeNames: options.includeNames,
    viewerUserId: '',
    authorMetadataMap: options.authorMetadataMap,
  });
  delete serializedPost.viewerHasUpvoted;
  delete serializedPost.isOwnPost;
  serializedPost.comments = serializedPost.comments.map((comment) => {
    const nextComment = { ...comment };
    delete nextComment.viewerHasUpvoted;
    delete nextComment.isOwnComment;
    return nextComment;
  });
  return { post: serializedPost };
}

async function archiveExpiredCourseChatPosts(course) {
  const retentionDays = Math.max(1, Number(course?.courseChatRetentionDays) || DEFAULT_RETENTION_DAYS);
  const cutoff = new Date(Date.now() - (retentionDays * DAY_IN_MS));
  await Post.updateMany({
    scopeType: 'course',
    courseId: String(course._id),
    archivedAt: null,
    createdAt: { $lt: cutoff },
  }, {
    $set: {
      archivedAt: new Date(),
      archivedBy: 'system',
      updatedAt: new Date(),
    },
  });
}

function getAllowedCourseTagValues(course) {
  const values = new Set();
  (course?.tags || []).forEach((tag) => {
    const normalized = getNormalizedTagValue(tag);
    if (normalized) values.add(normalized);
  });
  return values;
}

function normalizeCourseChatTags(tags = [], allowedTagValues = new Set()) {
  const normalized = normalizeTags(tags).map((tag) => normalizeText(tag?.value || tag?.label || tag)).filter(Boolean);
  const unique = [...new Set(normalized)];
  const hasInvalid = unique.some((tag) => !allowedTagValues.has(getNormalizedTagValue(tag)));
  if (hasInvalid) {
    const err = new Error('Course chat tags must be selected from the course tags');
    err.statusCode = 400;
    throw err;
  }
  return unique;
}

function parseBooleanParam(value) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeText(value).toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

async function loadCourseChatView(courseId, userId) {
  if (!courseId || !userId) return null;
  return CourseChatView.findOne({
    courseId: String(courseId),
    userId: String(userId),
  })
    .select('lastViewedAt')
    .lean();
}

async function markCourseChatViewed(courseId, userId) {
  if (!courseId || !userId) return;
  await CourseChatView.findOneAndUpdate({
    courseId: String(courseId),
    userId: String(userId),
  }, {
    $set: {
      lastViewedAt: new Date(),
    },
  }, {
    upsert: true,
  });
}

async function countUnseenCourseChatMessages(courseId, userId, lastViewedAt) {
  if (!courseId || !userId) return 0;

  const posts = await Post.find({
    scopeType: 'course',
    courseId: String(courseId),
    archivedAt: null,
  })
    .select('authorId createdAt comments')
    .lean();

  const cutoff = lastViewedAt ? getTimestampMs(lastViewedAt) : 0;
  return posts.reduce((count, post) => {
    let nextCount = count;
    if (
      String(post?.authorId || '') !== String(userId)
      && getTimestampMs(post?.createdAt) > cutoff
    ) {
      nextCount += 1;
    }

    nextCount += (post?.comments || []).reduce((commentCount, comment) => (
      String(comment?.authorId || '') !== String(userId)
      && getTimestampMs(comment?.createdAt) > cutoff
        ? commentCount + 1
        : commentCount
    ), 0);

    return nextCount;
  }, 0);
}

async function loadCourseChatContext(courseId) {
  const course = await Course.findById(courseId)
    .select('students instructors tags courseChatEnabled courseChatRetentionDays name deptCode courseNumber section semester')
    .lean();
  return { course };
}

function sendToUsersById(app, userIds, event, payload) {
  if (typeof app.wsSendToUsers !== 'function') return;
  const normalizedUserIds = [...new Set((userIds || []).map((userId) => String(userId)).filter(Boolean))];
  if (normalizedUserIds.length === 0) return;
  app.wsSendToUsers(normalizedUserIds, event, {
    emittedAt: payload?.emittedAt || new Date().toISOString(),
    ...payload,
  });
}

export async function notifyCourseChatUpdated(app, course, payload = {}) {
  const post = payload?.post || null;
  const authorMetadataMap = post ? await buildAuthorMetadataMap([post]) : new Map();
  const basePayload = {
    courseId: String(course._id),
    postId: String(payload?.postId || post?._id || ''),
    changeType: normalizeText(payload?.changeType),
  };

  sendToUsersById(app, course.instructors || [], 'course:chat-updated', {
    ...basePayload,
    ...buildCourseChatEventDelta(post, {
      includeNames: true,
      authorMetadataMap,
    }),
  });
  sendToUsersById(app, course.students || [], 'course:chat-updated', {
    ...basePayload,
    ...buildCourseChatEventDelta(post, {
      includeNames: false,
      authorMetadataMap,
    }),
  });
}

async function loadCourseChatPayload({ course, request, includeArchived = false }) {
  await archiveExpiredCourseChatPosts(course);
  const viewerUserId = String(request.user?.userId || '');
  const includeNames = isInstructorOrAdmin(course, request.user);
  const canIncludeArchived = includeNames && includeArchived;
  const posts = await Post.find({
    scopeType: 'course',
    courseId: String(course._id),
    ...(canIncludeArchived ? {} : { archivedAt: null }),
  })
    .select('authorId authorRole title body bodyWysiwyg tags upvoteUserIds upvoteCount comments archivedAt createdAt updatedAt')
    .lean();

  const visiblePosts = sortCourseChatPosts(posts);
  const authorMetadataMap = await buildAuthorMetadataMap(visiblePosts);

  return {
    enabled: !!course?.courseChatEnabled,
    retentionDays: Math.max(1, Number(course?.courseChatRetentionDays) || DEFAULT_RETENTION_DAYS),
    canPost: !!course?.courseChatEnabled,
    canComment: !!course?.courseChatEnabled,
    canVote: !!course?.courseChatEnabled && !includeNames,
    canDeleteOwnPost: !!course?.courseChatEnabled,
    canDeleteOwnComment: !!course?.courseChatEnabled,
    canDeleteAnyPost: includeNames,
    canDeleteAnyComment: includeNames,
    canArchive: includeNames,
    canUnarchive: includeNames,
    canViewNames: includeNames,
    availableTags: normalizeTags(course?.tags || []).map((tag) => ({
      value: normalizeText(tag?.value || tag?.label || tag),
      label: normalizeText(tag?.label || tag?.value || tag),
      className: normalizeText(tag?.className),
    })).filter((tag) => tag.value),
    posts: visiblePosts.map((post) => serializeCourseChatPost(post, {
      includeNames,
      viewerUserId,
      authorMetadataMap,
    })),
  };
}

export default async function courseChatRoutes(app) {
  const { authenticate } = app;
  const courseChatReadRateLimitPreHandler = app.rateLimit({
    ...COURSE_CHAT_READ_RATE_LIMIT,
  });
  const courseChatWriteRateLimitPreHandler = app.rateLimit({
    ...COURSE_CHAT_WRITE_RATE_LIMIT,
  });
  const courseChatArchiveRateLimitPreHandler = app.rateLimit({
    ...COURSE_CHAT_ARCHIVE_RATE_LIMIT,
  });

  app.get('/courses/:id/chat', {
    preHandler: [authenticate, courseChatReadRateLimitPreHandler],
    rateLimit: COURSE_CHAT_READ_RATE_LIMIT,
    config: { rateLimit: COURSE_CHAT_READ_RATE_LIMIT },
  }, async (request, reply) => {
    const { course } = await loadCourseChatContext(request.params.id);
    if (!course) {
      return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    }
    if (!isCourseMember(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
    }
    if (!course.courseChatEnabled) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Course chat is not available' });
    }

    const payload = await loadCourseChatPayload({
      course,
      request,
      includeArchived: parseBooleanParam(request.query?.includeArchived),
    });
    await markCourseChatViewed(course._id, request.user?.userId);
    return payload;
  });

  app.get('/courses/:id/chat/summary', {
    preHandler: [authenticate, courseChatReadRateLimitPreHandler],
    rateLimit: COURSE_CHAT_READ_RATE_LIMIT,
    config: { rateLimit: COURSE_CHAT_READ_RATE_LIMIT },
  }, async (request, reply) => {
    const { course } = await loadCourseChatContext(request.params.id);
    if (!course) {
      return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    }
    if (!isCourseMember(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
    }
    if (!course.courseChatEnabled) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Course chat is not available' });
    }

    await archiveExpiredCourseChatPosts(course);
    const view = await loadCourseChatView(course._id, request.user?.userId);
    const unseenCount = await countUnseenCourseChatMessages(
      course._id,
      request.user?.userId,
      view?.lastViewedAt || null
    );

    return { unseenCount };
  });

  app.post('/courses/:id/chat/posts', {
    preHandler: [authenticate, courseChatWriteRateLimitPreHandler],
    rateLimit: COURSE_CHAT_WRITE_RATE_LIMIT,
    config: { rateLimit: COURSE_CHAT_WRITE_RATE_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 160 },
          body: { type: 'string' },
          bodyWysiwyg: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { course } = await loadCourseChatContext(request.params.id);
    if (!course) {
      return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    }
    if (!isCourseMember(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
    }
    if (!course.courseChatEnabled) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Course chat is not available' });
    }

    await archiveExpiredCourseChatPosts(course);
    const title = normalizeText(request.body?.title);
    const bodyWysiwyg = normalizeText(request.body?.bodyWysiwyg);
    const body = normalizeText(request.body?.body || stripHtmlToPlainText(bodyWysiwyg));
    if (!title) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Post title is required' });
    }
    if (!body && !bodyWysiwyg) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Post content is required' });
    }

    let tags = [];
    try {
      tags = normalizeCourseChatTags(request.body?.tags || [], getAllowedCourseTagValues(course));
    } catch (err) {
      return reply.code(err.statusCode || 400).send({ error: 'Bad Request', message: err.message });
    }

    const created = await Post.create({
      scopeType: 'course',
      courseId: String(course._id),
      sessionId: '',
      authorId: String(request.user.userId),
      authorRole: getChatAuthorRole(course, request.user),
      title,
      body,
      bodyWysiwyg,
      tags,
      isQuickPost: false,
      quickPostQuestionNumber: null,
      upvoteUserIds: [],
      upvoteCount: 0,
      comments: [],
      dismissedAt: null,
      dismissedBy: '',
      archivedAt: null,
      archivedBy: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await notifyCourseChatUpdated(app, course, {
      changeType: 'post-created',
      postId: String(created._id),
      post: created.toObject ? created.toObject() : { ...created },
    });

    return reply.code(201).send({ success: true, postId: String(created._id) });
  });

  app.patch('/courses/:id/chat/posts/:postId/vote', {
    preHandler: [authenticate, courseChatWriteRateLimitPreHandler],
    rateLimit: COURSE_CHAT_WRITE_RATE_LIMIT,
    config: { rateLimit: COURSE_CHAT_WRITE_RATE_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['upvoted'],
        properties: {
          upvoted: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { course } = await loadCourseChatContext(request.params.id);
    if (!course) {
      return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    }
    if (!isCourseMember(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
    }
    if (!course.courseChatEnabled || isInstructorOrAdmin(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Voting is not available' });
    }

    await archiveExpiredCourseChatPosts(course);
    const post = await Post.findOne({
      _id: request.params.postId,
      scopeType: 'course',
      courseId: String(course._id),
      archivedAt: null,
    }).lean();
    if (!post) {
      return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
    }
    if (String(post.authorId || '') === String(request.user.userId || '')) {
      return reply.code(400).send({ error: 'Bad Request', message: 'You cannot vote on your own post' });
    }

    const userId = String(request.user.userId);
    const upvoteUserIds = Array.isArray(post.upvoteUserIds) ? post.upvoteUserIds.map(String) : [];
    const hasUpvoted = upvoteUserIds.includes(userId);
    const nextUpvoteUserIds = request.body.upvoted
      ? [...new Set(hasUpvoted ? upvoteUserIds : [...upvoteUserIds, userId])]
      : upvoteUserIds.filter((entry) => entry !== userId);

    const updated = await Post.findByIdAndUpdate(post._id, {
      $set: {
        upvoteUserIds: nextUpvoteUserIds,
        upvoteCount: nextUpvoteUserIds.length,
        updatedAt: new Date(),
      },
    }, { returnDocument: 'after' }).lean();

    await notifyCourseChatUpdated(app, course, {
      changeType: 'post-voted',
      postId: String(post._id),
      post: updated,
    });

    return {
      success: true,
      postId: String(post._id),
      viewerHasUpvoted: !!request.body.upvoted,
      upvoteCount: Number(updated?.upvoteCount || 0),
    };
  });

  app.patch('/courses/:id/chat/posts/:postId', {
    preHandler: [authenticate, courseChatWriteRateLimitPreHandler],
    schema: { body: { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 160 }, body: { type: 'string' }, bodyWysiwyg: { type: 'string' } }, additionalProperties: false } },
  }, async (request, reply) => {
    const { course } = await loadCourseChatContext(request.params.id);
    if (!course) return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    if (!isCourseMember(course, request.user) || !course.courseChatEnabled) return reply.code(403).send({ error: 'Forbidden', message: 'Course chat is not available' });
    const post = await Post.findOne({ _id: request.params.postId, scopeType: 'course', courseId: String(course._id), archivedAt: null }).lean();
    if (!post) return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
    if (String(post.authorId || '') !== String(request.user.userId || '')) return reply.code(403).send({ error: 'Forbidden', message: 'You can only edit your own posts' });
    const bodyWysiwyg = normalizeText(request.body?.bodyWysiwyg);
    const body = normalizeText(request.body?.body || stripHtmlToPlainText(bodyWysiwyg));
    if (!body && !bodyWysiwyg) return reply.code(400).send({ error: 'Bad Request', message: 'Post content is required' });
    const updated = await Post.findByIdAndUpdate(post._id, { $set: { title: normalizeText(request.body?.title || post.title), body, bodyWysiwyg, updatedAt: new Date() } }, { returnDocument: 'after' }).lean();
    await notifyCourseChatUpdated(app, course, { changeType: 'post-edited', postId: String(post._id), post: updated });
    return { success: true, postId: String(post._id) };
  });

  app.post('/courses/:id/chat/posts/:postId/comments', {
    preHandler: [authenticate, courseChatWriteRateLimitPreHandler],
    rateLimit: COURSE_CHAT_WRITE_RATE_LIMIT,
    config: { rateLimit: COURSE_CHAT_WRITE_RATE_LIMIT },
    schema: {
      body: {
        type: 'object',
        properties: {
          body: { type: 'string' },
          bodyWysiwyg: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { course } = await loadCourseChatContext(request.params.id);
    if (!course) {
      return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    }
    if (!isCourseMember(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
    }
    if (!course.courseChatEnabled) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Comments are not available' });
    }

    await archiveExpiredCourseChatPosts(course);
    const post = await Post.findOne({
      _id: request.params.postId,
      scopeType: 'course',
      courseId: String(course._id),
      archivedAt: null,
    }).lean();
    if (!post) {
      return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
    }

    const bodyWysiwyg = normalizeText(request.body?.bodyWysiwyg);
    const body = normalizeText(request.body?.body || stripHtmlToPlainText(bodyWysiwyg));
    if (!body && !bodyWysiwyg) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Comment content is required' });
    }

    const comment = {
      _id: generateMeteorId(),
      authorId: String(request.user.userId),
      authorRole: getChatAuthorRole(course, request.user),
      body,
      bodyWysiwyg,
      upvoteUserIds: [],
      upvoteCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const updated = await Post.findByIdAndUpdate(post._id, {
      $push: { comments: comment },
      $set: { updatedAt: new Date() },
    }, { returnDocument: 'after' }).lean();

    await notifyCourseChatUpdated(app, course, {
      changeType: 'comment-added',
      postId: String(post._id),
      post: updated,
    });

    return { success: true, postId: String(post._id), commentId: String(comment._id) };
  });

  app.patch('/courses/:id/chat/posts/:postId/comments/:commentId/vote', {
    preHandler: [authenticate, courseChatWriteRateLimitPreHandler],
    rateLimit: COURSE_CHAT_WRITE_RATE_LIMIT,
    config: { rateLimit: COURSE_CHAT_WRITE_RATE_LIMIT },
    schema: {
      body: {
        type: 'object',
        required: ['upvoted'],
        properties: {
          upvoted: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { course } = await loadCourseChatContext(request.params.id);
    if (!course) {
      return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    }
    if (!isCourseMember(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
    }
    if (!course.courseChatEnabled || isInstructorOrAdmin(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Voting is not available' });
    }

    await archiveExpiredCourseChatPosts(course);
    const post = await Post.findOne({
      _id: request.params.postId,
      scopeType: 'course',
      courseId: String(course._id),
      archivedAt: null,
    }).lean();
    if (!post) {
      return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
    }

    const comment = (post.comments || []).find((entry) => String(entry?._id || '') === String(request.params.commentId || ''));
    if (!comment) {
      return reply.code(404).send({ error: 'Not Found', message: 'Comment not found' });
    }
    if (String(comment.authorId || '') === String(request.user.userId || '')) {
      return reply.code(400).send({ error: 'Bad Request', message: 'You cannot vote on your own comment' });
    }

    const userId = String(request.user.userId);
    const upvoteUserIds = Array.isArray(comment.upvoteUserIds) ? comment.upvoteUserIds.map(String) : [];
    const hasUpvoted = upvoteUserIds.includes(userId);
    const nextUpvoteUserIds = request.body.upvoted
      ? [...new Set(hasUpvoted ? upvoteUserIds : [...upvoteUserIds, userId])]
      : upvoteUserIds.filter((entry) => entry !== userId);

    const updatedComments = (post.comments || []).map((entry) => (
      String(entry?._id || '') === String(comment._id)
        ? {
          ...entry,
          upvoteUserIds: nextUpvoteUserIds,
          upvoteCount: nextUpvoteUserIds.length,
          updatedAt: new Date(),
        }
        : entry
    ));

    const updated = await Post.findByIdAndUpdate(post._id, {
      $set: {
        comments: updatedComments,
        updatedAt: new Date(),
      },
    }, { returnDocument: 'after' }).lean();

    await notifyCourseChatUpdated(app, course, {
      changeType: 'comment-voted',
      postId: String(post._id),
      post: updated,
    });

    return {
      success: true,
      postId: String(post._id),
      commentId: String(comment._id),
      viewerHasUpvoted: !!request.body.upvoted,
      upvoteCount: nextUpvoteUserIds.length,
    };
  });

  app.patch('/courses/:id/chat/posts/:postId/comments/:commentId', {
    preHandler: [authenticate, courseChatWriteRateLimitPreHandler],
    schema: { body: { type: 'object', properties: { body: { type: 'string' }, bodyWysiwyg: { type: 'string' } }, additionalProperties: false } },
  }, async (request, reply) => {
    const { course } = await loadCourseChatContext(request.params.id);
    if (!course) return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    if (!isCourseMember(course, request.user) || !course.courseChatEnabled) return reply.code(403).send({ error: 'Forbidden', message: 'Course chat is not available' });
    const post = await Post.findOne({ _id: request.params.postId, scopeType: 'course', courseId: String(course._id), archivedAt: null }).lean();
    if (!post) return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
    const comment = (post.comments || []).find((entry) => String(entry?._id) === String(request.params.commentId));
    if (!comment) return reply.code(404).send({ error: 'Not Found', message: 'Comment not found' });
    if (String(comment.authorId || '') !== String(request.user.userId || '')) return reply.code(403).send({ error: 'Forbidden', message: 'You can only edit your own comments' });
    const bodyWysiwyg = normalizeText(request.body?.bodyWysiwyg);
    const body = normalizeText(request.body?.body || stripHtmlToPlainText(bodyWysiwyg));
    if (!body && !bodyWysiwyg) return reply.code(400).send({ error: 'Bad Request', message: 'Comment content is required' });
    const comments = post.comments.map((entry) => String(entry?._id) === String(comment._id) ? { ...entry, body, bodyWysiwyg, updatedAt: new Date() } : entry);
    const updated = await Post.findByIdAndUpdate(post._id, { $set: { comments, updatedAt: new Date() } }, { returnDocument: 'after' }).lean();
    await notifyCourseChatUpdated(app, course, { changeType: 'comment-edited', postId: String(post._id), post: updated });
    return { success: true, postId: String(post._id), commentId: String(comment._id) };
  });

  app.patch('/courses/:id/chat/posts/:postId/archive', {
    preHandler: [authenticate, courseChatArchiveRateLimitPreHandler],
    rateLimit: COURSE_CHAT_ARCHIVE_RATE_LIMIT,
    config: { rateLimit: COURSE_CHAT_ARCHIVE_RATE_LIMIT },
  }, async (request, reply) => {
    const { course } = await loadCourseChatContext(request.params.id);
    if (!course) {
      return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    }
    if (!isInstructorOrAdmin(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
    }

    const post = await Post.findOne({
      _id: request.params.postId,
      scopeType: 'course',
      courseId: String(course._id),
      archivedAt: null,
    }).lean();
    if (!post) {
      return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
    }

    await Post.findByIdAndUpdate(post._id, {
      $set: {
        archivedAt: new Date(),
        archivedBy: String(request.user.userId),
        updatedAt: new Date(),
      },
    });

    await notifyCourseChatUpdated(app, course, {
      changeType: 'post-archived',
      postId: String(post._id),
      post: null,
    });

    return { success: true, postId: String(post._id) };
  });

  app.patch('/courses/:id/chat/posts/:postId/unarchive', {
    preHandler: [authenticate, courseChatArchiveRateLimitPreHandler],
    rateLimit: COURSE_CHAT_ARCHIVE_RATE_LIMIT,
    config: { rateLimit: COURSE_CHAT_ARCHIVE_RATE_LIMIT },
  }, async (request, reply) => {
    const { course } = await loadCourseChatContext(request.params.id);
    if (!course) {
      return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    }
    if (!isInstructorOrAdmin(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Insufficient permissions' });
    }

    const post = await Post.findOne({
      _id: request.params.postId,
      scopeType: 'course',
      courseId: String(course._id),
      archivedAt: { $ne: null },
    }).lean();
    if (!post) {
      return reply.code(404).send({ error: 'Not Found', message: 'Archived post not found' });
    }

    const updated = await Post.findByIdAndUpdate(post._id, {
      $set: {
        archivedAt: null,
        archivedBy: '',
        updatedAt: new Date(),
      },
    }, { returnDocument: 'after' }).lean();

    await notifyCourseChatUpdated(app, course, {
      changeType: 'post-unarchived',
      postId: String(post._id),
      post: updated,
    });

    return { success: true, postId: String(post._id) };
  });

  app.delete('/courses/:id/chat/posts/:postId', {
    preHandler: [authenticate, courseChatWriteRateLimitPreHandler],
    rateLimit: COURSE_CHAT_WRITE_RATE_LIMIT,
    config: { rateLimit: COURSE_CHAT_WRITE_RATE_LIMIT },
  }, async (request, reply) => {
    const { course } = await loadCourseChatContext(request.params.id);
    if (!course) {
      return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    }
    if (!isCourseMember(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
    }

    const isModerator = isInstructorOrAdmin(course, request.user);
    const post = await Post.findOne({
      _id: request.params.postId,
      scopeType: 'course',
      courseId: String(course._id),
      archivedAt: null,
    }).lean();
    if (!post) {
      return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
    }
    if (!isModerator && String(post.authorId || '') !== String(request.user.userId || '')) {
      return reply.code(403).send({ error: 'Forbidden', message: 'You can only delete your own posts' });
    }

    await Post.deleteOne({ _id: String(post._id) });
    await notifyCourseChatUpdated(app, course, {
      changeType: 'post-deleted',
      postId: String(post._id),
      post: null,
    });

    return { success: true };
  });

  app.delete('/courses/:id/chat/posts/:postId/comments/:commentId', {
    preHandler: [authenticate, courseChatWriteRateLimitPreHandler],
    rateLimit: COURSE_CHAT_WRITE_RATE_LIMIT,
    config: { rateLimit: COURSE_CHAT_WRITE_RATE_LIMIT },
  }, async (request, reply) => {
    const { course } = await loadCourseChatContext(request.params.id);
    if (!course) {
      return reply.code(404).send({ error: 'Not Found', message: 'Course not found' });
    }
    if (!isCourseMember(course, request.user)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Not a member of this course' });
    }

    const isModerator = isInstructorOrAdmin(course, request.user);
    const post = await Post.findOne({
      _id: request.params.postId,
      scopeType: 'course',
      courseId: String(course._id),
      archivedAt: null,
    }).lean();
    if (!post) {
      return reply.code(404).send({ error: 'Not Found', message: 'Post not found' });
    }

    const comment = (post.comments || []).find((entry) => String(entry?._id || '') === String(request.params.commentId || ''));
    if (!comment) {
      return reply.code(404).send({ error: 'Not Found', message: 'Comment not found' });
    }
    if (!isModerator && String(comment.authorId || '') !== String(request.user.userId || '')) {
      return reply.code(403).send({ error: 'Forbidden', message: 'You can only delete your own comments' });
    }

    const updated = await Post.findByIdAndUpdate(post._id, {
      $pull: { comments: { _id: String(comment._id) } },
      $set: { updatedAt: new Date() },
    }, { returnDocument: 'after' }).lean();

    await notifyCourseChatUpdated(app, course, {
      changeType: 'comment-deleted',
      postId: String(post._id),
      post: updated,
    });

    return { success: true, postId: String(post._id), commentId: String(comment._id) };
  });
}
