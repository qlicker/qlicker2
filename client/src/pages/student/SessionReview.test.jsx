import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SessionReview from './SessionReview';
import apiClient from '../../api/client';
import i18n from '../../i18n';

const authState = vi.hoisted(() => ({ user: { profile: { roles: ['student'] } } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState }));

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('Student SessionReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user.profile.roles = ['student'];
    i18n.changeLanguage('en');

    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/review') {
        return {
          data: {
            session: {
              _id: 'session-1',
              name: 'Practice review',
              quiz: true,
              practiceQuiz: true,
              studentCreated: true,
            },
            questions: [
              {
                _id: 'q-1',
                type: 0,
                content: '<p>Choose the expression \\(x^2 + y^2\\)</p>',
                plainText: 'Choose the expression \\(x^2 + y^2\\)',
                sessionOptions: { points: 1 },
                options: [
                  { answer: 'A', plainText: '\\(x^2 + y^2\\)', correct: true },
                  { answer: 'B', plainText: 'B', correct: false },
                ],
              },
            ],
            responses: {
              'q-1': [{ attempt: 1, answer: '0' }],
            },
            feedback: {
              feedbackSeenAt: null,
              feedbackQuestionIds: [],
              feedbackCount: 0,
              newFeedbackQuestionIds: [],
              newFeedbackCount: 0,
              hasNewFeedback: false,
            },
          },
        };
      }

      if (url === '/sessions/session-1/grades') {
        return {
          data: {
            grades: [
              {
                userId: 'student-1',
                value: 100,
                points: 1,
                outOf: 1,
                participation: 100,
                marks: [{ questionId: 'q-1', points: 1, outOf: 1 }],
              },
            ],
          },
        };
      }

      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it('renders without hook-order warnings after loading review data', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <MemoryRouter initialEntries={['/student/course/course-1/session/session-1/review']}>
        <Routes>
          <Route path="/student/course/:courseId/session/:sessionId/review" element={<SessionReview />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('Practice review')).toBeInTheDocument();

    await waitFor(() => {
      expect(
        consoleErrorSpy.mock.calls.some((call) => (
          call.some((value) => String(value).includes('change in the order of Hooks'))
        ))
      ).toBe(false);
    });

    expect(apiClient.get).not.toHaveBeenCalledWith('/sessions/session-1/grades');

    consoleErrorSpy.mockRestore();
  });

  it('renders question and option math without exposing TeX delimiters', async () => {
    const view = (
      <MemoryRouter initialEntries={['/student/course/course-1/session/session-1/review']}>
        <Routes>
          <Route path="/student/course/:courseId/session/:sessionId/review" element={<SessionReview />} />
        </Routes>
      </MemoryRouter>
    );
    const { container, rerender } = render(view);

    expect(await screen.findByText('Practice review')).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
    });
    expect(container.textContent).not.toContain('\\(');

    rerender(view);

    await waitFor(() => {
      expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
    });
    expect(container.textContent).not.toContain('\\(');
  });

  it('tells students when a reviewed session was anonymous', async () => {
    const defaultGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation(async (url) => {
      const response = await defaultGet(url);
      if (url === '/sessions/session-1/review') {
        response.data.session = { ...response.data.session, anonymous: true, practiceQuiz: false, studentCreated: false };
        response.data.grade = null;
      }
      return response;
    });

    render(
      <MemoryRouter initialEntries={['/student/course/course-1/session/session-1/review']}>
        <Routes>
          <Route path="/student/course/:courseId/session/:sessionId/review" element={<SessionReview />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText(/your instructor cannot see which responses are yours/i)).toBeInTheDocument();
  });
  it.each([['student', '/student'], ['professor', '/prof']])('returns an activity participant to the %s dashboard', async (role, destination) => {
    authState.user.profile.roles = [role];
    render(
      <MemoryRouter initialEntries={['/activity/course-1/session/session-1/review']}>
        <Routes>
          <Route path="/activity/:courseId/session/:sessionId/review" element={<SessionReview />} />
          <Route path={destination} element={<div>Participant dashboard</div>} />
        </Routes>
      </MemoryRouter>
    );
    const back = await screen.findByRole('button', { name: 'Back to dashboard' });
    expect(screen.queryByRole('button', { name: 'Back to Course' })).not.toBeInTheDocument();
    fireEvent.click(back);
    expect(await screen.findByText('Participant dashboard')).toBeInTheDocument();
  });

});
