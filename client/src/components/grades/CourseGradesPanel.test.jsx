import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react';
import CourseGradesPanel from './CourseGradesPanel';
import apiClient from '../../api/client';
import i18n from '../../i18n';

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

function buildGradesPayload() {
  return {
    sessions: [
      {
        _id: 'session-1',
        name: 'Week 1',
        marksNeedingGrading: 5,
        autoGradeableQuestionIds: ['q-mc'],
        questionTypeById: {
          'q-mc': 0,
          'q-sa': 2,
        },
      },
    ],
    rows: [
      {
        student: {
          studentId: 'student-1',
          firstname: 'Ada',
          lastname: 'Lovelace',
          email: 'ada@example.edu',
        },
        avgParticipation: 92.5,
        avgGrade: 87.5,
        grades: [
          {
            _id: 'grade-1',
            sessionId: 'session-1',
            value: 87.5,
            participation: 95,
            needsGrading: true,
            joined: true,
            points: 7,
            outOf: 8,
            marks: [
              {
                questionId: 'q-mc',
                points: 1,
                outOf: 1,
                automatic: true,
                needsGrading: false,
                attempt: 1,
                feedback: '',
              },
              {
                questionId: 'q-sa',
                points: 0,
                outOf: 1,
                automatic: true,
                needsGrading: false,
                attempt: 1,
                feedback: '',
              },
            ],
          },
        ],
      },
    ],
  };
}

