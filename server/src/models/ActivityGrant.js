import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const ActivityGrantSchema = new mongoose.Schema({
  _id: { type: String, default: () => generateMeteorId() },
  sessionId: { type: String, required: true },
  userId: { type: String, required: true },
  accessEpoch: { type: Number, required: true, default: 0 },
  // Historical fact only; current course membership determines grading eligibility.
  guestAtRedemption: { type: Boolean, required: true, default: false },
  createdAt: { type: Date, default: Date.now },
}, { collection: 'activityGrants', timestamps: false });

ActivityGrantSchema.index({ sessionId: 1, userId: 1 }, { unique: true });

export default mongoose.model('ActivityGrant', ActivityGrantSchema);
