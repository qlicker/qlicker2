export const LIVE_TELEMETRY_ROLES = ['student', 'professor', 'presentation'];

export const LIVE_TELEMETRY_TRANSPORTS = ['websocket', 'polling', 'direct', 'unknown'];

export const LIVE_TELEMETRY_METRIC_PATHS = {
  live_fetch_request_ms: 'liveFetchRequestMs',
  live_fetch_apply_ms: 'liveFetchApplyMs',
  ws_event_delivery_ms: 'wsEventDeliveryMs',
  ws_event_to_dom_ms: 'wsEventToDomMs',
  server_emit_to_dom_ms: 'serverEmitToDomMs',
};

export const LIVE_TELEMETRY_BUCKETS_MS = [
  100,
  250,
  500,
  750,
  1000,
  1500,
  2000,
  2500,
  3000,
  4000,
  5000,
  7500,
  10000,
  15000,
];

function incrementCounter(target, path, amount = 1) {
  target[path] = Number(target[path] || 0) + amount;
}

function normalizeDurationMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.round(numeric));
}

export function normalizeTelemetryRole(role) {
  return LIVE_TELEMETRY_ROLES.includes(role) ? role : null;
}

export function normalizeTelemetryTransport(transport) {
  return LIVE_TELEMETRY_TRANSPORTS.includes(transport) ? transport : 'unknown';
}

export function normalizeTelemetryMetric(metric) {
  return LIVE_TELEMETRY_METRIC_PATHS[metric] ? metric : null;
}

export function getTelemetryBucketKey(durationMs) {
  const normalizedDuration = normalizeDurationMs(durationMs);
  if (normalizedDuration == null) return null;

  const threshold = LIVE_TELEMETRY_BUCKETS_MS.find((candidate) => normalizedDuration <= candidate);
  if (threshold != null) return `lte_${threshold}`;
  return `gt_${LIVE_TELEMETRY_BUCKETS_MS[LIVE_TELEMETRY_BUCKETS_MS.length - 1]}`;
}

export function buildLiveTelemetryUpdate({
  sessionId,
  courseId,
  role,
  samples = [],
  updatedAt = new Date(),
}) {
  const normalizedRole = normalizeTelemetryRole(role);
  if (!sessionId || !courseId || !normalizedRole) return null;

  const update = {
    $setOnInsert: {
      sessionId: String(sessionId),
      courseId: String(courseId),
    },
    $set: {
      updatedAt,
      [`${normalizedRole}.lastSeenAt`]: updatedAt,
    },
    $inc: {},
    $max: {},
  };

  let acceptedCount = 0;
  samples.forEach((sample) => {
    const normalizedMetric = normalizeTelemetryMetric(sample?.metric);
    const metricPath = LIVE_TELEMETRY_METRIC_PATHS[normalizedMetric];
    const durationMs = normalizeDurationMs(sample?.durationMs);
    if (!metricPath || durationMs == null) return;

    acceptedCount += 1;
    const transport = normalizeTelemetryTransport(sample?.transport);
    const success = sample?.success !== false;
    const basePath = `${normalizedRole}.${metricPath}`;

    incrementCounter(update.$inc, `${normalizedRole}.transportCounts.${transport}`, 1);
    incrementCounter(update.$inc, `${basePath}.count`, 1);
    incrementCounter(update.$inc, `${basePath}.totalMs`, durationMs);
    if (success) {
      incrementCounter(update.$inc, `${basePath}.successCount`, 1);
    }

    const bucketKey = getTelemetryBucketKey(durationMs);
    if (bucketKey) {
      incrementCounter(update.$inc, `${basePath}.buckets.${bucketKey}`, 1);
    }

    update.$set[`${basePath}.lastMs`] = durationMs;
    update.$max[`${basePath}.maxMs`] = Math.max(Number(update.$max[`${basePath}.maxMs`] || 0), durationMs);
  });

  if (acceptedCount === 0) return null;
  update.$inc[`${normalizedRole}.sampleCount`] = acceptedCount;

  if (Object.keys(update.$max).length === 0) {
    delete update.$max;
  }

  return update;
}

function getBucketCount(buckets, key) {
  if (!buckets) return 0;
  if (typeof buckets.get === 'function') return Number(buckets.get(key) || 0);
  return Number(buckets[key] || 0);
}

function summarizePercentile(metric = {}, percentile = 0.99) {
  const count = Number(metric?.count || 0);
  if (count <= 0) return null;

  const targetRank = Math.max(1, Math.ceil(count * percentile));
  let cumulative = 0;

  for (const bucket of LIVE_TELEMETRY_BUCKETS_MS) {
    cumulative += getBucketCount(metric?.buckets, `lte_${bucket}`);
    if (cumulative >= targetRank) return bucket;
  }

  const overflowKey = `gt_${LIVE_TELEMETRY_BUCKETS_MS[LIVE_TELEMETRY_BUCKETS_MS.length - 1]}`;
  cumulative += getBucketCount(metric?.buckets, overflowKey);
  if (cumulative >= targetRank) {
    return Number(metric?.maxMs || LIVE_TELEMETRY_BUCKETS_MS[LIVE_TELEMETRY_BUCKETS_MS.length - 1]);
  }

  return Number(metric?.maxMs || 0) || null;
}

function summarizeMetric(metric = {}) {
  const count = Number(metric?.count || 0);
  const successCount = Number(metric?.successCount || 0);
  const totalMs = Number(metric?.totalMs || 0);
  const maxMs = Number(metric?.maxMs || 0);

  return {
    count,
    successRate: count > 0 ? successCount / count : null,
    avgMs: count > 0 ? Math.round((totalMs / count) * 100) / 100 : null,
    maxMs: count > 0 ? maxMs : null,
    lastMs: count > 0 ? Number(metric?.lastMs || 0) : null,
    p50Ms: summarizePercentile(metric, 0.50),
    p95Ms: summarizePercentile(metric, 0.95),
    p99Ms: summarizePercentile(metric, 0.99),
  };
}

function summarizeRole(role = {}) {
  return {
    lastSeenAt: role?.lastSeenAt || null,
    sampleCount: Number(role?.sampleCount || 0),
    transportCounts: {
      websocket: Number(role?.transportCounts?.websocket || 0),
      polling: Number(role?.transportCounts?.polling || 0),
      direct: Number(role?.transportCounts?.direct || 0),
      unknown: Number(role?.transportCounts?.unknown || 0),
    },
    metrics: Object.fromEntries(
      Object.entries(LIVE_TELEMETRY_METRIC_PATHS).map(([metricName, metricPath]) => [
        metricName,
        summarizeMetric(role?.[metricPath] || {}),
      ])
    ),
  };
}

export function summarizeLiveTelemetryDocument(doc) {
  if (!doc) return null;

  return {
    sessionId: String(doc?.sessionId || ''),
    courseId: String(doc?.courseId || ''),
    updatedAt: doc?.updatedAt || null,
    student: summarizeRole(doc?.student || {}),
    professor: summarizeRole(doc?.professor || {}),
    presentation: summarizeRole(doc?.presentation || {}),
  };
}
