import { describe, expect, it } from 'vitest';
import {
  isCurrentUserCourseInstructorOrAdmin,
  isUserInstructorForCourse,
  shouldRedirectStudentCourseToInstructorView,
} from './courseAccess';

describe('courseAccess', () => {
  const course = { instructors: ['course-professor'], students: ['student-professor'] };

  it('detects when the current user is an instructor for a course', () => {
    expect(isUserInstructorForCourse({ instructors: [{ _id: 'user-1' }] }, 'user-1')).toBe(true);
  });

  it('does not redirect a professor or administrator who is only a student', () => {
    const studentCourse = { instructors: [{ _id: 'different-user' }], students: ['prof-user'] };
    expect(shouldRedirectStudentCourseToInstructorView(studentCourse, {
      _id: 'prof-user', profile: { roles: ['professor'] },
    })).toBe(false);
    expect(shouldRedirectStudentCourseToInstructorView(studentCourse, {
      _id: 'admin-user', profile: { roles: ['admin'] },
    })).toBe(false);
  });

  it('does not grant course instructor access from the global professor role', () => {
    expect(isCurrentUserCourseInstructorOrAdmin(course, {
      _id: 'student-professor', profile: { roles: ['professor', 'student'] },
    })).toBe(false);
  });

  it('grants access to a course instructor or administrator', () => {
    expect(isCurrentUserCourseInstructorOrAdmin(course, {
      _id: 'course-professor', profile: { roles: ['professor'] },
    })).toBe(true);
    expect(isCurrentUserCourseInstructorOrAdmin(course, {
      _id: 'administrator', profile: { roles: ['admin'] },
    })).toBe(true);
  });
});
