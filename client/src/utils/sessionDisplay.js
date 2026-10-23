import { formatDisplayDate, formatDisplayDateTime } from './date';
import { getSessionSortTime, isQuizSession } from './studentSessions';

export function getSessionTimingText(session, t, now = Date.now()) {
  const timestamp = getSessionSortTime(session, now);
  if (timestamp <= 0) return '';

  if (!isQuizSession(session)) {
    return formatDisplayDate(timestamp);
  }

  const dateTime = formatDisplayDateTime(timestamp);
  const status = session?.status;

  if (status === 'running') {
    return t('sessionTiming.quizEndsAt', {
      dateTime,
      defaultValue: `Quiz ends at: ${dateTime}`,
    });
  }

  if (status === 'done') {
    return t('sessionTiming.quizEndedAt', {
      dateTime,
      defaultValue: `Quiz ended at: ${dateTime}`,
    });
  }

  return t('sessionTiming.quizStartsAt', {
    dateTime,
    defaultValue: `Quiz starts at: ${dateTime}`,
  });
}
