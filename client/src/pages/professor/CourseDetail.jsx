import { Suspense, lazy, useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Autocomplete, Badge, Box, Typography, Button, TextField, Paper, Chip, Stack,
  List, ListItem, ListItemAvatar, ListItemText, ListItemButton, ListItemSecondaryAction, IconButton,
  Dialog, DialogTitle, DialogContent, DialogActions, Alert, Snackbar, Checkbox,
  CircularProgress, Divider, Switch, FormControlLabel, Tooltip, Avatar, MenuItem,
} from '@mui/material';
import {
  ContentCopy as CopyIcon, Delete as DeleteIcon,
  Add as AddIcon, Refresh as RefreshIcon, PersonRemove as PersonRemoveIcon,
  InfoOutlined as InfoOutlinedIcon,
  PlayArrow as LaunchIcon,
  Notifications as NotificationsIcon,
  RateReview as ReviewIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
} from '@mui/icons-material';
import { useTheme } from '@mui/material/styles';
import apiClient, { getUsableAccessToken } from '../../api/client';
import { closeWebSocketQuietly } from '../../utils/liveSocket';
import { getAiModelDisplayName, getAvailableAiModels, hasIncompleteAiBackend } from '../../utils/aiBackends';
import { isCurrentUserCourseInstructorOrAdmin } from '../../utils/courseAccess';
import { buildCourseSelectionLabel, buildCourseTitle, sortCoursesByRecent } from '../../utils/courseTitle';
import {
  getProfessorSessionPrimaryPath,
  sessionCanShowListReviewAction,
  sessionCanShowLiveReviewAction,
  sessionWaitingForAnonymousReview,
} from '../../utils/professorSessions';
import { getSessionTimingText } from '../../utils/sessionDisplay';
import { quizWouldBeLiveImmediately } from '../../utils/studentSessions';
import AutoSaveStatus from '../../components/common/AutoSaveStatus';
import ResponsiveTabsNavigation from '../../components/common/ResponsiveTabsNavigation';
import SessionStatusChip from '../../components/common/SessionStatusChip';
import SessionListCard from '../../components/common/SessionListCard';
import SessionGradesVisibilityControl from '../../components/common/SessionGradesVisibilityControl';
import SessionSelectorDialog from '../../components/common/SessionSelectorDialog';
import StudentListItem from '../../components/common/StudentListItem';
import StudentInfoModal from '../../components/common/StudentInfoModal';
import CourseGradesPanel from '../../components/grades/CourseGradesPanel';
import GroupManagementPanel from '../../components/groups/GroupManagementPanel';
import ManageNotificationsDialog from '../../components/notifications/ManageNotificationsDialog';
import VideoChatPanel from '../../components/video/VideoChatPanel';
import AiBackendManager from '../../components/ai/AiBackendManager';
import AiCourseChat from '../../components/ai/AiCourseChat';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { toggleSessionReviewable } from '../../utils/reviewableToggle';
import { getCourseChatEventUnseenDelta } from '../../utils/courseChat';
import { isRequestCanceled } from '../../utils/requestCancellation';

const QuestionLibraryPanel = lazy(() => import('../../components/questions/QuestionLibraryPanel'));
const CourseChatPanel = lazy(() => import('../../components/course/CourseChatPanel'));

