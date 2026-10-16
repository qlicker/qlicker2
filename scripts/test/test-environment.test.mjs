import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { configureTestEnvironment } from '../test-environment.mjs';

configureTestEnvironment();

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qlicker-test-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const envFile = path.join(root, '.env');
  const directory = path.join(root, 'test files');
  await fs.writeFile(envFile, `TEST_TMPDIR="${directory}"\nUNRELATED=do-not-load\n`);
  return { root, directory, envFile };
}

test('loads only test storage from .env and creates the destination', async (t) => {
  const { directory, envFile } = await fixture(t);
  const env = {};
  configureTestEnvironment({ env, envFile });
  assert.deepEqual(env, { TMPDIR: directory, TMP: directory, TEMP: directory });
  assert.ok((await fs.stat(directory)).isDirectory());
});

test('explicit overrides win, including an empty value to keep OS defaults', async (t) => {
  const { root, envFile } = await fixture(t);
  const directory = path.join(root, 'override');
  const env = { TEST_TMPDIR: directory };
  configureTestEnvironment({ env, envFile });
  assert.equal(env.TMPDIR, directory);
  const disabled = { TEST_TMPDIR: '', TMPDIR: root };
  configureTestEnvironment({ env: disabled, envFile });
  assert.deepEqual(disabled, { TEST_TMPDIR: '', TMPDIR: root });
});

test('rejects relative paths and non-directory destinations', async (t) => {
  const { envFile } = await fixture(t);
  assert.throws(() => configureTestEnvironment({ env: { TEST_TMPDIR: 'relative' } }), /absolute path/);
  assert.throws(() => configureTestEnvironment({ env: { TEST_TMPDIR: envFile } }), /not a writable directory/);
});

test('missing .env leaves the existing temporary directory alone', async (t) => {
  const { root } = await fixture(t);
  const env = { TMPDIR: root };
  configureTestEnvironment({ env, envFile: path.join(root, 'missing') });
  assert.deepEqual(env, { TMPDIR: root });
});

test('setup prompt preserves an existing path, accepts spaces, and can clear it', async (t) => {
  const { directory } = await fixture(t);
  const script = fileURLToPath(new URL('../setup-test-tmpdir.sh', import.meta.url));
  for (const [input, expected] of [['\n', directory], ['-\n', ''], [`relative\n${directory}\n`, directory]]) {
    const result = spawnSync('bash', ['-c', 'source "$1"; configure_test_tmpdir; printf "\\nRESULT=%s\\n" "$TEST_TMPDIR"', 'bash', script], {
      env: { ...process.env, TEST_TMPDIR: directory }, input, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.endsWith(`RESULT=${expected}\n`), result.stdout);
  }
});
