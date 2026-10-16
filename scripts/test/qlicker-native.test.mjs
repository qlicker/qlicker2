import { configureTestEnvironment } from '../test-environment.mjs';
configureTestEnvironment();

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openSync, closeSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const linuxOnly = process.platform !== 'linux';

async function listener() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

async function fixture(t, { disabled = false, failingMonitor = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qlicker-native-test-'));
  const database = await listener();
  const redis = await listener();
  const api = await listener();
  const client = await listener();
  const apiPort = api.address().port;
  const clientPort = client.address().port;
  await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => client.close(r))]);

  for (const dir of ['scripts', 'bin', 'server/src', 'server/node_modules', 'client/node_modules/.bin', '.data']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  await fs.copyFile(path.join(repoRoot, 'scripts/qlicker.sh'), path.join(root, 'scripts/qlicker.sh'));
  await fs.writeFile(path.join(root, 'bin/npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // These must never be started: the fixture supplies existing shared services.
  for (const command of ['mongod', 'redis-server']) {
    await fs.writeFile(path.join(root, 'bin', command), '#!/bin/sh\necho "Unexpected database startup" >&2\nexit 99\n', { mode: 0o755 });
  }
  const serverProgram = `
    import http from 'node:http';
    import fs from 'node:fs';
    const name = process.env.FIXTURE_CLIENT ? 'client' : 'server';
    const server = http.createServer((req, res) => res.end('ok'));
    server.listen(Number(process.env.FIXTURE_CLIENT ? process.env.APP_PORT : process.env.API_PORT), '127.0.0.1');
    process.on('SIGTERM', () => {
      fs.appendFileSync(process.env.FIXTURE_EVENTS, name + ':stopped\\n');
      server.close(() => process.exit(0));
    });
  `;
  await fs.writeFile(path.join(root, 'server/package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(root, 'client/package.json'), '{"type":"module"}');
  await fs.writeFile(path.join(root, 'server/src/server.js'), serverProgram);
  await fs.writeFile(path.join(root, 'client/node_modules/.bin/vite'), `#!/usr/bin/env node
    process.env.FIXTURE_CLIENT = '1';
    ${serverProgram}
  `, { mode: 0o755 });
  await fs.writeFile(path.join(root, 'server/src/systemMonitor.js'), failingMonitor ? 'process.exit(17);' : `
    import fs from 'node:fs';
    fs.writeFileSync(process.env.FIXTURE_MONITOR_ENV, JSON.stringify({
      mongo: process.env.MONGO_URI, redis: process.env.REDIS_URL,
      interval: process.env.SYSTEM_MONITOR_SAMPLE_INTERVAL_SECONDS, args: process.execArgv,
    }));
    console.log('fixture collector started');
    const timer = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => {
      // Exercise a graceful shutdown longer than the old two-second timeout.
      setTimeout(() => {
        fs.appendFileSync(process.env.FIXTURE_EVENTS, 'system-monitor:stopped\\n');
        clearInterval(timer);
        process.exit(0);
      }, 2200);
    });
  `);
  const uri = `mongodb://127.0.0.1:${database.address().port}/native-fixture`;
  const redisUrl = `redis://127.0.0.1:${redis.address().port}`;
  await fs.writeFile(path.join(root, '.env'), [
    `APP_PORT=${clientPort}`, `API_PORT=${apiPort}`, `MONGO_PORT=${database.address().port}`,
    `MONGO_URI=${uri}`, `REDIS_URL=${redisUrl}`, `REDIS_PORT=${redis.address().port}`,
    `SYSTEM_MONITOR_ENABLED=${!disabled}`, 'SYSTEM_MONITOR_SAMPLE_INTERVAL_SECONDS=45',
    `FIXTURE_EVENTS=${root}/events`, `FIXTURE_MONITOR_ENV=${root}/monitor-env.json`,
  ].join('\n') + '\n');

  let sequence = 0;
  const run = async (command) => {
    const logPath = path.join(root, `command-${sequence++}.log`);
    const log = openSync(logPath, 'w');
    const child = spawn('bash', ['scripts/qlicker.sh', command], {
      cwd: root,
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
      // Background app processes inherit file descriptors, not test-runner pipes.
      stdio: ['ignore', log, log],
    });
    closeSync(log);
    const [code] = await once(child, 'exit');
    return { code, output: await fs.readFile(logPath, 'utf8') };
  };
  const pids = async () => (await fs.readFile(path.join(root, '.qlicker.pids'), 'utf8'))
    .trim().split('\n').map((line) => line.split(':'));

  t.after(async () => {
    await run('stop');
    await Promise.all([new Promise((r) => database.close(r)), new Promise((r) => redis.close(r))]);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, run, pids, uri, redisUrl };
}

test('native start/status/restart/stop manages one monitor and stops dependants first', { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  const start = await f.run('start');
  assert.equal(start.code, 0, start.output);
  const first = await f.pids();
  assert.deepEqual(first.map(([name]) => name), ['server', 'client', 'system-monitor']);
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'monitor-env.json')));
  assert.deepEqual(config, { mongo: f.uri, redis: f.redisUrl, interval: '45', args: ['--max-old-space-size=64'] });
  assert.match(await fs.readFile(path.join(f.root, '.data/system-monitor.log'), 'utf8'), /fixture collector started/);
  assert.match((await f.run('status')).output, /\[RUNNING\] system-monitor/);
  assert.equal((await f.run('start')).code, 1, 'duplicate start should be refused');
  const restart = await f.run('restart');
  assert.equal(restart.code, 0, restart.output);
  assert.notEqual((await f.pids()).at(-1)[1], first.at(-1)[1]);
  const stop = await f.run('stop');
  assert.equal(stop.code, 0, stop.output);
  assert.deepEqual((await fs.readFile(path.join(f.root, 'events'), 'utf8')).trim().split('\n'), [
    'system-monitor:stopped', 'client:stopped', 'server:stopped',
    'system-monitor:stopped', 'client:stopped', 'server:stopped',
  ]);
  await assert.rejects(fs.access(path.join(f.root, '.data/system-monitor.pid')));
  assert.equal((await f.run('stop')).code, 0, 'stop is idempotent');
  assert.equal((await f.run('restart')).code, 0, 'restart also starts a stopped stack with no PID file');
});

test('a missing main PID file does not duplicate or strand the collector', { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run('start')).code, 0);
  await fs.unlink(path.join(f.root, '.qlicker.pids'));
  assert.match((await f.run('status')).output, /Orphan system-monitor/);
  assert.match((await f.run('start')).output, /system monitor is already running/);
  const stop = await f.run('stop');
  assert.equal(stop.code, 0, stop.output);
  assert.match(stop.output, /Stopped system-monitor/);
  await assert.rejects(fs.access(path.join(f.root, '.data/system-monitor.pid')));
});

