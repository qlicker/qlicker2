import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import i18n from '../../i18n';
import AppLayout from './AppLayout';
import { APP_VERSION } from '../../utils/version';

const { authState, apiClientMock } = vi.hoisted(() => ({
  authState: {
    user: {
      profile: {
        firstname: 'Prof',
        lastname: 'User',
        roles: ['professor'],
      },
    },
    logout: vi.fn(),
  },
  apiClientMock: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('../../api/client', () => ({
  default: apiClientMock,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('../common/ConnectionStatus', () => ({
  default: () => null,
}));

function renderLayout(initialEntry = '/prof') {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/prof" element={<div>Dashboard destination</div>} />
            <Route path="/student" element={<div>Student dashboard destination</div>} />
            <Route path="/admin" element={<div>Admin destination</div>} />
            <Route path="/manual/professor" element={<div>Professor manual destination</div>} />
            <Route path="/manual/admin" element={<div>Admin manual destination</div>} />
            <Route path="/profile" element={<div>Profile destination</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </I18nextProvider>
  );
}

describe('AppLayout', () => {
  beforeEach(() => {
    authState.logout.mockReset();
    apiClientMock.get.mockReset();
    apiClientMock.post.mockReset();
    authState.user = {
      profile: {
        firstname: 'Prof',
        lastname: 'User',
        roles: ['professor'],
      },
    };
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/notifications/summary') {
        return Promise.resolve({ data: { count: 0 } });
      }
      if (url === '/notifications') {
        return Promise.resolve({ data: { notifications: [] } });
      }
      return Promise.resolve({ data: {} });
    });
    apiClientMock.post.mockResolvedValue({ data: {} });
  });

  it('opens the account menu and routes professors to the professor manual', async () => {
    renderLayout('/prof');

    fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /user manual/i }));

    await waitFor(() => {
      expect(screen.getByText('Professor manual destination')).toBeInTheDocument();
    });
  });

  it('routes admins to the admin manual from the account menu', async () => {
    authState.user = {
      profile: {
        firstname: 'Admin',
        lastname: 'User',
        roles: ['admin'],
      },
    };
    renderLayout('/admin');

    fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /user manual/i }));

    await waitFor(() => {
      expect(screen.getByText('Admin manual destination')).toBeInTheDocument();
    });
  });

  it('routes student-role TA users back to the student dashboard', async () => {
    authState.user = {
      profile: {
        firstname: 'Student',
        lastname: 'TA',
        roles: ['student'],
      },
      hasInstructorCourses: true,
      canAccessProfessorDashboard: false,
    };
    renderLayout('/profile');

    fireEvent.click(screen.getByRole('button', { name: /go to dashboard/i }));

    await waitFor(() => {
      expect(screen.getByText('Student dashboard destination')).toBeInTheDocument();
    });
  });

  it('shows notifications in the account menu and allows dismissing them', async () => {
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/notifications/summary') {
        return Promise.resolve({ data: { count: 2 } });
      }
      if (url === '/notifications') {
        return Promise.resolve({
          data: {
            notifications: [
              {
                _id: 'notification-1',
                title: 'System update',
                message: 'Please read this message.',
                startAt: '2026-03-31T12:00:00.000Z',
                endAt: '2026-03-31T18:00:00.000Z',
                persistUntilDismissed: false,
                source: { type: 'system' },
              },
            ],
          },
        });
      }
      return Promise.resolve({ data: {} });
    });

    renderLayout('/prof');

    fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    const notificationsMenuItem = await screen.findByRole('menuitem', { name: /notifications/i });
    expect(within(notificationsMenuItem).getByText('2')).toBeInTheDocument();
    fireEvent.click(notificationsMenuItem);

    expect(await screen.findByRole('heading', { name: /notifications/i })).toBeInTheDocument();
    expect(screen.getByText('System update')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
    await waitFor(() => {
      expect(screen.queryByText('System update')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /open account menu/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /notifications/i }));
    expect(await screen.findByText('System update')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dismiss notification/i }));

    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/notifications/notification-1/dismiss');
    });
  });

  it('does not show the app version in the app bar', () => {
    renderLayout('/prof');

    expect(screen.queryByText(APP_VERSION)).not.toBeInTheDocument();
  });
});
