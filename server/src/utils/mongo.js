import mongoose from 'mongoose';

const DEFAULT_CONNECT_RETRIES = 6;
const DEFAULT_CONNECT_RETRY_DELAY_MS = 2000;
const DEFAULT_MAX_POOL_SIZE = 25;
const DEFAULT_MIN_POOL_SIZE = 0;
const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 10000;
const DEFAULT_SOCKET_TIMEOUT_MS = 45000;

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logMongoEvent(logger, level, message, details = {}) {
  if (!logger || typeof logger[level] !== 'function') {
    return;
  }

  if (Object.keys(details).length > 0) {
    logger[level](details, message);
    return;
  }

  logger[level](message);
}

export function buildMongooseConnectionOptions(overrides = {}) {
  return {
    autoIndex: false,
    maxPoolSize: normalizePositiveInt(overrides.maxPoolSize, DEFAULT_MAX_POOL_SIZE),
    minPoolSize: normalizePositiveInt(overrides.minPoolSize, DEFAULT_MIN_POOL_SIZE),
    serverSelectionTimeoutMS: normalizePositiveInt(
      overrides.serverSelectionTimeoutMS,
      DEFAULT_SERVER_SELECTION_TIMEOUT_MS
    ),
    socketTimeoutMS: normalizePositiveInt(overrides.socketTimeoutMS, DEFAULT_SOCKET_TIMEOUT_MS),
  };
}

export async function connectMongooseWithRetry(uri, {
  mongooseInstance = mongoose,
  logger = console,
  connectRetries = DEFAULT_CONNECT_RETRIES,
  connectRetryDelayMs = DEFAULT_CONNECT_RETRY_DELAY_MS,
  ...connectionOverrides
} = {}) {
  const attempts = Math.max(1, normalizePositiveInt(connectRetries, DEFAULT_CONNECT_RETRIES));
  const baseDelayMs = Math.max(250, normalizePositiveInt(connectRetryDelayMs, DEFAULT_CONNECT_RETRY_DELAY_MS));
  const connectionOptions = buildMongooseConnectionOptions(connectionOverrides);

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (mongooseInstance.connection.readyState !== 0) {
        await mongooseInstance.disconnect().catch(() => {});
      }
      await mongooseInstance.connect(uri, connectionOptions);
      if (attempt > 1) {
        logMongoEvent(logger, 'info', 'MongoDB connection recovered', { attempt });
      }
      return mongooseInstance;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }

      const delayMs = Math.min(baseDelayMs * attempt, 10000);
      logMongoEvent(logger, 'warn', 'MongoDB connection attempt failed; retrying', {
        attempt,
        attempts,
        delayMs,
        error: error?.message || String(error),
      });
      await sleep(delayMs);
    }
  }

  throw lastError;
}