test('a collector missing from a partial PID list still stops before app services', { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run('start')).code, 0);
  const appPids = (await f.pids()).filter(([name]) => name !== 'system-monitor');
  await fs.writeFile(path.join(f.root, '.qlicker.pids'), appPids.map((entry) => entry.join(':')).join('\n') + '\n');
  assert.match((await f.run('status')).output, /\[RUNNING\] system-monitor/);
  assert.equal((await f.run('stop')).code, 0);
  assert.deepEqual((await fs.readFile(path.join(f.root, 'events'), 'utf8')).trim().split('\n'), [
    'system-monitor:stopped', 'client:stopped', 'server:stopped',
  ]);
});

test('disabled or failed monitoring leaves app services usable', { skip: linuxOnly }, async (t) => {
  for (const options of [{ disabled: true }, { failingMonitor: true }]) {
    await t.test(JSON.stringify(options), async (st) => {
      const f = await fixture(st, options);
      const start = await f.run('start');
      assert.equal(start.code, 0, start.output);
      const status = (await f.run('status')).output;
      assert.match(status, /\[RUNNING\] server/);
      assert.match(status, /\[RUNNING\] client/);
      assert.match(status, options.disabled ? /\[DISABLED\] system-monitor/ : /\[STOPPED\] system-monitor/);
    });
  }
});

test('stale collector PIDs cannot kill an unrelated process', { skip: linuxOnly }, async (t) => {
  const f = await fixture(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { unrelated.kill(); });
  await fs.writeFile(path.join(f.root, '.qlicker.pids'), `system-monitor:${unrelated.pid}\n`);
  await fs.writeFile(path.join(f.root, '.data/system-monitor.pid'), `${unrelated.pid}\n`);
  assert.equal((await f.run('stop')).code, 0);
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
});
