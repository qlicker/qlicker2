function toText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

export function buildCourseTitle(course = {}, variant = 'long') {
  const name = toText(course?.name);
  const deptCode = toText(course?.deptCode);
  const courseNumber = toText(course?.courseNumber);
  const semester = toText(course?.semester);

  const code = `${deptCode} ${courseNumber}`.trim();
  const shortTitle = code || name || 'Course';
  const mediumTitle = code && name ? `${code}: ${name}` : (name || code || 'Course');
  const longTitle = semester ? `${mediumTitle} (${semester})` : mediumTitle;

  if (variant === 'short') return shortTitle;
  if (variant === 'medium') return mediumTitle;
  return longTitle;
}

export function buildCourseSelectionLabel(course = {}) {
  const shortTitle = buildCourseTitle(course, 'short');
  const section = toText(course?.section);
  const semester = toText(course?.semester);
  const baseTitle = [shortTitle, section].filter(Boolean).join(' · ') || shortTitle;
  return semester ? `${baseTitle} (${semester})` : baseTitle;
}

export function sortCoursesByRecent(courses = []) {
  return [...courses].sort((a, b) => {
    const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (aTime !== bTime) return bTime - aTime;
    return buildCourseSelectionLabel(a).localeCompare(buildCourseSelectionLabel(b));
  });
}
