import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const CommentSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    authorId: { type: String, default: '' },
    authorRole: {
      type: String,
      enum: ['student', 'instructor', 'admin', 'system'],
      default: 'student',
    },
    body: { type: String, default: '' },
    bodyWysiwyg: { type: String, default: '' },
    upvoteUserIds: { type: [String], default: [] },
    upvoteCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const PostSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    scopeType: { type: String, enum: ['session', 'course'], default: 'session' },
    courseId: { type: String, required: true },
    sessionId: { type: String, default: '' },
    authorId: { type: String, default: '' },
    authorRole: {
      type: String,
      enum: ['student', 'instructor', 'admin', 'system'],
      default: 'student',
    },
    title: { type: String, default: '' },
    body: { type: String, default: '' },
    bodyWysiwyg: { type: String, default: '' },
    tags: { type: [String], default: [] },
    isQuickPost: { type: Boolean, default: false },
    quickPostQuestionNumber: { type: Number, default: null },
    upvoteUserIds: { type: [String], default: [] },
    upvoteCount: { type: Number, default: 0 },
    comments: { type: [CommentSchema], default: [] },
    dismissedAt: { type: Date, default: null },
    dismissedBy: { type: String, default: '' },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    collection: 'posts',
    timestamps: false,
  }
);

PostSchema.index({ scopeType: 1, sessionId: 1, upvoteCount: -1, createdAt: 1 });
PostSchema.index({ scopeType: 1, courseId: 1, createdAt: -1 });
PostSchema.index({ scopeType: 1, courseId: 1, archivedAt: 1, createdAt: -1 });
PostSchema.index(
  { scopeType: 1, sessionId: 1, isQuickPost: 1, quickPostQuestionNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { isQuickPost: true },
  }
);

const Post = mongoose.model('Post', PostSchema);

export default Post;
