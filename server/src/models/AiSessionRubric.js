import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const AiSessionRubricSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateMeteorId() },
  courseId: { type: String, required: true },
  sessionId: { type: String, required: true },
  questionIds: { type: [String], default: [] },
  instructions: { type: Map, of: mongoose.Schema.Types.Mixed, default: {} },
}, { collection: 'aiSessionRubrics', timestamps: true });

AiSessionRubricSchema.index({ courseId: 1, sessionId: 1 }, { unique: true });

export default mongoose.model('AiSessionRubric', AiSessionRubricSchema);
