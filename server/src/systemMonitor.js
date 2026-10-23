import os from 'node:os';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import SystemMetricSample from './models/SystemMetricSample.js';
import SystemMonitorEvent from './models/SystemMonitorEvent.js';
import { connectMongooseWithRetry } from './utils/mongo.js';
import {
  buildSystemMetricSample,
  readActiveUserCounts,
  readSystemSnapshot,
} from './services/systemMetrics.js';

const RETENTION_DAYS = 7;

function parseInteger(value, fallback, { min, max }) {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function log(level, message, details = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    service: 'system-monitor',
    message,
    ...details,
  };
  const writer = level === 'error' ? console.error : level === 'warning' ? console.warn : console.log;
  writer(JSON.stringify(payload));
}

async function main() {
  let stopping = false;
  let wakeSleep = () => {};
  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeSleep = () => { clearTimeout(timer); resolve(); };
    if (stopping) wakeSleep();
  });
  const stop = () => { stopping = true; wakeSleep(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const mongoUri = String(process.env.MONGO_URI || '').trim();
  if (!mongoUri) throw new Error('MONGO_URI must be set for system-monitor');

  const sampleIntervalSeconds = parseInteger(
    process.env.SYSTEM_MONITOR_SAMPLE_INTERVAL_SECONDS,
    60,
    { min: 30, max: 300 }
  );
  const activeWindowMinutes = parseInteger(
    process.env.SYSTEM_MONITOR_ACTIVE_WINDOW_MINUTES,
    15,
    { min: 5, max: 120 }
  );
  const procRoot = String(process.env.SYSTEM_MONITOR_PROC_PATH || '/proc').trim() || '/proc';
  const collectorId = String(process.env.SYSTEM_MONITOR_COLLECTOR_ID || os.hostname()).trim();
  const networkInterfaces = String(process.env.SYSTEM_MONITOR_NETWORK_INTERFACES || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  await connectMongooseWithRetry(mongoUri, {
    mongooseInstance: mongoose,
    logger: { info: (...args) => log('info', 'MongoDB connection recovered', { args }), warn: (...args) => log('warning', 'MongoDB connection retry', { args }) },
    maxPoolSize: 2,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 30_000,
  });
  await Promise.all([
    SystemMetricSample.createIndexes(),
    SystemMonitorEvent.createIndexes(),
  ]);

  let redis = null;
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  if (redisUrl) {
    redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      connectTimeout: 5_000,
      commandTimeout: 5_000,
      enableOfflineQueue: false,
      retryStrategy: (attempt) => Math.min(attempt * 1_000, 30_000),
    });
    redis.on('error', () => {});
    try {
      await redis.connect();
    } catch (error) {
      log('warning', 'Redis is unavailable; active-user counts will be omitted', { error: error.message });
    }
  }

  const expiresAt = () => new Date(Date.now() + (RETENTION_DAYS * 24 * 60 * 60 * 1000));
  const writeEvent = async (level, code, message, details = {}) => {
    log(level, message, details);
    try {
      await SystemMonitorEvent.create({
        timestamp: new Date(),
        expiresAt: expiresAt(),
        collectorId,
        level,
        code,
        message,
        details,
      });
    } catch (error) {
      log('error', 'Unable to persist monitor event', { error: error.message, eventCode: code });
    }
  };

  await writeEvent('info', 'collector_started', 'System monitor started', {
    sampleIntervalSeconds,
    activeWindowMinutes,
    procRoot,
    networkInterfaces: networkInterfaces.length > 0 ? networkInterfaces : ['default-route'],
  });

  let previousSnapshot = null;
  let lastActivitySource = redis ? 'redis' : null;
  let failureCount = 0;
  let sampleCount = 0;

  try {
    previousSnapshot = await readSystemSnapshot({ procRoot, networkInterfaces });
  } catch (error) {
    failureCount = 1;
    await writeEvent('error', 'collection_failed', 'Host metric files are unavailable', { error: error.message });
  }

  // A short baseline interval makes CPU/network rates available immediately;
  // subsequent collection uses the configured low-frequency interval.
  await sleep(1_000);

  while (!stopping) {
    const cycleStartedAt = Date.now();
    try {
      const [currentSnapshot, activity] = await Promise.all([
        readSystemSnapshot({ procRoot, networkInterfaces }),
        readActiveUserCounts(redis, { activeWindowMinutes }).catch(() => ({
          source: 'unavailable',
          windowMinutes: activeWindowMinutes,
        })),
      ]);
      const sample = buildSystemMetricSample(previousSnapshot, currentSnapshot, {
        activity,
        collectorId,
        retentionDays: RETENTION_DAYS,
        sampleIntervalSeconds,
      });
      await SystemMetricSample.create(sample);
      previousSnapshot = currentSnapshot;
      sampleCount += 1;

      if (failureCount > 0) {
        await writeEvent('info', 'collection_recovered', 'System metric collection recovered', {
          failedCycles: failureCount,
        });
        failureCount = 0;
      }
      if (activity.source !== lastActivitySource) {
        await writeEvent(
          activity.source === 'redis' ? 'info' : 'warning',
          activity.source === 'redis' ? 'activity_tracking_recovered' : 'activity_tracking_unavailable',
          activity.source === 'redis'
            ? 'Active-user tracking recovered'
            : 'Redis active-user tracking is unavailable; host metrics are still being collected'
        );
        lastActivitySource = activity.source;
      }

      // TTL indexes perform normal cleanup. This periodic fallback also keeps the
      // collection bounded if an operator disabled MongoDB TTL processing.
      if (sampleCount % 60 === 0) {
        const cutoff = new Date(Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1000));
        await Promise.all([
          SystemMetricSample.deleteMany({ timestamp: { $lt: cutoff } }),
          SystemMonitorEvent.deleteMany({ timestamp: { $lt: cutoff } }),
        ]);
      }
    } catch (error) {
      failureCount += 1;
      log('error', 'System metric collection failed', { error: error.message, failureCount });
      if (failureCount === 1 || failureCount % 10 === 0) {
        await writeEvent('error', 'collection_failed', 'System metric collection failed', {
          error: error.message,
          failureCount,
        });
      }
    }

    const elapsedMs = Date.now() - cycleStartedAt;
    const remainingMs = Math.max(1_000, (sampleIntervalSeconds * 1000) - elapsedMs);
    if (!stopping) await sleep(remainingMs);
  }

  await writeEvent('info', 'collector_stopped', 'System monitor stopped');
  redis?.disconnect();
  await mongoose.disconnect();
}

main().catch((error) => {
  log('error', 'System monitor terminated', { error: error.message });
  // Close reconnecting sockets too; the process supervisor restarts the collector.
  process.exit(1);
});
