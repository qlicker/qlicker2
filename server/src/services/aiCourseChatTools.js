import AiConversation from '../models/AiConversation.js';
import AiCourseChatDraft from '../models/AiCourseChatDraft.js';
import Course from '../models/Course.js';
import Post from '../models/Post.js';
import User from '../models/User.js';
import { getNormalizedTagValue, normalizeTags } from './questionImportExport.js';

const DEFAULT_RETENTION_DAYS = 14;
const DAY_IN_MS = 24 * 60 * 60 * 1000;

function normalizedText(value) {
  return String(value ?? '').trim();
}

function userDisplayName(user) {
  const first = normalizedText(user?.profile?.firstname);
  const last = normalizedText(user?.profile?.lastname);
  const email = normalizedText(user?.emails?.[0]?.address || user?.email);
  return `${first} ${last}`.trim() || email || 'Unknown User';
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function truncatedText(value, maxCharacters) {
  const text = normalizedText(value);
  return {
    text: text.length > maxCharacters ? `${text.slice(0, maxCharacters)}…` : text,
    truncated: text.length > maxCharacters,
  };
}

async function requireCourseChat(courseId) {
  const course = await Course.findById(String(courseId))
    .select('name tags courseChatEnabled courseChatRetentionDays')
    .lean();
  if (!course) throw new Error('Course not found');
  if (!course.courseChatEnabled) throw new Error('Course chat is not available');
  return course;
}

async function archiveExpiredPosts(course) {
  const retentionDays = Math.max(1, Number(course.courseChatRetentionDays) || DEFAULT_RETENTION_DAYS);
  const cutoff = new Date(Date.now() - (retentionDays * DAY_IN_MS));
  await Post.updateMany({
    scopeType: 'course',
    courseId: String(course._id),
    archivedAt: null,
    createdAt: { $lt: cutoff },
  }, {
    $set: { archivedAt: new Date(), archivedBy: 'system', updatedAt: new Date() },
  });
}

async function authorNamesForPosts(posts) {
  const authorIds = new Set();
  posts.forEach((post) => {
    if (post.authorId) authorIds.add(String(post.authorId));
    (post.comments || []).forEach((comment) => {
      if (comment.authorId) authorIds.add(String(comment.authorId));
    });
  });
  if (authorIds.size === 0) return new Map();
  const users = await User.find({ _id: { $in: [...authorIds] } }).select('_id profile emails email').lean();
  return new Map(users.map((user) => [String(user._id), userDisplayName(user)]));
}

function serializeTopic(post, authorNames, bodyLimit = 1000) {
  const body = truncatedText(post.body, bodyLimit);
  return {
    topic_id: String(post._id),
    title: normalizedText(post.title),
    body: body.text,
    body_truncated: body.truncated,
    tags: (post.tags || []).map(String),
    author_name: authorNames.get(String(post.authorId)) || 'Unknown User',
    author_role: post.authorRole || 'student',
    comment_count: (post.comments || []).length,
    upvote_count: Number(post.upvoteCount || 0),
    created_at: post.createdAt || null,
    updated_at: post.updatedAt || null,
    archived: !!post.archivedAt,
  };
}

export async function listCourseChatTopics(courseId, {
  query = '',
  includeArchived = false,
  offset = 0,
  limit = 20,
} = {}) {
  const course = await requireCourseChat(courseId);
  await archiveExpiredPosts(course);
  const boundedOffset = Math.max(0, Number(offset) || 0);
  const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 20));
  const filter = {
    scopeType: 'course',
    courseId: String(course._id),
    ...(includeArchived ? {} : { archivedAt: null }),
  };
  if (normalizedText(query)) {
    const pattern = escapeRegex(query);
    filter.$or = [
      { title: { $regex: pattern, $options: 'i' } },
      { body: { $regex: pattern, $options: 'i' } },
      { 'comments.body': { $regex: pattern, $options: 'i' } },
    ];
  }
  const [total, posts] = await Promise.all([
    Post.countDocuments(filter),
    Post.find(filter)
      .select('authorId authorRole title body tags upvoteCount comments archivedAt createdAt updatedAt')
      .sort({ createdAt: -1 })
      .skip(boundedOffset)
      .limit(boundedLimit)
      .lean(),
  ]);
  const authorNames = await authorNamesForPosts(posts);
  return {
    course_name: course.name,
    topic_count: total,
    offset: boundedOffset,
    returned_count: posts.length,
    next_offset: boundedOffset + posts.length < total ? boundedOffset + posts.length : null,
    topics: posts.map((post) => serializeTopic(post, authorNames)),
  };
}

