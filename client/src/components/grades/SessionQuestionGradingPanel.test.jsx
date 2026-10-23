import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SessionQuestionGradingPanel, { buildResponseSummary } from './SessionQuestionGradingPanel';
import apiClient from '../../api/client';
import i18n from '../../i18n';

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  },
}));

vi.mock('../questions/RichTextEditor', () => ({
  default: ({
    value,
    onChange,
    ariaLabel,
    disabled,
    onBlur,
  }) => (
    <FeedbackTextarea
      value={value}
      onChange={onChange}
      ariaLabel={ariaLabel}
      disabled={disabled}
      onBlur={onBlur}
    />
  ),
}));

function FeedbackTextarea({
  value,
  onChange,
  ariaLabel,
  disabled,
  onBlur,
}) {
  const [localValue, setLocalValue] = React.useState(value || '');

  React.useEffect(() => {
    setLocalValue(value || '');
  }, [value]);

  return (
    <textarea
      aria-label={ariaLabel}
      value={localValue}
      disabled={disabled}
      onChange={(event) => {
        const nextValue = event.target.value;
        setLocalValue(nextValue);
        onChange?.({ html: nextValue, plainText: nextValue });
      }}
      onBlur={onBlur}
    />
  );
}

function buildGradesPayload() {
  return {
    grades: [
      {
        _id: 'grade-1',
        userId: 'student-a',
        marks: [{ questionId: 'q-mc', points: 1, outOf: 1, needsGrading: false }],
      },
      {
        _id: 'grade-2',
        userId: 'student-b',
        marks: [{ questionId: 'q-mc', points: 0, outOf: 1, needsGrading: false }],
      },
    ],
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SessionQuestionGradingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage('en');
    apiClient.get.mockResolvedValue({ data: buildGradesPayload() });
    apiClient.patch.mockResolvedValue({ data: { grade: { _id: 'grade-1', userId: 'student-a', marks: [{ questionId: 'q-manual', points: 0, outOf: 5, needsGrading: false }] } } });
    apiClient.post.mockResolvedValue({ data: {} });
    apiClient.put.mockResolvedValue({ data: {} });
  });

  it('renders one labelled question navigator below the active question', async () => {
    render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[{
          _id: 'q-mc', type: 0, content: '<p>Pick one</p>', plainText: 'Pick one', sessionOptions: { points: 1 },
        }]}
        studentResults={[{
          studentId: 'student-a', firstname: 'Ada', lastname: 'Lovelace', inSession: true,
          questionResults: [{ questionId: 'q-mc', responses: [{ attempt: 1, answer: '0' }] }],
        }]}
      />
    );

    await screen.findByText('Ada Lovelace');
    expect(screen.getAllByText('Question navigator')).toHaveLength(1);
    expect(screen.getByRole('navigation', { name: 'Question navigator' })).toHaveTextContent('Q1');
  });

  it('keeps a failed AI grading report available with its error and partial log notice', async () => {
    apiClient.get.mockImplementation((url) => {
      if (url.includes('/ai/courses/')) {
        return Promise.resolve({
          data: {
            job: {
              status: 'failed',
              error: 'The AI service timed out.',
              log: [{ question: 'Q1', student: 'Ada Lovelace', status: 'graded', points: 3, outOf: 5 }],
            },
          },
        });
      }
      return Promise.resolve({ data: buildGradesPayload() });
    });

    render(
      <SessionQuestionGradingPanel
        courseId="course-1"
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[{ _id: 'q-manual', type: 2, content: '<p>Explain</p>', sessionOptions: { points: 5 } }]}
        studentResults={[{ studentId: 'student-a', firstname: 'Ada', lastname: 'Lovelace', inSession: true }]}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'AI grading report' }));

    expect(screen.getAllByText(/last AI grading run did not complete/i)).toHaveLength(2);
    expect(screen.getByText(/The AI service timed out/i)).toBeInTheDocument();
    expect(screen.getByText('Q1 · Ada Lovelace')).toBeInTheDocument();
  });

  it('halts active AI grading and immediately opens its partial report', async () => {
    let gradingHalted = false;
    const haltedData = {
      job: {
        _id: 'job-1', status: 'halted', completed: 2, total: 10,
        report: { summary: 'AI grading was halted after 2 of 10 grading steps.' },
      },
      log: { runs: [{ jobId: 'job-1', status: 'halted', entries: [{ status: 'halted', note: 'AI grading was halted by an instructor.' }] }] },
    };
    apiClient.get.mockImplementation((url) => {
      if (url.includes('/ai/courses/')) {
        return Promise.resolve({ data: gradingHalted ? haltedData : { job: {
          _id: 'job-1', status: 'running', completed: 2, total: 10,
          currentStudent: 2, studentTotal: 5, currentQuestion: 1, questionTotal: 2,
        } } });
      }
      return Promise.resolve({ data: buildGradesPayload() });
    });
    apiClient.post.mockImplementationOnce(() => {
      gradingHalted = true;
      return Promise.resolve({ data: haltedData });
    });

    render(
      <SessionQuestionGradingPanel
        courseId="course-1"
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[{ _id: 'q-manual', type: 2, content: '<p>Explain</p>', sessionOptions: { points: 5 } }]}
        studentResults={[{ studentId: 'student-a', firstname: 'Ada', lastname: 'Lovelace', inSession: true }]}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Halt grading' }));

    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/ai/courses/course-1/sessions/session-1/ai-grading/halt'));
    expect(await screen.findByText('AI grading was halted after 2 of 10 grading steps.')).toBeInTheDocument();
    expect(screen.getByText('AI grading was halted by an instructor.')).toBeInTheDocument();
  });

  it('debounces answer filtering and matches MC answers by option label instead of option text', async () => {
    render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-mc',
            type: 0,
            content: '<p>Pick one</p>',
            plainText: 'Pick one',
            sessionOptions: { points: 1 },
            options: [
              { answer: 'Correct', plainText: 'Correct', correct: true },
              { answer: 'Alpha distractor', plainText: 'Alpha distractor', correct: false },
            ],
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-mc', responses: [{ attempt: 1, answer: '0' }] }],
          },
          {
            studentId: 'student-b',
            firstname: 'Grace',
            lastname: 'Hopper',
            email: 'grace@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-mc', responses: [{ attempt: 1, answer: '1' }] }],
          },
        ]}
      />
    );

    await screen.findByText('Ada Lovelace');
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/search answer content/i), { target: { value: 'A' } });

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
      expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
    });
  });

  it('builds filter text for TF, numerical, and short-answer responses using the searchable answer value', () => {
    expect(buildResponseSummary(
      {
        type: 1,
        options: [
          { answer: 'True', plainText: 'True', correct: true },
          { answer: 'False', plainText: 'False', correct: false },
        ],
      },
      { answer: '0' }
    ).filterText).toBe('true');

    expect(buildResponseSummary(
      { type: 4 },
      { answer: '12.345' }
    ).filterText).toBe('12.345');

    expect(buildResponseSummary(
      { type: 2 },
      { answer: 'Derivative is positive', answerWysiwyg: '<p>Derivative is positive</p>' }
    ).filterText.toLowerCase()).toContain('derivative is positive');
  });

  it('allows saving a manual zero when the mark previously had no explicit score', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        grades: [
          {
            _id: 'grade-1',
            userId: 'student-a',
            marks: [{ questionId: 'q-manual', points: null, outOf: 5, needsGrading: true, feedback: '' }],
          },
        ],
      },
    });

    render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-manual',
            type: 2,
            content: '<p>Explain your reasoning</p>',
            plainText: 'Explain your reasoning',
            sessionOptions: { points: 5 },
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-manual', responses: [{ attempt: 1, answer: 'Because it works.' }] }],
          },
        ]}
      />
    );

    await screen.findByText('Ada Lovelace');

    const saveButton = screen.getAllByRole('button', { name: /save/i }).find((button) => !button.disabled);
    expect(saveButton).toBeTruthy();
    expect(saveButton).not.toBeDisabled();

    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/grades/grade-1/marks/q-manual',
        { points: 0, feedback: '' }
      );
    });
  });

  it('updates feedback drafts while typing in the grading table', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        grades: [
          {
            _id: 'grade-1',
            userId: 'student-a',
            marks: [{ questionId: 'q-manual', points: 3, outOf: 5, needsGrading: false, feedback: '' }],
          },
        ],
      },
    });

    render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-manual',
            type: 2,
            content: '<p>Explain your reasoning</p>',
            plainText: 'Explain your reasoning',
            sessionOptions: { points: 5 },
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-manual', responses: [{ attempt: 1, answer: 'Because it works.' }] }],
          },
        ]}
      />
    );

    await screen.findByText('Ada Lovelace');

    const feedbackInput = screen.getByLabelText(/feedback — ada lovelace/i);
    const row = screen.getByText('Ada Lovelace').closest('tr');
    const rowSaveButton = within(row).getByRole('button', { name: /^save$/i });

    await waitFor(() => {
      expect(rowSaveButton).toBeDisabled();
    });

    fireEvent.change(feedbackInput, { target: { value: 'Immediate feedback' } });

    await waitFor(() => {
      expect(rowSaveButton).not.toBeDisabled();
    });
  });

  it('saves latest feedback even when Save is clicked before the feedback editor blurs', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        grades: [
          {
            _id: 'grade-1',
            userId: 'student-a',
            marks: [{ questionId: 'q-manual', points: 3, outOf: 5, needsGrading: false, feedback: '' }],
          },
        ],
      },
    });
    apiClient.patch.mockResolvedValueOnce({
      data: {
        grade: {
          _id: 'grade-1',
          userId: 'student-a',
          marks: [{ questionId: 'q-manual', points: 3, outOf: 5, needsGrading: false, feedback: 'Immediate feedback text' }],
        },
      },
    });

    render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-manual',
            type: 2,
            content: '<p>Explain your reasoning</p>',
            plainText: 'Explain your reasoning',
            sessionOptions: { points: 5 },
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-manual', responses: [{ attempt: 1, answer: 'Because it works.' }] }],
          },
        ]}
      />
    );

    await screen.findByText('Ada Lovelace');

    fireEvent.change(screen.getByLabelText(/feedback — ada lovelace/i), {
      target: { value: 'Immediate feedback text' },
    });
    const row = screen.getByText('Ada Lovelace').closest('tr');
    fireEvent.click(within(row).getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/grades/grade-1/marks/q-manual',
        { points: 3, feedback: 'Immediate feedback text' }
      );
    });
  });

  it('preserves an in-progress feedback draft when grading rows refresh', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        grades: [
          {
            _id: 'grade-1',
            userId: 'student-a',
            marks: [{ questionId: 'q-manual', points: 3, outOf: 5, needsGrading: false, feedback: '' }],
          },
        ],
      },
    });

    const session = { _id: 'session-1', quiz: false, practiceQuiz: false };
    const questions = [
      {
        _id: 'q-manual',
        type: 2,
        content: '<p>Explain your reasoning</p>',
        plainText: 'Explain your reasoning',
        sessionOptions: { points: 5 },
      },
    ];
    const initialStudentResults = [
      {
        studentId: 'student-a',
        firstname: 'Ada',
        lastname: 'Lovelace',
        email: 'ada@example.edu',
        inSession: true,
        questionResults: [{ questionId: 'q-manual', responses: [{ attempt: 1, answer: 'Because it works.' }] }],
      },
    ];

    const { rerender } = render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={session}
        questions={questions}
        studentResults={initialStudentResults}
      />
    );

    await screen.findByText('Ada Lovelace');

    const feedbackInput = screen.getByLabelText(/feedback — ada lovelace/i);
    fireEvent.change(feedbackInput, { target: { value: 'Typing draft feedback' } });

    await waitFor(() => {
      const row = screen.getByText('Ada Lovelace').closest('tr');
      const rowSaveButton = within(row).getByRole('button', { name: /^save$/i });
      expect(rowSaveButton).not.toBeDisabled();
    });

    rerender(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ ...session }}
        questions={[{ ...questions[0] }]}
        studentResults={[{ ...initialStudentResults[0], questionResults: [...initialStudentResults[0].questionResults] }]}
      />
    );

    expect(screen.getByLabelText(/feedback — ada lovelace/i)).toHaveValue('Typing draft feedback');
  });

  it('locks grading controls until the session has ended', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        grades: [
          {
            _id: 'grade-1',
            userId: 'student-a',
            marks: [{ questionId: 'q-manual', points: 3, outOf: 5, needsGrading: false, feedback: '' }],
          },
        ],
      },
    });

    render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', status: 'running', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-manual',
            type: 2,
            content: '<p>Explain your reasoning</p>',
            plainText: 'Explain your reasoning',
            sessionOptions: { points: 5 },
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-manual', responses: [{ attempt: 1, answer: 'Because it works.' }] }],
          },
        ]}
      />
    );

    expect(await screen.findByText(/locked while the session is live/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-calculate all grades/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /fast grading interface/i })).toBeDisabled();
    expect(screen.getByLabelText(/feedback — ada lovelace/i)).toBeDisabled();
  });

  it('filters the grading table down to students with responses only', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        grades: [
          {
            _id: 'grade-1',
            userId: 'student-a',
            marks: [{ questionId: 'q-manual', points: 3, outOf: 5, needsGrading: false, feedback: '' }],
          },
          {
            _id: 'grade-2',
            userId: 'student-b',
            marks: [{ questionId: 'q-manual', points: 0, outOf: 5, needsGrading: false, feedback: '' }],
          },
        ],
      },
    });

    render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-manual',
            type: 2,
            content: '<p>Explain your reasoning</p>',
            plainText: 'Explain your reasoning',
            sessionOptions: { points: 5 },
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-manual', responses: [{ attempt: 1, answer: 'Has response' }] }],
          },
          {
            studentId: 'student-b',
            firstname: 'Grace',
            lastname: 'Hopper',
            email: 'grace@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-manual', responses: [] }],
          },
        ]}
      />
    );

    await screen.findByText('Ada Lovelace');
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/only with responses/i));

    await waitFor(() => {
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
      expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
    });
  });

  it('applies bulk grading changes only to selected filtered students', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        grades: [
          {
            _id: 'grade-1',
            userId: 'student-a',
            marks: [{ questionId: 'q-manual', points: 1, outOf: 5, needsGrading: false, feedback: '' }],
          },
          {
            _id: 'grade-2',
            userId: 'student-b',
            marks: [{ questionId: 'q-manual', points: 2, outOf: 5, needsGrading: false, feedback: '' }],
          },
        ],
      },
    });
    apiClient.patch.mockResolvedValueOnce({
      data: {
        updatedCount: 1,
        grades: [{ _id: 'grade-1', userId: 'student-a', marks: [{ questionId: 'q-manual', points: 4, outOf: 5, needsGrading: false, feedback: '' }] }],
      },
    });

    render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-manual',
            type: 2,
            content: '<p>Explain your reasoning</p>',
            plainText: 'Explain your reasoning',
            sessionOptions: { points: 5 },
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-manual', responses: [{ attempt: 1, answer: 'First response' }] }],
          },
          {
            studentId: 'student-b',
            firstname: 'Grace',
            lastname: 'Hopper',
            email: 'grace@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-manual', responses: [{ attempt: 1, answer: 'Second response' }] }],
          },
        ]}
      />
    );

    await screen.findByText('Ada Lovelace');

    const [bulkSaveButton] = screen.getAllByRole('button', { name: /^save$/i });
    expect(bulkSaveButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/bulk points/i), { target: { value: '4' } });
    expect(bulkSaveButton).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/select student: ada lovelace/i));
    expect(bulkSaveButton).not.toBeDisabled();

    fireEvent.click(bulkSaveButton);

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledTimes(1);
      expect(apiClient.patch).toHaveBeenCalledWith(
        '/sessions/session-1/grades/marks/q-manual',
        { gradeIds: ['grade-1'], points: 4 }
      );
    });
  });

  it('shows fast grading interface button for short-answer questions needing manual grading', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        grades: [
          {
            _id: 'grade-1',
            userId: 'student-a',
            marks: [{ questionId: 'q-manual', points: null, outOf: 5, needsGrading: true, feedback: '' }],
          },
        ],
      },
    });

    render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-manual',
            type: 2,
            content: '<p>Explain your reasoning</p>',
            plainText: 'Explain your reasoning',
            sessionOptions: { points: 5 },
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-manual', responses: [{ attempt: 1, answer: 'Because it works.' }] }],
          },
        ]}
      />
    );

    await screen.findByText('Ada Lovelace');
    expect(screen.getByText(/fast grading interface/i)).toBeInTheDocument();
  });

  it('keeps the speed-grading student list frozen while the modal is open', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        grades: [
          {
            _id: 'grade-1',
            userId: 'student-a',
            marks: [{ questionId: 'q-manual', points: 3, outOf: 5, needsGrading: false, feedback: '' }],
          },
          {
            _id: 'grade-2',
            userId: 'student-b',
            marks: [{ questionId: 'q-manual', points: 4, outOf: 5, needsGrading: false, feedback: '' }],
          },
        ],
      },
    });

    const question = {
      _id: 'q-manual',
      type: 2,
      content: '<p>Explain your reasoning</p>',
      plainText: 'Explain your reasoning',
      sessionOptions: { points: 5 },
    };
    const firstStudent = {
      studentId: 'student-a',
      firstname: 'Ada',
      lastname: 'Lovelace',
      email: 'ada@example.edu',
      inSession: true,
      questionResults: [{ questionId: 'q-manual', responses: [{ attempt: 1, answer: 'Because it works.' }] }],
    };
    const secondStudent = {
      studentId: 'student-b',
      firstname: 'Grace',
      lastname: 'Hopper',
      email: 'grace@example.edu',
      inSession: true,
      questionResults: [{ questionId: 'q-manual', responses: [{ attempt: 1, answer: 'Debugging matters.' }] }],
    };

    const { rerender } = render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[question]}
        studentResults={[firstStudent, secondStudent]}
      />
    );

    await screen.findByText('Ada Lovelace');
    await screen.findByText('Grace Hopper');

    fireEvent.click(screen.getByRole('button', { name: /fast grading interface/i }));

    await waitFor(() => {
      expect(screen.getByText('1 of 2')).toBeInTheDocument();
    });

    rerender(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[question]}
        studentResults={[firstStudent]}
      />
    );

    expect(screen.getByText('1 of 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => {
      expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
      expect(screen.getByText('2 of 2')).toBeInTheDocument();
    });
  });

  it('does not show fast grading button for auto-gradeable question types', async () => {
    render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-mc',
            type: 0,
            content: '<p>Pick one</p>',
            plainText: 'Pick one',
            sessionOptions: { points: 1 },
            options: [
              { answer: 'Correct', plainText: 'Correct', correct: true },
              { answer: 'Wrong', plainText: 'Wrong', correct: false },
            ],
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-mc', responses: [{ attempt: 1, answer: '0' }] }],
          },
        ]}
      />
    );

    await screen.findByText('Ada Lovelace');
    expect(screen.queryByText(/fast grading interface/i)).not.toBeInTheDocument();
  });

  it('updates question points and triggers a session grade recalculation after confirmation', async () => {
    apiClient.patch.mockResolvedValueOnce({
      data: {
        question: {
          _id: 'q-mc',
          sessionOptions: { points: 6 },
        },
      },
    });

    const onSessionDataRefresh = vi.fn().mockResolvedValue(undefined);

    render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-mc',
            type: 0,
            content: '<p>Pick one</p>',
            plainText: 'Pick one',
            sessionOptions: { points: 1 },
            options: [
              { answer: 'Correct', plainText: 'Correct', correct: true },
              { answer: 'Wrong', plainText: 'Wrong', correct: false },
            ],
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-mc', responses: [{ attempt: 1, answer: '0' }] }],
          },
        ]}
        onSessionDataRefresh={onSessionDataRefresh}
      />
    );

    await screen.findByText('Ada Lovelace');

    fireEvent.change(screen.getByLabelText(/question points/i), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /update question points/i }));
    fireEvent.click(screen.getByRole('button', { name: /proceed/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith('/questions/q-mc', {
        sessionOptions: { points: 6 },
      });
      expect(apiClient.post).toHaveBeenCalledWith('/sessions/session-1/grades/recalculate', {
        missingOnly: false,
      });
    });

    expect(onSessionDataRefresh).toHaveBeenCalled();
  });

  it('does not treat zero-point questions as needing grading even when a stale mark says otherwise', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        grades: [
          {
            _id: 'grade-1',
            userId: 'student-a',
            marks: [{ questionId: 'q-manual', points: 0, outOf: 0, needsGrading: true, feedback: '' }],
          },
        ],
      },
    });

    render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-manual',
            type: 2,
            content: '<p>Explain your reasoning</p>',
            plainText: 'Explain your reasoning',
            sessionOptions: { points: 0 },
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-manual', responses: [{ attempt: 1, answer: 'Because it works.' }] }],
          },
        ]}
      />
    );

    await screen.findByText('Ada Lovelace');

    fireEvent.click(screen.getByLabelText(/only need/i));

    await waitFor(() => {
      expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    });
  });

  it('ignores stale grade responses from a previous session when the session changes', async () => {
    const firstGrades = createDeferred();
    const secondGrades = createDeferred();
    apiClient.get
      .mockReturnValueOnce(firstGrades.promise)
      .mockReturnValueOnce(secondGrades.promise);

    const { rerender } = render(
      <SessionQuestionGradingPanel
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-session-1',
            type: 2,
            content: '<p>First question</p>',
            plainText: 'First question',
            sessionOptions: { points: 4 },
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-session-1', responses: [{ attempt: 1, answer: 'Session one response' }] }],
          },
        ]}
      />
    );

    rerender(
      <SessionQuestionGradingPanel
        sessionId="session-2"
        session={{ _id: 'session-2', quiz: false, practiceQuiz: false }}
        questions={[
          {
            _id: 'q-session-2',
            type: 2,
            content: '<p>Second question</p>',
            plainText: 'Second question',
            sessionOptions: { points: 5 },
          },
        ]}
        studentResults={[
          {
            studentId: 'student-a',
            firstname: 'Ada',
            lastname: 'Lovelace',
            email: 'ada@example.edu',
            inSession: true,
            questionResults: [{ questionId: 'q-session-2', responses: [{ attempt: 1, answer: 'Session two response' }] }],
          },
        ]}
      />
    );

    secondGrades.resolve({
      data: {
        grades: [
          {
            _id: 'grade-session-2',
            userId: 'student-a',
            marks: [{ questionId: 'q-session-2', points: 4, outOf: 5, needsGrading: false, feedback: '' }],
          },
        ],
      },
    });

    await screen.findByDisplayValue('4');
    expect(screen.getByText('/ 5')).toBeInTheDocument();

    firstGrades.resolve({
      data: {
        grades: [
          {
            _id: 'grade-session-1',
            userId: 'student-a',
            marks: [{ questionId: 'q-session-1', points: 1, outOf: 4, needsGrading: false, feedback: '' }],
          },
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('4')).toBeInTheDocument();
      expect(screen.getByText('/ 5')).toBeInTheDocument();
    });
  });

  it('does not let an AI progress refresh supersede the initial grade load', async () => {
    const initialGrades = createDeferred();
    apiClient.get.mockImplementation((url) => {
      if (url === '/sessions/session-1/grades') return initialGrades.promise;
      if (url.includes('/ai/courses/course-1/')) {
        return Promise.resolve({ data: { job: { status: 'running', completed: 1, total: 2 } } });
      }
      return Promise.resolve({ data: {} });
    });

    render(
      <SessionQuestionGradingPanel
        courseId="course-1"
        sessionId="session-1"
        session={{ _id: 'session-1', quiz: false, practiceQuiz: false }}
        questions={[{ _id: 'q-manual', type: 2, content: '<p>Explain</p>', sessionOptions: { points: 5 } }]}
        studentResults={[{ studentId: 'student-a', firstname: 'Ada', lastname: 'Lovelace', inSession: true }]}
      />
    );

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/ai/courses/course-1/sessions/session-1/ai-grading'));
    expect(apiClient.get.mock.calls.filter(([url]) => url === '/sessions/session-1/grades')).toHaveLength(1);

    initialGrades.resolve({ data: { grades: [{ _id: 'grade-1', userId: 'student-a', marks: [{ questionId: 'q-manual', points: 2, outOf: 5 }] }] } });
    await screen.findByText('Ada Lovelace');
    expect(screen.getByDisplayValue('2')).toBeInTheDocument();
  });
});

