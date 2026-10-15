import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import config from './config/index.js';
import dbPlugin from './plugins/db.js';
import uploadPlugin from './plugins/upload.js';
import samlPlugin from './plugins/saml.js';
import redisPlugin from './plugins/redis.js';
import websocketPlugin from './plugins/websocket.js';
import {
  authenticate,
  authenticateAccessTokenOrRefreshCookie,
  requireRole,
  requireRoleFromAccessTokenOrRefreshCookie,
} from './middleware/auth.js';
import authRoutes, { legacySamlRoutes } from './routes/auth.js';
import userRoutes from './routes/users.js';
import settingsRoutes from './routes/settings.js';
import imageRoutes from './routes/images.js';
import courseRoutes from './routes/courses.js';
import courseChatRoutes from './routes/courseChat.js';
import sessionRoutes from './routes/sessions.js';
import ActivityShare from './models/ActivityShare.js';
import ActivityGrant from './models/ActivityGrant.js';
import activityAccessRoutes from './routes/activityAccess.js';
import questionRoutes from './routes/questions.js';
import gradeRoutes from './routes/grades.js';
import groupRoutes from './routes/groups.js';
import videoRoutes from './routes/video.js';
import notificationRoutes from './routes/notifications.js';
import aiRoutes, { aiMediaRoutes } from './routes/ai.js';
import { transformApiDocs } from './utils/apiDocs.js';
import { guessImageContentTypeFromKey, normalizeRequestedStorageKey } from './utils/storageUrls.js';
import { ensureSettingsSingleton } from './utils/settingsSingleton.js';
import { registerUserActivityTracking } from './services/userActivity.js';

