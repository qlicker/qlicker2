import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';

const {
  apiClientMock,
  setAccessTokenMock,
  getAccessTokenMock,
  clearAccessTokenMock,
  refreshAccessTokenMock,
  markExplicitLogoutMock,
  clearExplicitLogoutMock,
  hasExplicitLogoutMock,
} = vi.hoisted(() => ({
  apiClientMock: {
    get: vi.fn(),
    post: vi.fn(),
  },
  setAccessTokenMock: vi.fn(),
  getAccessTokenMock: vi.fn(),
  clearAccessTokenMock: vi.fn(),
  refreshAccessTokenMock: vi.fn(),
  markExplicitLogoutMock: vi.fn(),
  clearExplicitLogoutMock: vi.fn(),
  hasExplicitLogoutMock: vi.fn(),
}));

vi.mock('../api/client', () => ({
  default: apiClientMock,
  setAccessToken: setAccessTokenMock,
  getAccessToken: getAccessTokenMock,
  clearAccessToken: clearAccessTokenMock,
  refreshAccessToken: refreshAccessTokenMock,
  markExplicitLogout: markExplicitLogoutMock,
  clearExplicitLogout: clearExplicitLogoutMock,
  hasExplicitLogout: hasExplicitLogoutMock,
}));

function Probe() {
  const { loading, user, logout } = useAuth();

  return (
    <div>
      <div data-testid="auth-state">{loading ? 'loading' : (user ? 'user' : 'anon')}</div>
      <button type="button" onClick={logout}>logout</button>
    </div>
  );
}

describe('AuthProvider', () => {
  beforeEach(() => {
    apiClientMock.get.mockReset();
    apiClientMock.post.mockReset();
    setAccessTokenMock.mockReset();
    getAccessTokenMock.mockReset();
    clearAccessTokenMock.mockReset();
    refreshAccessTokenMock.mockReset();
    markExplicitLogoutMock.mockReset();
    clearExplicitLogoutMock.mockReset();
    hasExplicitLogoutMock.mockReset();

    getAccessTokenMock.mockReturnValue(null);
    hasExplicitLogoutMock.mockReturnValue(false);
    refreshAccessTokenMock.mockResolvedValue('refreshed-token');
    apiClientMock.get.mockResolvedValue({
      data: {
        user: {
          _id: 'user-1',
          profile: { roles: ['student'] },
        },
      },
    });
    apiClientMock.post.mockResolvedValue({ data: { success: true } });
  });

  it('skips refresh when the previous navigation was an explicit logout', async () => {
    hasExplicitLogoutMock.mockReturnValue(true);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('anon');
    });

    expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    expect(apiClientMock.get).not.toHaveBeenCalled();
    expect(clearAccessTokenMock).toHaveBeenCalled();
  });

  it('marks explicit logout when logout is requested', async () => {
    getAccessTokenMock.mockReturnValue('existing-token');

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-state')).toHaveTextContent('user');
    });

    fireEvent.click(screen.getByRole('button', { name: 'logout' }));

    await waitFor(() => {
      expect(markExplicitLogoutMock).toHaveBeenCalled();
    });

    expect(apiClientMock.post).toHaveBeenCalledWith('/auth/logout');
    expect(clearAccessTokenMock).toHaveBeenCalled();
  });
});
