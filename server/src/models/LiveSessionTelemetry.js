import mongoose from 'mongoose';

const MetricAggregateSchema = new mongoose.Schema(
  {
    count: { type: Number, default: 0 },
    successCount: { type: Number, default: 0 },
    totalMs: { type: Number, default: 0 },
    maxMs: { type: Number, default: 0 },
    lastMs: { type: Number, default: 0 },
    buckets: { type: Map, of: Number, default: {} },
  },
  { _id: false }
);

const TransportCountsSchema = new mongoose.Schema(
  {
    websocket: { type: Number, default: 0 },
    polling: { type: Number, default: 0 },
    direct: { type: Number, default: 0 },
    unknown: { type: Number, default: 0 },
  },
  { _id: false }
);

const RoleTelemetrySchema = new mongoose.Schema(
  {
    lastSeenAt: { type: Date },
    sampleCount: { type: Number, default: 0 },
    transportCounts: { type: TransportCountsSchema, default: () => ({}) },
    liveFetchRequestMs: { type: MetricAggregateSchema, default: () => ({}) },
    liveFetchApplyMs: { type: MetricAggregateSchema, default: () => ({}) },
    wsEventDeliveryMs: { type: MetricAggregateSchema, default: () => ({}) },
    wsEventToDomMs: { type: MetricAggregateSchema, default: () => ({}) },
    serverEmitToDomMs: { type: MetricAggregateSchema, default: () => ({}) },
  },
  { _id: false }
);

const LiveSessionTelemetrySchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    courseId: { type: String, required: true },
    updatedAt: { type: Date, default: Date.now },
    student: { type: RoleTelemetrySchema, default: () => ({}) },
    professor: { type: RoleTelemetrySchema, default: () => ({}) },
    presentation: { type: RoleTelemetrySchema, default: () => ({}) },
  },
  {
    collection: 'liveSessionTelemetry',
    timestamps: false,
  }
);

LiveSessionTelemetrySchema.index({ courseId: 1, updatedAt: -1 });

const LiveSessionTelemetry = mongoose.model('LiveSessionTelemetry', LiveSessionTelemetrySchema);

export default LiveSessionTelemetry;
