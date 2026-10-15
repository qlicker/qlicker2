import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import QuizSession from './QuizSession';
import apiClient from '../../api/client';
import i18n from '../../i18n';
import { QUESTION_TYPES } from '../../components/questions/constants';

const authState = vi.hoisted(() => ({ user: { profile: { roles: ['student'] } } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState }));

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
  },
  getAccessToken: vi.fn(() => null),
}));

describe('Student QuizSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user.profile.roles = ['student'];
    i18n.changeLanguage('en');

    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/quiz') {
        return {
          data: {
            session: {
              _id: 'session-1',
              name: 'Math quiz',
              quiz: true,
              practiceQuiz: false,
              studentCreated: false,
            },
            questions: [
              {
                _id: 'q-1',
                type: QUESTION_TYPES.MULTIPLE_CHOICE,
                content: '<p>Select the correct option</p>',
                plainText: 'Select the correct option',
                options: [
                  {
                    _id: 'opt-1',
                    content: '<p><br></p>',
                    plainText: '\\(x^2\\)',
                    correct: true,
                  },
                  {
                    _id: 'opt-2',
                    content: '<p>Not math</p>',
                    plainText: 'Not math',
                    correct: false,
                  },
                ],
                sessionOptions: { points: 1 },
              },
            ],
            responses: {},
            allAnswered: false,
            submitted: false,
          },
        };
      }

      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it('renders math from option plain-text fallbacks for quiz MC options', async () => {
    const view = (
      <MemoryRouter initialEntries={['/student/course/course-1/session/session-1/quiz']}>
        <Routes>
          <Route path="/student/course/:courseId/session/:sessionId/quiz" element={<QuizSession />} />
        </Routes>
      </MemoryRouter>
    );
    const { container, rerender } = render(view);

    expect(await screen.findByText('Math quiz')).toBeInTheDocument();

    await waitFor(() => {
      expect(container.querySelector('.katex')).not.toBeNull();
    });

    rerender(view);

    await waitFor(() => {
      expect(container.querySelector('.katex')).not.toBeNull();
    });
    expect(screen.queryByText('\\(x^2\\)')).not.toBeInTheDocument();
  });

  it('keeps numerical answers unchanged on wheel without cancelling page scrolling', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        session: {
          _id: 'session-1',
          name: 'Math quiz',
          quiz: true,
          practiceQuiz: false,
          studentCreated: false,
        },
        questions: [
          {
            _id: 'q-1',
            type: QUESTION_TYPES.NUMERICAL,
            content: '<p>Estimate the value</p>',
            plainText: 'Estimate the value',
            toleranceNumerical: 0.00012,
            sessionOptions: { points: 1 },
          },
        ],
        responses: {},
        allAnswered: false,
        submitted: false,
      },
    });

    render(
      <MemoryRouter initialEntries={['/student/course/course-1/session/session-1/quiz']}>
        <Routes>
          <Route path="/student/course/:courseId/session/:sessionId/quiz" element={<QuizSession />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('Answers will be scored based on a tolerance of +/- 1.2E-4.')).toBeInTheDocument();

    apiClient.patch.mockResolvedValue({ data: {} });
    const input = screen.getByRole('spinbutton', { name: 'Enter a number' });
    fireEvent.change(input, { target: { value: '-1.25e-3' } });
    await waitFor(() => expect(apiClient.patch).toHaveBeenCalledWith(
      '/sessions/session-1/quiz-response',
      { questionId: 'q-1', answer: '-1.25e-3' },
    ));
    apiClient.patch.mockClear();

    for (const deltaY of [100, -100]) {
      input.focus();
      expect(input).toHaveFocus();
      expect(fireEvent.wheel(input, { deltaY, cancelable: true })).toBe(true);
      expect(input).not.toHaveFocus();
      expect(input.value).toBe('-1.25e-3');
      expect(fireEvent.wheel(input, { deltaY, cancelable: true })).toBe(true);
      expect(input.value).toBe('-1.25e-3');
    }
    expect(apiClient.patch).not.toHaveBeenCalled();
  });
  it.each([['student', '/student'], ['professor', '/prof']])('returns an activity participant to the %s dashboard', async (role, destination) => {
    authState.user.profile.roles = [role];
    render(
      <MemoryRouter initialEntries={['/activity/course-1/session/session-1/quiz']}>
        <Routes>
          <Route path="/activity/:courseId/session/:sessionId/quiz" element={<QuizSession />} />
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