export async function getCourseChatTopic(courseId, topicId, { commentOffset = 0, commentLimit = 30 } = {}) {
  const course = await requireCourseChat(courseId);
  await archiveExpiredPosts(course);
  const post = await Post.findOne({
    _id: String(topicId),
    scopeType: 'course',
    courseId: String(course._id),
  }).select('authorId authorRole title body tags upvoteCount comments archivedAt createdAt updatedAt').lean();
  if (!post) throw new Error('Course chat topic not found');
  const boundedOffset = Math.max(0, Number(commentOffset) || 0);
  const boundedLimit = Math.max(1, Math.min(20, Number(commentLimit) || 20));
  const comments = [...(post.comments || [])]
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  const page = comments.slice(boundedOffset, boundedOffset + boundedLimit);
  const authorNames = await authorNamesForPosts([{ ...post, comments: page }]);
  return {
    topic: serializeTopic(post, authorNames, 8000),
    comment_count: comments.length,
    comment_offset: boundedOffset,
    returned_comment_count: page.length,
    next_comment_offset: boundedOffset + page.length < comments.length ? boundedOffset + page.length : null,
    comments: page.map((comment) => {
      const body = truncatedText(comment.body, 3000);
      return {
        comment_id: String(comment._id),
        body: body.text,
        body_truncated: body.truncated,
        author_name: authorNames.get(String(comment.authorId)) || 'Unknown User',
        author_role: comment.authorRole || 'student',
        upvote_count: Number(comment.upvoteCount || 0),
        created_at: comment.createdAt || null,
        updated_at: comment.updatedAt || null,
      };
    }),
  };
}

function normalizeDraftTags(course, tags = []) {
  const courseTags = new Map();
  normalizeTags(course.tags || []).forEach((tag) => {
    courseTags.set(getNormalizedTagValue(tag), normalizedText(tag.value || tag.label));
  });
  const requested = [...new Set((tags || []).map((tag) => getNormalizedTagValue(tag)).filter(Boolean))];
  const invalid = requested.filter((tag) => !courseTags.has(tag));
  if (invalid.length) throw new Error(`Course chat tags must be selected from the course topics: ${invalid.join(', ')}`);
  return requested.map((tag) => courseTags.get(tag));
}

export function courseChatApprovalPhrase(draftId) {
  return `Approve course chat draft ${String(draftId)}`;
}

export async function draftCourseChatMessage({
  courseId,
  conversationId,
  userId,
  sourceMessageId,
  type,
  targetPostId = '',
  title = '',
  body,
  tags = [],
}) {
  const course = await requireCourseChat(courseId);
  const conversation = await AiConversation.exists({
    _id: String(conversationId),
    courseId: String(course._id),
    ownerId: String(userId),
    messages: { $elemMatch: { _id: String(sourceMessageId), role: 'user' } },
  });
  if (!conversation) throw new Error('AI conversation context was not found');
  const normalizedType = type === 'response' ? 'response' : 'topic';
  const normalizedBody = normalizedText(body);
  const normalizedTitle = normalizedText(title);
  if (!normalizedBody) throw new Error('Course chat draft content is required');
  if (normalizedBody.length > 20_000) throw new Error('Course chat draft content cannot exceed 20,000 characters');
  if (normalizedType === 'topic' && !normalizedTitle) throw new Error('A new course chat topic requires a title');
  if (normalizedTitle.length > 160) throw new Error('Course chat topic titles cannot exceed 160 characters');

  let targetTitle = '';
  if (normalizedType === 'response') {
    if (!normalizedText(targetPostId)) throw new Error('A response draft requires a target topic ID');
    const target = await Post.findOne({
      _id: String(targetPostId),
      scopeType: 'course',
      courseId: String(course._id),
      archivedAt: null,
    }).select('title').lean();
    if (!target) throw new Error('The target course chat topic was not found or is archived');
    targetTitle = normalizedText(target.title);
  }

  const draft = await AiCourseChatDraft.create({
    courseId: String(course._id),
    conversationId: String(conversationId),
    ownerId: String(userId),
    sourceMessageId: String(sourceMessageId),
    type: normalizedType,
    targetPostId: normalizedType === 'response' ? String(targetPostId) : '',
    targetTitle,
    title: normalizedType === 'topic' ? normalizedTitle : '',
    body: normalizedBody,
    tags: normalizedType === 'topic' ? normalizeDraftTags(course, tags) : [],
  });
  const approvalPhrase = courseChatApprovalPhrase(draft._id);
  return {
    course_chat_draft: {
      draft_id: String(draft._id),
      status: draft.status,
      type: draft.type,
      target_topic_id: draft.targetPostId,
      target_title: draft.targetTitle,
      title: draft.title,
      body: draft.body,
      tags: draft.tags,
      approval_phrase: approvalPhrase,
    },
    posted: false,
    message: `This draft has not been posted. The instructor must review it and reply exactly: ${approvalPhrase}`,
  };
}

