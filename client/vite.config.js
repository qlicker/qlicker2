import { defineConfig, loadEnv } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function resolveAppVersion(env) {
  if (typeof env.VITE_APP_VERSION === 'string' && env.VITE_APP_VERSION.trim()) {
    return env.VITE_APP_VERSION.trim();
  }

  try {
    // Local development can read ../VERSION from the repository root.
    const fileVersion = readFileSync(resolve(process.cwd(), '../VERSION'), 'utf8').trim();
    if (fileVersion) return fileVersion;
  } catch {
    // Docker client builds use ./client as the context, so ../VERSION does not exist there.
  }

  const packageVersion = (process.env.npm_package_version || '').trim();
  if (packageVersion) {
    return packageVersion.startsWith('v') ? packageVersion : `v${packageVersion}`;
  }

  return 'dev';
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_URL || 'http://localhost:3001';
  const wsTarget = env.VITE_WS_URL || 'ws://localhost:3001';
  const devPort = parseInt(env.VITE_DEV_PORT || '3000', 10);
  const appVersion = resolveAppVersion(env);

  return {
    plugins: [react()],
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    },
    oxc: {
      jsx: {
        runtime: 'automatic',
        importSource: 'react',
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            if (id.includes('@mui/') || id.includes('@emotion/')) {
              return 'vendor-mui';
            }
            if (id.includes('@tiptap/') || id.includes('katex')) {
              return 'vendor-editor';
            }
            // PDF export libraries. All of these are loaded on demand via a
            // dynamic import() in sessionExport.js, so they never touch the
            // initial page load. html2canvas is a separate module and gets its
            // own chunk; html2pdf.js ships a single pre-bundled dist with jspdf
            // and its codecs (fflate/fast-png) inlined, so it is one indivisible
            // module that cannot be split further via manualChunks.
            if (id.includes('html2canvas')) {
              return 'vendor-html2canvas';
            }
            if (id.includes('jspdf') || id.includes('html2pdf.js')) {
              return 'vendor-jspdf';
            }
            if (id.includes('i18next') || id.includes('react-i18next')) {
              return 'vendor-i18n';
            }
            if (id.includes('react-router')) {
              return 'vendor-router';
            }
            if (id.includes('axios')) {
              return 'vendor-network';
            }
            // React runtime split out of the catch-all so vendor-core stays
            // under the size warning threshold.
            if (
              id.includes('/react-dom/') ||
              id.includes('/react/') ||
              id.includes('/scheduler/')
            ) {
              return 'vendor-react';
            }
            return 'vendor-core';
          },
        },
      },
      // Every eagerly-loaded chunk is now well under 500 kB. The only chunk that
      // exceeds it is vendor-jspdf (~736 kB): the pre-bundled html2pdf.js/jspdf
      // PDF exporter, which is a single indivisible third-party module and is
      // loaded on demand only when a user exports a PDF. Raise the warning limit
      // past it so the build stays warning-clean while still flagging any chunk
      // that grows unexpectedly large.
      chunkSizeWarningLimit: 800,
    },
    server: {
      port: devPort,
      proxy: {
        '/api': apiTarget,
        '/uploads': apiTarget,
        '/ai/media': apiTarget,
        '/ws': {
          target: wsTarget,
          ws: true,
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './test/setup.js',
      exclude: [
        ...configDefaults.exclude,
        'e2e/**',
        'e2e-sso/**',
        'playwright.config.js',
        'playwright.sso.config.js',
      ],
    },
  };
});
