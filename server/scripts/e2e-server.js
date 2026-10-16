import fs from 'fs/promises';
import path from 'path';
import os from 'node:os';
import { fileURLToPath } from 'url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildApp } from '../src/app.js';
import { configureTestEnvironment } from '../../scripts/test-environment.mjs';

configureTestEnvironment();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateFile = process.env.QCLICKER_E2E_STATE_FILE || path.join(os.tmpdir(), 'qlicker-e2e-state.json');

let app;
let mongoServer;
let cleanupPromise;

async function writeStateFile(payload) {
  await fs.writeFile(stateFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function cleanup(exitCode = 0) {
  process.exitCode = Math.max(process.exitCode || 0, exitCode);
  if (!cleanupPromise) {
    // Repeated signals must share teardown, never exit while stop is pending.
    cleanupPromise = (async () => {
      try {
        try {
          if (app) await app.close();
        } finally {
          if (mongoServer) await mongoServer.stop();
        }
      } catch (err) {
        console.error('E2E server cleanup failed:', err);
        process.exitCode = 1;
      } finally {
        await fs.rm(stateFile, { force: true }).catch((err) => {
          console.error('E2E state cleanup failed:', err);
          process.exitCode = 1;
        });
      }
      process.exit(process.exitCode || 0);
    })();
  }
  return cleanupPromise;
}

async function start() {
  mongoServer = new MongoMemoryServer();
  await mongoServer.start();
  const mongoUri = mongoServer.getUri();
  const port = Number.parseInt(process.env.PORT || '3001', 10);
  const host = process.env.HOST || '127.0.0.1';
  const rootUrl = process.env.ROOT_URL || 'http://127.0.0.1:3000';

  app = await buildApp({
    logger: false,
    config: {
      mongoUri,
      port,
      host,
      rootUrl,
      nodeEnv: 'test',
      disableRateLimits: true,
      jwtSecret: process.env.JWT_SECRET || 'e2e-secret',
      jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'e2e-refresh-secret',
    },
  });

  await app.listen({ port, host });

  await writeStateFile({
    mongoUri,
    serverBaseUrl: `http://${host}:${port}`,
    docsUrl: `http://${host}:${port}/docs`,
    uploadsDir: app.uploadsDir,
    rootUrl,
  });

  console.log(`Qlicker E2E server ready at http://${host}:${port}`);
}

process.on('SIGINT', () => { cleanup(0); });
process.on('SIGTERM', () => { cleanup(0); });
process.on('uncaughtException', async (err) => {
  console.error(err);
  await cleanup(1);
});
process.on('unhandledRejection', async (err) => {
  console.error(err);
  await cleanup(1);
});

start().catch(async (err) => {
  console.error(err);
  await cleanup(1);
});
