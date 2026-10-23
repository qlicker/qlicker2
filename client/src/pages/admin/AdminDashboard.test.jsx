import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../i18n';
import AdminDashboard from './AdminDashboard';

const { apiClientMock, authState } = vi.hoisted(() => ({
  apiClientMock: {
    delete: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
  },
  authState: {
    user: {
      _id: 'admin-1',
      profile: {
        firstname: 'Admin',
        lastname: 'User',
        roles: ['admin'],
      },
    },
  },
}));

vi.mock('../../api/client', () => ({
  default: apiClientMock,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('../../components/common/AutoSaveStatus', () => ({
  default: () => null,
}));

let settingsState;
let usersState;
let userDetailsState;
let coursesState;
let usageStatisticsState;
let systemMonitoringState;

function buildUser(overrides = {}) {
  const user = {
    _id: 'student-1',
    emails: [{ address: 'student@example.com', verified: true }],
    profile: {
      firstname: 'Student',
      lastname: 'User',
      roles: ['student'],
      canPromote: false,
    },
    allowEmailLogin: true,
    disabled: false,
    activeSessions: [],
    studentCourses: [],
    instructorCourses: [],
    ...overrides,
  };

  return {
    ...user,
    profile: {
      firstname: 'Student',
      lastname: 'User',
      roles: ['student'],
      canPromote: false,
      ...(overrides.profile || {}),
    },
  };
}

function buildCourse(overrides = {}) {
  return {
    _id: 'course-1',
    name: 'Course 1',
    deptCode: 'CS',
    courseNumber: '101',
    section: '001',
    semester: 'Fall 2026',
    createdAt: '2026-03-30T00:00:00.000Z',
    inactive: false,
    ...overrides,
  };
}

function compareValues(aValue, bValue, direction = 'asc') {
  const factor = direction === 'desc' ? -1 : 1;
  if (aValue < bValue) return -1 * factor;
  if (aValue > bValue) return 1 * factor;
  return 0;
}

function sortUsers(users = [], sortBy = 'lastLogin', sortDirection = 'desc') {
  return [...users].sort((a, b) => {
    if (sortBy === 'name') {
      const aName = `${a.profile?.lastname || ''}\u0000${a.profile?.firstname || ''}`.toLowerCase();
      const bName = `${b.profile?.lastname || ''}\u0000${b.profile?.firstname || ''}`.toLowerCase();
      return compareValues(aName, bName, sortDirection);
    }

    if (sortBy === 'email') {
      return compareValues(
        String(a.emails?.[0]?.address || '').toLowerCase(),
        String(b.emails?.[0]?.address || '').toLowerCase(),
        sortDirection
      );
    }

    if (sortBy === 'verified') {
      return compareValues(
        a.emails?.[0]?.verified ? 1 : 0,
        b.emails?.[0]?.verified ? 1 : 0,
        sortDirection
      );
    }

    if (sortBy === 'role') {
      return compareValues(
        String(a.profile?.roles?.[0] || '').toLowerCase(),
        String(b.profile?.roles?.[0] || '').toLowerCase(),
        sortDirection
      );
    }

    const aLastLogin = a.lastLogin ? new Date(a.lastLogin).getTime() : 0;
    const bLastLogin = b.lastLogin ? new Date(b.lastLogin).getTime() : 0;
    return compareValues(aLastLogin, bLastLogin, sortDirection);
  });
}

function renderDashboard() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <AdminDashboard />
      </MemoryRouter>
    </I18nextProvider>
  );
}

async function selectMuiOption(element, optionName) {
  fireEvent.mouseDown(element);
  const listbox = await screen.findByRole('listbox');
  fireEvent.click(within(listbox).getByRole('option', { name: String(optionName) }));
}

describe('AdminDashboard', () => {
  beforeEach(() => {
    vi.useRealTimers();
    i18n.changeLanguage('en');
    apiClientMock.delete.mockReset();
    apiClientMock.get.mockReset();
    apiClientMock.patch.mockReset();
    apiClientMock.post.mockReset();
    localStorage.clear();

    settingsState = {
      restrictDomain: false,
      allowedDomains: [],
      requireVerified: false,
      adminEmail: 'admin@example.com',
      tokenExpiryMinutes: 120,
      locale: 'en',
      dateFormat: 'DD-MMM-YYYY',
      timeFormat: '24h',
      SSO_enabled: true,
      backupEnabled: false,
      backupTimeLocal: '02:00',
      backupRetentionDaily: 7,
      backupRetentionWeekly: 4,
      backupRetentionMonthly: 12,
      backupLastRunAt: '2026-03-27T07:15:00.000Z',
      backupLastRunType: 'weekly',
      backupLastRunStatus: 'success',
      backupLastRunFilename: 'qlicker_backup_20260327_071500_weekly.tar.gz',
      backupLastRunMessage: 'Backup completed successfully.',
      backupManagerLastSeenAt: '2026-03-27T07:16:00.000Z',
      backupManagerStatus: 'healthy',
      backupManagerMessage: 'Backup manager is running. Archives are written to ./backups on the host.',
      backupManagerHostPath: './backups',
      backupManagerCheckIntervalSeconds: 60,
      backupManagerIsStale: false,
    };

    usersState = [buildUser()];
    userDetailsState = new Map(usersState.map((user) => [user._id, { ...user }]));
    coursesState = [];
    usageStatisticsState = {
      loginCounts: { pastHour: 3, past24Hours: 12, past7Days: 48 },
      activeCourseWindowDays: 7,
      topCourses: [
        {
          ...buildCourse({ name: 'Active Course' }),
          enrollment: 36,
          activeUserCount: 14,
        },
      ],
    };

    systemMonitoringState = {
      status: 'healthy',
      latest: {
        timestamp: '2026-09-08T16:00:00.000Z', sampleIntervalSeconds: 60,
        cpu: { usagePercent: 42, cores: 4, load1: 1.2 },
        memory: { usedPercent: 65, usedBytes: 5.2 * 1024 ** 3, totalBytes: 8 * 1024 ** 3, availableBytes: 2.8 * 1024 ** 3 },
        network: { interfaces: ['wlp4s0'], receivedBytesPerSecond: 1024, transmittedBytesPerSecond: 2048 },
        activity: { activeUsers: 25, windowMinutes: 15 },
      },
      history: [0, 1].map((index) => ({
        timestamp: `2026-09-08T15:0${index}:00.000Z`,
        cpuPercent: 40 + index, memoryPercent: 65, activeUsers: 25,
        activeStudents: 20, activeProfessors: 5,
        networkReceivedBytesPerSecond: 1024, networkTransmittedBytesPerSecond: 2048,
      })),
      peakPeriods: [],
      events: [{ timestamp: '2026-09-08T16:00:00.000Z', code: 'collector_started',
        level: 'info', message: 'System monitor started', collectorId: 'host' }],
    };

    apiClientMock.get.mockImplementation((url, config = {}) => {
      if (url === '/settings') {
        return Promise.resolve({ data: settingsState });
      }

      if (url.startsWith('/notifications/manage')) {
        return Promise.resolve({ data: { notifications: [] } });
      }

      if (url === '/users') {
        const params = config?.params || {};
        const searchValue = String(params.search || '').trim().toLowerCase();
        const roleValue = String(params.role || '').trim();
        const pageValue = Number(params.page) || 1;
        const limitValue = Number(params.limit) || usersState.length || 20;
        let filteredUsers = usersState;

        if (searchValue) {
          filteredUsers = filteredUsers.filter((user) => {
            const name = `${user.profile?.firstname || ''} ${user.profile?.lastname || ''}`.toLowerCase();
            const email = String(user.emails?.[0]?.address || '').toLowerCase();
            return name.includes(searchValue) || email.includes(searchValue);
          });
        }

        if (roleValue) {
          filteredUsers = filteredUsers.filter((user) => user.profile?.roles?.includes(roleValue));
        }

        const sortedUsers = sortUsers(filteredUsers, params.sortBy, params.sortDirection);
        const startIndex = Math.max(0, (pageValue - 1) * limitValue);
        return Promise.resolve({
          data: {
            users: sortedUsers.slice(startIndex, startIndex + limitValue),
            total: filteredUsers.length,
          },
        });
      }

      if (url === '/users/admin/usage-statistics') {
        return Promise.resolve({ data: usageStatisticsState });
      }

      if (url === '/users/admin/system-monitoring') {
        return Promise.resolve({ data: systemMonitoringState });
      }

      if (url.startsWith('/users/')) {
        const userId = url.split('/').at(-1);
        return Promise.resolve({ data: userDetailsState.get(userId) });
      }

      if (url === '/courses') {
        const params = config?.params || {};
        const pageValue = Number(params.page) || 1;
        const limitValue = Number(params.limit) || coursesState.length || 20;
        const startIndex = Math.max(0, (pageValue - 1) * limitValue);
        const total = coursesState.length;
        return Promise.resolve({
          data: {
            courses: coursesState.slice(startIndex, startIndex + limitValue),
            total,
            page: pageValue,
            pages: Math.max(Math.ceil(total / limitValue), 1),
          },
        });
      }

      throw new Error(`Unexpected GET ${url}`);
    });

    apiClientMock.patch.mockImplementation((url, payload) => {
      if (url === '/settings') {
        settingsState = {
          ...settingsState,
          ...payload,
        };
        return Promise.resolve({ data: settingsState });
      }

      if (url === '/users/student-1/properties') {
        const nextUser = {
          ...userDetailsState.get('student-1'),
          ...payload,
          profile: {
            ...userDetailsState.get('student-1').profile,
            canPromote: payload.canPromote ?? userDetailsState.get('student-1').profile.canPromote,
          },
        };
        userDetailsState.set('student-1', nextUser);
        usersState = usersState.map((user) => (user._id === nextUser._id ? nextUser : user));
        return Promise.resolve({ data: nextUser });
      }

      if (url === '/users/student-1/password') {
        const nextUser = {
          ...userDetailsState.get('student-1'),
        };
        userDetailsState.set('student-1', nextUser);
        usersState = usersState.map((user) => (user._id === nextUser._id ? nextUser : user));
        return Promise.resolve({ data: nextUser });
      }

      throw new Error(`Unexpected PATCH ${url}`);
    });

    apiClientMock.post.mockImplementation((url) => {
      if (url === '/settings/backup-now') {
        settingsState = {
          ...settingsState,
          backupLastRunStatus: 'running',
          backupLastRunType: 'manual',
          backupLastRunMessage: 'Manual backup requested.',
        };
        return Promise.resolve({ data: settingsState });
      }

      if (url === '/settings/backup-reset') {
        settingsState = {
          ...settingsState,
          backupManualRequestId: '',
          backupLastHandledManualRequestId: '',
          backupLastRunStatus: 'idle',
          backupLastRunType: '',
          backupLastRunMessage: 'Backup request state was reset by an admin.',
        };
        return Promise.resolve({ data: settingsState });
      }

      throw new Error(`Unexpected POST ${url}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('auto-saves backup settings and reloads normalized retention values from the Backup tab', async () => {
    const { unmount } = renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^Backup$/i }));

    expect(await screen.findByLabelText(/Enable scheduled backups/i)).not.toBeChecked();
    expect(screen.getByText(/qlicker_backup_20260327_071500_weekly\.tar\.gz/i)).toBeInTheDocument();
    expect(screen.getByText(/Backup completed successfully\./i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /Enable scheduled backups/i }));
    const backupTimeField = screen.getByTestId('backup-time-field');
    await selectMuiOption(within(backupTimeField).getByLabelText('Hour'), '03');
    await selectMuiOption(within(backupTimeField).getByLabelText('Minute'), '30');
    fireEvent.change(screen.getByLabelText(/Daily backups to keep/i), { target: { value: '-2' } });
    fireEvent.change(screen.getByLabelText(/Weekly backups to keep/i), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText(/Monthly backups to keep/i), { target: { value: '9' } });

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/settings', {
        backupEnabled: true,
        backupTimeLocal: '03:30',
        backupRetentionDaily: 7,
        backupRetentionWeekly: 5,
        backupRetentionMonthly: 9,
      });
    });

    unmount();
    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^Backup$/i }));
    expect(await screen.findByRole('checkbox', { name: /Enable scheduled backups/i })).toBeChecked();
    const reloadedTimeField = screen.getByTestId('backup-time-field');
    expect(within(reloadedTimeField).getByLabelText('Hour')).toHaveTextContent('03');
    expect(within(reloadedTimeField).getByLabelText('Minute')).toHaveTextContent('30');
    expect(screen.getByLabelText(/Daily backups to keep/i)).toHaveValue(7);
    expect(screen.getByLabelText(/Weekly backups to keep/i)).toHaveValue(5);
    expect(screen.getByLabelText(/Monthly backups to keep/i)).toHaveValue(9);
  }, 10_000);

  it('shows login counts and the most active courses in Usage Statistics', async () => {
    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /Usage Statistics/i }));

    expect(await screen.findByText('48')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    const courseRow = screen.getByRole('row', { name: /Active Course/i });
    expect(within(courseRow).getByText('14')).toBeInTheDocument();
    expect(within(courseRow).getByText('36')).toBeInTheDocument();
    expect(apiClientMock.get).toHaveBeenCalledWith('/users/admin/usage-statistics');
    expect(screen.getByRole('img', { name: /^CPU and memory history/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Active-user history/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Network traffic history/ })).toBeInTheDocument();
    expect(screen.getByText('42.0%')).toBeInTheDocument();
    expect(screen.getByText(/not Qlicker alone/i)).toBeInTheDocument();
    expect(screen.getByText(/5.2 GiB.*8.0 GiB.*2.8 GiB/)).toBeInTheDocument();
    expect(screen.getByText('1.0 KiB/s / 2.0 KiB/s')).toBeInTheDocument();
    expect(screen.getByText('Interfaces: wlp4s0')).toBeInTheDocument();
    expect(screen.getByText('System monitor started')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '7 days', exact: true }));
    await waitFor(() => expect(apiClientMock.get).toHaveBeenCalledWith(
      '/users/admin/system-monitoring', { params: { range: '7d' } }
    ));
  });

  it('keeps login statistics usable when monitoring is unavailable', async () => {
    systemMonitoringState = { status: 'unavailable', latest: null, history: [], peakPeriods: [], events: [] };
    renderDashboard();
    fireEvent.click(await screen.findByRole('tab', { name: /Usage Statistics/i }));
    expect(await screen.findByText('48')).toBeInTheDocument();
    expect(screen.getByText(/No system samples are available/)).toBeInTheDocument();
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'CPU and memory history' })).not.toBeInTheDocument();
  });

  it.each(['en', 'de', 'es', 'fr', 'it', 'pir', 'ru', 'zh'])('renders Usage Statistics without raw translation keys in %s', async (locale) => {
    await i18n.changeLanguage(locale);
    const { unmount } = renderDashboard();
    try {
      fireEvent.click(await screen.findByRole('tab', { name: i18n.t('admin.tabs.usageStatistics'), exact: true }));
      expect(await screen.findByText('42.0%')).toBeInTheDocument();
      const section = screen.getByRole('region', { name: i18n.t('admin.usageStatistics.systemMonitoring'), exact: true });
      expect(section.innerHTML).not.toMatch(/admin\.usageStatistics\./);
      expect(section.textContent).not.toContain('{{');
    } finally {
      unmount();
      await i18n.changeLanguage('en');
    }
  });

  it('requests a manual backup and shows 12-hour backup controls when the app uses 12-hour time', async () => {
    settingsState.timeFormat = '12h';
    localStorage.setItem('qlicker_timeFormat', '12h');

    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^Backup$/i }));

    const backupTimeField = await screen.findByTestId('backup-time-field');
    expect(within(backupTimeField).getByLabelText('Period')).toBeInTheDocument();
    expect(screen.getByText(/Last run at:/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Backup now/i }));

    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/settings/backup-now');
    });
    expect(screen.getByText(/Manual backup requested\./i)).toBeInTheDocument();
    expect(screen.getByText(/^Running$/i)).toBeInTheDocument();
  });

  it('warns when the backup manager is stale and disables manual backup requests', async () => {
    settingsState.backupLastRunStatus = 'running';
    settingsState.backupLastRunType = 'manual';
    settingsState.backupLastRunMessage = 'Manual backup requested.';
    settingsState.backupManagerStatus = 'stale';
    settingsState.backupManagerMessage = 'Backup manager heartbeat is stale. Check the backup-manager service and confirm ./backups on the host is writable.';
    settingsState.backupManagerIsStale = true;

    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^Backup$/i }));

    expect((await screen.findAllByText(/Backup manager heartbeat is stale/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/still marked as running, but the backup manager needs attention/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Backup now/i })).toBeDisabled();
  });

  it('resets a stuck backup request from the Backup tab', async () => {
    settingsState.backupLastRunStatus = 'running';
    settingsState.backupLastRunType = 'manual';
    settingsState.backupLastRunMessage = 'Manual backup requested.';
    settingsState.backupManagerStatus = 'stale';
    settingsState.backupManagerMessage = 'Backup manager heartbeat is stale. Check the backup-manager service and confirm ./backups on the host is writable.';
    settingsState.backupManagerIsStale = true;

    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^Backup$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Reset backup state/i }));

    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/settings/backup-reset');
    });

    expect(screen.queryByText(/still marked as running, but the backup manager needs attention/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Backup request state was reset by an admin\./i)).toBeInTheDocument();
  });

  it('sends only SSO fields when auto-saving from the SSO tab', async () => {
    settingsState.backupLastRunAt = null;
    settingsState.backupLastRunType = '';

    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /SSO Configuration/i }));

    const ssoToggle = await screen.findByRole('checkbox', { name: /Enable SSO/i });
    fireEvent.click(ssoToggle);

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    vi.useRealTimers();

    let ssoPatchCall;
    await waitFor(() => {
      ssoPatchCall = apiClientMock.patch.mock.calls.find(
        ([url, payload]) => url === '/settings' && Object.prototype.hasOwnProperty.call(payload, 'SSO_enabled')
      );
      expect(ssoPatchCall).toBeTruthy();
    });

    const [, payload] = ssoPatchCall;
    expect(payload).toMatchObject({
      SSO_enabled: false,
      SSO_routeMode: 'legacy',
    });
    expect(payload).not.toHaveProperty('backupLastRunAt');
    expect(payload).not.toHaveProperty('backupLastRunType');
    expect(payload).not.toHaveProperty('backupLastRunStatus');
    expect(payload).not.toHaveProperty('storageType');
  });

  it('persists AI enablement and course policy immediately before leaving the AI tab', async () => {
    coursesState = [buildCourse()];
    const { unmount } = renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^AI$/i }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /^Enable AI helper$/i }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/settings', expect.objectContaining({
        AI_Enabled: true,
      }));
    });

    fireEvent.click(screen.getByRole('button', { name: /Course 1/i }));
    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/settings', expect.objectContaining({
        AI_Enabled: true,
        AI_EnabledCourses: ['course-1'],
      }));
    });

    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    vi.useRealTimers();
    expect(apiClientMock.patch.mock.calls.filter(([url]) => url === '/settings')).toHaveLength(2);

    unmount();
    renderDashboard();
    fireEvent.click(await screen.findByRole('tab', { name: /^AI$/i }));
    expect(await screen.findByRole('checkbox', { name: /^Enable AI helper$/i })).toBeChecked();
    expect(screen.getByRole('button', { name: /Course 1/i })).toBeInTheDocument();
  });

  it('persists the global AI request timeout from the admin AI tab', async () => {
    settingsState = { ...settingsState, AI_Enabled: true, AI_RequestTimeoutSeconds: 300 };
    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^AI$/i }));
    const timeoutField = await screen.findByRole('spinbutton', { name: 'AI request timeout (seconds)' });
    expect(timeoutField).toHaveValue(300);
    fireEvent.change(timeoutField, { target: { value: '420' } });

    await waitFor(() => expect(apiClientMock.patch).toHaveBeenCalledWith('/settings', expect.objectContaining({
      AI_RequestTimeoutSeconds: 420,
    })));
  });

  it('loads every course in the AI and video policy tabs', async () => {
    settingsState = { ...settingsState, Jitsi_Enabled: true };
    coursesState = Array.from({ length: 501 }, (_, index) => buildCourse({
      _id: `course-${index + 1}`,
      name: `Course ${index + 1}`,
    }));
    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^AI$/i }));
    expect(await screen.findByText(/CS 101: Course 501/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Video/i }));
    expect(await screen.findByText(/CS 101: Course 501/)).toBeInTheDocument();

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/courses', expect.objectContaining({
        params: expect.objectContaining({ page: 2, limit: 500, view: 'all' }),
      }));
    });
  });

  it('keeps saved AI settings visible when the course-policy list cannot load', async () => {
    settingsState = {
      ...settingsState,
      AI_Enabled: true,
      AI_Backends: [{ id: 'ollama-1', name: 'Local Ollama', type: 'ollama', url: 'http://localhost:11434', models: [] }],
      AI_EnabledCourses: ['course-1'],
    };
    const defaultGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation((url, config) => {
      if (url === '/courses') return Promise.reject(new Error('Courses unavailable'));
      return defaultGet(url, config);
    });

    renderDashboard();
    fireEvent.click(await screen.findByRole('tab', { name: /^AI$/i }));

    expect(await screen.findByRole('checkbox', { name: /^Enable AI helper$/i })).toBeChecked();
    expect(screen.getByDisplayValue('Local Ollama')).toBeInTheDocument();
  });

  it('disables and restores a user account from the Users tab', async () => {
    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^Users$/i }));
    fireEvent.change(await screen.findByPlaceholderText(/Search by name or email/i), {
      target: { value: 'student@example.com' },
    });

    const getUserRow = () => screen.getByText('student@example.com').closest('tr');
    const userRow = await waitFor(() => {
      const row = getUserRow();
      expect(row).not.toBeNull();
      return row;
    });

    fireEvent.click(within(userRow).getByRole('button', { name: /^Disable user$/i }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/users/student-1/properties', {
        disabled: true,
      });
    });
    expect(within(getUserRow()).getByText(/^Disabled$/i)).toBeInTheDocument();

    fireEvent.click(within(getUserRow()).getByRole('button', { name: /^Restore user$/i }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/users/student-1/properties', {
        disabled: false,
      });
    });
    expect(within(getUserRow()).queryByText(/^Disabled$/i)).not.toBeInTheDocument();
  });

  it('loads users sorted by last login by default and lets admins change the sort column', async () => {
    usersState = [
      buildUser({
        _id: 'student-1',
        emails: [{ address: 'zoe@example.com', verified: true }],
        profile: { firstname: 'Zoe', lastname: 'Zimmer', roles: ['student'] },
        lastLogin: '2026-03-28T10:00:00.000Z',
      }),
      buildUser({
        _id: 'student-2',
        emails: [{ address: 'amy@example.com', verified: false }],
        profile: { firstname: 'Amy', lastname: 'Able', roles: ['student'] },
        lastLogin: '2026-03-29T10:00:00.000Z',
      }),
      buildUser({
        _id: 'student-3',
        emails: [{ address: 'mike@example.com', verified: true }],
        profile: { firstname: 'Mike', lastname: 'Middle', roles: ['professor'] },
        lastLogin: null,
      }),
    ];
    userDetailsState = new Map(usersState.map((user) => [user._id, { ...user }]));

    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^Users$/i }));

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/users', {
        params: expect.objectContaining({
          page: 1,
          limit: 20,
          sortBy: 'lastLogin',
          sortDirection: 'desc',
        }),
      });
    });

    await waitFor(() => {
      expect(screen.getAllByRole('row').map((row) => row.textContent)).toEqual(expect.arrayContaining([
        expect.stringContaining('amy@example.com'),
        expect.stringContaining('zoe@example.com'),
        expect.stringContaining('mike@example.com'),
      ]));
    });

    let bodyRows = screen.getAllByRole('row').slice(1);
    expect(within(bodyRows[0]).getByText('amy@example.com')).toBeInTheDocument();
    expect(within(bodyRows[1]).getByText('zoe@example.com')).toBeInTheDocument();
    expect(within(bodyRows[2]).getByText('mike@example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Name$/i }));

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenLastCalledWith('/users', {
        params: expect.objectContaining({
          page: 1,
          limit: 20,
          sortBy: 'name',
          sortDirection: 'asc',
        }),
      });
    });

    bodyRows = screen.getAllByRole('row').slice(1);
    expect(within(bodyRows[0]).getByText('amy@example.com')).toBeInTheDocument();
    expect(within(bodyRows[1]).getByText('mike@example.com')).toBeInTheDocument();
    expect(within(bodyRows[2]).getByText('zoe@example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Name$/i }));

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenLastCalledWith('/users', {
        params: expect.objectContaining({
          page: 1,
          limit: 20,
          sortBy: 'name',
          sortDirection: 'desc',
        }),
      });
    });

    bodyRows = screen.getAllByRole('row').slice(1);
    expect(within(bodyRows[0]).getByText('zoe@example.com')).toBeInTheDocument();
    expect(within(bodyRows[1]).getByText('mike@example.com')).toBeInTheDocument();
    expect(within(bodyRows[2]).getByText('amy@example.com')).toBeInTheDocument();
  });

  it('uses new-password autocomplete for admin reset password fields', async () => {
    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^Users$/i }));
    fireEvent.change(await screen.findByPlaceholderText(/Search by name or email/i), {
      target: { value: 'student@example.com' },
    });

    const userRow = await waitFor(() => {
      const row = screen.getByText('student@example.com').closest('tr');
      expect(row).not.toBeNull();
      return row;
    });

    fireEvent.click(within(userRow).getByRole('button', { name: /Open user properties/i }));

    const [newPasswordField] = await screen.findAllByLabelText(/New Password/i);
    const confirmPasswordField = screen.getByLabelText(/Confirm New Password/i);

    expect(newPasswordField.getAttribute('autocomplete')).toContain('new-password');
    expect(confirmPasswordField.getAttribute('autocomplete')).toContain('new-password');
    expect(newPasswordField.getAttribute('autocomplete')).not.toBe(confirmPasswordField.getAttribute('autocomplete'));
    expect(newPasswordField).toHaveAttribute('data-lpignore', 'true');
    expect(confirmPasswordField).toHaveAttribute('data-lpignore', 'true');
    expect(newPasswordField).toHaveAttribute('data-1p-ignore', 'true');
    expect(confirmPasswordField).toHaveAttribute('data-1p-ignore', 'true');
    expect(newPasswordField).toHaveAttribute('data-bwignore', 'true');
    expect(confirmPasswordField).toHaveAttribute('data-bwignore', 'true');

    fireEvent.change(newPasswordField, { target: { value: 'newpassword456' } });
    fireEvent.change(confirmPasswordField, { target: { value: 'n' } });
    expect(confirmPasswordField).toHaveValue('n');
    fireEvent.change(confirmPasswordField, { target: { value: 'newpassword456' } });
    expect(confirmPasswordField).toHaveValue('newpassword456');
    fireEvent.click(screen.getByRole('button', { name: /^Reset password$/i }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/users/student-1/password', {
        newPassword: 'newpassword456',
      });
    });
  });

  it('opens the system notification manager from the Users tab', async () => {
    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^Users$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /notifications/i }));

    expect(await screen.findByRole('heading', { name: /^manage system notifications$/i })).toBeInTheDocument();
  });

  it('shows the first 50 courses by default and searches across the full fetched course set', async () => {
    coursesState = Array.from({ length: 55 }, (_, index) => buildCourse({
      _id: `course-${index + 1}`,
      name: index >= 50 ? `Hidden Course ${index + 1}` : `Visible Course ${index + 1}`,
      courseNumber: String(101 + index),
      createdAt: new Date(Date.UTC(2026, 2, 30, 0, 55 - index, 0)).toISOString(),
    }));
    const hiddenCourse = buildCourse({
      _id: 'course-hidden-search',
      name: 'Special Astronomy Seminar',
      courseNumber: '999',
      createdAt: '2026-03-29T00:00:00.000Z',
    });
    coursesState[54] = hiddenCourse;

    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^Courses$/i }));

    await screen.findByRole('button', { name: /Show all 55/i });

    expect(screen.queryByText(/Special Astronomy Seminar/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Search courses by code, section, name, or semester/i), {
      target: { value: 'astronomy' },
    });

    expect(await screen.findByText(/CS 999: Special Astronomy Seminar/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show all 55/i })).not.toBeInTheDocument();
  });

  it('fetches additional pages for the admin courses tab before rendering the full result count', async () => {
    coursesState = Array.from({ length: 501 }, (_, index) => buildCourse({
      _id: `course-${index + 1}`,
      name: `Course ${index + 1}`,
      courseNumber: String(100 + index),
      createdAt: new Date(Date.UTC(2026, 2, 30, 0, 0, 501 - index)).toISOString(),
    }));

    renderDashboard();

    fireEvent.click(await screen.findByRole('tab', { name: /^Courses$/i }));

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/courses', expect.objectContaining({
        params: { view: 'all', page: 1, limit: 500 },
      }));
      expect(apiClientMock.get).toHaveBeenCalledWith('/courses', expect.objectContaining({
        params: { view: 'all', page: 2, limit: 500 },
      }));
    });

    expect(await screen.findByText(/501 course\(s\)/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show all 501/i })).toBeInTheDocument();
  });
});
