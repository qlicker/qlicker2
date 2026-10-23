const ACTIVITY_KEY_PREFIX = 'qlicker:activity';
const PUBLISH_THROTTLE_MS = 60 * 1000;
const KEY_TTL_SECONDS = 8 * 24 * 60 * 60;

export function getActiveUserRedisKey(role = 'all') {
  return `${ACTIVITY_KEY_PREFIX}:${role}`;
}

export function registerUserActivityTracking(app, options = {}) {
  const lastPublishedAt = new Map();
  const now = options.now || (() => Date.now());
  const publishThrottleMs = options.publishThrottleMs ?? PUBLISH_THROTTLE_MS;
  let lastSweepAt = 0;
  let pendingWrites = 0;

  function recordAuthenticatedActivity(user = {}) {
    const userId = String(user.userId || '').trim();
    // Never queue monitoring writes during a Redis outage.
    if (!userId || !app.redis || pendingWrites >= 1_000
      || (app.redis.status && app.redis.status !== 'ready')) return;

    const timestamp = now();
    const previous = lastPublishedAt.get(userId) || 0;
    if (timestamp - previous < publishThrottleMs) return;
    lastPublishedAt.set(userId, timestamp);

    const roles = [...new Set((user.roles || [])
      .map((role) => String(role || '').trim().toLowerCase())
      .filter((role) => ['student', 'professor', 'admin'].includes(role)))];
    try {
      const pipeline = app.redis.pipeline();
      for (const role of ['all', ...roles]) {
        const key = getActiveUserRedisKey(role);
        pipeline.zadd(key, timestamp, userId);
        pipeline.expire(key, KEY_TTL_SECONDS);
      }
      const result = pipeline.exec();
      pendingWrites += 1;
      Promise.resolve(result).catch((error) => {
        app.log.debug({ err: error }, 'Unable to publish active-user heartbeat');
      }).finally(() => { pendingWrites -= 1; });
    } catch (error) {
      app.log.debug({ err: error }, 'Unable to publish active-user heartbeat');
    }

    if (timestamp - lastSweepAt >= publishThrottleMs) {
      lastSweepAt = timestamp;
      const cutoff = timestamp - publishThrottleMs;
      for (const [trackedUserId, trackedAt] of lastPublishedAt) {
        if (trackedAt <= cutoff) lastPublishedAt.delete(trackedUserId);
      }
    }
    // Bound memory even during sustained traffic from many distinct users.
    if (lastPublishedAt.size > 20_000) lastPublishedAt.delete(lastPublishedAt.keys().next().value);
  }

  app.decorate('recordAuthenticatedActivity', recordAuthenticatedActivity);
  app.addHook('onClose', async () => {
    lastPublishedAt.clear();
  });
}
