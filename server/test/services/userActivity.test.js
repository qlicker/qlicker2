import { describe, expect, it, vi } from 'vitest';
import { getActiveUserRedisKey, registerUserActivityTracking } from '../../src/services/userActivity.js';

describe('user activity tracking', () => {
  it('publishes throttled per-role heartbeats without awaiting Redis', async () => {
    const pipeline = {
      zadd: vi.fn(() => pipeline),
      expire: vi.fn(() => pipeline),
      exec: vi.fn().mockResolvedValue([]),
    };
    const closeHooks = [];
    const app = {
      redis: { pipeline: () => pipeline },
      log: { debug: vi.fn() },
      decorate: vi.fn((name, value) => { app[name] = value; }),
      addHook: vi.fn((name, hook) => { if (name === 'onClose') closeHooks.push(hook); }),
    };
    let nowMs = 1_000_000;
    registerUserActivityTracking(app, { now: () => nowMs, publishThrottleMs: 60_000 });

    app.recordAuthenticatedActivity({ userId: 'user-1', roles: ['student', 'student'] });
    app.recordAuthenticatedActivity({ userId: 'user-1', roles: ['student'] });

    expect(pipeline.zadd).toHaveBeenCalledTimes(2);
    expect(pipeline.zadd).toHaveBeenCalledWith(getActiveUserRedisKey('all'), nowMs, 'user-1');
    expect(pipeline.zadd).toHaveBeenCalledWith(getActiveUserRedisKey('student'), nowMs, 'user-1');
    expect(pipeline.exec).toHaveBeenCalledTimes(1);

    nowMs += 60_000;
    app.recordAuthenticatedActivity({ userId: 'user-1', roles: ['student'] });
    expect(pipeline.exec).toHaveBeenCalledTimes(2);

    await closeHooks[0]();
  });

  it('is a no-op when Redis is not configured', () => {
    const app = {
      log: { debug: vi.fn() },
      decorate: vi.fn((name, value) => { app[name] = value; }),
      addHook: vi.fn(),
    };
    registerUserActivityTracking(app);

    expect(() => app.recordAuthenticatedActivity({ userId: 'user-1', roles: ['student'] })).not.toThrow();
  });

  it('drops monitoring heartbeats while Redis reconnects and resumes on recovery', () => {
    const pipeline = { zadd: vi.fn(), expire: vi.fn(), exec: vi.fn().mockResolvedValue([]) };
    const app = {
      redis: { status: 'reconnecting', pipeline: () => pipeline },
      log: { debug: vi.fn() },
      decorate: (name, value) => { app[name] = value; },
      addHook: vi.fn(),
    };
    registerUserActivityTracking(app);
    app.recordAuthenticatedActivity({ userId: 'user-1' });
    expect(pipeline.exec).not.toHaveBeenCalled();
    app.redis.status = 'ready';
    app.recordAuthenticatedActivity({ userId: 'user-1' });
    expect(pipeline.exec).toHaveBeenCalledOnce();
  });
});
