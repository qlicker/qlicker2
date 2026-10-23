import { getDashboardPath } from './dashboard';

export const USER_MANUAL_ROLES = ['admin', 'professor', 'student'];

export function getPreferredManualRole(roles = [], hasInstructorCourses = false) {
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('professor') || hasInstructorCourses) return 'professor';
  return 'student';
}

export function getManualDashboardPath(roles = [], hasInstructorCourses = false) {
  return getDashboardPath({
    profile: { roles },
    hasInstructorCourses,
  });
}

export function getManualPath(role) {
  return `/manual/${role}`;
}

export function canAccessManualRole(roles = [], manualRole, hasInstructorCourses = false) {
  if (!USER_MANUAL_ROLES.includes(manualRole)) return false;
  if (roles.includes('admin')) return true;
  if (manualRole === 'student') return roles.includes('student') || roles.includes('professor') || hasInstructorCourses;
  if (manualRole === 'professor') return roles.includes('professor') || hasInstructorCourses;
  return false;
}

export function getAvailableManualRoles(roles = [], hasInstructorCourses = false) {
  return USER_MANUAL_ROLES.filter((manualRole) => canAccessManualRole(roles, manualRole, hasInstructorCourses));
}
