import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QuestionLibraryPanel from './QuestionLibraryPanel';

const {
  apiClientMock,
  tMock,
  requestCloseMock,
  authState,
  questionEditorPropsMock,
} = vi.hoisted(() => ({
  apiClientMock: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  tMock: vi.fn((key, options) => options?.defaultValue ?? key),
  requestCloseMock: vi.fn(),
  authState: { user: { _id: 'prof-1', roles: ['professor'] } },
  questionEditorPropsMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: tMock,
  }),
}));

vi.mock('../../api/client', () => ({
  default: apiClientMock,
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('./QuestionDisplay', () => ({
  default: ({ question }) => <div>{question?.content || ''}</div>,
}));

vi.mock('./QuestionEditor', () => ({
  default: function MockQuestionEditor({ ref, ...props }) {
    React.useImperativeHandle(ref, () => ({
      requestClose: requestCloseMock,
    }));
    questionEditorPropsMock(props);
    return <div>Mock Question Editor</div>;
  },
}));

describe('QuestionLibraryPanel', () => {
  beforeEach(() => {
    apiClientMock.get.mockReset();
    apiClientMock.post.mockReset();
    apiClientMock.patch.mockReset();
    apiClientMock.delete.mockReset();
    tMock.mockClear();
    requestCloseMock.mockReset();
    questionEditorPropsMock.mockReset();
    authState.user = { _id: 'prof-1', roles: ['professor'] };

    apiClientMock.get.mockImplementation((url) => {
      if (url === '/courses') {
        return Promise.resolve({
          data: {
            courses: [
              { _id: 'course-1', name: 'Course One', instructors: ['prof-1'] },
            ],
          },
        });
      }

      if (url === '/courses/course-1/sessions') {
        return Promise.resolve({
          data: {
            sessions: [
              { _id: 'session-1', name: 'Session One', status: 'hidden' },
              { _id: 'practice-1', name: 'Practice One', status: 'hidden', studentCreated: true, practiceQuiz: true },
            ],
          },
        });
      }

      if (url === '/courses/course-1/question-tags?limit=100') {
        return Promise.resolve({
          data: {
            tags: [{ value: 'algebra', label: 'algebra' }],
          },
        });
      }

      if (url.startsWith('/courses/course-1/questions?') && url.includes('idsOnly=true')) {
        return Promise.resolve({
          data: {
            questionIds: ['q1'],
            total: 1,
          },
        });
      }

      if (url.startsWith('/courses/course-1/questions?')) {
        return Promise.resolve({
          data: {
            questions: [
              {
                _id: 'q1',
                type: 2,
                content: 'Library question content',
                owner: 'prof-1',
                approved: false,
                hasResponses: true,
                responseCount: 3,
                linkedSessions: [{ _id: 'session-1', name: 'Session One' }],
                tags: [
                  { value: 'algebra', label: 'algebra' },
                  { value: 'Qlicker', label: 'Qlicker' },
                ],
              },
            ],
            total: 1,
            page: 1,
            limit: 10,
            questionTypes: [2],
          },
        });
      }

      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });
  });

  it('loads course-library questions and supports selecting all filtered matches', async () => {
    render(
      <QuestionLibraryPanel
        courseId="course-1"
        availableSessions={[{ _id: 'session-1', name: 'Session One', status: 'hidden' }]}
      />
    );

    expect(await screen.findByText('Library question content')).toBeInTheDocument();
    expect(screen.getByText('Session One')).toBeInTheDocument();
    expect(screen.getAllByText('Short Answer').length).toBeGreaterThan(0);
    expect(screen.getByText('Has responses')).toBeInTheDocument();
    expect(screen.getByText('3 responses')).toBeInTheDocument();
    expect(screen.getByText('Unapproved')).toBeInTheDocument();
    expect(screen.getByText('algebra')).toBeInTheDocument();
    expect(screen.queryByText('Qlicker')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select all filtered' }));

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith(expect.stringContaining('idsOnly=true'));
    });

    expect(screen.getByRole('button', { name: 'Export JSON' })).not.toBeDisabled();
  });

  it('uses edit and close icons that route closing through the editor close handler', async () => {
    render(
      <QuestionLibraryPanel
        courseId="course-1"
        availableSessions={[{ _id: 'session-1', name: 'Session One', status: 'hidden' }]}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'common.edit' }));
    expect(screen.getByText('Mock Question Editor')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'professor.sessionEditor.closeEditor' }));

    await waitFor(() => {
      expect(requestCloseMock).toHaveBeenCalledTimes(1);
    });
  });

  it('bulk-updates selected question visibility from the library modal', async () => {
    render(
      <QuestionLibraryPanel
        courseId="course-1"
        availableSessions={[{ _id: 'session-1', name: 'Session One', status: 'hidden' }]}
      />
    );

    await screen.findByText('Library question content');

    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Change visibility' }));

    expect(screen.queryByText(/Students normally see session questions by making that session reviewable/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Visible to any prof on Qlicker'));

    expect(screen.getByText(/Students normally see session questions by making that session reviewable/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/questions/bulk-visibility', {
        questionIds: ['q1'],
        public: true,
        publicOnQlicker: true,
        publicOnQlickerForStudents: false,
      });
    });
  });

  it('hides professor-only controls for student libraries', async () => {
    authState.user = { _id: 'student-1', roles: ['student', 'professor'] };

    render(
      <QuestionLibraryPanel
        courseId="course-1"
        currentCourse={{
          _id: 'course-1',
          name: 'Course One',
          instructors: ['prof-1'],
          tags: [{ value: 'algebra', label: 'algebra' }],
        }}
        availableSessions={[{ _id: 'practice-1', name: 'Practice One', studentCreated: true, practiceQuiz: true }]}
        allowQuestionCreate
        permissionMode="student"
      />
    );

    await screen.findByText('Library question content');

    expect(screen.queryByRole('button', { name: 'Approve question' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change visibility' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import JSON' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common.edit' })).not.toBeInTheDocument();
    expect(screen.queryByText('Has responses')).not.toBeInTheDocument();
    expect(screen.queryByText('3 responses')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'Copy to practice session' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole('button', { name: 'New question' }));

    expect(questionEditorPropsMock).toHaveBeenCalledWith(expect.objectContaining({
      showVisibilityControls: false,
      allowCustomTags: false,
    }));
  });

  it('disables student delete actions for questions they do not own', async () => {
    authState.user = { _id: 'student-1', roles: ['student'] };

    render(
      <QuestionLibraryPanel
        courseId="course-1"
        currentCourse={{ _id: 'course-1', name: 'Course One', instructors: ['prof-1'] }}
        availableSessions={[{ _id: 'practice-1', name: 'Practice One', studentCreated: true, practiceQuiz: true }]}
        allowQuestionCreate
        permissionMode="student"
      />
    );

    await screen.findByText('Library question content');

    const deleteButtons = screen.getAllByRole('button', { name: 'common.delete' });
    expect(deleteButtons[0]).toBeDisabled();
  });

  it('shows student edit and copy controls for manageable owned questions and disables mixed delete selections', async () => {
    authState.user = { _id: 'student-1', roles: ['student'] };
    apiClientMock.get.mockImplementation((url) => {
      if (url.startsWith('/courses/course-1/questions?') && !url.includes('idsOnly=true')) {
        return Promise.resolve({
          data: {
            questions: [
              {
                _id: 'q-owned',
                type: 2,
                content: 'Owned draft question',
                owner: 'student-1',
                approved: false,
                hasResponses: false,
                responseCount: 0,
                linkedSessions: [],
                tags: [{ value: 'algebra', label: 'algebra' }],
              },
              {
                _id: 'q-shared',
                type: 2,
                content: 'Shared session question',
                owner: 'prof-1',
                approved: true,
                hasResponses: true,
                responseCount: 2,
                linkedSessions: [{ _id: 'session-1', name: 'Session One' }],
                tags: [{ value: 'algebra', label: 'algebra' }],
              },
            ],
            total: 2,
            page: 1,
            limit: 10,
            questionTypes: [2],
          },
        });
      }

      if (url.startsWith('/courses/course-1/questions?') && url.includes('idsOnly=true')) {
        return Promise.resolve({
          data: {
            questionIds: ['q-owned', 'q-shared'],
            total: 2,
          },
        });
      }

      if (url === '/courses/course-1/sessions') {
        return Promise.resolve({
          data: {
            sessions: [{ _id: 'practice-1', name: 'Practice One', studentCreated: true, practiceQuiz: true }],
          },
        });
      }

      if (url === '/courses/course-1/question-tags?limit=100') {
        return Promise.resolve({
          data: {
            tags: [{ value: 'algebra', label: 'algebra' }],
          },
        });
      }

      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    render(
      <QuestionLibraryPanel
        courseId="course-1"
        currentCourse={{ _id: 'course-1', name: 'Course One', instructors: ['prof-1'] }}
        availableSessions={[{ _id: 'practice-1', name: 'Practice One', studentCreated: true, practiceQuiz: true }]}
        allowQuestionCreate
        permissionMode="student"
      />
    );

    const ownedCard = (await screen.findByText('Owned draft question')).closest('.MuiCard-root');
    const sharedCard = screen.getByText('Shared session question').closest('.MuiCard-root');

    expect(ownedCard).not.toBeNull();
    expect(sharedCard).not.toBeNull();

    expect(within(ownedCard).getByRole('button', { name: 'common.edit' })).toBeInTheDocument();
    expect(within(sharedCard).queryByRole('button', { name: 'common.edit' })).not.toBeInTheDocument();
    expect(within(ownedCard).getByRole('button', { name: 'Copy to practice session' })).toBeInTheDocument();
    expect(within(sharedCard).getByRole('button', { name: 'Copy to practice session' })).toBeInTheDocument();
    expect(within(sharedCard).getByRole('button', { name: 'common.delete' })).toBeDisabled();
    expect(screen.queryByText('Has responses')).not.toBeInTheDocument();
    expect(screen.queryByText('2 responses')).not.toBeInTheDocument();

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    expect(screen.getAllByRole('button', { name: 'common.delete' })[0]).toBeEnabled();

    fireEvent.click(checkboxes[2]);
    expect(screen.getAllByRole('button', { name: 'common.delete' })[0]).toBeDisabled();
  });

  it('hides student practice-session copy actions when no practice sessions exist', async () => {
    authState.user = { _id: 'student-1', roles: ['student', 'professor'] };

    render(
      <QuestionLibraryPanel
        courseId="course-1"
        currentCourse={{ _id: 'course-1', name: 'Course One', instructors: ['prof-1'] }}
        availableSessions={[]}
        allowQuestionCreate
        permissionMode="student"
      />
    );

    const questionCard = (await screen.findByText('Library question content')).closest('.MuiCard-root');

    expect(screen.queryByRole('button', { name: 'Copy to practice session' })).not.toBeInTheDocument();
    expect(questionCard).not.toBeNull();
    expect(within(questionCard).queryByRole('button', { name: 'Copy to practice session' })).not.toBeInTheDocument();
  });
});