export async function buildApp(opts = {}) {
  // Resolve config early so proxy trust can be applied at construction time.
  const resolvedConfig = { ...config, ...opts.config };

  const app = Fastify({
    logger: opts.logger !== undefined ? opts.logger : true,
    // Make request.ip reflect the real client behind the reverse proxy so per-IP
    // rate limiting and audit logging are accurate and not X-Forwarded-For
    // spoofable. Configurable via TRUST_PROXY (see config).
    trustProxy: resolvedConfig.trustProxy,
    ...opts,
  });

  // Config
  app.decorate('config', resolvedConfig);

  // Plugins
  await app.register(cors, {
    origin: app.config.rootUrl,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });
  await app.register(formbody);
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: false, // CSP managed by the frontend reverse-proxy / nginx
  });

  if (app.config.disableRateLimits) {
    // Strip per-route rate limit config before @fastify/rate-limit processes routes.
    app.addHook('onRoute', (routeOptions) => {
      if (routeOptions.rateLimit) {
        delete routeOptions.rateLimit;
      }
      if (routeOptions.config?.rateLimit) {
        delete routeOptions.config.rateLimit;
      }
    });
  }

  await app.register(rateLimit, {
    global: false, // only apply to routes that opt-in
  });
  await app.register(jwt, {
    secret: app.config.jwtSecret,
    sign: { expiresIn: '15m' },
  });
  if (app.config.enableApiDocs) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Qlicker API',
          description: 'Fastify API for the Qlicker classroom response system.',
          version: app.config.appVersion,
        },
        servers: [
          { url: app.config.rootUrl },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
            },
          },
        },
      },
      transform: ({ schema, url, route }) => ({
        schema: transformApiDocs({ schema, url, route }),
        url,
      }),
    });
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: false,
      },
      uiHooks: {
        onRequest: requireRoleFromAccessTokenOrRefreshCookie(['admin']),
      },
    });
  }

  // Auth decorators
  app.decorate('authenticate', authenticate);
  app.decorate('requireRole', requireRole);

  // CSRF protection: Require X-Requested-With header on state-changing requests.
  // CORS blocks cross-origin requests from setting custom headers, so this prevents
  // cross-site request forgery. Exempt paths that receive external form posts
  // (SAML callbacks, file uploads via multipart that may lack the header on preflight).
  const CSRF_EXEMPT_PATHS = [
    '/api/v1/auth/sso/callback',
    '/api/v1/auth/sso/logout',
    '/SSO/SAML2',
  ];
  app.addHook('onRequest', async (request, reply) => {
    const method = request.method;
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    if (CSRF_EXEMPT_PATHS.some(p => request.url.startsWith(p))) return;
    if (request.headers['x-requested-with'] !== 'XMLHttpRequest') {
      return reply.code(403).send({ error: 'Forbidden', message: 'Missing CSRF header' });
    }
  });

  // Database (skip in test if opts.skipDb)
  if (!opts.skipDb) {
    await app.register(dbPlugin, { uri: app.config.mongoUri });
    // New independent collections need their unique indexes even when the
    // production Mongo connection has autoIndex disabled.
    await Promise.all([ActivityShare.createIndexes(), ActivityGrant.createIndexes()]);
  }

  try {
    await ensureSettingsSingleton(app.log);
  } catch (err) {
    app.log.error({ err }, 'Failed to enforce settings singleton document');
  }

  // Upload plugin
  await app.register(uploadPlugin);

  // SAML SSO plugin
  await app.register(samlPlugin);

  // Redis pub/sub (skip in test if opts.skipRedis, no-op when REDIS_URL is unset)
  if (!opts.skipRedis) {
    await app.register(redisPlugin);
  }

  // Record at most one Redis heartbeat per authenticated user per minute.
  // The system-monitor sidecar uses these timestamps for a low-cost active-user
  // count without adding database writes to normal classroom requests.
  registerUserActivityTracking(app);

  // WebSocket plugin (skip in test if opts.skipWs)
  if (!opts.skipWs) {
    await app.register(websocketPlugin);
  }

  // Health check
  app.get('/api/v1/health', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' },
            websocket: { type: 'boolean' },
            redis: { type: 'boolean' },
          },
        },
      },
    },
  }, async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    websocket: typeof app.wsSendToUser === 'function',
    redis: typeof app.redis !== 'undefined' && app.redis !== null,
  }));

  // Serve uploaded images from the configured storage backend through a stable app URL.
  app.get('/uploads/*', {
    preHandler: authenticateAccessTokenOrRefreshCookie,
    config: {
      rateLimit: { max: 600, timeWindow: '1 minute' },
    },
    schema: {
      params: {
        type: 'object',
        required: ['*'],
        properties: {
          '*': { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const key = normalizeRequestedStorageKey(request.params['*']);
    if (!key) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Invalid filename' });
    }

    try {
      const { buffer, contentType } = await app.getFileObject(key);
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      // Prevent MIME sniffing so a stored file is only ever interpreted as its
      // declared image content type, never executed as HTML/SVG/script.
      reply.header('X-Content-Type-Options', 'nosniff');
      return reply.type(contentType || guessImageContentTypeFromKey(key)).send(buffer);
    } catch (err) {
      request.log.warn({ err, key }, 'Failed to serve uploaded image');

      const errorName = String(err?.name || '');
      const errorCode = String(err?.code || '');
      const httpStatus = Number(err?.$metadata?.httpStatusCode || err?.statusCode || 0);

      if (errorCode === 'ENOENT' || errorName === 'NoSuchKey' || errorCode === 'NoSuchKey' || errorCode === 'BlobNotFound' || httpStatus === 404) {
        return reply.code(404).send({ error: 'Not Found', message: 'File not found' });
      }

      if (err?.code === 'UPLOAD_CONFIG_ERROR') {
        return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
      }

      return reply.code(500).send({ error: 'Internal Server Error', message: 'Failed to load file' });
    }
  });

  // Routes
  await app.register(legacySamlRoutes);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(userRoutes, { prefix: '/api/v1/users' });
  await app.register(settingsRoutes, { prefix: '/api/v1/settings' });
  await app.register(imageRoutes, { prefix: '/api/v1/images' });
  await app.register(courseRoutes, { prefix: '/api/v1/courses' });
  await app.register(courseChatRoutes, { prefix: '/api/v1' });
  await app.register(aiRoutes, { prefix: '/api/v1/ai' });
  await app.register(aiMediaRoutes, { prefix: '/ai' });
  await app.register(sessionRoutes, { prefix: '/api/v1' });
  await app.register(activityAccessRoutes, { prefix: '/api/v1' });
  await app.register(questionRoutes, { prefix: '/api/v1' });
  await app.register(gradeRoutes, { prefix: '/api/v1' });
  await app.register(groupRoutes, { prefix: '/api/v1/courses' });
  await app.register(videoRoutes, { prefix: '/api/v1/courses' });
  await app.register(notificationRoutes, { prefix: '/api/v1/notifications' });

  return app;
}
