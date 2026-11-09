import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SessionEditor from './SessionEditor';

const quizEvents = vi.hoisted(() => ({ listeners: new Set() }));
vi.mock('../../contexts/LiveSessionWebSocketContext', () => ({
  LiveSessionWebSocketProvider: ({ children }) => children,
  useLiveSessionWebSocket: () => ({
    subscribe: quizEvents.subscribe,
    registerRefreshHandler: quizEvents.register,
  }),
}));
quizEvents.subscribe = (handler) => { quizEvents.listeners.add(handler); return () => quizEvents.listeners.delete(handler); };
quizEvents.register = () => () => {};

const {
  navigateMock,
  requestCloseMock,
  apiClientMock,
  buildPrintableSessionHtmlMock,
  downloadPdfMock,
  downloadJsonMock,
  lastQuestionEditorProps,
  questionLibraryPanelPropsMock,
  submitSelectedQuestionsMock,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  requestCloseMock: vi.fn(),
  apiClientMock: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
  buildPrintableSessionHtmlMock: vi.fn(() => '<html><body>PDF</body></html>'),
  downloadPdfMock: vi.fn().mockResolvedValue(undefined),
  downloadJsonMock: vi.fn(),
  lastQuestionEditorProps: { current: null },
  questionLibraryPanelPropsMock: vi.fn(),
  submitSelectedQuestionsMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key,
  }),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ courseId: 'course-1', sessionId: 'session-1' }),
    useNavigate: () => navigateMock,
    useLocation: () => ({ state: {} }),
    useSearchParams: () => [new URLSearchParams('returnTab=1')],
  };
});

vi.mock('../../api/client', () => ({
  default: apiClientMock,
}));

vi.mock('../../components/questions/QuestionEditor', () => ({
  default: function MockQuestionEditor({ ref, ...props }) {
    lastQuestionEditorProps.current = props;
    React.useImperativeHandle(ref, () => ({
      requestClose: requestCloseMock,
    }));
    return <div>Mock Question Editor</div>;
  },
}));

vi.mock('../../components/questions/QuestionDisplay', () => ({
  default: ({ question }) => <div>{question?.content || ''}</div>,
}));

vi.mock('../../components/questions/QuestionLibraryPanel', () => ({
  default: function MockQuestionLibraryPanel({ ref, ...props }) {
    React.useImperativeHandle(ref, () => ({
      submitSelectedQuestions: submitSelectedQuestionsMock,
    }));

    React.useEffect(() => {
      props.selectionAction?.onSelectionChange?.(['library-q1']);
    }, [props.selectionAction]);

    questionLibraryPanelPropsMock(props);
    return <div>Mock Question Library Panel</div>;
  },
}));

vi.mock('../../components/common/AutoSaveStatus', () => ({
  default: () => null,
}));

vi.mock('../../components/common/BackLinkButton', () => ({
  default: ({ label, onClick }) => <button type="button" onClick={onClick}>{label}</button>,
}));

