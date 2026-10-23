import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import EventEmitter from 'events';
import { buildApp } from '../../src/app.js';

// ── Lightweight in-process Redis mock ──
// This simulates two ioredis instances sharing a bus so that
// PUBLISH on one triggers the 'message' callback on the other.
function createRedisMock() {
  const bus = new EventEmitter();

  function makeMock() {
    const mock = {
      publish(channel, message) {
        bus.emit('published', channel, message);
      },
      subscribe(channel, cb) {
        bus.on('published', (ch, msg) => {
          if (ch === channel) {
            mock.emit('message', ch, msg);
          }
        });
        if (cb) cb(null);
      },
      disconnect() {},
      on: EventEmitter.prototype.on,
      off: EventEmitter.prototype.off,
      once: EventEmitter.prototype.once,
      emit: EventEmitter.prototype.emit,
      removeAllListeners: EventEmitter.prototype.removeAllListeners,
    };
    EventEmitter.call(mock);
    return mock;
  }

  return { pub: makeMock(), sub: makeMock() };
}

function once(target, event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.off?.(event, handleEvent);
      target.off?.('error', handleError);
    };
    const handleEvent = (...args) => { cleanup(); resolve(args); };
    const handleError = (err) => { cleanup(); reject(err); };
    target.once(event, handleEvent);
    target.once('error', handleError);
  });
}

// ── Tests ──

describe('WebSocket with Redis pub/sub', () => {
  let app;
  let baseUrl;
  let redisMock;

  beforeEach(async () => {
    redisMock = createRedisMock();

    app = await buildApp({
      logger: false,
      skipDb: true,
      skipRedis: true,  // we inject the mock manually
      skipWs: true,     // defer WS registration so we can inject Redis first
      config: {
        jwtSecret: 'test-secret',
        jwtRefreshSecret: 'test-refresh-secret',
        rootUrl: 'http://localhost:3000',
        redisUrl: '',
      },
    });

    // Inject mock Redis clients before WebSocket plugin sees them
    app.decorate('redis', redisMock.pub);
    app.decorate('redisSub', redisMock.sub);

    // Now register WebSocket plugin — it will detect Redis decorators
    const websocketPlugin = (await import('../../src/plugins/websocket.js')).default;
    await app.register(websocketPlugin);
    await app.ready();

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    baseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('delivers broadcast messages through Redis pub/sub to connected clients', async () => {
    const token = app.jwt.sign({ userId: 'redis-user-1', roles: ['student'] }, { expiresIn: '15m' });
    const socket = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token)}`);
    await once(socket, 'open');

    const messagePromise = new Promise((resolve) => {
      socket.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.event === 'test:broadcast') {
          resolve(parsed);
        }
      });
    });

    // Trigger a broadcast — should go through Redis
    app.wsBroadcast('test:broadcast', { hello: 'world' });

    const received = await messagePromise;
    expect(received).toEqual({ event: 'test:broadcast', data: { hello: 'world' } });

    socket.close();
  });

  it('delivers targeted user messages through Redis pub/sub', async () => {
    const token = app.jwt.sign({ userId: 'redis-user-2', roles: ['professor'] }, { expiresIn: '15m' });
    const socket = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token)}`);
    await once(socket, 'open');

    const messagePromise = new Promise((resolve) => {
      socket.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.event === 'test:targeted') {
          resolve(parsed);
        }
      });
    });

    app.wsSendToUser('redis-user-2', 'test:targeted', { for: 'you' });

    const received = await messagePromise;
    expect(received).toEqual({ event: 'test:targeted', data: { for: 'you' } });

    socket.close();
  });

  it('delivers messages to multiple users through Redis pub/sub', async () => {
    const token1 = app.jwt.sign({ userId: 'redis-user-3', roles: ['student'] }, { expiresIn: '15m' });
    const token2 = app.jwt.sign({ userId: 'redis-user-4', roles: ['student'] }, { expiresIn: '15m' });
    const socket1 = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token1)}`);
    const socket2 = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token2)}`);
    await Promise.all([once(socket1, 'open'), once(socket2, 'open')]);

    const msg1Promise = new Promise((resolve) => {
      socket1.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.event === 'test:multi') resolve(parsed);
      });
    });
    const msg2Promise = new Promise((resolve) => {
      socket2.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.event === 'test:multi') resolve(parsed);
      });
    });

    app.wsSendToUsers(['redis-user-3', 'redis-user-4'], 'test:multi', { group: true });

    const [received1, received2] = await Promise.all([msg1Promise, msg2Promise]);
    expect(received1).toEqual({ event: 'test:multi', data: { group: true } });
    expect(received2).toEqual({ event: 'test:multi', data: { group: true } });

    socket1.close();
    socket2.close();
  });

  it('closes a user\'s sockets on every instance via the closeUser envelope', async () => {
    const token = app.jwt.sign({ userId: 'redis-user-close', roles: ['student'] }, { expiresIn: '15m' });
    const socket = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token)}`);
    await once(socket, 'open');

    const closePromise = once(socket, 'close');
    app.wsCloseUser('redis-user-close');

    const [code] = await closePromise;
    expect(code).toBe(4403);
  });

  it('does not deliver targeted messages to other users', async () => {
    const token1 = app.jwt.sign({ userId: 'redis-user-5', roles: ['student'] }, { expiresIn: '15m' });
    const token2 = app.jwt.sign({ userId: 'redis-user-6', roles: ['student'] }, { expiresIn: '15m' });
    const socket1 = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token1)}`);
    const socket2 = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token2)}`);
    await Promise.all([once(socket1, 'open'), once(socket2, 'open')]);

    const received = [];
    socket2.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString());
      if (parsed.event === 'test:private') received.push(parsed);
    });

    // Send only to user 5
    app.wsSendToUser('redis-user-5', 'test:private', { secret: true });

    // Wait briefly to ensure no message arrives for user 6
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);

    socket1.close();
    socket2.close();
  });
});

describe('WebSocket without Redis (single-instance fallback)', () => {
  let app;
  let baseUrl;

  beforeEach(async () => {
    app = await buildApp({
      logger: false,
      skipDb: true,
      config: {
        jwtSecret: 'test-secret',
        jwtRefreshSecret: 'test-refresh-secret',
        rootUrl: 'http://localhost:3000',
        redisUrl: '',
      },
    });
    await app.ready();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    baseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it('delivers broadcast messages in-process when Redis is not configured', async () => {
    const token = app.jwt.sign({ userId: 'local-user-1', roles: ['student'] }, { expiresIn: '15m' });
    const socket = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token)}`);
    await once(socket, 'open');

    const messagePromise = new Promise((resolve) => {
      socket.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.event === 'test:local') resolve(parsed);
      });
    });

    app.wsBroadcast('test:local', { mode: 'in-process' });

    const received = await messagePromise;
    expect(received).toEqual({ event: 'test:local', data: { mode: 'in-process' } });

    socket.close();
  });

  it('health endpoint reports redis: false when Redis is not configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.redis).toBe(false);
    expect(body.version).toBeUndefined();
  });
});
