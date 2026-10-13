import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';

async function fixture(t, mode = '') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qlicker-matrix-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'bin'));
  await fs.copyFile(new URL('../matrix.sh', import.meta.url), path.join(root, 'matrix.sh'));
  await fs.writeFile(path.join(root, '.env'), 'LIVE_STATS_DURING_ANSWERS=true\n');
  await fs.writeFile(path.join(root, 'bin/docker'), '#!/bin/sh\necho \'{"Name":"qlicker-load-test","CPUPerc":"10%"}\'\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, 'run.sh'), `#!/usr/bin/env bash
# Deliberately read stdin: must never consume the matrix commands.
cat >/dev/null
printf '%s\\n' "$*" >> calls
case "$1" in
  --prepare) echo original > state/rate-limit-restore.env; [[ "$MATRIX_TEST_MODE" != prepare ]] ;;
  --restore) [[ "$MATRIX_TEST_MODE" != restore ]] || exit 1; rm state/rate-limit-restore.env ;;
  --clean) echo 'Cleanup complete'; [[ "$MATRIX_TEST_MODE" != clean ]] ;;
  --scenario)
    case "$MATRIX_TEST_MODE" in
      threshold) exit 99 ;;
      ingress) exit 10 ;;
      wait) touch waiting; sleep 30 ;;
    esac ;;
esac
`);
  return { root, options: { cwd: root, encoding: 'utf8', env: {
    ...process.env, PATH: `${root}/bin:${process.env.PATH}`, MATRIX_TEST_MODE: mode,
  } } };
}

for (const mode of ['', 'threshold', 'ingress', 'prepare', 'restore', 'clean']) {
  test(`matrix handles ${mode || 'success'}, preserves configuration and records cleanup`, async (t) => {
    const { root, options } = await fixture(t, mode);
    const result = spawnSync('bash', ['matrix.sh', '--students', '20'], options);
    assert.equal(result.status, mode === '' ? 0 : mode === 'ingress' ? 10 : 1, result.stdout + result.stderr);
    const calls = (await fs.readFile(path.join(root, 'calls'), 'utf8')).trim().split('\n');
    assert.equal(calls[0], '--prepare');
    assert.deepEqual(calls.slice(-2), ['--restore', '--clean']);
    const runs = calls.filter((line) => line.startsWith('--scenario'));
    assert.equal(runs.length, mode === 'prepare' ? 0 : mode === 'ingress' ? 1 : 12);
    if (runs.length === 12) {
      assert.equal(runs.filter((line) => line.endsWith('--live-stats off')).length, 6);
      assert.equal(runs.filter((line) => line.endsWith('--live-stats on')).length, 6);
      assert.ok(runs.every((line) => line.includes('--students 20 --session-chat off')));
    }
    assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'LIVE_STATS_DURING_ANSWERS=true\n');
    const files = await fs.readdir(path.join(root, 'results'));
    const summary = await fs.readFile(path.join(root, 'results', files.find((name) => name.endsWith('.tsv'))), 'utf8');
    assert.equal(summary.trim().split('\n').length, runs.length + 1);
    if (mode !== 'restore') await assert.rejects(fs.access(path.join(root, 'state/rate-limit-restore.env')));
    else await fs.access(path.join(root, 'state/rate-limit-restore.env'));
  });
}

test('matrix handles termination and rejects a concurrent matrix', async (t) => {
  const { root, options } = await fixture(t, 'wait');
  const child = spawn('bash', ['matrix.sh', '--students', '20'], { ...options, detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
  for (let i = 0; i < 200; i += 1) {
    if (await fs.access(path.join(root, 'waiting')).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await fs.access(path.join(root, 'waiting'));
  const duplicate = spawnSync('bash', ['matrix.sh', '--students', '20'], options);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /already running/);
  const finished = once(child, 'exit');
  process.kill(-child.pid, 'SIGTERM');
  const [code] = await finished;
  assert.equal(code, 143);
  const calls = (await fs.readFile(path.join(root, 'calls'), 'utf8')).trim().split('\n');
  assert.deepEqual(calls.slice(-2), ['--restore', '--clean']);
  await assert.rejects(fs.access(path.join(root, 'state/rate-limit-restore.env')));
});
