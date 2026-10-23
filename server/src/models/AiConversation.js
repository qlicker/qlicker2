import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

export const MAX_AI_MESSAGE_CHARS = 20_000;
export const MAX_AI_MESSAGE_WYSIWYG_CHARS = 100_000;
export const MAX_AI_THINKING_CHARS = 100_000;
export const MAX_AI_CONVERSATION_MESSAGES = 400;
export const MAX_AI_ARTIFACTS_PER_MESSAGE = 10;

const AiArtifactSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    kind: { type: String, enum: ['image', 'audio', 'file'], required: true },
    sourcePath: { type: String, required: true, maxlength: 2_000 },
    filename: { type: String, default: '', maxlength: 300 },
    mimeType: { type: String, default: '', maxlength: 200 },
    label: { type: String, default: '', maxlength: 300 },
  },
  { _id: false }
);

const AiMessageSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '', maxlength: MAX_AI_MESSAGE_CHARS },
    contentWysiwyg: { type: String, default: '', maxlength: MAX_AI_MESSAGE_WYSIWYG_CHARS },
    thinking: { type: String, default: '', maxlength: MAX_AI_THINKING_CHARS },
    isError: { type: Boolean, default: false },
    artifacts: {
      type: [AiArtifactSchema],
      default: [],
      validate: [(value) => value.length <= MAX_AI_ARTIFACTS_PER_MESSAGE, `A message cannot contain more than ${MAX_AI_ARTIFACTS_PER_MESSAGE} artifacts`],
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AiConversationSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    courseId: { type: String, required: true, index: true },
    ownerId: { type: String, required: true, index: true },
    audience: { type: String, enum: ['instructor', 'student'], default: 'instructor' },
    title: { type: String, default: '' },
    backendId: { type: String, default: '' },
    modelId: { type: String, default: '' },
    pending: { type: Boolean, default: false },
    pendingMessageId: { type: String, default: '' },
    pendingThinking: { type: String, default: '', maxlength: MAX_AI_THINKING_CHARS },
    pendingError: { type: String, default: '' },
    messages: { type: [AiMessageSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'aiConversations', timestamps: false }
);

AiConversationSchema.index({ courseId: 1, ownerId: 1, audience: 1, updatedAt: -1 });

export default mongoose.model('AiConversation', AiConversationSchema);
