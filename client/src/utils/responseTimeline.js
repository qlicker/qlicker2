import { getRecordedResponseTimestampMs } from './responses';

export function collectResponseTimeline(responses = []) {
  const timestamps = [];
  let missingCount = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const response of responses) {
    const timestamp = getRecordedResponseTimestampMs(response);
    if (timestamp === null) { missingCount += 1; continue; }
    timestamps.push(timestamp);
    min = Math.min(min, timestamp);
    max = Math.max(max, timestamp);
  }
  return { timestamps, missingCount, range: timestamps.length ? { min, max } : null };
}

// Round intervals up to human-readable units. A bounded number of bins keeps
// long-running sessions and outliers from producing huge DOMs or arrays.
const INTERVALS = [1000, 5000, 10000, 30000, 60000, 300000, 900000, 1800000,
  3600000, 10800000, 21600000, 43200000, 86400000, 604800000, 2592000000];

export function buildResponseTimelineBins(data, { targetBins = 25 } = {}) {
  if (!data.timestamps.length || !data.range) return null;
  const { min, max } = data.range;
  const desired = Math.max(1000, (max - min) / Math.max(1, Math.min(80, targetBins)));
  const interval = INTERVALS.find((value) => value >= desired)
    || Math.ceil(desired / 2592000000) * 2592000000;
  const start = Math.floor(min / interval) * interval;
  const count = Math.floor((max - start) / interval) + 1;
  const bins = Array.from({ length: count }, (_, index) => ({
    start: start + index * interval, end: start + (index + 1) * interval, count: 0,
  }));
  for (const timestamp of data.timestamps) {
    bins[Math.floor((timestamp - start) / interval)].count += 1;
  }
  return { bins, start, end: start + count * interval, interval };
}
