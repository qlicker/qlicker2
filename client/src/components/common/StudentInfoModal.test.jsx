import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StudentInfoModal from './StudentInfoModal';
import apiClient from '../../api/client';

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, values = {}) => {
      const messages = {
        'common.close': 'Close',
        'common.cancel': 'Cancel',
        'common.loading': 'Loading',
        'common.unknown': 'Unknown',
        'groups.studentInfo': 'Student Info',
        'groups.interactiveSessionsJoined': 'Interactive sessions joined',
        'groups.quizzesCompleted': 'Quizzes completed',
        'groups.avgInteractiveGrade': 'Average interactive grade',
        'groups.avgQuizGrade': 'Average quiz grade',
        'groups.avgParticipation': 'Average participation',
        'groups.fractionValue': `${values.current} / ${values.total}`,
        'groups.groupMembership': 'Group Membership',
        'groups.noStatsAvailable': 'No statistics available',
        'groups.noGroupMembership': 'No group membership',
        'groups.groupMembersTitle': `${values.category} — ${values.group}`,
        'groups.uncategorizedGroup': 'Uncategorized',
        'groups.removeFromCourse': 'Remove from course',
        'groups.confirmRemove': 'Confirm Remove',
        'professor.course.removeStudentConfirm': `Remove ${values.name}?`,
      };
      return messages[key] ?? key;
    },
  }),
}));

describe('StudentInfoModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue({
      data: {
        sessions: [
          { _id: 'interactive-1', quiz: false, practiceQuiz: false, joinedCount: 2 },
          { _id: 'interactive-2', quiz: false, practiceQuiz: false, joinedCount: 1 },
          { _id: 'quiz-1', quiz: true, practiceQuiz: false, status: 'done', joinedCount: 2 },
          { _id: 'empty', quiz: false, joinedCount: 3 },
          { _id: 'quiz-empty', quiz: true, status: 'done' },
          { _id: 'quiz-2', quiz: true, practiceQuiz: false, status: 'visible', joinedCount: 2 },
        ],
        rows: [
          {
            grades: [
              { _id: 'grade-live-1', sessionId: 'interactive-1', joined: true, participation: 80, value: 70, submitted: false },
              { _id: 'grade-quiz-1', sessionId: 'quiz-1', joined: true, participation: 0, value: 90, submitted: true },
              { sessionId: 'empty', hasGradeItem: false, participation: 0, value: 0 },
              { sessionId: 'quiz-empty', hasGradeItem: false, participation: 0, value: 0 },
              { sessionId: 'quiz-2', joined: true, participation: 0, value: 100, submitted: true },
            ],
          },
        ],
      },
    });
  });

  it('shows the requested stats and group members for the selected student', async () => {
    render(
      <StudentInfoModal
        open
        onClose={vi.fn()}
        onRemoved={vi.fn()}
        courseId="course-1"
        student={{
          _id: 'student-1',
          emails: [{ address: 'ada@example.com' }],
          profile: {
            firstname: 'Ada',
            lastname: 'Lovelace',
          },
        }}
        course={{
          students: [
            {
              _id: 'student-1',
              emails: [{ address: 'ada@example.com' }],
              profile: { firstname: 'Ada', lastname: 'Lovelace' },
            },
            {
              _id: 'student-2',
              emails: [{ address: 'grace@example.com' }],
              profile: { firstname: 'Grace', lastname: 'Hopper' },
            },
          ],
          groupCategories: [
            {
              categoryNumber: 1,
              categoryName: 'Lab Teams',
              groups: [
                { name: 'Group A', members: ['student-1', 'student-2'] },
              ],
            },
          ],
        }}
      />
    );

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith('/courses/course-1/grades', {
        params: { studentId: 'student-1' },
      });
    });

    expect(await screen.findAllByText('1 / 2')).toHaveLength(2);
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('90%')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('Group A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove from course' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Group A' }));

    expect(await screen.findByText('Lab Teams — Group A')).toBeInTheDocument();
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(1);
    expect(screen.getByText('grace@example.com')).toBeInTheDocument();
  });
});
