import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, Paper, Alert, Snackbar, CircularProgress, Chip,
  Dialog, DialogTitle, DialogContent, DialogActions, IconButton, Tooltip,
  Switch, FormControlLabel, TextField, Divider, useMediaQuery,
  Radio, RadioGroup, FormControl, FormLabel, Collapse, InputAdornment,
} from '@mui/material';
import {
  ArrowBack as PrevIcon, ArrowForward as NextIcon,
  Stop as StopIcon, OpenInNew as OpenInNewIcon,
  Check as CheckIcon,
  Edit as EditIcon,
  ExpandLess as ExpandLessIcon,
  ExpandMore as ExpandMoreIcon,
  Replay as AttemptIcon,
  Refresh as RefreshIcon,
  VisibilityOff as VisibilityOffIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import apiClient from '../../api/client';
import {
  QUESTION_TYPES,
  getQuestionTypeLabel,
  isOptionBasedQuestionType,
  isSlideType,
  normalizeQuestionType,
} from '../../components/questions/constants';
import {
  normalizeStoredHtml,
  prepareRichTextInput,
  renderKatexInElement,
} from '../../components/questions/richTextUtils';
import { buildCourseTitle } from '../../utils/courseTitle';
import { useTranslation } from 'react-i18next';
import BackLinkButton from '../../components/common/BackLinkButton';
import SessionChatPanel from '../../components/live/SessionChatPanel';
import { buildReviewableWarningMessage } from '../../utils/reviewableToggle';
import LiveSessionPanelNavigation from '../../components/live/LiveSessionPanelNavigation';
import StudentIdentity from '../../components/common/StudentIdentity';
import WordCloudPanel from '../../components/questions/WordCloudPanel';
import HistogramPanel from '../../components/questions/HistogramPanel';
import {
  LiveSessionWebSocketProvider,
  useLiveSessionWebSocket,
} from '../../contexts/LiveSessionWebSocketContext';
import useLiveSessionTelemetry from '../../hooks/useLiveSessionTelemetry';
import { applyLiveResponseAddedDelta, sortResponsesNewestFirst } from '../../utils/responses';
import { filterStudentsByIdentity } from '../../utils/studentFiltering';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const COMPACT_CHIP_SX = {
  borderRadius: 1.4,
  '& .MuiChip-label': { px: 1.15 },
};

const SESSION_NAV_CHIP_SX = {
  borderRadius: 1.4,
  minWidth: { xs: 48, sm: 44 },
  height: { xs: 38, sm: 32 },
  '& .MuiChip-label': {
    px: { xs: 1.25, sm: 1.1 },
    fontWeight: 600,
    fontSize: { xs: '0.9rem', sm: '0.8rem' },
  },
};

const CONTROL_TOGGLE_LABEL_SX = {
  m: 0,
  width: '100%',
  minHeight: { xs: 46, sm: 40 },
  px: 1.15,
  py: { xs: 0.25, sm: 0.1 },
  borderRadius: 1,
  justifyContent: 'space-between',
  alignItems: 'center',
  '& .MuiFormControlLabel-label': {
    fontSize: { xs: '0.9rem', sm: '0.875rem' },
    lineHeight: 1.2,
    marginRight: 8,
    overflowWrap: 'anywhere',
  },
  '& .MuiSwitch-root': {
    mr: 0,
    ml: 0.5,
  },
};

const SESSION_CHAT_TOGGLE_LABEL_SX = {
  minHeight: { xs: 44, sm: 40 },
  m: 0,
  width: { xs: '100%', sm: 'fit-content' },
  maxWidth: '100%',
  px: 1.15,
  py: { xs: 0.25, sm: 0.1 },
  borderRadius: 1,
  justifyContent: 'flex-start',
  alignItems: 'center',
  columnGap: 1,
  '& .MuiFormControlLabel-label': {
    fontSize: { xs: '0.9rem', sm: '0.875rem' },
    lineHeight: 1.2,
    marginRight: 0,
    overflowWrap: 'anywhere',
  },
  '& .MuiSwitch-root': {
    mr: 0,
    ml: 0,
    flexShrink: 0,
  },
};

const SR_ONLY_SX = {
  position: 'absolute',
  width: 1,
  height: 1,
  p: 0,
  m: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function getOptionRichContentProps(option) {
  return {
    html: normalizeStoredHtml(option?.content || ''),
    fallback: option?.plainText || option?.answer || '',
  };
}

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function applyCurrentQuestionUpdate(prev, payload) {
  if (!prev) return prev;

  const nextQuestionId = String(payload?.questionId || '');
  const currentQuestionId = String(prev?.currentQuestion?._id || prev?.session?.currentQuestion || '');
  if (!nextQuestionId || currentQuestionId !== nextQuestionId || !payload?.question) {
    return prev;
  }

  return {
    ...prev,
    currentQuestion: payload.question,
  };
}

function getCurrentAttemptFromQuestion(question) {
  const attempts = Array.isArray(question?.sessionOptions?.attempts)
    ? question.sessionOptions.attempts
    : [];
  if (attempts.length === 0) return null;
  const latestAttempt = attempts[attempts.length - 1];
  return {
    number: Number(latestAttempt?.number) || 1,
    closed: !!latestAttempt?.closed,
  };
}

function replaceCurrentQuestion(prev, question) {
  if (!prev || !question?._id) return prev;

  const nextQuestionId = String(question._id || '');
  const currentQuestionId = String(prev?.currentQuestion?._id || prev?.session?.currentQuestion || '');
  if (!nextQuestionId || currentQuestionId !== nextQuestionId) {
    return prev;
  }

  const nextAttempt = getCurrentAttemptFromQuestion(question);

  return {
    ...prev,
    currentQuestion: question,
    currentAttempt: nextAttempt ?? prev.currentAttempt,
  };
}

function applyQuestionChanged(prev, payload) {
  if (!prev || !Object.prototype.hasOwnProperty.call(payload || {}, 'question')) return prev;
  return {
    ...prev,
    session: prev.session
      ? { ...prev.session, currentQuestion: payload?.questionId ?? prev.session.currentQuestion }
      : prev.session,
    currentQuestion: payload.question,
    currentAttempt: payload?.currentAttempt ?? null,
    responseStats: payload?.responseStats ?? null,
    responseCount: payload?.responseCount ?? 0,
    allResponses: payload?.allResponses ?? [],
    wordCloudData: payload?.wordCloudData ?? null,
    histogramData: payload?.histogramData ?? null,
    questionNumber: payload?.questionNumber ?? prev.questionNumber,
    questionCount: payload?.questionCount ?? prev.questionCount,
    pageProgress: payload?.pageProgress ?? prev.pageProgress,
    questionProgress: payload?.questionProgress ?? prev.questionProgress,
  };
}

function applyVisibilityChanged(prev, payload) {
  if (!prev) return prev;

  const nextQuestionId = String(payload?.questionId || '');
  const currentQuestionId = String(prev?.currentQuestion?._id || prev?.session?.currentQuestion || '');
  if (!nextQuestionId || currentQuestionId !== nextQuestionId || !prev.currentQuestion) {
    return prev;
  }

  return {
    ...prev,
    currentQuestion: {
      ...prev.currentQuestion,
      sessionOptions: {
        ...(prev.currentQuestion.sessionOptions || {}),
        hidden: payload?.hidden ?? prev.currentQuestion?.sessionOptions?.hidden,
        stats: payload?.stats ?? prev.currentQuestion?.sessionOptions?.stats,
        correct: payload?.correct ?? prev.currentQuestion?.sessionOptions?.correct,
        responseListVisible: payload?.responseListVisible ?? prev.currentQuestion?.sessionOptions?.responseListVisible,
      },
    },
  };
}

function applyParticipantJoined(prev, payload) {
  if (!prev?.session) return prev;

  const joinedStudent = payload?.joinedStudent;
  const joinedStudentId = String(joinedStudent?._id || '');
  const previousJoinedStudents = Array.isArray(prev.session.joinedStudents) ? prev.session.joinedStudents : [];
  const nextJoinedStudents = joinedStudentId
    ? [
      ...previousJoinedStudents.filter((student) => String(student?._id || '') !== joinedStudentId),
      joinedStudent,
    ]
    : previousJoinedStudents;
  const previousJoined = Array.isArray(prev.session.joined) ? prev.session.joined : [];
  const nextJoined = joinedStudentId && !previousJoined.some((id) => String(id) === joinedStudentId)
    ? [...previousJoined, joinedStudentId]
    : previousJoined;

  return {
    ...prev,
    session: {
      ...prev.session,
      joinedCount: payload?.joinedCount ?? prev.session.joinedCount,
      joined: nextJoined,
      joinedStudents: nextJoinedStudents,
    },
  };
}

function applyAttemptChanged(prev, payload) {
  if (!prev) return prev;

  const nextQuestionId = String(payload?.questionId || '');
  const currentQuestionId = String(prev?.currentQuestion?._id || prev?.session?.currentQuestion || '');
  if (!nextQuestionId || currentQuestionId !== nextQuestionId) {
    return prev;
  }

  const previousAttemptNumber = prev?.currentAttempt?.number ?? null;
  const nextAttemptNumber = payload?.currentAttempt?.number ?? previousAttemptNumber;
  const resetResponses = !!payload?.resetResponses || nextAttemptNumber !== previousAttemptNumber;

  return {
    ...prev,
    currentAttempt: payload?.currentAttempt ?? prev.currentAttempt,
    currentQuestion: prev.currentQuestion
      ? {
        ...prev.currentQuestion,
        sessionOptions: {
          ...(prev.currentQuestion.sessionOptions || {}),
          stats: payload?.stats ?? prev.currentQuestion?.sessionOptions?.stats,
          correct: payload?.correct ?? prev.currentQuestion?.sessionOptions?.correct,
        },
      }
      : prev.currentQuestion,
    responseCount: resetResponses ? 0 : prev.responseCount,
    responseStats: resetResponses ? null : prev.responseStats,
    allResponses: resetResponses ? [] : prev.allResponses,
  };
}

function applyJoinCodeChanged(prev, payload) {
  if (!prev?.session) return prev;
  return {
    ...prev,
    session: {
      ...prev.session,
      joinCodeEnabled: payload?.joinCodeEnabled ?? prev.session.joinCodeEnabled,
      joinCodeActive: payload?.joinCodeActive ?? prev.session.joinCodeActive,
      joinCodeInterval: payload?.joinCodeInterval ?? prev.session.joinCodeInterval,
      currentJoinCode: payload?.currentJoinCode ?? prev.session.currentJoinCode,
    },
  };
}

function mergeSessionUpdate(prev, sessionPatch) {
  if (!prev?.session || !sessionPatch?._id) return prev;
  if (String(prev.session._id || '') !== String(sessionPatch._id || '')) return prev;
  return {
    ...prev,
    session: {
      ...prev.session,
      ...sessionPatch,
    },
  };
}

function formatJoinedTimestamp(value, fallbackLabel) {
  if (!value) return fallbackLabel;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallbackLabel;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Renders rich-text question content with KaTeX math support. */
function RichContent({ html, fallback, allowVideoEmbeds = false }) {
  const ref = useRef(null);
  const prepared = prepareRichTextInput(html || '', fallback || '', { allowVideoEmbeds });
  const innerHtml = useMemo(() => ({ __html: prepared }), [prepared]);

  useLayoutEffect(() => {
    if (ref.current) renderKatexInElement(ref.current);
  }, [prepared]);

  if (!prepared) return null;
  return (
    <Box
      ref={ref}
      sx={{ '& p': { my: 0.5 }, '& img': { maxWidth: '100%' } }}
      dangerouslySetInnerHTML={innerHtml}
    />
  );
}

/** Short-answer responses list (rendered rich text). */
function ShortAnswerList({ responses, showStudentNames = false }) {
  const { t } = useTranslation();
  const sortedResponses = sortResponsesNewestFirst(responses);
  if (!sortedResponses.length) {
    return (
      <Typography variant="body2" sx={{
        color: "text.secondary"
      }}>{t('professor.liveSession.noResponsesYet')}</Typography>
    );
  }
  return (
    <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
      {sortedResponses.map((r, i) => (
        <Paper key={i} variant="outlined" sx={{ p: 1, mb: 0.5 }}>
          {showStudentNames && (
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
                display: 'block',
                mb: 0.5
              }}>
              {r.studentName || t('common.unknown')}
            </Typography>
          )}
          {r.answerWysiwyg ? (
            <RichContent html={r.answerWysiwyg} />
          ) : (
            <Typography variant="body2">{r.answer ?? r.value ?? r.text ?? t('common.noAnswer')}</Typography>
          )}
        </Paper>
      ))}
    </Box>
  );
}

/** Numerical statistics display with histogram. */
function NumericalStats({ stats }) {
  const { t } = useTranslation();
  if (!stats) {
    return (
      <Typography variant="body2" sx={{
        color: "text.secondary"
      }}>{t('professor.liveSession.noResponsesYet')}</Typography>
    );
  }

  const entries = [
    { label: t('common.count'), value: stats.total ?? stats.count ?? 0 },
    { label: t('professor.secondDesktop.mean'), value: stats.mean != null ? Number(stats.mean).toFixed(2) : '—' },
    { label: t('professor.secondDesktop.stdev'), value: stats.stdev != null ? Number(stats.stdev).toFixed(2) : '—' },
    { label: t('professor.secondDesktop.median'), value: stats.median != null ? Number(stats.median).toFixed(2) : '—' },
    { label: t('professor.secondDesktop.min'), value: stats.min != null ? Number(stats.min).toFixed(2) : '—' },
    { label: t('professor.secondDesktop.max'), value: stats.max != null ? Number(stats.max).toFixed(2) : '—' },
  ];
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
      {entries.map((e) => (
        <Paper key={e.label} variant="outlined" sx={{ p: 1.5, minWidth: 90, textAlign: 'center' }}>
          <Typography variant="caption" sx={{
            color: "text.secondary"
          }}>{e.label}</Typography>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>{e.value}</Typography>
        </Paper>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function LiveSessionContent() {
  const { courseId, sessionId } = useParams();
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width:768px)');
  const { t } = useTranslation();
  const { lastEvent, registerRefreshHandler, transport } = useLiveSessionWebSocket();
  const {
    recordEventReceipt,
    recordLiveFetch,
    scheduleUiSyncMeasurement,
  } = useLiveSessionTelemetry({ sessionId, role: 'professor', transport });

  // Core state
  const [liveData, setLiveData] = useState(null);
  const [activityCode, setActivityCode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [pendingActionKey, setPendingActionKey] = useState(null);
  const [unjoinedStudentsExpanded, setUnjoinedStudentsExpanded] = useState(true);
  const [unjoinedStudentsFilter, setUnjoinedStudentsFilter] = useState('');

  // End session dialog
  const [endDialogOpen, setEndDialogOpen] = useState(false);
  const [makeReviewable, setMakeReviewable] = useState(false);
  const [ending, setEnding] = useState(false);
  const [nonAutoGradeableWarning, setNonAutoGradeableWarning] = useState(null);
  const [reviewableOption, setReviewableOption] = useState('proceed'); // 'proceed', 'zero', 'cancel'

  const [joinCodeIntervalInput, setJoinCodeIntervalInput] = useState('10');
  const [activePanel, setActivePanel] = useState('question');
  const [chatRefreshToken, setChatRefreshToken] = useState(0);
  const [chatEvent, setChatEvent] = useState(null);
  const [chatUnseenCount, setChatUnseenCount] = useState(0);
  const activePanelRef = useRef('question');
  const pendingChatRefreshRef = useRef(false);

  // Join code refresh interval ref
  const joinCodeTimerRef = useRef(null);

  // --------------------------------------------------
  // Data fetching
  // --------------------------------------------------

  // Sharing is instructor-only metadata. Read on entry and return to this window,
  // independently of response deltas, join events, and live-statistics refreshes.
  useEffect(() => {
    let active = true;
    let requestId = 0;
    const refreshActivityCode = async () => {
      const currentRequest = ++requestId;
      try {
        const { data } = await apiClient.get(`/sessions/${sessionId}/activity-share`);
        if (active && currentRequest === requestId) setActivityCode(data.enabled ? data.code : null);
      } catch {
        if (active && currentRequest === requestId) setActivityCode(null);
      }
    };
    setActivityCode(null);
    refreshActivityCode();
    window.addEventListener('focus', refreshActivityCode);
    return () => {
      active = false;
      window.removeEventListener('focus', refreshActivityCode);
    };
  }, [sessionId]);

  const fetchLive = useCallback(async (syncContext = null) => {
    const startedAtMs = Date.now();
    try {
      const { data } = await apiClient.get(`/sessions/${sessionId}/live`, {
        params: {
          includeStudentNames: true,
          includeJoinedStudents: activePanelRef.current === 'students',
        },
      });
      const fetchMeasurement = recordLiveFetch({
        startedAtMs,
        completedAtMs: Date.now(),
        success: true,
        transportOverride: syncContext?.transport,
      });
      setLiveData(data);
      scheduleUiSyncMeasurement({
        fetchStartedAtMs: fetchMeasurement?.startedAtMs || startedAtMs,
        emittedAtMs: syncContext?.emittedAtMs,
        receivedAtMs: syncContext?.receivedAtMs,
        success: true,
        transportOverride: syncContext?.transport,
      });
      setError(null);

      if (data?.session?.status === 'done') {
        navigate(`/prof/course/${courseId}`, { replace: true });
      }
    } catch (err) {
      recordLiveFetch({
        startedAtMs,
        completedAtMs: Date.now(),
        success: false,
        transportOverride: syncContext?.transport,
      });
      setError(err.response?.data?.message || t('professor.liveSession.failedLoadLiveSession'));
    } finally {
      setLoading(false);
    }
  }, [courseId, navigate, recordLiveFetch, scheduleUiSyncMeasurement, sessionId, t]);

  // Throttled re-fetch: batches rapid response-added events into at most one
  // re-fetch per 2-second window, dramatically reducing DB load during live sessions.
  const fetchThrottleRef = useRef(null);
  const scheduleFetchLive = useCallback((syncContext = null) => {
    if (fetchThrottleRef.current) return;
    fetchThrottleRef.current = setTimeout(() => {
      fetchThrottleRef.current = null;
      fetchLive(syncContext);
    }, 2000);
  }, [fetchLive]);

  const queueChatRefresh = useCallback((eventPayload = null) => {
    const addsUnreadPost = ['post-created', 'comment-added'].includes(eventPayload?.changeType)
      || (eventPayload?.changeType === 'quick-post-toggled' && eventPayload?.becameVisible);
    if (activePanel !== 'chat' && addsUnreadPost) {
      setChatUnseenCount((count) => count + 1);
    }
    if (activePanel === 'chat' && eventPayload) {
      pendingChatRefreshRef.current = false;
      setChatEvent((prev) => ({
        id: (prev?.id || 0) + 1,
        ...eventPayload,
      }));
      return;
    }

    if (activePanel === 'chat') {
      pendingChatRefreshRef.current = false;
      setChatRefreshToken((prev) => prev + 1);
      return;
    }

    pendingChatRefreshRef.current = true;
  }, [activePanel]);

  useEffect(() => {
    if (activePanel === 'chat') setChatUnseenCount(0);
  }, [activePanel]);

  const handlePanelChange = useCallback((nextPanel) => {
    if (nextPanel === 'chat') setChatUnseenCount(0);
    setActivePanel(nextPanel);
  }, []);

  useEffect(() => { fetchLive(); }, [fetchLive]);
  useEffect(() => registerRefreshHandler(fetchLive), [fetchLive, registerRefreshHandler]);

  useEffect(() => {
    activePanelRef.current = activePanel;
  }, [activePanel]);

  useEffect(() => {
    if (!lastEvent) return;

    const syncContext = recordEventReceipt({
      emittedAt: lastEvent?.data?.emittedAt,
      receivedAtMs: lastEvent?.receivedAtMs,
      success: true,
    });
    const { event, data } = lastEvent;
    switch (event) {
      case 'session:response-added':
        setLiveData((prev) => (
          data?.responseStats || data?.response || prev?.session?.anonymous
            ? applyLiveResponseAddedDelta(prev, data)
            : prev
              ? {
                ...prev,
                responseCount: data.responseCount ?? prev.responseCount,
                session: {
                  ...prev.session,
                  joinedCount: data.joinedCount ?? prev.session?.joinedCount,
                },
              }
              : prev
        ));
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:participant-joined':
        setLiveData((prev) => applyParticipantJoined(prev, data));
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:question-changed':
        if (Object.prototype.hasOwnProperty.call(data || {}, 'question')) {
          setLiveData((prev) => applyQuestionChanged(prev, data));
          scheduleUiSyncMeasurement({
            emittedAtMs: syncContext?.emittedAtMs,
            receivedAtMs: syncContext?.receivedAtMs,
            success: true,
            transportOverride: syncContext?.transport,
          });
        } else {
          fetchLive(syncContext);
        }
        break;
      case 'session:metadata-changed':
        fetchLive(syncContext);
        break;
      case 'session:question-updated':
        setLiveData((prev) => applyCurrentQuestionUpdate(prev, data));
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:attempt-changed':
        setLiveData((prev) => applyAttemptChanged(prev, data));
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:join-code-changed':
        setLiveData((prev) => applyJoinCodeChanged(prev, data));
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:chat-settings-changed':
        setLiveData((prev) => prev ? mergeSessionUpdate(prev, {
          _id: prev.session?._id,
          chatEnabled: data?.chatEnabled ?? prev.session?.chatEnabled,
          richTextChatEnabled: data?.richTextChatEnabled ?? prev.session?.richTextChatEnabled,
        }) : prev);
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:chat-updated':
        queueChatRefresh(data);
        break;
      case 'session:visibility-changed':
        setLiveData((prev) => applyVisibilityChanged(prev, data));
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:word-cloud-updated':
        setLiveData((prev) => prev ? { ...prev, wordCloudData: data.wordCloudData } : prev);
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:histogram-updated':
        setLiveData((prev) => prev ? { ...prev, histogramData: data.histogramData } : prev);
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:status-changed':
        if (data.status === 'done') {
          navigate(`/prof/course/${courseId}`, { replace: true });
          return;
        }
        fetchLive(syncContext);
        break;
      default:
        break;
    }
  }, [
    courseId,
    fetchLive,
    lastEvent,
    navigate,
    recordEventReceipt,
    queueChatRefresh,
    scheduleFetchLive,
    scheduleUiSyncMeasurement,
  ]);

  useEffect(() => () => {
    if (fetchThrottleRef.current) clearTimeout(fetchThrottleRef.current);
    fetchThrottleRef.current = null;
  }, []);

  // --------------------------------------------------
  // Auto-refresh join code
  // --------------------------------------------------

  useEffect(() => {
    if (joinCodeTimerRef.current) {
      clearInterval(joinCodeTimerRef.current);
      joinCodeTimerRef.current = null;
    }

    const session = liveData?.session;
    if (!session?.joinCodeEnabled || !session?.joinCodeActive) return;

    const interval = (session.joinCodeInterval || 10) * 1000;
    joinCodeTimerRef.current = setInterval(async () => {
      try {
        await apiClient.post(`/sessions/${sessionId}/refresh-join-code`, { force: false });
      } catch { /* ignore */ }
    }, interval);

    return () => {
      if (joinCodeTimerRef.current) {
        clearInterval(joinCodeTimerRef.current);
        joinCodeTimerRef.current = null;
      }
    };
  }, [
    liveData?.session?.joinCodeEnabled,
    liveData?.session?.joinCodeActive,
    liveData?.session?.joinCodeInterval,
    sessionId,
  ]);

  useEffect(() => {
    const interval = liveData?.session?.joinCodeInterval;
    if (interval == null) return;
    setJoinCodeIntervalInput(String(interval));
  }, [liveData?.session?.joinCodeInterval]);

  // --------------------------------------------------
  // Action helpers
  // --------------------------------------------------

  const doAction = useCallback(async (requestFn, successMsg, options = {}) => {
    if (pendingActionKey) return null;

    const {
      pendingKey = 'global:action',
      refresh = true,
      onSuccess,
    } = options;

    setPendingActionKey(pendingKey);
    try {
      const result = await requestFn();
      onSuccess?.(result);
      if (successMsg) setMsg({ severity: 'success', text: successMsg });
      if (refresh) {
        await fetchLive();
      }
      return result;
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.liveSession.actionFailed') });
      return null;
    } finally {
      setPendingActionKey(null);
    }
  }, [fetchLive, pendingActionKey, t]);

  // Navigation
  const handleSetQuestion = useCallback((qId) => {
    doAction(
      () => apiClient.patch(`/sessions/${sessionId}/current`, { questionId: qId }),
      null,
      { pendingKey: 'question:navigate' }
    );
  }, [doAction, sessionId]);

  const handlePrev = useCallback(() => {
    const session = liveData?.session;
    if (!session) return;
    const ids = session.questions || [];
    const idx = ids.indexOf(session.currentQuestion);
    if (idx > 0) handleSetQuestion(ids[idx - 1]);
  }, [liveData, handleSetQuestion]);

  const handleNext = useCallback(() => {
    const session = liveData?.session;
    if (!session) return;
    const ids = session.questions || [];
    const idx = ids.indexOf(session.currentQuestion);
    if (idx < ids.length - 1) handleSetQuestion(ids[idx + 1]);
  }, [liveData, handleSetQuestion]);

  // Visibility toggles
  const handleToggleVisibility = useCallback((field) => {
    const opts = liveData?.currentQuestion?.sessionOptions || {};
    const newVal = !opts[field];
    doAction(
      () => apiClient.patch(`/sessions/${sessionId}/question-visibility`, {
        hidden: field === 'hidden' ? newVal : !!opts.hidden,
        stats: field === 'stats' ? newVal : !!opts.stats,
        correct: field === 'correct' ? newVal : !!opts.correct,
      }),
      null,
      {
        pendingKey: `question-toggle:${field}`,
        refresh: false,
        onSuccess: (response) => {
          if (response?.data?.question) {
            setLiveData((prev) => replaceCurrentQuestion(prev, response.data.question));
          }
        },
      }
    );
  }, [doAction, sessionId, liveData]);

  // Attempts & responses
  const handleNewAttempt = useCallback(() => {
    doAction(
      () => apiClient.post(`/sessions/${sessionId}/new-attempt`),
      t('professor.liveSession.newAttemptStarted'),
      { pendingKey: 'question:new-attempt' }
    );
  }, [doAction, sessionId, t]);

  const handleToggleResponses = useCallback(() => {
    const closed = liveData?.currentAttempt?.closed;
    doAction(
      () => apiClient.patch(`/sessions/${sessionId}/toggle-responses`, { closed: !closed }),
      null,
      {
        pendingKey: 'question-responses:toggle',
        refresh: false,
        onSuccess: (response) => {
          if (response?.data?.question) {
            setLiveData((prev) => replaceCurrentQuestion(prev, response.data.question));
          }
        },
      }
    );
  }, [doAction, sessionId, liveData]);

  // End session
  const handleEndSession = useCallback(async () => {
    setEnding(true);
    try {
      const shouldMakeReviewable = makeReviewable && (!nonAutoGradeableWarning || reviewableOption !== 'cancel');
      const payload = { reviewable: shouldMakeReviewable };
      if (shouldMakeReviewable && nonAutoGradeableWarning) {
        payload.acknowledgeNonAutoGradeable = true;
        if (reviewableOption === 'zero') {
          payload.zeroNonAutoGradeable = true;
        }
      }
      const { data } = await apiClient.post(`/sessions/${sessionId}/end`, payload);
      if (data?.nonAutoGradeableWarning && !nonAutoGradeableWarning) {
        setNonAutoGradeableWarning(data.nonAutoGradeableWarning);
        setEnding(false);
        return;
      }
      setEndDialogOpen(false);
      setNonAutoGradeableWarning(null);
      navigate(`/prof/course/${courseId}`, { replace: true });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.liveSession.failedEndSession') });
    } finally {
      setEnding(false);
    }
  }, [sessionId, makeReviewable, navigate, courseId, nonAutoGradeableWarning, reviewableOption]);

  // Join code controls
  const handleTogglePasscodeRequired = useCallback((enabled) => {
    doAction(
      () => apiClient.patch(`/sessions/${sessionId}/join-code-settings`, { joinCodeEnabled: enabled }),
      enabled ? t('professor.liveSession.passcodeEnabled') : t('professor.liveSession.passcodeDisabled'),
      {
        pendingKey: 'join-code:enabled',
        refresh: false,
        onSuccess: (response) => {
          if (response?.data?.session) {
            setLiveData((prev) => mergeSessionUpdate(prev, response.data.session));
          }
        },
      }
    );
  }, [doAction, sessionId, t]);

  const handleToggleJoinCode = useCallback((active) => {
    doAction(
      () => apiClient.patch(`/sessions/${sessionId}/join-code-settings`, { joinCodeActive: active }),
      active ? t('professor.liveSession.joinPeriodStarted') : t('professor.liveSession.joinPeriodClosed'),
      {
        pendingKey: 'join-code:active',
        refresh: false,
        onSuccess: (response) => {
          if (response?.data?.session) {
            setLiveData((prev) => mergeSessionUpdate(prev, response.data.session));
          }
        },
      }
    );
  }, [doAction, sessionId, t]);

  const handleRefreshJoinCode = useCallback(() => {
    doAction(
      () => apiClient.post(`/sessions/${sessionId}/refresh-join-code`, { force: true }),
      t('professor.liveSession.joinCodeRefreshed'),
      { pendingKey: 'join-code:refresh' }
    );
  }, [doAction, sessionId, t]);

  const handleAdmitStudent = useCallback((studentId) => {
    doAction(
      () => apiClient.post(`/sessions/${sessionId}/join/${studentId}`),
      t('professor.liveSession.studentAdmitted'),
      {
        pendingKey: `student:admit:${studentId}`,
        refresh: false,
        onSuccess: (response) => {
          if (response?.data?.joinedStudent) {
            setLiveData((prev) => applyParticipantJoined(prev, response.data));
          }
        },
      }
    );
  }, [doAction, sessionId, t]);

  const handleJoinCodeIntervalBlur = useCallback(() => {
    const currentInterval = Number(liveData?.session?.joinCodeInterval || 10);
    const parsed = Number(joinCodeIntervalInput);
    if (!Number.isFinite(parsed)) {
      setJoinCodeIntervalInput(String(currentInterval));
      return;
    }
    const rounded = Math.round(parsed);
    if (rounded < 5 || rounded > 120) {
      setMsg({ severity: 'error', text: t('professor.liveSession.joinCodeIntervalRange') });
      setJoinCodeIntervalInput(String(currentInterval));
      return;
    }
    if (rounded === currentInterval) return;

    doAction(
      () => apiClient.patch(`/sessions/${sessionId}/join-code-settings`, { joinCodeInterval: rounded }),
      t('professor.liveSession.joinCodeIntervalUpdated'),
      {
        pendingKey: 'join-code:interval',
        refresh: false,
        onSuccess: (response) => {
          if (response?.data?.session) {
            setLiveData((prev) => mergeSessionUpdate(prev, response.data.session));
          }
        },
      }
    );
  }, [doAction, joinCodeIntervalInput, liveData?.session?.joinCodeInterval, sessionId]);

  const handleToggleSessionChat = useCallback((enabled) => {
    doAction(
      () => apiClient.patch(`/sessions/${sessionId}/chat-settings`, { chatEnabled: enabled }),
      enabled ? t('sessionChat.enableSessionChat') : t('sessionChat.disabled'),
      {
        pendingKey: 'session-chat:enabled',
        refresh: false,
        onSuccess: (response) => {
          if (response?.data?.session) {
            setLiveData((prev) => mergeSessionUpdate(prev, response.data.session));
          }
        },
      }
    );
  }, [doAction, sessionId, t]);

  const handleToggleRichTextChat = useCallback((enabled) => {
    doAction(
      () => apiClient.patch(`/sessions/${sessionId}/chat-settings`, { richTextChatEnabled: enabled }),
      enabled ? t('sessionChat.enableRichTextChat') : t('sessionChat.disableRichTextChat'),
      {
        pendingKey: 'session-chat:rich-text',
        refresh: false,
        onSuccess: (response) => {
          if (response?.data?.session) {
            setLiveData((prev) => mergeSessionUpdate(prev, response.data.session));
          }
        },
      }
    );
  }, [doAction, sessionId, t]);

  // Presentation window
  const presentationWindowRef = useRef(null);

  const handleOpenPresent = useCallback(() => {
    const url = `/prof/course/${courseId}/session/${sessionId}/present`;
    const w = Math.min(1200, window.screen.availWidth * 0.8);
    const h = Math.min(800, window.screen.availHeight * 0.8);
    const left = Math.round((window.screen.availWidth - w) / 2);
    const top = Math.round((window.screen.availHeight - h) / 2);
    const features = `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no,location=no,status=no,scrollbars=yes,resizable=yes`;
    const win = window.open(url, 'qlicker-presentation-window', features);
    if (win) presentationWindowRef.current = win;
  }, [courseId, sessionId]);

  const handleGenerateWordCloud = useCallback(async () => {
    if (!sessionId) return;
    const stopWords = t('stopWords', { returnObjects: true });
    const payload = Array.isArray(stopWords) ? { stopWords } : {};
    try {
      const res = await apiClient.post(`/sessions/${sessionId}/word-cloud`, payload);
      // Live data will be refreshed by WebSocket event; but also update local state
      setLiveData((prev) => prev ? { ...prev, wordCloudData: res.data?.wordCloudData } : prev);
    } catch {
      // silently fail — user can retry
    }
  }, [sessionId, t]);

  const handleToggleWordCloudVisibility = useCallback(async (visible) => {
    if (!sessionId) return;
    try {
      const res = await apiClient.patch(`/sessions/${sessionId}/word-cloud-visibility`, { visible });
      setLiveData((prev) => prev ? { ...prev, wordCloudData: res.data?.wordCloudData } : prev);
    } catch {
      // silently fail
    }
  }, [sessionId]);

  const handleGenerateHistogram = useCallback(async (opts = {}) => {
    if (!sessionId) return;
    try {
      const res = await apiClient.post(`/sessions/${sessionId}/histogram`, opts);
      setLiveData((prev) => prev ? { ...prev, histogramData: res.data?.histogramData } : prev);
    } catch {
      // silently fail — user can retry
    }
  }, [sessionId]);

  const handleToggleHistogramVisibility = useCallback(async (visible) => {
    if (!sessionId) return;
    try {
      const res = await apiClient.patch(`/sessions/${sessionId}/histogram-visibility`, { visible });
      setLiveData((prev) => prev ? { ...prev, histogramData: res.data?.histogramData } : prev);
    } catch {
      // silently fail
    }
  }, [sessionId]);

  const handleToggleResponseListVisibility = useCallback((visible) => {
    doAction(
      () => apiClient.patch(`/sessions/${sessionId}/question-visibility`, {
        responseListVisible: visible,
      }),
      visible
        ? t('professor.liveSession.responsesShownOnStudentDisplays')
        : t('professor.liveSession.responsesHiddenOnStudentDisplays'),
      { pendingKey: 'question-toggle:response-list' }
    );
  }, [doAction, sessionId, t]);

  // --------------------------------------------------
  // Derived values
  // --------------------------------------------------

  const session = liveData?.session;
  const chatEnabled = !!session?.chatEnabled;
  const richTextChatEnabled = session?.richTextChatEnabled !== false;
  const joinedStudentsLoaded = !!session?.joinedStudentsLoaded;
  const courseTitle = useMemo(() => (
    liveData?.course?._id ? buildCourseTitle(liveData.course, 'long') : ''
  ), [liveData?.course]);
  const courseSection = useMemo(
    () => normalizeValue(liveData?.course?.section),
    [liveData?.course?.section]
  );
  const currentQ = liveData?.currentQuestion;
  const currentAttempt = liveData?.currentAttempt;
  const responseStats = liveData?.responseStats;
  const wordCloudData = liveData?.wordCloudData || currentQ?.sessionOptions?.wordCloudData || null;
  const histogramData = liveData?.histogramData || currentQ?.sessionOptions?.histogramData || null;
  const allResponses = liveData?.allResponses || [];
  const responseCount = liveData?.responseCount ?? allResponses.length;
  const joinedCount = session?.joinedCount ?? (session?.joined?.length || 0);
  const anonymousSession = !!session?.anonymous;
  const joinedStudents = Array.isArray(session?.joinedStudents) ? session.joinedStudents : [];
  const enrolledStudents = Array.isArray(session?.enrolledStudents) ? session.enrolledStudents : [];
  const sortedJoinedStudents = useMemo(() => [...joinedStudents].sort((a, b) => {
    const lastCmp = normalizeValue(a?.lastname).localeCompare(normalizeValue(b?.lastname));
    if (lastCmp !== 0) return lastCmp;
    const firstCmp = normalizeValue(a?.firstname).localeCompare(normalizeValue(b?.firstname));
    if (firstCmp !== 0) return firstCmp;
    return normalizeValue(a?.email).localeCompare(normalizeValue(b?.email));
  }), [joinedStudents]);
  const unjoinedStudents = useMemo(() => {
    const joinedIds = new Set((session?.joined || []).map((id) => String(id)));
    return enrolledStudents.filter((student) => !joinedIds.has(String(student?._id || '')));
  }, [enrolledStudents, session?.joined]);
  const filteredUnjoinedStudents = useMemo(
    () => filterStudentsByIdentity(unjoinedStudents, unjoinedStudentsFilter),
    [unjoinedStudents, unjoinedStudentsFilter]
  );

  const questionIds = session?.questions || [];
  const qIdx = session ? questionIds.indexOf(session.currentQuestion) : -1;
  const totalQ = questionIds.length || 0;
  const hasPrev = qIdx > 0;
  const hasNext = qIdx < totalQ - 1;
  const sessionNavigationItems = questionIds.map((questionId, index) => ({
    questionId: String(questionId),
    label: String(index + 1),
  }));
  const qType = currentQ ? normalizeQuestionType(currentQ) : null;
  const isSlide = isSlideType(qType);
  const pageProgress = liveData?.pageProgress || (totalQ > 0 && qIdx >= 0
    ? { current: qIdx + 1, total: totalQ }
    : null);
  const questionProgress = liveData?.questionProgress || null;
  const hasSlidesInSession = !!(pageProgress && questionProgress && pageProgress.total !== questionProgress.total);
  const isHidden = !!currentQ?.sessionOptions?.hidden;
  const showStats = !!currentQ?.sessionOptions?.stats;
  const showCorrect = !!currentQ?.sessionOptions?.correct;
  const showResponseList = currentQ?.sessionOptions?.responseListVisible !== false;
  const responsesClosed = !!currentAttempt?.closed;
  const attemptNum = currentAttempt?.number ?? null;
  const globalActionLoading = pendingActionKey?.startsWith('global:');
  const navigationBusy = pendingActionKey === 'question:navigate';
  const newAttemptBusy = pendingActionKey === 'question:new-attempt';
  const joinCodeEnabledBusy = pendingActionKey === 'join-code:enabled';
  const joinCodeActiveBusy = pendingActionKey === 'join-code:active';
  const joinCodeRefreshBusy = pendingActionKey === 'join-code:refresh';
  const joinCodeIntervalBusy = pendingActionKey === 'join-code:interval';
  const sessionChatBusy = pendingActionKey === 'session-chat:enabled';
  const visibleToggleBusy = pendingActionKey === 'question-toggle:hidden';
  const statsToggleBusy = pendingActionKey === 'question-toggle:stats';
  const correctToggleBusy = pendingActionKey === 'question-toggle:correct';
  const responseListToggleBusy = pendingActionKey === 'question-toggle:response-list';
  const responsesToggleBusy = pendingActionKey === 'question-responses:toggle';

  useEffect(() => {
    if (!chatEnabled && activePanel === 'chat') {
      setActivePanel('question');
    }
  }, [activePanel, chatEnabled]);

  useEffect(() => {
    if (activePanel !== 'students') return;
    if (!session?._id || joinedStudentsLoaded) return;
    fetchLive();
  }, [activePanel, fetchLive, joinedStudentsLoaded, session?._id]);

  useEffect(() => {
    if (!chatEnabled) {
      pendingChatRefreshRef.current = false;
      return;
    }
    if (activePanel !== 'chat' || !pendingChatRefreshRef.current) return;

    pendingChatRefreshRef.current = false;
    setChatRefreshToken((prev) => prev + 1);
  }, [activePanel, chatEnabled]);
  const isOptionBasedQuestion = isOptionBasedQuestionType(qType) || qType === QUESTION_TYPES.TRUE_FALSE;
  const inlineDistribution = responseStats?.type === 'distribution'
    ? responseStats.distribution || []
    : [];
  const inlineDistributionTotal = Number(responseStats?.total) > 0
    ? Number(responseStats.total)
    : inlineDistribution.reduce((sum, d) => sum + (d.count || 0), 0);
  const liveStatusMessage = [
    hasSlidesInSession && pageProgress ? t('professor.liveSession.pageProgress', pageProgress) : null,
    !isSlide && questionProgress ? t('professor.liveSession.questionProgress', questionProgress) : null,
    t('professor.liveSession.studentsJoined', { count: joinedCount }),
    !isSlide ? t('professor.liveSession.studentsResponded', { responded: responseCount, total: joinedCount }) : null,
    attemptNum != null ? t('professor.liveSession.attemptNumber', { number: attemptNum }) : null,
    !isSlide ? (responsesClosed ? t('professor.liveSession.responsesCurrentlyClosed') : t('professor.liveSession.responsesCurrentlyOpen')) : null,
    isHidden ? t('professor.liveSession.questionHidden') : t('professor.liveSession.questionVisible'),
  ].filter(Boolean).join(' ');
  const mobileControlSize = isMobile ? 'medium' : 'small';
  const navButtonSx = {
    width: '100%',
    minHeight: { xs: 46, sm: 38 },
  };
  const toggleColumnsSx = {
    display: 'grid',
    gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fit, minmax(260px, 1fr))' },
    gap: 1,
    width: '100%',
  };
  const panelTabs = [
    {
      value: 'question',
      label: t('professor.liveSession.controlsTab'),
      tabProps: {
        'aria-label': pageProgress
          ? t('professor.liveSession.pageControlsLabel', pageProgress)
          : t('professor.liveSession.questionControls'),
      },
    },
    ...(chatEnabled ? [{
      value: 'chat',
      label: <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>{t('sessionChat.chat')}{chatUnseenCount > 0 ? <Chip size="small" color="error" label={chatUnseenCount} sx={{ height: 20 }} /> : null}</Box>,
      menuLabel: t('sessionChat.chat'),
    }] : []),
    {
      value: 'students',
      label: t('professor.liveSession.studentsTab'),
      tabProps: {
        'aria-label': t('professor.liveSession.showStudentsPanel', { count: joinedCount }),
      },
    },
  ];

  // --------------------------------------------------
  // Render: loading / error / ended states
  // --------------------------------------------------

  if (loading) {
    return (
      <Box sx={{ p: 4, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress aria-label={t('professor.liveSession.loadingLiveSession')} />
      </Box>
    );
  }

  if (error || !session) {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="error">{error || t('professor.liveSession.sessionNotFound')}</Alert>
        <BackLinkButton sx={{ mt: 2 }} label={t('professor.liveSession.backToCourse')} onClick={() => navigate(`/prof/course/${courseId}`)} />
      </Box>
    );
  }

  // --------------------------------------------------
  // Build chart data from responseStats
  // --------------------------------------------------

  // --------------------------------------------------
  // Render
  // --------------------------------------------------

  return (
    <Box sx={{ p: { xs: 1.5, sm: 2.5 }, maxWidth: 1200, mx: 'auto' }}>
      <Box role="status" aria-live="polite" aria-atomic="true" sx={SR_ONLY_SX}>
        {liveStatusMessage}
      </Box>

      {/* ============================================================ */}
      {/* Top bar                                                      */}
      {/* ============================================================ */}
      <Paper
        variant="outlined"
        sx={{
          p: { xs: 1.5, sm: 2 },
          mb: 2,
          display: 'flex',
          flexDirection: 'column',
          gap: 1.25,
        }}
      >
        <Box sx={{ width: '100%' }}>
          <BackLinkButton
            label={t('professor.liveSession.backToCourse')}
            onClick={() => navigate(`/prof/course/${courseId}`)}
          />
        </Box>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 1.25, width: '100%' }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            {!isMobile && courseTitle ? (
              <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.15 }}>
                {courseTitle}
              </Typography>
            ) : null}
            {!isMobile && courseSection ? (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  display: 'block',
                  mb: 0.5
                }}>
                {t('professor.course.sectionHeader', { section: courseSection })}
              </Typography>
            ) : null}
            <Typography variant="h6" sx={{ fontWeight: 700 }} noWrap>
              {session.name || t('professor.liveSession.liveSessionFallback')}
            </Typography>
            {activityCode && (
              <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
                {t('professor.sessionEditor.activityCodeLabel')}: <Box component="span" data-testid="activity-share-code" sx={{ fontWeight: 600 }}>{activityCode}</Box>
              </Typography>
            )}
          </Box>

          <Tooltip title={t('professor.liveSession.openPresentationWindow')}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<OpenInNewIcon />}
              onClick={handleOpenPresent}
              aria-label={t('professor.liveSession.openPresentationWindow')}
            >
              {isMobile ? t('professor.liveSession.present') : t('professor.liveSession.presentationWindow')}
            </Button>
          </Tooltip>

          <Tooltip title={t('professor.liveSession.editSession')}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<EditIcon />}
              onClick={() => navigate(`/prof/course/${courseId}/session/${sessionId}`)}
              aria-label={t('professor.liveSession.editSession')}
            >
              {t('professor.liveSession.editSession')}
            </Button>
          </Tooltip>

          <Button
            size="small"
            variant="contained"
            color="error"
            startIcon={<StopIcon />}
            onClick={() => setEndDialogOpen(true)}
            aria-label={t('professor.liveSession.endSessionAction')}
          >
            {t('professor.liveSession.endSession')}
          </Button>
        </Box>

        <Paper variant="outlined" sx={{ p: { xs: 1, sm: 1.25 }, display: 'flex', justifyContent: 'flex-start' }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, width: '100%' }}>
            <FormControlLabel
              labelPlacement="start"
              sx={SESSION_CHAT_TOGGLE_LABEL_SX}
              control={(
                <Switch
                  checked={chatEnabled}
                  onChange={(event) => handleToggleSessionChat(event.target.checked)}
                  disabled={globalActionLoading || sessionChatBusy}
                  size={mobileControlSize}
                />
              )}
              label={t('sessionChat.enableSessionChat')}
            />
            {chatEnabled ? (
              <FormControlLabel
                labelPlacement="start"
                sx={SESSION_CHAT_TOGGLE_LABEL_SX}
                control={(
                  <Switch
                    checked={richTextChatEnabled}
                    onChange={(event) => handleToggleRichTextChat(event.target.checked)}
                    disabled={globalActionLoading || sessionChatBusy}
                    size={mobileControlSize}
                  />
                )}
                label={t('sessionChat.enableRichTextChat')}
              />
            ) : null}
          </Box>
        </Paper>

        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, width: '100%' }}>
          <Chip
            label={t('professor.liveSession.respondedSummary', { responded: responseCount, total: joinedCount })}
            size="small"
            variant="outlined"
            color={responseCount >= joinedCount && joinedCount > 0 ? 'success' : 'default'}
            sx={COMPACT_CHIP_SX}
            aria-label={t('professor.liveSession.respondedSummaryAria', { responded: responseCount, total: joinedCount })}
          />

          {activePanel === 'question' && (
            attemptNum != null ? (
              <Chip
                label={t('professor.liveSession.attemptChip', { number: attemptNum })}
                size="small"
                variant="outlined"
                sx={COMPACT_CHIP_SX}
              />
            ) : null
          )}
        </Box>
      </Paper>

      {activePanel === 'question' ? (
        <>
          {/* ============================================================ */}
          {/* Control bar (always above the question)                      */}
          {/* ============================================================ */}
          <Paper
            variant="outlined"
            sx={{
              p: { xs: 1.5, sm: 2 },
              mb: 2,
              display: 'flex',
              flexDirection: 'column',
              gap: 1.25,
            }}
          >
            <LiveSessionPanelNavigation
              value={activePanel}
              onChange={handlePanelChange}
          tabs={panelTabs}
          compactAdornment={chatEnabled && chatUnseenCount > 0 ? <Chip size="small" color="error" label={chatUnseenCount} /> : null}
              ariaLabel={t('professor.liveSession.panelsLabel')}
              disablePaper
              sx={{ mb: 0.5 }}
            />

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, width: '100%' }}>
              <Box sx={toggleColumnsSx}>
                <FormControlLabel
                  labelPlacement="start"
                  sx={CONTROL_TOGGLE_LABEL_SX}
                  control={
                    <Switch
                      checked={!!session.joinCodeEnabled}
                      onChange={(e) => handleTogglePasscodeRequired(e.target.checked)}
                      disabled={globalActionLoading || joinCodeEnabledBusy}
                      size={mobileControlSize}
                    />
                  }
                  label={t('professor.liveSession.requirePasscode')}
                />

                {session.joinCodeEnabled && (
                  <FormControlLabel
                    labelPlacement="start"
                    sx={CONTROL_TOGGLE_LABEL_SX}
                    control={
                      <Switch
                        checked={!!session.joinCodeActive}
                        onChange={(e) => handleToggleJoinCode(e.target.checked)}
                        disabled={globalActionLoading || joinCodeActiveBusy}
                        size={mobileControlSize}
                      />
                    }
                    label={t('professor.liveSession.joinPeriod')}
                  />
                )}
              </Box>

              {session.joinCodeEnabled && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
                  <TextField
                    size={mobileControlSize}
                    label={t('professor.liveSession.refreshSec')}
                    type="number"
                    value={joinCodeIntervalInput}
                    onChange={(e) => setJoinCodeIntervalInput(e.target.value)}
                    onBlur={handleJoinCodeIntervalBlur}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    slotProps={{ htmlInput: { min: 5, max: 120 } }}
                    disabled={globalActionLoading || joinCodeIntervalBusy}
                    sx={{ width: { xs: '100%', sm: 150 }, maxWidth: 200 }}
                  />
                  {session.joinCodeActive && session.currentJoinCode && (
                    <>
                      <Chip
                        label={session.currentJoinCode}
                        color="primary"
                        sx={{ fontWeight: 700, fontSize: '1.1rem', letterSpacing: 2 }}
                        aria-label={t('professor.liveSession.currentJoinCodeAria', { code: session.currentJoinCode })}
                      />
                      <Tooltip title={t('professor.liveSession.refreshJoinCodeNow')}>
                        <IconButton
                          size={mobileControlSize}
                          onClick={handleRefreshJoinCode}
                          disabled={globalActionLoading || joinCodeRefreshBusy}
                          aria-label={t('professor.liveSession.refreshJoinCode')}
                        >
                          <RefreshIcon />
                        </IconButton>
                      </Tooltip>
                    </>
                  )}
                </Box>
              )}
            </Box>

            {anonymousSession && currentQ && !isSlide && (
              <Alert severity="info" role="status">
                {responseStats
                  ? t('professor.liveSession.anonymousStatsBatches', { count: responseStats.total || 0 })
                  : t('professor.liveSession.anonymousStatsWaiting')}
              </Alert>
            )}

            <Divider />

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(260px, 1fr))' },
                gap: 1,
                width: '100%',
              }}
            >
              <Box sx={{ display: 'grid', gap: 1 }}>
                <FormControlLabel
                  labelPlacement="start"
                  sx={CONTROL_TOGGLE_LABEL_SX}
                  control={
                    <Switch
                      checked={!isHidden}
                      onChange={() => handleToggleVisibility('hidden')}
                      disabled={!currentQ || globalActionLoading || visibleToggleBusy}
                      size={mobileControlSize}
                    />
                  }
                  label={t('professor.liveSession.visible')}
                />

                <FormControlLabel
                  labelPlacement="start"
                  sx={CONTROL_TOGGLE_LABEL_SX}
                  control={
                    <Switch
                      checked={!responsesClosed}
                      onChange={handleToggleResponses}
                      disabled={!currentQ || globalActionLoading || responsesToggleBusy || isSlide}
                      size={mobileControlSize}
                    />
                  }
                  label={t('professor.liveSession.responsesOpen')}
                />
              </Box>

              <Box sx={{ display: 'grid', gap: 1 }}>
                <FormControlLabel
                  labelPlacement="start"
                  sx={CONTROL_TOGGLE_LABEL_SX}
                  control={
                    <Switch
                      checked={showStats}
                      onChange={() => handleToggleVisibility('stats')}
                      disabled={!currentQ || globalActionLoading || statsToggleBusy || isSlide}
                      size={mobileControlSize}
                    />
                  }
                  label={t('professor.liveSession.showStats')}
                />

                <FormControlLabel
                  labelPlacement="start"
                  sx={CONTROL_TOGGLE_LABEL_SX}
                  control={
                    <Switch
                      checked={showCorrect}
                      onChange={() => handleToggleVisibility('correct')}
                      disabled={!currentQ || globalActionLoading || correctToggleBusy || isSlide}
                      size={mobileControlSize}
                    />
                  }
                  label={t('professor.liveSession.showCorrect')}
                />
              </Box>
            </Box>

            <Divider />

            {sessionNavigationItems.length > 1 && (
              <Box
                sx={{
                  display: 'flex',
                  gap: { xs: 1, sm: 0.75 },
                  flexWrap: 'wrap',
                  p: 1,
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1,
                }}
              >
                {sessionNavigationItems.map((entry) => {
                  const isActive = entry.questionId === String(session?.currentQuestion || '');
                  return (
                    <Chip
                      key={entry.questionId}
                      clickable
                      disabled={navigationBusy && !isActive}
                      onClick={() => handleSetQuestion(entry.questionId)}
                      label={entry.label}
                      color={isActive ? 'primary' : 'default'}
                      variant={isActive ? 'filled' : 'outlined'}
                      sx={SESSION_NAV_CHIP_SX}
                    />
                  );
                })}
              </Box>
            )}

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(3, minmax(0, 1fr))' },
                alignItems: 'stretch',
                gap: 1,
              }}
            >
              <Tooltip title={t('professor.liveSession.previousQuestion')}>
                <Box component="span" sx={{ display: 'flex', order: { xs: 2, sm: 1 } }}>
                  <Button
                    size={mobileControlSize}
                    variant="outlined"
                    startIcon={<PrevIcon />}
                    onClick={handlePrev}
                    disabled={!hasPrev || navigationBusy}
                    aria-label={t('professor.liveSession.previousQuestion')}
                    sx={navButtonSx}
                  >
                    {t('professor.liveSession.prev')}
                  </Button>
                </Box>
              </Tooltip>

              <Tooltip title={t('professor.liveSession.startNewAttempt')}>
                <Box component="span" sx={{ display: 'flex', order: { xs: 1, sm: 2 }, gridColumn: { xs: '1 / -1', sm: 'auto' } }}>
                  <Button
                    size={mobileControlSize}
                    variant="outlined"
                    startIcon={<AttemptIcon />}
                    onClick={handleNewAttempt}
                    disabled={!currentQ || newAttemptBusy || isSlide}
                    aria-label={t('professor.liveSession.newAttempt')}
                    sx={navButtonSx}
                  >
                    {t('professor.liveSession.newAttempt')}
                  </Button>
                </Box>
              </Tooltip>

              <Tooltip title={t('professor.liveSession.nextQuestion')}>
                <Box component="span" sx={{ display: 'flex', order: 3 }}>
                  <Button
                    size={mobileControlSize}
                    variant="outlined"
                    endIcon={<NextIcon />}
                    onClick={handleNext}
                    disabled={!hasNext || navigationBusy}
                    aria-label={t('professor.liveSession.nextQuestion')}
                    sx={navButtonSx}
                  >
                    {t('common.next')}
                  </Button>
                </Box>
              </Tooltip>
            </Box>
          </Paper>

          {/* ============================================================ */}
          {/* Main content: question + stats                               */}
          {/* ============================================================ */}
          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column', md: isOptionBasedQuestion || isSlide ? 'column' : 'row' },
              gap: 2,
              mb: 2,
            }}
          >
            {/* ---- Left panel: question content ---- */}
            <Paper
              variant="outlined"
              sx={{ flex: { md: 1 }, p: 2, minWidth: 0 }}
              aria-label={t('professor.liveSession.currentQuestion')}
            >
              {currentQ ? (
                <>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
                    {hasSlidesInSession && pageProgress && (
                      <Chip
                        label={t('professor.liveSession.pageProgress', pageProgress)}
                        size="small"
                        variant="outlined"
                        sx={COMPACT_CHIP_SX}
                      />
                    )}
                    {!isSlide && questionProgress && (
                      <Chip
                        label={t('professor.liveSession.questionProgress', questionProgress)}
                        size="small"
                        variant="outlined"
                        sx={COMPACT_CHIP_SX}
                      />
                    )}
                    <Chip
                      label={getQuestionTypeLabel(t, qType)}
                      size="small"
                      variant="outlined"
                      sx={COMPACT_CHIP_SX}
                    />
                    {!isSlide && (
                      <Chip
                        label={t('professor.liveSession.respondedSummary', { responded: responseCount, total: joinedCount })}
                        size="small"
                        variant="outlined"
                        color={responseCount >= joinedCount && joinedCount > 0 ? 'success' : 'default'}
                        sx={COMPACT_CHIP_SX}
                      />
                    )}
                    {isHidden && (
                      <Chip label={t('professor.liveSession.hidden')} size="small" color="warning" sx={COMPACT_CHIP_SX} />
                    )}
                  </Box>

                  {/* Question content (rich text with KaTeX) */}
                  <Box sx={{ mb: 2 }}>
                    <RichContent html={currentQ.content} fallback={currentQ.plainText} allowVideoEmbeds />
                  </Box>

                  {/* Options for MC / TF / MS */}
                  {isOptionBasedQuestion && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                      {(currentQ.options || []).map((opt, i) => {
                        const isCorrect = !!opt.correct;
                        const count = inlineDistribution?.[i]?.count || 0;
                        const pct = inlineDistributionTotal > 0 ? Math.round(100 * count / inlineDistributionTotal) : 0;
                        const optionContent = getOptionRichContentProps(opt);
                        const barColor = showCorrect
                          ? (isCorrect ? 'rgba(46, 125, 50, 0.22)' : 'rgba(211, 47, 47, 0.14)')
                          : 'rgba(25, 118, 210, 0.18)';
                        return (
                          <Paper
                            key={opt._id || i}
                            variant="outlined"
                            sx={{
                              position: 'relative',
                              overflow: 'hidden',
                              p: 1,
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 1,
                              borderColor: isCorrect ? 'success.main' : 'divider',
                              bgcolor: isCorrect ? 'success.lighter' : 'transparent',
                            }}
                          >
                            <Box
                              aria-hidden
                              sx={{
                                position: 'absolute',
                                left: 0,
                                top: 0,
                                bottom: 0,
                                width: `${pct}%`,
                                bgcolor: barColor,
                                transition: 'width 0.4s ease-out',
                                pointerEvents: 'none',
                              }}
                            />
                            <Box
                              sx={{
                                position: 'relative',
                                zIndex: 1,
                                display: 'grid',
                                gridTemplateColumns: '30px minmax(0, 1fr) 74px 20px',
                                columnGap: 1,
                                alignItems: 'start',
                                width: '100%',
                              }}
                            >
                              <Chip
                                label={OPTION_LETTERS[i]}
                                size="small"
                                color={isCorrect ? 'success' : 'default'}
                                sx={{ ...COMPACT_CHIP_SX, fontWeight: 700, minWidth: 28, justifySelf: 'start' }}
                              />
                              <Box sx={{ minWidth: 0 }}>
                                <RichContent html={optionContent.html} fallback={optionContent.fallback} />
                              </Box>
                              <Typography variant="body2" sx={{ fontWeight: 700, minWidth: 58, textAlign: 'right' }}>
                                {pct}% ({count})
                              </Typography>
                              {isCorrect && (
                                <CheckIcon color="success" fontSize="small" aria-label={t('professor.liveSession.correctAnswerAria')} />
                              )}
                            </Box>
                          </Paper>
                        );
                      })}
                    </Box>
                  )}

                  {/* Correct answer for numerical */}
                  {qType === QUESTION_TYPES.NUMERICAL && currentQ.correctNumerical != null && (
                    <Paper variant="outlined" sx={{ p: 1.5, mt: 1 }}>
                      <Typography variant="body2" sx={{
                        color: "text.secondary"
                      }}>
                        {t('professor.liveSession.correct', { value: currentQ.correctNumerical })}
                      </Typography>
                      {currentQ.toleranceNumerical != null && (
                        <Typography variant="body2" sx={{
                          color: "text.secondary"
                        }}>
                          {t('professor.liveSession.tolerance', { value: currentQ.toleranceNumerical })}
                        </Typography>
                      )}
                    </Paper>
                  )}

                  {/* Solution */}
                  {currentQ.solution && (
                    <Box sx={{ mt: 2 }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5 }}>
                        {t('common.solution')}
                      </Typography>
                      <Paper variant="outlined" sx={{ p: 1.5 }}>
                        <RichContent html={currentQ.solution} fallback={currentQ.solution_plainText} />
                      </Paper>
                    </Box>
                  )}
                </>
              ) : (
                <Typography variant="body1" sx={{
                  color: "text.secondary"
                }}>
                  {t('professor.liveSession.noQuestionSelected')}
                </Typography>
              )}
            </Paper>

            {/* ---- Right panel: response statistics ---- */}
            {!isOptionBasedQuestion && !isSlide && (
              <Paper
                variant="outlined"
                sx={{ flex: { md: 1 }, p: 2, minWidth: 0 }}
                aria-label={t('professor.liveSession.responseStatisticsAria')}
              >
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
                  {t('professor.liveSession.responses')}
                </Typography>

                {!currentQ ? (
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    {t('professor.liveSession.selectQuestionToViewResponses')}
                  </Typography>
                ) : anonymousSession && !responseStats ? (
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {t('professor.liveSession.respondedSummary', { responded: responseCount, total: joinedCount })}
                  </Typography>
                ) : responseStats?.type === 'distribution' ? (
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    {t('professor.liveSession.statsInline')}
                  </Typography>
                ) : responseStats?.type === 'shortAnswer' ? (
                  <>
                    <WordCloudPanel
                      wordCloudData={wordCloudData}
                      onGenerate={handleGenerateWordCloud}
                      onToggleVisible={handleToggleWordCloudVisibility}
                      showControls
                    />
                    <FormControlLabel
                      labelPlacement="start"
                      sx={{ ...CONTROL_TOGGLE_LABEL_SX, mb: 0.5 }}
                      control={(
                        <Switch
                          checked={showResponseList}
                          onChange={(event) => handleToggleResponseListVisibility(event.target.checked)}
                          disabled={!currentQ || globalActionLoading || responseListToggleBusy}
                          size={mobileControlSize}
                        />
                      )}
                      label={t('professor.liveSession.showResponsesOnStudentDisplays')}
                    />
                    <ShortAnswerList
                      responses={responseStats.answers || allResponses}
                      showStudentNames={!anonymousSession}
                    />
                  </>
                ) : responseStats?.type === 'numerical' ? (
                  <>
                    <HistogramPanel
                      histogramData={histogramData}
                      onGenerate={handleGenerateHistogram}
                      onToggleVisible={handleToggleHistogramVisibility}
                      showControls
                    />
                    <NumericalStats stats={responseStats} />
                    <ShortAnswerList
                      responses={responseStats.answers || allResponses}
                      showStudentNames={!anonymousSession}
                    />
                  </>
                ) : allResponses.length > 0 ? (
                  <ShortAnswerList
                    responses={allResponses}
                    showStudentNames={!anonymousSession}
                  />
                ) : (
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    {t('professor.liveSession.noResponsesYet')}
                  </Typography>
                )}
              </Paper>
            )}
          </Box>
        </>
      ) : activePanel === 'chat' ? (
        <>
          <LiveSessionPanelNavigation
            value={activePanel}
            onChange={handlePanelChange}
            tabs={panelTabs}
            compactAdornment={chatEnabled && chatUnseenCount > 0 ? <Chip size="small" color="error" label={chatUnseenCount} /> : null}
            ariaLabel={t('professor.liveSession.panelsLabel')}
          />
          <SessionChatPanel
            sessionId={sessionId}
            enabled={chatEnabled}
            role="professor"
            richTextChatEnabled={richTextChatEnabled}
            syncTransport={transport}
            refreshToken={chatRefreshToken}
            chatEvent={chatEvent}
          />
        </>
      ) : (
        <>
          <LiveSessionPanelNavigation
            value={activePanel}
            onChange={handlePanelChange}
            tabs={panelTabs}
            compactAdornment={chatEnabled && chatUnseenCount > 0 ? <Chip size="small" color="error" label={chatUnseenCount} /> : null}
            ariaLabel={t('professor.liveSession.panelsLabel')}
          />
          <Paper
            variant="outlined"
            sx={{ p: { xs: 1.5, sm: 2 }, mb: 2 }}
            aria-label={t('professor.liveSession.studentsCurrently')}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
              {t('professor.liveSession.studentsInSession', { count: joinedCount })}
            </Typography>

            {anonymousSession ? (
              <Alert severity="info" icon={<VisibilityOffIcon fontSize="inherit" />}>
                {t('professor.liveSession.anonymousStudentsNote')}
              </Alert>
            ) : null}

            {!anonymousSession && session.joinCodeEnabled ? (
              <Box sx={{ mb: 2 }}>
                <Button
                  color="inherit"
                  fullWidth
                  aria-expanded={unjoinedStudentsExpanded}
                  aria-controls="unjoined-students-section"
                  onClick={() => setUnjoinedStudentsExpanded((expanded) => !expanded)}
                  endIcon={unjoinedStudentsExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                  sx={{ justifyContent: 'space-between', px: 0.5, mb: 1, textTransform: 'none' }}
                >
                  <Typography component="span" variant="subtitle2">
                    {t('professor.liveSession.waitingToJoin', { count: unjoinedStudents.length })}
                  </Typography>
                  <Box component="span" sx={SR_ONLY_SX}>
                    {unjoinedStudentsExpanded
                      ? t('professor.liveSession.collapseWaitingStudents')
                      : t('professor.liveSession.expandWaitingStudents')}
                  </Box>
                </Button>
                <Collapse in={unjoinedStudentsExpanded} timeout="auto">
                  <Box id="unjoined-students-section">
                    {unjoinedStudents.length === 0 ? (
                      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                        {t('professor.liveSession.allEnrolledStudentsJoined')}
                      </Typography>
                    ) : (
                      <>
                        <TextField
                          fullWidth
                          size="small"
                          label={t('professor.liveSession.filterWaitingStudents')}
                          placeholder={t('professor.liveSession.filterWaitingStudentsPlaceholder')}
                          value={unjoinedStudentsFilter}
                          onChange={(event) => setUnjoinedStudentsFilter(event.target.value)}
                          slotProps={{
                            input: {
                              startAdornment: (
                                <InputAdornment position="start">
                                  <SearchIcon fontSize="small" />
                                </InputAdornment>
                              ),
                            },
                          }}
                          sx={{ mb: 1 }}
                        />
                        {filteredUnjoinedStudents.length === 0 ? (
                          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                            {t('professor.liveSession.noWaitingStudentsMatch')}
                          </Typography>
                        ) : (
                          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                            {filteredUnjoinedStudents.map((student) => {
                              const admitPending = pendingActionKey === `student:admit:${student._id}`;
                              return (
                                <Paper
                                  key={student._id}
                                  variant="outlined"
                                  sx={{
                                    p: 1.1,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: 1,
                                    flexWrap: 'wrap',
                                  }}
                                >
                                  <StudentIdentity
                                    student={student}
                                    avatarSize={34}
                                    nameVariant="body2"
                                    emailVariant="caption"
                                    nameWeight={600}
                                    sx={{ flex: '1 1 220px', minWidth: 0 }}
                                  />
                                  <Button
                                    size="small"
                                    variant="contained"
                                    disabled={!!pendingActionKey}
                                    onClick={() => handleAdmitStudent(student._id)}
                                  >
                                    {admitPending
                                      ? t('professor.liveSession.admittingStudent')
                                      : t('professor.liveSession.admitStudent')}
                                  </Button>
                                </Paper>
                              );
                            })}
                          </Box>
                        )}
                      </>
                    )}
                  </Box>
                </Collapse>
                <Divider sx={{ mt: 2 }} />
              </Box>
            ) : null}

            {anonymousSession ? null : sortedJoinedStudents.length === 0 ? (
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                {t('professor.liveSession.noStudentsJoined')}
              </Typography>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {sortedJoinedStudents.map((student) => (
                  <Paper
                    key={student._id}
                    variant="outlined"
                    sx={{
                      p: 1.1,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1,
                      flexWrap: 'wrap',
                    }}
                  >
                    <StudentIdentity
                      student={student}
                      avatarSize={34}
                      nameVariant="body2"
                      emailVariant="caption"
                      nameWeight={600}
                      sx={{ flex: '1 1 220px', minWidth: 0 }}
                    />
                    <Typography variant="caption" sx={{
                      color: "text.secondary"
                    }}>
                      {formatJoinedTimestamp(student.joinedAt, t('professor.liveSession.joinTimeUnavailable'))}
                    </Typography>
                  </Paper>
                ))}
              </Box>
            )}
          </Paper>
        </>
      )}

      {/* ============================================================ */}
      {/* End Session confirmation dialog                              */}
      {/* ============================================================ */}
      <Dialog
        open={endDialogOpen}
        onClose={() => { if (!ending) { setEndDialogOpen(false); setNonAutoGradeableWarning(null); } }}
        aria-labelledby="end-session-dialog-title"
      >
        <DialogTitle id="end-session-dialog-title">{t('professor.liveSession.endSession')}</DialogTitle>
        <DialogContent>
          <Typography sx={{ mb: 2 }}>
            Are you sure you want to end <strong>{session.name}</strong>?
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={makeReviewable}
                onChange={(e) => { setMakeReviewable(e.target.checked); setNonAutoGradeableWarning(null); }}
              />
            }
            label={t('professor.liveSession.makeReviewable')}
          />
          {nonAutoGradeableWarning && makeReviewable && (
            <Alert severity="warning" sx={{ mt: 2 }}>
              <Typography variant="body2" sx={{ mb: 1 }}>
                {buildReviewableWarningMessage(t, nonAutoGradeableWarning)}
              </Typography>
              <FormControl sx={{ mt: 1 }}>
                <FormLabel>{t('professor.liveSession.nonAutoGradeableChoose')}</FormLabel>
                <RadioGroup
                  value={reviewableOption}
                  onChange={(e) => setReviewableOption(e.target.value)}
                >
                  <FormControlLabel value="proceed" control={<Radio size="small" />} label={t('professor.liveSession.nonAutoGradeableProceed')} />
                  <FormControlLabel value="zero" control={<Radio size="small" />} label={t('professor.liveSession.nonAutoGradeableZero')} />
                  <FormControlLabel value="cancel" control={<Radio size="small" />} label={t('professor.liveSession.nonAutoGradeableCancel')} />
                </RadioGroup>
              </FormControl>
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setEndDialogOpen(false); setNonAutoGradeableWarning(null); }} disabled={ending}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleEndSession}
            disabled={ending}
          >
            {ending ? t('professor.liveSession.ending') : t('professor.liveSession.endSession')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ============================================================ */}
      {/* Snackbar for messages                                        */}
      {/* ============================================================ */}
      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)}>
        {msg ? <Alert severity={msg.severity} onClose={() => setMsg(null)}>{msg.text}</Alert> : undefined}
      </Snackbar>
    </Box>
  );
}

export default function LiveSession() {
  const { sessionId } = useParams();

  return (
    <LiveSessionWebSocketProvider sessionId={sessionId}>
      <LiveSessionContent />
    </LiveSessionWebSocketProvider>
  );
}
