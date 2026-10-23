import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { configureTestEnvironment } from '../test-environment.mjs';
import { createPlaywrightConfig } from '../../client/playwright.shared.js';

configureTestEnvironment();
const serverScript = fileURLToPath(new URL('../../server/scripts/e2e-server.js', import.meta.url));

async function startServer(t, port = '0') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qlicker-cleanup-'));
  const stateFile = path.join(root, 'state.json');
  const child = spawn(process.execPath, [serverScript], {
    env: { ...process.env, TEST_TMPDIR: root, QCLICKER_E2E_STATE_FILE: stateFile, PORT: port, REDIS_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try { await closed; } finally { clearTimeout(timeout); }
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, stateFile, child, closed, output: () => output };
}

test('Playwright allows the MongoDB owner to finish graceful shutdown', () => {
  const config = createPlaywrightConfig('./e2e');
  assert.deepEqual(config.webServer[0].gracefulShutdown, { signal: 'SIGTERM', timeout: 30_000 });
  assert.match(config.webServer[0].command, /exec node scripts\/e2e-server\.js/);
});

test('SIGTERM waits for MongoDB to stop and removes its temporary database', { timeout: 45_000 }, async (t) => {
  const server = await startServer(t);
  await new Promise((resolve, reject) => {
    server.child.stdout.on('data', () => {
      if (server.output().includes('Qlicker E2E server ready')) resolve();
    });
    server.closed.then(() => reject(new Error(server.output())), reject);
  });
  assert.ok((await fs.readdir(server.root)).some((name) => name.startsWith('mongo-mem-')));
  server.child.kill('SIGTERM');
  // Exercise repeated shutdown requests while app.close()/mongoServer.stop() await.
  server.child.kill('SIGINT');
  const [code, signal] = await server.closed;
  assert.equal(code, 0, server.output());
  assert.equal(signal, null);
  assert.deepEqual(await fs.readdir(server.root), []);
});

test('startup failure also removes the database', { timeout: 45_000 }, async (t) => {
  const server = await startServer(t, '-1');
  const [code] = await server.closed;
  assert.equal(code, 1, server.output());
  assert.match(server.output(), /ERR_SOCKET_BAD_PORT/);
  assert.deepEqual(await fs.readdir(server.root), []);
});
