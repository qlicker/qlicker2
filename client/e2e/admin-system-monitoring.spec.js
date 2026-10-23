import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { expectNoCriticalAccessibilityViolations, loginViaUi, readE2eState, seedUsers } from './helpers.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(repoRoot, 'server/package.json'));
const { MongoClient } = require('mongodb');

test.use({ hasTouch: true });

test('admin can correlate host load and user activity on desktop and mobile', async ({ page, request }) => {
  const { admin } = await seedUsers(request);
  const { mongoUri } = await readE2eState();
  const mongo = await MongoClient.connect(mongoUri);
  // Example data is written only to the isolated, ephemeral E2E database.
  try {
    const now = Date.now();
    const samples = Array.from({ length: 360 }, (_, index) => {
      const peak = Math.exp(-(((index - 210) / 48) ** 2));
      const users = Math.round(18 + peak * 240);
      return {
        timestamp: new Date(now - (359 - index) * 60_000),
        expiresAt: new Date(now + 7 * 86_400_000), collectorId: 'teaching-host', sampleIntervalSeconds: 60,
        cpu: { usagePercent: 12 + peak * 66, cores: 4, load1: 0.6 + peak * 2.4 },
        memory: { usedPercent: 35 + peak * 26, totalBytes: 8 * 1024 ** 3,
          usedBytes: ((35 + peak * 26) / 100) * 8 * 1024 ** 3,
          availableBytes: ((65 - peak * 26) / 100) * 8 * 1024 ** 3 },
        network: { interfaces: ['eth0'], receivedBytesPerSecond: 25_000 + peak * 800_000,
          transmittedBytesPerSecond: 60_000 + peak * 2_200_000 },
        activity: { activeUsers: users, activeStudents: users - 5, activeProfessors: 4,
          activeAdmins: 1, windowMinutes: 15, source: 'redis' },
      };
    });
    await mongo.db().collection('systemMetricSamples').insertMany(samples);
    await mongo.db().collection('systemMonitorEvents').insertOne({
      timestamp: new Date(now - 360 * 60_000), expiresAt: new Date(now + 7 * 86_400_000),
      collectorId: 'teaching-host', level: 'info', code: 'collector_started', message: 'System monitor started',
    });
  } finally {
    await mongo.close();
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginViaUi(page, admin.email, admin.password, /\/admin$/);
  await page.getByRole('tab', { name: 'Usage Statistics' }).click();
  await expect(page.getByText('Collecting', { exact: true })).toBeVisible();
  await expect(page.getByText(/not Qlicker alone/)).toBeVisible();
  await expect(page.getByText('Interfaces: eth0', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /^CPU and memory history/ })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Peak periods' }).getByRole('row')).toHaveCount(6);
  await expect(page.getByText('System monitor started')).toBeVisible();
  await page.getByRole('button', { name: '7 days', exact: true }).click();
  await expect(page.getByRole('button', { name: '7 days', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const resourceChart = page.getByRole('img', { name: /^CPU and memory history/ });
  for (const name of [/^CPU and memory history/, /^Active-user history/, /^Network traffic history/]) {
    const chart = page.getByRole('img', { name });
    await chart.scrollIntoViewIfNeeded();
    const bounds = await chart.boundingBox();
    await chart.hover({ position: { x: bounds.width * 0.5, y: bounds.height * 0.45 } });
    await expect(page.getByRole('status').filter({ hasText: 'Time bucket:' })).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.getByText(/^Time bucket:/)).toHaveCount(0);
  }
  await resourceChart.focus();
  await page.keyboard.press('Home');
  const firstReadout = await page.getByRole('status').filter({ hasText: 'Time bucket:' }).textContent();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('status').filter({ hasText: 'Time bucket:' })).not.toHaveText(firstReadout);
  await expect(page.getByRole('status').filter({ hasText: 'Time bucket:' })).toContainText('CPU:');
  await expect(page.getByRole('status').filter({ hasText: 'Time bucket:' })).toContainText('Memory:');
  await expectNoCriticalAccessibilityViolations(page);

  if (process.env.QCLICKER_CAPTURE_MANUALS === '1') {
    const imagePath = path.join(repoRoot, 'docs/assets/manuals/admin-system-monitoring.png');
    await page.getByRole('region', { name: 'System monitoring', exact: true }).screenshot({ path: imagePath });
    await fs.copyFile(imagePath, path.join(repoRoot, 'client/public/manuals/admin-system-monitoring.png'));
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape');
  await resourceChart.scrollIntoViewIfNeeded();
  await resourceChart.tap({ position: { x: 200, y: 80 } });
  await expect(page.getByRole('status').filter({ hasText: 'Time bucket:' })).toBeVisible();
  await expect(page.getByRole('button', { name: '6 hours', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expectNoCriticalAccessibilityViolations(page);
});
