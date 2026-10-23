function getCourseActivityTimestamp(course) {
  const timestamp = course?.lastActivityAt || course?.updatedAt || course?.createdAt || 0;
  return new Date(timestamp).getTime() || 0;
}

export function sortCoursesByRecentActivity(items = []) {
  return [...items].sort((a, b) => {
    const aActive = a?.inactive ? 1 : 0;
    const bActive = b?.inactive ? 1 : 0;
    if (aActive !== bActive) return aActive - bActive;
    return getCourseActivityTimestamp(b) - getCourseActivityTimestamp(a);
  });
}