async function requireApprovalContext({ draftId, courseId, conversationId, userId, currentUserMessageId }) {
  const [draft, conversation, course] = await Promise.all([
    AiCourseChatDraft.findOne({
      _id: String(draftId),
      courseId: String(courseId),
      conversationId: String(conversationId),
      ownerId: String(userId),
    }),
    AiConversation.findOne({
      _id: String(conversationId),
      courseId: String(courseId),
      ownerId: String(userId),
    }).select('messages').lean(),
    requireCourseChat(courseId),
  ]);
  if (!draft) throw new Error('Course chat draft not found in this conversation');
  const approvalMessage = (conversation?.messages || []).find((message) => String(message._id) === String(currentUserMessageId));
  if (!approvalMessage || approvalMessage.role !== 'user') throw new Error('The current instructor approval message was not found');
  if (String(draft.sourceMessageId) === String(currentUserMessageId)) {
    throw new Error('A course chat draft cannot be approved in the same turn in which it was created');
  }
  if (normalizedText(approvalMessage.content) !== courseChatApprovalPhrase(draft._id)) {
    throw new Error(`Publishing requires the instructor's exact approval phrase: ${courseChatApprovalPhrase(draft._id)}`);
  }
  return { draft, course };
}

async function claimDraft(draft) {
  if (draft.status === 'published' || draft.status === 'publishing') return draft;
  const claimed = await AiCourseChatDraft.findOneAndUpdate(
    { _id: draft._id, status: 'awaiting_approval' },
    { $set: { status: 'publishing' } },
    { returnDocument: 'after' }
  );
  if (!claimed) throw new Error('Course chat draft is no longer awaiting approval');
  return claimed;
}

async function publishTopic(draft, userId) {
  let created = false;
  const postFilter = { _id: draft._id, scopeType: 'course', courseId: String(draft.courseId) };
  let post = await Post.findOne(postFilter).lean();
  if (!post) {
    try {
      post = (await Post.create({
        _id: String(draft._id),
        scopeType: 'course',
        courseId: String(draft.courseId),
        sessionId: '',
        authorId: String(userId),
        authorRole: 'instructor',
        title: draft.title,
        body: draft.body,
        bodyWysiwyg: '',
        tags: draft.tags,
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
      })).toObject();
      created = true;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      post = await Post.findOne(postFilter).lean();
    }
  }
  if (!post) throw new Error('The approved course chat topic could not be published');
  return { post, created, postId: String(post._id), commentId: '' };
}

async function publishResponse(draft, userId) {
  const comment = {
    _id: String(draft._id),
    authorId: String(userId),
    authorRole: 'instructor',
    body: draft.body,
    bodyWysiwyg: '',
    upvoteUserIds: [],
    upvoteCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let post = await Post.findOneAndUpdate({
    _id: String(draft.targetPostId),
    scopeType: 'course',
    courseId: String(draft.courseId),
    archivedAt: null,
    'comments._id': { $ne: String(draft._id) },
  }, {
    $push: { comments: comment },
    $set: { updatedAt: new Date() },
  }, { returnDocument: 'after' }).lean();
  let created = true;
  if (!post) {
    post = await Post.findOne({
      _id: String(draft.targetPostId),
      scopeType: 'course',
      courseId: String(draft.courseId),
      archivedAt: null,
      'comments._id': String(draft._id),
    }).lean();
    created = false;
  }
  if (!post) throw new Error('The target course chat topic was removed or archived before approval');
  return { post, created, postId: String(post._id), commentId: String(draft._id) };
}

export async function publishCourseChatDraft({
  draftId,
  courseId,
  conversationId,
  userId,
  currentUserMessageId,
  onPublished,
}) {
  const context = await requireApprovalContext({ draftId, courseId, conversationId, userId, currentUserMessageId });
  const draft = await claimDraft(context.draft);
  const publication = draft.type === 'response'
    ? await publishResponse(draft, userId)
    : await publishTopic(draft, userId);
  const publishedAt = draft.publishedAt || new Date();
  await AiCourseChatDraft.findByIdAndUpdate(draft._id, {
    $set: {
      status: 'published',
      publishedPostId: publication.postId,
      publishedCommentId: publication.commentId,
      publishedAt,
    },
  });
  let notificationWarning = '';
  if (publication.created && onPublished) {
    try {
      await onPublished({
        changeType: draft.type === 'response' ? 'comment-added' : 'post-created',
        postId: publication.postId,
        post: publication.post,
      });
    } catch (error) {
      notificationWarning = error?.message || 'The live course chat notification could not be sent';
    }
  }
  return {
    course_chat_publication: {
      draft_id: String(draft._id),
      type: draft.type,
      topic_id: publication.postId,
      comment_id: publication.commentId,
      published_at: publishedAt,
    },
    posted: true,
    ...(notificationWarning ? { warning: notificationWarning } : {}),
  };
}
