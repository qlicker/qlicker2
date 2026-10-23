import { beforeEach, describe, expect, it } from 'vitest';
import { getSessionTimingText } from './sessionDisplay';
import { formatDisplayDate, formatDisplayDateTime } from './date';

describe('getSessionTimingText', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('qlicker_dateFormat', 'YYYY-MM-DD');
    localStorage.setItem('qlicker_timeFormat', '24h');
  });

  it('shows the quiz start date and time for upcoming quizzes', () => {
    const expectedDateTime = formatDisplayDateTime('2026-03-29T13:45:00.000Z');
    const text = getSessionTimingText({
      quiz: true,
      status: 'visible',
      quizStart: '2026-03-29T13:45:00.000Z',
    }, (key, values) => `${key}:${values.dateTime}`, '2026-03-29T12:45:00.000Z');

    expect(text).toBe(`sessionTiming.quizStartsAt:${expectedDateTime}`);
  });

  it('shows the quiz end date and time for live quizzes', () => {
    const expectedDateTime = formatDisplayDateTime('2026-03-29T15:00:00.000Z');
    const text = getSessionTimingText({
      quiz: true,
      status: 'running',
      quizEnd: '2026-03-29T15:00:00.000Z',
    }, (key, values) => `${key}:${values.dateTime}`, '2026-03-29T14:00:00.000Z');

    expect(text).toBe(`sessionTiming.quizEndsAt:${expectedDateTime}`);
  });

  it('keeps a manually opened quiz live even before its scheduled start', () => {
    const expectedDateTime = formatDisplayDateTime('2026-03-29T15:00:00.000Z');
    const text = getSessionTimingText({
      quiz: true,
      status: 'running',
      quizStart: '2026-03-29T13:45:00.000Z',
      quizEnd: '2026-03-29T15:00:00.000Z',
    }, (key, values) => `${key}:${values.dateTime}`, '2026-03-29T12:00:00.000Z');

    expect(text).toBe(`sessionTiming.quizEndsAt:${expectedDateTime}`);
  });

  it('shows the quiz end date and time for ended quizzes', () => {
    const expectedDateTime = formatDisplayDateTime('2026-03-29T16:15:00.000Z');
    const text = getSessionTimingText({
      quiz: true,
      status: 'done',
      quizEnd: '2026-03-29T16:15:00.000Z',
    }, (key, values) => `${key}:${values.dateTime}`, '2026-03-29T17:00:00.000Z');

    expect(text).toBe(`sessionTiming.quizEndedAt:${expectedDateTime}`);
  });

  it('keeps an upcoming extension visible even after the base deadline', () => {
    const expectedDateTime = formatDisplayDateTime('2026-03-29T13:45:00.000Z');
    const text = getSessionTimingText({
      quiz: true,
      status: 'visible',
      quizStart: '2026-03-29T13:45:00.000Z',
      quizEnd: '2026-03-29T15:00:00.000Z',
    }, (key, values) => `${key}:${values.dateTime}`, '2026-03-29T16:00:00.000Z');

    expect(text).toBe(`sessionTiming.quizStartsAt:${expectedDateTime}`);
  });

  it('does not describe a manually reopened quiz as ended after the scheduled deadline', () => {
    const quizEnd = '2026-03-29T15:00:00.000Z';
    expect(getSessionTimingText({ quiz: true, status: 'running', quizEnd },
      (key) => key, '2026-03-29T16:00:00.000Z')).toBe('sessionTiming.quizEndsAt');
  });

  it('keeps non-quiz sessions on date-only formatting', () => {
    const expectedDate = formatDisplayDate('2026-03-29T16:15:00.000Z');
    const text = getSessionTimingText({
      status: 'visible',
      date: '2026-03-29T16:15:00.000Z',
    }, (key, values) => `${key}:${values.dateTime}`);

    expect(text).toBe(expectedDate);
  });
});
