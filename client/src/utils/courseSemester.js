import i18n from '../i18n';

export const SEMESTER_OPTIONS = [
  i18n.t('semesters.fall'),
  i18n.t('semesters.winter'),
  i18n.t('semesters.fallWinter'),
  i18n.t('semesters.spring'),
  i18n.t('semesters.summer'),
  i18n.t('semesters.springSummer'),
];

export function getYearOptions(now = new Date()) {
  const currentYear = now.getFullYear();
  const previousYear = currentYear - 1;
  const nextYear = currentYear + 1;
  return [
    String(previousYear),
    `${previousYear}/${currentYear}`,
    String(currentYear),
    `${currentYear}/${nextYear}`,
    String(nextYear),
  ];
}

export function parseSemester(semester) {
  const normalized = String(semester || '').trim();
  if (!normalized) {
    return { season: SEMESTER_OPTIONS[0], year: '' };
  }

  const matchedSeason = [...SEMESTER_OPTIONS]
    .sort((a, b) => b.length - a.length)
    .find((candidate) => normalized === candidate || normalized.startsWith(`${candidate} `));

  if (matchedSeason) {
    const year = normalized.slice(matchedSeason.length).trim();
    return { season: matchedSeason, year };
  }

  const firstSpaceIndex = normalized.indexOf(' ');
  if (firstSpaceIndex === -1) {
    return { season: normalized, year: '' };
  }

  return {
    season: normalized.slice(0, firstSpaceIndex).trim(),
    year: normalized.slice(firstSpaceIndex + 1).trim(),
  };
}

export function formatSemester(season, year) {
  const normalizedSeason = String(season || '').trim();
  const normalizedYear = String(year || '').trim();
  if (!normalizedSeason || !normalizedYear) return '';
  return `${normalizedSeason} ${normalizedYear}`;
}
