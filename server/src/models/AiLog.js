import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const AiLogSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    category: { type: String, required: true, enum: ['grading'] },
    recordType: { type: String, required: true, enum: ['run', 'entry'] },
    courseId: { type: String, required: true },
    sessionId: { type: String, default: '' },
    questionId: { type: String, default: '' },
    jobId: { type: String, required: true },
    ownerId: { type: String, default: '' },
    status: { type: String, default: '' },
    sequence: { type: Number, default: 0 },
    entryCount: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'aiLogs', timestamps: false }
);

AiLogSchema.index({ category: 1, courseId: 1, sessionId: 1, createdAt: -1 });
AiLogSchema.index({ category: 1, jobId: 1, recordType: 1, sequence: 1 });
AiLogSchema.index(
  { category: 1, jobId: 1 },
  { unique: true, partialFilterExpression: { recordType: 'run' }, name: 'ai_log_run_unique' }
);
AiLogSchema.index(
  { category: 1, jobId: 1, sequence: 1 },
  { unique: true, partialFilterExpression: { recordType: 'entry' }, name: 'ai_log_entry_sequence_unique' }
);

export default mongoose.model('AiLog', AiLogSchema);
