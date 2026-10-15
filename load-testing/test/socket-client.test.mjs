import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSocketConnector } from '../scenarios/socket-client.js';

function fixture() {
  let ws;
  const active = new Map();
  let nextId = 0;
  const timers = {
    setTimeout: (fn) => { const id = ++nextId; active.set(id, () => { active.delete(id); fn(); }); return id; },
    setInterval: (fn) => { active.set(++nextId, fn); return nextId; },
    clearTimeout: (id) => active.delete(id), clearInterval: (id) => active.delete(id),
  };
  class MockWebSocket {
    constructor() { ws = this; this.listeners = {}; this.sent = []; this.readyState = 0; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name, value = {}) {
      if (name === 'open') this.readyState = 1;
      if (name === 'close') this.readyState = 3;
      for (const fn of this.listeners[name] || []) fn(value);
    }
    send(value) { this.sent.push(value); }
    close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
  }
  return { connect: createSocketConnector(MockWebSocket, timers), active, socket: () => ws };
}

test('socket callbacks run while an answer promise is pending, and close waits for that answer', async () => {
  const f = fixture();
  let completeHttp;
  let settled = false;
  const messages = [];
  const lifetime = f.connect('ws://test', (socket) => {
    socket.on('open', () => socket.send('ping'));
    socket.on('message', (raw) => messages.push(raw));
    socket.setTimeout(() => new Promise((resolve) => { completeHttp = resolve; }), 1);
    socket.setInterval(() => {}, 1000);
  });
  lifetime.then(() => { settled = true; });
  const ws = f.socket();
  ws.emit('open');
  f.active.get(1)();
  ws.emit('message', { data: 'stats update' });
  assert.deepEqual(messages, ['stats update']);
  assert.deepEqual(ws.sent, ['ping']);
  ws.close();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(f.active.size, 0);
  completeHttp();
  assert.equal((await lifetime).status, 101);
});

test('failed handshake resolves as failure and clears scheduled timers', async () => {
  const f = fixture();
  let errors = 0;
  const lifetime = f.connect('ws://test', (socket) => {
    socket.setTimeout(() => {}, 1000);
    socket.on('error', () => { errors += 1; });
  });
  f.socket().emit('error', { error: 'handshake rejected' });
  assert.equal((await lifetime).status, 0);
  assert.equal(errors, 1);
  assert.equal(f.active.size, 0);
});

test('a rejected HTTP callback fails the flow instead of reporting a successful completion', async () => {
  const f = fixture();
  const lifetime = f.connect('ws://test', (socket) => {
    socket.setTimeout(async () => { throw new Error('HTTP callback failed'); }, 1);
  });
  f.socket().emit('open');
  f.active.get(1)();
  await assert.rejects(lifetime, /HTTP callback failed/);
  assert.equal(f.active.size, 0);
  assert.equal(f.socket().closed, true);
});

test('a synchronous message handler failure also closes the socket and fails the flow', async () => {
  const f = fixture();
  const lifetime = f.connect('ws://test', (socket) => {
    socket.on('message', () => { throw new Error('invalid snapshot'); });
    socket.setInterval(() => {}, 1000);
  });
  f.socket().emit('message', { data: '{}' });
  await assert.rejects(lifetime, /invalid snapshot/);
  assert.equal(f.active.size, 0);
});

test('requesting close immediately cancels timers while the native close event is still pending', async () => {
  const f = fixture();
  let client;
  const lifetime = f.connect('ws://test', (socket) => {
    client = socket;
    socket.setInterval(() => socket.send('ping'), 1000);
  });
  const ws = f.socket();
  ws.emit('open');
  // Model the asynchronous browser/k6 closing handshake, not an instant close.
  ws.close = () => { ws.readyState = 2; };
  const queuedTick = f.active.get(1);
  client.close();
  assert.equal(f.active.size, 0);
  queuedTick();
  client.send('late ping');
  client.setTimeout(() => {}, 1000);
  client.setInterval(() => {}, 1000);
  assert.equal(f.active.size, 0);
  assert.deepEqual(ws.sent, []);
  ws.emit('close');
  assert.equal((await lifetime).status, 101);
});
