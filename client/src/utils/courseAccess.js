export function isUserInstructorForCourse(course, userId) {
  const normalizedUserId = String(userId || '').trim();
  if (!course || !normalizedUserId) return false;
  return (course.instructors || []).some(
    (instructor) => String(instructor?._id || instructor || '').trim() === normalizedUserId
  );
}

export function shouldRedirectStudentCourseToInstructorView(course, user) {
  return isUserInstructorForCourse(course, user?._id);
}

export function isCurrentUserCourseInstructorOrAdmin(course, user) {
  const roles = user?.profile?.roles || user?.roles || [];
  if (roles.includes('admin')) return true;

  return isUserInstructorForCourse(course, user?._id || user?.userId);
}
