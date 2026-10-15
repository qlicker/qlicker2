import { describe, expect, it } from 'vitest';
import { getStudentSessionAction, sortSessions } from '../../utils/studentSessions';

describe('getStudentSessionAction', () => {
  it('opens a waiting page for upcoming interactive sessions, while upcoming quizzes stay closed', () => {
    expect(getStudentSessionAction({ _id: 'upcoming', status: 'visible', quiz: false }, 'course-1')).toMatchObject({
      clickable: true, path: '/student/course/course-1/session/upcoming/live', label: 'student.course.openWaitingPage',
    });
    expect(getStudentSessionAction({ _id: 'quiz', status: 'visible', quiz: true }, 'course-1').clickable).toBe(false);
    expect(getStudentSessionAction({ _id: 'draft', status: 'hidden', quiz: false }, 'course-1').clickable).toBe(false);
  });

  it('shows start quiz when a running quiz has no saved responses', () => {
    const action = getStudentSessionAction({
      _id: 'session-1',
      quiz: true,
      status: 'running',
      quizHasResponsesByCurrentUser: false,
      quizAllQuestionsAnsweredByCurrentUser: false,
    }, 'course-1', 1);

    expect(action).toEqual({
      clickable: true,
      path: '/student/course/course-1/session/session-1/quiz',
      label: 'student.course.startQuiz',
      chipColor: 'primary',
      chipVariant: 'filled',
    });
  });

  it('shows resume quiz in red when a running quiz already has saved responses', () => {
    const action = getStudentSessionAction({
      _id: 'session-1',
      quiz: true,
      status: 'running',
      quizHasResponsesByCurrentUser: true,
      quizAllQuestionsAnsweredByCurrentUser: false,
    }, 'course-1', 1);

    expect(action).toEqual({
      clickable: true,
      path: '/student/course/course-1/session/session-1/quiz',
      label: 'student.course.resumeQuiz',
      chipColor: 'error',
      chipVariant: 'filled',
    });
  });

  it('shows submit quiz in red when all quiz questions already have responses', () => {
    const action = getStudentSessionAction({
      _id: 'session-1',
      quiz: true,
      status: 'running',
      quizHasResponsesByCurrentUser: true,
      quizAllQuestionsAnsweredByCurrentUser: true,
    }, 'course-1', 1);

    expect(action).toEqual({
      clickable: true,
      path: '/student/course/course-1/session/session-1/quiz',
      label: 'student.course.submitQuiz',
      chipColor: 'error',
      chipVariant: 'filled',
    });
  });

  it('greys out a submitted live quiz', () => {
    const action = getStudentSessionAction({
      _id: 'session-1',
      quiz: true,
      status: 'running',
      quizSubmittedByCurrentUser: true,
      practiceQuiz: false,
    }, 'course-1', 1);

    expect(action).toEqual({
      clickable: false,
      path: '',
      label: 'student.course.quizSubmitted',
      chipColor: 'default',
      chipVariant: 'outlined',
    });
  });

  it('opens owned practice sessions even when they are not live quizzes', () => {
    const action = getStudentSessionAction({
      _id: 'practice-1',
      quiz: true,
      practiceQuiz: true,
      studentCreated: true,
      status: 'hidden',
      questions: ['q-1'],
      quizHasResponsesByCurrentUser: false,
      quizAllQuestionsAnsweredByCurrentUser: false,
    }, 'course-1', 2);

    expect(action).toEqual({
      clickable: true,
      path: '/student/course/course-1/session/practice-1/review?returnTab=2',
      label: 'student.course.review',
      chipColor: 'success',
      chipVariant: 'outlined',
    });
  });
});

describe('sortSessions', () => {
  it('keeps unsubmitted live quizzes ahead of submitted live quizzes', () => {
    const sorted = sortSessions([
      {
        _id: 'submitted',
        quiz: true,
        status: 'running',
        quizSubmittedByCurrentUser: true,
        quizStart: '2026-03-13T11:00:00.000Z',
      },
      {
        _id: 'open',
        quiz: true,
        status: 'running',
        quizSubmittedByCurrentUser: false,
        quizStart: '2026-03-13T10:00:00.000Z',
      },
    ]);

    expect(sorted.map((session) => session._id)).toEqual(['open', 'submitted']);
  });
});
