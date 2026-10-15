import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LiveSession from './LiveSession';
import apiClient from '../../api/client';
import i18n from '../../i18n';
import { QUESTION_TYPES } from '../../components/questions/constants';

const websocketState = vi.hoisted(() => ({ lastEvent: null }));
const liveSessionMocks = vi.hoisted(() => ({
  registerRefreshHandler: vi.fn(() => () => {}),
  recordEventReceipt: vi.fn(() => null),
  recordLiveFetch: vi.fn(() => null),
  scheduleUiSyncMeasurement: vi.fn(),
}));

const authState = vi.hoisted(() => ({ user: { profile: { roles: ['student'] } } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => authState }));

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('../../contexts/LiveSessionWebSocketContext', () => ({
  LiveSessionWebSocketProvider: ({ children }) => children,
  useLiveSessionWebSocket: () => ({
    lastEvent: websocketState.lastEvent,
    registerRefreshHandler: liveSessionMocks.registerRefreshHandler,
    transport: 'polling',
  }),
}));

vi.mock('../../components/live/SessionChatPanel', () => ({
  default: () => <div>Session chat panel</div>,
}));

vi.mock('../../hooks/useLiveSessionTelemetry', () => ({
  default: () => ({
    recordEventReceipt: liveSessionMocks.recordEventReceipt,
    recordLiveFetch: liveSessionMocks.recordLiveFetch,
    scheduleUiSyncMeasurement: liveSessionMocks.scheduleUiSyncMeasurement,
  }),
}));

