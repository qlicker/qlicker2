import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { getActiveUserRedisKey } from './userActivity.js';

export const SYSTEM_METRIC_RANGES = Object.freeze({
  '6h': { durationMs: 6 * 60 * 60 * 1000, bucketMs: 60 * 1000 },
  '24h': { durationMs: 24 * 60 * 60 * 1000, bucketMs: 5 * 60 * 1000 },
  '7d': { durationMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 30 * 60 * 1000 },
});

const NETWORK_ROLE_KEYS = ['all', 'student', 'professor', 'admin'];
const VIRTUAL_INTERFACE_PREFIXES = [
  'lo', 'docker', 'veth', 'br-', 'virbr', 'lxcbr', 'vmnet', 'vboxnet', 'zt', 'tailscale',
  'tun', 'tap', 'wg', 'ppp',
];

function isVirtualInterface(name) {
  return VIRTUAL_INTERFACE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values) {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) return null;
  return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
}

function maximum(values) {
  const finiteValues = values.filter(Number.isFinite);
  return finiteValues.length > 0 ? Math.max(...finiteValues) : null;
}

export function parseCpuStat(raw = '') {
  const lines = String(raw).split(/\r?\n/);
  const line = lines.find((entry) => /^cpu\s/.test(entry));
  if (!line) throw new Error('Host CPU counters are unavailable');
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Host CPU counters are malformed');
  }
  const idle = values[3] + (values[4] || 0);
  return {
    cores: lines.filter((entry) => /^cpu\d+\s/.test(entry)).length || null,
    idle,
    // guest and guest_nice are already included in user/nice counters.
    total: values.slice(0, 8).reduce((sum, value) => sum + value, 0),
  };
}

export function calculateCpuUsage(previous, current) {
  if (!previous || !current) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (!(totalDelta > 0) || idleDelta < 0) return null;
  return round(Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100)));
}

export function parseMeminfo(raw = '') {
  const values = {};
  String(raw).split(/\r?\n/).forEach((line) => {
    const match = line.match(/^([^:]+):\s+(\d+)\s+kB$/i);
    if (match) values[match[1]] = Number(match[2]) * 1024;
  });
  const totalBytes = finiteOrNull(values.MemTotal);
  const availableBytes = finiteOrNull(
    values.MemAvailable
      ?? ((values.MemFree || 0) + (values.Buffers || 0) + (values.Cached || 0))
  );
  if (!(totalBytes > 0) || availableBytes === null) {
    throw new Error('Host memory counters are unavailable');
  }
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  return {
    totalBytes,
    availableBytes,
    usedBytes,
    usedPercent: round((usedBytes / totalBytes) * 100),
  };
}

export function parseLoadavg(raw = '') {
  const values = String(raw).trim().split(/\s+/).slice(0, 3).map(Number);
  return {
    load1: finiteOrNull(values[0]),
    load5: finiteOrNull(values[1]),
    load15: finiteOrNull(values[2]),
  };
}

export function parseDefaultRouteInterfaces(raw = '') {
  const routes = [];
  String(raw).split(/\r?\n/).slice(1).forEach((line) => {
    const columns = line.trim().split(/\s+/);
    if (columns.length >= 8 && columns[1] === '00000000' && columns[7] === '00000000') {
      const flags = Number.parseInt(columns[3], 16);
      if ((flags & 0x1) === 0x1 && (flags & 0x200) === 0 && columns[0]) {
        routes.push({ name: columns[0], metric: Number(columns[6]) || 0 });
      }
    }
  });
  // VPN and uplink counters often describe the same packets at different layers.
  // Prefer the host uplinks, even if a tunnel has a lower routing metric.
  const uplinks = routes.filter(({ name }) => !isVirtualInterface(name));
  const selected = uplinks.length > 0
    ? uplinks
    : routes.sort((a, b) => a.metric - b.metric || a.name.localeCompare(b.name)).slice(0, 1);
  return [...new Set(selected.map(({ name }) => name))].sort();
}

