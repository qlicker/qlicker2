import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SSOCallback from './SSOCallback';

const {
  navigateMock,
  loadUserMock,
  setAccessTokenMock,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  loadUserMock: vi.fn().mockResolvedValue(undefined),
  setAccessTokenMock: vi.fn(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams('?token=test-token')],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key,
  }),
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    loadUser: loadUserMock,
    user: {
      profile: { roles: ['student'] },
      hasInstructorCourses: true,
    },
  }),
}));

vi.mock('../api/client', () => ({
  setAccessToken: setAccessTokenMock,
  getAccessToken: () => 'test-token',
}));

describe('SSOCallback', () => {
  it('routes student-role instructor accounts to the student dashboard', async () => {
    render(<SSOCallback />);

    await waitFor(() => {
      expect(setAccessTokenMock).toHaveBeenCalledWith('test-token');
      expect(loadUserMock).toHaveBeenCalled();
      expect(navigateMock).toHaveBeenCalledWith('/student', { replace: true });
    });
  });
});
