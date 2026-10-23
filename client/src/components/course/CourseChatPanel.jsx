import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  ArchiveOutlined as ArchiveIcon,
  ChatBubbleOutlined as CommentIcon,
  DeleteOutlined as DeleteIcon,
  EditOutlined as EditIcon,
  ExpandLess as ExpandLessIcon,
  ExpandMore as ExpandMoreIcon,
  RestoreFromTrash as UnarchiveIcon,
  ThumbUpOutlined as UpvoteIcon,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';
import StudentIdentity from '../common/StudentIdentity';
import StudentRichTextEditor from '../questions/StudentRichTextEditor';
import AiMarkdownContent from '../ai/AiMarkdownContent';
import {
  extractPlainTextFromHtml,
  prepareRichTextInput,
  renderKatexInElement,
} from '../questions/richTextUtils';

const richContentSx = {
  '& p': { my: 0.5 },
  '& ul, & ol': { my: 0.5, pl: 3 },
  '& img': {
    display: 'block',
    maxWidth: '100% !important',
    height: 'auto !important',
    borderRadius: 0,
    my: 0.75,
  },
};

const CHAT_REFRESH_DEBOUNCE_MS = 150;
const CHAT_EDITOR_CHANGE_DEBOUNCE_MS = 200;

function getTimestampMs(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortCoursePosts(posts = [], sortOrder = 'time') {
  return [...posts].sort((a, b) => {
    const createdDiff = getTimestampMs(b?.createdAt) - getTimestampMs(a?.createdAt);
    const upvoteDiff = Number(b?.upvoteCount || 0) - Number(a?.upvoteCount || 0);
    if (sortOrder === 'upvotes') {
      if (upvoteDiff !== 0) return upvoteDiff;
      if (createdDiff !== 0) return createdDiff;
    } else if (createdDiff !== 0) {
      return createdDiff;
    } else if (upvoteDiff !== 0) {
      return upvoteDiff;
    }
    return String(b?._id || '').localeCompare(String(a?._id || ''));
  });
}

function sortComments(comments = []) {
  return [...comments].sort((a, b) => {
    const createdDiff = getTimestampMs(a?.createdAt) - getTimestampMs(b?.createdAt);
    if (createdDiff !== 0) return createdDiff;
    return String(a?._id || '').localeCompare(String(b?._id || ''));
  });
}

function mergeCoursePost(existingPost = {}, incomingPost = {}) {
  return {
    ...existingPost,
    ...incomingPost,
    comments: sortComments(incomingPost?.comments ?? existingPost?.comments ?? []),
    viewerHasUpvoted: incomingPost?.viewerHasUpvoted ?? existingPost?.viewerHasUpvoted ?? false,
    isOwnPost: incomingPost?.isOwnPost ?? existingPost?.isOwnPost ?? false,
  };
}

function applyCourseChatEventData(previousData, eventPayload, sortOrder = 'time') {
  if (!previousData || !eventPayload) return null;
  const postId = String(eventPayload?.postId || eventPayload?.post?._id || '');
  let posts = Array.isArray(previousData?.posts) ? [...previousData.posts] : [];

  if (eventPayload?.post !== undefined) {
    if (eventPayload.post) {
      const existingIndex = posts.findIndex((post) => String(post?._id || '') === String(eventPayload.post?._id || ''));
      const mergedPost = mergeCoursePost(posts[existingIndex] || {}, eventPayload.post);
      if (existingIndex >= 0) {
        posts[existingIndex] = mergedPost;
      } else {
        posts.push(mergedPost);
      }
    } else if (postId) {
      posts = posts.filter((post) => String(post?._id || '') !== postId);
    }
  }

  return {
    ...previousData,
    posts: sortCoursePosts(posts, sortOrder),
  };
}

function formatTimestamp(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function normalizeDraftPlainText(html = '') {
  return extractPlainTextFromHtml(html || '').trim();
}

function getAuthorLabel({ authorName, authorRole, t }) {
  if (authorName) return authorName;
  if (authorRole === 'student') return t('courseChat.anonymousStudent');
  if (authorRole === 'instructor' || authorRole === 'admin') return t('courseChat.instructor');
  return t('courseChat.unknownAuthor');
}

function RichContent({ html, fallback }) {
  const ref = useRef(null);
  const prepared = useMemo(
    () => prepareRichTextInput(html || '', fallback || '', { allowVideoEmbeds: true }),
    [fallback, html]
  );

  useLayoutEffect(() => {
    if (ref.current && prepared) {
      renderKatexInElement(ref.current);
    }
  }, [prepared]);

  if (!prepared) return null;
  // LLM-generated posts are commonly Markdown rather than editor HTML.
  if (!/<\/?[a-z][\s\S]*>/i.test(html || '') && fallback) return <AiMarkdownContent content={fallback} />;

  return (
    <Box
      ref={ref}
      sx={richContentSx}
      dangerouslySetInnerHTML={{ __html: prepared }}
    />
  );
}

function VoteButton({ onClick, active, disabled, count, label }) {
  return (
    <Tooltip title={label}>
      <span>
        <Button
          size="small"
          color={active ? 'primary' : 'inherit'}
          startIcon={<UpvoteIcon fontSize="small" />}
          onClick={onClick}
          disabled={disabled}
          sx={{ minWidth: 0 }}
        >
          {label} ({count})
        </Button>
      </span>
    </Tooltip>
  );
}

function CommentItem({
  post,
  comment,
  canViewNames,
  canVote,
  canDelete,
  deletingCommentId,
  onDeleteComment,
  onVoteComment,
  votingCommentId,
}) {
  const { t } = useTranslation();

  return (
    <Paper variant="outlined" sx={{ p: 1.25 }}>
      <Stack spacing={1}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} sx={{ justifyContent: 'space-between' }}>
          <Box sx={{ minWidth: 0, flexGrow: 1 }}>
            {canViewNames && comment.author ? (
              <StudentIdentity student={comment.author} avatarSize={32} />
            ) : (
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {getAuthorLabel({ authorName: comment.authorName, authorRole: comment.authorRole, t })}
              </Typography>
            )}
            <Stack direction="row" spacing={0.75} sx={{ mt: 0.25, flexWrap: 'wrap' }}>
              <Typography variant="caption" sx={{
                color: "text.secondary"
              }}>
                {formatTimestamp(comment.createdAt)}
              </Typography>
              {comment.isOriginalPoster ? <Chip size="small" label={t('courseChat.originalPoster')} variant="outlined" /> : null}
            </Stack>
          </Box>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
            {canVote ? (
              <VoteButton
                label={t('courseChat.upvote')}
                count={comment.upvoteCount || 0}
                active={!!comment.viewerHasUpvoted}
                disabled={votingCommentId === comment._id}
                onClick={() => onVoteComment(post._id, comment._id, !comment.viewerHasUpvoted)}
              />
            ) : (
              <Typography variant="caption" sx={{
                color: "text.secondary"
              }}>
                {t('courseChat.upvotesCount', { count: comment.upvoteCount || 0 })}
              </Typography>
            )}
            {canDelete ? (
              <Tooltip title={t('courseChat.deleteComment')}>
                <span>
                  <IconButton
                    size="small"
                    color="error"
                    aria-label={t('courseChat.deleteComment')}
                    disabled={deletingCommentId === comment._id}
                    onClick={() => onDeleteComment(post._id, comment._id)}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            ) : null}
          </Stack>
        </Stack>
        <RichContent html={comment.bodyWysiwyg} fallback={comment.body} />
      </Stack>
    </Paper>
  );
}

export default function CourseChatPanel({
  courseId,
  enabled,
  role = 'student',
  syncTransport = 'unknown',
  refreshToken = 0,
  chatEvent = null,
  initialData = null,
}) {
  const { t } = useTranslation();
  const [chatData, setChatData] = useState(initialData);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [draftHtml, setDraftHtml] = useState('');
  const [selectedTags, setSelectedTags] = useState([]);
  const [tagFilter, setTagFilter] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [sortOrder, setSortOrder] = useState('time');
  const [expandedPosts, setExpandedPosts] = useState({});
  const [commentDrafts, setCommentDrafts] = useState({});
  const [pendingCommentId, setPendingCommentId] = useState('');
  const [deletingCommentId, setDeletingCommentId] = useState('');
  const [votingCommentId, setVotingCommentId] = useState('');
  const [submittingPost, setSubmittingPost] = useState(false);
  const [editingPostId, setEditingPostId] = useState('');
  const [editTitleDraft, setEditTitleDraft] = useState('');
  const [editBodyDraft, setEditBodyDraft] = useState('');
  const [savingPostId, setSavingPostId] = useState('');
  const chatDataRef = useRef(initialData);
  const fetchInFlightRef = useRef(false);
  const queuedRefreshRef = useRef(false);

  useEffect(() => {
    chatDataRef.current = initialData;
    setChatData(initialData);
    setLoading(!initialData);
  }, [initialData]);

  const fetchChat = useCallback(async () => {
    if (!enabled) {
      chatDataRef.current = null;
      setChatData(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(!chatDataRef.current);
    try {
      const { data } = await apiClient.get(`/courses/${courseId}/chat`, {
        params: showArchived ? { includeArchived: true } : undefined,
      });
      chatDataRef.current = data;
      setChatData(data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToLoad'));
    } finally {
      setLoading(false);
    }
  }, [courseId, enabled, showArchived, t]);

  const runFetchChat = useCallback(async () => {
    if (fetchInFlightRef.current) {
      queuedRefreshRef.current = true;
      return;
    }

    fetchInFlightRef.current = true;
    try {
      await fetchChat();
    } finally {
      fetchInFlightRef.current = false;
      if (queuedRefreshRef.current) {
        queuedRefreshRef.current = false;
        void runFetchChat();
      }
    }
  }, [fetchChat]);

  useEffect(() => {
    const delayMs = chatDataRef.current ? CHAT_REFRESH_DEBOUNCE_MS : 0;
    const timer = setTimeout(() => {
      void runFetchChat();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [enabled, refreshToken, runFetchChat]);

  useEffect(() => {
    if (!enabled || !chatEvent) return;
    if (!chatDataRef.current) {
      void runFetchChat();
      return;
    }

    const nextData = applyCourseChatEventData(chatDataRef.current, chatEvent, sortOrder);
    if (!nextData) {
      void runFetchChat();
      return;
    }

    chatDataRef.current = nextData;
    setChatData(nextData);
    setError(null);
  }, [chatEvent, enabled, runFetchChat, sortOrder]);

  const canCompose = !!chatData?.canPost;
  const canVote = !!chatData?.canVote && role === 'student';
  const canViewNames = !!chatData?.canViewNames;
  const canDeleteAnyPost = !!chatData?.canDeleteAnyPost;
  const canDeleteOwnPost = !!chatData?.canDeleteOwnPost;
  const canDeleteAnyComment = !!chatData?.canDeleteAnyComment;
  const canDeleteOwnComment = !!chatData?.canDeleteOwnComment;
  const canArchive = !!chatData?.canArchive;
  const canUnarchive = !!chatData?.canUnarchive;
  const shouldRefetchAfterMutation = syncTransport !== 'websocket';
  const shouldRefetchAfterStudentMutation = shouldRefetchAfterMutation || role === 'student';
  const draftHasContent = normalizeDraftPlainText(draftHtml).length > 0 || (draftHtml || '').trim().length > 0;
  const availableTags = useMemo(() => chatData?.availableTags || [], [chatData?.availableTags]);

  const userFilterOptions = useMemo(() => {
    const map = new Map();
    (chatData?.posts || []).forEach((post) => {
      if (post?.authorId && post?.author) {
        map.set(String(post.authorId), {
          value: String(post.authorId),
          label: post.author.displayName || post.authorName || post.author.email || String(post.authorId),
        });
      }
    });
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [chatData?.posts]);

  const filteredPosts = useMemo(() => {
    const posts = sortCoursePosts(chatData?.posts || [], sortOrder);
    return posts.filter((post) => {
      const matchesArchived = showArchived || !post?.isArchived;
      const matchesTag = !tagFilter || (post?.tags || []).includes(tagFilter);
      const matchesAuthor = !authorFilter || String(post?.authorId || '') === String(authorFilter);
      return matchesArchived && matchesTag && matchesAuthor;
    });
  }, [authorFilter, chatData?.posts, showArchived, sortOrder, tagFilter]);

  const resetComposer = useCallback(() => {
    setTitleDraft('');
    setDraftHtml('');
    setSelectedTags([]);
  }, []);

  const handleCancelComposer = useCallback(() => {
    resetComposer();
    setComposerOpen(false);
  }, [resetComposer]);

  const handleSubmitPost = useCallback(async () => {
    if (!canCompose || !draftHasContent || !titleDraft.trim() || submittingPost) return;
    setSubmittingPost(true);
    try {
      await apiClient.post(`/courses/${courseId}/chat/posts`, {
        title: titleDraft.trim(),
        body: normalizeDraftPlainText(draftHtml),
        bodyWysiwyg: draftHtml,
        tags: selectedTags,
      });
      resetComposer();
      setComposerOpen(role === 'professor');
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToSend'));
    } finally {
      setSubmittingPost(false);
    }
  }, [canCompose, courseId, draftHasContent, draftHtml, fetchChat, resetComposer, role, selectedTags, shouldRefetchAfterStudentMutation, submittingPost, t, titleDraft]);

  const handleVotePost = useCallback(async (postId, upvoted) => {
    try {
      await apiClient.patch(`/courses/${courseId}/chat/posts/${postId}/vote`, { upvoted });
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToVote'));
    }
  }, [courseId, fetchChat, shouldRefetchAfterStudentMutation, t]);

  const beginEditingPost = useCallback((post) => {
    setEditingPostId(post._id);
    setEditTitleDraft(post.title || '');
    setEditBodyDraft(prepareRichTextInput(post.bodyWysiwyg, post.body));
  }, []);

  const cancelEditingPost = useCallback(() => {
    setEditingPostId('');
    setEditTitleDraft('');
    setEditBodyDraft('');
  }, []);

  const handleEditPost = useCallback(async (postId) => {
    const editHasContent = normalizeDraftPlainText(editBodyDraft).length > 0 || editBodyDraft.trim().length > 0;
    if (!editTitleDraft.trim() || !editHasContent || savingPostId) return;
    setSavingPostId(postId);
    try {
      await apiClient.patch(`/courses/${courseId}/chat/posts/${postId}`, {
        title: editTitleDraft.trim(),
        body: normalizeDraftPlainText(editBodyDraft),
        bodyWysiwyg: editBodyDraft,
      });
      cancelEditingPost();
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToEdit'));
    } finally {
      setSavingPostId('');
    }
  }, [cancelEditingPost, courseId, editBodyDraft, editTitleDraft, fetchChat, savingPostId, shouldRefetchAfterStudentMutation, t]);

  const handleVoteComment = useCallback(async (postId, commentId, upvoted) => {
    setVotingCommentId(commentId);
    try {
      await apiClient.patch(`/courses/${courseId}/chat/posts/${postId}/comments/${commentId}/vote`, { upvoted });
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToVote'));
    } finally {
      setVotingCommentId('');
    }
  }, [courseId, fetchChat, shouldRefetchAfterStudentMutation, t]);

  const handleSubmitComment = useCallback(async (postId) => {
    const draft = commentDrafts[postId] || '';
    if (!normalizeDraftPlainText(draft) && !draft.trim()) return;
    setPendingCommentId(postId);
    try {
      await apiClient.post(`/courses/${courseId}/chat/posts/${postId}/comments`, {
        body: normalizeDraftPlainText(draft),
        bodyWysiwyg: draft,
      });
      setCommentDrafts((prev) => ({ ...prev, [postId]: '' }));
      setExpandedPosts((prev) => ({ ...prev, [postId]: true }));
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToComment'));
    } finally {
      setPendingCommentId('');
    }
  }, [commentDrafts, courseId, fetchChat, shouldRefetchAfterStudentMutation, t]);

  const handleDeletePost = useCallback(async (postId) => {
    try {
      await apiClient.delete(`/courses/${courseId}/chat/posts/${postId}`);
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToDelete'));
    }
  }, [courseId, fetchChat, shouldRefetchAfterStudentMutation, t]);

  const handleArchivePost = useCallback(async (postId) => {
    try {
      await apiClient.patch(`/courses/${courseId}/chat/posts/${postId}/archive`);
      setError(null);
      if (shouldRefetchAfterMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToArchive'));
    }
  }, [courseId, fetchChat, shouldRefetchAfterMutation, t]);

  const handleUnarchivePost = useCallback(async (postId) => {
    try {
      await apiClient.patch(`/courses/${courseId}/chat/posts/${postId}/unarchive`);
      setError(null);
      if (shouldRefetchAfterMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToArchive'));
    }
  }, [courseId, fetchChat, shouldRefetchAfterMutation, t]);

  const handleDeleteComment = useCallback(async (postId, commentId) => {
    setDeletingCommentId(commentId);
    try {
      await apiClient.delete(`/courses/${courseId}/chat/posts/${postId}/comments/${commentId}`);
      setError(null);
      if (shouldRefetchAfterStudentMutation) {
        await fetchChat();
      }
    } catch (err) {
      setError(err.response?.data?.message || t('courseChat.failedToDelete'));
    } finally {
      setDeletingCommentId('');
    }
  }, [courseId, fetchChat, shouldRefetchAfterStudentMutation, t]);

  if (!enabled) {
    return <Alert severity="info">{t('courseChat.disabled')}</Alert>;
  }

  if (loading) {
    return (
      <Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Stack spacing={2}>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Alert severity="info">{t('courseChat.studentNamesAnonymous')}</Alert>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ justifyContent: 'space-between', alignItems: { sm: 'center' } }}>
            <Typography variant="h6">{t('courseChat.title')}</Typography>
            {canCompose ? (
              <Tooltip title={composerOpen ? t('courseChat.hideComposer') : t('courseChat.newPost')}>
                <Button
                  variant={composerOpen ? 'outlined' : 'contained'}
                  startIcon={<AddIcon />}
                  onClick={() => setComposerOpen((prev) => !prev)}
                >
                  {composerOpen ? t('courseChat.hideComposer') : t('courseChat.newPost')}
                </Button>
              </Tooltip>
            ) : null}
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
            {availableTags.length > 0 ? (
              <Autocomplete
                size="small"
                options={availableTags}
                getOptionLabel={(option) => option.label || option.value || ''}
                value={availableTags.find((option) => option.value === tagFilter) || null}
                onChange={(_, value) => setTagFilter(value?.value || '')}
                renderInput={(params) => <TextField {...params} label={t('courseChat.filterByTag')} size="small" />}
                sx={{ minWidth: { md: 220 } }}
              />
            ) : null}
            {canViewNames ? (
              <Autocomplete
                size="small"
                options={userFilterOptions}
                getOptionLabel={(option) => option.label || ''}
                value={userFilterOptions.find((option) => option.value === authorFilter) || null}
                onChange={(_, value) => setAuthorFilter(value?.value || '')}
                renderInput={(params) => <TextField {...params} label={t('courseChat.filterByUser')} size="small" />}
                sx={{ minWidth: { md: 240 } }}
              />
            ) : null}
            <TextField
              select
              size="small"
              label={t('courseChat.sortBy')}
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
              sx={{ minWidth: { md: 180 } }}
            >
              <MenuItem value="time">{t('courseChat.sortByTime')}</MenuItem>
              <MenuItem value="upvotes">{t('courseChat.sortByUpvotes')}</MenuItem>
            </TextField>
            {canArchive ? (
              <FormControlLabel
                control={(
                  <Checkbox
                    size="small"
                    checked={showArchived}
                    onChange={(event) => setShowArchived(event.target.checked)}
                  />
                )}
                label={t('courseChat.showArchived')}
              />
            ) : null}
          </Stack>

          {composerOpen ? (
            <Stack spacing={1.25}>
              <TextField
                size="small"
                label={t('courseChat.topic')}
                value={titleDraft}
                onChange={(event) => setTitleDraft(event.target.value)}
                slotProps={{
                  htmlInput: { maxLength: 160 }
                }}
              />
              {availableTags.length > 0 ? (
                <Autocomplete
                  multiple
                  size="small"
                  options={availableTags}
                  getOptionLabel={(option) => option.label || option.value || ''}
                  value={availableTags.filter((option) => selectedTags.includes(option.value))}
                  onChange={(_, values) => setSelectedTags(values.map((value) => value.value))}
                  renderInput={(params) => <TextField {...params} label={t('courseChat.tags')} size="small" />}
                />
              ) : null}
              <StudentRichTextEditor
                value={draftHtml}
                onChange={({ html }) => setDraftHtml(html)}
                onChangeDebounceMs={CHAT_EDITOR_CHANGE_DEBOUNCE_MS}
                placeholder={t('courseChat.postPlaceholder')}
                ariaLabel={t('courseChat.postEditorLabel')}
                enableVideo
              />
              <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
                <Button onClick={handleCancelComposer}>{t('common.cancel')}</Button>
                <Button
                  variant="contained"
                  onClick={handleSubmitPost}
                  disabled={!titleDraft.trim() || !draftHasContent || submittingPost}
                >
                  {t('courseChat.publishPost')}
                </Button>
              </Box>
            </Stack>
          ) : null}
        </Stack>
      </Paper>

      {filteredPosts.length === 0 ? (
        <Alert severity="info">{t('courseChat.noPosts')}</Alert>
      ) : filteredPosts.map((post) => {
        const expanded = !!expandedPosts[post._id];
        const isEditing = editingPostId === post._id;
        const canEditPost = !post.isArchived && post.isOwnPost;
        const canDeletePost = !post.isArchived && (canDeleteAnyPost || (canDeleteOwnPost && post.isOwnPost));
        return (
          <Paper key={post._id} variant="outlined" sx={{ p: 2, opacity: post.isArchived ? 0.82 : 1 }}>
            <Stack spacing={1.25}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ justifyContent: 'space-between' }}>
                <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                  {canViewNames && post.author ? (
                    <StudentIdentity student={post.author} avatarSize={40} emailVariant="body2" />
                  ) : (
                    <Typography variant="body2" sx={{ fontWeight: 700 }}>
                      {getAuthorLabel({ authorName: post.authorName, authorRole: post.authorRole, t })}
                    </Typography>
                  )}
                  <Typography variant="h6" sx={{ mt: 0.75 }}>{post.title}</Typography>
                  <Stack direction="row" spacing={0.75} sx={{ mt: 0.5, flexWrap: 'wrap' }}>
                    <Typography variant="caption" sx={{
                      color: "text.secondary"
                    }}>{formatTimestamp(post.createdAt)}</Typography>
                    <Typography variant="caption" sx={{
                      color: "text.secondary"
                    }}>{t('courseChat.commentsCount', { count: post.comments.length })}</Typography>
                    <Typography variant="caption" sx={{
                      color: "text.secondary"
                    }}>{t('courseChat.upvotesCount', { count: post.upvoteCount || 0 })}</Typography>
                    {post.isArchived ? <Chip size="small" variant="outlined" label={t('courseChat.archived')} /> : null}
                  </Stack>
                </Box>
                <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                  {canVote && !post.isArchived ? (
                    <VoteButton
                      label={t('courseChat.upvote')}
                      count={post.upvoteCount || 0}
                      active={!!post.viewerHasUpvoted}
                      onClick={() => handleVotePost(post._id, !post.viewerHasUpvoted)}
                    />
                  ) : null}
                  {canArchive && !post.isArchived ? (
                    <Tooltip title={t('courseChat.archivePost')}>
                      <IconButton size="small" aria-label={t('courseChat.archivePost')} onClick={() => handleArchivePost(post._id)}>
                        <ArchiveIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                  {canUnarchive && post.isArchived ? (
                    <Tooltip title={t('courseChat.unarchivePost')}>
                      <IconButton size="small" aria-label={t('courseChat.unarchivePost')} onClick={() => handleUnarchivePost(post._id)}>
                        <UnarchiveIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                  {canEditPost ? (
                    <Tooltip title={t('courseChat.editPost')}>
                      <IconButton size="small" aria-label={t('courseChat.editPost')} onClick={() => beginEditingPost(post)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                  {canDeletePost ? (
                    <Tooltip title={t('courseChat.deletePost')}>
                      <IconButton size="small" color="error" aria-label={t('courseChat.deletePost')} onClick={() => handleDeletePost(post._id)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                </Stack>
              </Stack>

              {(post.tags || []).length > 0 ? (
                <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap' }}>
                  {post.tags.map((tag) => (
                    <Chip key={`${post._id}-${tag}`} size="small" label={availableTags.find((entry) => entry.value === tag)?.label || tag} />
                  ))}
                </Stack>
              ) : null}

              {isEditing ? (
                <Stack spacing={1.25}>
                  <TextField
                    size="small"
                    label={t('courseChat.topic')}
                    value={editTitleDraft}
                    onChange={(event) => setEditTitleDraft(event.target.value)}
                    slotProps={{
                      htmlInput: { maxLength: 160 }
                    }}
                  />
                  <StudentRichTextEditor
                    value={editBodyDraft}
                    onChange={({ html }) => setEditBodyDraft(html)}
                    onChangeDebounceMs={CHAT_EDITOR_CHANGE_DEBOUNCE_MS}
                    placeholder={t('courseChat.postPlaceholder')}
                    ariaLabel={t('courseChat.editPostEditorLabel')}
                    enableVideo
                  />
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, flexWrap: 'wrap' }}>
                    <Button onClick={cancelEditingPost}>{t('common.cancel')}</Button>
                    <Button
                      variant="contained"
                      onClick={() => handleEditPost(post._id)}
                      disabled={!editTitleDraft.trim() || (!normalizeDraftPlainText(editBodyDraft) && !editBodyDraft.trim()) || savingPostId === post._id}
                    >
                      {t('common.save')}
                    </Button>
                  </Box>
                </Stack>
              ) : (
                <RichContent html={post.bodyWysiwyg} fallback={post.body} />
              )}

              <Tooltip title={t('courseChat.toggleComments')}>
                <Button
                  size="small"
                  color="inherit"
                  aria-label={t('courseChat.toggleComments')}
                  onClick={() => setExpandedPosts((prev) => ({ ...prev, [post._id]: !expanded }))}
                  startIcon={expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  {t('courseChat.commentsCount', { count: post.comments.length })}
                </Button>
              </Tooltip>

              <Collapse in={expanded} unmountOnExit>
                <Stack spacing={1.25} sx={{ mt: 1 }}>
                  {post.comments.map((comment) => {
                    const canDeleteComment = canDeleteAnyComment || (canDeleteOwnComment && comment.isOwnComment);
                    return (
                      <CommentItem
                        key={comment._id}
                        post={post}
                        comment={comment}
                        canViewNames={canViewNames}
                        canVote={canVote}
                        canDelete={canDeleteComment}
                        deletingCommentId={deletingCommentId}
                        onDeleteComment={handleDeleteComment}
                        onVoteComment={handleVoteComment}
                        votingCommentId={votingCommentId}
                      />
                    );
                  })}
                   {!post.isArchived ? (
                     <>
                       <Divider />
                       <StudentRichTextEditor
                         value={commentDrafts[post._id] || ''}
                         onChange={({ html }) => setCommentDrafts((prev) => ({ ...prev, [post._id]: html }))}
                         onChangeDebounceMs={CHAT_EDITOR_CHANGE_DEBOUNCE_MS}
                         placeholder={t('courseChat.commentPlaceholder')}
                         ariaLabel={t('courseChat.commentEditorLabel')}
                         enableVideo
                       />
                       <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                         <Tooltip title={t('courseChat.addComment')}>
                           <span>
                             <Button
                               variant="contained"
                               startIcon={<CommentIcon />}
                               onClick={() => handleSubmitComment(post._id)}
                               disabled={pendingCommentId === post._id}
                             >
                               {t('courseChat.addComment')}
                             </Button>
                           </span>
                         </Tooltip>
                       </Box>
                     </>
                   ) : null}
                </Stack>
              </Collapse>
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}