export function parseNetworkDev(raw = '', requestedInterfaces = []) {
  const counters = new Map();
  String(raw).split(/\r?\n/).slice(2).forEach((line) => {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex < 0) return;
    const name = line.slice(0, separatorIndex).trim();
    const values = line.slice(separatorIndex + 1).trim().split(/\s+/).map(Number);
    if (!name || values.length < 9 || !Number.isFinite(values[0]) || !Number.isFinite(values[8])) return;
    counters.set(name, { receivedBytes: values[0], transmittedBytes: values[8] });
  });

  const configured = [...new Set(requestedInterfaces.map((entry) => String(entry).trim()).filter(Boolean))];
  let interfaces = configured.filter((name) => counters.has(name));
  if (configured.length === 0) {
    interfaces = [...counters.keys()].filter((name) => !isVirtualInterface(name));
    if (interfaces.length === 0 && counters.has('lo')) interfaces = ['lo'];
  }
  // Never silently replace an explicitly requested, missing interface with all
  // host traffic. Treat a partially missing selection as unavailable too.
  if (interfaces.length === 0 || (configured.length > 0 && interfaces.length !== configured.length)) {
    return { interfaces: [], receivedBytes: null, transmittedBytes: null };
  }
  interfaces.sort();

  return interfaces.reduce((summary, name) => {
    const counter = counters.get(name);
    summary.interfaces.push(name);
    summary.receivedBytes += counter.receivedBytes;
    summary.transmittedBytes += counter.transmittedBytes;
    return summary;
  }, { interfaces: [], receivedBytes: 0, transmittedBytes: 0 });
}

export async function readSystemSnapshot({ procRoot = '/proc', networkInterfaces = [] } = {}) {
  const readProcFile = (name) => readFile(path.join(procRoot, name), 'utf8');
  const [cpuRaw, memoryRaw, loadRaw, networkRaw, routeRaw] = await Promise.all([
    readProcFile('stat'),
    readProcFile('meminfo'),
    readProcFile('loadavg'),
    readProcFile(path.join('net', 'dev')),
    readProcFile(path.join('net', 'route')).catch(() => ''),
  ]);
  const defaultRouteInterfaces = parseDefaultRouteInterfaces(routeRaw);
  const selectedInterfaces = networkInterfaces.length > 0 ? networkInterfaces : defaultRouteInterfaces;

  return {
    measuredAtMs: Date.now(),
    monotonicAtMs: performance.now(),
    cpuCounters: parseCpuStat(cpuRaw),
    memory: parseMeminfo(memoryRaw),
    load: parseLoadavg(loadRaw),
    network: parseNetworkDev(networkRaw, selectedInterfaces),
  };
}

function counterRate(previousValue, currentValue, elapsedSeconds) {
  if (!Number.isFinite(previousValue) || !Number.isFinite(currentValue) || !(elapsedSeconds > 0)) return null;
  if (currentValue < previousValue) return null;
  return round((currentValue - previousValue) / elapsedSeconds);
}

export function buildSystemMetricSample(previous, current, {
  activity = {},
  collectorId,
  retentionDays = 7,
  sampleIntervalSeconds = 60,
} = {}) {
  const timestamp = new Date(current.measuredAtMs);
  const monotonicTiming = Number.isFinite(previous?.monotonicAtMs) && Number.isFinite(current.monotonicAtMs);
  const elapsedSeconds = previous
    ? (monotonicTiming
      ? current.monotonicAtMs - previous.monotonicAtMs
      : current.measuredAtMs - previous.measuredAtMs) / 1000
    : null;
  const sameInterfaces = previous?.network?.interfaces?.join(',') === current.network.interfaces.join(',');
  return {
    timestamp,
    expiresAt: new Date(timestamp.getTime() + (retentionDays * 24 * 60 * 60 * 1000)),
    collectorId,
    sampleIntervalSeconds,
    cpu: {
      usagePercent: calculateCpuUsage(previous?.cpuCounters, current.cpuCounters),
      cores: finiteOrNull(current.cpuCounters?.cores),
      ...current.load,
    },
    memory: current.memory,
    network: {
      ...current.network,
      receivedBytesPerSecond: counterRate(
        sameInterfaces ? previous?.network?.receivedBytes : null,
        current.network.receivedBytes,
        elapsedSeconds
      ),
      transmittedBytesPerSecond: counterRate(
        sameInterfaces ? previous?.network?.transmittedBytes : null,
        current.network.transmittedBytes,
        elapsedSeconds
      ),
    },
    activity: {
      activeUsers: finiteOrNull(activity.activeUsers),
      activeStudents: finiteOrNull(activity.activeStudents),
      activeProfessors: finiteOrNull(activity.activeProfessors),
      activeAdmins: finiteOrNull(activity.activeAdmins),
      windowMinutes: finiteOrNull(activity.windowMinutes),
      source: activity.source === 'redis' ? 'redis' : 'unavailable',
    },
  };
}

