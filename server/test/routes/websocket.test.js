import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { createApp } from '../helpers.js';

let app;
let baseUrl;

function once(target, event) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.off?.(event, handleEvent);
      target.off?.('error', handleError);
    };
    const handleEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const handleError = (err) => {
      cleanup();
      reject(err);
    };

    target.once(event, handleEvent);
    target.once('error', handleError);
  });
}

beforeEach(async () => {
  app = await createApp();
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

describe('WebSocket hardening', () => {
  it('closes connections that exceed the message rate limit', async () => {
    const token = app.jwt.sign({ userId: 'ws-user-1', roles: ['student'] }, { expiresIn: '15m' });
    const socket = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token)}`);

    await once(socket, 'open');

    const closePromise = once(socket, 'close');
    for (let index = 0; index < 61; index += 1) {
      socket.send(JSON.stringify({ event: 'ping', data: { index } }));
    }

    const [code] = await closePromise;
    expect(code).toBe(4408);
  });

  it('closes the connection when the access token expires', async () => {
    const token = app.jwt.sign({ userId: 'ws-user-expiry', roles: ['student'] }, { expiresIn: '1s' });
    const socket = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token)}`);

    await once(socket, 'open');

    const [code] = await once(socket, 'close');
    expect(code).toBe(4401);
  }, 10000);

  it('rejects tokens without an expiry claim', async () => {
    // app.jwt.sign always adds exp; craft a token without one to hit the guard.
    const token = jwt.sign({ userId: 'ws-user-noexp', roles: ['student'] }, 'test-secret');
    const socket = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token)}`);

    const [code] = await once(socket, 'close');
    expect(code).toBe(4401);
  });

  it('wsCloseUser drops every socket belonging to the user', async () => {
    const token = app.jwt.sign({ userId: 'ws-user-disable', roles: ['student'] }, { expiresIn: '15m' });
    const otherToken = app.jwt.sign({ userId: 'ws-user-other', roles: ['student'] }, { expiresIn: '15m' });
    const socketA = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token)}`);
    const socketB = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(token)}`);
    const otherSocket = new WebSocket(`${baseUrl}/ws?token=${encodeURIComponent(otherToken)}`);

    await Promise.all([once(socketA, 'open'), once(socketB, 'open'), once(otherSocket, 'open')]);

    const closes = Promise.all([once(socketA, 'close'), once(socketB, 'close')]);
    app.wsCloseUser('ws-user-disable');

    const [[codeA], [codeB]] = await closes;
    expect(codeA).toBe(4403);
    expect(codeB).toBe(4403);
    expect(otherSocket.readyState).toBe(WebSocket.OPEN);

    otherSocket.close();
  });
});
