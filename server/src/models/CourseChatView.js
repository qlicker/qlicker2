import mongoose from 'mongoose';

const CourseChatViewSchema = new mongoose.Schema(
  {
    courseId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    lastViewedAt: { type: Date, default: Date.now },
  },
  {
    collection: 'courseChatViews',
    timestamps: false,
  }
);

CourseChatViewSchema.index({ courseId: 1, userId: 1 }, { unique: true });

const CourseChatView = mongoose.model('CourseChatView', CourseChatViewSchema);

export default CourseChatView;
