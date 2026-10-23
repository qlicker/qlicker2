import { describe, expect, it } from 'vitest';
import {
  USER_MANUAL_ROLES,
  canAccessManualRole,
  getAvailableManualRoles,
  getManualDashboardPath,
  getManualPath,
  getPreferredManualRole,
} from './userManuals';

describe('userManuals helpers', () => {
  it('returns the preferred manual role in permission order', () => {
    expect(getPreferredManualRole(['student'])).toBe('student');
    expect(getPreferredManualRole(['professor', 'student'])).toBe('professor');
    expect(getPreferredManualRole(['admin', 'professor', 'student'])).toBe('admin');
    expect(getPreferredManualRole(['student'], true)).toBe('professor');
    expect(getPreferredManualRole()).toBe('student');
  });

  it('builds manual paths from role slugs', () => {
    expect(getManualPath('admin')).toBe('/manual/admin');
    expect(getManualPath('professor')).toBe('/manual/professor');
    expect(getManualPath('student')).toBe('/manual/student');
  });

  it('checks manual access by role', () => {
    expect(canAccessManualRole(['student'], 'student')).toBe(true);
    expect(canAccessManualRole(['student'], 'professor')).toBe(false);
    expect(canAccessManualRole(['student'], 'professor', true)).toBe(true);
    expect(canAccessManualRole(['professor'], 'student')).toBe(true);
    expect(canAccessManualRole(['professor'], 'admin')).toBe(false);
    expect(canAccessManualRole(['admin'], 'admin')).toBe(true);
    expect(canAccessManualRole(['admin'], 'professor')).toBe(true);
    expect(canAccessManualRole(['admin'], 'student')).toBe(true);
    expect(canAccessManualRole(['student'], 'unknown')).toBe(false);
  });

  it('lists the manual roles available to each kind of user', () => {
    expect(getAvailableManualRoles(['student'])).toEqual(['student']);
    expect(getAvailableManualRoles(['professor'])).toEqual(['professor', 'student']);
    expect(getAvailableManualRoles(['student'], true)).toEqual(['professor', 'student']);
    expect(getAvailableManualRoles(['admin'])).toEqual(USER_MANUAL_ROLES);
    expect(getAvailableManualRoles(['admin', 'professor'])).toEqual(USER_MANUAL_ROLES);
  });

  it('returns the correct dashboard path for each role combination', () => {
    expect(getManualDashboardPath(['student'])).toBe('/student');
    expect(getManualDashboardPath(['professor'])).toBe('/prof');
    expect(getManualDashboardPath(['student'], true)).toBe('/student');
    expect(getManualDashboardPath(['admin'])).toBe('/admin');
    expect(getManualDashboardPath(['professor', 'student'])).toBe('/student');
    expect(getManualDashboardPath(['admin', 'professor', 'student'])).toBe('/admin');
    expect(getManualDashboardPath()).toBe('/student');
  });
});
