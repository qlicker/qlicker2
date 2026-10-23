import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const AiGradingJobSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateMeteorId() },
  courseId: { type: String, required: true },
  sessionId: { type: String, required: true },
  ownerId: { type: String, required: true },
  backendId: { type: String, default: '' },
  modelId: { type: String, default: '' },
  questionIds: { type: [String], default: [] },
  regrade: { type: Boolean, default: false },
  instructions: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'halted'], default: 'queued' },
  active: { type: Boolean, default: false },
  completed: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  currentQuestion: { type: Number, default: 0 },
  questionTotal: { type: Number, default: 0 },
  currentStudent: { type: Number, default: 0 },
  studentTotal: { type: Number, default: 0 },
  report: { type: mongoose.Schema.Types.Mixed, default: {} },
  error: { type: String, default: '' },
  haltedAt: { type: Date, default: null },
}, { collection: 'aiGradingJobs', timestamps: true });

AiGradingJobSchema.index({ courseId: 1, sessionId: 1, createdAt: -1 });
AiGradingJobSchema.index(
  { courseId: 1, sessionId: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'active_ai_grading_job_unique' }
);
export default mongoose.model('AiGradingJob', AiGradingJobSchema);
