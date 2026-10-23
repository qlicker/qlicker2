import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PracticeSessionEditor from './PracticeSessionEditor';

const {
  apiClientMock,
  tMock,
  questionEditorPropsMock,
  questionLibraryPanelPropsMock,
  submitSelectedQuestionsMock,
  submitRandomFilteredQuestionsMock,
} = vi.hoisted(() => ({
  apiClientMock: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
  tMock: vi.fn((key, options) => options?.defaultValue ?? key),
  questionEditorPropsMock: vi.fn(),
  questionLibraryPanelPropsMock: vi.fn(),
  submitSelectedQuestionsMock: vi.fn(),
  submitRandomFilteredQuestionsMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tMock }),
}));

vi.mock('../../api/client', () => ({
  default: apiClientMock,
}));

vi.mock('../../components/common/BackLinkButton', () => ({
  default: ({ label, onClick }) => <button type="button" onClick={onClick}>{label}</button>,
}));

vi.mock('../../components/questions/QuestionDisplay', () => ({
  default: ({ question }) => <div>{question?.content || ''}</div>,
}));

vi.mock('../../components/questions/QuestionEditor', () => ({
  default: function MockQuestionEditor({ ref, ...props }) {
    React.useImperativeHandle(ref, () => ({
      requestClose: vi.fn(),
    }));
    questionEditorPropsMock(props);
    return <div>Mock Question Editor</div>;
  },
}));

vi.mock('../../components/questions/QuestionLibraryPanel', () => ({
  default: function MockQuestionLibraryPanel({ ref, ...props }) {
    React.useImperativeHandle(ref, () => ({
      submitSelectedQuestions: submitSelectedQuestionsMock,
      submitRandomFilteredQuestions: submitRandomFilteredQuestionsMock,
    }));

    React.useEffect(() => {
      props.selectionAction?.onSelectionChange?.(['q1', 'q2']);
    }, [props.selectionAction]);

    questionLibraryPanelPropsMock(props);
    return <div>Mock Question Library Panel</div>;
  },
}));

function renderEditor(initialEntry = '/student/course/course-1/practice-sessions/new') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/student/course/:courseId/practice-sessions/new" element={<PracticeSessionEditor />} />
        <Route path="/student/course/:courseId/practice-sessions/:sessionId" element={<PracticeSessionEditor />} />
        <Route path="/student/course/:courseId/session/:sessionId/review" element={<div>Review destination</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('PracticeSessionEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    apiClientMock.get.mockImplementation((url) => {
      if (url === '/courses/course-1') {
        return Promise.resolve({
          data: {
            course: {
              _id: 'course-1',
              name: 'Course One',
              deptCode: 'CS',
              courseNumber: '101',
              section: '001',
              semester: 'Fall 2026',
              allowStudentQuestions: true,
              tags: [{ value: 'algebra', label: 'algebra' }],
            },
          },
        });
      }

      if (url === '/sessions/session-1') {
        return Promise.resolve({
          data: {
            session: {
              _id: 'session-1',
              name: 'Practice One',
              questions: ['q1', 'q2'],
              tags: [{ value: 'algebra', label: 'algebra' }],
            },
          },
        });
      }

      if (url === '/questions/q1' || url === '/questions/q2') {
        return Promise.resolve({
          data: {
            question: {
              _id: url.endsWith('q1') ? 'q1' : 'q2',
              content: url.endsWith('q1') ? 'Question One' : 'Question Two',
              tags: [{ value: url.endsWith('q1') ? 'Algebra' : 'geometry', label: url.endsWith('q1') ? 'Algebra' : 'geometry' }],
            },
          },
        });
      }

      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });
  });

  it('opens the add-question flow and keeps student question creation private', async () => {
    renderEditor();

    expect(await screen.findByLabelText('Practice session name')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create New' }));

    expect(await screen.findByText('Mock Question Editor')).toBeInTheDocument();
    expect(questionEditorPropsMock).toHaveBeenCalledWith(expect.objectContaining({
      showVisibilityControls: false,
      allowCustomTags: false,
      tagSuggestions: [{ value: 'algebra', label: 'algebra' }],
    }));
  });

  it('shows insertion controls for existing practice questions and saves to review', async () => {
    apiClientMock.patch.mockResolvedValue({ data: {} });

    renderEditor('/student/course/course-1/practice-sessions/session-1');

    expect(await screen.findByText('Question One')).toBeInTheDocument();
    expect(screen.getByText('Question Two')).toBeInTheDocument();
    expect(screen.getAllByText('algebra').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Add question' }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'common.add' })).toBeInTheDocument();

    questionEditorPropsMock.mockClear();
    fireEvent.click(screen.getAllByRole('button', { name: 'common.edit' })[0]);

    expect(questionEditorPropsMock).toHaveBeenCalledWith(expect.objectContaining({
      initial: expect.objectContaining({ _id: 'q1' }),
      showVisibilityControls: false,
      allowCustomTags: false,
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Save and start practice' }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1', {
        name: 'Practice One',
        tags: [{ value: 'algebra', label: 'algebra' }],
      });
      expect(apiClientMock.patch).toHaveBeenCalledWith('/sessions/session-1/practice-questions', {
        questionIds: ['q1', 'q2'],
      });
    });

    expect(await screen.findByText('Review destination')).toBeInTheDocument();
  });

  it('applies practice-session tags to every question in the session', async () => {
    apiClientMock.patch.mockResolvedValue({ data: {} });

    renderEditor('/student/course/course-1/practice-sessions/session-1');

    expect(await screen.findByText('Question One')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Apply tags to all questions' }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/questions/q1', {
        tags: [{ value: 'Algebra', label: 'Algebra' }],
      });
      expect(apiClientMock.patch).toHaveBeenCalledWith('/questions/q2', {
        tags: [
          { value: 'geometry', label: 'geometry' },
          { value: 'algebra', label: 'algebra' },
        ],
      });
    });
  });

  it('offers bottom modal actions to add selected or random library questions', async () => {
    submitSelectedQuestionsMock.mockResolvedValue(undefined);
    submitRandomFilteredQuestionsMock.mockResolvedValue(undefined);

    renderEditor();

    expect(await screen.findByLabelText('Practice session name')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy from Question Library' }));

    expect(await screen.findByText('Mock Question Library Panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add selected questions to practice session' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add selected questions to practice session' }));

    await waitFor(() => {
      expect(submitSelectedQuestionsMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.change(screen.getByLabelText('Random count'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Randomly add 12 questions from the list' }));

    await waitFor(() => {
      expect(submitRandomFilteredQuestionsMock).toHaveBeenCalledWith(12);
    });

    expect(questionLibraryPanelPropsMock).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'student',
      selectionAction: expect.objectContaining({
        hideInlineRandomSelectionControls: true,
      }),
    }));
  });
});
