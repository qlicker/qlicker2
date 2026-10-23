import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { createApp, createTestUser, getAuthToken } from '../helpers.js';

let app;

beforeEach(async (ctx) => {
  if (mongoose.connection.readyState !== 1) {
    ctx.skip();
    return;
  }
  app = await createApp();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe('GET /uploads/*', () => {
  it('rejects unauthenticated upload requests', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const res = await app.inject({
      method: 'GET',
      url: '/uploads/legacy-folder/my%20image.png',
    });

    expect(res.statusCode).toBe(401);
  });

  it('serves a proxied upload for bearer-authenticated requests using the decoded storage key', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const user = await createTestUser();
    const token = await getAuthToken(app, user);
    const getFileObject = vi.fn(async (key) => ({
      buffer: Buffer.from('image-bytes'),
      contentType: 'image/png',
    }));
    app.getFileObject = getFileObject;

    const res = await app.inject({
      method: 'GET',
      url: '/uploads/legacy-folder/my%20image.png',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(getFileObject).toHaveBeenCalledWith('legacy-folder/my image.png');
  });

  it('serves a proxied upload for same-origin refresh-cookie requests', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const user = await createTestUser();
    const sessionId = 'session-123';
    const expiresAt = new Date(Date.now() + 60_000);
    user.services.resume.loginTokens = [{
      sessionId,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      expiresAt,
      ipAddress: '',
    }];
    await user.save();

    const refreshToken = jwt.sign(
      { userId: user._id, type: 'refresh', sessionId },
      app.config.jwtRefreshSecret,
      { expiresIn: 60 },
    );

    const getFileObject = vi.fn(async (key) => ({
      buffer: Buffer.from('image-bytes'),
      contentType: 'image/png',
    }));
    app.getFileObject = getFileObject;

    const res = await app.inject({
      method: 'GET',
      url: '/uploads/legacy-folder/my%20image.png',
      cookies: {
        refreshToken,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    expect(getFileObject).toHaveBeenCalledWith('legacy-folder/my image.png');
  });

  it('rejects traversal-style keys', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const user = await createTestUser();
    const token = await getAuthToken(app, user);
    const res = await app.inject({
      method: 'GET',
      url: '/uploads/%2E%2E%2Fsecret.png',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the storage backend reports a missing object', async (ctx) => {
    if (mongoose.connection.readyState !== 1) ctx.skip();

    const user = await createTestUser();
    const token = await getAuthToken(app, user);
    app.getFileObject = vi.fn(async () => {
      const err = new Error('Not found');
      err.name = 'NoSuchKey';
      throw err;
    });

    const res = await app.inject({
      method: 'GET',
      url: '/uploads/missing.png',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(404);
  });
});
