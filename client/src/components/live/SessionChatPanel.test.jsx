import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SessionChatPanel from './SessionChatPanel';
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
  default: ({ value, onChange, placeholder, ariaLabel, disabled = false }) => (
    <textarea
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange({ html: event.target.value })}
    />
  ),
  MathPreview: () => null,
}));

vi.mock('../questions/richTextUtils', () => ({
  extractPlainTextFromHtml: (html = '') => String(html).replace(/<[^>]*>/g, '').trim(),
  prepareRichTextInput: (html = '', fallback = '') => html || fallback || '',
  renderKatexInElement: () => {},
}));

describe('SessionChatPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    i18n.changeLanguage('en');
    apiClient.get.mockResolvedValue({
      data: {
        canPost: false,
        canVote: true,
        canDeleteOwnPost: false,
        canDismiss: false,
        canComment: false,
        canViewNames: false,
        quickPosts: [],
        posts: [],
      },
    });
    apiClient.patch.mockResolvedValue({ data: { success: true } });
  });

  it('loads chat once on mount and only refetches when refreshToken changes', async () => {
    const { rerender } = render(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="student"
        refreshToken={0}
      />
    );

    expect(await screen.findByText('No posts yet.')).toBeInTheDocument();
    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledTimes(1);
    });
    expect(apiClient.get).toHaveBeenCalledWith('/sessions/session-1/chat', { params: {} });

    rerender(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="student"
        refreshToken={1}
      />
    );

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledTimes(2);
    });
    expect(apiClient.get).toHaveBeenLastCalledWith('/sessions/session-1/chat', { params: {} });
  });

  it('lets students trigger a shared quick post from hidden quick-post options', async () => {
    apiClient.get
      .mockResolvedValueOnce({
        data: {
          canPost: false,
          canVote: true,
          canDeleteOwnPost: false,
          canDismiss: false,
          canComment: false,
          canViewNames: false,
          quickPostOptions: [
            {
              postId: 'quick-3',
              questionNumber: 3,
              label: "I didn't understand question 3",
              upvoteCount: 0,
              viewerHasUpvoted: false,
            },
          ],
          posts: [],
        },
      })
      .mockResolvedValueOnce({
        data: {
          canPost: false,
          canVote: true,
          canDeleteOwnPost: false,
          canDismiss: false,
          canComment: false,
          canViewNames: false,
          quickPostOptions: [
            {
              postId: 'quick-3',
              questionNumber: 3,
              label: "I didn't understand question 3",
              upvoteCount: 1,
              viewerHasUpvoted: true,
            },
          ],
          posts: [
            {
              _id: 'quick-3',
              body: "I didn't understand question 3",
              bodyWysiwyg: '',
              createdAt: null,
              updatedAt: null,
              upvoteCount: 1,
              viewerHasUpvoted: true,
              isOwnPost: false,
              isQuickPost: true,
              quickPostQuestionNumber: 3,
              dismissed: false,
              authorRole: 'system',
              authorName: null,
              comments: [],
            },
          ],
        },
      });
    apiClient.post.mockResolvedValue({ data: { success: true } });

    render(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="student"
      />
    );

    expect(await screen.findByText('Need more explanation?')).toBeInTheDocument();
    expect(screen.getByText('Choose the current or an earlier question to add your vote to a shared request for clarification.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Request explanation' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/sessions/session-1/chat/quick-posts/3/toggle');
    });
    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole('button', { name: 'Undo request' })).toBeInTheDocument();
    expect(screen.getAllByText("I didn't understand question 3").length).toBeGreaterThan(0);
  });

  it('keeps presentation chat anonymous by refetching instead of applying named websocket deltas', async () => {
    apiClient.get
      .mockResolvedValueOnce({
        data: {
          richTextChatEnabled: true,
          canPost: false,
          canVote: false,
          canDeleteOwnPost: false,
          canDeleteOwnComment: false,
          canDeleteAnyComment: false,
          canDismiss: false,
          canComment: false,
          canViewNames: false,
          quickPosts: [],
          posts: [
            {
              _id: 'post-1',
              body: 'Anonymous post',
              bodyWysiwyg: '',
              createdAt: null,
              updatedAt: null,
              upvoteCount: 0,
              viewerHasUpvoted: false,
              isOwnPost: false,
              isQuickPost: false,
              dismissed: false,
              authorRole: 'student',
              authorName: null,
              comments: [],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          richTextChatEnabled: true,
          canPost: false,
          canVote: false,
          canDeleteOwnPost: false,
          canDeleteOwnComment: false,
          canDeleteAnyComment: false,
          canDismiss: false,
          canComment: false,
          canViewNames: false,
          quickPosts: [],
          posts: [
            {
              _id: 'post-1',
              body: 'Anonymous post updated',
              bodyWysiwyg: '',
              createdAt: null,
              updatedAt: null,
              upvoteCount: 1,
              viewerHasUpvoted: false,
              isOwnPost: false,
              isQuickPost: false,
              dismissed: false,
              authorRole: 'student',
              authorName: null,
              comments: [],
            },
          ],
        },
      });

    const { rerender } = render(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="presentation"
        view="presentation"
        chatEvent={null}
      />
    );

    expect(await screen.findByText('Anonymous post')).toBeInTheDocument();
    expect(screen.getByText('Anonymous student')).toBeInTheDocument();

    rerender(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="presentation"
        view="presentation"
        chatEvent={{
          id: 1,
          postId: 'post-1',
          post: {
            _id: 'post-1',
            body: 'Named update',
            bodyWysiwyg: '',
            createdAt: null,
            updatedAt: null,
            upvoteCount: 1,
            authorRole: 'student',
            authorName: 'Student One',
            comments: [],
          },
        }}
      />
    );

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('Anonymous post updated')).toBeInTheDocument();
    expect(screen.queryByText('Student One')).not.toBeInTheDocument();
  });

  it('hides rich text post and comment inputs while keeping quick posts available', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        richTextChatEnabled: false,
        canPost: true,
        canVote: true,
        canDeleteOwnPost: false,
        canDeleteOwnComment: true,
        canDeleteAnyComment: false,
        canDismiss: false,
        canComment: true,
        canViewNames: false,
        quickPostOptions: [
          {
            postId: 'quick-2',
            questionNumber: 2,
            label: "I didn't understand question 2",
            upvoteCount: 1,
            viewerHasUpvoted: false,
          },
        ],
        posts: [
          {
            _id: 'post-1',
            body: 'Existing post',
            bodyWysiwyg: '',
            createdAt: null,
            updatedAt: null,
            upvoteCount: 0,
            viewerHasUpvoted: false,
            isOwnPost: false,
            isQuickPost: false,
            dismissed: false,
            authorRole: 'student',
            authorName: null,
            comments: [],
          },
        ],
      },
    });

    render(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="student"
      />
    );

    expect(await screen.findByText('Rich text chat is off. Only quick posts are available right now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request explanation' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Write a post' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Session chat post editor')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Comments' }));
    expect(await screen.findByText('Commenting is disabled while rich text chat is off.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Session chat comment editor')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Comment' })).not.toBeInTheDocument();
  });

  it('hides the professor post composer when rich text chat is off during live sessions', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        richTextChatEnabled: false,
        canPost: true,
        canVote: false,
        canDeleteOwnPost: false,
        canDeleteOwnComment: true,
        canDeleteAnyComment: true,
        canDismiss: true,
        canComment: true,
        canViewNames: true,
        quickPostOptions: [],
        posts: [],
      },
    });

    render(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="professor"
      />
    );

    expect(await screen.findByText('Rich text chat is off. New posts and comments are disabled.')).toBeInTheDocument();
    expect(screen.queryByText('New post')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Session chat post editor')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post' })).not.toBeInTheDocument();
  });

  it('shows delete only for a student-owned non-quick post and calls the delete endpoint', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        canPost: true,
        canVote: true,
        canDeleteOwnPost: true,
        canDismiss: false,
        canComment: true,
        canViewNames: false,
        quickPosts: [],
        posts: [
          {
            _id: 'normal-own-post',
            body: 'My normal post',
            bodyWysiwyg: '',
            createdAt: null,
            updatedAt: null,
            upvoteCount: 0,
            viewerHasUpvoted: false,
            isOwnPost: true,
            isQuickPost: false,
            dismissed: false,
            authorRole: 'student',
            authorName: null,
            comments: [],
          },
          {
            _id: 'quick-own-post',
            body: 'Shared quick post',
            bodyWysiwyg: '',
            createdAt: null,
            updatedAt: null,
            upvoteCount: 1,
            viewerHasUpvoted: true,
            isOwnPost: true,
            isQuickPost: true,
            quickPostQuestionNumber: 3,
            dismissed: false,
            authorRole: 'system',
            authorName: null,
            comments: [],
          },
        ],
      },
    });
    apiClient.delete.mockResolvedValue({ data: { success: true } });

    render(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="student"
      />
    );

    expect(await screen.findByText('My normal post')).toBeInTheDocument();
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    expect(deleteButtons).toHaveLength(1);

    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(apiClient.delete).toHaveBeenCalledWith('/sessions/session-1/chat/posts/normal-own-post');
    });
  });

  it('lets an author edit their own non-quick post but not another author\'s post', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        richTextChatEnabled: true,
        canPost: true,
        canVote: true,
        canEditOwnPost: true,
        canDeleteOwnPost: true,
        canDismiss: false,
        canComment: true,
        canViewNames: false,
        quickPosts: [],
        posts: [
          {
            _id: 'own-post',
            body: 'My original post',
            bodyWysiwyg: '<p>My original post</p>',
            createdAt: null,
            updatedAt: null,
            upvoteCount: 0,
            viewerHasUpvoted: false,
            isOwnPost: true,
            isQuickPost: false,
            dismissed: false,
            authorRole: 'student',
            authorName: null,
            comments: [],
          },
          {
            _id: 'other-post',
            body: 'Another student post',
            bodyWysiwyg: '',
            createdAt: null,
            updatedAt: null,
            upvoteCount: 0,
            viewerHasUpvoted: false,
            isOwnPost: false,
            isQuickPost: false,
            dismissed: false,
            authorRole: 'student',
            authorName: null,
            comments: [],
          },
        ],
      },
    });

    render(<SessionChatPanel sessionId="session-1" enabled role="student" />);

    expect(await screen.findByText('My original post')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit session chat post'), { target: { value: '<p>My revised post</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith('/sessions/session-1/chat/posts/own-post', {
        body: 'My revised post',
        bodyWysiwyg: '<p>My revised post</p>',
      });
    });
  });

  it('refetches after a student creates a post over websocket transport so own names stay personalized', async () => {
    apiClient.get
      .mockResolvedValueOnce({
        data: {
          canPost: true,
          canVote: false,
          canDeleteOwnPost: true,
          canDeleteOwnComment: true,
          canDeleteAnyComment: false,
          canDismiss: false,
          canComment: false,
          canViewNames: false,
          quickPosts: [],
          posts: [],
        },
      })
      .mockResolvedValueOnce({
        data: {
          canPost: true,
          canVote: false,
          canDeleteOwnPost: true,
          canDeleteOwnComment: true,
          canDeleteAnyComment: false,
          canDismiss: false,
          canComment: false,
          canViewNames: false,
          quickPosts: [],
          posts: [
            {
              _id: 'own-post',
              body: 'My named post',
              bodyWysiwyg: '',
              createdAt: null,
              updatedAt: null,
              upvoteCount: 0,
              viewerHasUpvoted: false,
              isOwnPost: true,
              isQuickPost: false,
              dismissed: false,
              authorRole: 'student',
              authorName: 'Student One',
              comments: [],
            },
          ],
        },
      });
    apiClient.post.mockResolvedValue({ data: { success: true, postId: 'own-post' } });

    render(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="student"
        syncTransport="websocket"
      />
    );

    expect(await screen.findByText('No posts yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Write a post' }));
    fireEvent.change(screen.getByLabelText('Session chat post editor'), { target: { value: 'My named post' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith('/sessions/session-1/chat/posts', {
        body: 'My named post',
        bodyWysiwyg: 'My named post',
      });
    });
    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText('Student One')).toBeInTheDocument();
  });

  it('lets students delete their own comments', async () => {
    apiClient.get
      .mockResolvedValueOnce({
        data: {
          canPost: false,
          canVote: false,
          canDeleteOwnPost: false,
          canDeleteOwnComment: true,
          canDeleteAnyComment: false,
          canDismiss: false,
          canComment: true,
          canViewNames: false,
          quickPosts: [],
          posts: [
            {
              _id: 'post-1',
              body: 'Post with comments',
              bodyWysiwyg: '',
              createdAt: null,
              updatedAt: null,
              upvoteCount: 0,
              viewerHasUpvoted: false,
              isOwnPost: false,
              isQuickPost: false,
              dismissed: false,
              authorRole: 'student',
              authorName: null,
              comments: [
                {
                  _id: 'comment-own',
                  body: 'My comment',
                  bodyWysiwyg: '',
                  createdAt: null,
                  updatedAt: null,
                  isOwnComment: true,
                  authorRole: 'student',
                  authorName: 'Student One',
                },
                {
                  _id: 'comment-other',
                  body: 'Other comment',
                  bodyWysiwyg: '',
                  createdAt: null,
                  updatedAt: null,
                  isOwnComment: false,
                  authorRole: 'student',
                  authorName: null,
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          canPost: false,
          canVote: false,
          canDeleteOwnPost: false,
          canDeleteOwnComment: true,
          canDeleteAnyComment: false,
          canDismiss: false,
          canComment: true,
          canViewNames: false,
          quickPosts: [],
          posts: [
            {
              _id: 'post-1',
              body: 'Post with comments',
              bodyWysiwyg: '',
              createdAt: null,
              updatedAt: null,
              upvoteCount: 0,
              viewerHasUpvoted: false,
              isOwnPost: false,
              isQuickPost: false,
              dismissed: false,
              authorRole: 'student',
              authorName: null,
              comments: [
                {
                  _id: 'comment-other',
                  body: 'Other comment',
                  bodyWysiwyg: '',
                  createdAt: null,
                  updatedAt: null,
                  isOwnComment: false,
                  authorRole: 'student',
                  authorName: null,
                },
              ],
            },
          ],
        },
      });
    apiClient.delete.mockResolvedValue({ data: { success: true } });

    render(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="student"
      />
    );

    expect(await screen.findByText('Post with comments')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Comments' }));

    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    expect(deleteButtons).toHaveLength(1);
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(apiClient.delete).toHaveBeenCalledWith('/sessions/session-1/chat/posts/post-1/comments/comment-own');
    });
    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText('My comment')).not.toBeInTheDocument();
  });

  it('removes a post immediately when a delete chat event arrives', async () => {
    const initialData = {
      canPost: true,
      canVote: true,
      canDeleteOwnPost: true,
      canDismiss: false,
      canComment: true,
      canViewNames: false,
      quickPosts: [],
      posts: [
        {
          _id: 'normal-own-post',
          body: 'My normal post',
          bodyWysiwyg: '',
          createdAt: null,
          updatedAt: null,
          upvoteCount: 0,
          viewerHasUpvoted: false,
          isOwnPost: true,
          isQuickPost: false,
          dismissed: false,
          authorRole: 'student',
          authorName: null,
          comments: [],
        },
      ],
    };

    const { rerender } = render(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="student"
        initialData={initialData}
      />
    );

    expect(screen.getByText('My normal post')).toBeInTheDocument();

    rerender(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="student"
        initialData={initialData}
        chatEvent={{
          changeType: 'post-deleted',
          postId: 'normal-own-post',
          post: null,
        }}
      />
    );

    await waitFor(() => {
      expect(screen.queryByText('My normal post')).not.toBeInTheDocument();
    });
  });

  it('shows delete and dismiss controls for professors on any live post', async () => {
    apiClient.get.mockResolvedValue({
      data: {
        canPost: false,
        canVote: false,
        canDeleteOwnPost: false,
        canDismiss: true,
        canComment: false,
        canViewNames: true,
        quickPosts: [],
        posts: [
          {
            _id: 'student-post',
            body: 'Student post',
            bodyWysiwyg: '',
            createdAt: null,
            updatedAt: null,
            upvoteCount: 2,
            viewerHasUpvoted: false,
            isOwnPost: false,
            isQuickPost: false,
            dismissed: false,
            authorRole: 'student',
            authorName: 'Student One',
            comments: [],
          },
          {
            _id: 'quick-post',
            body: 'Shared quick post',
            bodyWysiwyg: '',
            createdAt: null,
            updatedAt: null,
            upvoteCount: 3,
            viewerHasUpvoted: false,
            isOwnPost: false,
            isQuickPost: true,
            quickPostQuestionNumber: 2,
            dismissed: false,
            authorRole: 'system',
            authorName: null,
            comments: [],
          },
        ],
      },
    });

    render(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="professor"
      />
    );

    expect(await screen.findByText('Student post')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(2);
  });

  it.each(['student', 'professor'])('moves a discussion to the top on comment/upvote deltas for %s without refetching', (role) => {
    vi.useFakeTimers();
    const older = { _id: 'older', body: 'Older popular post', createdAt: '2020-01-01', updatedAt: '2020-01-01', upvoteCount: 20, comments: [] };
    const newer = { _id: 'newer', body: 'Recent post', createdAt: '2020-01-02', updatedAt: '2020-01-02', upvoteCount: 0, comments: [] };
    const initialData = { posts: [newer, older], quickPosts: [], canPost: false, canComment: false, canVote: false };
    const { rerender, unmount } = render(<SessionChatPanel sessionId="session-1" enabled role={role} initialData={initialData} />);
    const expectFirst = (first, second) => expect(screen.getByText(first).compareDocumentPosition(screen.getByText(second)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    try {
      expectFirst('Recent post', 'Older popular post');
      rerender(<SessionChatPanel sessionId="session-1" enabled role={role} initialData={initialData}
        chatEvent={{ changeType: 'comment-added', postId: older._id, post: { ...older, updatedAt: '2020-01-03', comments: [{ _id: 'comment-1', body: 'New comment' }] } }} />);
      expectFirst('Older popular post', 'Recent post');
      rerender(<SessionChatPanel sessionId="session-1" enabled role={role} initialData={initialData}
        chatEvent={{ changeType: 'post-voted', postId: newer._id, post: { ...newer, updatedAt: '2020-01-04', upvoteCount: 1 } }} />);
      expectFirst('Recent post', 'Older popular post');
      expect(apiClient.get).not.toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it('keeps dismissed posts last in professor live chat updates', async () => {
    vi.useFakeTimers();
    apiClient.get.mockResolvedValue({
      data: {
        viewMode: 'live',
        canPost: false,
        canVote: false,
        canDeleteOwnPost: false,
        canDismiss: true,
        canComment: false,
        canViewNames: true,
        quickPosts: [],
        posts: [],
      },
    });

    const initialData = {
      viewMode: 'live',
      canPost: false,
      canVote: false,
      canDeleteOwnPost: false,
      canDismiss: true,
      canComment: false,
      canViewNames: true,
      quickPosts: [],
      posts: [
        {
          _id: 'active-post',
          body: 'Active post',
          bodyWysiwyg: '',
          createdAt: '2026-04-02T02:00:00.000Z',
          updatedAt: '2026-04-02T02:00:00.000Z',
          upvoteCount: 1,
          viewerHasUpvoted: false,
          isOwnPost: false,
          isQuickPost: false,
          dismissed: false,
          authorRole: 'student',
          authorName: 'Student One',
          comments: [],
        },
      ],
    };

    const { rerender } = render(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="professor"
        initialData={initialData}
      />
    );

    expect(screen.getByText('Active post')).toBeInTheDocument();

    rerender(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="professor"
        initialData={initialData}
        chatEvent={{
          postId: 'dismissed-post',
          post: {
            _id: 'dismissed-post',
            body: 'Dismissed post',
            bodyWysiwyg: '',
            createdAt: '2026-04-02T02:01:00.000Z',
            updatedAt: '2026-04-02T02:01:00.000Z',
            upvoteCount: 10,
            viewerHasUpvoted: false,
            isOwnPost: false,
            isQuickPost: false,
            dismissed: true,
            dismissedAt: '2026-04-02T02:02:00.000Z',
            authorRole: 'student',
            authorName: 'Student Two',
            comments: [],
          },
        }}
      />
    );

    const activePost = screen.getByText('Active post');
    const dismissedPost = screen.getByText('Dismissed post');
    expect(activePost.compareDocumentPosition(dismissedPost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    vi.useRealTimers();
  });

  it('filters dismissed posts from presentation chat updates', async () => {
    vi.useFakeTimers();
    apiClient.get.mockResolvedValue({
      data: {
        viewMode: 'presentation',
        canPost: false,
        canVote: false,
        canDeleteOwnPost: false,
        canDismiss: false,
        canComment: false,
        canViewNames: false,
        quickPosts: [],
        posts: [],
      },
    });

    const initialData = {
      viewMode: 'presentation',
      canPost: false,
      canVote: false,
      canDeleteOwnPost: false,
      canDismiss: false,
      canComment: false,
      canViewNames: false,
      quickPosts: [],
      posts: [
        {
          _id: 'active-post',
          body: 'Visible post',
          bodyWysiwyg: '',
          createdAt: '2026-04-02T02:00:00.000Z',
          updatedAt: '2026-04-02T02:00:00.000Z',
          upvoteCount: 1,
          viewerHasUpvoted: false,
          isOwnPost: false,
          isQuickPost: false,
          dismissed: false,
          authorRole: 'student',
          authorName: null,
          comments: [],
        },
      ],
    };

    const { rerender } = render(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="presentation"
        view="presentation"
        initialData={initialData}
      />
    );

    expect(screen.getByText('Visible post')).toBeInTheDocument();

    rerender(
      <SessionChatPanel
        sessionId="session-1"
        enabled
        role="presentation"
        view="presentation"
        initialData={initialData}
        chatEvent={{
          postId: 'dismissed-post',
          post: {
            _id: 'dismissed-post',
            body: 'Hidden dismissed post',
            bodyWysiwyg: '',
            createdAt: '2026-04-02T02:01:00.000Z',
            updatedAt: '2026-04-02T02:01:00.000Z',
            upvoteCount: 20,
            viewerHasUpvoted: false,
            isOwnPost: false,
            isQuickPost: false,
            dismissed: true,
            dismissedAt: '2026-04-02T02:02:00.000Z',
            authorRole: 'student',
            authorName: null,
            comments: [],
          },
        }}
      />
    );

    expect(screen.queryByText('Hidden dismissed post')).not.toBeInTheDocument();
    vi.useRealTimers();
  });
});
