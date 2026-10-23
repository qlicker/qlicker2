import { buildApp } from '../src/app.js';
import User from '../src/models/User.js';

export async function createApp(configOverrides = {}, appOverrides = {}) {
  const {
    logger = false,
    skipDb = true,
    skipRedis = true,
    skipWs = false,
    ...extraAppOptions
  } = appOverrides;
  const app = await buildApp({
    logger,
    skipDb,
    skipRedis,
    skipWs,
    ...extraAppOptions,
    config: {
      jwtSecret: 'test-secret',
      jwtRefreshSecret: 'test-refresh-secret',
      rootUrl: process.env.ROOT_URL || 'http://localhost:3000',
      // Fastify injects requests from loopback. Trust that explicit peer so
      // forwarded-IP audit behavior is exercised without unsafe hop-count trust.
      trustProxy: 'loopback',
      ...configOverrides,
    },
  });
  await app.ready();
  return app;
}

export async function createTestUser(overrides = {}) {
  const defaults = {
    email: 'test@example.com',
    password: 'password123',
    firstname: 'Test',
    lastname: 'User',
    roles: ['student'],
  };
  const data = { ...defaults, ...overrides };
  const hashedPassword = await User.hashPassword(data.password);
  const user = await User.create({
    emails: [{ address: data.email.toLowerCase(), verified: true }],
    services: { password: { hash: hashedPassword } },
    profile: {
      firstname: data.firstname,
      lastname: data.lastname,
      roles: data.roles,
      courses: [],
    },
    createdAt: new Date(),
  });
  return user;
}

export async function getAuthToken(app, user) {
  const token = app.jwt.sign(
    { userId: user._id, roles: user.profile.roles },
    { expiresIn: '15m' }
  );
  return token;
}

export const csrfHeaders = { 'x-requested-with': 'XMLHttpRequest' };

export async function authenticatedRequest(app, method, url, opts = {}) {
  const { token, payload, headers = {} } = opts;
  const reqOpts = {
    method,
    url,
    headers: {
      ...csrfHeaders,
      ...headers,
    },
  };
  if (token) {
    reqOpts.headers.authorization = `Bearer ${token}`;
  }
  if (payload) {
    reqOpts.payload = payload;
    reqOpts.headers['content-type'] = 'application/json';
  }
  return app.inject(reqOpts);
}
