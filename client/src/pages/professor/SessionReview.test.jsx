import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SessionReview, { buildSessionResultsCsv } from './SessionReview';
import apiClient from '../../api/client';
import i18n from '../../i18n';

const quizEvents = vi.hoisted(() => ({ listeners: new Set(), refresh: null }));
vi.mock('../../contexts/LiveSessionWebSocketContext', () => ({
  LiveSessionWebSocketProvider: ({ children }) => children,
  useLiveSessionWebSocket: () => ({
    subscribe: quizEvents.subscribe,
    registerRefreshHandler: quizEvents.register,
  }),
}));
quizEvents.subscribe = (handler) => { quizEvents.listeners.add(handler); return () => quizEvents.listeners.delete(handler); };
quizEvents.register = (handler) => { quizEvents.refresh = handler; return () => { quizEvents.refresh = null; }; };

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

function renderSessionReview() {
  return render(
    <MemoryRouter initialEntries={['/prof/course/course-1/session/session-1/review']}>
      <Routes>
        <Route path="/prof/course/:courseId/session/:sessionId/review" element={<SessionReview />} />
        <Route path="/prof/course/:courseId/session/:sessionId/live" element={<div>Live session destination</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function buildResultsPayload(sessionOverrides = {}) {
  return {
    session: {
      _id: 'session-1',
      name: 'Midterm review',
      status: 'done',
      reviewable: true,
      questions: ['q-1'],
      ...sessionOverrides,
    },
    questions: [
      {
        _id: 'q-1',
        type: 0,
        content: '<p>Pick one</p>',
        plainText: 'Pick one',
        sessionOptions: { points: 5 },
        options: [
          { answer: 'A', plainText: 'A', correct: false },
          { answer: 'B', plainText: 'B', correct: true },
        ],
      },
    ],
    studentResults: [
      {
        studentId: 'student-1',
        firstname: 'Ada',
        lastname: 'Lovelace',
        email: 'ada@example.edu',
        profileImage: 'https://example.edu/ada-full.png',
        profileThumbnail: 'https://example.edu/ada-thumb.png',
        inSession: true,
        participation: 100,
        joinedAt: '2026-03-15T12:05:00.000Z',
        questionResults: [
          {
            questionId: 'q-1',
            responses: [
              {
                attempt: 2,
                answer: '1',
                createdAt: '2026-03-15T12:00:00.000Z',
              },
            ],
          },
        ],
      },
      {
        studentId: 'student-2',
        firstname: 'Grace',
        lastname: 'Hopper',
        email: 'grace@example.edu',
        profileImage: 'https://example.edu/grace-full.png',
        profileThumbnail: 'https://example.edu/grace-thumb.png',
        inSession: false,
        participation: 50,
        joinedAt: '2026-03-15T11:55:00.000Z',
        questionResults: [
          {
            questionId: 'q-1',
            responses: [
              {
                attempt: 1,
                answer: '0',
                createdAt: '2026-03-15T11:56:00.000Z',
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('SessionReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    quizEvents.listeners.clear();
    quizEvents.refresh = null;
    i18n.changeLanguage('en');

    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/results') {
        return {
          data: buildResultsPayload(),
        };
      }

      if (url === '/courses/course-1') {
        return {
          data: {
            course: {
              _id: 'course-1',
              name: 'Discrete Math',
              deptCode: 'MATH',
              courseNumber: '200',
              section: '001',
              semester: 'Fall 2026',
            },
          },
        };
      }

      if (url === '/sessions/session-1/grades') {
        return {
          data: {
            grades: [
              {
                _id: 'grade-1',
                userId: 'student-1',
                value: 87.5,
                participation: 100,
                marks: [
                  {
                    questionId: 'q-1',
                    points: 4,
                    outOf: 5,
                    needsGrading: false,
                  },
                ],
              },
              {
                _id: 'grade-2',
                userId: 'student-2',
                value: 20,
                participation: 50,
                marks: [
                  {
                    questionId: 'q-1',
                    points: 1,
                    outOf: 5,
                    needsGrading: false,
                  },
                ],
              },
            ],
          },
        };
      }

      if (url === '/courses/course-1/groups') {
        return { data: { groupCategories: [] } };
      }

      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it('updates independent grade visibility without enabling review and retains state on failure', async () => {
    const originalGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation(async (url) => url === '/sessions/session-1/results'
      ? { data: buildResultsPayload({ reviewable: false, gradesVisible: false }) }
      : originalGet(url));
    apiClient.patch.mockResolvedValueOnce({ data: { session: { _id: 'session-1', gradesVisible: true, reviewable: false } } });
    renderSessionReview();
    const control = await screen.findByRole('switch', { name: 'Grades visible', exact: true });
    fireEvent.click(control);
    await waitFor(() => expect(control).toBeChecked());
    expect(apiClient.patch).toHaveBeenCalledWith('/sessions/session-1/grades/visibility', { visibleToStudents: true });
    expect(screen.getByRole('switch', { name: 'Toggle student review access' })).not.toBeChecked();
    apiClient.patch.mockRejectedValueOnce(new Error('Network failure'));
    fireEvent.click(control);
    expect(await screen.findByText('Failed to update grade visibility.')).toBeInTheDocument();
    expect(control).toBeChecked();
  });

  it('offers a direct return to a running interactive session', async () => {
    const defaultGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/results') {
        return { data: buildResultsPayload({ status: 'running', quiz: false, practiceQuiz: false }) };
      }
      return defaultGet(url);
    });

    renderSessionReview();

    const joinButton = await screen.findByRole('button', { name: 'Join live session' });
    expect(screen.getByRole('button', { name: 'Edit session' })).toBeInTheDocument();
    fireEvent.click(joinButton);
    expect(await screen.findByText('Live session destination')).toBeInTheDocument();
  });

  it('refreshes quiz results on coalesced submissions and ending, without refetching on autosaves', async () => {
    const originalGet = apiClient.get.getMockImplementation();
    let payload = { ...buildResultsPayload({ quiz: true, status: 'running' }), studentResults: [] };
    apiClient.get.mockImplementation((url, ...args) => url === '/sessions/session-1/results'
      ? Promise.resolve({ data: payload }) : originalGet(url, ...args));
    renderSessionReview();
    await screen.findByText(/only submitted quizzes are shown/i);
    fireEvent.click(screen.getByRole('tab', { name: /response data/i }));
    const resultCalls = () => apiClient.get.mock.calls.filter(([url]) => url.endsWith('/results')).length;
    const courseCalls = () => apiClient.get.mock.calls.filter(([url]) => url === '/courses/course-1').length;
    const initialCourses = courseCalls();
    expect(resultCalls()).toBe(1);
    act(() => quizEvents.listeners.forEach((handler) => handler({ event: 'session:response-added' })));
    payload = { ...buildResultsPayload({ quiz: true, status: 'running' }), studentResults: buildResultsPayload().studentResults.slice(0, 1) };
    act(() => {
      for (let index = 0; index < 5; index += 1) {
        quizEvents.listeners.forEach((handler) => handler({ event: 'session:quiz-submitted' }));
      }
    });
    await screen.findByText('Ada Lovelace', {}, { timeout: 4000 });
    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
    expect(resultCalls()).toBe(2);
    expect(courseCalls()).toBe(initialCourses);
    payload = buildResultsPayload({ quiz: true, status: 'done' });
    act(() => quizEvents.listeners.forEach((handler) => handler({ event: 'session:status-changed' })));
    await screen.findByText('Grace Hopper', {}, { timeout: 4000 });
    expect(resultCalls()).toBe(3);
    expect(screen.queryByText(/only submitted quizzes are shown/i)).not.toBeInTheDocument();
  }, 10000);

  it('renders question math in both the results and grading tabs', async () => {
    const defaultGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/results') {
        const payload = buildResultsPayload();
        payload.questions[0] = {
          ...payload.questions[0],
          content: '<p>Evaluate \\(x^2 + y^2\\)</p>',
          plainText: 'Evaluate \\(x^2 + y^2\\)',
          options: [
            { answer: 'A', plainText: '\\(x^2\\)', correct: false },
            { answer: 'B', plainText: '\\(x^2 + y^2\\)', correct: true },
          ],
        };
        return { data: payload };
      }
      return defaultGet(url);
    });

    const { container } = renderSessionReview();

    expect(await screen.findByText('Midterm review')).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(3);
    });
    expect(container.textContent).not.toContain('\\(');

    fireEvent.click(screen.getByRole('tab', { name: /grading/i }));

    await screen.findByText('Question navigator');
    await waitFor(() => {
      expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(3);
    });
    expect(screen.queryByText('B: \\(x^2 + y^2\\)')).not.toBeInTheDocument();
  });

  it('shows the consolidated response data table, sorts rows, and exports the visible CSV', async () => {
    const originalBlob = globalThis.Blob;
    let downloadedBlob = null;
    class BlobSpy {
      constructor(parts, options = {}) {
        this.parts = parts;
        this.type = options.type;
      }
    }
    vi.stubGlobal('Blob', BlobSpy);
    const createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      downloadedBlob = blob;
      return 'blob:session-review-test';
    });
    const revokeObjectUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderSessionReview();

    await screen.findByText('Midterm review');
    expect(screen.queryByRole('tab', { name: /students/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /response data/i }));

    expect(await screen.findByText('B (4)')).toBeInTheDocument();
    expect(screen.getByText('A (1)')).toBeInTheDocument();
    expect(screen.getByText('Grade')).toBeInTheDocument();
    expect(screen.getByText('87.5%')).toBeInTheDocument();
    expect(screen.getAllByText('Joined Session').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /export results to csv/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Joined Session' }));

    const resultsTable = screen.getByRole('table', { name: /student results/i });
    await waitFor(() => {
      const rows = within(resultsTable).getAllByRole('row');
      expect(within(rows[1]).getByText('Grace Hopper')).toBeInTheDocument();
      expect(within(rows[2]).getByText('Ada Lovelace')).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText(/search students/i);
    fireEvent.change(searchInput, { target: { value: 'ada@example.edu' } });

    await waitFor(() => {
      const filteredRows = within(resultsTable).getAllByRole('row');
      expect(within(filteredRows[1]).getByText('Ada Lovelace')).toBeInTheDocument();
      expect(within(resultsTable).queryByText('Grace Hopper')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /export results to csv/i }));

    const exportDialog = screen.getByRole('dialog', { name: /export results to csv/i });
    expect(within(exportDialog).getByRole('checkbox', { name: /include response timestamps/i })).not.toBeChecked();
    expect(clickSpy).not.toHaveBeenCalled();
    fireEvent.click(within(exportDialog).getByRole('button', { name: /cancel/i }));
    expect(clickSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /export results to csv/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^export csv$/i }));

    expect(clickSpy).toHaveBeenCalled();
    expect(downloadedBlob).toBeTruthy();
    const csvText = downloadedBlob.parts.join('');
    expect(csvText).toContain('Last Name,First Name,Email,Grade,In Session,Participation,Percent Correct,Joined Session');
    expect(csvText).toContain('Q1 Attempt 1 Response,Q1 Attempt 1 Points,Q1 Attempt 2 Response,Q1 Attempt 2 Points');
    expect(csvText).toContain('Lovelace,Ada,ada@example.edu,87.5%,Yes,100%,100%');
    expect(csvText).toContain(',B,4');
    expect(csvText).not.toContain('grace@example.edu');
    expect(csvText).not.toContain(' Time');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /export results to csv/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /include response timestamps/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^export csv$/i }));
    expect(downloadedBlob.parts.join('')).toContain('Q1 Attempt 1 Time');
    expect(downloadedBlob.parts.join('')).toContain('Q1 Attempt 2 Time');
    expect(downloadedBlob.parts.join('')).toMatch(/2026-03-15T\d{2}:00:00\.000[+-]\d{2}:\d{2}/);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    vi.stubGlobal('Blob', originalBlob);
    createObjectUrlSpy.mockRestore();
    revokeObjectUrlSpy.mockRestore();
    clickSpy.mockRestore();
    expect(screen.queryByText(/attempt 2/i)).not.toBeInTheDocument();
  });

  it('builds CSV rows for the visible students in table order with split identity columns', async () => {
    const csvExport = buildSessionResultsCsv({
      csvQuestionAttempts: [
        {
          question: {
            _id: 'q-1',
            type: 0,
            options: [
              { answer: 'A', plainText: 'A', correct: false },
              { answer: 'B', plainText: 'B', correct: true },
            ],
          },
          questionNumber: 1,
          attempts: [2],
        },
      ],
      gradesByStudentId: {
        'student-1': {
          userId: 'student-1',
          value: 87.5,
          marks: [{ questionId: 'q-1', points: 4 }],
        },
      },
      sessionName: 'Midterm review',
      studentResults: [
        {
          studentId: 'student-1',
          firstname: 'Ada',
          lastname: 'Lovelace',
          email: 'ada@example.edu',
          inSession: true,
          participation: 100,
          joinedAt: '2026-03-15T12:05:00.000Z',
          questionResults: [
            {
              questionId: 'q-1',
              responses: [{ attempt: 2, answer: '1', createdAt: '2026-03-15T12:00:00.000Z' }],
            },
          ],
        },
      ],
      visibleStudents: [
        {
          studentId: 'student-1',
          percentCorrectValue: 100,
        },
      ],
      t: i18n.t.bind(i18n),
    });

    expect(csvExport.filename).toBe('Midterm_review_results.csv');
    expect(csvExport.csvContent).toContain('Last Name,First Name,Email,Grade,In Session,Participation,Percent Correct,Joined Session,Q1 Response,Q1 Points');
    expect(csvExport.csvContent).toContain('Lovelace,Ada,ada@example.edu,87.5%,Yes,100%,100%');
    expect(csvExport.csvContent).toContain(',B,4');
  });

  it.each([false, true])('exports join times as ISO timestamps when response timestamps are %s', (includeResponseTimestamps) => {
    const payload = buildResultsPayload();
    const joinedAt = '2026-10-02T19:59:58.771Z';
    payload.studentResults[0].joinedAt = joinedAt;
    payload.studentResults[0].questionResults[0].responses = [{ attempt: 1, answer: '1', submittedAt: joinedAt }];
    for (const value of [joinedAt, null, 'invalid']) {
      payload.studentResults[0].joinedAt = value;
      const csv = buildSessionResultsCsv({
        includeResponseTimestamps,
        csvQuestionAttempts: [{ question: payload.questions[0], questionNumber: 1, attempts: [1] }],
        studentResults: [payload.studentResults[0]],
        gradesByStudentId: {},
        t: i18n.t.bind(i18n),
      });
      const [headers, row] = csv.csvContent.split('\n').map((line) => line.split(','));
      expect(row).toHaveLength(headers.length);
      const time = row[headers.indexOf('Joined Session')];
      if (value === joinedAt) {
        expect(time).toMatch(/^2026-10-\d{2}T\d{2}:\d{2}:58\.771[+-]\d{2}:\d{2}$/);
        expect(new Date(time).toISOString()).toBe(joinedAt);
        if (includeResponseTimestamps) expect(time).toBe(row[headers.indexOf('Q1 Time')]);
      } else {
        expect(time).toBe('');
      }
    }
  });

  it.each(['en', 'fr'])('labels True/False responses in the table and CSV in %s', async (locale) => {
    await i18n.changeLanguage(locale);
    const payload = buildResultsPayload();
    // Reversed option order also occurs in imported questions; respect the option text.
    payload.questions[0] = { ...payload.questions[0], type: 1, options: [
      { _id: 'false-option', content: '<p>False</p>' },
      { _id: 'true-option', content: '<p>True</p>' },
    ] };
    payload.studentResults[0].questionResults[0].responses[0].answer = { optionId: 'true-option' };
    const defaultGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation(async (url) => url.endsWith('/results')
      ? { data: payload } : defaultGet(url));
    renderSessionReview();
    fireEvent.click(await screen.findByRole('tab', { name: i18n.t('professor.sessionReview.responseData') }));
    const trueLabel = i18n.t('questions.editor.true');
    const falseLabel = i18n.t('questions.editor.false');
    expect(await screen.findByRole('cell', { name: `${trueLabel} (4)`, exact: true })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: `${falseLabel} (1)`, exact: true })).toBeInTheDocument();
    const csv = buildSessionResultsCsv({
      csvQuestionAttempts: [{ question: payload.questions[0], questionNumber: 1, attempts: [1, 2] }],
      studentResults: payload.studentResults, gradesByStudentId: {}, sessionName: 'True False',
      t: i18n.t.bind(i18n),
    });
    expect(csv.csvContent).toContain(`,${trueLabel},`);
    expect(csv.csvContent).toContain(`,${falseLabel},`);
  });

  it('exports times for each attempt, leaving missing responses and legacy dates blank', () => {
    const payload = buildResultsPayload();
    payload.studentResults[0].joinedAt = null;
    payload.studentResults[0].questionResults[0].responses = [
      { attempt: 1, answer: '0', createdAt: '2026-03-15T12:00:00Z' },
      { attempt: 1, answer: '1', createdAt: '2026-03-15T11:00:00Z', submittedAt: '2026-03-15T12:05:00Z', updatedAt: '2026-03-15T12:10:00Z' },
      { attempt: 2, answer: '0' },
      { attempt: 3, answer: '1', createdAt: 'invalid' },
    ];
    const csv = buildSessionResultsCsv({
      includeResponseTimestamps: true,
      csvQuestionAttempts: [{ question: payload.questions[0], questionNumber: 1, attempts: [1, 2, 3, 4] }],
      studentResults: [payload.studentResults[0]],
      gradesByStudentId: {},
      t: i18n.t.bind(i18n),
    });
    const [header, row] = csv.csvContent.split('\n').map((line) => line.split(','));
    expect(row).toHaveLength(header.length);
    expect(row[header.indexOf('Q1 Attempt 1 Response')]).toBe('B');
    expect(new Date(row[header.indexOf('Q1 Attempt 1 Time')]).toISOString()).toBe('2026-03-15T12:05:00.000Z');
    for (const attempt of [2, 3, 4]) expect(row[header.indexOf(`Q1 Attempt ${attempt} Time`)]).toBe('');

    const single = buildSessionResultsCsv({
      includeResponseTimestamps: true,
      csvQuestionAttempts: [{ question: payload.questions[0], questionNumber: 1, attempts: [1] }],
      studentResults: [payload.studentResults[0]],
      gradesByStudentId: {},
      t: i18n.t.bind(i18n),
    });
    expect(single.csvContent.split('\n')[0]).toContain('Q1 Response,Q1 Points,Q1 Time');
  });

  it('combines all attempts in the overview and offers separate question timelines', async () => {
    renderSessionReview();
    await screen.findByText('Midterm review');
    expect(screen.getByRole('button', { name: 'Session response timeline' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Session response timeline' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Session response timeline' }));
    const overview = screen.getByRole('region', { name: 'Session response timeline' });
    expect(within(overview).getByText('Responses plotted: 2')).toBeVisible();
    expect(screen.queryByRole('img', { name: /Q1, attempt/ })).not.toBeInTheDocument();
    for (const number of [1, 2]) {
      const name = `Response timeline — Q1, attempt ${number}`;
      fireEvent.click(screen.getByRole('button', { name }));
      const attempt = screen.getByRole('region', { name });
      expect(within(attempt).getByText('Responses plotted: 1')).toBeVisible();
      expect(within(attempt).queryByRole('switch')).not.toBeInTheDocument();
      // Each attempt has a single timestamp; its plot must not inherit the
      // broader multi-bin range of the other attempt or the whole session.
      expect(within(attempt).getByRole('img').querySelectorAll('rect')).toHaveLength(1);
    }
    expect(within(overview).queryByRole('switch')).not.toBeInTheDocument();
  });

  it('disables timestamp exports and timelines for anonymous activities', async () => {
    const defaultGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation(async (url) => url === '/sessions/session-1/results'
      ? { data: buildResultsPayload({ anonymous: true }) }
      : defaultGet(url));
    renderSessionReview();
    await screen.findByText('Midterm review');
    expect(screen.queryByRole('button', { name: /response timeline/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /response data/i }));
    fireEvent.click(screen.getByRole('button', { name: /export results to csv/i }));
    expect(screen.getByRole('checkbox', { name: /include response timestamps/i })).toBeDisabled();
    expect(screen.getByText(/timestamps are hidden for anonymous activities/i)).toBeInTheDocument();
  });

  it('builds anonymous CSV rows without identity, grade, join, or time columns even if requested', () => {
    const csvExport = buildSessionResultsCsv({
      includeResponseTimestamps: true,
      anonymous: true,
      csvQuestionAttempts: [
        {
          question: {
            _id: 'q-1',
            type: 0,
            options: [
              { answer: 'A', plainText: 'A', correct: false },
              { answer: 'B', plainText: 'B', correct: true },
            ],
          },
          questionNumber: 1,
          attempts: [1],
        },
      ],
      gradesByStudentId: {},
      sessionName: 'Course survey',
      studentResults: [
        {
          studentId: 'respondent-1',
          firstname: 'Respondent 1',
          lastname: '',
          email: '',
          participation: 100,
          questionResults: [{ questionId: 'q-1', responses: [{ attempt: 1, answer: '1', createdAt: '2026-03-15T12:00:00Z' }] }],
        },
      ],
      visibleStudents: [{ studentId: 'respondent-1', percentCorrectValue: 100 }],
      t: i18n.t.bind(i18n),
    });

    const [header, row] = csvExport.csvContent.split('\n');
    expect(header).toBe('Respondent,Participation,Percent Correct,Q1 Response,Q1 Points');
    expect(row).toBe('Respondent 1,100%,100%,B,');
  });

  it('explains when anonymous rows are withheld below the respondent threshold', async () => {
    const defaultGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/results') {
        return { data: {
          ...buildResultsPayload({ anonymous: true }),
          studentResults: [],
          anonymousSummary: {
            respondentCount: 2, joinedCount: 2, enrolledCount: 10,
            responsesWithheld: true, minimumRespondents: 4,
          },
        } };
      }
      return defaultGet(url);
    });

    renderSessionReview();
    expect(await screen.findByText(/Answers are shown separately for each question and attempt with at least 4 respondents/)).toBeInTheDocument();
    expect(screen.getByText('Respondents')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /response data/i }));
    expect(screen.queryByRole('table', { name: /student results/i })).not.toBeInTheDocument();
  });

  it('shows true counts and per-attempt withheld markers alongside released anonymous answers', async () => {
    const payload = buildResultsPayload({ anonymous: true });
    payload.questions[0].anonymousResponseAttempts = [
      { attempt: 1, respondentCount: 4, responsesWithheld: false, minimumRespondents: 4 },
      { attempt: 2, respondentCount: 3, responsesWithheld: true, minimumRespondents: 4 },
    ];
    payload.studentResults = Array.from({ length: 4 }, (_, index) => ({
      studentId: `respondent-${index + 1}`, anonymousIndex: index + 1, participation: null,
      questionResults: [{ questionId: 'q-1', responses: [{ attempt: 1, answer: '1' }] }],
    }));
    payload.anonymousSummary = { respondentCount: 4, responsesWithheld: true, minimumRespondents: 4 };
    const defaultGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation(async (url) => url === '/sessions/session-1/results'
      ? { data: payload } : defaultGet(url));
    renderSessionReview();
    expect(await screen.findByText('3 responses')).toBeInTheDocument();
    expect(screen.getByText('4 responses')).toBeInTheDocument();
    expect(screen.queryByText('0 responses')).not.toBeInTheDocument();
    expect(screen.getByText('Answers hidden — fewer than 4 respondents.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /response data/i }));
    const table = await screen.findByRole('table', { name: /student results/i });
    expect(within(table).getAllByRole('cell', { name: 'B', exact: true })).toHaveLength(4);
    expect(within(table).getAllByText('Answers hidden — fewer than 4 respondents.')).toHaveLength(4);
    expect(within(table).queryByText('0%')).not.toBeInTheDocument();
    const csv = buildSessionResultsCsv({
      anonymous: true, gradesByStudentId: {}, sessionName: 'Survey', t: i18n.t.bind(i18n),
      csvQuestionAttempts: [{ question: payload.questions[0], questionNumber: 1, attempts: [1, 2] }],
      studentResults: payload.studentResults.map((student) => ({ ...student, firstname: `Respondent ${student.anonymousIndex}` })),
    });
    expect(csv.csvContent).toContain('Respondent 1,—,—,B,,Answers hidden — fewer than 4 respondents.,');
  });

  it('shows anonymous results with respondent labels and a read-only responses tab', async () => {
    const defaultGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/results') {
        const payload = buildResultsPayload({ anonymous: true, joinedCount: 3 });
        payload.studentResults = payload.studentResults.map((student, index) => ({
          ...student,
          studentId: `respondent-${index + 1}`,
          anonymousIndex: index + 1,
          firstname: '',
          lastname: '',
          email: '',
          profileImage: '',
          profileThumbnail: '',
          joinedAt: null,
          inSession: true,
        }));
        payload.anonymousSummary = { respondentCount: 2, joinedCount: 3, enrolledCount: 10 };
        return { data: payload };
      }
      return defaultGet(url);
    });

    renderSessionReview();

    expect(await screen.findByText(/This session is anonymous/)).toBeInTheDocument();
    expect(screen.getByText('Respondents')).toBeInTheDocument();
    expect(screen.getByText('3/10')).toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalledWith('/sessions/session-1/grades');
    expect(screen.queryByRole('tab', { name: /grading/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /response data/i }));
    const resultsTable = await screen.findByRole('table', { name: /student results/i });
    expect(within(resultsTable).getByText('Respondent 1')).toBeInTheDocument();
    expect(within(resultsTable).getByText('Respondent 2')).toBeInTheDocument();
    expect(within(resultsTable).queryByText('Grade')).not.toBeInTheDocument();
    expect(within(resultsTable).getByRole('cell', { name: 'B', exact: true })).toBeInTheDocument();
    expect(within(resultsTable).getByRole('cell', { name: 'A', exact: true })).toBeInTheDocument();
    expect(within(resultsTable).queryByText('In Session')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/search respondents/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /responses by question/i }));
    const responsesTable = await screen.findByRole('table', { name: /anonymous responses/i });
    const rows = within(responsesTable).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('Respondent 1')).toBeInTheDocument();
    expect(within(rows[1]).getByText('B')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Yes')).toBeInTheDocument();
    expect(within(rows[2]).getByText('A')).toBeInTheDocument();
    expect(within(rows[2]).getByText('No')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Question navigator' })).toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalledWith('/sessions/session-1/grades');
    expect(screen.queryByRole('spinbutton', { name: 'Question points' })).not.toBeInTheDocument();
  });

  it('grades enrolled students and shows guest answers without grade controls in a shared named activity', async () => {
    const defaultGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/results') {
        const payload = buildResultsPayload({ activityEverShared: true });
        Object.assign(payload.studentResults[0], { guest: false, participantRole: 'student', isProfessor: false });
        Object.assign(payload.studentResults[1], { guest: true, participantRole: 'guest', isProfessor: true });
        return { data: payload };
      }
      if (url === '/sessions/session-1/grades') {
        return { data: { grades: [{
          _id: 'grade-1', userId: 'student-1', value: 87.5,
          marks: [{ questionId: 'q-1', points: 4, outOf: 5, needsGrading: false }],
        }] } };
      }
      return defaultGet(url);
    });

    renderSessionReview();
    expect(await screen.findByText(/Enrolled students can receive grades/)).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledWith('/sessions/session-1/grades');
    fireEvent.click(screen.getByRole('tab', { name: /response data/i }));
    const resultsTable = await screen.findByRole('table', { name: /student results/i });
    const guestRow = within(resultsTable).getByText('Grace Hopper').closest('tr');
    expect(within(guestRow).getByText('Guest')).toBeInTheDocument();
    expect(within(guestRow).getByText('Professor')).toBeInTheDocument();
    const enrolledRow = within(resultsTable).getByText('Ada Lovelace').closest('tr');
    expect(within(enrolledRow).getByText('Student')).toBeInTheDocument();
    expect(within(guestRow).getByText('No grade')).toBeInTheDocument();
    expect(within(guestRow).getByRole('cell', { name: 'A', exact: true })).toBeInTheDocument();
    expect(within(enrolledRow).getByRole('cell', { name: 'B (4)', exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /grading/i }));
    expect(await screen.findByText('Guest responses')).toBeInTheDocument();
    expect(screen.getByText(/Guests do not receive grades/)).toBeInTheDocument();
  });

  it.each([undefined, null, '', 0])('shows points only for an explicit question mark (%s)', async (points) => {
    const defaultGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation(async (url) => {
      if (url.endsWith('/grades')) return { data: { grades: [{ userId: 'student-1',
        marks: [{ questionId: 'q-1', points }],
      }] } };
      if (url.endsWith('/results')) {
        const payload = buildResultsPayload();
        payload.studentResults[0].questionResults[0].responses[0].mark = 0;
        return { data: payload };
      }
      return defaultGet(url);
    });
    renderSessionReview();
    fireEvent.click(await screen.findByRole('tab', { name: /response data/i }));
    const table = await screen.findByRole('table', { name: /student results/i });
    const row = within(table).getByText('Ada Lovelace').closest('tr');
    expect(within(row).getByRole('cell', { name: points === 0 ? 'B (0)' : 'B', exact: true })).toBeInTheDocument();
    const payload = buildResultsPayload();
    const csv = buildSessionResultsCsv({
      csvQuestionAttempts: [{ question: payload.questions[0], questionNumber: 1, attempts: [2] }],
      studentResults: [payload.studentResults[0]], sessionName: 'Review',
      gradesByStudentId: { 'student-1': { marks: [{ questionId: 'q-1', points }] } },
      t: i18n.t.bind(i18n),
    });
    expect(csv.csvContent.split('\n')[1]).toMatch(points === 0 ? /,B,0$/ : /,B,$/);
  });

  it('opens the student avatar image from the response data tab', async () => {
    renderSessionReview();

    await screen.findByText('Midterm review');
    fireEvent.click(screen.getByRole('tab', { name: /response data/i }));
    await screen.findByText('Ada Lovelace');

    fireEvent.click(screen.getByRole('button', { name: /ada lovelace/i }));

    expect(await screen.findByRole('img', { name: 'Ada Lovelace' })).toBeInTheDocument();
  });

  it('loads running live interactive sessions but warns that grading stays locked', async () => {
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/results') {
        return {
          data: buildResultsPayload({ status: 'running', reviewable: false, quiz: false, practiceQuiz: false }),
        };
      }
      if (url === '/courses/course-1') {
        return {
          data: {
            course: {
              _id: 'course-1',
              name: 'Discrete Math',
              deptCode: 'MATH',
              courseNumber: '200',
              section: '001',
              semester: 'Fall 2026',
            },
          },
        };
      }
      if (url === '/sessions/session-1/grades') {
        return {
          data: {
            grades: [],
          },
        };
      }
      if (url === '/courses/course-1/groups') {
        return { data: { groupCategories: [] } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    renderSessionReview();

    await screen.findByText('Midterm review');
    expect(screen.getByText(/results continue to update here, but grading stays locked until the session ends/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /grading/i }));
    expect(await screen.findByText(/this grading interface is locked while the session is live/i)).toBeInTheDocument();
    expect(screen.queryByText(/results will be available after the session ends/i)).not.toBeInTheDocument();
  });

  it('makes sessions reviewable through the dedicated reviewable endpoint without a confirm dialog', async () => {
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/results') {
        return {
          data: buildResultsPayload({ reviewable: false }),
        };
      }
      if (url === '/courses/course-1') {
        return {
          data: {
            course: {
              _id: 'course-1',
              name: 'Discrete Math',
              deptCode: 'MATH',
              courseNumber: '200',
              section: '001',
              semester: 'Fall 2026',
            },
          },
        };
      }
      if (url === '/sessions/session-1/grades') {
        return { data: { grades: [] } };
      }
      if (url === '/courses/course-1/groups') {
        return { data: { groupCategories: [] } };
      }
      throw new Error(`Unexpected GET ${url}`);
    });
    apiClient.patch
      .mockResolvedValueOnce({
        data: {
          session: buildResultsPayload({ reviewable: true }).session,
          grading: null,
          nonAutoGradeableWarning: null,
        },
      });

    renderSessionReview();

    const toggle = await screen.findByRole('switch', { name: /toggle student review access/i });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledTimes(1);
      expect(apiClient.patch).toHaveBeenCalledWith('/sessions/session-1/reviewable', { reviewable: true });
      expect(toggle).toBeChecked();
    });
  });

  it('sends the selected saved guidance and blocks generation while editing it', async () => {
    const defaultGet = apiClient.get.getMockImplementation();
    const custom = { _id: 'custom-summary', kind: 'summary', name: 'French quotes', content: 'Give quotes in French.' };
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/results') {
        const payload = buildResultsPayload();
        payload.questions[0] = { ...payload.questions[0], type: 2, options: [] };
        return { data: payload };
      }

      if (url.endsWith('/grading-instructions')) return { data: { instructions: [
        { _id: 'basic-summary', kind: 'summary', name: 'Basic summary', content: 'Default guidance.' }, custom,
      ] } };
      if (url.endsWith('/config')) return { data: { approvedModels: [
        { backendId: 'local', modelId: 'model', displayName: 'Test model' },
      ], defaultBackendId: 'local', defaultModelId: 'model' } };
      return defaultGet(url);
    });
    apiClient.post.mockImplementation(async (url, payload) => {
      if (url.endsWith('/grading-instructions')) return { data: { instruction: { ...payload, _id: custom._id } } };
      return { data: { summary: { status: 'completed', summary: 'Custom output' } } };
    });
    renderSessionReview();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Generate AI Response summary' }))[0]);
    const dialog = screen.getByRole('dialog');
    const generate = within(dialog).getByRole('button', { name: 'Generate AI Response summary' });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: 'Summary instructions' }));
    fireEvent.click(await screen.findByRole('option', { name: 'French quotes' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit' }));
    expect(generate).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Summary instructions' }), {
      target: { value: 'Only quote responses in French, in a table.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(generate).toBeEnabled());
    expect(within(dialog).queryByRole('textbox', { name: 'Summary instructions' })).not.toBeInTheDocument();
    fireEvent.click(generate);
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith(
      '/ai/courses/course-1/sessions/session-1/questions/q-1/ai-summary', {
        instruction: 'Only quote responses in French, in a table.', backendId: 'local', modelId: 'model',
      }
    ));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click((await screen.findAllByRole('button', { name: 'Generate AI Response summary' }))[0]);
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('combobox', { name: 'Summary instructions' })).toHaveTextContent('French quotes'));
  });

  it('shows a halt control while an AI response summary is running', async () => {
    const defaultGet = apiClient.get.getMockImplementation();
    const runningSummary = {
      _id: 'summary-1',
      status: 'running',
      phase: 'generating',
      completed: 2,
      total: 2,
    };
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/sessions/session-1/results') {
        const payload = buildResultsPayload();
        payload.questions[0] = {
          ...payload.questions[0],
          type: 2,
          content: '<p>Explain recursion</p>',
          plainText: 'Explain recursion',
          options: [],
        };
        return { data: payload };
      }
      if (url.endsWith('/ai-summaries')) return { data: { summaries: [{ ...runningSummary, questionId: 'q-1' }] } };
      return defaultGet(url);
    });
    apiClient.post.mockResolvedValueOnce({
      data: { summary: { ...runningSummary, status: 'halted', phase: 'halted' } },
    });

    renderSessionReview();

    const haltButtons = await screen.findAllByRole('button', { name: 'Halt summary' });
    fireEvent.click(haltButtons[0]);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/ai/courses/course-1/sessions/session-1/questions/q-1/ai-summary/halt');
    });
    expect((await screen.findAllByText('AI summary halted. You can generate it again.')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Generate AI Response summary' }).length).toBeGreaterThan(0);
  });
});
