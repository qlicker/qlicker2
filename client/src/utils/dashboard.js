export function getDashboardPath(user = null) {
  const roles = user?.profile?.roles || [];
  const canAccessProfessorDashboard = typeof user?.canAccessProfessorDashboard === 'boolean'
    ? user.canAccessProfessorDashboard
    : roles.includes('professor');
  if (roles.includes('admin')) return '/admin';
  if (roles.includes('student')) return '/student';
  if (canAccessProfessorDashboard) return '/prof';
  return '/student';
}
