import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'node:os';
import { configureTestEnvironment } from '../scripts/test-environment.mjs';

configureTestEnvironment();

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(configDir, '..');
const stateFile = process.env.QCLICKER_E2E_STATE_FILE || path.join(os.tmpdir(), 'qlicker-e2e-state.json');

function readLocalEnv(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.split(/\r?\n/).reduce((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return acc;
      const separatorIndex = trimmed.indexOf('=');
      if (separatorIndex === -1) return acc;
      const key = trimmed.slice(0, separatorIndex).trim();
      const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');
      acc[key] = value;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

export function createPlaywrightConfig(testDir) {
  const localEnv = readLocalEnv(path.join(repoRoot, '.env'));
  const appPort = process.env.APP_PORT || localEnv.APP_PORT || '3000';
  const apiPort = process.env.API_PORT || localEnv.API_PORT || '3001';
  const baseURL = `http://127.0.0.1:${appPort}`;
  const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
  const wsBaseUrl = `ws://127.0.0.1:${apiPort}`;

  return defineConfig({
    testDir,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 120_000,
    expect: {
      timeout: 10_000,
    },
    use: {
      baseURL,
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      video: 'retain-on-failure',
    },
    webServer: [
      {
        command: 'exec node scripts/e2e-server.js',
        cwd: path.join(repoRoot, 'server'),
        env: { QCLICKER_E2E_STATE_FILE: stateFile, ROOT_URL: baseURL, HOST: '127.0.0.1', PORT: apiPort },
        url: `${apiBaseUrl}/api/v1/health`,
        reuseExistingServer: false,
        timeout: 120_000,
        // Let the server await MongoDB shutdown and remove its temporary DB.
        gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
      },
      {
        command: `npm run dev -- --host 127.0.0.1 --port ${appPort}`,
        cwd: path.join(repoRoot, 'client'),
        env: { QCLICKER_E2E_STATE_FILE: stateFile, VITE_API_URL: apiBaseUrl, VITE_WS_URL: wsBaseUrl },
        url: `${baseURL}/login`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
    ],
    projects: [
      {
        name: 'chromium',
        use: { ...devices['Desktop Chrome'] },
      },
    ],
  });
}
