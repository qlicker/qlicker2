import mongoose from 'mongoose';

const SystemMonitorEventSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
    collectorId: { type: String, required: true, trim: true },
    level: { type: String, required: true, enum: ['info', 'warning', 'error'] },
    code: { type: String, required: true, trim: true },
    message: { type: String, required: true, maxlength: 1000 },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    collection: 'systemMonitorEvents',
    timestamps: false,
  }
);

SystemMonitorEventSchema.index({ timestamp: -1 });
SystemMonitorEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('SystemMonitorEvent', SystemMonitorEventSchema);
