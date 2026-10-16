import { Suspense, lazy, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Badge, Box, Typography, Button, Paper, Alert, Snackbar, CircularProgress, Chip,
  List, ListItem, ListItemButton, ListItemText, Divider, IconButton, Tooltip,
  Dialog, DialogTitle, DialogContent, DialogActions, Stack, TextField, MenuItem,
} from '@mui/material';
import { useAuth } from '../../contexts/AuthContext';
import apiClient, { getUsableAccessToken } from '../../api/client';
import { closeWebSocketQuietly } from '../../utils/liveSocket';
import { buildCourseTitle } from '../../utils/courseTitle';
import { shouldRedirectStudentCourseToInstructorView } from '../../utils/courseAccess';
import {
  getStudentSessionAction,
  isQuizSession,
  isSubmittedLiveQuiz,
  matchesStudentSessionStatus,
  shouldShowStudentSessionQuestionCount,
  sortStudentSessions,
} from '../../utils/studentSessions';
import { getSessionTimingText } from '../../utils/sessionDisplay';
import {
  Delete as DeleteIcon,
  Edit as EditIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from '@mui/icons-material';
import SessionStatusChip from '../../components/common/SessionStatusChip';
import SessionListCard from '../../components/common/SessionListCard';
import ResponsiveTabsNavigation from '../../components/common/ResponsiveTabsNavigation';
import { useTranslation } from 'react-i18next';
import CourseGradesPanel from '../../components/grades/CourseGradesPanel';
import VideoChatPanel from '../../components/video/VideoChatPanel';
import AiCourseChat from '../../components/ai/AiCourseChat';
import { getCourseChatEventUnseenDelta } from '../../utils/courseChat';
import { isRequestCanceled } from '../../utils/requestCancellation';
export { getStudentSessionAction, sortStudentSessions as sortSessions };

const QuestionLibraryPanel = lazy(() => import('../../components/questions/QuestionLibraryPanel'));
const CourseChatPanel = lazy(() => import('../../components/course/CourseChatPanel'));

const MAX_STUDENT_TAB_INDEX = 8;

function parseCourseTab(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return 0;
  if (parsed < 0 || parsed > MAX_STUDENT_TAB_INDEX) return 0;
  return parsed;
}

const COMPACT_CHIP_SX = {
  borderRadius: 1.4,
  '& .MuiChip-label': {
    px: 1.15,
  },
};

const SESSION_PAGE_SIZE = 15;
const SESSION_BACKGROUND_BATCH_SIZE = 4;
const SESSION_PAGE_SIZE_OPTIONS = [15, 30, 50];
const SESSION_STATUS_FILTER_ALL = 'all';
const SESSION_STATUS_FILTER_OPTIONS = [
  { value: SESSION_STATUS_FILTER_ALL, labelKey: 'common.all', defaultLabel: 'All' },
  { value: 'visible', labelKey: 'sessionStatus.upcoming', defaultLabel: 'Upcoming' },
  { value: 'running', labelKey: 'sessionStatus.live', defaultLabel: 'Live' },
  { value: 'done', labelKey: 'sessionStatus.ended', defaultLabel: 'Ended' },
  { value: 'reviewable', labelKey: 'student.course.reviewable', defaultLabel: 'Reviewable' },
];

function normalizeSessionSearchValue(value) {
  return String(value || '').trim().toLowerCase();
}

function getStudentSessionTypeCounts(sessionItems = []) {
  return sessionItems.reduce((counts, session) => {
    if (session?.studentCreated && session?.practiceQuiz) {
      counts.practice += 1;
      return counts;
    }
    if (session?.studentCreated) return counts;
    if (isQuizSession(session)) {
      counts.quizzes += 1;
    } else {
      counts.interactive += 1;
    }
    return counts;
  }, { interactive: 0, quizzes: 0, practice: 0 });
}

function buildWebsocketUrl(token) {
  const encodedToken = encodeURIComponent(token);
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws?token=${encodedToken}`;
}

function TabPanel({ children, value, index }) {
  if (value !== index) return null;
  return <Box sx={{ pt: 2 }}>{children}</Box>;
}

function buildSessionSubtitle(session, t) {
  const details = [];
  if (shouldShowStudentSessionQuestionCount(session)) {
    details.push(t('student.course.questionCount', { count: (session.questions || []).length }));
  }
  const timingText = getSessionTimingText(session, t);
  if (timingText) {
    details.push(timingText);
  }
  return details.join(' · ');
}

export default function StudentCourseDetail() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);
  const [unenrollOpen, setUnenrollOpen] = useState(false);
  const [unenrolling, setUnenrolling] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsBackgroundLoading, setSessionsBackgroundLoading] = useState(false);
  const [sessionTotalCount, setSessionTotalCount] = useState(0);
  const [sessionTypeCounts, setSessionTypeCounts] = useState({ interactive: 0, quizzes: 0, practice: 0 });
  const [sessionPages, setSessionPages] = useState({});
  const [sessionPageSizes, setSessionPageSizes] = useState({});
  const [sessionSearchTerms, setSessionSearchTerms] = useState({});
  const [sessionStatusFilters, setSessionStatusFilters] = useState({});
  const [sessionControlsExpanded, setSessionControlsExpanded] = useState({});
  const [tab, setTab] = useState(() => parseCourseTab(searchParams.get('tab')));
  const [chatRefreshToken, setChatRefreshToken] = useState(0);
  const [chatEvent, setChatEvent] = useState(null);
  const [chatUnseenCount, setChatUnseenCount] = useState(0);
  const [studentAiChatAvailable, setStudentAiChatAvailable] = useState(false);
  const sessionFetchVersionRef = useRef(0);
  const sessionsFullyLoadedRef = useRef(false);
  const sessionsRef = useRef([]);
  const sessionsAbortControllerRef = useRef(null);

  // Video chat availability
  const [videoEnabled, setVideoEnabled] = useState(false);
  const studentPracticeEnabled = !!course?.allowStudentQuestions;
  const courseChatEnabled = !!course?.courseChatEnabled;
  const courseHasVideo = videoEnabled && !!(
    (course?.videoChatOptions && course.videoChatOptions.urlId)
    || (course?.groupCategories || []).some((cat) => cat.catVideoChatOptions && cat.catVideoChatOptions.urlId)
  );
  let nextTabIndex = 0;
  const lecturesTabIndex = nextTabIndex++;
  const quizzesTabIndex = nextTabIndex++;
  const practiceTabIndex = studentPracticeEnabled ? nextTabIndex++ : -1;
  const questionLibraryTabIndex = studentPracticeEnabled ? nextTabIndex++ : -1;
  const gradesTabIndex = nextTabIndex++;
  const chatTabIndex = courseChatEnabled ? nextTabIndex++ : -1;
  const aiChatTabIndex = studentAiChatAvailable ? nextTabIndex++ : -1;
  const videoTabIndex = courseHasVideo ? nextTabIndex++ : -1;
  const settingsTabIndex = nextTabIndex++;

  useEffect(() => {
    let mounted = true;
    apiClient.get(`/settings/jitsi-course/${id}`).then(({ data }) => {
      if (mounted) setVideoEnabled(!!data.enabled);
    }).catch(() => {
      if (mounted) setVideoEnabled(false);
    });
    return () => { mounted = false; };
  }, [id]);

  const fetchCourse = useCallback(async () => {
    try {
      const { data } = await apiClient.get(`/courses/${id}`);
      const nextCourse = data.course || data;
      let nextStudentAiChatAvailable = false;
      if (nextCourse.aiEnabled && nextCourse.aiStudentChatEnabled) {
        try {
          const aiResponse = await apiClient.get(`/ai/student/courses/${id}/config`);
          nextStudentAiChatAvailable = !!aiResponse.data?.enabled;
        } catch {
          nextStudentAiChatAvailable = false;
        }
      }
      setStudentAiChatAvailable(nextStudentAiChatAvailable);
      setCourse(nextCourse);
    } catch {
      setStudentAiChatAvailable(false);
      setMsg({ severity: 'error', text: t('student.course.failedLoadCourse') });
    } finally {
      setLoading(false);
    }
  }, [id]);

  const setCourseTab = useCallback((nextTab) => {
    setTab(nextTab);
    const nextParams = new URLSearchParams(searchParams);
    if (nextTab === lecturesTabIndex) {
      nextParams.delete('tab');
    } else {
      nextParams.set('tab', String(nextTab));
    }
    setSearchParams(nextParams, { replace: true });
  }, [lecturesTabIndex, searchParams, setSearchParams]);

  const fetchChatSummary = useCallback(async () => {
    if (!courseChatEnabled || tab === chatTabIndex) {
      setChatUnseenCount(0);
      return;
    }
    try {
      const { data } = await apiClient.get(`/courses/${id}/chat/summary`);
      setChatUnseenCount(Math.max(0, Number(data?.unseenCount || 0)));
    } catch {
      setChatUnseenCount(0);
    }
  }, [chatTabIndex, courseChatEnabled, id, tab]);

  useEffect(() => { fetchCourse(); }, [fetchCourse]);
  useEffect(() => { fetchChatSummary(); }, [fetchChatSummary]);

  const fetchSessionsPage = useCallback(async (page, limit = SESSION_PAGE_SIZE, { signal } = {}) => {
    const { data } = await apiClient.get(`/courses/${id}/sessions`, {
      params: { page, limit },
      signal,
    });
    return data;
  }, [id]);

  const recomputeLoadedSessionTypeCounts = useCallback((sessionItems) => {
    const nextCounts = getStudentSessionTypeCounts(sessionItems);
    setSessionTypeCounts(nextCounts);
  }, []);

  const upsertStudentSession = useCallback((previousSessions, nextSession) => {
    const targetId = String(nextSession?._id || '');
    if (!targetId) return previousSessions;
    const existingIndex = previousSessions.findIndex((session) => String(session?._id || '') === targetId);

    if (existingIndex === -1) {
      return [...previousSessions, nextSession];
    }

    return previousSessions.map((session, index) => (
      index === existingIndex
        ? { ...session, ...nextSession }
        : session
    ));
  }, []);

  const removeStudentSession = useCallback((previousSessions, sessionId) => (
    previousSessions.filter((session) => String(session?._id || '') !== String(sessionId || ''))
  ), []);

  const refreshSingleSession = useCallback(async (sessionId) => {
    if (!sessionId) return;
    try {
      const { data } = await apiClient.get(`/sessions/${sessionId}`);
      const nextSession = data?.session || data;
      if (!nextSession?._id) return;

      setSessions((previousSessions) => {
        const nextSessions = upsertStudentSession(previousSessions, nextSession);
        if (sessionsFullyLoadedRef.current) {
          recomputeLoadedSessionTypeCounts(nextSessions);
        }
        return nextSessions;
      });
    } catch (err) {
      const statusCode = Number(err?.response?.status || 0);
      if (statusCode === 403 || statusCode === 404) {
        setSessions((previousSessions) => {
          const nextSessions = removeStudentSession(previousSessions, sessionId);
          if (sessionsFullyLoadedRef.current) {
            recomputeLoadedSessionTypeCounts(nextSessions);
          }
          return nextSessions;
        });
      }
    }
  }, [recomputeLoadedSessionTypeCounts, removeStudentSession, upsertStudentSession]);

  const patchSessionStatusLocally = useCallback((sessionId, status) => {
    if (!sessionId || !status) return;

    if (status === 'hidden') {
      setSessions((previousSessions) => {
        const nextSessions = previousSessions.filter((session) => {
          if (String(session?._id || '') !== String(sessionId)) return true;
          return !!session?.studentCreated;
        });
        if (sessionsFullyLoadedRef.current) {
          recomputeLoadedSessionTypeCounts(nextSessions);
        }
        return nextSessions;
      });
      return;
    }

    setSessions((previousSessions) => previousSessions.map((session) => (
      String(session?._id || '') === String(sessionId)
        ? { ...session, status }
        : session
    )));
  }, [recomputeLoadedSessionTypeCounts]);

  const fetchSessions = useCallback(async () => {
    const fetchVersion = sessionFetchVersionRef.current + 1;
    sessionFetchVersionRef.current = fetchVersion;
    sessionsFullyLoadedRef.current = false;
    setSessionsLoading(true);
    setSessionsBackgroundLoading(false);
    sessionsAbortControllerRef.current?.abort();
    const controller = new AbortController();
    sessionsAbortControllerRef.current = controller;

    try {
      const firstPageData = await fetchSessionsPage(1, SESSION_PAGE_SIZE, { signal: controller.signal });
      if (sessionFetchVersionRef.current !== fetchVersion) return;

      const initialSessions = firstPageData.sessions || [];
      const totalSessions = Number(firstPageData.total) || initialSessions.length;
      const totalPages = Math.max(Number(firstPageData.pages) || 1, 1);
      const nextSessionTypeCounts = firstPageData.sessionTypeCounts
        ? {
          interactive: Number(firstPageData.sessionTypeCounts.interactive) || 0,
          quizzes: Number(firstPageData.sessionTypeCounts.quizzes) || 0,
          practice: Number(firstPageData.sessionTypeCounts.practice) || 0,
        }
        : getStudentSessionTypeCounts(initialSessions);

      setSessions(initialSessions);
      setSessionTotalCount(totalSessions);
      setSessionTypeCounts(nextSessionTypeCounts);
      setSessionsLoading(false);

      if (totalPages <= 1) {
        sessionsFullyLoadedRef.current = true;
        setSessionsBackgroundLoading(false);
        return;
      }

      setSessionsBackgroundLoading(true);
      const allLoadedSessions = [...initialSessions];
      const remainingPages = Array.from({ length: totalPages - 1 }, (_, index) => index + 2);

      for (let index = 0; index < remainingPages.length; index += SESSION_BACKGROUND_BATCH_SIZE) {
        const pageBatch = remainingPages.slice(index, index + SESSION_BACKGROUND_BATCH_SIZE);
        const batchResults = await Promise.all(
          pageBatch.map((page) => fetchSessionsPage(page, SESSION_PAGE_SIZE, { signal: controller.signal }))
        );
        if (sessionFetchVersionRef.current !== fetchVersion) return;

        const batchSessions = batchResults.flatMap((result) => result.sessions || []);
        if (batchSessions.length === 0) continue;

        allLoadedSessions.push(...batchSessions);
        setSessions([...allLoadedSessions]);
      }

      if (sessionFetchVersionRef.current !== fetchVersion) return;
      sessionsFullyLoadedRef.current = true;
      setSessionsBackgroundLoading(false);
    } catch (err) {
      if (isRequestCanceled(err) || controller.signal.aborted) return;
      if (sessionFetchVersionRef.current !== fetchVersion) return;
      sessionsFullyLoadedRef.current = false;
      setSessionTotalCount(0);
      setSessionTypeCounts({ interactive: 0, quizzes: 0, practice: 0 });
      setSessionsLoading(false);
      setSessionsBackgroundLoading(false);
    } finally {
      if (sessionsAbortControllerRef.current === controller) {
        sessionsAbortControllerRef.current = null;
      }
    }
  }, [fetchSessionsPage]);

  useEffect(() => {
    fetchSessions();
    return () => {
      sessionsAbortControllerRef.current?.abort();
      sessionsAbortControllerRef.current = null;
    };
  }, [fetchSessions]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    const urlTab = parseCourseTab(searchParams.get('tab'));
    setTab((currentTab) => (currentTab === urlTab ? currentTab : urlTab));
  }, [searchParams]);

  useEffect(() => {
    if (!courseChatEnabled || tab === chatTabIndex) {
      setChatUnseenCount(0);
    }
  }, [chatTabIndex, courseChatEnabled, tab]);

  // Latest-handler refs so the websocket effect below doesn't tear down and
  // reconnect the socket every time a callback identity or the active tab
  // changes — that mid-handshake close surfaced as a browser console error
  // on every course-page load.
  const handleWsEventRef = useRef(() => {});
  handleWsEventRef.current = (evt, d) => {
    if (String(d?.courseId || '') !== String(id)) return;
    if (evt === 'session:status-changed') {
      const hasSessionLoaded = sessionsRef.current
        .some((session) => String(session?._id || '') === String(d?.sessionId || ''));
      if (hasSessionLoaded) {
        patchSessionStatusLocally(d?.sessionId, d?.status);
      } else if (d?.status && d.status !== 'hidden') {
        refreshSingleSession(d?.sessionId).catch(() => {});
      }
    } else if (evt === 'session:metadata-changed'
      || evt === 'session:feedback-updated'
      || evt === 'session:quiz-submitted') {
      refreshSingleSession(d?.sessionId).catch(() => {});
    } else if (evt === 'course:chat-updated') {
      setChatRefreshToken((prev) => prev + 1);
      if (tab === chatTabIndex) {
        setChatUnseenCount(0);
        setChatEvent((prev) => ({ id: (prev?.id || 0) + 1, ...d }));
      } else {
        setChatUnseenCount((prev) => prev + getCourseChatEventUnseenDelta(d));
      }
    }
    if (evt === 'video:updated') {
      fetchCourse();
    }
  };
  const refreshSessionsRef = useRef(() => {});
  refreshSessionsRef.current = () => {
    fetchSessions();
    fetchChatSummary();
  };

  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let pollingTimer = null;
    let closed = false;

    const refreshSessions = () => {
      if (document.visibilityState !== 'visible') return;
      refreshSessionsRef.current();
    };

    const startPolling = () => {
      if (pollingTimer || closed) return;
      pollingTimer = setInterval(refreshSessions, 15000);
    };

    const stopPolling = () => {
      if (!pollingTimer) return;
      clearInterval(pollingTimer);
      pollingTimer = null;
    };

    const connect = async () => {
      if (closed) return;
      const latestToken = await getUsableAccessToken({ refreshIfMissing: true, refreshIfExpiring: true });
      if (!latestToken) return;
      try {
        ws = new WebSocket(buildWebsocketUrl(latestToken));
      } catch {
        startPolling();
        reconnectTimer = setTimeout(() => { void connect(); }, 2500);
        return;
      }

      ws.onopen = () => {
        stopPolling();
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (!message?.event) return;
          handleWsEventRef.current(message.event, message.data);
        } catch {
          // Ignore malformed websocket payloads.
        }
      };

      ws.onclose = () => {
        if (closed) return;
        startPolling();
        reconnectTimer = setTimeout(() => { void connect(); }, 2500);
      };
    };

    const initializeTransport = async () => {
      try {
        const { data } = await apiClient.get('/health');
        const websocketAvailable = data?.websocket === true;
        if (!websocketAvailable) {
          startPolling();
          return;
        }
        void connect();
      } catch {
        startPolling();
      }
    };

    initializeTransport();

    const handleVisibilityChange = () => refreshSessions();
    window.addEventListener('focus', refreshSessions);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPolling();
      closeWebSocketQuietly(ws);
      window.removeEventListener('focus', refreshSessions);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [id]);

  const handleUnenroll = async () => {
    setUnenrolling(true);
    try {
      await apiClient.delete(`/courses/${id}/students/${user._id}`);
      navigate('/student');
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('student.course.failedUnenroll') });
      setUnenrolling(false);
      setUnenrollOpen(false);
    }
  };

  // Redirect instructors/admins to the professor view of this course
  const shouldRedirectToInstructorView = useMemo(() => {
    if (!course) return false;
    return shouldRedirectStudentCourseToInstructorView(course, user);
  }, [course, user]);

  useEffect(() => {
    if (!shouldRedirectToInstructorView) return;
    navigate(`/prof/course/${id}`, { replace: true });
  }, [shouldRedirectToInstructorView, id, navigate]);

  useEffect(() => {
    if (!course) return;
    if (tab <= settingsTabIndex) return;
    setCourseTab(settingsTabIndex);
  }, [course, setCourseTab, settingsTabIndex, tab]);

  if (loading) return <Box sx={{ p: 3 }}><CircularProgress /></Box>;
  if (shouldRedirectToInstructorView) return <Box sx={{ p: 3 }}><CircularProgress aria-label={t('common.redirecting')} /></Box>;
  if (!course) return <Box sx={{ p: 3 }}><Alert severity="error">{t('student.course.courseNotFound')}</Alert></Box>;
  const sortedSessions = sortStudentSessions(sessions);
  const practiceSessions = sortedSessions.filter((session) => !!session.studentCreated && !!session.practiceQuiz);
  const interactiveSessions = sortedSessions.filter((session) => !isQuizSession(session) && !session.studentCreated);
  const quizSessions = sortedSessions.filter((session) => isQuizSession(session) && !session.studentCreated);
  const liveSessions = sortedSessions.filter((session) => session.status === 'running' && !session.studentCreated);
  const visibleLiveSessions = liveSessions.filter((session) => !isSubmittedLiveQuiz(session));
  const sessionCountsArePartial = sessionsBackgroundLoading && sessions.length < sessionTotalCount;
  const interactiveSessionCount = Number(sessionTypeCounts.interactive) || interactiveSessions.length;
  const quizSessionCount = Number(sessionTypeCounts.quizzes) || quizSessions.length;
  const practiceSessionCount = Number(sessionTypeCounts.practice) || practiceSessions.length;
  const headerTitle = buildCourseTitle(course, 'long');
  const headerSection = String(course.section || '').trim();

  const renderSessionListControls = ({
    listTabIndex,
    controlsVisible,
    controlsDisabled,
    controlsExpanded,
    searchTerm,
    statusFilter,
    pageSize,
    safePage,
    totalPages,
  }) => {
    if (!controlsVisible) return null;
    return (
      <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
        <Button
          color="inherit"
          onClick={() => setSessionControlsExpanded((prev) => ({ ...prev, [listTabIndex]: !controlsExpanded }))}
          aria-expanded={controlsExpanded}
          endIcon={controlsExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          sx={{ px: 0, py: 0, minWidth: 0, textTransform: 'none', fontWeight: 700 }}
        >
          {t('common.searchSessions', { defaultValue: 'Search sessions' })}
        </Button>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            mt: 0.5
          }}>
          {t('common.paginationSummary', {
            page: safePage,
            pages: totalPages,
            defaultValue: `Page ${safePage} of ${totalPages}`,
          })}
        </Typography>
        {controlsExpanded && (
          <Stack spacing={1.25} sx={{ mt: 1.25 }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' } }}>
              <TextField
                size="small"
                label={t('common.search')}
                placeholder={t('student.course.searchSessionsPlaceholder', { defaultValue: 'Search by session name' })}
                value={searchTerm}
                onChange={(event) => {
                  setSessionSearchTerms((prev) => ({ ...prev, [listTabIndex]: event.target.value }));
                  setSessionPages((prev) => ({ ...prev, [listTabIndex]: 1 }));
                }}
                disabled={controlsDisabled}
                sx={{ flexGrow: 1, minWidth: { xs: '100%', sm: 240 } }}
              />
              <TextField
                select
                size="small"
                label={t('common.status')}
                value={statusFilter}
                onChange={(event) => {
                  setSessionStatusFilters((prev) => ({ ...prev, [listTabIndex]: event.target.value }));
                  setSessionPages((prev) => ({ ...prev, [listTabIndex]: 1 }));
                }}
                disabled={controlsDisabled}
                sx={{ minWidth: { xs: '100%', sm: 150 } }}
              >
                {SESSION_STATUS_FILTER_OPTIONS.map((option) => (
                  <MenuItem key={`status-filter-${listTabIndex}-${option.value}`} value={option.value}>
                    {t(option.labelKey, { defaultValue: option.defaultLabel })}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                select
                size="small"
                label={t('common.rowsPerPage', { defaultValue: 'Rows per page' })}
                value={String(pageSize)}
                onChange={(event) => {
                  const nextPageSize = Number(event.target.value);
                  const safePageSize = SESSION_PAGE_SIZE_OPTIONS.includes(nextPageSize) ? nextPageSize : SESSION_PAGE_SIZE;
                  setSessionPageSizes((prev) => ({ ...prev, [listTabIndex]: safePageSize }));
                  setSessionPages((prev) => ({ ...prev, [listTabIndex]: 1 }));
                }}
                disabled={controlsDisabled}
                sx={{ minWidth: { xs: '100%', sm: 136 } }}
              >
                {SESSION_PAGE_SIZE_OPTIONS.map((option) => (
                  <MenuItem key={`page-size-${listTabIndex}-${option}`} value={String(option)}>
                    {option}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  disabled={controlsDisabled || safePage <= 1}
                  onClick={() => setSessionPages((prev) => ({ ...prev, [listTabIndex]: safePage - 1 }))}
                >
                  {t('common.previous')}
                </Button>
                <Button
                  size="small"
                  disabled={controlsDisabled || safePage >= totalPages}
                  onClick={() => setSessionPages((prev) => ({ ...prev, [listTabIndex]: safePage + 1 }))}
                >
                  {t('common.next')}
                </Button>
              </Stack>
            </Box>
          </Stack>
        )}
      </Paper>
    );
  };

  const renderSessionListPagination = ({
    listTabIndex,
    controlsVisible,
    controlsDisabled,
    safePage,
    totalPages,
    showFooter,
  }) => {
    if (!controlsVisible || totalPages <= 1 || !showFooter) return null;
    return (
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 2, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="body2" sx={{
          color: "text.secondary"
        }}>
          {t('common.paginationSummary', {
            page: safePage,
            pages: totalPages,
            defaultValue: `Page ${safePage} of ${totalPages}`,
          })}
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            disabled={controlsDisabled || safePage <= 1}
            onClick={() => setSessionPages((prev) => ({ ...prev, [listTabIndex]: safePage - 1 }))}
          >
            {t('common.previous')}
          </Button>
          <Button
            size="small"
            disabled={controlsDisabled || safePage >= totalPages}
            onClick={() => setSessionPages((prev) => ({ ...prev, [listTabIndex]: safePage + 1 }))}
          >
            {t('common.next')}
          </Button>
        </Stack>
      </Box>
    );
  };

  const renderSessionList = (sessionItems, emptyText, listTabIndex = 0, totalItemCount = sessionItems.length) => {
    const listStillHydrating = sessionCountsArePartial;
    if (sessionsLoading && sessions.length === 0) return <CircularProgress size={24} />;

    const controlsVisible = totalItemCount > 0;
    const controlsDisabled = listStillHydrating;
    const controlsExpanded = controlsVisible && sessionControlsExpanded[listTabIndex] !== false;
    const searchTerm = controlsVisible ? String(sessionSearchTerms[listTabIndex] || '') : '';
    const normalizedSearchTerm = controlsDisabled ? '' : normalizeSessionSearchValue(searchTerm);
    const statusFilter = controlsVisible
      ? String(sessionStatusFilters[listTabIndex] || SESSION_STATUS_FILTER_ALL)
      : SESSION_STATUS_FILTER_ALL;

    const filteredSessionItems = controlsVisible && !controlsDisabled
      ? sessionItems.filter((session) => {
        const matchesSearch = !normalizedSearchTerm
          || String(session?.name || '').toLowerCase().includes(normalizedSearchTerm);
        const matchesStatus = matchesStudentSessionStatus(session, statusFilter);
        return matchesSearch && matchesStatus;
      })
      : sessionItems;

    const rawPageSize = controlsVisible
      ? Number(sessionPageSizes[listTabIndex] || SESSION_PAGE_SIZE)
      : SESSION_PAGE_SIZE;
    const pageSize = SESSION_PAGE_SIZE_OPTIONS.includes(rawPageSize) ? rawPageSize : SESSION_PAGE_SIZE;
    const currentPage = sessionPages[listTabIndex] || 1;
    const totalPages = Math.max(Math.ceil((controlsDisabled ? totalItemCount : filteredSessionItems.length) / pageSize), 1);
    const safePage = controlsDisabled ? 1 : Math.min(currentPage, totalPages);
    const startIdx = (safePage - 1) * pageSize;
    const pageItems = controlsDisabled
      ? sessionItems.slice(0, pageSize)
      : filteredSessionItems.slice(startIdx, startIdx + pageSize);
    const hasNoLoadedItems = sessionItems.length === 0;

    return (
      <>
        {renderSessionListControls({
          listTabIndex,
          controlsVisible,
          controlsDisabled,
          controlsExpanded,
          searchTerm,
          statusFilter,
          pageSize,
          safePage,
          totalPages,
        })}
        {listStillHydrating && pageItems.length === 0 && (
          <Paper variant="outlined" sx={{ p: 1.25, mb: hasNoLoadedItems ? 0 : 1.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <CircularProgress size={16} />
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                {t('student.course.loadingRemainingSessions', {
                  defaultValue: 'Loading remaining sessions in the background…',
                })}
              </Typography>
            </Stack>
          </Paper>
        )}
        {hasNoLoadedItems ? (
          !listStillHydrating ? (
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>{emptyText}</Typography>
          ) : null
        ) : filteredSessionItems.length === 0 ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t('student.course.noSessionsMatchFilters', { defaultValue: 'No sessions match the current filters.' })}
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            {pageItems.map((s) => {
              const action = getStudentSessionAction(s, id, listTabIndex);
              const clickable = action.clickable && !!action.path;
              const submittedLiveQuiz = isSubmittedLiveQuiz(s);
              return (
                <SessionListCard
                  key={s._id}
                  highlighted={s.status === 'running' && !submittedLiveQuiz}
                  onClick={clickable ? () => navigate(action.path) : undefined}
                  disabled={!clickable}
                  sx={submittedLiveQuiz ? {
                    bgcolor: 'action.disabledBackground',
                    borderColor: 'divider',
                    opacity: 0.76,
                    '&:hover': {
                      bgcolor: 'action.disabledBackground',
                    },
                  } : undefined}
                  title={s.name}
                  badges={(
                    <>
                      <SessionStatusChip status={s.status} />
                      {s.hasNewFeedback && (
                        <Chip
                          label={t('student.course.newFeedback')}
                          size="small"
                          color="warning"
                          variant="filled"
                          sx={COMPACT_CHIP_SX}
                        />
                      )}
                      {s.status === 'done' && !s.reviewable && (
                        <Chip
                          label={t('student.course.notReviewable')}
                          size="small"
                          variant="outlined"
                          color="default"
                          sx={COMPACT_CHIP_SX}
                        />
                      )}
                      {s.practiceQuiz && <Chip label={t('student.course.practice')} size="small" variant="outlined" sx={COMPACT_CHIP_SX} />}
                      {s.anonymous && <Chip label={t('sessionAnonymity.chip')} size="small" variant="outlined" color="info" sx={COMPACT_CHIP_SX} />}
                      {action.label && (
                        <Chip
                          label={t(action.label)}
                          size="small"
                          color={action.chipColor}
                          variant={action.chipVariant}
                          sx={COMPACT_CHIP_SX}
                        />
                      )}
                    </>
                  )}
                  subtitle={buildSessionSubtitle(s, t)}
                />
              );
            })}
          </Box>
        )}
        {renderSessionListPagination({
          listTabIndex,
          controlsVisible,
          controlsDisabled,
          safePage,
          totalPages,
          showFooter: pageItems.length > 0 || listStillHydrating,
        })}
      </>
    );
  };

  const deletePracticeSession = async (sessionId) => {
    if (!window.confirm(t('student.course.deletePracticeSessionConfirm', { defaultValue: 'Delete this practice session?' }))) {
      return;
    }
    try {
      await apiClient.delete(`/sessions/${sessionId}`);
      await fetchSessions();
    } catch (err) {
      setMsg({
        severity: 'error',
        text: err.response?.data?.message || t('student.course.failedDeletePracticeSession', { defaultValue: 'Failed to delete practice session.' }),
      });
    }
  };

  return (
    <Box sx={{ p: 2.5, maxWidth: 980 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {headerTitle}
          </Typography>
          {headerSection && (
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>
              {t('student.course.sectionHeader', { section: headerSection })}
            </Typography>
          )}
        </Box>
      </Box>

      {visibleLiveSessions.length > 0 && (
        <Box sx={{ mb: 2.5 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
            {t('dashboard.liveSessions')}
          </Typography>
          <Box sx={{ display: 'grid', gap: 1.25, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {visibleLiveSessions.map((session) => {
              const action = getStudentSessionAction(session, id, tab);
              return (
                <SessionListCard
                  key={`live-course-${session._id}`}
                  highlighted
                  onClick={action.clickable && action.path ? () => navigate(action.path) : undefined}
                  disabled={!action.clickable || !action.path}
                  title={<Typography variant="body1" sx={{ fontWeight: 700 }}>{session.name}</Typography>}
                  subtitle={buildSessionSubtitle(session, t)}
                  badges={(
                    <>
                      <SessionStatusChip status={session.status} />
                      {session.anonymous ? (
                        <Chip label={t('sessionAnonymity.chip')} size="small" variant="outlined" color="info" sx={COMPACT_CHIP_SX} />
                      ) : null}
                      {action.label ? (
                        <Chip
                          label={t(action.label)}
                          size="small"
                          color={action.chipColor}
                          variant={action.chipVariant}
                          sx={COMPACT_CHIP_SX}
                        />
                      ) : null}
                    </>
                  )}
                />
              );
            })}
          </Box>
        </Box>
      )}

      <ResponsiveTabsNavigation
        value={tab}
        onChange={(nextTab) => {
          setCourseTab(nextTab);
        }}
        ariaLabel={t('common.view')}
        dropdownLabel={t('common.view')}
        wrap
        dropdownSx={{ mb: 1.5 }}
        tabs={[
          { value: lecturesTabIndex, label: `${t('student.course.lectures')} (${interactiveSessionCount})` },
          { value: quizzesTabIndex, label: `${t('student.course.quizzes')} (${quizSessionCount})` },
          ...(studentPracticeEnabled ? [
            { value: practiceTabIndex, label: `${t('student.course.practiceSessions', { defaultValue: 'Practice Sessions' })} (${practiceSessionCount})` },
            { value: questionLibraryTabIndex, label: t('questionLibrary.title', { defaultValue: 'Question Library' }) },
          ] : []),
          { value: gradesTabIndex, label: t('student.course.grades') },
          ...(courseChatEnabled ? [{
            value: chatTabIndex,
            label: (
              <Badge color="error" badgeContent={chatUnseenCount} invisible={chatUnseenCount <= 0}>
                <span>{t('courseChat.title')}</span>
              </Badge>
            ),
            menuLabel: chatUnseenCount > 0
              ? t('courseChat.titleWithUnseen', { count: chatUnseenCount })
              : t('courseChat.title'),
            tabProps: {
              'aria-label': chatUnseenCount > 0
                ? t('courseChat.titleWithUnseen', { count: chatUnseenCount })
                : t('courseChat.title'),
            },
          }] : []),
          ...(studentAiChatAvailable ? [{ value: aiChatTabIndex, label: t('ai.chat.title') }] : []),
          ...(courseHasVideo ? [{ value: videoTabIndex, label: t('student.course.video') }] : []),
          { value: settingsTabIndex, label: t('student.course.settings') },
        ]}
        tabsProps={{
          variant: 'scrollable',
          scrollButtons: 'auto',
          allowScrollButtonsMobile: true,
          sx: {
            mb: 0.5,
          },
        }}
      />

      <TabPanel value={tab} index={lecturesTabIndex}>
        <Typography variant="h6" sx={{ mb: 2 }}>{t('student.course.lectures')}</Typography>
        {renderSessionList(interactiveSessions, t('student.course.noLectures'), lecturesTabIndex, interactiveSessionCount)}
      </TabPanel>

      <TabPanel value={tab} index={quizzesTabIndex}>
        <Typography variant="h6" sx={{ mb: 2 }}>{t('student.course.quizzes')}</Typography>
        {renderSessionList(quizSessions, t('student.course.noQuizzes'), quizzesTabIndex, quizSessionCount)}
      </TabPanel>

      {studentPracticeEnabled && (
        <TabPanel value={tab} index={practiceTabIndex}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 2 }}>
          <Typography variant="h6">{t('student.course.practiceSessions', { defaultValue: 'Practice Sessions' })}</Typography>
          <Button variant="contained" onClick={() => navigate(`/student/course/${id}/practice-sessions/new`)}>
            {t('student.course.newPracticeSession', { defaultValue: 'New practice session' })}
          </Button>
        </Box>
        {sessionsLoading && sessions.length === 0 ? <CircularProgress size={24} /> : (() => {
          const listStillHydrating = sessionCountsArePartial;
          const controlsVisible = practiceSessionCount > SESSION_PAGE_SIZE;
          const controlsDisabled = listStillHydrating;
          const searchTerm = controlsVisible ? String(sessionSearchTerms[practiceTabIndex] || '') : '';
          const normalizedSearchTerm = controlsDisabled ? '' : normalizeSessionSearchValue(searchTerm);
          const statusFilter = controlsVisible
            ? String(sessionStatusFilters[practiceTabIndex] || SESSION_STATUS_FILTER_ALL)
            : SESSION_STATUS_FILTER_ALL;

          const filteredPracticeSessions = controlsVisible && !controlsDisabled
            ? practiceSessions.filter((session) => {
              const matchesSearch = !normalizedSearchTerm
                || String(session?.name || '').toLowerCase().includes(normalizedSearchTerm);
              const matchesStatus = matchesStudentSessionStatus(session, statusFilter);
              return matchesSearch && matchesStatus;
            })
            : practiceSessions;

          const rawPageSize = controlsVisible
            ? Number(sessionPageSizes[practiceTabIndex] || SESSION_PAGE_SIZE)
            : SESSION_PAGE_SIZE;
          const pageSize = SESSION_PAGE_SIZE_OPTIONS.includes(rawPageSize) ? rawPageSize : SESSION_PAGE_SIZE;
          const currentPage = sessionPages[practiceTabIndex] || 1;
          const totalPages = Math.max(Math.ceil((controlsDisabled ? practiceSessionCount : filteredPracticeSessions.length) / pageSize), 1);
          const safePage = controlsDisabled ? 1 : Math.min(currentPage, totalPages);
          const startIdx = (safePage - 1) * pageSize;
          const pageItems = controlsDisabled
            ? practiceSessions.slice(0, pageSize)
            : filteredPracticeSessions.slice(startIdx, startIdx + pageSize);
          const hasNoLoadedItems = practiceSessions.length === 0;

          return (
            <>
              {renderSessionListControls({
                listTabIndex: practiceTabIndex,
                controlsVisible,
                controlsDisabled,
                searchTerm,
                statusFilter,
                pageSize,
                safePage,
                totalPages,
              })}
              {listStillHydrating && pageItems.length === 0 && (
                <Paper variant="outlined" sx={{ p: 1.25, mb: hasNoLoadedItems ? 0 : 1.5 }}>
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <CircularProgress size={16} />
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      {t('student.course.loadingRemainingSessions', {
                        defaultValue: 'Loading remaining sessions in the background…',
                      })}
                    </Typography>
                  </Stack>
                </Paper>
              )}
              {hasNoLoadedItems ? (
                !listStillHydrating ? (
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    {t('student.course.noPracticeSessions', { defaultValue: 'No practice sessions yet.' })}
                  </Typography>
                ) : null
              ) : filteredPracticeSessions.length === 0 ? (
                <Typography variant="body2" sx={{
                  color: "text.secondary"
                }}>
                  {t('student.course.noSessionsMatchFilters', { defaultValue: 'No sessions match the current filters.' })}
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                  {pageItems.map((session) => {
                    const action = getStudentSessionAction(session, id, practiceTabIndex);
                    return (
                      <SessionListCard
                        key={session._id}
                        title={session.name}
                        onClick={action.path ? () => navigate(action.path) : undefined}
                        subtitle={buildSessionSubtitle(session, t)}
                        badges={(
                          <>
                            <Chip label={t('student.course.practice', { defaultValue: 'Practice' })} size="small" variant="outlined" sx={COMPACT_CHIP_SX} />
                            {action.label ? (
                              <Chip
                                label={t(action.label)}
                                size="small"
                                color={action.chipColor}
                                variant={action.chipVariant}
                                sx={COMPACT_CHIP_SX}
                              />
                            ) : null}
                          </>
                        )}
                        actions={(
                          <>
                            <Tooltip title={t('common.edit')}>
                              <span>
                                <IconButton
                                  size="small"
                                  aria-label={t('common.edit')}
                                  onClick={() => navigate(`/student/course/${id}/practice-sessions/${session._id}`)}
                                >
                                  <EditIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                            <Tooltip title={t('common.delete')}>
                              <span>
                                <IconButton
                                  size="small"
                                  color="error"
                                  aria-label={t('common.delete')}
                                  onClick={() => deletePracticeSession(session._id)}
                                >
                                  <DeleteIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          </>
                        )}
                      />
                    );
                  })}
                </Box>
              )}
              {renderSessionListPagination({
                listTabIndex: practiceTabIndex,
                controlsVisible,
                controlsDisabled,
                safePage,
                totalPages,
                showFooter: pageItems.length > 0 || listStillHydrating,
              })}
            </>
          );
        })()}
        </TabPanel>
      )}

      {studentPracticeEnabled && (
        <TabPanel value={tab} index={questionLibraryTabIndex}>
          <Suspense fallback={<Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}><CircularProgress /></Box>}>
            <QuestionLibraryPanel
              courseId={id}
              currentCourse={course}
              availableSessions={sortedSessions}
              allowQuestionCreate
              permissionMode="student"
            />
          </Suspense>
        </TabPanel>
      )}

      <TabPanel value={tab} index={gradesTabIndex}>
        <Typography variant="h6" sx={{ mb: 1.5 }}>{t('student.course.grades')}</Typography>
        <CourseGradesPanel
          courseId={id}
          instructorView={false}
          onOpenSession={(sessionReviewId) => navigate(`/student/course/${id}/session/${sessionReviewId}/review?returnTab=${gradesTabIndex}`)}
        />
      </TabPanel>

      {courseChatEnabled && (
        <TabPanel value={tab} index={chatTabIndex}>
          <Suspense fallback={<Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}><CircularProgress /></Box>}>
            <CourseChatPanel
              courseId={id}
              enabled={courseChatEnabled}
              role="student"
              syncTransport="unknown"
              refreshToken={chatRefreshToken}
              chatEvent={chatEvent}
            />
          </Suspense>
        </TabPanel>
      )}

      {studentAiChatAvailable && (
        <TabPanel value={tab} index={aiChatTabIndex}>
          <AiCourseChat courseId={id} audience="student" />
        </TabPanel>
      )}

      {courseHasVideo && (
        <TabPanel value={tab} index={videoTabIndex}>
          <Typography variant="h6" sx={{ mb: 1.5 }}>{t('video.title')}</Typography>
          <VideoChatPanel
            courseId={id}
            course={course}
            isStudent
            onCourseRefresh={fetchCourse}
          />
        </TabPanel>
      )}

      <TabPanel value={tab} index={settingsTabIndex}>
        <Typography variant="h6" sx={{ mb: 1.5 }}>{t('student.course.courseSettings')}</Typography>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mb: 1.25
            }}>
            {t('student.course.manageEnrollment')}
          </Typography>
          <Button variant="outlined" color="error" onClick={() => setUnenrollOpen(true)}>
            {t('student.course.unenroll')}
          </Button>
        </Paper>
      </TabPanel>

      {/* Unenroll Confirmation */}
      <Dialog open={unenrollOpen} onClose={() => setUnenrollOpen(false)}>
        <DialogTitle>{t('student.course.unenrollConfirm')}</DialogTitle>
        <DialogContent>
          {t('student.course.unenrollMessage', { name: course.name })}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUnenrollOpen(false)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" onClick={handleUnenroll} disabled={unenrolling}>
            {unenrolling ? t('student.course.unenrolling') : t('student.course.unenroll')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)}>
        {msg ? <Alert severity={msg.severity} onClose={() => setMsg(null)}>{msg.text}</Alert> : undefined}
      </Snackbar>
    </Box>
  );
}
