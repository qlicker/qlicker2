import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const QuizExtensionSchema = new mongoose.Schema(
  {
    userId: { type: String },
    quizStart: { type: Date },
    quizEnd: { type: Date },
  },
  { _id: false }
);

const TagSchema = new mongoose.Schema(
  {
    value: { type: String },
    label: { type: String },
    className: { type: String },
  },
  { _id: false }
);

const JoinRecordSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    joinedAt: { type: Date, default: Date.now },
    joinedWithCode: { type: Boolean, default: false },
  },
  { _id: false }
);

const SessionSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    courseId: { type: String, required: true },
    creator: { type: String, default: '' },
    studentCreated: { type: Boolean, default: false },
    status: { type: String, required: true, enum: ['hidden', 'visible', 'running', 'done'] },
    quiz: { type: Boolean, default: false },
    practiceQuiz: { type: Boolean, default: false },
    // Anonymous sessions store responses and attendance under per-session
    // pseudonyms and never create grades. Absent on legacy documents (false).
    anonymous: { type: Boolean, default: false },
    // Monotonic guard: participation claims this before writing identity-shaped data.
    participationStarted: { type: Boolean, default: false },
    // Sharing history permanently disables individual extensions; current course
    // enrollment determines grading eligibility for identified activities.
    activityEverShared: { type: Boolean, default: false },
    // Fast path for ordinary sessions: only shared sessions resolve outside recipients.
    activityAccessEnabled: { type: Boolean, default: false },
    date: { type: Date },
    quizStart: { type: Date },
    quizEnd: { type: Date },
    quizExtensions: { type: [QuizExtensionSchema], default: [] },
    // Multi-select grading strategy for autograding (Meteor-compatible default).
    msScoringMethod: { type: String, default: 'right-minus-wrong' },
    questions: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
    currentQuestion: { type: String, default: '' },
    // Legacy: plain userId strings. New sessions also populate joinRecords.
    joined: { type: [String], default: [] },
    joinRecords: { type: [JoinRecordSchema], default: [] },
    submittedQuiz: { type: [String], default: [] },
    tags: { type: [TagSchema], default: [] },
    reviewable: { type: Boolean, default: false },
    hasResponses: { type: Boolean, default: false },
    questionResponseCounts: { type: Map, of: Number, default: {} },
    // Interactive session join-code settings
    joinCodeEnabled: { type: Boolean, default: false },
    joinCodeActive: { type: Boolean, default: false },
    currentJoinCode: { type: String, default: '' },
    joinCodeInterval: { type: Number, default: 10 },
    joinCodeExpiresAt: { type: Date },
    chatEnabled: { type: Boolean, default: false },
    richTextChatEnabled: { type: Boolean, default: true },
  },
  {
    collection: 'sessions',
    timestamps: false,
  }
);

// Indexes for query performance (matching legacy database indexes)
SessionSchema.index({ courseId: 1 });
SessionSchema.index({ courseId: 1, status: 1 });

const Session = mongoose.model('Session', SessionSchema);

export default Session;
