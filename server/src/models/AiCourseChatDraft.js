import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const AiCourseChatDraftSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    courseId: { type: String, required: true, index: true },
    conversationId: { type: String, required: true, index: true },
    ownerId: { type: String, required: true, index: true },
    sourceMessageId: { type: String, required: true },
    type: { type: String, enum: ['topic', 'response'], required: true },
    targetPostId: { type: String, default: '' },
    targetTitle: { type: String, default: '' },
    title: { type: String, default: '' },
    body: { type: String, required: true },
    tags: { type: [String], default: [] },
    status: { type: String, enum: ['awaiting_approval', 'publishing', 'published'], default: 'awaiting_approval' },
    publishedPostId: { type: String, default: '' },
    publishedCommentId: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    publishedAt: { type: Date, default: null },
  },
  { collection: 'aiCourseChatDrafts', timestamps: false }
);

AiCourseChatDraftSchema.index({ conversationId: 1, ownerId: 1, createdAt: -1 });
AiCourseChatDraftSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.model('AiCourseChatDraft', AiCourseChatDraftSchema);
