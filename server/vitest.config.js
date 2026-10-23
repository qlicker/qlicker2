import { defineConfig } from 'vitest/config';
import { configureTestEnvironment } from '../scripts/test-environment.mjs';

configureTestEnvironment();

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['./test/setup.js'],
    env: {
      MONGOMS_SYSTEM_BINARY: process.env.MONGOMS_SYSTEM_BINARY || '',
    },
  },
});