describe('Student LiveSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user.profile.roles = ['student'];
    websocketState.lastEvent = null;
    i18n.changeLanguage('en');

    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/live') {
        return {
          data: {
            session: {
              _id: 'session-1',
              name: 'Live math session',
              status: 'running',
              chatEnabled: true,
            },
            currentQuestion: {
              _id: 'q-1',
              type: QUESTION_TYPES.MULTI_SELECT,
              content: '<p>Select all matching options</p>',
              plainText: 'Select all matching options',
              options: [
                {
                  _id: 'opt-1',
                  content: '<p><br></p>',
                  plainText: '\\(x^2\\)',
                  correct: true,
                },
                {
                  _id: 'opt-2',
                  content: '<p>Other</p>',
                  plainText: 'Other',
                  correct: false,
                },
              ],
              sessionOptions: {
                hidden: false,
                stats: false,
                correct: false,
                attempts: [{ number: 1, closed: false }],
              },
            },
            currentAttempt: { number: 1, closed: false },
            isJoined: true,
            questionHidden: false,
            showStats: false,
            showCorrect: false,
            responseStats: null,
            studentResponse: null,
            questionCount: 1,
            questionNumber: 1,
            questionProgress: { current: 1, total: 1 },
            pageProgress: { current: 1, total: 1 },
          },
        };
      }

      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it('renders math from option plain-text fallbacks for live MS options', async () => {
    const view = (
      <MemoryRouter initialEntries={['/student/course/course-1/live/session-1']}>
        <Routes>
          <Route path="/student/course/:courseId/live/:sessionId" element={<LiveSession />} />
        </Routes>
      </MemoryRouter>
    );
    const { container, rerender } = render(view);

    expect(await screen.findByText('Live math session')).toBeInTheDocument();

    await waitFor(() => {
      expect(container.querySelector('.katex')).not.toBeNull();
    });

    rerender(view);

    await waitFor(() => {
      expect(container.querySelector('.katex')).not.toBeNull();
    });
    expect(screen.queryByText('\\(x^2\\)')).not.toBeInTheDocument();
  });

  it('shows numerical tolerance helper text next to the live answer input', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        session: {
          _id: 'session-1',
          name: 'Live math session',
          status: 'running',
        },
        currentQuestion: {
          _id: 'q-1',
          type: QUESTION_TYPES.NUMERICAL,
          content: '<p>Estimate the value</p>',
          plainText: 'Estimate the value',
          toleranceNumerical: 12345,
          sessionOptions: {
            hidden: false,
            stats: false,
            correct: false,
            attempts: [{ number: 1, closed: false }],
          },
        },
        currentAttempt: { number: 1, closed: false },
        isJoined: true,
        questionHidden: false,
        showStats: false,
        showCorrect: false,
        responseStats: null,
        studentResponse: null,
        questionCount: 1,
        questionNumber: 1,
        questionProgress: { current: 1, total: 1 },
        pageProgress: { current: 1, total: 1 },
      },
    });

    render(
      <MemoryRouter initialEntries={['/student/course/course-1/live/session-1']}>
        <Routes>
          <Route path="/student/course/:courseId/live/:sessionId" element={<LiveSession />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText(/Answers will be scored based on a tolerance of \+\/- 1\.2345E4\./i)).toBeInTheDocument();
  });

  it.each(['post-created', 'comment-added', 'quick-post-toggled'])('shows %s as unread in red and clears it as soon as chat is opened', async (changeType) => {
    const buildView = () => (
      <MemoryRouter initialEntries={['/student/course/course-1/live/session-1']}>
        <Routes>
          <Route path="/student/course/:courseId/live/:sessionId" element={<LiveSession />} />
        </Routes>
      </MemoryRouter>
    );
    const { rerender } = render(buildView());
    expect(await screen.findByText('Live math session')).toBeInTheDocument();

    websocketState.lastEvent = {
      event: 'session:chat-updated',
      data: {
        changeType,
        becameVisible: true,
        postId: 'quick-post-new',
      },
      receivedAtMs: Date.now(),
    };
    rerender(buildView());

    const chatTab = await screen.findByRole('tab', { name: /Chat/ });
    await waitFor(() => {
      const unreadLabel = within(chatTab).getByText('1');
      expect(unreadLabel.closest('.MuiChip-root')).toHaveClass('MuiChip-colorError');
    });

    fireEvent.click(chatTab);
    expect(screen.getByText('Session chat panel')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: 'Chat' })).queryByText('1')).not.toBeInTheDocument();
  });

  it('applies complete stats immediately when navigating forward and back between questions', async () => {
    const buildView = () => (
      <MemoryRouter initialEntries={['/student/course/course-1/live/session-1']}>
        <Routes>
          <Route path="/student/course/:courseId/live/:sessionId" element={<LiveSession />} />
        </Routes>
      </MemoryRouter>
    );
    const { rerender } = render(buildView());
    expect(await screen.findByText('Live math session')).toBeInTheDocument();

    websocketState.lastEvent = {
      event: 'session:question-changed',
      data: {
        sessionId: 'session-1',
        questionId: 'q-2',
        question: {
          _id: 'q-2',
          type: QUESTION_TYPES.MULTIPLE_CHOICE,
          content: '<p>Second question</p>',
          options: [{ content: '<p>A</p>' }, { content: '<p>B</p>' }],
          sessionOptions: { hidden: false, stats: false, correct: false },
        },
        currentAttempt: { number: 1, closed: false },
        questionHidden: false,
        showStats: false,
        showCorrect: false,
        responseStats: null,
        studentResponse: null,
        questionNumber: 2,
        questionCount: 2,
      },
      receivedAtMs: Date.now(),
    };
    rerender(buildView());
    expect(await screen.findByText('Second question')).toBeInTheDocument();
    expect(screen.queryByText('75%')).not.toBeInTheDocument();

    websocketState.lastEvent = {
      event: 'session:question-changed',
      data: {
        sessionId: 'session-1',
        questionId: 'q-1',
        question: {
          _id: 'q-1',
          type: QUESTION_TYPES.MULTIPLE_CHOICE,
          content: '<p>First question again</p>',
          options: [{ content: '<p>A</p>' }, { content: '<p>B</p>' }],
          sessionOptions: { hidden: false, stats: true, correct: false },
        },
        currentAttempt: { number: 1, closed: false },
        questionHidden: false,
        showStats: true,
        showCorrect: false,
        responseStats: {
          type: 'distribution',
          total: 4,
          distribution: [
            { index: 0, answer: 'A', count: 3 },
            { index: 1, answer: 'B', count: 1 },
          ],
        },
        studentResponse: null,
        questionNumber: 1,
        questionCount: 2,
      },
      receivedAtMs: Date.now(),
    };
    rerender(buildView());

    expect(await screen.findByText('First question again')).toBeInTheDocument();
    expect(await screen.findByText('75%')).toBeInTheDocument();
    expect(screen.getByText(/response statistics are visible/i)).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('refreshes immediately when a stats-enabled navigation event is incomplete', async () => {
    const buildView = () => (
      <MemoryRouter initialEntries={['/student/course/course-1/live/session-1']}>
        <Routes>
          <Route path="/student/course/:courseId/live/:sessionId" element={<LiveSession />} />
        </Routes>
      </MemoryRouter>
    );
    const { rerender } = render(buildView());
    expect(await screen.findByText('Live math session')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    websocketState.lastEvent = {
      event: 'session:question-changed',
      data: {
        sessionId: 'session-1',
        questionId: 'q-2',
        question: {
          _id: 'q-2',
          type: QUESTION_TYPES.MULTIPLE_CHOICE,
          content: '<p>Incomplete stats snapshot</p>',
          options: [{ content: '<p>A</p>' }, { content: '<p>B</p>' }],
          sessionOptions: { hidden: false, stats: true, correct: false },
        },
        questionHidden: false,
        showStats: true,
        showCorrect: false,
      },
      receivedAtMs: Date.now(),
    };
    rerender(buildView());

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
  });

  it('applies role-safe stats and correct-answer snapshots without refetching live state', async () => {
    const buildView = () => (
      <MemoryRouter initialEntries={['/student/course/course-1/live/session-1']}>
        <Routes>
          <Route path="/student/course/:courseId/live/:sessionId" element={<LiveSession />} />
        </Routes>
      </MemoryRouter>
    );
    const { rerender } = render(buildView());
    expect(await screen.findByText('Live math session')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    websocketState.lastEvent = {
      event: 'session:visibility-changed',
      data: {
        sessionId: 'session-1',
        questionId: 'q-1',
        question: {
          _id: 'q-1',
          type: QUESTION_TYPES.MULTI_SELECT,
          content: '<p>Select all matching options</p>',
          options: [
            { content: '<p>First</p>' },
            { content: '<p>Other</p>' },
          ],
          sessionOptions: { hidden: false, stats: true, correct: false },
        },
        currentAttempt: { number: 1, closed: false },
        questionHidden: false,
        showStats: true,
        showCorrect: false,
        showResponseList: true,
        responseStats: {
          type: 'distribution',
          total: 2,
          distribution: [
            { index: 0, answer: 'First', count: 2 },
            { index: 1, answer: 'Other', count: 0 },
          ],
        },
      },
      receivedAtMs: Date.now(),
    };
    rerender(buildView());

    await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument());
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    websocketState.lastEvent = {
      event: 'session:visibility-changed',
      data: {
        sessionId: 'session-1',
        questionId: 'q-1',
        question: {
          _id: 'q-1',
          type: QUESTION_TYPES.MULTI_SELECT,
          content: '<p>Select all matching options</p>',
          options: [
            { content: '<p>First</p>' },
            { content: '<p>Other</p>' },
          ],
          sessionOptions: { hidden: false, stats: false, correct: false },
        },
        currentAttempt: { number: 1, closed: false },
        questionHidden: false,
        showStats: false,
        showCorrect: false,
        showResponseList: true,
        responseStats: null,
      },
      receivedAtMs: Date.now(),
    };
    rerender(buildView());

    await waitFor(() => expect(screen.queryByText('100%')).not.toBeInTheDocument());
    expect(apiClient.get).toHaveBeenCalledTimes(1);

    websocketState.lastEvent = {
      event: 'session:visibility-changed',
      data: {
        sessionId: 'session-1',
        questionId: 'q-1',
        question: {
          _id: 'q-1',
          type: QUESTION_TYPES.MULTI_SELECT,
          content: '<p>Select all matching options</p>',
          options: [
            { content: '<p>First</p>', correct: true },
            { content: '<p>Other</p>', correct: false },
          ],
          solution: '<p>The first option is correct.</p>',
          sessionOptions: { hidden: false, stats: true, correct: true },
        },
        currentAttempt: { number: 1, closed: false },
        questionHidden: false,
        showStats: true,
        showCorrect: true,
        showResponseList: true,
        responseStats: {
          type: 'distribution',
          total: 2,
          distribution: [
            { index: 0, answer: 'First', count: 2, correct: true },
            { index: 1, answer: 'Other', count: 0, correct: false },
          ],
        },
      },
      receivedAtMs: Date.now(),
    };
    rerender(buildView());

    expect(await screen.findByText('The first option is correct.')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });
  it.each([['student', '/student'], ['professor', '/prof']])('returns an activity participant to the %s dashboard', async (role, destination) => {
    authState.user.profile.roles = [role];
    render(
      <MemoryRouter initialEntries={['/activity/course-1/session/session-1/live']}>
        <Routes>
          <Route path="/activity/:courseId/session/:sessionId/live" element={<LiveSession />} />
          <Route path={destination} element={<div>Participant dashboard</div>} />
        </Routes>
      </MemoryRouter>
    );
    const back = await screen.findByRole('button', { name: 'Back to dashboard' });
    expect(screen.queryByRole('button', { name: 'Back to Course' })).not.toBeInTheDocument();
    fireEvent.click(back);
    expect(await screen.findByText('Participant dashboard')).toBeInTheDocument();
  });
  it.each([
    ['course', '/student/course/course-1/live/session-1', '/student/course/course-1', 'student'],
    ['guest', '/activity/course-1/session/session-1/live', '/student', 'student'],
    ['professor guest', '/activity/course-1/session/session-1/live', '/prof', 'professor'],
  ])('leaves Draft and waits through Upcoming for a %s participant', async (_kind, path, destination, role) => {
    authState.user.profile.roles = [role];
    let status = 'running';
    const originalGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation(async (...args) => {
      const response = await originalGet(...args);
      return { data: { ...response.data, session: { ...response.data.session, status } } };
    });
    const view = () => (
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/student/course/:courseId/live/:sessionId" element={<LiveSession />} />
          <Route path="/activity/:courseId/session/:sessionId/live" element={<LiveSession />} />
          <Route path={destination} element={<div>Returned to destination</div>} />
        </Routes>
      </MemoryRouter>
    );
    const { rerender } = render(view());
    expect(await screen.findByText('Select all matching options')).toBeInTheDocument();
    status = 'visible';
    websocketState.lastEvent = { event: 'session:metadata-changed', data: { sessionId: 'session-1' } };
    rerender(view());
    expect(await screen.findByText('This session has not started yet. Please wait for your instructor.')).toBeInTheDocument();
    expect(screen.queryByText('Select all matching options')).not.toBeInTheDocument();
    status = 'running';
    websocketState.lastEvent = { event: 'session:status-changed', data: { sessionId: 'session-1', status } };
    rerender(view());
    expect(await screen.findByText('Select all matching options')).toBeInTheDocument();
    status = 'hidden';
    websocketState.lastEvent = { event: 'session:metadata-changed', data: { sessionId: 'session-1' } };
    rerender(view());
    expect(await screen.findByText('Returned to destination')).toBeInTheDocument();
    expect(screen.queryByText('Select all matching options')).not.toBeInTheDocument();
  });

  it.each(['visible', 'done'])('does not auto-join an inactive %s session opened directly', async (status) => {
    apiClient.get.mockResolvedValue({ data: { session: { _id: 'session-1', status }, isJoined: false, currentQuestion: null } });
    render(
      <MemoryRouter initialEntries={['/student/course/course-1/live/session-1']}>
        <Routes><Route path="/student/course/:courseId/live/:sessionId" element={<LiveSession />} /></Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText(status === 'visible'
      ? 'This session has not started yet. Please wait for your instructor.' : 'Session has ended.')).toBeInTheDocument();
    expect(apiClient.post).not.toHaveBeenCalled();
  });

});
