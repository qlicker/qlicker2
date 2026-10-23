import { describe, expect, it } from 'vitest';
import {
  getStudentSessionReviewRestriction,
  isCourseInstructorOrAdmin,
  isCourseMember,
  isStudentOwnedSession,
  resolveCourseAiAudience,
  studentReviewableSessionQuery,
  studentVisibleGradeQuery,
} from '../../src/utils/courseAccess.js';

describe('course access', () => {
  const course = { instructors: ['course-professor'], students: ['student-professor'] };

  it('does not grant instructor privileges from the global professor role', () => {
    const user = { userId: 'student-professor', roles: ['professor', 'student'] };

    expect(isCourseInstructorOrAdmin(course, user)).toBe(false);
    expect(isCourseMember(course, user)).toBe(true);
    expect(resolveCourseAiAudience(course, user)).toBe('student');
  });

  it('grants instructor privileges only to an assigned instructor or an admin', () => {
    expect(isCourseInstructorOrAdmin(course, { userId: 'course-professor', roles: ['professor'] })).toBe(true);
    expect(isCourseInstructorOrAdmin(course, { userId: 'administrator', roles: ['admin'] })).toBe(true);
    expect(resolveCourseAiAudience(course, { userId: 'course-professor', roles: ['professor'] })).toBe('instructor');
    expect(resolveCourseAiAudience(course, { userId: 'student-professor', roles: ['admin'] })).toBe('instructor');
  });

  it('uses one reviewability rule for student session access', () => {
    const student = { userId: 'student-professor', roles: ['student'] };
    expect(getStudentSessionReviewRestriction({ reviewable: true, status: 'done' }, student)).toBeNull();
    expect(getStudentSessionReviewRestriction({ reviewable: false, status: 'done' }, student)).toBe('not-reviewable');
    expect(getStudentSessionReviewRestriction({ reviewable: true, status: 'running' }, student)).toBe('not-finished');
    expect(getStudentSessionReviewRestriction({
      reviewable: true, status: 'done', quiz: true,
      quizExtensions: [{ userId: 'other-student', quizEnd: new Date(Date.now() + 60000) }],
    }, student)).toBe('not-finished');
    expect(getStudentSessionReviewRestriction({
      studentCreated: true,
      creator: 'another-student',
      reviewable: true,
      status: 'done',
    }, student)).toBe('unavailable');

    const ownedPractice = { studentCreated: true, creator: student.userId, reviewable: false, status: 'hidden' };
    expect(isStudentOwnedSession(ownedPractice, student)).toBe(true);
    expect(getStudentSessionReviewRestriction(ownedPractice, student)).toBeNull();
    expect(getStudentSessionReviewRestriction(ownedPractice, student, { allowOwnedStudentSession: false }))
      .toBe('unavailable');
  });

  it('provides shared database filters for reviewable sessions and student-visible grades', () => {
    expect(studentReviewableSessionQuery()).toEqual({
      reviewable: true,
      status: 'done',
      quizExtensions: { $not: { $elemMatch: { quizEnd: { $gte: expect.any(Date) } } } },
      studentCreated: { $ne: true },
    });
    expect(studentVisibleGradeQuery('course-1', 'session-1', { userId: 'student-1' })).toEqual({
      courseId: 'course-1',
      sessionId: 'session-1',
      userId: 'student-1',
      visibleToStudents: true,
    });
  });
});