describe('Grading readiness locks', () => {
  const question = { _id: 'q', type: 2, content: '<p>Explain</p>', sessionOptions: { points: 5 } };
  const student = { studentId: 'student', firstname: 'Test', lastname: 'Student', questionResults: [{ questionId: 'q', responses: [{ answer: 'Answer', attempt: 1 }] }] };
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage('en');
  });

  it('offers explicit creation when grade items are missing and unlocks after creation', async () => {
    let created = false;
    apiClient.get.mockImplementation(async (url) => ({ data: url.includes('/ai/') ? {} : created
      ? { grades: [{ _id: 'grade', userId: 'student', marks: [{ questionId: 'q', points: 0, outOf: 5, automatic: true, needsGrading: true }] }], gradingLockReason: null }
      : { grades: [], gradingLockReason: 'missing-grades' } }));
    apiClient.post.mockImplementation(async () => { created = true; return { data: {} }; });
    render(<SessionQuestionGradingPanel sessionId="session" session={{ status: 'done', quiz: true }} questions={[question]} studentResults={[student]} />);
    const create = await screen.findByRole('button', { name: 'Create grade items' });
    expect(screen.getByRole('button', { name: 'AI Grading Assistant' })).toBeDisabled();
    fireEvent.click(create);
    await waitFor(() => expect(apiClient.post).toHaveBeenCalledWith('/sessions/session/grades/recalculate', { missingOnly: true }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Create grade items' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'AI Grading Assistant' })).toBeEnabled();
  });

  it('locks an ended quiz with remaining extensions even when grade items exist', async () => {
    apiClient.get.mockResolvedValue({ data: { grades: [{ _id: 'grade', userId: 'student', marks: [{ questionId: 'q', points: 0, outOf: 5, needsGrading: true }] }] } });
    render(<SessionQuestionGradingPanel sessionId="session" session={{ status: 'done', quiz: true, quizHasRemainingExtensions: true }} questions={[question]} studentResults={[student]} />);
    await screen.findByText(/Grading is locked while quiz extensions/);
    expect(screen.getByRole('button', { name: 'AI Grading Assistant' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Re-calculate all grades' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Create grade items' })).not.toBeInTheDocument();
  });
});
