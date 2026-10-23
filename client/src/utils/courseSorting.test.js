import { describe, expect, it } from 'vitest';
import { sortCoursesByRecentActivity } from './courseSorting';

describe('sortCoursesByRecentActivity', () => {
  it('sorts active courses ahead of inactive ones by latest activity timestamp', () => {
    const sorted = sortCoursesByRecentActivity([
      { _id: 'inactive-newer', inactive: true, lastActivityAt: '2026-04-05T00:00:00.000Z' },
      { _id: 'active-older', inactive: false, lastActivityAt: '2026-04-02T00:00:00.000Z' },
      { _id: 'active-newer', inactive: false, lastActivityAt: '2026-04-04T00:00:00.000Z' },
    ]);

    expect(sorted.map((course) => course._id)).toEqual([
      'active-newer',
      'active-older',
      'inactive-newer',
    ]);
  });
});
