import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import ProfDashboard from './ProfDashboard';

const {
  apiClientMock,
  authState,
  fetchAllCoursesMock,
  loadUserMock,
  navigateMock,
  tMock,
} = vi.hoisted(() => ({
  apiClientMock: {
    get: vi.fn(),
    post: vi.fn(),
  },
  authState: {
    user: {
      profile: {
        roles: ['professor'],
      },
    },
    loadUser: vi.fn(),
  },
  fetchAllCoursesMock: vi.fn(),
  loadUserMock: vi.fn(),
  navigateMock: vi.fn(),
  tMock: vi.fn((key, options) => options?.defaultValue ?? key),
}));

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({ t: tMock }),
  };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('../../api/client', () => ({
  default: apiClientMock,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    ...authState,
    loadUser: loadUserMock,
  }),
}));

vi.mock('../../utils/fetchAllCourses', () => ({
  fetchAllCourses: fetchAllCoursesMock,
}));

describe('ProfDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = {
      profile: {
        roles: ['professor'],
      },
      hasStudentCourses: false,
    };
    loadUserMock.mockReset();
    loadUserMock.mockResolvedValue(undefined);
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/sessions/live') {
        return Promise.resolve({ data: { liveSessions: [] } });
      }
      return Promise.resolve({ data: {} });
    });
    fetchAllCoursesMock
      .mockResolvedValueOnce([
        {
          _id: 'course-instructor',
          name: 'Instructor Course',
          deptCode: 'CS',
          courseNumber: '101',
          section: '001',
          semester: 'Fall 2026',
          lastActivityAt: '2026-04-01T00:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          _id: 'course-student',
          name: 'Student Course',
          deptCode: 'CS',
          courseNumber: '102',
          section: '001',
          semester: 'Fall 2026',
          lastActivityAt: '2026-04-05T00:00:00.000Z',
        },
      ])
      .mockResolvedValue([
        {
          _id: 'course-student',
          name: 'Student Course',
          deptCode: 'CS',
          courseNumber: '102',
          section: '001',
          semester: 'Fall 2026',
          lastActivityAt: '2026-04-05T00:00:00.000Z',
        },
      ]);
  });

  function renderDashboard() {
    return render(
      <MemoryRouter>
        <ProfDashboard />
      </MemoryRouter>
    );
  }

  it('merges instructor and student course lists and marks student enrollments', async () => {
    renderDashboard();

    await waitFor(() => {
      expect(fetchAllCoursesMock).toHaveBeenCalledTimes(2);
    });

    expect(fetchAllCoursesMock).toHaveBeenNthCalledWith(1, apiClientMock, { view: 'instructor' }, expect.objectContaining({ signal: expect.anything() }));
    expect(fetchAllCoursesMock).toHaveBeenNthCalledWith(2, apiClientMock, { view: 'student' }, expect.objectContaining({ signal: expect.anything() }));

    const studentCourseCard = screen.getByText('CS 102').closest('.MuiCard-root');
    expect(studentCourseCard).not.toBeNull();
    expect(within(studentCourseCard).getByText('professor.dashboard.enrolledAsStudent')).toBeInTheDocument();

    fireEvent.click(studentCourseCard);
    expect(navigateMock).toHaveBeenCalledWith('/student/course/course-student');
  });

  it('enrolls in a course as a student from the professor dashboard', async () => {
    apiClientMock.post.mockResolvedValue({ data: {} });

    renderDashboard();

    await waitFor(() => {
      expect(fetchAllCoursesMock).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'professor.dashboard.enrollInCourseAsStudent' }));
    fireEvent.change(screen.getByLabelText('student.dashboard.enrollmentCode'), {
      target: { value: 'ABC123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'student.dashboard.enroll' }));

    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/courses/enroll', { enrollmentCode: 'ABC123' });
    });
    await waitFor(() => {
      expect(fetchAllCoursesMock).toHaveBeenCalledTimes(4);
    });
    expect(loadUserMock).toHaveBeenCalled();
  });
});
