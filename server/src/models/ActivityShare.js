import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const ActivityShareSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateMeteorId() },
  sessionId: { type: String, required: true },
  codeHash: { type: String, required: true },
  codeSeed: { type: String, default: null },
  enabled: { type: Boolean, default: true },
  accessEpoch: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { collection: 'activityShares', timestamps: false });

ActivityShareSchema.index({ sessionId: 1 }, { unique: true });
ActivityShareSchema.index({ codeHash: 1 }, { unique: true });

export default mongoose.model('ActivityShare', ActivityShareSchema);