function buildWebsocketUrl(token) {
  const encodedToken = encodeURIComponent(token);
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws?token=${encodedToken}`;
}

function TabPanel({ children, value, index }) {
  return value === index ? <Box sx={{ pt: 3 }}>{children}</Box> : null;
}

function getTimestamp(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getSessionSortBucket(session) {
  const status = String(session?.status || '');
  if (status === 'running') return 0;
  if (status === 'hidden') return 1;
  if (status === 'visible') return 2;
  if (status === 'done') return 3;
  return 4;
}

function getSessionSortTime(session) {
  const status = String(session?.status || '');
  const isQuiz = !!(session?.quiz || session?.practiceQuiz);

  if (isQuiz && status === 'visible') {
    return getTimestamp(session?.quizStart || session?.date || session?.createdAt || session?.quizEnd);
  }
  if (isQuiz && status === 'done') {
    return getTimestamp(session?.quizEnd || session?.date || session?.quizStart || session?.createdAt);
  }
  if (isQuiz) {
    return getTimestamp(session?.quizStart || session?.date || session?.createdAt || session?.quizEnd);
  }

  return getTimestamp(session?.date || session?.createdAt || session?.quizStart || session?.quizEnd);
}

function getApprovedCourseAiModels(config) {
  if (!config) return [];
  const approved = new Map((config.modelPolicies || []).map((entry) => [`${entry.backendId}::${entry.modelId}`, entry]));
  return getAvailableAiModels([...(config.adminBackends || []), ...(config.courseBackends || [])])
    .filter(({ backend, model }) => approved.has(`${backend.id}::${model.id}`))
    .map(({ backend, model }) => ({
      backend,
      model,
      displayName: getAiModelDisplayName(backend, model, approved.get(`${backend.id}::${model.id}`)?.displayName),
    }));
}

function getStudentCourseAiModels(config) {
  const studentAvailable = new Set((config?.modelPolicies || [])
    .filter((entry) => entry.studentAvailable)
    .map((entry) => `${entry.backendId}::${entry.modelId}`));
  return getApprovedCourseAiModels(config)
    .filter(({ backend, model }) => studentAvailable.has(`${backend.id}::${model.id}`));
}

function sortSessions(items) {
  return [...items].sort((a, b) => {
    const aBucket = getSessionSortBucket(a);
    const bBucket = getSessionSortBucket(b);
    if (aBucket !== bBucket) return aBucket - bBucket;
    return getSessionSortTime(b) - getSessionSortTime(a);
  });
}

const SESSION_PAGE_SIZE = 15;
const SESSION_BACKGROUND_BATCH_SIZE = 4;
const SESSION_PAGE_SIZE_OPTIONS = [15, 30, 50];
const SESSION_STATUS_FILTER_ALL = 'all';
const SESSION_STATUS_FILTER_OPTIONS = [
  { value: SESSION_STATUS_FILTER_ALL, labelKey: 'common.all', defaultLabel: 'All' },
  { value: 'hidden', labelKey: 'sessionStatus.draft', defaultLabel: 'Draft' },
  { value: 'visible', labelKey: 'sessionStatus.upcoming', defaultLabel: 'Upcoming' },
  { value: 'running', labelKey: 'sessionStatus.live', defaultLabel: 'Live' },
  { value: 'done', labelKey: 'sessionStatus.ended', defaultLabel: 'Ended' },
];

function normalizeSessionSearchValue(value) {
  return String(value || '').trim().toLowerCase();
}

function getProfessorSessionTypeCounts(sessionItems = []) {
  return sessionItems.reduce((counts, session) => {
    if (session?.studentCreated) return counts;
    if (session?.quiz) {
      counts.quizzes += 1;
    } else {
      counts.interactive += 1;
    }
    return counts;
  }, { interactive: 0, quizzes: 0 });
}

function buildProfessorSessionSubtitle(session, t) {
  const details = [
    t('professor.course.questionCount', { count: (session?.questions || []).length }),
  ];
  if (session?.anonymous) {
    details.push(t('professor.course.anonymousSession'));
  }
  const joinedCount = Array.isArray(session?.joined)
    ? session.joined.length
    : Number(session?.joinedCount || 0);
  if (joinedCount > 0) {
    details.push(t('professor.course.joinedCount', { count: joinedCount }));
  }
  const timingText = getSessionTimingText(session, t);
  if (timingText) {
    details.push(timingText);
  }
  return details.join(' · ');
}

const OPTIONAL_COURSE_TABS = ['chat', 'video', 'ai-settings', 'ai-chat', 'settings', 'questions'];

function parseCourseTab(value) {
  if (OPTIONAL_COURSE_TABS.includes(value)) return value;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return 0;
  if (parsed < 0 || parsed > 11) return 0;
  return parsed;
}

function getDefaultQuizWindowIso() {
  const start = new Date();
  const end = new Date(start.getTime() + (12 * 60 * 60 * 1000));
  return {
    quizStart: start.toISOString(),
    quizEnd: end.toISOString(),
  };
}

function toText(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function sortPeopleByLastName(items = []) {
  return [...items].sort((a, b) => {
    const aLast = toText(a?.profile?.lastname).trim();
    const bLast = toText(b?.profile?.lastname).trim();
    const lastCmp = aLast.localeCompare(bLast);
    if (lastCmp !== 0) return lastCmp;

    const aFirst = toText(a?.profile?.firstname).trim();
    const bFirst = toText(b?.profile?.firstname).trim();
    const firstCmp = aFirst.localeCompare(bFirst);
    if (firstCmp !== 0) return firstCmp;

    const aEmail = toText(a?.emails?.[0]?.address || a?.email).trim();
    const bEmail = toText(b?.emails?.[0]?.address || b?.email).trim();
    return aEmail.localeCompare(bEmail);
  });
}

function matchesPersonSearch(person, term) {
  const normalized = toText(term).trim().toLowerCase();
  if (!normalized) return true;
  const first = toText(person?.profile?.firstname).trim().toLowerCase();
  const last = toText(person?.profile?.lastname).trim().toLowerCase();
  const fullName = `${first} ${last}`.trim();
  const email = toText(person?.emails?.[0]?.address || person?.email).trim().toLowerCase();
  return first.includes(normalized)
    || last.includes(normalized)
    || fullName.includes(normalized)
    || email.includes(normalized);
}

function getCourseEditFields(course = {}) {
  return {
    name: toText(course.name),
    deptCode: toText(course.deptCode),
    courseNumber: toText(course.courseNumber),
    section: toText(course.section),
    semester: toText(course.semester),
    tags: [...new Set(
      (course.tags || [])
        .map((tag) => toText(tag?.label || tag?.value || tag).trim())
        .filter(Boolean)
    )],
  };
}

const EMPTY_COURSE_EDIT_FIELDS = {
  name: '',
  deptCode: '',
  courseNumber: '',
  section: '',
  semester: '',
  tags: [],
};
const EMPTY_COURSE_EDIT_FIELDS_HASH = JSON.stringify(EMPTY_COURSE_EDIT_FIELDS);
const COMPACT_CHIP_SX = {
  borderRadius: 1.4,
  '& .MuiChip-label': {
    px: 1.15,
  },
};

function parseFieldsHash(hashValue) {
  if (!hashValue) return { ...EMPTY_COURSE_EDIT_FIELDS };
  try {
    const parsed = JSON.parse(hashValue);
    return {
      name: toText(parsed.name),
      deptCode: toText(parsed.deptCode),
      courseNumber: toText(parsed.courseNumber),
      section: toText(parsed.section),
      semester: toText(parsed.semester),
      tags: [...new Set(
        (parsed.tags || [])
          .map((tag) => toText(tag?.label || tag?.value || tag).trim())
          .filter(Boolean)
      )],
    };
  } catch {
    return { ...EMPTY_COURSE_EDIT_FIELDS };
  }
}

function diffCourseEditFields(previousFields, nextFields) {
  const updates = {};
  const keys = Object.keys(nextFields);
  for (const key of keys) {
    if (nextFields[key] !== previousFields[key]) {
      updates[key] = nextFields[key];
    }
  }
  return updates;
}

function hasAllCourseEditFields(fields) {
  return ['name', 'deptCode', 'courseNumber', 'section', 'semester']
    .every((key) => String(fields?.[key] || '').trim().length > 0);
}

function isEmptyField(value) {
  return String(value || '').trim().length === 0;
}

export default function CourseDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const theme = useTheme();
  const { t } = useTranslation();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedTab, setTab] = useState(() => parseCourseTab(searchParams.get('tab')));
  const [msg, setMsg] = useState(null);

  // Dialogs
  const [addStudentOpen, setAddStudentOpen] = useState(false);
  const [studentEmail, setStudentEmail] = useState('');
  const [addingStudent, setAddingStudent] = useState(false);

  const [addInstructorOpen, setAddInstructorOpen] = useState(false);
  const [instructorUserId, setInstructorUserId] = useState('');
  const [addingInstructor, setAddingInstructor] = useState(false);
  const [manageNotificationsOpen, setManageNotificationsOpen] = useState(false);

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Confirm removal dialogs
  const [removeStudentTarget, setRemoveStudentTarget] = useState(null);
  const [removeInstructorTarget, setRemoveInstructorTarget] = useState(null);

  // Full-size image viewer
  const [imageViewUrl, setImageViewUrl] = useState(null);

  // Student info modal
  const [studentInfoTarget, setStudentInfoTarget] = useState(null);
  const [studentSearch, setStudentSearch] = useState('');

  // Settings
  const [editFields, setEditFields] = useState(EMPTY_COURSE_EDIT_FIELDS);
  const [settingsAutoSaveStatus, setSettingsAutoSaveStatus] = useState('idle');
  const [settingsAutoSaveError, setSettingsAutoSaveError] = useState('');
  const [adminTimeFormat, setAdminTimeFormat] = useState('24h');
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [aiCoursePolicy, setAiCoursePolicy] = useState({ enabled: false, allowCourseBackend: false });
  const [aiConfig, setAiConfig] = useState(null);
  const [rubricSourceCourses, setRubricSourceCourses] = useState([]);
  const [rubricSourceCourseId, setRubricSourceCourseId] = useState('');
  const [copyingRubrics, setCopyingRubrics] = useState(false);
  const [rubricManagerOpen, setRubricManagerOpen] = useState(false);
  const [courseRubrics, setCourseRubrics] = useState([]);
  const [rubricKind, setRubricKind] = useState('grading');
  const [activeRubricId, setActiveRubricId] = useState('');
  const [rubricDraft, setRubricDraft] = useState({ name: '', content: '' });

  // Sessions
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsBackgroundLoading, setSessionsBackgroundLoading] = useState(false);
  const [sessionTotalCount, setSessionTotalCount] = useState(0);
  const [sessionTypeCounts, setSessionTypeCounts] = useState({ interactive: 0, quizzes: 0 });
  const [sessionPages, setSessionPages] = useState({});
  const [sessionPageSizes, setSessionPageSizes] = useState({});
  const [sessionSearchTerms, setSessionSearchTerms] = useState({});
  const [sessionStatusFilters, setSessionStatusFilters] = useState({});
  const [sessionNeedsGradingFilters, setSessionNeedsGradingFilters] = useState({});
  const [sessionControlsExpanded, setSessionControlsExpanded] = useState({});
  const [gradingSummaryBySessionId, setGradingSummaryBySessionId] = useState({});
  const [createSessionOpen, setCreateSessionOpen] = useState(false);
  const [creatingSess, setCreatingSess] = useState(false);
  const [deleteSessionTarget, setDeleteSessionTarget] = useState(null);
  const [copySessionTarget, setCopySessionTarget] = useState(null);
  const [copySessionTargetCourseId, setCopySessionTargetCourseId] = useState(id);
  const [copySessionPreservePoints, setCopySessionPreservePoints] = useState(false);
  const [copySessionQuestionSummary, setCopySessionQuestionSummary] = useState(null);
  const [copyingSession, setCopyingSession] = useState(false);
  const [copySessionsDialogOpen, setCopySessionsDialogOpen] = useState(false);
  const [copySessionsSourceCourseId, setCopySessionsSourceCourseId] = useState(id);
  const [copySessionsSourceSessions, setCopySessionsSourceSessions] = useState([]);
  const [selectedCopySessionIds, setSelectedCopySessionIds] = useState([]);
  const [copyingSessions, setCopyingSessions] = useState(false);
  const [scheduledQuizStatusTarget, setScheduledQuizStatusTarget] = useState(null);
  const [instructorCourses, setInstructorCourses] = useState([]);
  const [sessionUpdatesInFlight, setSessionUpdatesInFlight] = useState({});
  const [chatRefreshToken, setChatRefreshToken] = useState(0);
  const [chatEvent, setChatEvent] = useState(null);
  const [chatUnseenCount, setChatUnseenCount] = useState(0);

  // Video chat — check if Jitsi is enabled for this course
  const [videoEnabled, setVideoEnabled] = useState(false);
  const aiAvailable = !!aiCoursePolicy.enabled;
  const courseChatEnabled = !!course?.courseChatEnabled;
  // Optional tabs have stable URL identities even when features add/remove tabs.
  const chatTabIndex = 'chat';
  const videoTabIndex = 'video';
  const aiTabIndex = 'ai-settings';
  const aiChatTabIndex = 'ai-chat';
  const settingsTabIndex = 'settings';
  const questionLibraryTabIndex = 'questions';
  const legacyOptionalTabs = [
    ...(courseChatEnabled ? [chatTabIndex] : []),
    ...(videoEnabled ? [videoTabIndex] : []),
    ...(aiAvailable ? [aiTabIndex, ...(course?.aiEnabled ? [aiChatTabIndex] : [])] : []),
    settingsTabIndex, questionLibraryTabIndex,
  ];
  const tab = typeof selectedTab === 'number' && selectedTab >= 6
    ? (legacyOptionalTabs[selectedTab - 6] || 0) : selectedTab;

  useEffect(() => {
    let mounted = true;
    apiClient.get(`/settings/jitsi-course/${id}`).then(({ data }) => {
      if (mounted) setVideoEnabled(!!data.enabled);
    }).catch(() => {
      if (mounted) setVideoEnabled(false);
    });
    return () => { mounted = false; };
  }, [id]);

  useEffect(() => {
    if (!aiAvailable) { setAiConfig(null); return undefined; }
    let mounted = true;
    apiClient.get(`/ai/courses/${id}/config`).then(({ data }) => {
      if (mounted) setAiConfig(data);
    }).catch(() => { if (mounted) setAiConfig(null); });
    return () => { mounted = false; };
  }, [aiAvailable, id]);

  useEffect(() => {
    if (!aiAvailable) return undefined;
    let mounted = true;
    apiClient.get(`/ai/courses/${id}/grading-instructions/copy-sources`)
      .then(({ data }) => { if (mounted) setRubricSourceCourses(data.courses || []); })
      .catch(() => { if (mounted) setRubricSourceCourses([]); });
    return () => { mounted = false; };
  }, [aiAvailable, id]);

  const handleCopyRubrics = useCallback(async () => {
    if (!rubricSourceCourseId) return;
    setCopyingRubrics(true);
    try {
      const { data } = await apiClient.post(`/ai/courses/${id}/grading-instructions/copy`, {
        sourceCourseId: rubricSourceCourseId,
      });
      setMsg({ severity: 'success', text: t('professor.course.rubricsCopied', { count: data.copied || 0 }) });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.course.rubricsCopyFailed') });
    } finally {
      setCopyingRubrics(false);
    }
  }, [id, rubricSourceCourseId, t]);

  const openRubricManager = useCallback(async () => {
    const { data } = await apiClient.get(`/ai/courses/${id}/grading-instructions`);
    setCourseRubrics((data.instructions || []).filter((entry) => !['no-feedback', 'basic-summary'].includes(entry._id)));
    setActiveRubricId('');
    setRubricDraft({ name: '', content: '' });
    setRubricManagerOpen(true);
  }, [id]);

  const saveCourseRubric = useCallback(async () => {
    if (!rubricDraft.name.trim() || !rubricDraft.content.trim()) return;
    const { data } = await apiClient.post(`/ai/courses/${id}/grading-instructions`, { _id: activeRubricId, kind: rubricKind, ...rubricDraft });
    setCourseRubrics((current) => [...current.filter((entry) => entry._id !== data.instruction._id), data.instruction]);
    setActiveRubricId(data.instruction._id);
  }, [activeRubricId, id, rubricDraft, rubricKind]);

  const deleteCourseRubric = useCallback(async () => {
    if (!activeRubricId) return;
    await apiClient.delete(`/ai/courses/${id}/grading-instructions/${activeRubricId}`);
    setCourseRubrics((current) => current.filter((entry) => entry._id !== activeRubricId));
    setActiveRubricId(''); setRubricDraft({ name: '', content: '' });
  }, [activeRubricId, id]);

  useEffect(() => {
    let mounted = true;
    apiClient.get(`/settings/ai-course/${id}`).then(({ data }) => {
      if (mounted) setAiCoursePolicy({ enabled: !!data?.enabled, allowCourseBackend: !!data?.allowCourseBackend });
    }).catch(() => {
      if (mounted) setAiCoursePolicy({ enabled: false, allowCourseBackend: false });
    });
    return () => { mounted = false; };
  }, [id]);

  // Polling ref for auto-refresh
  const pollingRef = useRef(null);
  const sessionFetchVersionRef = useRef(0);
  const sessionsAbortControllerRef = useRef(null);
  const settingsHydratedRef = useRef(false);
  const lastSavedEditFieldsHashRef = useRef('');
  const settingsSaveInFlightRef = useRef(false);
  const queuedSettingsFieldsRef = useRef(null);
  const aiConfigSaveTimerRef = useRef(null);
  const aiConfigUpdatesRef = useRef({});
  const aiConfigSaveInFlightRef = useRef(false);
  const aiConfigSaveQueuedRef = useRef(false);
  const newSessionNameInputRef = useRef(null);
  const newSessionDescInputRef = useRef(null);

  const fetchSessionGradeSummaries = useCallback(async (sessionItems, {
    merge = false,
    fetchVersion = null,
    signal = undefined,
  } = {}) => {
    const sessionIds = [...new Set(
      (sessionItems || []).map((session) => session?._id).filter(Boolean)
    )];

    if (sessionIds.length === 0) {
      if (!merge && (fetchVersion === null || sessionFetchVersionRef.current === fetchVersion)) {
        setGradingSummaryBySessionId({});
      }
      return;
    }

    try {
      const gradeSummaryRes = await apiClient.get(`/courses/${id}/grades`, {
        params: { sessionIds: sessionIds.join(',') },
        signal,
      });
      if (fetchVersion !== null && sessionFetchVersionRef.current !== fetchVersion) return;

      const summaryMap = {};
      (gradeSummaryRes.data?.sessions || []).forEach((sessionSummary) => {
        summaryMap[sessionSummary._id] = {
          hasGradeItems: sessionSummary.hasGradeItems,
          studentsNeedingGrading: Number(sessionSummary.studentsNeedingGrading) || 0,
          marksNeedingGrading: Number(sessionSummary.marksNeedingGrading) || 0,
        };
      });

      setGradingSummaryBySessionId((previousSummaries) => (
        merge ? { ...previousSummaries, ...summaryMap } : summaryMap
      ));
    } catch (err) {
      if (isRequestCanceled(err) || signal?.aborted) return;
      if (fetchVersion !== null && sessionFetchVersionRef.current !== fetchVersion) return;
      if (!merge) {
        setGradingSummaryBySessionId({});
      }
    }
  }, [id]);

  const fetchSessionsPage = useCallback(async (page, limit = SESSION_PAGE_SIZE, { signal } = {}) => {
    const { data } = await apiClient.get(`/courses/${id}/sessions`, {
      params: { page, limit },
      signal,
    });
    return data;
  }, [id]);

  const refreshSingleSession = useCallback(async (sessionId) => {
    if (!sessionId) return;
    const { data } = await apiClient.get(`/sessions/${sessionId}`);
    const nextSession = data?.session || data;
    if (!nextSession?._id || nextSession.studentCreated) return;

    setSessions((previousSessions) => previousSessions.map((session) => (
      String(session?._id || '') === String(sessionId)
        ? { ...session, ...nextSession }
        : session
    )));
  }, []);

  const patchSingleSessionStatus = useCallback((sessionId, status) => {
    if (!sessionId || !status) return;
    setSessions((previousSessions) => previousSessions.map((session) => (
      String(session?._id || '') === String(sessionId)
        ? { ...session, status }
        : session
    )));
  }, []);

  const fetchSessions = useCallback(async () => {
    const fetchVersion = sessionFetchVersionRef.current + 1;
    sessionFetchVersionRef.current = fetchVersion;
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
        }
        : getProfessorSessionTypeCounts(initialSessions);

      setSessions(initialSessions);
      setSessionTotalCount(totalSessions);
      setSessionTypeCounts(nextSessionTypeCounts);
      setSessionsLoading(false);

      await fetchSessionGradeSummaries(initialSessions, {
        fetchVersion,
        merge: false,
        signal: controller.signal,
      });
      if (sessionFetchVersionRef.current !== fetchVersion) return;

      if (totalPages <= 1) {
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
        await fetchSessionGradeSummaries(batchSessions, {
          fetchVersion,
          merge: true,
          signal: controller.signal,
        });
        if (sessionFetchVersionRef.current !== fetchVersion) return;
      }

      setSessionsBackgroundLoading(false);
    } catch (err) {
      if (isRequestCanceled(err) || controller.signal.aborted) return;
      if (sessionFetchVersionRef.current !== fetchVersion) return;
      setGradingSummaryBySessionId({});
      setSessionTotalCount(0);
      setSessionTypeCounts({ interactive: 0, quizzes: 0 });
      setSessionsLoading(false);
      setSessionsBackgroundLoading(false);
    } finally {
      if (sessionsAbortControllerRef.current === controller) {
        sessionsAbortControllerRef.current = null;
      }
    }
  }, [fetchSessionGradeSummaries, fetchSessionsPage]);

  const fetchInstructorCourses = useCallback(async () => {
    const { data } = await apiClient.get('/courses', { params: { limit: 500 } });
    const nextCourses = sortCoursesByRecent(
      (data.courses || []).filter((courseItem) => Array.isArray(courseItem.instructors))
    );
    setInstructorCourses(nextCourses);
  }, []);

  const fetchCopySessionsSource = useCallback(async (sourceCourseId) => {
    if (!sourceCourseId) {
      setCopySessionsSourceSessions([]);
      return;
    }
    const { data } = await apiClient.get(`/courses/${sourceCourseId}/sessions`);
    setCopySessionsSourceSessions(sortSessions(data.sessions || []));
  }, []);

  const fetchCourse = useCallback(async () => {
    try {
      const { data } = await apiClient.get(`/courses/${id}`);
      const c = data.course || data;
      if (user) {
        if (!isCurrentUserCourseInstructorOrAdmin(c, user)) {
          navigate(`/student/course/${id}`, { replace: true });
          return;
        }
      }
      const nextEditFields = getCourseEditFields(c);
      const nextHash = JSON.stringify(nextEditFields);
      setCourse(c);
      setEditFields((previousFields) => {
        const previousHash = JSON.stringify(previousFields);
        const shouldHydrate = !settingsHydratedRef.current
          || previousHash === EMPTY_COURSE_EDIT_FIELDS_HASH
          || previousHash === lastSavedEditFieldsHashRef.current;

        if (shouldHydrate) {
          settingsHydratedRef.current = true;
          lastSavedEditFieldsHashRef.current = nextHash;
          return nextEditFields;
        }

        return previousFields;
      });
    } catch {
      setMsg({ severity: 'error', text: t('professor.course.failedLoadCourse') });
    } finally {
      setLoading(false);
    }
  }, [id, navigate, user]);

  const setCourseTab = useCallback((nextTab) => {
    setTab(nextTab);
    const nextParams = new URLSearchParams(searchParams);
    if (nextTab === 0) {
      nextParams.delete('tab');
    } else {
      nextParams.set('tab', String(nextTab));
    }
    setSearchParams(nextParams, { replace: true });
  }, [searchParams, setSearchParams]);

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

  useEffect(() => {
    settingsHydratedRef.current = false;
    lastSavedEditFieldsHashRef.current = '';
    settingsSaveInFlightRef.current = false;
    queuedSettingsFieldsRef.current = null;
    clearTimeout(aiConfigSaveTimerRef.current);
    aiConfigSaveTimerRef.current = null;
    aiConfigUpdatesRef.current = {};
    aiConfigSaveInFlightRef.current = false;
    aiConfigSaveQueuedRef.current = false;
    setSettingsAutoSaveStatus('idle');
    setSettingsAutoSaveError('');
  }, [id]);

  useEffect(() => {
    let mounted = true;
    apiClient.get('/settings/public')
      .then(({ data }) => {
        if (mounted) {
          setAdminTimeFormat(data?.timeFormat === '12h' ? '12h' : '24h');
          setSsoEnabled(!!data?.SSO_enabled);
        }
      })
      .catch(() => {
        if (mounted) {
          setAdminTimeFormat('24h');
          setSsoEnabled(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    fetchCourse();
    fetchSessions();
    return () => {
      sessionsAbortControllerRef.current?.abort();
      sessionsAbortControllerRef.current = null;
    };
  }, [fetchCourse, fetchSessions]);
  useEffect(() => {
    if (tab === 0 || tab === 1) {
      fetchSessions();
    }
  }, [fetchSessions, tab]);
  useEffect(() => {
    fetchChatSummary();
  }, [fetchChatSummary]);

  // Poll for updates every 15 seconds (reactive student/instructor list)
  useEffect(() => {
    pollingRef.current = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchCourse();
      fetchChatSummary();
    }, 15000);
    return () => clearInterval(pollingRef.current);
  }, [fetchChatSummary, fetchCourse]);

  useEffect(() => {
    if (!copySessionsDialogOpen) return;
    fetchInstructorCourses().catch(() => {
      setMsg({ severity: 'error', text: t('professor.course.failedLoadCourses') });
    });
  }, [copySessionsDialogOpen, fetchInstructorCourses, t]);

  useEffect(() => {
    if (!copySessionTarget) return;
    fetchInstructorCourses().catch(() => {
      setMsg({ severity: 'error', text: t('professor.course.failedLoadCourses') });
    });
  }, [copySessionTarget, fetchInstructorCourses, t]);

  useEffect(() => {
    let active = true;
    if (!copySessionTarget?._id) {
      setCopySessionPreservePoints(false);
      setCopySessionQuestionSummary(null);
      return () => {
        active = false;
      };
    }

    setCopySessionPreservePoints(false);
    setCopySessionQuestionSummary(null);
    apiClient.get(`/sessions/${copySessionTarget._id}/export`).then(({ data }) => {
      if (!active) return;
      const questions = Array.isArray(data?.questions) ? data.questions : [];
      const zeroPointCount = questions.filter(
        (question) => Number(question?.sessionOptions?.points ?? 1) <= 0
      ).length;
      setCopySessionQuestionSummary({
        questionCount: questions.length,
        zeroPointCount,
      });
    }).catch(() => {
      if (!active) return;
      setCopySessionQuestionSummary({ questionCount: 0, zeroPointCount: 0 });
    });

    return () => {
      active = false;
    };
  }, [copySessionTarget]);

  useEffect(() => {
    if (!copySessionsDialogOpen) return;
    fetchCopySessionsSource(copySessionsSourceCourseId).catch(() => {
      setMsg({ severity: 'error', text: t('professor.course.failedLoadSessionsForCopy') });
    });
  }, [copySessionsDialogOpen, copySessionsSourceCourseId, fetchCopySessionsSource, t]);

  // Latest-handler ref so the websocket effect below doesn't tear down and
  // reconnect the socket every time a callback identity or the active tab
  // changes — that mid-handshake close surfaced as a browser console error
  // on every course-page load.
  const handleWsEventRef = useRef(() => {});
  handleWsEventRef.current = (evt, d) => {
    if (String(d?.courseId || '') !== String(id)) return;
    if (evt === 'session:status-changed') {
      patchSingleSessionStatus(d?.sessionId, d?.status);
    } else if (evt === 'session:metadata-changed') {
      refreshSingleSession(d?.sessionId).catch(() => {});
    } else if (evt === 'session:quiz-submitted' && d?.anonymous && Number.isFinite(d.submittedCount)) {
      setSessions((previous) => previous.map((session) => String(session._id) === String(d.sessionId)
        ? { ...session, submittedCount: Math.max(session.submittedCount || 0, d.submittedCount) } : session));
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

  // WebSocket push for session status changes (replaces session-list polling)
  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let closed = false;

    const connect = async () => {
      if (closed) return;
      const latestToken = await getUsableAccessToken({ refreshIfMissing: true, refreshIfExpiring: true });
      if (!latestToken) return;
      try {
        ws = new WebSocket(buildWebsocketUrl(latestToken));
      } catch {
        reconnectTimer = setTimeout(() => { void connect(); }, 2500);
        return;
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (!message?.event) return;
          handleWsEventRef.current(message.event, message.data);
        } catch {
          // Ignore malformed payloads
        }
      };

      ws.onclose = () => {
        if (closed) return;
        reconnectTimer = setTimeout(() => { void connect(); }, 2500);
      };
    };

    const init = async () => {
      try {
        const { data } = await apiClient.get('/health');
        if (data?.websocket === true) { void connect(); }
      } catch { /* WebSocket not available — polling still active */ }
    };

    init();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      closeWebSocketQuietly(ws);
    };
  }, [id]);

  useEffect(() => {
    const urlTab = parseCourseTab(searchParams.get('tab'));
    setTab((currentTab) => (currentTab === urlTab ? currentTab : urlTab));
  }, [searchParams]);

  useEffect(() => {
    if (!courseChatEnabled || tab === chatTabIndex) {
      setChatUnseenCount(0);
    }
  }, [chatTabIndex, courseChatEnabled, tab]);

  const copyCode = () => {
    if (course?.enrollmentCode) {
      navigator.clipboard.writeText(course.enrollmentCode);
      setMsg({ severity: 'success', text: t('professor.dashboard.enrollmentCodeCopied') });
    }
  };

  // Student actions
  const handleAddStudent = async () => {
    if (!studentEmail.trim()) return;
    setAddingStudent(true);
    try {
      await apiClient.post(`/courses/${id}/students`, { email: studentEmail.trim() });
      setAddStudentOpen(false);
      setStudentEmail('');
      fetchCourse();
      setMsg({ severity: 'success', text: t('professor.course.studentAdded') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.course.failedAddStudent') });
    } finally {
      setAddingStudent(false);
    }
  };

  const handleRemoveStudent = async (studentId) => {
    try {
      await apiClient.delete(`/courses/${id}/students/${studentId}`);
      setRemoveStudentTarget(null);
      fetchCourse();
      setMsg({ severity: 'success', text: t('professor.course.studentRemoved') });
    } catch {
      setMsg({ severity: 'error', text: t('professor.course.failedRemoveStudent') });
    }
  };

  // Instructor actions
  const handleAddInstructor = async () => {
    if (!instructorUserId.trim()) return;
    setAddingInstructor(true);
    try {
      await apiClient.post(`/courses/${id}/instructors`, { userId: instructorUserId.trim() });
      setAddInstructorOpen(false);
      setInstructorUserId('');
      fetchCourse();
      setMsg({ severity: 'success', text: t('professor.course.instructorAdded') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.course.failedAddInstructor') });
    } finally {
      setAddingInstructor(false);
    }
  };

  const handleRemoveInstructor = async (instructorId) => {
    const instructors = course?.instructors || [];
    if (instructors.length <= 1) {
      setMsg({ severity: 'warning', text: t('professor.course.cannotRemoveLastInstructor') });
      return;
    }
    try {
      await apiClient.delete(`/courses/${id}/instructors/${instructorId}`);
      setRemoveInstructorTarget(null);
      fetchCourse();
      setMsg({ severity: 'success', text: t('professor.course.instructorRemoved') });
    } catch {
      setMsg({ severity: 'error', text: t('professor.course.failedRemoveInstructor') });
    }
  };

  // Settings actions
  const markSettingAutoSaveInProgress = () => {
    setSettingsAutoSaveStatus('saving');
    setSettingsAutoSaveError('');
  };

  const markSettingAutoSaveError = (err, fallbackMessage) => {
    setSettingsAutoSaveStatus('error');
    const message = err.response?.data?.message || fallbackMessage;
    setSettingsAutoSaveError(`${message} ${t('profile.lastChangeNotRecorded')}`);
  };

  const persistCourseEditFields = useCallback(async (fieldsToPersist) => {
    const runSave = async (pendingFields) => {
      if (settingsSaveInFlightRef.current) {
        queuedSettingsFieldsRef.current = pendingFields;
        return;
      }

      settingsSaveInFlightRef.current = true;
      setSettingsAutoSaveStatus('saving');
      setSettingsAutoSaveError('');
      const requestedHash = JSON.stringify(pendingFields);
      const lastSavedFields = parseFieldsHash(lastSavedEditFieldsHashRef.current);
      const patchPayload = diffCourseEditFields(lastSavedFields, pendingFields);
      if (Array.isArray(patchPayload.tags)) {
        patchPayload.tags = patchPayload.tags.map((tag) => ({ value: tag, label: tag }));
      }

      if (Object.keys(patchPayload).length === 0) {
        settingsSaveInFlightRef.current = false;
        setSettingsAutoSaveStatus('success');
        return;
      }

      try {
        const { data } = await apiClient.patch(`/courses/${id}`, patchPayload);
        const savedCourse = data.course || data;
        const savedFields = getCourseEditFields(savedCourse);
        const savedHash = JSON.stringify(savedFields);

        lastSavedEditFieldsHashRef.current = savedHash;
        setCourse((previousCourse) => (previousCourse ? { ...previousCourse, ...savedFields } : previousCourse));
        setEditFields((currentFields) => (
          JSON.stringify(currentFields) === requestedHash ? savedFields : currentFields
        ));
        setSettingsAutoSaveStatus('success');
      } catch (err) {
        const message = err.response?.data?.message || t('professor.course.failedUpdateCourse');
        setSettingsAutoSaveStatus('error');
        setSettingsAutoSaveError(`${message} ${t('profile.lastChangeNotRecorded')}`);
      } finally {
        settingsSaveInFlightRef.current = false;

        if (queuedSettingsFieldsRef.current) {
          const queuedFields = queuedSettingsFieldsRef.current;
          queuedSettingsFieldsRef.current = null;
          const queuedHash = JSON.stringify(queuedFields);
          if (queuedHash !== lastSavedEditFieldsHashRef.current) {
            await runSave(queuedFields);
          }
        }
      }
    };

    await runSave(fieldsToPersist);
  }, [id]);

  useEffect(() => {
    if (!settingsHydratedRef.current) return;
    if (!hasAllCourseEditFields(editFields)) return;

    const fieldsHash = JSON.stringify(editFields);
    if (fieldsHash === lastSavedEditFieldsHashRef.current) return;

    const autosaveTimer = setTimeout(() => {
      persistCourseEditFields(editFields);
    }, 700);

    return () => clearTimeout(autosaveTimer);
  }, [editFields, persistCourseEditFields]);

  const handleToggleActive = async () => {
    markSettingAutoSaveInProgress();
    try {
      await apiClient.patch(`/courses/${id}/active`, { inactive: !course.inactive });
      fetchCourse();
      setSettingsAutoSaveStatus('success');
      setMsg({ severity: 'success', text: course.inactive ? t('professor.course.courseActivated') : t('professor.course.courseDeactivated') });
    } catch (err) {
      markSettingAutoSaveError(err, t('professor.course.failedUpdateCourseSetting'));
    }
  };

  const handleToggleRequireVerified = async () => {
    markSettingAutoSaveInProgress();
    try {
      await apiClient.patch(`/courses/${id}`, { requireVerified: !course.requireVerified });
      fetchCourse();
      setSettingsAutoSaveStatus('success');
    } catch (err) {
      markSettingAutoSaveError(err, t('professor.course.failedUpdateSetting'));
    }
  };

  const handleToggleAllowStudentQuestions = async () => {
    markSettingAutoSaveInProgress();
    try {
      await apiClient.patch(`/courses/${id}`, { allowStudentQuestions: !course.allowStudentQuestions });
      fetchCourse();
      setSettingsAutoSaveStatus('success');
    } catch (err) {
      markSettingAutoSaveError(err, t('professor.course.failedUpdateSetting'));
    }
  };

  const handleToggleAllowSharedActivities = async () => {
    markSettingAutoSaveInProgress();
    try {
      await apiClient.patch(`/courses/${id}`, { allowSharedActivities: !course.allowSharedActivities });
      fetchCourse();
      setSettingsAutoSaveStatus('success');
    } catch (err) {
      markSettingAutoSaveError(err, t('professor.course.failedUpdateSetting'));
    }
  };

  const handleQuizTimeFormatChange = async (nextValue) => {
    markSettingAutoSaveInProgress();
    try {
      await apiClient.patch(`/courses/${id}`, { quizTimeFormat: nextValue });
      fetchCourse();
      setSettingsAutoSaveStatus('success');
    } catch (err) {
      markSettingAutoSaveError(err, t('professor.course.failedUpdateSetting'));
    }
  };

  const handleAiEnabledChange = async (event) => {
    markSettingAutoSaveInProgress();
    try {
      const enabled = event.target.checked;
      await apiClient.patch(`/ai/courses/${id}/config`, { enabled });
      setCourse((current) => (current ? { ...current, aiEnabled: enabled } : current));
      setCourseTab(settingsTabIndex);
      fetchCourse();
      setSettingsAutoSaveStatus('success');
    } catch (err) {
      markSettingAutoSaveError(err, t('professor.course.failedUpdateSetting'));
    }
  };

  const flushAiConfigChanges = useCallback(async function flushAiConfigChanges() {
    if (aiConfigSaveInFlightRef.current) {
      aiConfigSaveQueuedRef.current = true;
      return;
    }

    const updates = aiConfigUpdatesRef.current;
    if (Object.keys(updates).length === 0) return;

    aiConfigUpdatesRef.current = {};
    aiConfigSaveInFlightRef.current = true;
    try {
      const { data } = await apiClient.patch(`/ai/courses/${id}/config`, updates);
      if (Array.isArray(data?.courseBackends)) {
        const savedById = new Map(data.courseBackends.map((backend) => [backend.id, backend]));
        const submittedById = new Map((updates.backends || []).map((backend) => [backend.id, backend]));
        setAiConfig((current) => current ? {
          ...current,
          courseBackends: (current.courseBackends || []).map((backend) => {
            const saved = savedById.get(backend.id);
            const submitted = submittedById.get(backend.id);
            const savedSubmittedToken = !!submitted?.apiToken && backend.apiToken === submitted.apiToken;
            return saved ? {
              ...backend,
              apiToken: savedSubmittedToken ? '' : backend.apiToken,
              apiTokenSet: !!saved.apiTokenSet,
            } : backend;
          }),
        } : current);
      }
      setSettingsAutoSaveStatus('success');
    } catch (err) {
      markSettingAutoSaveError(err, t('professor.course.failedUpdateSetting'));
    } finally {
      aiConfigSaveInFlightRef.current = false;
      if (aiConfigSaveQueuedRef.current || Object.keys(aiConfigUpdatesRef.current).length > 0) {
        aiConfigSaveQueuedRef.current = false;
        await flushAiConfigChanges();
      }
    }
  }, [id, t]);

  const handleAiConfigChange = (updates, localUpdates = updates, { saveImmediately = false } = {}) => {
    setAiConfig((current) => (current ? { ...current, ...localUpdates } : current));
    aiConfigUpdatesRef.current = { ...aiConfigUpdatesRef.current, ...updates };
    clearTimeout(aiConfigSaveTimerRef.current);
    markSettingAutoSaveInProgress();
    if (saveImmediately) {
      aiConfigSaveTimerRef.current = null;
      void flushAiConfigChanges();
      return;
    }
    aiConfigSaveTimerRef.current = setTimeout(() => {
      aiConfigSaveTimerRef.current = null;
      flushAiConfigChanges();
    }, 500);
  };

  const handleAiBackendChange = (field, value, options = {}) => {
    if (options.deferSave) return;
    if (field === 'backends' && hasIncompleteAiBackend(value)) {
      const { backends, ...pendingUpdates } = aiConfigUpdatesRef.current;
      aiConfigUpdatesRef.current = pendingUpdates;
      if (Object.keys(pendingUpdates).length === 0) setSettingsAutoSaveStatus('idle');
      return;
    }
    handleAiConfigChange({ [field]: value }, { courseBackends: value }, options);
  };

  const handleAiCourseDefaultChange = (defaultBackendId, defaultModelId) => {
    handleAiConfigChange({
      defaultBackendId,
      defaultModelId,
    }, {
      courseDefaultBackendId: defaultBackendId,
      courseDefaultModelId: defaultModelId,
      defaultBackendId,
      defaultModelId,
    });
  };

  const handleAiModelPoliciesChange = (modelPolicies) => {
    const nextConfig = { ...aiConfig, modelPolicies };
    const studentModels = getStudentCourseAiModels(nextConfig);
    const selectedStudentModelAvailable = studentModels.some(({ backend, model }) => (
      backend.id === aiConfig.studentDefaultBackendId && model.id === aiConfig.studentDefaultModelId
    ));
    const fallbackStudentModel = selectedStudentModelAvailable ? null : studentModels[0];
    const updates = {
      modelPolicies,
      ...(!selectedStudentModelAvailable ? {
        studentDefaultBackendId: fallbackStudentModel?.backend.id || '',
        studentDefaultModelId: fallbackStudentModel?.model.id || '',
      } : {}),
    };
    // Availability changes affect every AI model selector. Start saving them
    // immediately so opening chat cannot fetch an older approved-model list.
    handleAiConfigChange(updates, updates, { saveImmediately: true });
  };

  const handleStudentAiChatEnabledChange = (event) => {
    const enabled = event.target.checked;
    const studentModels = getStudentCourseAiModels(aiConfig);
    const selectedModel = studentModels.find(({ backend, model }) => (
      backend.id === aiConfig.studentDefaultBackendId && model.id === aiConfig.studentDefaultModelId
    )) || studentModels[0];
    const updates = {
      studentChatEnabled: enabled,
      ...(enabled ? { studentChatGuidance: aiConfig.studentChatGuidance || '' } : {}),
      ...(enabled && selectedModel ? {
        studentDefaultBackendId: selectedModel.backend.id,
        studentDefaultModelId: selectedModel.model.id,
      } : {}),
    };
    handleAiConfigChange(updates, updates, { saveImmediately: true });
  };

  useEffect(() => () => {
    clearTimeout(aiConfigSaveTimerRef.current);
    const pendingUpdates = aiConfigUpdatesRef.current;
    if (Object.keys(pendingUpdates).length > 0) {
      apiClient.patch(`/ai/courses/${id}/config`, pendingUpdates).catch(() => {});
    }
  }, [id]);

  const handleCourseChatEnabledChange = async (event) => {
    markSettingAutoSaveInProgress();
    try {
      const nextCourseChatEnabled = event.target.checked;
      await apiClient.patch(`/courses/${id}`, { courseChatEnabled: nextCourseChatEnabled });
      setCourseTab(settingsTabIndex);
      setChatUnseenCount(0);
      fetchCourse();
      setSettingsAutoSaveStatus('success');
    } catch (err) {
      markSettingAutoSaveError(err, t('professor.course.failedUpdateSetting'));
    }
  };

  const handleCourseChatRetentionChange = async (event) => {
    const nextValue = Number(event.target.value);
    if (!Number.isInteger(nextValue) || nextValue < 1 || nextValue > 365) return;
    markSettingAutoSaveInProgress();
    try {
      await apiClient.patch(`/courses/${id}`, { courseChatRetentionDays: nextValue });
      fetchCourse();
      setSettingsAutoSaveStatus('success');
    } catch (err) {
      markSettingAutoSaveError(err, t('professor.course.failedUpdateSetting'));
    }
  };

  const handleRegenerateCode = async () => {
    try {
      await apiClient.post(`/courses/${id}/regenerate-code`);
      fetchCourse();
      setMsg({ severity: 'success', text: t('professor.course.enrollmentCodeRegenerated') });
    } catch {
      setMsg({ severity: 'error', text: t('professor.course.failedRegenerateCode') });
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await apiClient.delete(`/courses/${id}`);
      navigate('/prof');
    } catch {
      setMsg({ severity: 'error', text: t('professor.course.failedDeleteCourse') });
      setDeleting(false);
    }
  };

  // Session actions
  const handleCreateSession = async () => {
    const nextSessionName = String(newSessionNameInputRef.current?.value || '').trim();
    const nextSessionDesc = String(newSessionDescInputRef.current?.value || '').trim();
    if (!nextSessionName) return;
    setCreatingSess(true);
    try {
      const body = { name: nextSessionName };
      if (nextSessionDesc) body.description = nextSessionDesc;
      if (tab === 1) {
        const quizWindow = getDefaultQuizWindowIso();
        body.quiz = true;
        body.quizStart = quizWindow.quizStart;
        body.quizEnd = quizWindow.quizEnd;
      }
      const { data } = await apiClient.post(`/courses/${id}/sessions`, body);
      const createdSession = data?.session || data;
      setCreateSessionOpen(false);
      if (newSessionNameInputRef.current) newSessionNameInputRef.current.value = '';
      if (newSessionDescInputRef.current) newSessionDescInputRef.current.value = '';
      if (createdSession?._id) {
        navigate(
          `/prof/course/${id}/session/${createdSession._id}?returnTab=${tab}`,
          { state: { returnTab: tab } }
        );
      } else {
        await fetchSessions();
        setMsg({ severity: 'success', text: t('professor.course.sessionCreated') });
      }
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.course.failedCreateSession') });
    } finally {
      setCreatingSess(false);
    }
  };

  const handleDeleteSession = async (sessionId) => {
    try {
      await apiClient.delete(`/sessions/${sessionId}`);
      setDeleteSessionTarget(null);
      fetchSessions();
      setMsg({ severity: 'success', text: t('professor.course.sessionDeleted') });
    } catch {
      setMsg({ severity: 'error', text: t('professor.course.failedDeleteSession') });
    }
  };

  const handleCopySession = async () => {
    if (!copySessionTarget?._id) return;
    setCopyingSession(true);
    try {
      await apiClient.post(`/sessions/${copySessionTarget._id}/copy`, {
        targetCourseId: copySessionTargetCourseId,
        preservePoints: copySessionPreservePoints,
      });
      if (String(copySessionTargetCourseId) === String(id)) {
        await fetchSessions();
      }
      setCopySessionTarget(null);
      setMsg({ severity: 'success', text: t('professor.course.sessionCopied') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.course.failedCopySession') });
    } finally {
      setCopyingSession(false);
    }
  };

  const handleCopySelectedSessions = async () => {
    if (!selectedCopySessionIds.length) return;
    setCopyingSessions(true);
    try {
      const { data } = await apiClient.post(`/courses/${id}/sessions/copy`, {
        sessionIds: selectedCopySessionIds,
      });
      await fetchSessions();
      setCopySessionsDialogOpen(false);
      setSelectedCopySessionIds([]);
      setMsg({
        severity: 'success',
        text: t('professor.course.sessionsCopied', {
          count: (data.sessions || []).length,
        }),
      });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.course.failedCopySession') });
    } finally {
      setCopyingSessions(false);
    }
  };

  const patchSessionFromList = async (sessionId, updates) => {
    setSessionUpdatesInFlight((prev) => ({ ...prev, [sessionId]: true }));
    try {
      const toggleOnlyReviewable = Object.keys(updates).length === 1 && Object.prototype.hasOwnProperty.call(updates, 'reviewable');
      const result = toggleOnlyReviewable
        ? await toggleSessionReviewable({
            apiClient,
            sessionId,
            reviewable: updates.reviewable,
          })
        : Object.prototype.hasOwnProperty.call(updates, 'gradesVisible')
          ? (await apiClient.patch(`/sessions/${sessionId}/grades/visibility`, { visibleToStudents: updates.gradesVisible })).data
          : (await apiClient.patch(`/sessions/${sessionId}`, updates)).data;
      const data = result;
      const updated = data.session || data;
      setSessions((prev) => prev.map((session) => (session._id === sessionId ? { ...session, ...updated } : session)));
      const warnings = data.grading?.warnings || [];
      if (warnings.length > 0) {
        setMsg({ severity: 'warning', text: warnings.join(' ') });
      } else {
        setMsg({ severity: 'success', text: t('professor.course.sessionUpdated') });
      }
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.course.failedUpdateSession') });
      refreshSingleSession(sessionId).catch(() => {});
    } finally {
      setSessionUpdatesInFlight((prev) => ({ ...prev, [sessionId]: false }));
    }
  };

  const handleSessionStatusChange = (session, nextStatus) => {
    if (nextStatus === session.status) return;
    if (nextStatus === 'visible' && quizWouldBeLiveImmediately(session)) {
      setScheduledQuizStatusTarget(session);
      return;
    }
    patchSessionFromList(session._id, { status: nextStatus });
  };

  const confirmScheduledQuizStatus = () => {
    const sessionId = scheduledQuizStatusTarget?._id;
    setScheduledQuizStatusTarget(null);
    if (sessionId) {
      patchSessionFromList(sessionId, { status: 'visible' });
    }
  };

  const handleLaunchSession = async (sessionId) => {
    try {
      await apiClient.post(`/sessions/${sessionId}/start`);
      fetchSessions();
      navigate(`/prof/course/${id}/session/${sessionId}/live`);
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.course.failedLaunchSession') });
    }
  };

  if (loading) return <Box sx={{ p: 3 }}><CircularProgress /></Box>;
  if (!course) return <Box sx={{ p: 3 }}><Alert severity="error">{t('professor.course.courseNotFound')}</Alert></Box>;

  const students = sortPeopleByLastName(course.students || []);
  const instructors = sortPeopleByLastName(course.instructors || []);
  const filteredStudents = students.filter((student) => matchesPersonSearch(student, studentSearch));
  const sortedSessions = sortSessions((sessions || []).filter((session) => !session.studentCreated));
  const interactiveSessions = sortedSessions.filter((s) => !s.quiz);
  const quizSessions = sortedSessions.filter((s) => !!s.quiz);
  const liveSessions = sortedSessions.filter((session) => session.status === 'running');
  const interactiveSessionCount = Number(sessionTypeCounts.interactive) || interactiveSessions.length;
  const quizSessionCount = Number(sessionTypeCounts.quizzes) || quizSessions.length;
  const hasMissingCourseProperties = !hasAllCourseEditFields(editFields);
  const headerCourseName = settingsHydratedRef.current ? editFields.name : toText(course.name);
  const headerDeptCode = settingsHydratedRef.current ? editFields.deptCode : toText(course.deptCode);
  const headerCourseNumber = settingsHydratedRef.current ? editFields.courseNumber : toText(course.courseNumber);
  const headerSection = settingsHydratedRef.current ? editFields.section : toText(course.section);
  const headerSemester = settingsHydratedRef.current ? editFields.semester : toText(course.semester);
  const headerTitle = buildCourseTitle(
    {
      name: headerCourseName,
      deptCode: headerDeptCode,
      courseNumber: headerCourseNumber,
      semester: headerSemester,
    },
    'long'
  );

  const chatTabLabel = t('courseChat.title');
  const chatTabMenuLabel = chatUnseenCount > 0
    ? t('courseChat.titleWithUnseen', { count: chatUnseenCount })
    : chatTabLabel;
  const tabItems = [
    { value: 0, label: `${t('professor.course.interactiveSessions')} (${interactiveSessionCount})`, tooltip: t('professor.course.interactiveSessionsHelp') },
    { value: 1, label: `${t('professor.course.quizzes')} (${quizSessionCount})`, tooltip: t('professor.course.quizzesHelp') },
    { value: 2, label: t('professor.course.grades') },
    { value: 3, label: `${t('professor.course.students')} (${students.length})` },
    { value: 4, label: `${t('professor.course.instructors')} (${instructors.length})` },
    { value: 5, label: t('professor.course.groups'), tooltip: t('professor.course.groupsHelp') },
    ...(courseChatEnabled ? [{
      value: chatTabIndex,
      label: (
        <Badge color="error" badgeContent={chatUnseenCount} invisible={chatUnseenCount <= 0}>
          <span>{chatTabLabel}</span>
        </Badge>
      ),
      menuLabel: chatTabMenuLabel,
      tooltip: t('professor.course.courseChatHelp'),
      tabProps: {
        'aria-label': chatTabMenuLabel,
      },
    }] : []),
    ...(videoEnabled ? [{ value: videoTabIndex, label: t('professor.course.video') }] : []),
    ...(aiAvailable && course?.aiEnabled ? [
      { value: aiTabIndex, label: t('professor.course.aiSettings') },
      { value: aiChatTabIndex, label: t('ai.chat.title'), tooltip: t('professor.course.aiChatHelp') },
    ] : []),
    { value: settingsTabIndex, label: t('professor.course.settings') },
    { value: questionLibraryTabIndex, label: t('questionLibrary.title', { defaultValue: 'Question Library' }) },
  ];

  const selectedCopySourceCourse = instructorCourses.find((courseItem) => String(courseItem._id) === String(copySessionsSourceCourseId))
    || instructorCourses.find((courseItem) => String(courseItem._id) === String(id))
    || null;
  const selectedCopyTargetCourse = instructorCourses.find((courseItem) => String(courseItem._id) === String(copySessionTargetCourseId))
    || instructorCourses.find((courseItem) => String(courseItem._id) === String(id))
    || null;
  const copySessionHasZeroPointQuestions = Number(copySessionQuestionSummary?.zeroPointCount) > 0;
  const use24HourNotifications = (course?.quizTimeFormat && course.quizTimeFormat !== 'inherit'
    ? course.quizTimeFormat
    : adminTimeFormat) !== '12h';

  const handleTabChange = (nextTab) => {
    setCourseTab(nextTab);
  };

  const renderSessionList = (sessionItems, emptyText, listTabIndex = 0, totalItemCount = sessionItems.length) => {
    const listStillHydrating = sessionsBackgroundLoading && sessions.length < sessionTotalCount;
    if (sessionsLoading && sessions.length === 0) return <CircularProgress size={24} />;

    const controlsVisible = totalItemCount > 0;
    const controlsDisabled = listStillHydrating;
    const searchTerm = controlsVisible ? String(sessionSearchTerms[listTabIndex] || '') : '';
    const normalizedSearchTerm = controlsDisabled ? '' : normalizeSessionSearchValue(searchTerm);
    const statusFilter = controlsVisible
      ? String(sessionStatusFilters[listTabIndex] || SESSION_STATUS_FILTER_ALL)
      : SESSION_STATUS_FILTER_ALL;
    const needsGradingOnly = controlsVisible ? !!sessionNeedsGradingFilters[listTabIndex] : false;
    const controlsExpanded = controlsVisible && sessionControlsExpanded[listTabIndex] !== false;

    const filteredSessionItems = controlsVisible && !controlsDisabled
      ? sessionItems.filter((session) => {
        const gradingSummary = gradingSummaryBySessionId[String(session?._id || '')] || {};
        const marksNeedingGrading = Number(gradingSummary.marksNeedingGrading || 0);
        const matchesSearch = !normalizedSearchTerm
          || String(session?.name || '').toLowerCase().includes(normalizedSearchTerm);
        const matchesStatus = statusFilter === SESSION_STATUS_FILTER_ALL
          || String(session?.status || '') === statusFilter;
        const matchesNeedsGrading = !needsGradingOnly || marksNeedingGrading > 0;
        return matchesSearch && matchesStatus && matchesNeedsGrading;
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
        {controlsVisible && (
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
                    placeholder={t('professor.course.searchSessionsPlaceholder', { defaultValue: 'Search by session name' })}
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
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}>
                  <FormControlLabel
                    sx={{ m: 0 }}
                    control={(
                      <Switch
                        size="small"
                        checked={needsGradingOnly}
                        onChange={(event) => {
                          setSessionNeedsGradingFilters((prev) => ({ ...prev, [listTabIndex]: event.target.checked }));
                          setSessionPages((prev) => ({ ...prev, [listTabIndex]: 1 }));
                        }}
                        disabled={controlsDisabled}
                      />
                    )}
                    label={<Typography variant="caption">{t('professor.course.needsGradingOnly')}</Typography>}
                  />
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
                </Stack>
              </Stack>
            )}
          </Paper>
        )}
        {listStillHydrating && pageItems.length === 0 && (
          <Paper variant="outlined" sx={{ p: 1.25, mb: hasNoLoadedItems ? 0 : 1.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <CircularProgress size={16} />
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                {t('professor.course.loadingRemainingSessions', {
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
            {t('professor.course.noSessionsMatchFilters', { defaultValue: 'No sessions match the current filters.' })}
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            {pageItems.map((s) => {
              const gradingSummary = gradingSummaryBySessionId[String(s._id)] || {};
              const marksNeedingGrading = Number(gradingSummary.marksNeedingGrading || 0);
              return (
                <SessionListCard
                  key={s._id}
                  highlighted={s.status === 'running'}
                  onClick={() => navigate(
                    getProfessorSessionPrimaryPath(s, id, tab),
                    { state: { returnTab: tab } }
                  )}
                  title={s.name}
                  badges={(
                    <>
                      <SessionStatusChip status={s.status} />
                      {marksNeedingGrading > 0 && (
                        <Chip
                          label={t('professor.course.needsGrading')}
                          size="small"
                          color="warning"
                          variant="filled"
                          sx={COMPACT_CHIP_SX}
                        />
                      )}
                      {s.practiceQuiz && <Chip label={t('professor.course.practice')} size="small" variant="outlined" sx={COMPACT_CHIP_SX} />}
                      {(s.quiz || s.practiceQuiz) && s.quizHasActiveExtensions && (
                        <Chip
                          label={t('professor.course.extensionsActive')}
                          size="small"
                          color="warning"
                          variant="outlined"
                          sx={COMPACT_CHIP_SX}
                        />
                      )}
                    </>
                  )}
                  subtitle={buildProfessorSessionSubtitle(s, t)}
                  actions={(
                    <>
                      {!s.quiz && s.status !== 'running' && s.status !== 'done' && (
                        <Button
                          size="small"
                          variant="contained"
                          color="primary"
                          startIcon={<LaunchIcon />}
                          onClick={() => handleLaunchSession(s._id)}
                          disabled={!!sessionUpdatesInFlight[s._id]}
                          aria-label={t('professor.course.launchSessionAria', { name: s.name })}
                        >
                          {t('professor.course.launch')}
                        </Button>
                      )}
                      {sessionCanShowLiveReviewAction(s) && (
                        <Button
                          size="small"
                          variant="contained"
                          color="success"
                          startIcon={<ReviewIcon />}
                          onClick={() => navigate(
                            `/prof/course/${id}/session/${s._id}/review?returnTab=${tab}`,
                            { state: { returnTab: tab } }
                          )}
                          aria-label={t('professor.course.reviewLiveSessionAria', { name: s.name })}
                        >
                          {t('professor.course.reviewLiveSessionResults')}
                        </Button>
                      )}
                      {sessionWaitingForAnonymousReview(s) && (
                        <Typography variant="body2" color="text.secondary" role="status">
                          {t('professor.sessionReview.anonymousLiveWaiting')}
                        </Typography>
                      )}
                      {sessionCanShowListReviewAction(s) && (
                        <Button
                          size="small"
                          variant="outlined"
                          color="primary"
                          startIcon={<ReviewIcon />}
                          onClick={() => navigate(
                            `/prof/course/${id}/session/${s._id}/review?returnTab=${tab}`,
                            { state: { returnTab: tab } }
                          )}
                          aria-label={t('professor.course.reviewSessionAria', { name: s.name })}
                        >
                          {t('professor.course.review')}
                        </Button>
                      )}
                      <TextField
                        select
                        size="small"
                        label={t('common.status')}
                        value={s.status || 'hidden'}
                        onChange={(event) => handleSessionStatusChange(s, event.target.value)}
                        disabled={!!sessionUpdatesInFlight[s._id]}
                        sx={{ minWidth: s.quiz ? 300 : 122 }}
                      >
                        <MenuItem value="hidden">{t('sessionStatus.draft')}</MenuItem>
                        <MenuItem value="visible">
                          {s.quiz ? t('professor.sessionEditor.liveBasedOnDate') : t('sessionStatus.upcoming')}
                        </MenuItem>
                        <MenuItem value="running">{t('sessionStatus.live')}</MenuItem>
                        <MenuItem value="done">{t('sessionStatus.ended')}</MenuItem>
                      </TextField>
                      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.25 }}>
                        <FormControlLabel
                          sx={{ m: 0 }}
                          control={(
                            <Switch
                              size="small"
                              checked={!!s.reviewable}
                              onChange={(event) => patchSessionFromList(s._id, { reviewable: event.target.checked })}
                              disabled={!!sessionUpdatesInFlight[s._id] || s.status !== 'done' || s.quizHasRemainingExtensions}
                            />
                          )}
                          label={(
                            <Tooltip title={t('professor.course.reviewableHelp')} arrow>
                              <span><Typography variant="caption">{t('professor.course.reviewable')}</Typography></span>
                            </Tooltip>
                          )}
                        />
                        <SessionGradesVisibilityControl
                          session={s}
                          sx={{ '& .MuiFormControlLabel-label': { typography: 'caption' } }}
                          disabled={!!sessionUpdatesInFlight[s._id]}
                          onChange={(checked) => patchSessionFromList(s._id, { gradesVisible: checked })}
                        />
                      </Box>
                      <Tooltip title={t('professor.course.copySession')}>
                        <IconButton
                          size="small"
                          aria-label={t('common.copySession')}
                          onClick={() => {
                            setCopySessionTarget(s);
                            setCopySessionTargetCourseId(id);
                          }}
                          disabled={!!sessionUpdatesInFlight[s._id]}
                        >
                          <CopyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={t('professor.course.deleteSession')}>
                        <IconButton size="small" color="error" aria-label={t('common.deleteSession')} onClick={() => setDeleteSessionTarget(s)} disabled={!!sessionUpdatesInFlight[s._id]}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </>
                  )}
                />
              );
            })}
          </Box>
        )}
        {controlsVisible && totalPages > 1 && (pageItems.length > 0 || listStillHydrating) && (
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
        )}
      </>
    );
  };

  return (
    <Box sx={{ p: 2.5, maxWidth: 980 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            {headerTitle}
          </Typography>
          {headerSection && (
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>
             {t('professor.course.sectionHeader', { section: headerSection })}
            </Typography>
          )}
        </Box>
        <Chip label={course.inactive ? t('professor.course.courseInactive') : t('professor.course.courseActive')} color={course.inactive ? 'default' : 'success'} sx={COMPACT_CHIP_SX} />
      </Box>

      {liveSessions.length > 0 && (
        <Box sx={{ mb: 2.5 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
            {t('dashboard.liveSessions')}
          </Typography>
          <Box sx={{ display: 'grid', gap: 1.25, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {liveSessions.map((session) => (
              <SessionListCard
                key={`live-course-${session._id}`}
                highlighted
                onClick={() => navigate(
                  getProfessorSessionPrimaryPath(session, id, tab),
                  { state: { returnTab: tab } }
                )}
                title={<Typography variant="body1" sx={{ fontWeight: 700 }}>{session.name}</Typography>}
                subtitle={buildProfessorSessionSubtitle(session, t)}
                badges={<SessionStatusChip status={session.status} />}
              />
            ))}
          </Box>
        </Box>
      )}

      {/* Tabs */}
      <ResponsiveTabsNavigation
        value={tab}
        onChange={handleTabChange}
        ariaLabel={t('common.view')}
        dropdownLabel={t('common.view')}
        wrap
        tabs={tabItems}
        dropdownSx={{ mb: 1.5, minWidth: 260, maxWidth: 420 }}
        tabsProps={{
          variant: 'scrollable',
          scrollButtons: 'auto',
          allowScrollButtonsMobile: true,
          sx: {
            mb: 0.5,
          },
        }}
      />

      {/* Interactive Sessions Tab */}
      <TabPanel value={tab} index={0}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6">{t('professor.course.interactiveSessions')}</Typography>
          <Button
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() => {
              if (newSessionNameInputRef.current) newSessionNameInputRef.current.value = '';
              if (newSessionDescInputRef.current) newSessionDescInputRef.current.value = '';
              setCreateSessionOpen(true);
            }}
          >
            {t('professor.course.createSession')}
          </Button>
        </Box>
        {renderSessionList(interactiveSessions, t('professor.course.noInteractiveSessions'), 0, interactiveSessionCount)}
      </TabPanel>

      {/* Quizzes Tab */}
      <TabPanel value={tab} index={1}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6">{t('professor.course.quizzes')}</Typography>
          <Button
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={() => {
              if (newSessionNameInputRef.current) newSessionNameInputRef.current.value = '';
              if (newSessionDescInputRef.current) newSessionDescInputRef.current.value = '';
              setCreateSessionOpen(true);
            }}
          >
            {t('professor.course.createSession')}
          </Button>
        </Box>
        {renderSessionList(quizSessions, t('professor.course.noQuizzes'), 1, quizSessionCount)}
      </TabPanel>

      {/* Grades Tab */}
      <TabPanel value={tab} index={2}>
        <Typography variant="h6" sx={{ mb: 1.5 }}>{t('professor.course.grades')}</Typography>
        <CourseGradesPanel
          courseId={id}
          instructorView
          availableSessions={sortedSessions}
          gradingSummaryBySessionId={gradingSummaryBySessionId}
          onOpenSession={(sessionId) => navigate(
            `/prof/course/${id}/session/${sessionId}/review?returnTab=2`,
            { state: { returnTab: 2 } }
          )}
        />
      </TabPanel>

      {/* Students Tab */}
      <TabPanel value={tab} index={3}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="h6">{t('professor.course.students')}</Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{
            flexWrap: "wrap"
          }}>
            <Tooltip title={t('notifications.manage.tooltip')} describeChild>
              <Button variant="outlined" startIcon={<NotificationsIcon />} onClick={() => setManageNotificationsOpen(true)}>
                {t('notifications.manage.button')}
              </Button>
            </Tooltip>
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setAddStudentOpen(true)}>
              {t('professor.course.addStudent')}
            </Button>
          </Stack>
        </Box>
        <TextField
          label={t('grades.coursePanel.searchStudents')}
          value={studentSearch}
          onChange={(event) => setStudentSearch(event.target.value)}
          fullWidth
          size="small"
          sx={{ mb: 2, maxWidth: 420 }}
        />
        {students.length === 0 ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>{t('professor.course.noStudents')}</Typography>
        ) : filteredStudents.length === 0 ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>{t('groups.noStudentsMatch')}</Typography>
        ) : (
          <Paper variant="outlined">
            <List disablePadding>
              {filteredStudents.map((s, i) => (
                <Box key={s._id || i}>
                  {i > 0 && <Divider />}
                  <StudentListItem
                    student={s}
                    onClick={() => setStudentInfoTarget(s)}
                  />
                </Box>
              ))}
            </List>
          </Paper>
        )}
      </TabPanel>

      {/* Instructors Tab */}
      <TabPanel value={tab} index={4}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="h6">{t('professor.course.instructors')}</Typography>
          <Stack direction="row" spacing={1} useFlexGap sx={{
            flexWrap: "wrap"
          }}>
            <Tooltip title={t('notifications.manage.tooltip')} describeChild>
              <Button variant="outlined" startIcon={<NotificationsIcon />} onClick={() => setManageNotificationsOpen(true)}>
                {t('notifications.manage.button')}
              </Button>
            </Tooltip>
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setAddInstructorOpen(true)}>
              {t('professor.course.addInstructor')}
            </Button>
          </Stack>
        </Box>
        {instructors.length === 0 ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>{t('professor.course.noInstructors')}</Typography>
        ) : (
          <Paper variant="outlined">
            <List disablePadding>
              {instructors.map((inst, i) => (
                <Box key={inst._id || i}>
                  {i > 0 && <Divider />}
                  <ListItem>
                    <ListItemAvatar>
                      <Avatar
                        alt={`${inst.profile?.firstname || ''} ${inst.profile?.lastname || ''}`.trim() || 'Instructor avatar'}
                        src={inst.profile?.profileThumbnail || inst.profile?.profileImage || ''}
                        slotProps={{
                          img: {
                            alt: `${inst.profile?.firstname || ''} ${inst.profile?.lastname || ''}`.trim() || 'Instructor avatar',
                            loading: 'lazy',
                            decoding: 'async',
                          },
                        }}
                        sx={{ width: 36, height: 36, cursor: (inst.profile?.profileImage) ? 'pointer' : 'default' }}
                        onClick={() => {
                          if (inst.profile?.profileImage) setImageViewUrl(inst.profile.profileImage);
                        }}
                      >
                        {(inst.profile?.firstname?.[0] || '').toUpperCase()}
                      </Avatar>
                    </ListItemAvatar>
                    <ListItemText
                      primary={
                        <>
                          {`${inst.profile?.firstname || ''} ${inst.profile?.lastname || ''}`.trim() || 'Unknown'}
                          {(inst.profile?.roles || []).includes('student') && (
                            <Typography
                              component="span"
                              variant="body2"
                              sx={{
                                color: "text.secondary",
                                ml: 0.5
                              }}>
                              ({t('common.ta')})
                            </Typography>
                          )}
                        </>
                      }
                      secondary={inst.emails?.[0]?.address || inst.email || ''}
                    />
                    <ListItemSecondaryAction>
                      <Tooltip title={instructors.length <= 1 ? t('professor.course.cannotRemoveLastInstructor') : t('professor.course.removeInstructorAction')}>
                        <span>
                          <IconButton
                            edge="end"
                            color="error"
                            size="small"
                            aria-label={t('common.removeInstructor')}
                            disabled={instructors.length <= 1}
                            onClick={() => setRemoveInstructorTarget(inst)}
                          >
                            <PersonRemoveIcon fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </ListItemSecondaryAction>
                  </ListItem>
                </Box>
              ))}
            </List>
          </Paper>
        )}
      </TabPanel>

      {/* Groups Tab */}
      <TabPanel value={tab} index={5}>
        <Typography variant="h6" sx={{ mb: 1.5 }}>{t('professor.course.groups')}</Typography>
        <GroupManagementPanel courseId={id} students={students} />
      </TabPanel>

      {courseChatEnabled && (
        <TabPanel value={tab} index={chatTabIndex}>
          <Suspense fallback={<Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}><CircularProgress /></Box>}>
            <CourseChatPanel
              courseId={id}
              enabled={courseChatEnabled}
              role="professor"
              syncTransport="unknown"
              refreshToken={chatRefreshToken}
              chatEvent={chatEvent}
            />
          </Suspense>
        </TabPanel>
      )}

      {/* Video Tab (conditional) */}
      {videoEnabled && (
        <TabPanel value={tab} index={videoTabIndex}>
          <Typography variant="h6" sx={{ mb: 1.5 }}>{t('video.title')}</Typography>
          <VideoChatPanel
            courseId={id}
            course={course}
            isInstructor
            onCourseRefresh={fetchCourse}
          />
        </TabPanel>
      )}

      {aiAvailable && course?.aiEnabled && (
        <TabPanel value={tab} index={aiTabIndex}>
          <Box sx={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="h6">{t('professor.course.aiSettings')}</Typography>
            {!aiConfig ? <CircularProgress size={24} /> : <>
              <TextField select label={t('professor.course.aiDefaultModel')} value={`${aiConfig.defaultBackendId}::${aiConfig.defaultModelId}`} onChange={(event) => {
                const [defaultBackendId, defaultModelId] = event.target.value.split('::');
                handleAiCourseDefaultChange(defaultBackendId, defaultModelId);
              }} fullWidth>
                {getApprovedCourseAiModels(aiConfig).map(({ backend, model, displayName }) => <MenuItem key={`${backend.id}-${model.id}`} value={`${backend.id}::${model.id}`}>{displayName}</MenuItem>)}
              </TextField>
              <TextField
                type="number"
                label={t('professor.course.instructorAiChatMaxToolRounds')}
                value={aiConfig.instructorChatMaxToolRounds ?? 20}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 1 && value <= 50) handleAiConfigChange({ instructorChatMaxToolRounds: value });
                }}
                helperText={t('professor.course.instructorAiChatMaxToolRoundsHelp')}
                slotProps={{ htmlInput: { min: 1, max: 50, step: 1 } }}
                fullWidth
              />
              <FormControlLabel
                control={<Switch checked={!!aiConfig.studentChatEnabled} onChange={handleStudentAiChatEnabledChange} />}
                label={(
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                    <Typography>{t('professor.course.enableStudentAiChat')}</Typography>
                    <Tooltip title={t('professor.course.enableStudentAiChatHelp')} arrow>
                      <InfoOutlinedIcon fontSize="small" color="action" />
                    </Tooltip>
                  </Box>
                )}
              />
              {aiConfig.studentChatEnabled ? <>
                <TextField
                  multiline
                  minRows={6}
                  label={t('professor.course.studentAiChatGuidance')}
                  value={aiConfig.studentChatGuidance || ''}
                  onChange={(event) => handleAiConfigChange({ studentChatGuidance: event.target.value })}
                  fullWidth
                />
                <TextField
                  select
                  label={t('professor.course.studentAiDefaultModel')}
                  value={aiConfig.studentDefaultBackendId && aiConfig.studentDefaultModelId ? `${aiConfig.studentDefaultBackendId}::${aiConfig.studentDefaultModelId}` : ''}
                  onChange={(event) => {
                    const [studentDefaultBackendId, studentDefaultModelId] = event.target.value.split('::');
                    handleAiConfigChange({ studentDefaultBackendId, studentDefaultModelId });
                  }}
                  helperText={getStudentCourseAiModels(aiConfig).length ? undefined : t('professor.course.studentAiModelUnavailable')}
                  fullWidth
                >
                  {getStudentCourseAiModels(aiConfig).map(({ backend, model, displayName }) => <MenuItem key={`${backend.id}-${model.id}`} value={`${backend.id}::${model.id}`}>{displayName}</MenuItem>)}
                </TextField>
                <TextField
                  type="number"
                  label={t('professor.course.studentAiChatMaxToolRounds')}
                  value={aiConfig.studentChatMaxToolRounds ?? 5}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isInteger(value) && value >= 1 && value <= 50) handleAiConfigChange({ studentChatMaxToolRounds: value });
                  }}
                  helperText={t('professor.course.studentAiChatMaxToolRoundsHelp')}
                  slotProps={{ htmlInput: { min: 1, max: 50, step: 1 } }}
                  fullWidth
                />
              </> : null}
              <Typography variant="subtitle2">{t('professor.course.aiAdminModels')}</Typography>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {t('professor.course.aiAdminModelsHelp')}
              </Typography>
              <AiBackendManager
                backends={aiConfig.adminBackends}
                courseId={id}
                canAddBackends={false}
                readOnly
                onChange={(adminBackends) => setAiConfig((current) => ({ ...current, adminBackends }))}
                defaultBackendId={aiConfig.defaultBackendId}
                defaultModelId={aiConfig.defaultModelId}
                modelPolicies={aiConfig.modelPolicies}
                onModelPoliciesChange={handleAiModelPoliciesChange}
              />
              {aiCoursePolicy.allowCourseBackend ? <>
                <Divider />
                <Typography variant="subtitle2">{t('professor.course.aiCourseModels')}</Typography>
                <Typography variant="body2" sx={{
                  color: "text.secondary"
                }}>{t('professor.course.aiBackendHelp')}</Typography>
                <AiBackendManager
                  backends={aiConfig.courseBackends}
                  courseId={id}
                  canAddBackends
                  onChange={(backends, options) => { setAiConfig((current) => ({ ...current, courseBackends: backends })); handleAiBackendChange('backends', backends, options); }}
                  defaultBackendId={aiConfig.defaultBackendId}
                  defaultModelId={aiConfig.defaultModelId}
                  onDefaultChange={handleAiCourseDefaultChange}
                  modelPolicies={aiConfig.modelPolicies}
                  onModelPoliciesChange={handleAiModelPoliciesChange}
                />
              </> : <>
                <Alert severity="info">{t('professor.course.aiAdminBackendOnly')}</Alert>
              </>}
            </>}
            <Divider />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              <Typography variant="subtitle2">{t('professor.course.copyRubrics')}</Typography>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>{t('professor.course.copyRubricsHelp')}</Typography>
              <TextField select size="small" label={t('professor.course.copyRubricsSource')} value={rubricSourceCourseId} onChange={(event) => setRubricSourceCourseId(event.target.value)}>
                {rubricSourceCourses.map((sourceCourse) => (
                  <MenuItem key={sourceCourse._id} value={sourceCourse._id}>{buildCourseTitle(sourceCourse)}</MenuItem>
                ))}
              </TextField>
              <Box>
                <Button variant="outlined" onClick={handleCopyRubrics} disabled={!rubricSourceCourseId || copyingRubrics}>
                  {copyingRubrics ? t('common.saving') : t('professor.course.copyRubrics')}
                </Button>
                <Button variant="outlined" sx={{ ml: 1 }} onClick={openRubricManager}>{t('professor.course.manageRubrics')}</Button>
              </Box>
              <Dialog open={rubricManagerOpen} onClose={() => setRubricManagerOpen(false)} fullWidth maxWidth="sm">
                <DialogTitle>{t('professor.course.manageRubrics')}</DialogTitle>
                <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  <TextField select label={t('professor.course.rubricType')} value={rubricKind} onChange={(event) => { setRubricKind(event.target.value); setActiveRubricId(''); setRubricDraft({ name: '', content: '' }); }}><MenuItem value="grading">{t('grades.aiGrading.gradingInstructions')}</MenuItem><MenuItem value="feedback">{t('grades.aiGrading.feedbackToStudentInstructions')}</MenuItem><MenuItem value="summary">{t('professor.course.summaryInstructions')}</MenuItem></TextField>
                  <Autocomplete options={courseRubrics.filter((entry) => entry.kind === rubricKind)} value={courseRubrics.find((entry) => entry._id === activeRubricId) || null} getOptionLabel={(entry) => entry.name} onChange={(_, entry) => { setActiveRubricId(entry?._id || ''); setRubricDraft(entry ? { name: entry.name, content: entry.content } : { name: '', content: '' }); }} renderInput={(params) => <TextField {...params} label={t('professor.course.selectRubric')} />} />
                  <TextField label={t('common.name')} value={rubricDraft.name} onChange={(event) => setRubricDraft((current) => ({ ...current, name: event.target.value }))} />
                  <TextField multiline minRows={5} label={t('professor.course.rubricInstructions')} value={rubricDraft.content} onChange={(event) => setRubricDraft((current) => ({ ...current, content: event.target.value }))} />
                </DialogContent>
                <DialogActions><Button color="error" onClick={deleteCourseRubric} disabled={!activeRubricId}>{t('common.delete')}</Button><Button onClick={() => setRubricManagerOpen(false)}>{t('common.close')}</Button><Button variant="contained" onClick={saveCourseRubric} disabled={!rubricDraft.name.trim() || !rubricDraft.content.trim()}>{t('common.save')}</Button></DialogActions>
              </Dialog>
            </Box>
          </Box>
        </TabPanel>
      )}

      {aiAvailable && course?.aiEnabled && <TabPanel value={tab} index={aiChatTabIndex}><AiCourseChat courseId={id} /></TabPanel>}

      {/* Settings Tab */}
      <TabPanel value={tab} index={settingsTabIndex}>
        <Box sx={{ maxWidth: 500, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <AutoSaveStatus status={settingsAutoSaveStatus} errorText={settingsAutoSaveError} />
          {hasMissingCourseProperties && (
            <Alert severity="warning">
              {t('professor.course.allFieldsRequired')}
            </Alert>
          )}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Typography>{t('professor.course.enrollmentCode', { code: course.enrollmentCode })}</Typography>
              <Tooltip title={t('professor.course.enrollmentCodeHelp')} arrow>
                <InfoOutlinedIcon fontSize="small" color="action" />
              </Tooltip>
            </Box>
            <Button size="small" startIcon={<CopyIcon />} onClick={copyCode}>
              {t('professor.course.copy')}
            </Button>
            <Button size="small" startIcon={<RefreshIcon />} onClick={handleRegenerateCode}>
              {t('professor.course.regenerate')}
            </Button>
          </Box>
          <FormControlLabel
            control={<Switch checked={!course.inactive} onChange={handleToggleActive} />}
            label={(
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Typography>{course.inactive ? t('professor.course.courseInactive') : t('professor.course.courseActive')}</Typography>
                <Tooltip title={t('professor.course.courseActiveHelp')} arrow>
                  <InfoOutlinedIcon fontSize="small" color="action" />
                </Tooltip>
              </Box>
            )}
          />
          <Autocomplete
            multiple
            freeSolo
            options={editFields.tags}
            value={editFields.tags}
            onChange={(_event, nextValue) => {
              const normalizedTags = [...new Set(
                (nextValue || [])
                  .map((tag) => String(tag?.label || tag?.value || tag || '').trim())
                  .filter(Boolean)
              )];
              setEditFields((current) => ({ ...current, tags: normalizedTags }));
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('professor.course.topics')}
                placeholder={t('professor.course.topicsPlaceholder')}
                helperText={t('professor.course.topicsHelp')}
              />
            )}
          />
          <FormControlLabel
            control={<Switch checked={!!course.aiEnabled} onChange={handleAiEnabledChange} disabled={!aiAvailable} />}
            label={(
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Typography>{t('professor.course.enableAiHelper')}</Typography>
                <Tooltip title={aiAvailable ? t('professor.course.aiHelperHelp') : t('professor.course.aiRequiresAdminAuthorization')} arrow>
                  <InfoOutlinedIcon fontSize="small" color="action" />
                </Tooltip>
              </Box>
            )}
          />
          {!ssoEnabled ? (
            <FormControlLabel
              control={(
                <Switch
                  checked={!!course.requireVerified}
                  onChange={handleToggleRequireVerified}
                />
              )}
              label={t('professor.course.requireVerifiedEnroll')}
            />
          ) : null}
          <FormControlLabel
            control={
              <Switch
                checked={!!course.allowStudentQuestions}
                onChange={handleToggleAllowStudentQuestions}
              />
            }
            label={(
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Typography variant="body2">
                  {t('professor.course.allowStudentQuestions')}
                </Typography>
                <Tooltip title={t('professor.course.allowStudentQuestionsHelp')}>
                  <InfoOutlinedIcon fontSize="small" color="action" />
                </Tooltip>
              </Box>
            )}
          />
          <FormControlLabel
            control={<Switch checked={!!course.allowSharedActivities} onChange={handleToggleAllowSharedActivities} />}
            label={(
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Typography variant="body2">{t('professor.course.allowSharedActivities')}</Typography>
                <Tooltip title={t('professor.course.allowSharedActivitiesHelp')}>
                  <InfoOutlinedIcon fontSize="small" color="action" />
                </Tooltip>
              </Box>
            )}
          />
          <TextField
            select
            size="small"
            label={t('professor.course.quizTimeFormat')}
            value={course.quizTimeFormat || 'inherit'}
            onChange={(event) => handleQuizTimeFormatChange(event.target.value)}
          >
            <MenuItem value="inherit">
              {t('professor.course.quizTimeFormatInherit', {
                defaultFormat: t(`professor.course.quizTimeFormatOptions.${adminTimeFormat}`),
              })}
            </MenuItem>
            <MenuItem value="24h">{t('professor.course.quizTimeFormatOptions.24h')}</MenuItem>
            <MenuItem value="12h">{t('professor.course.quizTimeFormatOptions.12h')}</MenuItem>
          </TextField>
          <FormControlLabel
            control={(
              <Switch
                checked={!!course.courseChatEnabled}
                onChange={handleCourseChatEnabledChange}
              />
            )}
            label={t('courseChat.enableCourseChat')}
          />
          {course.courseChatEnabled ? (
            <TextField
              select
              size="small"
              label={t('courseChat.retentionDays')}
              value={String(course.courseChatRetentionDays || 14)}
              onChange={handleCourseChatRetentionChange}
              helperText={t('courseChat.retentionHelp')}
            >
              {[1, 3, 7, 14, 30, 60, 90, 180, 365].map((days) => (
                <MenuItem key={`course-chat-retention-${days}`} value={String(days)}>
                  {t('courseChat.retentionDaysValue', { count: days })}
                </MenuItem>
              ))}
            </TextField>
          ) : null}
          <Divider sx={{ my: 1 }} />
          <Typography variant="h6">{t('professor.course.courseProperties')}</Typography>
          <TextField
            label={t('professor.course.courseName')}
            value={editFields.name}
            onChange={(e) => setEditFields((s) => ({ ...s, name: e.target.value }))}
            error={isEmptyField(editFields.name)}
            helperText={isEmptyField(editFields.name) ? t('professor.course.courseNameRequired') : undefined}
            fullWidth
          />
          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField
              label={t('professor.course.deptCode')}
              value={editFields.deptCode}
              onChange={(e) => setEditFields((s) => ({ ...s, deptCode: e.target.value }))}
              error={isEmptyField(editFields.deptCode)}
              helperText={isEmptyField(editFields.deptCode) ? t('professor.course.deptCodeRequired') : undefined}
              sx={{ flex: 1 }}
            />
            <TextField
              label={t('professor.course.courseNumber')}
              value={editFields.courseNumber}
              onChange={(e) => setEditFields((s) => ({ ...s, courseNumber: e.target.value }))}
              error={isEmptyField(editFields.courseNumber)}
              helperText={isEmptyField(editFields.courseNumber) ? t('professor.course.courseNumberRequired') : undefined}
              sx={{ flex: 1 }}
            />
          </Box>
          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField
              label={t('professor.course.sectionLabel')}
              value={editFields.section}
              onChange={(e) => setEditFields((s) => ({ ...s, section: e.target.value }))}
              error={isEmptyField(editFields.section)}
              helperText={isEmptyField(editFields.section) ? t('professor.course.sectionRequired') : undefined}
              sx={{ flex: 1 }}
            />
            <TextField
              label={t('professor.course.semester')}
              value={editFields.semester}
              onChange={(e) => setEditFields((s) => ({ ...s, semester: e.target.value }))}
              error={isEmptyField(editFields.semester)}
              helperText={isEmptyField(editFields.semester) ? t('professor.course.semesterRequired') : t('professor.course.semesterLegacyHelp')}
              sx={{ flex: 1 }}
            />
          </Box>
          <Divider sx={{ my: 1 }} />
          <Button variant="outlined" color="error" startIcon={<DeleteIcon />} onClick={() => setDeleteOpen(true)}>
            {t('professor.course.deleteCourse')}
          </Button>
        </Box>
      </TabPanel>

      <TabPanel value={tab} index={questionLibraryTabIndex}>
        <Suspense fallback={<Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}><CircularProgress /></Box>}>
          <QuestionLibraryPanel
            courseId={id}
            availableSessions={sortedSessions}
            onSessionsChanged={fetchSessions}
          />
        </Suspense>
      </TabPanel>

      {/* Add Student Dialog */}
      <Dialog open={addStudentOpen} onClose={() => setAddStudentOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('professor.course.addStudentTitle')}</DialogTitle>
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            handleAddStudent();
          }}
        >
          <DialogContent sx={{ pt: '8px !important' }}>
            <TextField
              label={t('professor.course.studentEmail')}
              type="email"
              value={studentEmail}
              onChange={(e) => setStudentEmail(e.target.value)}
              fullWidth
              autoFocus
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setAddStudentOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={addingStudent || !studentEmail.trim()}>
              {addingStudent ? t('professor.course.adding') : t('common.add')}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      {/* Add Instructor Dialog */}
      <Dialog open={addInstructorOpen} onClose={() => setAddInstructorOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('professor.course.addInstructorTitle')}</DialogTitle>
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            handleAddInstructor();
          }}
        >
          <DialogContent sx={{ pt: '8px !important' }}>
            <TextField
              label={t('professor.course.userIdOrEmail', { defaultValue: 'User ID or email' })}
              value={instructorUserId}
              onChange={(e) => setInstructorUserId(e.target.value)}
              fullWidth
              autoFocus
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setAddInstructorOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={addingInstructor || !instructorUserId.trim()}>
              {addingInstructor ? t('professor.course.adding') : t('common.add')}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)}>
        <DialogTitle>{t('professor.course.deleteCourse')}</DialogTitle>
        <DialogContent>
          {t('professor.course.deleteCourseConfirm', { name: course.name })}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" onClick={handleDelete} disabled={deleting}>
            {deleting ? t('professor.course.deleting') : t('common.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Student Info Modal */}
      <StudentInfoModal
        open={!!studentInfoTarget}
        onClose={() => setStudentInfoTarget(null)}
        student={studentInfoTarget}
        course={course}
        courseId={id}
        onRemoved={() => {
          setStudentInfoTarget(null);
          fetchCourse();
          setMsg({ severity: 'success', text: t('professor.course.studentRemoved') });
        }}
      />

      {/* Confirm Remove Student */}
      <Dialog open={!!removeStudentTarget} onClose={() => setRemoveStudentTarget(null)}>
        <DialogTitle>{t('professor.course.removeStudent')}</DialogTitle>
        <DialogContent>
          {t('professor.course.removeStudentConfirm', { name: `${removeStudentTarget?.profile?.firstname || ''} ${removeStudentTarget?.profile?.lastname || ''}`.trim() })}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoveStudentTarget(null)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" onClick={() => handleRemoveStudent(removeStudentTarget?._id)}>
            {t('common.remove')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Confirm Remove Instructor */}
      <Dialog open={!!removeInstructorTarget} onClose={() => setRemoveInstructorTarget(null)}>
        <DialogTitle>{t('professor.course.removeInstructor')}</DialogTitle>
        <DialogContent>
          {t('professor.course.removeInstructorConfirm', { name: `${removeInstructorTarget?.profile?.firstname || ''} ${removeInstructorTarget?.profile?.lastname || ''}`.trim() })}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoveInstructorTarget(null)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" onClick={() => handleRemoveInstructor(removeInstructorTarget?._id)}>
            {t('common.remove')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Full-size image viewer */}
      <Dialog open={!!imageViewUrl} onClose={() => setImageViewUrl(null)} maxWidth="sm" fullWidth>
        <DialogContent sx={{ textAlign: 'center', p: 2 }}>
          <img src={imageViewUrl} alt="Profile" style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImageViewUrl(null)}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>

      <ManageNotificationsDialog
        open={manageNotificationsOpen}
        onClose={() => setManageNotificationsOpen(false)}
        scopeType="course"
        courseId={id}
        title={t('notifications.manage.courseDialogTitle', { course: headerTitle })}
        use24Hour={use24HourNotifications}
      />

      <Dialog
        open={!!scheduledQuizStatusTarget}
        onClose={() => setScheduledQuizStatusTarget(null)}
      >
        <DialogTitle>{t('professor.sessionEditor.liveBasedOnDate')}</DialogTitle>
        <DialogContent>
          <Typography>{t('professor.sessionEditor.scheduledQuizLiveWarning')}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setScheduledQuizStatusTarget(null)}>{t('common.cancel')}</Button>
          <Button variant="contained" color="warning" onClick={confirmScheduledQuizStatus}>
            {t('professor.sessionEditor.makeQuizLive')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Create Session Dialog */}
      <Dialog
        open={createSessionOpen}
        onClose={() => {
          setCreateSessionOpen(false);
          if (newSessionNameInputRef.current) newSessionNameInputRef.current.value = '';
          if (newSessionDescInputRef.current) newSessionDescInputRef.current.value = '';
        }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t('professor.course.createSession')}</DialogTitle>
        <Box
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            handleCreateSession();
          }}
        >
          <DialogContent sx={{ pt: '8px !important', display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField label={t('professor.course.sessionName')} inputRef={newSessionNameInputRef} fullWidth autoFocus />
            <TextField label={t('professor.course.description')} inputRef={newSessionDescInputRef} fullWidth multiline rows={2} />
            <Button
              variant="outlined"
              startIcon={<CopyIcon />}
              onClick={() => {
                setCreateSessionOpen(false);
                if (newSessionNameInputRef.current) newSessionNameInputRef.current.value = '';
                if (newSessionDescInputRef.current) newSessionDescInputRef.current.value = '';
                setCopySessionsSourceCourseId(id);
                setSelectedCopySessionIds([]);
                setCopySessionsDialogOpen(true);
              }}
            >
              {t('professor.course.copySessionsFromCourse')}
            </Button>
          </DialogContent>
          <DialogActions>
            <Button
              onClick={() => {
                setCreateSessionOpen(false);
                if (newSessionNameInputRef.current) newSessionNameInputRef.current.value = '';
                if (newSessionDescInputRef.current) newSessionDescInputRef.current.value = '';
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" variant="contained" disabled={creatingSess}>
              {creatingSess ? t('professor.dashboard.creating') : t('common.create')}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <SessionSelectorDialog
        open={copySessionsDialogOpen}
        title={t('professor.course.copySessionsDialogTitle')}
        sessions={copySessionsSourceSessions}
        selectedIds={selectedCopySessionIds}
        headerContent={(
          <Autocomplete
            options={instructorCourses}
            value={selectedCopySourceCourse}
            isOptionEqualToValue={(option, value) => String(option?._id) === String(value?._id)}
            onChange={(_event, nextValue) => {
              setCopySessionsSourceCourseId(nextValue?._id || id);
              setSelectedCopySessionIds([]);
            }}
            getOptionLabel={(option) => buildCourseSelectionLabel(option)}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('professor.course.sourceCourse')}
                sx={{ mb: 1.25 }}
              />
            )}
          />
        )}
        getSessionSecondaryText={(sessionItem) => (
          `${t('professor.course.questionCount', { count: (sessionItem.questions || []).length })} · ${t('grades.coursePanel.sessionStatus', {
            status: sessionItem.status,
            defaultValue: `Status: ${sessionItem.status}`,
          })}`
        )}
        onChange={setSelectedCopySessionIds}
        onClose={() => {
          setCopySessionsDialogOpen(false);
          setSelectedCopySessionIds([]);
        }}
        onConfirm={handleCopySelectedSessions}
        confirmLabel={copyingSessions ? t('professor.course.copyingSessions') : t('professor.course.copySelectedSessions')}
      />

      <Dialog open={!!copySessionTarget} onClose={() => setCopySessionTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('professor.course.copySessionToCourse')}</DialogTitle>
        <DialogContent sx={{ pt: '8px !important', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {copySessionTarget ? t('professor.course.copySessionConfirm', { name: copySessionTarget.name }) : ''}
          </Typography>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t('professor.course.copySessionPointsHelp')}
          </Typography>
          <Autocomplete
            options={instructorCourses}
            value={selectedCopyTargetCourse}
            isOptionEqualToValue={(option, value) => String(option?._id) === String(value?._id)}
            onChange={(_event, nextValue) => setCopySessionTargetCourseId(nextValue?._id || id)}
            getOptionLabel={(option) => buildCourseSelectionLabel(option)}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('professor.course.destinationCourse')}
              />
            )}
          />
          <FormControlLabel
            control={(
              <Checkbox
                checked={copySessionPreservePoints}
                onChange={(event) => setCopySessionPreservePoints(event.target.checked)}
              />
            )}
            label={t('professor.course.copySessionPreservePoints')}
          />
          {copySessionPreservePoints && copySessionHasZeroPointQuestions ? (
            <Alert severity="warning">
              {t('professor.course.copySessionPreservePointsWarning', {
                count: copySessionQuestionSummary.zeroPointCount,
              })}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCopySessionTarget(null)}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={handleCopySession} disabled={copyingSession || !copySessionTargetCourseId}>
            {copyingSession ? t('professor.course.copyingSession') : t('common.copy', { defaultValue: 'Copy' })}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Session Confirmation */}
      <Dialog open={!!deleteSessionTarget} onClose={() => setDeleteSessionTarget(null)}>
        <DialogTitle>{t('professor.course.deleteSession')}</DialogTitle>
        <DialogContent>
          {t('professor.course.deleteSessionConfirm', { name: deleteSessionTarget?.name || '' })}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteSessionTarget(null)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" onClick={() => handleDeleteSession(deleteSessionTarget?._id)}>
            {t('common.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)}>
        {msg ? <Alert severity={msg.severity} onClose={() => setMsg(null)}>{msg.text}</Alert> : undefined}
      </Snackbar>
    </Box>
  );
}
