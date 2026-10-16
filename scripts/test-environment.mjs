import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseEnv } from 'node:util';

// Imported only by test entry points, never by the running application.
export function configureTestEnvironment({ env = process.env, envFile = new URL('../.env', import.meta.url) } = {}) {
  let localEnv = {};
  if (env.TEST_TMPDIR === undefined) {
    try {
      localEnv = parseEnv(readFileSync(envFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const directory = (env.TEST_TMPDIR ?? localEnv.TEST_TMPDIR ?? '').trim();
  if (!directory) return;
  if (!isAbsolute(directory)) throw new Error('TEST_TMPDIR must be an absolute path.');
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    accessSync(directory, constants.W_OK | constants.X_OK);
  } catch (cause) {
    throw new Error(`TEST_TMPDIR is not a writable directory: ${directory}`, { cause });
  }
  env.TMPDIR = directory;
  env.TMP = directory;
  env.TEMP = directory;
}