async function openInstructorGradeTable() {
  fireEvent.click(screen.getByRole('button', { name: 'Show Grade Table' }));
  const dialog = await screen.findByRole('dialog', { name: /select sessions for grade table/i });
  expect(within(dialog).getByRole('checkbox', { name: 'Toggle selection for Week 1' })).toBeInTheDocument();
  fireEvent.click(within(dialog).getByText('Week 1'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Show Table' }));
  await waitForElementToBeRemoved(dialog);
  await screen.findByLabelText(/search students/i);
}

describe('CourseGradesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage('en');
    apiClient.get.mockResolvedValue({ data: buildGradesPayload() });
    apiClient.patch.mockResolvedValue({
      data: {
        grade: {
          ...buildGradesPayload().rows[0].grades[0],
          marks: [
            {
              questionId: 'q-mc',
              points: 1,
              outOf: 1,
              automatic: true,
              needsGrading: false,
              attempt: 1,
              feedback: '',
            },
            {
              questionId: 'q-sa',
              points: 0.5,
              outOf: 1,
              automatic: false,
              needsGrading: false,
              attempt: 1,
              feedback: '',
            },
          ],
        },
      },
    });
  });

  it('uses student-mode grading labels without numeric ungraded counts', async () => {
    render(<CourseGradesPanel courseId="course-1" instructorView={false} />);

    await screen.findByText(/week 1 mark/i);
    expect(screen.queryByLabelText(/search students/i)).not.toBeInTheDocument();
    expect(screen.getByText('Ungraded')).toBeInTheDocument();
    expect(screen.queryByText(/5 ungraded/i)).not.toBeInTheDocument();
  });

  it('explains unavailable student averages when no sessions are reviewable', async () => {
    const payload = buildGradesPayload();
    payload.sessions = [];
    payload.rows[0] = { ...payload.rows[0], avgParticipation: null, avgGrade: null, grades: [] };
    apiClient.get.mockResolvedValue({ data: payload });
    render(<CourseGradesPanel courseId="course-1" instructorView={false} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('No sessions are available for review yet');
    expect(screen.getAllByText('Not applicable')).toHaveLength(2);
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('opens session review for student grade clicks without opening instructor dialogs', async () => {
    const onOpenSession = vi.fn();
    render(<CourseGradesPanel courseId="course-1" instructorView={false} onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole('button', { name: '87.5%' }));
    expect(onOpenSession).toHaveBeenCalledWith('session-1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiClient.get.mock.calls.every(([url]) => url === '/courses/course-1/grades')).toBe(true);
  });

  it('starts hidden for instructors and shows selected-session grades after modal confirmation', async () => {
    render(
      <CourseGradesPanel
        courseId="course-1"
        instructorView
        availableSessions={[{ _id: 'session-1', name: 'Week 1', marksNeedingGrading: 5, autoGradeableQuestionIds: ['q-mc'] }]}
      />
    );

    expect(screen.queryByText(/week 1 mark/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/search students/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show Grade Table' })).toBeInTheDocument();

    await openInstructorGradeTable();
    expect(screen.getByLabelText(/search students/i)).toBeInTheDocument();
    expect(screen.getByText(/5 ungraded/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /87.5%/i })).toBeInTheDocument();
  });

  it('shows a later-enrolled activity guest as not applicable instead of zero', async () => {
    const payload = buildGradesPayload();
    payload.rows[0].avgParticipation = null;
    payload.rows[0].avgGrade = null;
    payload.rows[0].grades = [{ sessionId: 'session-1', notApplicable: true }];
    apiClient.get.mockResolvedValue({ data: payload });
    render(<CourseGradesPanel courseId="course-1" instructorView availableSessions={payload.sessions} />);
    await openInstructorGradeTable();
    expect(screen.getAllByText('Not applicable')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /87.5%/i })).not.toBeInTheDocument();
  });

  it('locks grade and question editors when an ended quiz has remaining extensions', async () => {
    const payload = buildGradesPayload();
    payload.sessions[0].gradingLockReason = 'extensions';
    payload.rows[0].grades[0].gradingLockReason = 'extensions';
    apiClient.get.mockImplementation(async (url) => ({ data: url.includes('/results')
      ? { questions: [{ _id: 'q-sa', type: 2, content: 'Explain', sessionOptions: { points: 1 } }], studentResults: [] }
      : payload }));
    render(<CourseGradesPanel courseId="course-1" instructorView availableSessions={payload.sessions} />);
    await openInstructorGradeTable();
    fireEvent.click(screen.getByRole('button', { name: /87.5%/i }));
    expect(await screen.findByRole('button', { name: i18n.t('grades.coursePanel.saveGradeValue') })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Q2(SA)' }));
    expect(await screen.findByRole('button', { name: 'Save Mark' })).toBeDisabled();
    expect(screen.getByLabelText('Manual points')).toBeDisabled();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('labels non-auto-gradeable mark rows as manual only in the grade detail modal', async () => {
    render(
      <CourseGradesPanel
        courseId="course-1"
        instructorView
        availableSessions={[{ _id: 'session-1', name: 'Week 1', marksNeedingGrading: 5, autoGradeableQuestionIds: ['q-mc'] }]}
      />
    );

    await openInstructorGradeTable();

    fireEvent.click(screen.getByRole('button', { name: /87.5%/i }));
    await screen.findByText(/manual only/i);
    expect(screen.getByText(/^graded$/i)).toBeInTheDocument();
  });

  it('opens the nested question detail dialog with the latest response and student identity details', async () => {
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/courses/course-1/grades') {
        return { data: buildGradesPayload() };
      }
      if (url === '/sessions/session-1/results') {
        return {
          data: {
            questions: [
              {
                _id: 'q-mc',
                type: 0,
                content: '<p>MC question</p>',
                plainText: 'MC question',
                options: [
                  { answer: 'A', plainText: 'A', correct: true },
                  { answer: 'B', plainText: 'B', correct: false },
                ],
              },
              {
                _id: 'q-sa',
                type: 2,
                content: '<p>Explain your reasoning</p>',
                plainText: 'Explain your reasoning',
                sessionOptions: { points: 1 },
              },
            ],
            studentResults: [
              {
                studentId: 'student-1',
                questionResults: [
                  {
                    questionId: 'q-sa',
                    responses: [
                      {
                        attempt: 1,
                        answer: 'Because the derivative is positive.',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    render(
      <CourseGradesPanel
        courseId="course-1"
        instructorView
        availableSessions={[{ _id: 'session-1', name: 'Week 1', marksNeedingGrading: 5, autoGradeableQuestionIds: ['q-mc'] }]}
      />
    );

    await openInstructorGradeTable();
    expect(screen.getByText('ada@example.edu')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /87.5%/i }));
    await screen.findByText(/manual only/i);
    expect(screen.getByRole('button', { name: /q1\(mc\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /q2\(sa\)/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /q2\(sa\)/i }));
    const questionDialog = await screen.findByRole('dialog', { name: /week 1\s*\/\s*q2/i });

    expect(await within(questionDialog).findByText(/because the derivative is positive\./i)).toBeInTheDocument();
    expect(within(questionDialog).getByText('Q2(SA)')).toBeInTheDocument();
    expect(within(questionDialog).getByText(/explain your reasoning/i)).toBeInTheDocument();
    expect(within(questionDialog).getAllByText(/short answer/i).length).toBeGreaterThan(0);
    expect(within(questionDialog).getByRole('button', { name: /save mark/i })).toBeInTheDocument();
  });

  it('saves updated manual points from the nested question detail dialog', async () => {
    apiClient.get.mockImplementation(async (url) => {
      if (url === '/courses/course-1/grades') {
        return { data: buildGradesPayload() };
      }
      if (url === '/sessions/session-1/results') {
        return {
          data: {
            questions: [
              {
                _id: 'q-sa',
                type: 2,
                content: '<p>Explain your reasoning</p>',
                plainText: 'Explain your reasoning',
                sessionOptions: { points: 1 },
              },
            ],
            studentResults: [
              {
                studentId: 'student-1',
                questionResults: [
                  {
                    questionId: 'q-sa',
                    responses: [
                      {
                        attempt: 1,
                        answer: 'Because the derivative is positive.',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected GET ${url}`);
    });

    render(
      <CourseGradesPanel
        courseId="course-1"
        instructorView
        availableSessions={[{ _id: 'session-1', name: 'Week 1', marksNeedingGrading: 5, autoGradeableQuestionIds: ['q-mc'] }]}
      />
    );

    await openInstructorGradeTable();
    fireEvent.click(screen.getByRole('button', { name: /87.5%/i }));
    await screen.findByText(/manual only/i);
    fireEvent.click(screen.getByRole('button', { name: /q2\(sa\)/i }));
    const questionDialog = await screen.findByRole('dialog', { name: /week 1\s*\/\s*q2/i });

    fireEvent.change(within(questionDialog).getByLabelText(/manual points/i), { target: { value: '0.5' } });
    fireEvent.click(within(questionDialog).getByRole('button', { name: /save mark/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith('/grades/grade-1/marks/q-sa', {
        points: 0.5,
        feedback: '',
      });
    });
    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledTimes(3);
    });
  });

  it('does not mark zero-point questions as needing grading in the grade detail modal', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        ...buildGradesPayload(),
        rows: [
          {
            ...buildGradesPayload().rows[0],
            grades: [
              {
                ...buildGradesPayload().rows[0].grades[0],
                marks: [
                  {
                    questionId: 'q-sa',
                    questionType: 2,
                    points: 0,
                    outOf: 0,
                    automatic: false,
                    needsGrading: true,
                    attempt: 1,
                    feedback: '',
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    render(
      <CourseGradesPanel
        courseId="course-1"
        instructorView
        availableSessions={[{ _id: 'session-1', name: 'Week 1', marksNeedingGrading: 1, autoGradeableQuestionIds: [] }]}
      />
    );

    await openInstructorGradeTable();
    fireEvent.click(screen.getByRole('button', { name: /87.5%/i }));

    const manualOnlyChip = await screen.findByText(/manual only/i);
    const questionRow = screen.getByRole('button', { name: /q1\(sa\)/i }).closest('tr');
    expect(manualOnlyChip).toBeInTheDocument();
    expect(questionRow).toBeTruthy();
    expect(within(questionRow).queryByText(/^needs grading$/i)).not.toBeInTheDocument();
  });
});

it('flags sessions without grade items and offers a graded-only selection without preventing manual inclusion', async () => {
  vi.clearAllMocks();
  const payload = buildGradesPayload();
  apiClient.get.mockResolvedValue({ data: payload });
  render(<CourseGradesPanel courseId="course-1" instructorView
    availableSessions={[
      { _id: 'session-1', name: 'Week 1' },
      { _id: 'empty', name: 'Draft without grades', status: 'hidden' },
      { _id: 'survey', name: 'Anonymous survey', anonymous: true },
    ]}
    gradingSummaryBySessionId={{ 'session-1': { hasGradeItems: true }, empty: { hasGradeItems: false } }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Show Grade Table' }));
  const dialog = await screen.findByRole('dialog', { name: /select sessions for grade table/i });
  expect(within(dialog).getByText('No grade items')).toBeInTheDocument();
  expect(within(dialog).queryByText('Anonymous survey')).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByText('Draft without grades'));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Select sessions with grade items' }));
  expect(within(dialog).getByRole('checkbox', { name: 'Toggle selection for Week 1' })).toBeChecked();
  expect(within(dialog).getByRole('checkbox', { name: 'Toggle selection for Draft without grades' })).not.toBeChecked();
  fireEvent.click(within(dialog).getByText('Draft without grades'));
  expect(within(dialog).getByRole('checkbox', { name: 'Toggle selection for Draft without grades' })).toBeChecked();
  apiClient.get.mockResolvedValue({ data: payload });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Show Table' }));
  await waitForElementToBeRemoved(dialog);
  expect(apiClient.get).toHaveBeenCalledWith('/courses/course-1/grades', { params: { sessionIds: 'session-1,empty' } });
  expect(screen.getByRole('columnheader', { name: /avg. grade/i })).toBeInTheDocument();
});

it('loads grade-item availability when no session options are supplied', async () => {
  vi.clearAllMocks();
  const payload = buildGradesPayload();
  payload.sessions[0].hasGradeItems = true;
  apiClient.get.mockResolvedValue({ data: payload });
  render(<CourseGradesPanel courseId="course-1" instructorView />);
  await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith('/courses/course-1/grades'));
  fireEvent.click(screen.getByRole('button', { name: 'Show Grade Table' }));
  const dialog = await screen.findByRole('dialog', { name: /select sessions for grade table/i });
  expect(within(dialog).getByRole('button', { name: 'Select sessions with grade items' })).toBeEnabled();
});
