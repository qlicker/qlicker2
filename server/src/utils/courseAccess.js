function userId(user) {
  return String(user?.userId || user?._id || '');
}

function userRoles(user) {
  return user?.roles || user?.profile?.roles || [];
}

export function isCourseInstructorOrAdmin(course, user) {
  if (userRoles(user).includes('admin')) return true;
  const id = userId(user);
  return !!id && (course?.instructors || []).some((instructorId) => String(instructorId) === id);
}

export function isCourseStudent(course, user) {
  const id = userId(user);
  return !!id && (course?.students || []).some((studentId) => String(studentId) === id);
}

export function isCourseMember(course, user) {
  if (course?.inactive && !isCourseInstructorOrAdmin(course, user) && isCourseStudent(course, user)) return false;
  return isCourseInstructorOrAdmin(course, user) || isCourseStudent(course, user);
}

export function isStudentOwnedSession(session, user) {
  const id = userId(user);
  return !!id && !!session?.studentCreated && String(session.creator || '') === id;
}

export function getStudentSessionReviewRestriction(
  session,
  user,
  { allowOwnedStudentSession = true } = {}
) {
  const ownsStudentSession = allowOwnedStudentSession && isStudentOwnedSession(session, user);
  if (session?.studentCreated && !ownsStudentSession) return 'unavailable';
  if (!session?.reviewable && !ownsStudentSession) return 'not-reviewable';
  if (session?.status !== 'done' && !ownsStudentSession) return 'not-finished';
  if (!ownsStudentSession && (session?.quiz || session?.practiceQuiz)
    && (session?.quizExtensions || []).some((extension) => (
      new Date(extension.quizEnd || session.quizEnd).getTime() >= Date.now()
    ))) return 'not-finished';
  return null;
}

export function studentReviewableSessionQuery({ includeStudentCreated = false } = {}) {
  return {
    reviewable: true,
    status: 'done',
    quizExtensions: { $not: { $elemMatch: { quizEnd: { $gte: new Date() } } } },
    ...(includeStudentCreated ? {} : { studentCreated: { $ne: true } }),
  };
}

export function studentVisibleGradeQuery(courseId, sessionId, user) {
  return {
    courseId: String(courseId),
    sessionId: String(sessionId),
    userId: userId(user),
    visibleToStudents: true,
  };
}

export function resolveCourseAiAudience(course, user) {
  if (userRoles(user).includes('admin')) return 'instructor';
  const id = userId(user);
  const listedInstructor = !!id && (course?.instructors || []).some((instructorId) => String(instructorId) === id);
  if (isCourseStudent(course, user) && !listedInstructor) return 'student';
  if (isCourseInstructorOrAdmin(course, user)) return 'instructor';
  return null;
}