export async function readActiveUserCounts(redis, {
  activeWindowMinutes = 15,
  nowMs = Date.now(),
} = {}) {
  if (!redis) {
    return { source: 'unavailable', windowMinutes: activeWindowMinutes };
  }
  const cutoff = nowMs - (activeWindowMinutes * 60 * 1000);
  const pipeline = redis.pipeline();
  NETWORK_ROLE_KEYS.forEach((role) => {
    const key = getActiveUserRedisKey(role);
    pipeline.zremrangebyscore(key, 0, cutoff - 1);
    pipeline.zcount(key, cutoff, '+inf');
  });
  const results = await pipeline.exec();
  if (!Array.isArray(results) || results.length !== NETWORK_ROLE_KEYS.length * 2) {
    throw new Error('Active-user counters are unavailable');
  }
  for (const [error] of results) if (error) throw error;
  const counts = {};
  NETWORK_ROLE_KEYS.forEach((role, index) => {
    const [, value] = results[(index * 2) + 1];
    counts[role] = Number(value) || 0;
  });
  return {
    source: 'redis',
    windowMinutes: activeWindowMinutes,
    activeUsers: counts.all,
    activeStudents: counts.student,
    activeProfessors: counts.professor,
    activeAdmins: counts.admin,
  };
}

function summarizeBucket(bucketTimestamp, samples) {
  const values = (selector) => samples.map(selector).map(finiteOrNull);
  return {
    timestamp: new Date(bucketTimestamp),
    cpuPercent: round(average(values((sample) => sample.cpu?.usagePercent))),
    memoryPercent: round(average(values((sample) => sample.memory?.usedPercent))),
    load1: round(average(values((sample) => sample.cpu?.load1))),
    networkReceivedBytesPerSecond: round(average(values((sample) => sample.network?.receivedBytesPerSecond))),
    networkTransmittedBytesPerSecond: round(average(values((sample) => sample.network?.transmittedBytesPerSecond))),
    activeUsers: maximum(values((sample) => sample.activity?.activeUsers)),
    activeStudents: maximum(values((sample) => sample.activity?.activeStudents)),
    activeProfessors: maximum(values((sample) => sample.activity?.activeProfessors)),
    activeAdmins: maximum(values((sample) => sample.activity?.activeAdmins)),
    samples: samples.length,
  };
}

export function aggregateSystemMetricSamples(samples = [], { bucketMs = 300_000 } = {}) {
  const buckets = new Map();
  [...samples]
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .forEach((sample) => {
      const timestampMs = new Date(sample.timestamp).getTime();
      if (!Number.isFinite(timestampMs)) return;
      const bucketTimestamp = Math.floor(timestampMs / bucketMs) * bucketMs;
      if (!buckets.has(bucketTimestamp)) buckets.set(bucketTimestamp, []);
      buckets.get(bucketTimestamp).push(sample);
    });
  if (!buckets.size) return [];
  const timestamps = [...buckets.keys()];
  const history = [];
  for (let timestamp = timestamps[0]; timestamp <= timestamps.at(-1); timestamp += bucketMs) {
    history.push(summarizeBucket(timestamp, buckets.get(timestamp) || []));
  }
  return history;
}

export function buildSystemMonitoringResponse({
  samples = [],
  events = [],
  range = '24h',
  now = new Date(),
} = {}) {
  const rangeConfig = SYSTEM_METRIC_RANGES[range] || SYSTEM_METRIC_RANGES['24h'];
  const history = aggregateSystemMetricSamples(samples, rangeConfig);
  const latest = samples.length > 0
    ? [...samples].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0]
    : null;
  const latestTimestampMs = latest ? new Date(latest.timestamp).getTime() : NaN;
  const staleAfterMs = Math.max(180_000, Number(latest?.sampleIntervalSeconds || 60) * 3 * 1000);
  const status = !latest
    ? 'unavailable'
    : now.getTime() - latestTimestampMs > staleAfterMs
      ? 'stale'
      : 'healthy';
  const peakPeriods = [...history]
    .filter((point) => point.activeUsers !== null || point.cpuPercent !== null)
    .sort((a, b) => (
      (b.activeUsers ?? -1) - (a.activeUsers ?? -1)
      || (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)
    ))
    .slice(0, 5);

  return {
    status,
    range,
    generatedAt: now,
    retentionDays: 7,
    bucketSeconds: rangeConfig.bucketMs / 1000,
    activeUserDefinition: 'authenticated request within the activity window',
    latest,
    history,
    peakPeriods,
    events,
  };
}
