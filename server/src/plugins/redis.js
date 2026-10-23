import fp from 'fastify-plugin';
import Redis from 'ioredis';

/**
 * Redis plugin for Fastify.
 *
 * When REDIS_URL is configured, creates two Redis connections:
 *   - `app.redis`     — the general-purpose client (used for PUBLISH)
 *   - `app.redisSub`  — a dedicated subscriber client (in subscribe mode)
 *
 * When REDIS_URL is empty (the default for development), the plugin is a no-op.
 * The WebSocket plugin detects presence of `app.redis` to decide whether to
 * use cross-instance pub/sub or fall back to in-process-only broadcast.
 */
async function redisPlugin(fastify) {
  const url = fastify.config.redisUrl;
  if (!url) {
    fastify.log.info('REDIS_URL not set — running in single-instance mode (no pub/sub)');
    return;
  }

  const sharedOpts = {
    maxRetriesPerRequest: null,   // allow unlimited retries on transient failures
    enableReadyCheck: true,
    lazyConnect: false,
  };

  const pub = new Redis(url, sharedOpts);
  const sub = new Redis(url, sharedOpts);

  // Wait for both connections to be ready
  function waitForReady(client) {
    return new Promise((resolve, reject) => {
      const onReady = () => { client.removeListener('error', onError); resolve(); };
      const onError = (err) => { client.removeListener('ready', onReady); reject(err); };
      client.once('ready', onReady);
      client.once('error', onError);
    });
  }

  await Promise.all([waitForReady(pub), waitForReady(sub)]);

  fastify.log.info('Redis pub/sub connected');

  fastify.decorate('redis', pub);
  fastify.decorate('redisSub', sub);

  fastify.addHook('onClose', async () => {
    sub.disconnect();
    pub.disconnect();
  });
}

export default fp(redisPlugin, { name: 'redis' });
