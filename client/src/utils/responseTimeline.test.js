import { describe, expect, it } from 'vitest';
import { buildResponseTimelineBins, collectResponseTimeline } from './responseTimeline';

describe('response timelines', () => {
  it('uses the answer save time before locking time and falls back for legacy records', () => {
    const data = collectResponseTimeline([
      { submittedAt: '2026-10-02T19:00:00Z', updatedAt: '2026-10-02T20:00:00Z' },
      { updatedAt: '2026-10-02T19:01:00Z' },
      { createdAt: '2026-10-02T19:02:00Z' },
      {}, { createdAt: 'invalid' },
    ]);
    expect(data.timestamps).toEqual([0, 1, 2].map((minutes) => Date.parse('2026-10-02T19:00:00Z') + minutes * 60000));
    expect(data.missingCount).toBe(2);
    expect(data.range).toEqual({ min: data.timestamps[0], max: data.timestamps[2] });
  });

  it('keeps exact interval boundaries, repeated timestamps, gaps and the last response', () => {
    const base = Date.parse('2026-10-02T19:00:00Z');
    const data = collectResponseTimeline([0, 0, 1000, 4000].map((offset) => ({ createdAt: new Date(base + offset).toISOString() })));
    const chart = buildResponseTimelineBins(data);
    expect(chart.interval).toBe(1000);
    expect(chart.bins.map((bin) => bin.count)).toEqual([2, 1, 0, 0, 1]);
    expect(chart.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(4);
    expect(chart.end).toBeGreaterThan(data.range.max);
  });

  it('supports single timestamps and no usable timestamps', () => {
    expect(buildResponseTimelineBins(collectResponseTimeline([{}]))).toBeNull();
    const chart = buildResponseTimelineBins(collectResponseTimeline([{ createdAt: '2026-10-02T19:00:00.771Z' }]));
    expect(chart.bins).toHaveLength(1);
    expect(chart.bins[0].count).toBe(1);
    expect(chart.end - chart.start).toBe(1000);
  });

  it('uses only its own responses to set the range', () => {
    const data = collectResponseTimeline([{ createdAt: '2026-10-02T19:00:00Z' }, { createdAt: '2026-10-02T20:00:00Z' }]);
    const chart = buildResponseTimelineBins(data);
    expect(chart.start).toBe(data.range.min);
    expect(chart.end).toBe(data.range.max + chart.interval);
    expect(chart.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(2);
  });

  it('bounds chart size across years of timestamps and many responses', () => {
    const responses = Array.from({ length: 150000 }, (_, index) => ({ createdAt: new Date(Date.UTC(2020, 0, 1) + index * 86400000 / 50).toISOString() }));
    const data = collectResponseTimeline(responses);
    const coarse = buildResponseTimelineBins(data, { targetBins: 10 });
    const fine = buildResponseTimelineBins(data, { targetBins: 80 });
    expect(fine.bins.length).toBeGreaterThan(coarse.bins.length);
    expect(fine.bins.length).toBeLessThanOrEqual(81);
    expect(fine.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(responses.length);
  });
});
