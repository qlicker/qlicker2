import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const AiResponseSummarySchema = new mongoose.Schema({
  _id: { type: String, default: () => generateMeteorId() },
  courseId: { type: String, required: true }, sessionId: { type: String, required: true }, questionId: { type: String, required: true },
  backendId: { type: String, default: '' }, modelId: { type: String, default: '' },
  status: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'halted'], default: 'queued' },
  phase: { type: String, enum: ['queued', 'preparing', 'generating', 'completed', 'failed', 'halted'], default: 'queued' },
  instruction: { type: String, default: '' }, completed: { type: Number, default: 0 }, total: { type: Number, default: 0 },
  summary: { type: String, default: '' }, error: { type: String, default: '' },
}, { collection: 'aiResponseSummaries', timestamps: true });
AiResponseSummarySchema.index({ courseId: 1, sessionId: 1, questionId: 1 }, { unique: true });
export default mongoose.model('AiResponseSummary', AiResponseSummarySchema);
