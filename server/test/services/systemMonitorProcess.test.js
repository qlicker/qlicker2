import { spawn } from 'node:child_process';
import { once } from 'node:events';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import SystemMetricSample from '../../src/models/SystemMetricSample.js';
import SystemMonitorEvent from '../../src/models/SystemMonitorEvent.js';

describe('standalone Linux collector', () => {
  it('writes host metrics with TTL indexes and stops promptly while sleeping', async (ctx) => {
    if (mongoose.connection.readyState !== 1 || process.platform !== 'linux') ctx.skip();
    const child = spawn(process.execPath, ['src/systemMonitor.js'], {
      env: {
        ...process.env,
        MONGO_URI: mongoose.connection.getClient().s.url,
        REDIS_URL: '',
        SYSTEM_MONITOR_SAMPLE_INTERVAL_SECONDS: '60',
        SYSTEM_MONITOR_PROC_PATH: '/proc',
        SYSTEM_MONITOR_COLLECTOR_ID: 'process-test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const exit = once(child, 'exit');
    try {
      let sample;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        sample = await SystemMetricSample.findOne({ collectorId: 'process-test' }).lean();
        if (sample) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(sample, output).toBeTruthy();
      expect(sample.cpu.usagePercent).toBeGreaterThanOrEqual(0);
      expect(sample.memory.totalBytes).toBeGreaterThan(0);
      expect(sample.activity.activeUsers).toBeNull();
      expect(sample.expiresAt - sample.timestamp).toBe(7 * 86_400_000);
      const indexes = await SystemMetricSample.collection.indexes();
      expect(indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
      ]));
      child.kill('SIGTERM');
      const stopped = await Promise.race([
        exit,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Collector did not stop within five seconds')), 5000);
          timer.unref();
        }),
      ]);
      expect(stopped[0], output).toBe(0);
      expect(await SystemMonitorEvent.countDocuments({ code: 'collector_stopped' })).toBe(1);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await exit;
    }
  });
});
