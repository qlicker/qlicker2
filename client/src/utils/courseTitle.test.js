import { describe, expect, it } from 'vitest';
import { buildCourseSelectionLabel, sortCoursesByRecent } from './courseTitle';

describe('courseTitle helpers', () => {
  it('builds compact course-selection labels with semester context', () => {
    expect(buildCourseSelectionLabel({
      deptCode: 'PHYS',
      courseNumber: '242',
      semester: 'Fall/Winter 2023/2024',
    })).toBe('PHYS 242 (Fall/Winter 2023/2024)');

    expect(buildCourseSelectionLabel({
      name: 'Quantum Mechanics',
      section: 'A01',
      semester: 'Fall 2025',
    })).toBe('Quantum Mechanics · A01 (Fall 2025)');
  });

  it('sorts recent courses before older ones', () => {
    const sorted = sortCoursesByRecent([
      { _id: 'course-1', deptCode: 'PHYS', courseNumber: '242', semester: 'Fall 2024', createdAt: '2024-08-01T00:00:00.000Z' },
      { _id: 'course-2', deptCode: 'PHYS', courseNumber: '242', semester: 'Fall 2025', createdAt: '2025-08-01T00:00:00.000Z' },
      { _id: 'course-3', deptCode: 'MATH', courseNumber: '100', semester: 'Winter 2025', createdAt: '2025-08-01T00:00:00.000Z' },
    ]);

    expect(sorted.map((course) => course._id)).toEqual(['course-3', 'course-2', 'course-1']);
  });
});
