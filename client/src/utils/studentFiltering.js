function normalizeSearchValue(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

export function filterStudentsByIdentity(students = [], query = '') {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return students;

  return students.filter((student) => {
    const searchableIdentity = [
      student?.firstname,
      student?.lastname,
      student?.displayName,
      student?.email,
      `${student?.firstname || ''} ${student?.lastname || ''}`,
    ]
      .map(normalizeSearchValue)
      .filter(Boolean);
    return searchableIdentity.some((value) => value.includes(normalizedQuery));
  });
}
