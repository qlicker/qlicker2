import mongoose from 'mongoose';

const NotificationDismissalSchema = new mongoose.Schema(
  {
    notificationId: { type: String, required: true },
    userId: { type: String, required: true },
    dismissedAt: { type: Date, default: Date.now },
  },
  {
    collection: 'notificationDismissals',
    timestamps: false,
  }
);

NotificationDismissalSchema.index({ notificationId: 1, userId: 1 }, { unique: true });
NotificationDismissalSchema.index({ userId: 1, dismissedAt: -1 });

const NotificationDismissal = mongoose.model('NotificationDismissal', NotificationDismissalSchema);

export default NotificationDismissal;
