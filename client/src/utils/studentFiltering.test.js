import { describe, expect, it } from 'vitest';
import { filterStudentsByIdentity } from './studentFiltering';

const students = [
  {
    _id: 'student-1',
    firstname: 'Ada',
    lastname: 'Lovelace',
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
  },
  {
    _id: 'student-2',
    firstname: 'Grace',
    lastname: 'Hopper',
    displayName: 'Grace Hopper',
    email: 'grace@example.com',
  },
];

describe('filterStudentsByIdentity', () => {
  it('filters case-insensitively by first name, last name, full name, or email', () => {
    expect(filterStudentsByIdentity(students, 'ADA')).toEqual([students[0]]);
    expect(filterStudentsByIdentity(students, 'hopper')).toEqual([students[1]]);
    expect(filterStudentsByIdentity(students, 'Ada Love')).toEqual([students[0]]);
    expect(filterStudentsByIdentity(students, 'grace@example.com')).toEqual([students[1]]);
  });

  it('returns the original roster for an empty filter and no results for a miss', () => {
    expect(filterStudentsByIdentity(students, '   ')).toBe(students);
    expect(filterStudentsByIdentity(students, 'missing')).toEqual([]);
  });
});
