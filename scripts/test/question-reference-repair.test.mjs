import { configureTestEnvironment } from '../test-environment.mjs';
configureTestEnvironment();

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const source = fileURLToPath(new URL('../../production_setup/repair-question-references.sh', import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qlicker-repair-shell-'));
  const production = path.join(root, 'production setup');
  const bin = path.join(root, 'bin');
  await fs.mkdir(production);
  await fs.mkdir(bin);
  await fs.copyFile(source, path.join(production, 'repair-question-references.sh'));
  await fs.writeFile(path.join(production, 'docker-compose.yml'), 'services: {}\n');
  await fs.writeFile(path.join(production, '.env'), 'MONGO_URI=must-not-be-printed\n');
  await fs.writeFile(path.join(bin, 'node'), '#!/bin/sh\necho "Host node was invoked" >&2\nexit 99\n', { mode: 0o755 });
  await fs.writeFile(path.join(bin, 'docker'), `#!/bin/bash
printf 'CALL\\0' >> "$REPAIR_TEST_LOG"
printf '%s\\0' "$@" >> "$REPAIR_TEST_LOG"
case "$*" in
  *version) exit 0 ;;
  *'ps --all --quiet server') printf '%s' "\${REPAIR_TEST_RUNNING:-}"; exit 0 ;;
  inspect*) printf '%s' "\${REPAIR_TEST_STATE:-running}"; exit 0 ;;
  *'run --rm --no-deps'*) echo 'Docker worker invoked'; exit "\${REPAIR_TEST_EXIT:-0}" ;;
  *) echo 'Unexpected Docker command' >&2; exit 98 ;;
esac
`, { mode: 0o755 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(production, 'repair-question-references.sh');
  const log = path.join(root, 'calls');
  async function run(args = [], { tty = false, input = '', running = '', state = 'running', exit = 0 } = {}) {
    const child = spawn(tty ? 'script' : 'bash', tty
      ? ['-q', '-e', '-c', ['bash', script, ...args].map(quote).join(' '), '/dev/null']
      : [script, ...args], {
      cwd: '/tmp',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REPAIR_TEST_LOG: log, REPAIR_TEST_RUNNING: running, REPAIR_TEST_STATE: state, REPAIR_TEST_EXIT: String(exit) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.stdin.end(input);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    const calls = (await fs.readFile(log, 'utf8').catch(() => '')).split('CALL\0').slice(1).map((call) => call.split('\0').filter(Boolean));
    return { code, output, calls };
  }
  return { production, run };
}

test('diagnostic runs entirely through the production Docker project, without host Node', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['--course', 'course with spaces']);
  assert.equal(result.code, 0, result.output);
  const run = result.calls.at(-1);
  assert.deepEqual(run.slice(0, 5), ['compose', '--project-directory', f.production, '-f', path.join(f.production, 'docker-compose.yml')]);
  assert.deepEqual(run.slice(5, 11), ['run', '--rm', '--no-deps', '-T', 'server', 'sh']);
  assert.deepEqual(run.slice(-2), ['--course', 'course with spaces']);
  assert.match(run.join(' '), /node scripts\/repair-question-references.js/);
  assert.doesNotMatch(result.output, /must-not-be-printed|Host node/);
});

test('worker exit status is preserved', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run(['--json'], { exit: 2 })).code, 2);
});

test('repair cannot run unattended', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['--repair']);
  assert.equal(result.code, 1);
  assert.match(result.output, /requires an interactive terminal/);
  assert.equal(result.calls.some((call) => call.includes('run')), false);
});

test('repair refuses any running server replica', { skip: process.platform !== 'linux' }, async (t) => {
  const f = await fixture(t);
  const result = await f.run(['--repair'], { tty: true, running: 'replica-one\nreplica-two' });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /stop ALL app server replicas/);
  assert.equal(result.calls.some((call) => call.includes('run')), false);
});

test('repair uses a terminal in Docker after maintenance confirmation', { skip: process.platform !== 'linux' }, async (t) => {
  const f = await fixture(t);
  const result = await f.run(['--repair'], { tty: true, input: 'READY\n' });
  assert.equal(result.code, 0, result.output);
  assert.ok(result.calls.at(-1).includes('--interactive'));
  assert.equal(result.calls.at(-1).includes('-T'), false);
});

test('declining maintenance confirmation makes no changes', { skip: process.platform !== 'linux' }, async (t) => {
  const f = await fixture(t);
  const result = await f.run(['--repair'], { tty: true, input: 'no\n' });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Cancelled; no data changed/);
  assert.equal(result.calls.some((call) => call.includes('run')), false);
});


test('repair also refuses restarting server replicas', { skip: process.platform !== 'linux' }, async (t) => {
  const f = await fixture(t);
  const result = await f.run(['--repair'], { tty: true, running: 'replica-one', state: 'restarting' });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.calls.some((call) => call.includes('run')), false);
});

test('stopped containers do not block the repair wizard', { skip: process.platform !== 'linux' }, async (t) => {
  const f = await fixture(t);
  const result = await f.run(['--repair'], { tty: true, running: 'replica-one', state: 'exited', input: 'READY\n' });
  assert.equal(result.code, 0, result.output);
  assert.ok(result.calls.at(-1).includes('--interactive'));
});
