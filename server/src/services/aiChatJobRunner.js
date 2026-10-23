import AiConversation from '../models/AiConversation.js';
import {
  MAX_AI_CONVERSATION_MESSAGES,
  MAX_AI_MESSAGE_CHARS,
  MAX_AI_THINKING_CHARS,
  MAX_AI_ARTIFACTS_PER_MESSAGE,
} from '../models/AiConversation.js';
import { runAiCourseChat } from './aiChatRunner.js';

const activeJobs = new Map();

export function isAiCourseChatActive(conversationId) {
  return activeJobs.has(String(conversationId));
}

function abortMessage(error) {
  return error?.name === 'AbortError' ? 'AI response stopped' : error?.message || 'AI backend request failed';
}

function pendingThinkingUpdater(filter) {
  let latest = '';
  let timer = null;
  let writes = Promise.resolve();
  let lastWriteAt = 0;
  const persist = () => {
    timer = null;
    lastWriteAt = Date.now();
    const value = latest;
    writes = writes.then(() => AiConversation.updateOne(filter, {
      $set: { pendingThinking: value, updatedAt: new Date() },
    })).catch(() => {});
  };
  return {
    update(value) {
      latest = String(value || '').slice(0, MAX_AI_THINKING_CHARS);
      if (timer) return;
      timer = setTimeout(persist, Math.max(0, 400 - (Date.now() - lastWriteAt)));
    },
    value: () => latest,
    async flush() {
      if (timer) {
        clearTimeout(timer);
        persist();
      }
      await writes;
    },
  };
}

export function queueAiCourseChat({
  conversationId,
  pendingMessageId,
  backend,
  modelId,
  course,
  user,
  onCourseChatUpdated,
  timeZone,
}) {
  const controller = new AbortController();
  activeJobs.set(String(conversationId), controller);

  setImmediate(async () => {
    const jobKey = String(conversationId);
    const filter = { _id: jobKey, pending: true, pendingMessageId: String(pendingMessageId) };
    const thinking = pendingThinkingUpdater(filter);
    try {
      const conversation = await AiConversation.findOne(filter).lean();
      if (!conversation) return;

      const result = await runAiCourseChat({
        backend,
        modelId,
        course,
        user,
        messages: conversation.messages,
        conversationId: jobKey,
        currentUserMessageId: String(pendingMessageId),
        onCourseChatUpdated,
        onProgress: () => AiConversation.updateOne(filter, { $set: { updatedAt: new Date() } }),
        onThinking: thinking.update,
        signal: controller.signal,
        timeZone,
      });
      await thinking.flush();
      const content = typeof result === 'string' ? result : result?.content || '';
      const completedThinking = String(result?.thinking || thinking.value() || '').slice(0, MAX_AI_THINKING_CHARS);
      const artifacts = Array.isArray(result?.artifacts) ? result.artifacts.slice(0, MAX_AI_ARTIFACTS_PER_MESSAGE) : [];
      await AiConversation.findOneAndUpdate(filter, {
        $push: { messages: { $each: [{ role: 'assistant', content: String(content).slice(0, MAX_AI_MESSAGE_CHARS), thinking: completedThinking, artifacts }], $slice: -MAX_AI_CONVERSATION_MESSAGES } },
        $set: { pending: false, pendingMessageId: '', pendingThinking: '', pendingError: '', updatedAt: new Date() },
      });
    } catch (error) {
      await thinking.flush();
      const detail = abortMessage(error);
      await AiConversation.findOneAndUpdate(filter, {
        // Keep a visible assistant turn when a provider fails. Otherwise the
        // user only sees a banner and the conversation appears to have ignored
        // their message.
        $push: { messages: { $each: [{ role: 'assistant', content: `AI backend ran into an error: ${detail}`, thinking: thinking.value(), isError: true }], $slice: -MAX_AI_CONVERSATION_MESSAGES } },
        $set: { pending: false, pendingMessageId: '', pendingThinking: '', pendingError: detail, updatedAt: new Date() },
      });
    } finally {
      if (activeJobs.get(jobKey) === controller) activeJobs.delete(jobKey);
    }
  });
}

export function stopAiCourseChat(conversationId) {
  const controller = activeJobs.get(String(conversationId));
  if (controller) controller.abort();
}
