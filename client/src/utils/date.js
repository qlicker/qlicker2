import i18n from '../i18n';
import { DEFAULT_DATE_FORMAT } from '../i18n';

const FALLBACK_LOCALE = 'en';
const MONTH_SHORT_CACHE = new Map();

function getSupportedLocale(lang) {
  if (!lang) return FALLBACK_LOCALE;

  try {
    return Intl.DateTimeFormat.supportedLocalesOf([lang])[0] || FALLBACK_LOCALE;
  } catch {
    return FALLBACK_LOCALE;
  }
}

function getMonthShort(lang) {
  const locale = getSupportedLocale(lang);
  if (MONTH_SHORT_CACHE.has(locale)) {
    return MONTH_SHORT_CACHE.get(locale);
  }

  const formatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    timeZone: 'UTC',
  });
  const months = Array.from({ length: 12 }, (_, index) => (
    formatter.format(new Date(Date.UTC(2026, index, 1)))
  ));

  MONTH_SHORT_CACHE.set(locale, months);
  return months;
}

/**
 * Return the active date-format key.
 * Checks localStorage first (set via admin panel), falls back to DEFAULT_DATE_FORMAT.
 */
export function getDateFormat() {
  try {
    return localStorage.getItem('qlicker_dateFormat') || DEFAULT_DATE_FORMAT;
  } catch {
    return DEFAULT_DATE_FORMAT;
  }
}

export function getTimeFormat() {
  try {
    return localStorage.getItem('qlicker_timeFormat') || '24h';
  } catch {
    return '24h';
  }
}

/**
 * Format a date value using the active locale and date-format preference.
 *
 * Supported format keys:
 *   DD-MMM-YYYY  → 11-Jan-2026 (default)
 *   MMM-DD-YYYY  → Jan-11-2026
 *   YYYY-MM-DD   → 2026-01-11
 *
 * The clock always uses 24-hour format (HH:mm) when a time is displayed.
 */
export function formatDisplayDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const lang = i18n.language || FALLBACK_LOCALE;
  const months = getMonthShort(lang);
  const day = String(date.getDate()).padStart(2, '0');
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  const fmt = getDateFormat();

  switch (fmt) {
    case 'MMM-DD-YYYY':
      return `${month}-${day}-${year}`;
    case 'YYYY-MM-DD':
      return `${year}-${String(date.getMonth() + 1).padStart(2, '0')}-${day}`;
    case 'DD-MMM-YYYY':
    default:
      return `${day}-${month}-${year}`;
  }
}

/**
 * Format a date-time value including the 24-hour clock.
 * Example: "11-Jan-2026 14:30"
 */
export function formatDisplayDateTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const datePart = formatDisplayDate(date);
  if (getTimeFormat() === '12h') {
    const localizedTime = new Intl.DateTimeFormat(getSupportedLocale(i18n.language), {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date);
    return `${datePart} ${localizedTime}`;
  }

  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${datePart} ${hours}:${minutes}`;
}
