import mongoose from 'mongoose';

const SystemMetricSampleSchema = new mongoose.Schema(
  {
    timestamp: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    collectorId: { type: String, required: true, trim: true },
    sampleIntervalSeconds: { type: Number, required: true, min: 1 },
    cpu: {
      usagePercent: { type: Number, default: null },
      cores: { type: Number, default: null },
      load1: { type: Number, default: null },
      load5: { type: Number, default: null },
      load15: { type: Number, default: null },
    },
    memory: {
      usedBytes: { type: Number, default: null },
      availableBytes: { type: Number, default: null },
      totalBytes: { type: Number, default: null },
      usedPercent: { type: Number, default: null },
    },
    network: {
      interfaces: { type: [String], default: [] },
      receivedBytes: { type: Number, default: null },
      transmittedBytes: { type: Number, default: null },
      receivedBytesPerSecond: { type: Number, default: null },
      transmittedBytesPerSecond: { type: Number, default: null },
    },
    activity: {
      activeUsers: { type: Number, default: null },
      activeStudents: { type: Number, default: null },
      activeProfessors: { type: Number, default: null },
      activeAdmins: { type: Number, default: null },
      windowMinutes: { type: Number, default: null },
      source: { type: String, enum: ['redis', 'unavailable'], default: 'unavailable' },
    },
  },
  {
    collection: 'systemMetricSamples',
    timestamps: false,
  }
);

SystemMetricSampleSchema.index({ timestamp: 1 });
SystemMetricSampleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('SystemMetricSample', SystemMetricSampleSchema);
