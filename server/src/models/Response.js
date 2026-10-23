import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const ResponseSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    attempt: { type: Number, required: true },
    questionId: { type: String, required: true },
    studentUserId: { type: String, required: true },
    answer: { type: mongoose.Schema.Types.Mixed, required: true },
    answerWysiwyg: { type: String, default: '' },
    correct: { type: Boolean },
    mark: { type: Number },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
    submittedAt: { type: Date },
    submittedIpAddress: { type: String, default: '' },
    editable: { type: Boolean, default: false },
  },
  {
    collection: 'responses',
    timestamps: false,
  }
);

ResponseSchema.index({ questionId: 1, studentUserId: 1, attempt: 1 });
ResponseSchema.index({ questionId: 1, attempt: 1 });

const Response = mongoose.model('Response', ResponseSchema);

export default Response;
