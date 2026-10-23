import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const MarkSchema = new mongoose.Schema(
  {
    questionId: { type: String, default: '' },
    responseId: { type: String, default: '' },
    attempt: { type: Number, default: 1 },
    points: { type: Number, default: 0 },
    outOf: { type: Number, default: 0 },
    automatic: { type: Boolean, default: true },
    aiGraded: { type: Boolean, default: false },
    needsGrading: { type: Boolean, default: false },
    feedback: { type: String, default: '' },
    feedbackUpdatedAt: { type: Date, default: null },
  },
  { _id: false }
);

const GradeSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    userId: { type: String, required: true },
    courseId: { type: String, default: '' },
    sessionId: { type: String, default: '' },
    name: { type: String, default: '' },
    marks: { type: [MarkSchema], default: [] },
    joined: { type: Boolean, default: false },
    participation: { type: Number, default: 0 },
    value: { type: Number, default: 0 },
    automatic: { type: Boolean, default: true },
    points: { type: Number, default: 0 },
    outOf: { type: Number, default: 0 },
    numAnswered: { type: Number, default: 0 },
    numQuestions: { type: Number, default: 0 },
    numAnsweredTotal: { type: Number, default: 0 },
    numQuestionsTotal: { type: Number, default: 0 },
    visibleToStudents: { type: Boolean, default: false },
    needsGrading: { type: Boolean, default: false },
    feedbackSeenAt: { type: Date, default: null },
  },
  {
    collection: 'grades',
    timestamps: false,
  }
);

// Indexes for query performance (matching legacy database indexes)
GradeSchema.index({ userId: 1 });
GradeSchema.index({ sessionId: 1 });
GradeSchema.index({ courseId: 1 });
GradeSchema.index({ userId: 1, sessionId: 1 });
GradeSchema.index(
  { courseId: 1, sessionId: 1, userId: 1 },
  { unique: true, name: 'grade_identity_unique' }
);

const Grade = mongoose.model('Grade', GradeSchema);

export default Grade;
