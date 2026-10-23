import { describe, expect, it } from 'vitest';
import {
  getProfessorSessionPrimaryPath,
  sessionCanShowListReviewAction,
  sessionCanShowLiveReviewAction,
} from './professorSessions';

describe('professorSessions utils', () => {
  it('routes ended sessions to review and active sessions to the editor', () => {
    expect(getProfessorSessionPrimaryPath({ _id: 'session-1', status: 'done' }, 'course-1', 1))
      .toBe('/prof/course/course-1/session/session-1/review?returnTab=1');
    expect(getProfessorSessionPrimaryPath({ _id: 'session-2', status: 'visible' }, 'course-1', 0))
      .toBe('/prof/course/course-1/session/session-2?returnTab=0');
    expect(getProfessorSessionPrimaryPath({ _id: 'session-3', status: 'running' }, 'course-1', 2))
      .toBe('/prof/course/course-1/session/session-3/live?returnTab=2');
    expect(getProfessorSessionPrimaryPath({ _id: 'session-4', status: 'running', quiz: true }, 'course-1', 3))
      .toBe('/prof/course/course-1/session/session-4?returnTab=3');
  });

  it('shows the live review action for any running session', () => {
    expect(sessionCanShowLiveReviewAction({ status: 'running', quiz: false })).toBe(true);
    expect(sessionCanShowLiveReviewAction({ status: 'running', quiz: true })).toBe(true);
    expect(sessionCanShowLiveReviewAction({ status: 'done', quiz: true })).toBe(false);
  });

  it('shows the list review action only for draft or upcoming sessions with responses', () => {
    expect(sessionCanShowListReviewAction({ status: 'hidden', hasResponses: true })).toBe(true);
    expect(sessionCanShowListReviewAction({ status: 'visible', hasResponses: true })).toBe(true);
    expect(sessionCanShowListReviewAction({ status: 'visible', hasResponses: false })).toBe(false);
    expect(sessionCanShowListReviewAction({ status: 'done', hasResponses: true })).toBe(false);
    expect(sessionCanShowListReviewAction({ status: 'running', hasResponses: true })).toBe(false);
  });
});
