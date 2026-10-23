import AiActionDraft from '../models/AiActionDraft.js';
import AiConversation from '../models/AiConversation.js';
import {
  createCourseQuestion,
  createCourseSession,
  editCourseQuestion,
  editCourseSession,
} from './aiCourseAuthoringTools.js';

export function courseActionApprovalPhrase(draftId) {
  return `Approve AI course action ${String(draftId)}`;
}

async function requireConversationMessage({ courseId, conversationId, userId, messageId }) {
  const conversation = await AiConversation.exists({
    _id: String(conversationId),
    courseId: String(courseId),
    ownerId: String(userId),
    messages: { $elemMatch: { _id: String(messageId), role: 'user' } },
  });
  if (!conversation) throw new Error('AI conversation context was not found');
}

export async function draftCourseAction({
  courseId,
  conversationId,
  userId,
  sourceMessageId,
  action,
  arguments: actionArguments,
}) {
  await requireConversationMessage({ courseId, conversationId, userId, messageId: sourceMessageId });
  const draft = await AiActionDraft.create({
    courseId: String(courseId),
    conversationId: String(conversationId),
    ownerId: String(userId),
    sourceMessageId: String(sourceMessageId),
    action,
    arguments: actionArguments || {},
  });
  return {
    ai_action_draft: {
      draft_id: String(draft._id),
      action,
      arguments: draft.arguments,
      approval_phrase: courseActionApprovalPhrase(draft._id),
    },
    applied: false,
  };
}

async function executeDraft(draft, userId) {
  const args = draft.arguments || {};
  if (draft.action === 'create_session') return createCourseSession(draft.courseId, userId, args);
  if (draft.action === 'edit_session') {
    const { session_id: sessionId, ...input } = args;
    return editCourseSession(draft.courseId, sessionId, input);
  }
  if (draft.action === 'create_question') return createCourseQuestion(draft.courseId, userId, args);
  if (draft.action === 'edit_question') {
    const { question_id: questionId, ...input } = args;
    return editCourseQuestion(draft.courseId, questionId, input);
  }
  throw new Error('Unsupported AI course action');
}

export async function applyCourseActionDraft({
  draftId,
  courseId,
  conversationId,
  userId,
  currentUserMessageId,
}) {
  const [draft, conversation] = await Promise.all([
    AiActionDraft.findOne({
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
  ]);
  if (!draft) throw new Error('AI course action draft not found in this conversation');
  if (draft.status === 'applied' && draft.result) return { ...draft.result, ai_action_applied: { draft_id: String(draft._id), action: draft.action } };
  const approval = (conversation?.messages || []).find((message) => String(message._id) === String(currentUserMessageId));
  if (!approval || approval.role !== 'user') throw new Error('The current approval message was not found');
  if (String(draft.sourceMessageId) === String(currentUserMessageId)) throw new Error('An AI course action cannot be approved in the same turn in which it was drafted');
  if (String(approval.content || '').trim() !== courseActionApprovalPhrase(draft._id)) {
    throw new Error(`Applying this action requires the exact approval phrase: ${courseActionApprovalPhrase(draft._id)}`);
  }
  const claimed = await AiActionDraft.findOneAndUpdate(
    { _id: draft._id, status: 'awaiting_approval' },
    { $set: { status: 'applying' } },
    { returnDocument: 'after' }
  );
  if (!claimed) throw new Error('AI course action is no longer awaiting approval');
  try {
    const result = await executeDraft(claimed, userId);
    const appliedAt = new Date();
    await AiActionDraft.findByIdAndUpdate(claimed._id, { $set: { status: 'applied', result, appliedAt } });
    return { ...result, ai_action_applied: { draft_id: String(claimed._id), action: claimed.action, applied_at: appliedAt } };
  } catch (error) {
    await AiActionDraft.updateOne({ _id: claimed._id, status: 'applying' }, { $set: { status: 'awaiting_approval' } });
    throw error;
  }
}
