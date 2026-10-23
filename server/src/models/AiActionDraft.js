import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const AiActionDraftSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateMeteorId() },
  courseId: { type: String, required: true },
  conversationId: { type: String, required: true },
  ownerId: { type: String, required: true },
  sourceMessageId: { type: String, required: true },
  action: { type: String, enum: ['create_session', 'edit_session', 'create_question', 'edit_question'], required: true },
  arguments: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['awaiting_approval', 'applying', 'applied'], default: 'awaiting_approval' },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now },
  appliedAt: { type: Date, default: null },
}, { collection: 'aiActionDrafts', timestamps: false });

AiActionDraftSchema.index({ conversationId: 1, ownerId: 1, createdAt: -1 });
AiActionDraftSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.model('AiActionDraft', AiActionDraftSchema);
