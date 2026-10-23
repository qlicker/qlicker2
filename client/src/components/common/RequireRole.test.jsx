import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RequireRole from './RequireRole';

const { authState, tMock } = vi.hoisted(() => ({
  authState: {
    user: {
      profile: {
        roles: ['student'],
      },
      hasStudentCourses: false,
    },
  },
  tMock: vi.fn((key) => key),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock }),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

describe('RequireRole', () => {
  beforeEach(() => {
    authState.user = {
      profile: {
        roles: ['student'],
      },
      hasStudentCourses: false,
    };
  });

  it('allows professors with student-course access through student-only routes', () => {
    authState.user = {
      profile: {
        roles: ['professor'],
      },
      hasStudentCourses: true,
    };

    render(
      <RequireRole role="student" allowAdmin={false}>
        <div>student content</div>
      </RequireRole>
    );

    expect(screen.getByText('student content')).toBeInTheDocument();
  });

  it('allows admins with student-course access through student-only routes', () => {
    authState.user = {
      profile: {
        roles: ['admin'],
      },
      hasStudentCourses: true,
    };

    render(
      <RequireRole role="student" allowAdmin={false}>
        <div>student content</div>
      </RequireRole>
    );

    expect(screen.getByText('student content')).toBeInTheDocument();
  });

  it('still blocks non-students without student-course access', () => {
    authState.user = {
      profile: {
        roles: ['professor'],
      },
      hasStudentCourses: false,
    };

    render(
      <RequireRole role="student" allowAdmin={false}>
        <div>student content</div>
      </RequireRole>
    );

    expect(screen.getByText('accessDenied.title')).toBeInTheDocument();
    expect(screen.queryByText('student content')).not.toBeInTheDocument();
  });
});
