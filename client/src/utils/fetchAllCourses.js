const COURSES_PAGE_SIZE = 500;
const COURSES_FETCH_BATCH_SIZE = 4;

function buildPageParams(params = {}, page, limit) {
  return {
    ...params,
    page,
    limit,
  };
}

function getTotalPages(data, limit, courseCount) {
  const pageCount = Number(data?.pages);
  if (Number.isInteger(pageCount) && pageCount > 0) return pageCount;

  const totalCount = Number(data?.total);
  if (Number.isInteger(totalCount) && totalCount > 0) {
    return Math.max(Math.ceil(totalCount / limit), 1);
  }

  return courseCount > 0 ? 1 : 0;
}

export async function fetchAllCourses(apiClient, params = {}, options = {}) {
  const limit = Math.min(COURSES_PAGE_SIZE, Math.max(1, Number(options.pageSize) || COURSES_PAGE_SIZE));
  const { signal } = options;

  const fetchPage = async (page) => {
    const { data } = await apiClient.get('/courses', {
      params: buildPageParams(params, page, limit),
      signal,
    });
    return data || {};
  };

  const firstPage = await fetchPage(1);
  const allCourses = Array.isArray(firstPage.courses) ? [...firstPage.courses] : [];
  const totalPages = getTotalPages(firstPage, limit, allCourses.length);

  if (totalPages <= 1) return allCourses;

  const remainingPages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);

  for (let index = 0; index < remainingPages.length; index += COURSES_FETCH_BATCH_SIZE) {
    const batchPages = remainingPages.slice(index, index + COURSES_FETCH_BATCH_SIZE);
    const batchResults = await Promise.all(batchPages.map((page) => fetchPage(page)));
    batchResults.forEach((result) => {
      if (Array.isArray(result.courses) && result.courses.length > 0) {
        allCourses.push(...result.courses);
      }
    });
  }

  return allCourses;
}
