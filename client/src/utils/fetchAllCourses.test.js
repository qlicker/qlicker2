import { describe, expect, it, vi } from 'vitest';
import { fetchAllCourses } from './fetchAllCourses';

describe('fetchAllCourses', () => {
  it('collects every page of courses using the server page metadata', async () => {
    const apiClient = {
      get: vi.fn()
        .mockResolvedValueOnce({
          data: {
            courses: [{ _id: 'course-1' }, { _id: 'course-2' }],
            total: 3,
            page: 1,
            pages: 2,
          },
        })
        .mockResolvedValueOnce({
          data: {
            courses: [{ _id: 'course-3' }],
            total: 3,
            page: 2,
            pages: 2,
          },
        }),
    };

    const courses = await fetchAllCourses(apiClient, { view: 'student' });

    expect(courses).toEqual([
      { _id: 'course-1' },
      { _id: 'course-2' },
      { _id: 'course-3' },
    ]);
    expect(apiClient.get).toHaveBeenNthCalledWith(1, '/courses', {
      params: { view: 'student', page: 1, limit: 500 },
    });
    expect(apiClient.get).toHaveBeenNthCalledWith(2, '/courses', {
      params: { view: 'student', page: 2, limit: 500 },
    });
  });

  it('forwards an abort signal to every paginated request', async () => {
    const signal = new AbortController().signal;
    const apiClient = {
      get: vi.fn().mockResolvedValue({
        data: {
          courses: [{ _id: 'course-1' }],
          total: 1,
          page: 1,
          pages: 1,
        },
      }),
    };

    await fetchAllCourses(apiClient, { view: 'instructor' }, { signal });

    expect(apiClient.get).toHaveBeenCalledWith('/courses', {
      params: { view: 'instructor', page: 1, limit: 500 },
      signal,
    });
  });
});
