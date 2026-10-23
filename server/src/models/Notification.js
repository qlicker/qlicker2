import mongoose from 'mongoose';
import { generateMeteorId } from '../utils/meteorId.js';

const NotificationSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => generateMeteorId() },
    scopeType: { type: String, enum: ['system', 'course'], required: true },
    courseId: { type: String, default: '' },
    recipientType: { type: String, enum: ['all', 'students', 'instructors'], default: 'all' },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    persistUntilDismissed: { type: Boolean, default: false },
    sourceKey: { type: String, default: '' },
    sourceRefId: { type: String, default: '' },
    createdBy: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    collection: 'notifications',
    timestamps: false,
  }
);

NotificationSchema.index({ scopeType: 1, recipientType: 1, startAt: -1, createdAt: -1 });
NotificationSchema.index({ courseId: 1, recipientType: 1, startAt: -1, createdAt: -1 });
NotificationSchema.index({ scopeType: 1, courseId: 1, sourceKey: 1, sourceRefId: 1 });
NotificationSchema.index({ endAt: 1 });
NotificationSchema.index({ createdBy: 1 });

const Notification = mongoose.model('Notification', NotificationSchema);

export default Notification;
