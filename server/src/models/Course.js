import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const AiModelSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    displayName: { type: String, default: '', maxlength: 200 },
    compatibility: { type: String, enum: ['', 'qrag'], default: '' },
    available: { type: Boolean, default: true },
  },
  { _id: false }
);

const AiBackendSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, default: '' },
    type: { type: String, enum: ['ollama', 'openai'], default: 'ollama' },
    url: { type: String, required: true },
    apiToken: { type: String, default: '' },
    models: { type: [AiModelSchema], default: [] },
  },
  { _id: false }
);

const AiModelPolicySchema = new mongoose.Schema(
  {
    backendId: { type: String, required: true },
    modelId: { type: String, required: true },
    displayName: { type: String, default: '', maxlength: 200 },
    studentAvailable: { type: Boolean, default: false },
  },
  { _id: false }
);

const VideoChatApiOptionsSchema = new mongoose.Schema(
  {
    startAudioMuted: { type: Boolean, default: true },
    startVideoMuted: { type: Boolean, default: true },
    startTileView: { type: Boolean, default: true },
    subjectTitle: { type: String, default: '' },
  },
  { _id: false }
);

const VideoChatOptionsSchema = new mongoose.Schema(
  {
    urlId: { type: String, default: '' },
    joined: { type: [String], default: [] },
    apiOptions: { type: VideoChatApiOptionsSchema, default: () => ({}) },
  },
  { _id: false }
);

const GroupSchema = new mongoose.Schema(
  {
    members: { type: [String], default: [] },
    name: { type: String },
    joinedVideoChat: { type: [String], default: [] },
    helpVideoChat: { type: Boolean, default: false },
  },
  { _id: false }
);

const GroupCategorySchema = new mongoose.Schema(
  {
    categoryNumber: { type: Number },
    categoryName: { type: String },
    groups: { type: [GroupSchema], default: [] },
    catVideoChatOptions: { type: VideoChatOptionsSchema, default: undefined },
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

const CourseSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    name: { type: String, required: true },
    deptCode: { type: String, required: true },
    courseNumber: { type: String, required: true },
    section: { type: String, required: true },
    owner: { type: String, required: true },
    enrollmentCode: { type: String, required: true },
    semester: { type: String, required: true },
    inactive: { type: Boolean, default: false },
    students: { type: [String], default: [] },
    instructors: { type: [String], default: [] },
    sessions: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
    requireVerified: { type: Boolean, default: false },
    allowStudentQuestions: { type: Boolean, default: false },
    allowSharedActivities: { type: Boolean, default: false },
    quizTimeFormat: { type: String, enum: ['inherit', '24h', '12h'], default: 'inherit' },
    courseChatEnabled: { type: Boolean, default: false },
    courseChatRetentionDays: { type: Number, default: 14, min: 1, max: 365 },
    tags: { type: [TagSchema], default: [] },
    groupCategories: { type: [GroupCategorySchema], default: [] },
    videoChatOptions: { type: VideoChatOptionsSchema, default: undefined },
    // AI remains off per course until an instructor explicitly enables it.
    aiEnabled: { type: Boolean, default: false },
    aiApiUrl: { type: String, default: '' },
    aiApiToken: { type: String, default: '' },
    aiSelectedBackendId: { type: String, default: '' },
    aiSelectedModelId: { type: String, default: '' },
    aiBackends: { type: [AiBackendSchema], default: [] },
    aiDefaultBackendId: { type: String, default: '' },
    aiDefaultModelId: { type: String, default: '' },
    aiModelPolicies: { type: [AiModelPolicySchema], default: [] },
    aiInstructorChatMaxToolRounds: { type: Number, default: 20, min: 1, max: 50 },
    aiStudentChatEnabled: { type: Boolean, default: false },
    aiStudentChatGuidance: { type: String, default: '' },
    aiStudentDefaultBackendId: { type: String, default: '' },
    aiStudentDefaultModelId: { type: String, default: '' },
    aiStudentChatMaxToolRounds: { type: Number, default: 5, min: 1, max: 50 },
  },
  {
    collection: 'courses',
    timestamps: false,
  }
);

// Indexes for query performance — students and instructors are the most frequent lookups
CourseSchema.index({ students: 1 });
CourseSchema.index({ instructors: 1 });
CourseSchema.index({ owner: 1 });

const Course = mongoose.model('Course', CourseSchema);

export default Course;
