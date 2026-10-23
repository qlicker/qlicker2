import { describe, expect, it, vi } from 'vitest';
import {
  aggregateSystemMetricSamples,
  buildSystemMetricSample,
  buildSystemMonitoringResponse,
  calculateCpuUsage,
  parseCpuStat,
  parseDefaultRouteInterfaces,
  parseLoadavg,
  parseMeminfo,
  parseNetworkDev,
  readActiveUserCounts,
} from '../../src/services/systemMetrics.js';

describe('system metrics collection', () => {
  it('uses available host RAM rather than treating all cached RAM as used', () => {
    const memory = parseMeminfo([
      'MemTotal: 67108864 kB', 'MemFree: 8388608 kB',
      'MemAvailable: 25165824 kB', 'Buffers: 1048576 kB', 'Cached: 20971520 kB',
    ].join('\n'));
    expect(memory.totalBytes).toBe(64 * 1024 ** 3);
    expect(memory.availableBytes).toBe(24 * 1024 ** 3);
    expect(memory.usedBytes).toBe(40 * 1024 ** 3);
    expect(memory.usedPercent).toBe(62.5);
  });

  it('normalizes CPU across all cores and excludes idle and iowait', () => {
    const before = parseCpuStat('cpu 100 0 0 1000 50 0 0 0 25 0');
    // One fully busy core among 16; guest counters are already included in user.
    const after = parseCpuStat('cpu 200 0 0 2400 150 0 0 0 125 0');
    expect(calculateCpuUsage(before, after)).toBe(6.25);
  });

  it('does not add VPN traffic to the uplink carrying the same packets', () => {
    const routes = [
      'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT',
      'tun0 00000000 0100620A 0003 0 0 50 00000000 0 0 0',
      'wlp4s0 00000000 0101A8C0 0003 0 0 600 00000000 0 0 0',
      'wlp4s0 00000000 0101A8C0 0003 0 0 601 00000000 0 0 0',
      'eth1 00000000 00000000 0001 0 0 10 00000080 0 0 0',
      'eth2 00000000 00000000 0000 0 0 10 00000000 0 0 0',
      'eth3 00000000 00000000 0201 0 0 10 00000000 0 0 0',
    ].join('\n');
    expect(parseDefaultRouteInterfaces(routes)).toEqual(['wlp4s0']);
    const dev = [
      'header', 'header',
      'tun0: 900 0 0 0 0 0 0 0 1800 0 0 0 0 0 0 0',
      'wlp4s0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0',
    ].join('\n');
    expect(parseNetworkDev(dev, parseDefaultRouteInterfaces(routes))).toEqual({
      interfaces: ['wlp4s0'], receivedBytes: 1000, transmittedBytes: 2000,
    });
    // Explicit tunnel selection is still supported.
    expect(parseNetworkDev(dev, ['tun0', 'tun0']).receivedBytes).toBe(900);
    expect(parseNetworkDev(dev, ['missing'])).toEqual({
      interfaces: [], receivedBytes: null, transmittedBytes: null,
    });
    expect(parseNetworkDev(dev, ['wlp4s0', 'missing']).receivedBytes).toBeNull();
    expect(parseNetworkDev(dev).interfaces).toEqual(['wlp4s0']);
  });

  it('selects only one tunnel if no non-tunnel default route exists', () => {
    expect(parseDefaultRouteInterfaces([
      'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT',
      'tun0 00000000 0100620A 0003 0 0 50 00000000 0 0 0',
      'wg0 00000000 00000000 0001 0 0 20 00000000 0 0 0',
    ].join('\n'))).toEqual(['wg0']);
  });

  it('uses monotonic elapsed time for network rates and leaves resets or interface changes as gaps', () => {
    const previous = {
      measuredAtMs: 100_000, monotonicAtMs: 1000,
      network: { interfaces: ['eth0'], receivedBytes: 1000, transmittedBytes: 2000 },
    };
    const current = {
      // A backwards wall-clock adjustment must not inflate or erase the rate.
      measuredAtMs: 90_000, monotonicAtMs: 11_000,
      network: { interfaces: ['eth0'], receivedBytes: 3000, transmittedBytes: 7000 },
    };
    expect(buildSystemMetricSample(previous, current).network).toMatchObject({
      receivedBytesPerSecond: 200, transmittedBytesPerSecond: 500,
    });
    expect(buildSystemMetricSample(previous, {
      ...current, network: { ...current.network, receivedBytes: 100 },
    }).network.receivedBytesPerSecond).toBeNull();
    expect(buildSystemMetricSample(previous, {
      ...current, network: { ...current.network, interfaces: ['eth1'] },
    }).network.receivedBytesPerSecond).toBeNull();
    expect(buildSystemMetricSample(previous, {
      ...current, network: { interfaces: [], receivedBytes: null, transmittedBytes: null },
    }).network.receivedBytesPerSecond).toBeNull();
  });

  it('does not turn missing activity into zero or bridge collection outages', () => {
    const history = aggregateSystemMetricSamples([
      { timestamp: '2026-09-08T15:00:00Z', cpu: { usagePercent: 50 }, activity: { activeUsers: null } },
      { timestamp: '2026-09-08T15:10:00Z', cpu: { usagePercent: 60 } },
    ]);
    expect(history).toHaveLength(3);
    expect(history[0].activeUsers).toBeNull();
    expect(history[1]).toMatchObject({ cpuPercent: null, activeUsers: null, samples: 0 });
    expect(parseCpuStat('cpu 100 10 20 870 0 0 0 0 30 5').total).toBe(1000);
    expect(calculateCpuUsage({ total: 1000, idle: 500 }, { total: 900, idle: 450 })).toBeNull();
  });

  it('parses Linux host counters and calculates rates from cumulative values', () => {
    const previousCpu = parseCpuStat('cpu  100 0 50 850 0 0 0 0\ncpu0 1 0 1 8\ncpu1 1 0 1 8\n');
    const currentCpu = parseCpuStat('cpu  160 0 70 970 0 0 0 0\ncpu0 1 0 1 8\ncpu1 1 0 1 8\n');
    expect(previousCpu.cores).toBe(2);
    expect(calculateCpuUsage(previousCpu, currentCpu)).toBe(40);

    expect(parseMeminfo('MemTotal:       1000 kB\nMemAvailable:    250 kB\n')).toEqual({
      totalBytes: 1_024_000,
      availableBytes: 256_000,
      usedBytes: 768_000,
      usedPercent: 75,
    });
    expect(parseLoadavg('1.25 0.75 0.50 1/100 123')).toEqual({
      load1: 1.25,
      load5: 0.75,
      load15: 0.5,
    });
    expect(parseDefaultRouteInterfaces([
      'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT',
      'eth0 00000000 0100000A 0003 0 0 0 00000000 0 0 0',
    ].join('\n'))).toEqual(['eth0']);

    const network = parseNetworkDev([
      'Inter-| Receive | Transmit',
      ' face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed',
      ' eth0: 1000 1 0 0 0 0 0 0 2000 1 0 0 0 0 0 0',
      ' veth123: 9000 1 0 0 0 0 0 0 8000 1 0 0 0 0 0 0',
    ].join('\n'), ['eth0']);
    expect(network).toEqual({ interfaces: ['eth0'], receivedBytes: 1000, transmittedBytes: 2000 });

    const previous = {
      measuredAtMs: 1_000,
      cpuCounters: previousCpu,
      network,
    };
    const current = {
      measuredAtMs: 11_000,
      cpuCounters: currentCpu,
      memory: parseMeminfo('MemTotal:       1000 kB\nMemAvailable:    250 kB\n'),
      load: parseLoadavg('1.25 0.75 0.50 1/100 123'),
      network: { interfaces: ['eth0'], receivedBytes: 3000, transmittedBytes: 7000 },
    };
    const sample = buildSystemMetricSample(previous, current, {
      collectorId: 'collector-a',
      activity: { source: 'redis', windowMinutes: 15, activeUsers: 12 },
    });
    expect(sample.cpu.usagePercent).toBe(40);
    expect(sample.cpu.cores).toBe(2);
    expect(sample.network.receivedBytesPerSecond).toBe(200);
    expect(sample.network.transmittedBytesPerSecond).toBe(500);
    expect(sample.activity.activeUsers).toBe(12);
  });

  it('reads active-user counts from throttled Redis sorted sets', async () => {
    const commands = [];
    const pipeline = {
      zremrangebyscore: vi.fn((...args) => { commands.push(['remove', ...args]); return pipeline; }),
      zcount: vi.fn((...args) => { commands.push(['count', ...args]); return pipeline; }),
      exec: vi.fn().mockResolvedValue([
        [null, 1], [null, 8],
        [null, 1], [null, 6],
        [null, 1], [null, 2],
        [null, 1], [null, 1],
      ]),
    };
    const redis = { pipeline: () => pipeline };

    const counts = await readActiveUserCounts(redis, {
      activeWindowMinutes: 15,
      nowMs: 1_000_000,
    });

    expect(counts).toEqual({
      source: 'redis',
      windowMinutes: 15,
      activeUsers: 8,
      activeStudents: 6,
      activeProfessors: 2,
      activeAdmins: 1,
    });
    expect(commands).toHaveLength(8);
  });

  it('downsamples history, identifies peaks, and reports stale collectors', () => {
    const now = new Date('2026-09-08T16:00:00.000Z');
    const samples = [
      {
        timestamp: new Date('2026-09-08T15:50:00.000Z'),
        sampleIntervalSeconds: 60,
        cpu: { usagePercent: 20, load1: 0.5 },
        memory: { usedPercent: 40 },
        network: { receivedBytesPerSecond: 100, transmittedBytesPerSecond: 50 },
        activity: { activeUsers: 4, activeStudents: 3, activeProfessors: 1, activeAdmins: 0 },
      },
      {
        timestamp: new Date('2026-09-08T15:51:00.000Z'),
        sampleIntervalSeconds: 60,
        cpu: { usagePercent: 60, load1: 1.5 },
        memory: { usedPercent: 50 },
        network: { receivedBytesPerSecond: 300, transmittedBytesPerSecond: 150 },
        activity: { activeUsers: 12, activeStudents: 10, activeProfessors: 2, activeAdmins: 1 },
      },
    ];
    const history = aggregateSystemMetricSamples(samples, { bucketMs: 5 * 60 * 1000 });
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(expect.objectContaining({
      cpuPercent: 40,
      memoryPercent: 45,
      activeUsers: 12,
    }));

    const response = buildSystemMonitoringResponse({ samples, range: '24h', now });
    expect(response.status).toBe('stale');
    expect(response.peakPeriods[0].activeUsers).toBe(12);
    expect(response.bucketSeconds).toBe(300);
  });
});