vi.mock('../../components/common/DateTimePreferenceField', () => ({
  default: ({ label, value = '', onChange }) => (
    <input
      aria-label={label}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

vi.mock('../../components/common/SessionStatusChip', () => ({
  default: ({ status }) => <div>{status}</div>,
}));

vi.mock('../../utils/courseTitle', () => ({
  buildCourseTitle: () => 'CS 101',
}));

vi.mock('../../utils/sessionExport', () => ({
  buildSessionExportFilename: (sessionName, suffix, extension) => `${sessionName}-${suffix}.${extension}`,
  buildPrintableSessionHtml: buildPrintableSessionHtmlMock,
  downloadPdf: downloadPdfMock,
  downloadJson: downloadJsonMock,
}));

describe('SessionEditor inline close behavior', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    requestCloseMock.mockReset();
    apiClientMock.get.mockReset();
    apiClientMock.patch.mockReset();
    apiClientMock.post.mockReset();
    apiClientMock.delete.mockReset();
    buildPrintableSessionHtmlMock.mockClear();
    downloadPdfMock.mockClear();
    downloadJsonMock.mockReset();
    questionLibraryPanelPropsMock.mockReset();
    submitSelectedQuestionsMock.mockReset();

    apiClientMock.get.mockImplementation((url) => {
      if (url === '/sessions/session-1') {
        return Promise.resolve({
          data: {
            session: {
              _id: 'session-1',
              name: 'Draft Session',
              description: '',
              quiz: false,
              practiceQuiz: false,
              msScoringMethod: 'right-minus-wrong',
              reviewable: false,
              status: 'hidden',
              tags: [{ value: 'kinematics', label: 'kinematics' }],
              questions: ['q1'],
              quizExtensions: [],
            },
          },
        });
      }

      if (url === '/questions/q1') {
        return Promise.resolve({
          data: {
            question: {
              _id: 'q1',
              type: 2,
              content: 'Original content',
              plainText: 'Original content',
              options: [],
              sessionOptions: { points: 1 },
            },
          },
        });
      }

      if (url === '/sessions/session-1/response-locks') {
        return Promise.resolve({ data: { responseBackedQuestionIds: [] } });
      }

      if (url === '/settings/public') {
        return Promise.resolve({ data: { timeFormat: '24h' } });
      }

      if (url === '/courses/course-1') {
        return Promise.resolve({
          data: {
            course: {
              _id: 'course-1',
              name: 'Test Course',
              deptCode: 'CS',
              courseNumber: '101',
              section: '001',
              tags: [
                { value: 'kinematics', label: 'kinematics' },
                { value: 'vectors', label: 'vectors' },
              ],
              quizTimeFormat: 'inherit',
              students: [],
            },
          },
        });
      }

      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });
  });

  it.each([false, true])('locks answered question structure independently of review results (anonymous=%s)', async (anonymous) => {
    const get = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/response-locks') {
        return { data: { responseBackedQuestionIds: ['q1'] } };
      }
      const result = await get(url);
      if (url === '/sessions/session-1') Object.assign(result.data.session, { quiz: true, anonymous });
      return result;
    });
    render(<SessionEditor />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'common.edit' }))[0]);
    expect(lastQuestionEditorProps.current.disableTypeSelection).toBe(true);
    expect(lastQuestionEditorProps.current.disableOptionCountChanges).toBe(true);
    expect(lastQuestionEditorProps.current.onAutoSave).toEqual(expect.any(Function));
    expect(screen.getByRole('button', { name: 'common.delete' })).toBeDisabled();
    expect(apiClientMock.get).not.toHaveBeenCalledWith('/sessions/session-1/results');
  });

  it('keeps unanswered questions editable', async () => {
    render(<SessionEditor />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'common.edit' }))[0]);
    expect(lastQuestionEditorProps.current.disableTypeSelection).toBe(false);
    expect(lastQuestionEditorProps.current.disableOptionCountChanges).toBe(false);
    expect(screen.getByRole('button', { name: 'common.delete' })).toBeEnabled();
  });

  it.each([
    { quiz: true, status: 'running' },
    { quiz: false, status: 'running' },
    { quiz: true, status: 'done', quizHasRemainingExtensions: true },
  ])('refreshes locks without resetting edits and retains them on request failure: %j', async (sessionFields) => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const get = apiClientMock.get.getMockImplementation();
    let answered = false;
    let failRefresh = false;
    apiClientMock.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/response-locks') {
        if (failRefresh) throw new Error('Temporary failure');
        return { data: { responseBackedQuestionIds: answered ? ['q1'] : [] } };
      }
      const result = await get(url);
      if (url === '/sessions/session-1') Object.assign(result.data.session, sessionFields);
      return result;
    });
    try {
      render(<SessionEditor />);
      await screen.findByDisplayValue('Draft Session');
      if (sessionFields.status === 'done') {
        fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.unlockEditing' }));
      }
      fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
      expect(lastQuestionEditorProps.current.disableTypeSelection).toBe(false);
      const initial = lastQuestionEditorProps.current.initial;
      const refresh = intervalSpy.mock.calls.find(([, delay]) => delay === 3000)?.[0];
      expect(refresh).toEqual(expect.any(Function));
      answered = true;
      await act(async () => { await refresh(); });
      expect(lastQuestionEditorProps.current.disableTypeSelection).toBe(true);
      expect(lastQuestionEditorProps.current.initial).toBe(initial);
      failRefresh = true;
      await act(async () => { await refresh(); });
      expect(lastQuestionEditorProps.current.disableTypeSelection).toBe(true);
      expect(lastQuestionEditorProps.current.disableOptionCountChanges).toBe(true);
    } finally {
      intervalSpy.mockRestore();
    }
  });

  it.each([
    { quiz: true, practiceQuiz: false, visible: true },
    { quiz: true, practiceQuiz: true, visible: false },
    { quiz: false, practiceQuiz: false, visible: false },
  ])('offers optional zero-point questions only for normal quizzes: %j', async ({ quiz, practiceQuiz, visible }) => {
    const get = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation(async (url) => {
      const result = await get(url);
      if (url === '/sessions/session-1') Object.assign(result.data.session, { quiz, practiceQuiz });
      return result;
    });
    apiClientMock.patch.mockResolvedValue({ data: { session: { status: 'hidden', quiz, practiceQuiz, allowSkippingZeroPointQuestions: true } } });
    render(<SessionEditor />);
    await screen.findByDisplayValue('Draft Session');
    const toggle = screen.queryByRole('switch', { name: 'professor.sessionEditor.allowSkippingZeroPointQuestions' });
    if (visible) {
      expect(toggle).not.toBeChecked();
      fireEvent.click(toggle);
      await waitFor(() => expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1', { allowSkippingZeroPointQuestions: true }));
      await waitFor(() => expect(toggle).toBeChecked());
    } else {
      expect(toggle).not.toBeInTheDocument();
    }
  });

  it('expands and collapses all previews while preserving individual toggles', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1') {
        const result = await originalGet(url);
        result.data.session.questions = ['q1', 'q2'];
        return result;
      }
      if (url === '/questions/q2') {
        const result = await originalGet('/questions/q1');
        result.data.question._id = 'q2';
        return result;
      }
      return originalGet(url);
    });
    render(<SessionEditor />);

    const expandAll = await screen.findByRole('button', { name: 'professor.sessionEditor.expandAllPreviews' });
    expect(screen.getAllByRole('button', { name: 'professor.sessionEditor.expandQuestion', expanded: false })).toHaveLength(2);
    fireEvent.click(expandAll);
    expect(screen.getAllByRole('button', { name: 'professor.sessionEditor.collapseQuestion', expanded: true })).toHaveLength(2);

    fireEvent.keyDown(screen.getAllByRole('button', { name: 'professor.sessionEditor.collapseQuestion' })[0], { key: 'Enter' });
    expect(screen.getAllByRole('button', { name: 'professor.sessionEditor.expandQuestion', expanded: false })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.expandAllPreviews' }));
    expect(screen.getAllByRole('button', { name: 'professor.sessionEditor.collapseQuestion', expanded: true })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.collapseAllPreviews', expanded: true }));
    expect(screen.getAllByRole('button', { name: 'professor.sessionEditor.expandQuestion', expanded: false })).toHaveLength(2);
    expect(apiClientMock.patch).not.toHaveBeenCalled();
  });

  it('disables the bulk preview control when the session has no questions', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation(async (url) => {
      const result = await originalGet(url);
      if (url === '/sessions/session-1') result.data.session.questions = [];
      return result;
    });
    render(<SessionEditor />);
    expect(await screen.findByRole('button', { name: 'professor.sessionEditor.expandAllPreviews' })).toBeDisabled();
  });

  it('publishes grades from the editor without enabling review or losing session settings', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation(async (url) => {
      const result = await originalGet(url);
      if (url === '/sessions/session-1') result.data.session.status = 'done';
      return result;
    });
    apiClientMock.patch.mockResolvedValueOnce({ data: { session: { _id: 'session-1', gradesVisible: true, reviewable: false } } });
    render(<SessionEditor />);
    const control = await screen.findByRole('switch', { name: 'grades.visibility.label' });
    fireEvent.click(control);
    await waitFor(() => expect(control).toBeChecked());
    expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1/grades/visibility', { visibleToStudents: true });
    expect(screen.getByRole('switch', { name: 'professor.sessionEditor.reviewableHelp' })).not.toBeChecked();
    expect(screen.getByText('Original content')).toBeInTheDocument();
  });

  it('routes outer close buttons through the question editor close handler', async () => {
    render(<SessionEditor />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'common.edit' }))[0]);
    expect(screen.getByText('Mock Question Editor')).toBeInTheDocument();
    expect(lastQuestionEditorProps.current?.showVisibilityControls).toBe(false);
    expect(lastQuestionEditorProps.current?.showCourseTagSettingsHint).toBe(true);

    fireEvent.click(screen.getAllByRole('button', { name: 'professor.sessionEditor.closeEditor' })[0]);

    await waitFor(() => {
      expect(requestCloseMock).toHaveBeenCalledTimes(1);
    });
  });

  it('uses the date-based quiz status label and warns when changing a draft quiz to date-controlled status', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    const quizStart = new Date(Date.now() - 60_000).toISOString();
    const quizEnd = new Date(Date.now() + 60_000).toISOString();
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/sessions/session-1') {
        return Promise.resolve({
          data: {
            session: {
              _id: 'session-1',
              name: 'Scheduled Quiz',
              description: '',
              quiz: true,
              practiceQuiz: false,
              quizStart,
              quizEnd,
              msScoringMethod: 'right-minus-wrong',
              reviewable: false,
              status: 'hidden',
              tags: [],
              questions: ['q1'],
              quizExtensions: [],
            },
          },
        });
      }
      return originalGet(url);
    });
    apiClientMock.patch.mockResolvedValue({
      data: {
        session: {
          _id: 'session-1',
          name: 'Scheduled Quiz',
          description: '',
          quiz: true,
          practiceQuiz: false,
          quizStart,
          quizEnd,
          status: 'running',
          tags: [],
          questions: ['q1'],
          quizExtensions: [],
        },
      },
    });

    render(<SessionEditor />);

    const [statusSelect] = await screen.findAllByRole('combobox');
    fireEvent.mouseDown(statusSelect);
    fireEvent.click(await screen.findByRole('option', { name: 'professor.sessionEditor.liveBasedOnDate' }));

    expect(await screen.findByText('professor.sessionEditor.scheduledQuizLiveWarning')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.makeQuizLive' }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1', { status: 'visible' });
      expect(screen.getByText('running')).toBeInTheDocument();
    });
  });

  it.each([
    ['running', -120_000, -60_000, []],
    ['running', 60_000, 120_000, []],
    ['done', -120_000, -60_000, [{ quizStart: new Date(Date.now() - 60_000), quizEnd: new Date(Date.now() + 60_000) }]],
    ['visible', -120_000, -60_000, [{ quizStart: new Date(Date.now() + 60_000), quizEnd: new Date(Date.now() + 120_000) }]],
  ])('uses server status %s without reinterpreting quiz dates (%s, %s)', async (status, startOffset, endOffset, quizExtensions) => {
    const originalGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation(async (url) => {
      const response = await originalGet(url);
      if (url === '/sessions/session-1') {
        Object.assign(response.data.session, {
          quiz: true, status, quizExtensions,
          quizStart: new Date(Date.now() + startOffset).toISOString(),
          quizEnd: new Date(Date.now() + endOffset).toISOString(),
        });
      }
      return response;
    });
    render(<SessionEditor />);
    expect(await screen.findByText(status)).toBeInTheDocument();
    const labels = { running: 'sessionStatus.live', done: 'sessionStatus.ended', visible: 'professor.sessionEditor.liveBasedOnDate' };
    expect(screen.getByRole('combobox', { name: 'professor.sessionEditor.status' })).toHaveTextContent(labels[status]);
    if (status === 'running') {
      expect(screen.getByRole('button', { name: 'professor.sessionEditor.reviewLiveResults' })).toBeInTheDocument();
    }
  });

  it('replaces the anonymous waiting notice with live review when a batch arrives', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation(async (url) => {
      const response = await originalGet(url);
      if (url === '/sessions/session-1') Object.assign(response.data.session, {
        quiz: true, anonymous: true, status: 'running', submittedCount: 3,
      });
      return response;
    });
    render(<SessionEditor />);
    expect(await screen.findByText('professor.sessionReview.anonymousLiveWaiting')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'professor.sessionEditor.reviewLiveResults' })).not.toBeInTheDocument();
    act(() => quizEvents.listeners.forEach((handler) => handler({ event: 'session:quiz-submitted', data: { anonymous: true, submittedCount: 4 } })));
    fireEvent.click(await screen.findByRole('button', { name: 'professor.sessionEditor.reviewLiveResults' }));
    expect(navigateMock).toHaveBeenCalledWith('/prof/course/course-1/session/session-1/review?returnTab=1');
    expect(screen.queryByText('professor.sessionReview.anonymousLiveWaiting')).not.toBeInTheDocument();
  });

  it('adopts the returned status when removing the last active scheduled extension', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    let session;
    apiClientMock.get.mockImplementation(async (url) => {
      const response = await originalGet(url);
      if (url === '/sessions/session-1') {
        session = {
          ...response.data.session, quiz: true, status: 'running',
          quizStart: new Date(Date.now() - 120_000).toISOString(),
          quizEnd: new Date(Date.now() - 60_000).toISOString(),
          quizHasActiveExtensions: true, quizHasRemainingExtensions: true,
          quizExtensions: [{
            userId: 'student-1',
            quizStart: new Date(Date.now() - 60_000).toISOString(),
            quizEnd: new Date(Date.now() + 60_000).toISOString(),
          }],
        };
        response.data.session = session;
      }
      return response;
    });
    apiClientMock.patch.mockImplementation(async () => ({ data: { session: {
      ...session, status: 'done', quizExtensions: [], quizHasActiveExtensions: false, quizHasRemainingExtensions: false,
    } } }));
    render(<SessionEditor />);
    fireEvent.click(await screen.findByRole('button', { name: 'professor.sessionEditor.manageExtensions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'professor.sessionEditor.removeExtension' }));
    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.saveExtensions' }));
    expect(await screen.findByText('done')).toBeInTheDocument();
    expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1/extensions', { extensions: [] });
    expect(await screen.findByRole('combobox', { name: 'professor.sessionEditor.status' })).toHaveTextContent('sessionStatus.ended');
  });

  it('saves the anonymous setting and locks it once students have joined', async () => {
    apiClientMock.patch.mockImplementation(async (_url, updates) => ({
      data: { session: { _id: 'session-1', status: 'hidden', questions: ['q1'], anonymous: !!updates.anonymous } },
    }));
    const { unmount } = render(<SessionEditor />);

    const anonymousSwitch = await screen.findByLabelText('professor.sessionEditor.anonymous');
    expect(anonymousSwitch).not.toBeChecked();
    expect(anonymousSwitch).toBeEnabled();
    fireEvent.click(anonymousSwitch);
    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1', { anonymous: true });
    });
    expect(await screen.findByText('professor.sessionEditor.anonymousEnabledNote')).toBeInTheDocument();
    expect(screen.getByLabelText('professor.sessionEditor.practiceQuiz')).toBeDisabled();
    unmount();

    const originalGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation(async (url) => {
      const response = await originalGet(url);
      if (url === '/sessions/session-1') {
        response.data.session = { ...response.data.session, anonymous: true, joinedCount: 1 };
      }
      return response;
    });
    render(<SessionEditor />);
    const lockedSwitch = await screen.findByLabelText('professor.sessionEditor.anonymous');
    expect(lockedSwitch).toBeChecked();
    expect(lockedSwitch).toBeDisabled();
    expect(screen.getByText(/professor\.sessionEditor\.anonymousLockedNote/)).toBeInTheDocument();
  });

  it('keeps individual extensions and anonymous mode mutually exclusive in the editor', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation(async (url) => {
      const response = await originalGet(url);
      if (url === '/sessions/session-1') {
        response.data.session = {
          ...response.data.session,
          quiz: true,
          quizExtensions: [{ userId: 'student-1', quizStart: '2026-09-25T10:00:00Z', quizEnd: '2026-09-25T11:00:00Z' }],
        };
      }
      return response;
    });
    const { unmount } = render(<SessionEditor />);
    expect(await screen.findByLabelText('professor.sessionEditor.anonymous')).toBeDisabled();
    expect(screen.getByText('professor.sessionEditor.anonymousNoExtensions')).toBeInTheDocument();
    unmount();

    apiClientMock.get.mockImplementation(async (url) => {
      const response = await originalGet(url);
      if (url === '/sessions/session-1') {
        response.data.session = { ...response.data.session, quiz: true, anonymous: true, quizExtensions: [] };
      }
      return response;
    });
    render(<SessionEditor />);
    expect(await screen.findByLabelText('professor.sessionEditor.anonymous')).toBeChecked();
    expect(screen.queryByRole('button', { name: 'professor.sessionEditor.manageExtensions' })).not.toBeInTheDocument();
    expect(screen.getByText('professor.sessionEditor.anonymousNoExtensions')).toBeInTheDocument();
  });

  it('hides activity sharing until course opt-in and prevents extensions on shared quizzes', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    const renderWith = async ({ allowSharedActivities, quizExtensions = [], activityEverShared = false }) => {
      apiClientMock.get.mockImplementation(async (url) => {
        const response = await originalGet(url);
        if (url === '/courses/course-1') response.data.course.allowSharedActivities = allowSharedActivities;
        if (url === '/sessions/session-1') Object.assign(response.data.session, {
          quiz: true, quizExtensions, activityEverShared,
        });
        return response;
      });
      return render(<SessionEditor />);
    };
    let view = await renderWith({ allowSharedActivities: false });
    await screen.findByLabelText('professor.sessionEditor.anonymous');
    expect(screen.queryByLabelText('professor.sessionEditor.allowActivityCodeAccess')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('professor.sessionEditor.activityCodeTitle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('activity-share-code')).not.toBeInTheDocument();
    expect(screen.queryByText('professor.sessionEditor.courseSharingDisabled')).not.toBeInTheDocument();
    view.unmount();

    view = await renderWith({ allowSharedActivities: true, quizExtensions: [{ userId: 'student-1' }] });
    expect(await screen.findByLabelText('professor.sessionEditor.allowActivityCodeAccess')).toBeDisabled();
    expect(screen.getByText('professor.sessionEditor.removeExtensionsBeforeSharing')).toBeInTheDocument();
    view.unmount();

    await renderWith({ allowSharedActivities: true, activityEverShared: true });
    expect(await screen.findByLabelText('professor.sessionEditor.allowActivityCodeAccess')).toBeEnabled();
    fireEvent.mouseOver(screen.getByLabelText('professor.sessionEditor.activityCodeTitle'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('professor.sessionEditor.activityCodeHelp');
    expect(screen.queryByRole('button', { name: 'professor.sessionEditor.manageExtensions' })).not.toBeInTheDocument();
    expect(screen.getByText('professor.sessionEditor.sharedNoExtensions')).toBeInTheDocument();
  });

  it('shows the active code after reload and turns sharing off through the switch', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    let enabled = true;
    apiClientMock.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/activity-share') {
        return { data: { enabled, code: enabled ? 'S-ABCDEFG' : null, expiresAt: enabled ? '2026-10-20T12:00:00.000Z' : null } };
      }
      const response = await originalGet(url);
      if (url === '/courses/course-1') response.data.course.allowSharedActivities = true;
      return response;
    });
    apiClientMock.delete.mockImplementation(async () => { enabled = false; return { data: { enabled: false } }; });
    render(<SessionEditor />);
    const shareSwitch = await screen.findByLabelText('professor.sessionEditor.allowActivityCodeAccess');
    await waitFor(() => expect(shareSwitch).toBeChecked());
    expect(screen.getByTestId('activity-share-code')).toHaveTextContent('S-ABCDEFG');
    expect(screen.getByRole('button', { name: 'professor.sessionEditor.rotateActivityCode' })).toBeInTheDocument();
    fireEvent.click(shareSwitch);
    await waitFor(() => expect(apiClientMock.delete).toHaveBeenCalledWith('/sessions/session-1/activity-share'));
    await waitFor(() => expect(shareSwitch).not.toBeChecked());
    expect(screen.queryByTestId('activity-share-code')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'professor.sessionEditor.rotateActivityCode' })).not.toBeInTheDocument();
  });

  it('uses explicit regeneration only for the Regenerate button', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    let enabled = true;
    let code = 'S-ABCDEFG';
    apiClientMock.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/activity-share') {
        return { data: { enabled, code: enabled ? code : null, expiresAt: enabled ? '2026-10-20T12:00:00.000Z' : null } };
      }
      const response = await originalGet(url);
      if (url === '/courses/course-1') response.data.course.allowSharedActivities = true;
      return response;
    });
    apiClientMock.post.mockImplementation(async (url, payload) => {
      expect(url).toBe('/sessions/session-1/activity-share');
      if (payload.regenerate) code = 'S-HJKLMNP';
      enabled = true;
      return { data: { code, expiresAt: '2026-10-20T12:00:00.000Z' } };
    });
    apiClientMock.delete.mockImplementation(async () => { enabled = false; return { data: { enabled: false } }; });
    render(<SessionEditor />);
    const shareSwitch = await screen.findByLabelText('professor.sessionEditor.allowActivityCodeAccess');
    await waitFor(() => expect(shareSwitch).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.rotateActivityCode' }));
    await waitFor(() => expect(apiClientMock.post).toHaveBeenCalledWith('/sessions/session-1/activity-share', { regenerate: true }));
    await waitFor(() => expect(screen.getByTestId('activity-share-code')).toHaveTextContent(code));
    fireEvent.click(shareSwitch);
    await waitFor(() => expect(shareSwitch).not.toBeChecked());
    fireEvent.click(shareSwitch);
    await waitFor(() => expect(apiClientMock.post).toHaveBeenLastCalledWith('/sessions/session-1/activity-share', {}));
    await waitFor(() => expect(screen.getByTestId('activity-share-code')).toHaveTextContent(code));
  });

  it('refreshes server status at the exact schedule boundaries while the editor stays open', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-09-16T12:00:00.000Z').getTime();
    vi.setSystemTime(now);
    const originalGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation(async (url) => {
      const response = await originalGet(url);
      if (url === '/sessions/session-1') {
        Object.assign(response.data.session, {
          quiz: true,
          status: Date.now() < now + 1000 ? 'visible' : Date.now() <= now + 2000 ? 'running' : 'done',
          quizStart: new Date(now + 1000).toISOString(),
          quizEnd: new Date(now + 2000).toISOString(),
        });
      }
      return response;
    });
    let view;
    try {
      await act(async () => { view = render(<SessionEditor />); });
      expect(screen.getByText('visible')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(1050); });
      expect(screen.getByText('running')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(screen.getByText('done')).toBeInTheDocument();
    } finally {
      view?.unmount();
      vi.useRealTimers();
    }
  });

  it.each([false, true])('makes a quiz live in the editor and offers results (practice: %s)', async (practiceQuiz) => {
    const originalGet = apiClientMock.get.getMockImplementation();
    let session;
    apiClientMock.get.mockImplementation(async (url) => {
      const response = await originalGet(url);
      if (url === '/sessions/session-1') {
        session = { ...response.data.session, quiz: true, practiceQuiz };
        response.data.session = session;
      }
      return response;
    });
    apiClientMock.patch.mockImplementation(async (_url, updates) => ({ data: { session: { ...session, ...updates } } }));
    render(<SessionEditor />);
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'professor.sessionEditor.status' }));
    fireEvent.click(await screen.findByRole('option', { name: 'sessionStatus.live' }));
    const results = await screen.findByRole('button', { name: 'professor.sessionEditor.reviewLiveResults' });
    expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1', { status: 'running' });
    expect(apiClientMock.post).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    fireEvent.click(results);
    expect(navigateMock).toHaveBeenCalledWith('/prof/course/course-1/session/session-1/review?returnTab=1');
  });

  it('still launches interactive controls after confirming Live for an interactive session', async () => {
    apiClientMock.post.mockResolvedValue({ data: {} });
    render(<SessionEditor />);
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'professor.sessionEditor.status' }));
    fireEvent.click(await screen.findByRole('option', { name: 'sessionStatus.live' }));
    fireEvent.click(await screen.findByRole('button', { name: 'professor.sessionEditor.goLive' }));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/prof/course/course-1/session/session-1/live'));
    expect(apiClientMock.post).toHaveBeenCalledWith('/sessions/session-1/start');
    expect(apiClientMock.patch).not.toHaveBeenCalled();
  });

  it('creates a new session-authored question once and inserts it into the session order directly', async () => {
    apiClientMock.post.mockImplementation((url, payload) => {
      if (url === '/questions') {
        return Promise.resolve({
          data: {
            question: {
              _id: 'source-q2',
              type: 6,
              content: '<p>Slide draft</p>',
              plainText: 'Slide draft',
              options: [],
              sessionOptions: { points: 0 },
            },
          },
        });
      }

      return Promise.reject(new Error(`Unexpected POST ${url}`));
    });

    apiClientMock.patch.mockImplementation((url, payload) => {
      if (url === '/sessions/session-1/questions/order') {
        expect(payload).toEqual({ questions: ['q1', 'source-q2'] });
        return Promise.resolve({ data: { success: true } });
      }
      return Promise.reject(new Error(`Unexpected PATCH ${url}`));
    });

    render(<SessionEditor />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'common.edit' }))[0]);

    let saved;
    await act(async () => {
      saved = await lastQuestionEditorProps.current.onAutoSave({
        type: 6,
        content: '<p>Slide draft</p>',
        plainText: 'Slide draft',
        sessionOptions: { points: 0 },
      }, null);
    });

    expect(saved._id).toBe('source-q2');
    expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1/questions/order', {
      questions: ['q1', 'source-q2'],
    });
    expect(apiClientMock.post).toHaveBeenCalledTimes(1);
  });

  it('exports session JSON from the export dialog', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/sessions/session-1/export') {
        return Promise.resolve({
          data: {
            version: 1,
            session: {
              name: 'Draft Session',
              questions: [],
            },
          },
        });
      }
      return originalGet(url);
    });

    render(<SessionEditor />);

    fireEvent.click(await screen.findByRole('button', { name: 'professor.sessionEditor.exportSession' }));
    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.exportFormatJson' }));
    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.exportJson' }));

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/sessions/session-1/export');
      expect(downloadJsonMock).toHaveBeenCalledWith(
        'Draft Session-export.json',
        expect.objectContaining({ version: 1 })
      );
    });
  });

  it('downloads a PDF export from the export dialog', async () => {
    render(<SessionEditor />);

    fireEvent.click(await screen.findByRole('button', { name: 'professor.sessionEditor.exportSession' }));
    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.pdfQuestions' }));

    await waitFor(() => {
      expect(buildPrintableSessionHtmlMock).toHaveBeenCalledWith(expect.objectContaining({
        variant: 'questions',
      }));
      expect(downloadPdfMock).toHaveBeenCalledWith(
        'Draft Session-questions.pdf',
        '<html><body>PDF</body></html>'
      );
    });
  });

  it('imports a session JSON file into the current course', async () => {
    apiClientMock.post.mockResolvedValue({
      data: {
        session: {
          _id: 'imported-session-1',
        },
      },
    });

    render(<SessionEditor />);
    await screen.findByRole('button', { name: 'professor.sessionEditor.importSession' });

    const input = screen.getByTestId('session-import-input');
    const fileContents = JSON.stringify({
      version: 1,
      session: {
        name: 'Imported Session',
        questions: [],
      },
    });
    const file = new File([fileContents], 'session.json', { type: 'application/json' });
    file.text = vi.fn().mockResolvedValue(fileContents);

    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(await screen.findByTestId('confirm-session-import'));

    await waitFor(() => {
      expect(file.text).toHaveBeenCalled();
      expect(apiClientMock.post).toHaveBeenCalledWith('/courses/course-1/sessions/import', {
        version: 1,
        session: {
          name: 'Imported Session',
          questions: [],
        },
        importTags: ['Imported'],
      });
      expect(navigateMock).toHaveBeenCalledWith(
        '/prof/course/course-1/session/imported-session-1?returnTab=1',
        { state: { returnTab: 1, returnTo: undefined } }
      );
    });
  });

  it('applies session tags to every question in the session', async () => {
    const originalGet = apiClientMock.get.getMockImplementation();
    apiClientMock.get.mockImplementation((url) => {
      if (url === '/questions/q1') {
        return Promise.resolve({
          data: {
            question: {
              _id: 'q1',
              type: 2,
              content: 'Original content',
              plainText: 'Original content',
              options: [],
              tags: [
                { value: 'Kinematics', label: 'Kinematics' },
                { value: 'legacy', label: 'legacy' },
              ],
              sessionOptions: { points: 1 },
            },
          },
        });
      }
      return originalGet(url);
    });
    apiClientMock.patch.mockResolvedValue({
      data: {
        question: {
          _id: 'q1',
          type: 2,
          content: 'Original content',
          plainText: 'Original content',
          options: [],
          tags: [{ value: 'kinematics', label: 'kinematics' }],
          sessionOptions: { points: 1 },
        },
      },
    });

    render(<SessionEditor />);

    fireEvent.click(await screen.findByRole('button', { name: 'professor.sessionEditor.applyTagsToAllQuestions' }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/questions/q1', {
        tags: [
          { value: 'Kinematics', label: 'Kinematics' },
          { value: 'legacy', label: 'legacy' },
        ],
      });
    });
  });

  it('sets every gradable question to zero points and warns when grades exist', async () => {
    apiClientMock.patch.mockImplementation((url, payload) => {
      if (url === '/sessions/session-1/questions/points') {
        expect(payload).toEqual({ points: 0 });
        return Promise.resolve({
          data: {
            points: 0,
            updatedCount: 1,
            updatedQuestionIds: ['q1'],
            gradingAffected: true,
          },
        });
      }
      return Promise.reject(new Error(`Unexpected PATCH ${url}`));
    });

    render(<SessionEditor />);

    fireEvent.change(await screen.findByRole('spinbutton', {
      name: 'professor.sessionEditor.pointsPerQuestion',
    }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', {
      name: 'professor.sessionEditor.applyPointsToAllQuestions',
    }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1/questions/points', { points: 0 });
      expect(screen.getByText('professor.sessionEditor.pointsChangedRegradeWarning')).toBeInTheDocument();
    });
  });

  it('inserts a fresh copy when the library selection is already in the session', async () => {
    apiClientMock.post.mockResolvedValue({ data: { question: { _id: 'q1-copy' } } });
    apiClientMock.patch.mockResolvedValue({ data: {} });
    render(<SessionEditor />);
    const buttons = await screen.findAllByRole('button', { name: 'professor.sessionEditor.addQuestionAtPositionAria' });
    fireEvent.click(buttons[0]);
    fireEvent.click(screen.getByRole('button', { name: 'student.course.copyFromQuestionLibrary' }));
    await screen.findByText('Mock Question Library Panel');
    await act(async () => {
      await questionLibraryPanelPropsMock.mock.lastCall[0].selectionAction.onSubmit(['q1']);
    });
    expect(apiClientMock.post).toHaveBeenCalledWith('/questions/q1/copy-to-session', { sessionId: 'session-1' });
    expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1/questions/order', { questions: ['q1-copy', 'q1'] });
  });

  it('offers an Add to session action beside Cancel at the bottom of the library modal', async () => {
    submitSelectedQuestionsMock.mockResolvedValue(undefined);

    render(<SessionEditor />);

    const addQuestionButtons = await screen.findAllByRole('button', {
      name: 'professor.sessionEditor.addQuestionAtPositionAria',
    });
    fireEvent.click(addQuestionButtons[0]);
    fireEvent.click(screen.getByRole('button', { name: 'student.course.copyFromQuestionLibrary' }));

    expect(await screen.findByText('Mock Question Library Panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeInTheDocument();

    const addToSessionButton = screen.getByRole('button', { name: 'questionLibrary.bulk.addToSession' });
    expect(addToSessionButton).toBeEnabled();
    fireEvent.click(addToSessionButton);

    await waitFor(() => {
      expect(submitSelectedQuestionsMock).toHaveBeenCalledTimes(1);
    });
    expect(questionLibraryPanelPropsMock).toHaveBeenCalledWith(expect.objectContaining({
      selectionAction: expect.objectContaining({
        hideImport: true,
        onSelectionChange: expect.any(Function),
      }),
    }));
  });
});
