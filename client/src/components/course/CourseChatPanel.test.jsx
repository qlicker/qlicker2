import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CourseChatPanel from './CourseChatPanel';
import apiClient from '../../api/client';
import i18n from '../../i18n';

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../questions/StudentRichTextEditor', () => ({
  default: ({ value, onChange, placeholder, ariaLabel }) => (
    <textarea
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange({ html: event.target.value })}
    />
  ),
}));

vi.mock('../questions/richTextUtils', () => ({
  extractPlainTextFromHtml: (html = '') => {
    const input = String(html);
    let insideTag = false;
    let plain = '';
    for (const character of input) {
      if (character === '<') {
        insideTag = true;
        continue;
      }
      if (character === '>') {
        insideTag = false;
        continue;
      }
      if (!insideTag) plain += character;
    }
    return plain.trim();
  },
  prepareRichTextInput: (html = '', fallback = '') => html || fallback || '',
  renderKatexInElement: () => {},
}));

describe('CourseChatPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    i18n.changeLanguage('en');
    apiClient.get.mockResolvedValue({
      data: {
        canPost: true,
        canVote: true,
        canDeleteOwnPost: true,
        canDeleteAnyPost: false,
        canDeleteOwnComment: true,
        canDeleteAnyComment: false,
        canArchive: false,
        canUnarchive: false,
        canViewNames: false,
        availableTags: [
          { value: 'homework', label: 'Homework' },
        ],
        posts: [],
      },
    });
    apiClient.post.mockResolvedValue({ data: { success: true } });
    apiClient.patch.mockResolvedValue({ data: { success: true } });
    apiClient.delete.mockResolvedValue({ data: { success: true } });
  });

  it('loads chat and submits a new post with topic and content', async () => {
    render(
      <CourseChatPanel
        courseId="course-1"
        enabled
        role="student"
        refreshToken={0}
      />
    );

    expect(await screen.findByText('No posts yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New post' }));
    fireEvent.change(screen.getByLabelText('Post topic'), { target: { value: 'Midterm help' } });
    fireEvent.change(screen.getByLabelText('Course chat post editor'), { target: { value: '<p>Please review question 2</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish post' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/courses/course-1/chat/posts', {
        title: 'Midterm help',
        body: 'Please review question 2',
        bodyWysiwyg: '<p>Please review question 2</p>',
        tags: [],
      });
    });
  });

  it('lets an author edit their own post', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        canPost: true,
        canVote: true,
        canDeleteOwnPost: true,
        canDeleteAnyPost: false,
        canDeleteOwnComment: true,
        canDeleteAnyComment: false,
        canArchive: false,
        canUnarchive: false,
        canViewNames: false,
        availableTags: [],
        posts: [{
          _id: 'post-own',
          title: 'Original topic',
          body: 'Original body',
          bodyWysiwyg: '<p>Original body</p>',
          createdAt: '2026-04-10T10:00:00.000Z',
          upvoteCount: 0,
          isOwnPost: true,
          isArchived: false,
          authorRole: 'student',
          comments: [],
        }],
      },
    });

    render(<CourseChatPanel courseId="course-1" enabled role="student" refreshToken={0} />);

    expect(await screen.findByText('Original topic')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Edit post'));
    fireEvent.change(screen.getByLabelText('Post topic'), { target: { value: 'Revised topic' } });
    fireEvent.change(screen.getByLabelText('Edit course chat post'), { target: { value: '<p>Revised body</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith('/courses/course-1/chat/posts/post-own', {
        title: 'Revised topic',
        body: 'Revised body',
        bodyWysiwyg: '<p>Revised body</p>',
      });
    });
  });

  it('keeps the professor composer hidden by default and hides course tags when none exist', async () => {
    apiClient.get.mockResolvedValueOnce({
      data: {
        canPost: true,
        canVote: false,
        canDeleteOwnPost: false,
        canDeleteAnyPost: true,
        canDeleteOwnComment: false,
        canDeleteAnyComment: true,
        canArchive: false,
        canUnarchive: false,
        canViewNames: true,
        availableTags: [],
        posts: [],
      },
    });

    render(<CourseChatPanel courseId="course-1" enabled role="professor" refreshToken={0} />);

    expect(await screen.findByText('No posts yet.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Course chat post editor')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Course Tags')).not.toBeInTheDocument();
    expect(screen.queryByText('Students see instructor messages as coming from the instructor role rather than by name.')).not.toBeInTheDocument();
  });

  it('sorts by time by default, can sort by upvotes, and reveals archived posts for professors', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        canPost: true,
        canVote: false,
        canDeleteOwnPost: false,
        canDeleteAnyPost: true,
        canDeleteOwnComment: false,
        canDeleteAnyComment: true,
        canArchive: true,
        canUnarchive: true,
        canViewNames: true,
        availableTags: [],
        posts: [
          {
            _id: 'post-new',
            title: 'Newest post',
            body: 'Body',
            bodyWysiwyg: '<p>Body</p>',
            createdAt: '2026-04-10T10:00:00.000Z',
            upvoteCount: 1,
            isOwnPost: false,
            isArchived: false,
            authorRole: 'student',
            comments: [],
          },
          {
            _id: 'post-top',
            title: 'Top voted post',
            body: 'Body',
            bodyWysiwyg: '<p>Body</p>',
            createdAt: '2026-04-09T10:00:00.000Z',
            upvoteCount: 5,
            isOwnPost: false,
            isArchived: false,
            authorRole: 'student',
            comments: [],
          },
          {
            _id: 'post-archived',
            title: 'Archived post',
            body: 'Body',
            bodyWysiwyg: '<p>Body</p>',
            createdAt: '2026-04-08T10:00:00.000Z',
            upvoteCount: 2,
            isOwnPost: false,
            isArchived: true,
            archivedAt: '2026-04-11T10:00:00.000Z',
            authorRole: 'student',
            comments: [],
          },
        ],
      },
    });

    const { container } = render(<CourseChatPanel courseId="course-1" enabled role="professor" refreshToken={0} />);

    expect(await screen.findByText('Newest post')).toBeInTheDocument();
    expect(screen.queryByText('Archived post')).not.toBeInTheDocument();
    expect([...container.querySelectorAll('h6')].map((node) => node.textContent)).toEqual([
      'Course Chat',
      'Newest post',
      'Top voted post',
    ]);

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Sort posts by' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Most upvotes' }));
    expect([...container.querySelectorAll('h6')].map((node) => node.textContent)).toEqual([
      'Course Chat',
      'Top voted post',
      'Newest post',
    ]);

    fireEvent.click(screen.getByLabelText('Show archived posts'));
    expect(await screen.findByText('Archived post')).toBeInTheDocument();
    expect(screen.getByLabelText('Unarchive post')).toBeInTheDocument();
  });
});
