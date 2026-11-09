import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLocation, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box, Typography, Button, TextField, Paper,
  IconButton, Dialog, DialogTitle, DialogContent, DialogActions,
  Alert, Snackbar, Switch, FormControlLabel, CircularProgress,
  Card, CardContent, Tooltip, FormControl, InputLabel, Select, MenuItem,
  Checkbox, Chip,
  Menu, Autocomplete, Stack,
} from '@mui/material';
import {
  ContentCopy as CopyIcon, Delete as DeleteIcon,
  Add as AddIcon, Edit as EditIcon,
  Close as CloseIcon,
  KeyboardArrowUp as UpIcon, KeyboardArrowDown as DownIcon,
  ExpandMore as ExpandMoreIcon,
  MoreVert as MoreIcon,
  PlayArrow as LaunchIcon, Login as JoinIcon,
  RateReview as ReviewIcon,
  Download as DownloadIcon, Upload as UploadIcon,
  InfoOutlined as InfoOutlinedIcon, Refresh as RefreshIcon,
} from '@mui/icons-material';
import apiClient from '../../api/client';
import QuestionEditor from '../../components/questions/QuestionEditor';
import QuestionDisplay from '../../components/questions/QuestionDisplay';
import QuestionLibraryPanel from '../../components/questions/QuestionLibraryPanel';
import { isSlideType } from '../../components/questions/constants';
import AutoSaveStatus from '../../components/common/AutoSaveStatus';
import BackLinkButton from '../../components/common/BackLinkButton';
import DateTimePreferenceField from '../../components/common/DateTimePreferenceField';
import SessionStatusChip from '../../components/common/SessionStatusChip';
import SessionGradesVisibilityControl from '../../components/common/SessionGradesVisibilityControl';
import { buildCourseTitle } from '../../utils/courseTitle';
import { quizWouldBeLiveImmediately } from '../../utils/studentSessions';
import { sessionCanShowLiveReviewAction, sessionWaitingForAnonymousReview } from '../../utils/professorSessions';
import { LiveSessionWebSocketProvider, useLiveSessionWebSocket } from '../../contexts/LiveSessionWebSocketContext';
import {
  buildSessionExportFilename,
  buildPrintableSessionHtml,
  downloadPdf,
  downloadJson,
} from '../../utils/sessionExport';
import { toggleSessionReviewable } from '../../utils/reviewableToggle';
import { useTranslation } from 'react-i18next';

const PAGE_SECTION_GAP = 1.5;
const SETTINGS_STACK_GAP = 1.5;
const QUIZ_WINDOW_VALIDATION_MESSAGE = 'professor.sessionEditor.quizEndAfterStart';
const DEFAULT_MS_SCORING_METHOD = 'right-minus-wrong';
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

const MAX_COURSE_TAB_INDEX = 4;

function parseCourseTab(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return 0;
  if (parsed < 0 || parsed > MAX_COURSE_TAB_INDEX) return 0;
  return parsed;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toDateTimeLocalString(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}T${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;
}

function floorDateToNearestHalfHour(value = new Date()) {
  const nextDate = new Date(value);
  nextDate.setSeconds(0, 0);
  const minutes = nextDate.getMinutes();
  nextDate.setMinutes(minutes < 30 ? 0 : 30, 0, 0);
  return nextDate;
}

function buildDefaultQuizWindow() {
  const start = floorDateToNearestHalfHour(new Date());
  const end = new Date(start.getTime() + TWELVE_HOURS_MS);
  return {
    quizStart: toDateTimeLocalString(start),
    quizEnd: toDateTimeLocalString(end),
  };
}

function buildTodayQuizWindow() {
  const start = floorDateToNearestHalfHour(new Date());
  const end = new Date(start.getTime() + TWELVE_HOURS_MS);
  return {
    quizStart: toDateTimeLocalString(start),
    quizEnd: toDateTimeLocalString(end),
  };
}

function normalizeTagValues(tags = []) {
  return [...new Set(
    (tags || [])
      .map((tag) => String(tag?.label || tag?.value || tag || '').trim())
      .filter(Boolean)
  )];
}

function toTagObjects(tags = []) {
  return normalizeTagValues(tags).map((tag) => ({ value: tag, label: tag }));
}

function mergeQuestionTagsWithSessionTags(questionTags = [], sessionTags = [], allowedTags = []) {
  const allowedTagSet = new Set(normalizeTagValues(allowedTags).map((tag) => tag.toLowerCase()));
  const mergedTags = [];
  const seenTags = new Set();

  const addTag = (tag) => {
    const normalizedTag = String(tag || '').trim();
    const normalizedKey = normalizedTag.toLowerCase();
    if (!normalizedKey || seenTags.has(normalizedKey)) return;
    seenTags.add(normalizedKey);
    mergedTags.push(normalizedTag);
  };

  normalizeTagValues(questionTags).forEach(addTag);
  normalizeTagValues(sessionTags)
    .filter((tag) => allowedTagSet.has(tag.toLowerCase()))
    .forEach(addTag);

  return mergedTags;
}

function buildExtendedQuizEnd(endValue = '', startValue = '') {
  const parsedEnd = endValue ? new Date(endValue) : null;
  const parsedStart = startValue ? new Date(startValue) : null;
  const endBase = parsedEnd && !Number.isNaN(parsedEnd.getTime())
    ? parsedEnd
    : parsedStart && !Number.isNaN(parsedStart.getTime())
      ? parsedStart
      : floorDateToNearestHalfHour(new Date());
  endBase.setSeconds(0, 0);
  const end = new Date(endBase.getTime() + TWELVE_HOURS_MS);
  return {
    quizEnd: toDateTimeLocalString(end),
  };
}

function formatStudentLabel(student) {
  const first = String(student?.profile?.firstname || '').trim();
  const last = String(student?.profile?.lastname || '').trim();
  const email = String(student?.emails?.[0]?.address || student?.email || '').trim();
  const fullName = `${first} ${last}`.trim();
  if (fullName && email) return `${fullName} (${email})`;
  return fullName || email || 'Unknown Student';
}

function compareStudentsByLastName(a, b) {
  const aLast = String(a?.profile?.lastname || '').trim();
  const bLast = String(b?.profile?.lastname || '').trim();
  const lastCmp = aLast.localeCompare(bLast);
  if (lastCmp !== 0) return lastCmp;
  const aFirst = String(a?.profile?.firstname || '').trim();
  const bFirst = String(b?.profile?.firstname || '').trim();
  const firstCmp = aFirst.localeCompare(bFirst);
  if (firstCmp !== 0) return firstCmp;
  const aEmail = String(a?.emails?.[0]?.address || a?.email || '').trim();
  const bEmail = String(b?.emails?.[0]?.address || b?.email || '').trim();
  return aEmail.localeCompare(bEmail);
}

// Only update availability: a submission must not overwrite unsaved editor fields.
function AnonymousQuizReviewUpdates({ sessionId, setSession }) {
  const { subscribe, registerRefreshHandler } = useLiveSessionWebSocket();
  useEffect(() => {
    let stopped = false;
    const updateCount = (count) => {
      if (!stopped && Number.isFinite(count)) setSession((previous) => previous
        ? { ...previous, submittedCount: Math.max(previous.submittedCount || 0, count) } : previous);
    };
    const unsubscribe = subscribe(({ event, data }) => {
      if (event === 'session:quiz-submitted' && data?.anonymous) updateCount(data.submittedCount);
    });
    const unregister = registerRefreshHandler(async () => {
      try {
        const { data } = await apiClient.get(`/sessions/${sessionId}`);
        updateCount(data.session?.submittedCount);
      } catch { /* The next reconnect/focus can recover availability. */ }
    });
    return () => { stopped = true; unsubscribe(); unregister(); };
  }, [registerRefreshHandler, sessionId, setSession, subscribe]);
  return null;
}

export default function SessionEditor() {
  const { courseId, sessionId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const returnTab = parseCourseTab(searchParams.get('returnTab') ?? location.state?.returnTab);
  const returnToReview = (searchParams.get('returnTo') || location.state?.returnTo) === 'review';
  const { t } = useTranslation();
  const sessionReviewLink = returnTab === 0
    ? `/prof/course/${courseId}/session/${sessionId}/review`
    : `/prof/course/${courseId}/session/${sessionId}/review?returnTab=${returnTab}`;
  const courseBackLink = returnTab === 0
    ? `/prof/course/${courseId}`
    : `/prof/course/${courseId}?tab=${returnTab}`;
  const backLink = returnToReview ? sessionReviewLink : courseBackLink;

  const [session, setSession] = useState(null);
  const [course, setCourse] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);

  // Edit session fields
  const [editFields, setEditFields] = useState({ name: '', description: '' });
  const [savingSession, setSavingSession] = useState(false);
  const [sessionSaveStatus, setSessionSaveStatus] = useState('idle');
  const [sessionSaveError, setSessionSaveError] = useState('');
  const [applyingSessionTags, setApplyingSessionTags] = useState(false);
  const [allQuestionPoints, setAllQuestionPoints] = useState('1');
  const [applyingQuestionPoints, setApplyingQuestionPoints] = useState(false);

  // Quiz settings
  const [quiz, setQuiz] = useState(false);
  const [practiceQuiz, setPracticeQuiz] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [quizStart, setQuizStart] = useState('');
  const [quizEnd, setQuizEnd] = useState('');
  const [msScoringMethod, setMsScoringMethod] = useState(DEFAULT_MS_SCORING_METHOD);
  const [reviewable, setReviewable] = useState(false);
  const [status, setStatus] = useState('hidden');
  const [sessionDate, setSessionDate] = useState('');
  const [use24HourTime, setUse24HourTime] = useState(true);
  const [sessionTags, setSessionTags] = useState([]);

  // Join code settings
  const [joinCodeEnabled, setJoinCodeEnabled] = useState(false);
  const [joinCodeInterval, setJoinCodeInterval] = useState(10);
  const [activityShare, setActivityShare] = useState({ enabled: false, expiresAt: null });
  const [activityCode, setActivityCode] = useState('');
  const [savingActivityShare, setSavingActivityShare] = useState(false);

  // Quiz extensions
  const [courseStudents, setCourseStudents] = useState([]);
  const [extensionsOpen, setExtensionsOpen] = useState(false);
  const [extensionDrafts, setExtensionDrafts] = useState([]);
  const [extensionStudent, setExtensionStudent] = useState(null);
  const [savingExtensions, setSavingExtensions] = useState(false);

  // Dialogs
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [confirmGoLiveOpen, setConfirmGoLiveOpen] = useState(false);
  const [confirmScheduledQuizLiveOpen, setConfirmScheduledQuizLiveOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState('pdf');
  const [exportingSession, setExportingSession] = useState(false);
  const [importingSession, setImportingSession] = useState(false);
  const [addQuestionDialog, setAddQuestionDialog] = useState({ open: false, index: 0 });
  const [libraryDialogOpen, setLibraryDialogOpen] = useState(false);
  const [librarySelectionCount, setLibrarySelectionCount] = useState(0);
  const [sessionImportPreview, setSessionImportPreview] = useState(null);
  const [sessionImportSelectedIds, setSessionImportSelectedIds] = useState([]);
  const [sessionImportTags, setSessionImportTags] = useState(['Imported']);
  const importInputRef = useRef(null);
  const libraryPanelRef = useRef(null);

  // Question editor
  const [inlineEditor, setInlineEditor] = useState(null);
  const inlineQuestionEditorRef = useRef(null);

  // Delete question
  const [deleteQTarget, setDeleteQTarget] = useState(null);
  const [expandedQuestions, setExpandedQuestions] = useState({});
  const [questionActions, setQuestionActions] = useState({ anchorEl: null, context: null });
  const [responseBackedQuestionIds, setResponseBackedQuestionIds] = useState(new Set());
  const [unlockEndedEditing, setUnlockEndedEditing] = useState(false);

  const refreshResponseBackedQuestions = useCallback(async () => {
    try {
      const { data } = await apiClient.get(`/sessions/${sessionId}/response-locks`);
      setResponseBackedQuestionIds(new Set(data.responseBackedQuestionIds.map(String)));
    } catch {
      // Keep the last known locks if the response check is temporarily unavailable.
    }
  }, [sessionId]);

  const fetchSession = useCallback(async () => {
    try {
      const { data } = await apiClient.get(`/sessions/${sessionId}`);
      const s = data.session || data;
      setSession(s);
      setEditFields({ name: s.name || '', description: s.description || '' });
      setQuiz(!!s.quiz);
      setPracticeQuiz(!!s.practiceQuiz);
      setAnonymous(!!s.anonymous);
      setQuizStart(toDateTimeLocalString(s.quizStart));
      setQuizEnd(toDateTimeLocalString(s.quizEnd));
      setMsScoringMethod(s.msScoringMethod || DEFAULT_MS_SCORING_METHOD);
      setReviewable(!!s.reviewable);
      setStatus(s.status);
      setSessionDate(toDateTimeLocalString(s.date));
      setSessionTags(normalizeTagValues(s.tags || []));
      setJoinCodeEnabled(!!s.joinCodeEnabled);
      setJoinCodeInterval(s.joinCodeInterval || 10);
      try {
        const { data: share } = await apiClient.get(`/sessions/${sessionId}/activity-share`);
        setActivityShare(share);
        setActivityCode(share.code || '');
      } catch {
        setActivityShare({ enabled: false, expiresAt: null });
      }
      setExtensionDrafts((s.quizExtensions || []).map((extension) => ({
        userId: extension.userId,
        quizStart: toDateTimeLocalString(extension.quizStart),
        quizEnd: toDateTimeLocalString(extension.quizEnd),
      })));
      setUnlockEndedEditing((prev) => (s.status === 'done' ? prev : true));

      // Fetch full question objects
      const qIds = s.questions || [];
      if (qIds.length) {
        const results = await Promise.all(
          qIds.map(qId => apiClient.get(`/questions/${qId}`).then(r => r.data.question || r.data).catch(() => null))
        );
        setQuestions(results.filter(Boolean));
      } else {
        setQuestions([]);
      }

      // Identify questions that already have response data attached.
      await refreshResponseBackedQuestions();

      try {
        const { data: publicSettings } = await apiClient.get('/settings/public').catch(() => ({ data: { timeFormat: '24h' } }));
        const { data: courseData } = await apiClient.get(`/courses/${courseId}`);
        const loadedCourse = courseData?.course || courseData;
        setCourse(loadedCourse);
        const resolvedTimeFormat = loadedCourse?.quizTimeFormat && loadedCourse.quizTimeFormat !== 'inherit'
          ? loadedCourse.quizTimeFormat
          : publicSettings?.timeFormat || '24h';
        setUse24HourTime(resolvedTimeFormat !== '12h');
        const students = (loadedCourse?.students || []).slice().sort(compareStudentsByLastName);
        setCourseStudents(students);
      } catch {
        setCourse(null);
        setCourseStudents([]);
        setUse24HourTime(true);
      }
    } catch {
      setMsg({ severity: 'error', text: t('professor.sessionEditor.failedLoadSession') });
    } finally {
      setLoading(false);
    }
  }, [courseId, refreshResponseBackedQuestions, sessionId]);

  useEffect(() => {
    if (status === 'done') {
      setUnlockEndedEditing(false);
      return;
    }
    setUnlockEndedEditing(true);
  }, [status]);

  useEffect(() => { fetchSession(); }, [fetchSession]);

  // A scheduled quiz's stored status remains "visible" while its time window
  // determines whether it is upcoming, live, or ended. Refresh right at each
  // remaining boundary so an editor left open stays in sync without a reload.
  useEffect(() => {
    if (!quiz || status === 'hidden') return undefined;

    const now = Date.now();
    const upcomingBoundaries = [
      session?.quizStart,
      session?.quizEnd,
      ...(session?.quizExtensions || []).flatMap((extension) => [extension.quizStart, extension.quizEnd]),
    ]
      .map((value) => new Date(value || 0).getTime())
      .filter((value) => Number.isFinite(value) && value > now);
    const nextBoundary = Math.min(...upcomingBoundaries);
    if (!Number.isFinite(nextBoundary)) return undefined;

    const timer = setTimeout(() => {
      fetchSession();
    }, Math.min(nextBoundary - now + 25, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [fetchSession, quiz, session?.quizEnd, session?.quizStart, session?.quizExtensions, status]);

  // While responses can arrive, poll only edit-lock metadata. This
  // applies the existing type/option locks when a student starts responding,
  // without resetting any fields the instructor is editing.
  useEffect(() => {
    if (status !== 'running' && !session?.quizHasRemainingExtensions) return undefined;
    refreshResponseBackedQuestions();
    const timer = setInterval(refreshResponseBackedQuestions, 3000);
    return () => clearInterval(timer);
  }, [refreshResponseBackedQuestions, session?.quizHasRemainingExtensions, status]);

  const toIsoIfValid = (dateValue) => {
    if (!dateValue) return null;
    const parsed = new Date(dateValue);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  };

  const validateQuizWindow = (startValue, endValue) => {
    const startIso = toIsoIfValid(startValue);
    const endIso = toIsoIfValid(endValue);
    if (!startIso || !endIso) return null;
    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      return QUIZ_WINDOW_VALIDATION_MESSAGE;
    }
    return null;
  };

  const ensureQuizWindowDefaults = useCallback((startValue, endValue) => {
    const defaults = buildDefaultQuizWindow();
    return {
      quizStart: startValue || defaults.quizStart,
      quizEnd: endValue || defaults.quizEnd,
    };
  }, []);

  // Save session properties immediately as fields change
  const saveSessionPatch = async (updates) => {
    setSavingSession(true);
    setSessionSaveStatus('saving');
    setSessionSaveError('');
    try {
      const { data } = Object.prototype.hasOwnProperty.call(updates, 'gradesVisible')
        ? await apiClient.patch(`/sessions/${sessionId}/grades/visibility`, { visibleToStudents: updates.gradesVisible })
        : await apiClient.patch(`/sessions/${sessionId}`, updates);
      const updatedSession = { ...session, ...(data.session || data) };
      setSession(updatedSession);
      setReviewable(!!updatedSession.reviewable);
      setStatus(updatedSession.status);
      const warnings = data.grading?.warnings || [];
      if (warnings.length > 0) {
        setMsg({ severity: 'warning', text: warnings.join(' ') });
      }
      setSessionSaveStatus('success');
    } catch (err) {
      setSessionSaveStatus('error');
      const message = err.response?.data?.message || t('professor.sessionEditor.failedUpdateSession');
      setSessionSaveError(`${message} ${t('profile.lastChangeNotRecorded')}`);
      fetchSession();
    } finally {
      setSavingSession(false);
    }
  };

  const handleReviewableChange = useCallback(async (checked) => {
    setSavingSession(true);
    setSessionSaveStatus('saving');
    setSessionSaveError('');
    try {
      const data = await toggleSessionReviewable({
        apiClient,
        sessionId,
        reviewable: checked,
      });
      const updatedSession = data.session || data;
      setSession(updatedSession);
      setReviewable(!!updatedSession.reviewable);
      const warnings = data.grading?.warnings || [];
      if (warnings.length > 0) {
        setMsg({ severity: 'warning', text: warnings.join(' ') });
      }
      setSessionSaveStatus('success');
    } catch (err) {
      setSessionSaveStatus('error');
      const message = err.response?.data?.message || t('professor.sessionEditor.failedUpdateSession');
      setSessionSaveError(`${message} ${t('profile.lastChangeNotRecorded')}`);
      fetchSession();
    } finally {
      setSavingSession(false);
    }
  }, [fetchSession, sessionId, t]);

  const persistQuizWindow = useCallback((nextStart, nextEnd, extraUpdates = {}) => {
    const validationMessage = validateQuizWindow(nextStart, nextEnd);
    if (validationMessage) {
      setMsg({ severity: 'error', text: t(validationMessage) });
      return false;
    }
    const updates = { ...extraUpdates };
    const startIso = toIsoIfValid(nextStart);
    const endIso = toIsoIfValid(nextEnd);
    if (startIso) updates.quizStart = startIso;
    if (endIso) updates.quizEnd = endIso;
    if (Object.keys(updates).length === 0) return true;
    saveSessionPatch(updates);
    return true;
  }, [saveSessionPatch]);

  const applyTodayQuizWindow = useCallback(() => {
    const nextWindow = buildTodayQuizWindow();
    setQuizStart(nextWindow.quizStart);
    setQuizEnd(nextWindow.quizEnd);
    persistQuizWindow(nextWindow.quizStart, nextWindow.quizEnd);
  }, [persistQuizWindow]);

  const applyQuizEndExtension = useCallback(() => {
    const nextWindow = buildExtendedQuizEnd(quizEnd, quizStart);
    setQuizEnd(nextWindow.quizEnd);
    persistQuizWindow(quizStart, nextWindow.quizEnd);
  }, [persistQuizWindow, quizEnd, quizStart]);

  const saveScheduledQuizStatus = () => {
    setConfirmScheduledQuizLiveOpen(false);
    setStatus('running');
    saveSessionPatch({ status: 'visible' });
  };

  const handleStatusChange = (nextStatus) => {
    if (nextStatus === status) return;
    if (nextStatus === 'visible' && quizWouldBeLiveImmediately({
      quiz,
      practiceQuiz,
      quizStart: toIsoIfValid(quizStart),
      quizEnd: toIsoIfValid(quizEnd),
      quizExtensions: session?.quizExtensions,
    })) {
      setConfirmScheduledQuizLiveOpen(true);
      return;
    }
    if (nextStatus === 'running' && !quiz && !practiceQuiz) {
      setConfirmGoLiveOpen(true);
      return;
    }
    setStatus(nextStatus);
    saveSessionPatch({ status: nextStatus });
  };

  const confirmGoLive = async () => {
    setConfirmGoLiveOpen(false);
    try {
      await apiClient.post(`/sessions/${sessionId}/start`);
      navigate(`/prof/course/${courseId}/session/${sessionId}/live`);
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.sessionEditor.failedLaunch') });
    }
  };

  // Delete session
  const handleDeleteSession = async () => {
    setDeleting(true);
    try {
      await apiClient.delete(`/sessions/${sessionId}`);
      navigate(courseBackLink);
    } catch {
      setMsg({ severity: 'error', text: t('professor.sessionEditor.failedDeleteSession') });
      setDeleting(false);
    }
  };

  // Copy session
  const handleCopySession = async () => {
    setCopying(true);
    try {
      const { data } = await apiClient.post(`/sessions/${sessionId}/copy`);
      const newId = data.session?._id || data._id;
      setMsg({ severity: 'success', text: t('professor.sessionEditor.sessionCopied') });
      if (newId) {
        const query = buildReturnNavigationOptions();
        navigate(
          `/prof/course/${courseId}/session/${newId}${query ? `?${query}` : ''}`,
          { state: { returnTab, returnTo: returnToReview ? 'review' : undefined } }
        );
      }
    } catch {
      setMsg({ severity: 'error', text: t('professor.sessionEditor.failedCopySession') });
    } finally {
      setCopying(false);
    }
  };

  const buildReturnNavigationOptions = () => {
    const nextParams = new URLSearchParams();
    if (returnTab > 0) {
      nextParams.set('returnTab', String(returnTab));
    }
    if (returnToReview) {
      nextParams.set('returnTo', 'review');
    }
    return nextParams.toString();
  };

  const handleExportJson = async () => {
    setExportingSession(true);
    try {
      const { data } = await apiClient.get(`/sessions/${sessionId}/export`);
      downloadJson(
        buildSessionExportFilename(session?.name, 'export', 'json'),
        data
      );
      setExportOpen(false);
      setMsg({ severity: 'success', text: t('professor.sessionEditor.exportJsonSuccess') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.sessionEditor.failedExportSession') });
    } finally {
      setExportingSession(false);
    }
  };

  const handleExportPdfVariant = async (variant) => {
    setExportingSession(true);
    try {
      await downloadPdf(
        buildSessionExportFilename(session?.name, variant, 'pdf'),
        buildPrintableSessionHtml({
          course,
          session,
          questions,
          variant,
          t,
        })
      );
      setMsg({ severity: 'success', text: t('professor.sessionEditor.exportPdfSuccess') });
      setExportOpen(false);
    } catch {
      setMsg({ severity: 'error', text: t('professor.sessionEditor.failedOpenPdfExport') });
    } finally {
      setExportingSession(false);
    }
  };

  const openSessionImportPicker = () => {
    if (importingSession) return;
    importInputRef.current?.click();
  };

  const handleImportSessionFile = async (event) => {
    const [file] = event.target.files || [];
    event.target.value = '';
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text());
      const previewQuestions = Array.isArray(parsed?.session?.questions)
        ? parsed.session.questions.map((question, index) => ({
          ...question,
          _previewId: `session-import-${index}`,
        }))
        : [];
      setSessionImportPreview({
        ...parsed,
        session: {
          ...(parsed?.session || {}),
          questions: previewQuestions,
        },
      });
      setSessionImportSelectedIds(previewQuestions.map((question) => question._previewId));
      setSessionImportTags(['Imported']);
    } catch (err) {
      const invalidJson = err instanceof SyntaxError;
      setMsg({
        severity: 'error',
        text: invalidJson
          ? t('professor.sessionEditor.invalidImportFile')
          : err.response?.data?.message || t('professor.sessionEditor.failedImportSession'),
      });
    }
  };

  const handleConfirmSessionImport = async () => {
    if (!sessionImportPreview?.session) return;
    setImportingSession(true);
    try {
      const selectedSet = new Set(sessionImportSelectedIds);
      const filteredQuestions = (sessionImportPreview.session.questions || [])
        .filter((question) => selectedSet.has(question._previewId))
        .map((question) => {
          const sanitized = { ...question };
          delete sanitized._previewId;
          return sanitized;
        });
      const payload = {
        ...sessionImportPreview,
        session: {
          ...sessionImportPreview.session,
          questions: filteredQuestions,
        },
        importTags: sessionImportTags,
      };
      const { data } = await apiClient.post(`/courses/${courseId}/sessions/import`, payload);
      const importedSessionId = data.session?._id;
      setSessionImportPreview(null);
      setSessionImportSelectedIds([]);
      setSessionImportTags(['Imported']);
      setMsg({ severity: 'success', text: t('professor.sessionEditor.importSessionSuccess') });
      if (importedSessionId) {
        const query = buildReturnNavigationOptions();
        navigate(
          `/prof/course/${courseId}/session/${importedSessionId}${query ? `?${query}` : ''}`,
          { state: { returnTab, returnTo: returnToReview ? 'review' : undefined } }
        );
      }
    } catch (err) {
      setMsg({
        severity: 'error',
        text: err.response?.data?.message || t('professor.sessionEditor.failedImportSession'),
      });
    } finally {
      setImportingSession(false);
    }
  };

  const upsertQuestionLocally = useCallback((savedQuestion, orderedIds = null) => {
    setQuestions((prev) => {
      const existingIdx = prev.findIndex(q => q._id === savedQuestion._id);
      const mergedQuestion = existingIdx === -1 ? savedQuestion : { ...prev[existingIdx], ...savedQuestion };

      let next = existingIdx === -1
        ? [...prev, mergedQuestion]
        : prev.map((q, idx) => (idx === existingIdx ? mergedQuestion : q));

      if (Array.isArray(orderedIds)) {
        const byId = new Map(next.map(q => [q._id, q]));
        next = orderedIds.map((id) => byId.get(id)).filter(Boolean);
      }

      return next;
    });

    setSession((prev) => {
      if (!prev) return prev;

      if (Array.isArray(orderedIds)) {
        return { ...prev, questions: orderedIds };
      }

      const ids = prev.questions || [];
      if (ids.includes(savedQuestion._id)) return prev;
      return { ...prev, questions: [...ids, savedQuestion._id] };
    });
  }, []);

  const applyQuestionOrderLocally = useCallback((orderedIds) => {
    setQuestions((prev) => {
      const byId = new Map(prev.map(q => [q._id, q]));
      return orderedIds.map((id) => byId.get(id)).filter(Boolean);
    });
    setSession((prev) => (prev ? { ...prev, questions: orderedIds } : prev));
  }, []);

  const cloneQuestionForBaseline = (question) => {
    if (!question) return null;
    return JSON.parse(JSON.stringify(question));
  };

  const handleApplySessionTagsToQuestions = useCallback(async () => {
    if (!sessionTags.length || !questions.length) return;

    const allowedTags = normalizeTagValues(course?.tags || []);
    setApplyingSessionTags(true);
    try {
      const updatedQuestions = await Promise.all(questions.map(async (question) => {
        const nextTags = mergeQuestionTagsWithSessionTags(question.tags || [], sessionTags, allowedTags);
        const { data } = await apiClient.patch(`/questions/${question._id}`, { tags: toTagObjects(nextTags) });
        return data.question || data;
      }));
      updatedQuestions.forEach((question) => upsertQuestionLocally(question));
      setMsg({
        severity: 'success',
        text: t('professor.sessionEditor.appliedSessionTagsToQuestions', {
          count: updatedQuestions.length,
          defaultValue: updatedQuestions.length === 1
            ? 'Applied the session tags to 1 question.'
            : `Applied the session tags to ${updatedQuestions.length} questions.`,
        }),
      });
    } catch (err) {
      setMsg({
        severity: 'error',
        text: err.response?.data?.message || t('professor.sessionEditor.failedApplySessionTagsToQuestions', {
          defaultValue: 'Failed to apply the session tags to the questions.',
        }),
      });
    } finally {
      setApplyingSessionTags(false);
    }
  }, [course?.tags, questions, sessionTags, t, upsertQuestionLocally]);

  const handleApplyPointsToAllQuestions = useCallback(async () => {
    const normalizedValue = String(allQuestionPoints).trim();
    const points = Number(normalizedValue);
    if (normalizedValue === '' || !Number.isFinite(points) || points < 0) {
      setMsg({ severity: 'error', text: t('professor.sessionEditor.invalidQuestionPoints') });
      return;
    }

    setApplyingQuestionPoints(true);
    try {
      const { data } = await apiClient.patch(`/sessions/${sessionId}/questions/points`, { points });
      const updatedIds = new Set((data.updatedQuestionIds || []).map(String));
      if (updatedIds.size > 0) {
        setQuestions((prev) => prev.map((question) => (
          updatedIds.has(String(question._id))
            ? {
              ...question,
              sessionOptions: {
                ...(question.sessionOptions || {}),
                points,
              },
            }
            : question
        )));
      }
      setMsg({
        severity: data.gradingAffected ? 'warning' : 'success',
        text: data.gradingAffected
          ? t('professor.sessionEditor.pointsChangedRegradeWarning')
          : t('professor.sessionEditor.appliedPointsToAllQuestions', { points }),
      });
    } catch (err) {
      setMsg({
        severity: 'error',
        text: err.response?.data?.message || t('professor.sessionEditor.failedApplyPointsToQuestions'),
      });
    } finally {
      setApplyingQuestionPoints(false);
    }
  }, [allQuestionPoints, sessionId, t]);

  const hasResponseDataForQuestion = useCallback(
    (questionId) => responseBackedQuestionIds.has(String(questionId)),
    [responseBackedQuestionIds]
  );
  const questionsEditingLocked = status === 'done' && !unlockEndedEditing;

  const openInsertEditorAt = (index) => {
    if (questionsEditingLocked) {
      setMsg({ severity: 'warning', text: t('professor.sessionEditor.unlockBeforeAdd') });
      return;
    }
    setInlineEditor((prev) => {
      if (prev?.mode === 'insert' && prev.index === index) return prev;
      return { mode: 'insert', index, key: Date.now() };
    });
  };

  const openAddQuestionDialogAt = (index) => {
    if (questionsEditingLocked) {
      setMsg({ severity: 'warning', text: t('professor.sessionEditor.unlockBeforeAdd') });
      return;
    }
    setAddQuestionDialog({ open: true, index });
  };

  const openEditEditor = (questionId) => {
    if (questionsEditingLocked) {
      setMsg({ severity: 'warning', text: t('professor.sessionEditor.unlockBeforeChange') });
      return;
    }
    const baselineQuestion = questions.find((q) => q._id === questionId) || null;
    setInlineEditor((prev) => {
      if (prev?.mode === 'edit' && prev.questionId === questionId) return prev;
      return {
        mode: 'edit',
        questionId,
        key: Date.now(),
        baselineQuestion: cloneQuestionForBaseline(baselineQuestion),
      };
    });
  };

  const shiftInsertEditor = (direction) => {
    setInlineEditor((prev) => {
      if (!prev || prev.mode !== 'insert') return prev;
      const nextIndex = Math.max(0, Math.min(questions.length, prev.index + direction));
      if (nextIndex === prev.index) return prev;
      return { ...prev, index: nextIndex };
    });
  };

  const closeInlineEditor = async ({ persistedQuestionId } = {}) => {
    setInlineEditor(null);

    if (persistedQuestionId) {
      try {
        const { data } = await apiClient.get(`/questions/${persistedQuestionId}`);
        const refreshed = data.question || data;
        upsertQuestionLocally(refreshed);
      } catch {
        // Keep local state if refresh fails.
      }
    }
  };

  const requestInlineEditorClose = () => {
    const requestClose = inlineQuestionEditorRef.current?.requestClose;
    if (typeof requestClose === 'function') {
      requestClose();
      return;
    }
    closeInlineEditor();
  };

  const handleAddQuestionsFromLibrary = useCallback(async (questionIds) => {
    const normalizedIds = [...new Set((questionIds || []).map((questionId) => String(questionId)).filter(Boolean))];
    if (!normalizedIds.length) return;

    const insertIndex = Math.max(0, Math.min(addQuestionDialog.index, questions.length));
    const copiedIds = [];
    for (const questionId of normalizedIds) {
      const { data } = await apiClient.post(`/questions/${questionId}/copy-to-session`, { sessionId });
      copiedIds.push(String(data.question._id));
    }

    if (copiedIds.length > 0) {
      const existingIds = questions.map((question) => String(question._id));
      const orderedIds = [...existingIds];
      orderedIds.splice(insertIndex, 0, ...copiedIds);
      await apiClient.patch(`/sessions/${sessionId}/questions/order`, { questions: orderedIds });
    }
    setLibraryDialogOpen(false);
    setLibrarySelectionCount(0);
    setAddQuestionDialog({ open: false, index: insertIndex });
    await fetchSession();
  }, [addQuestionDialog.index, fetchSession, questions, sessionId]);

  const handleAutoSaveQuestion = useCallback(async (payload, questionId) => {
    try {
      if (questionId) {
        const { data } = await apiClient.patch(`/questions/${questionId}`, payload);
        const updated = data.question || data;
        upsertQuestionLocally(updated);
        if (data.gradingAffected) {
          setMsg({ severity: 'warning', text: t('professor.sessionEditor.pointsChangedRegradeWarning') });
        }
        return updated;
      }

      const insertIndex = inlineEditor?.mode === 'insert' ? inlineEditor.index : questions.length;
      const { data } = await apiClient.post('/questions', { ...payload, sessionId, courseId });
      const created = data.question || data;
      const currentIds = (session?.questions || questions.map(q => q._id)).filter((id) => id !== created._id);
      const orderedIds = [...currentIds];
      const clampedIndex = Math.max(0, Math.min(insertIndex, orderedIds.length));
      orderedIds.splice(clampedIndex, 0, created._id);

      upsertQuestionLocally(created, orderedIds);
      await apiClient.patch(`/sessions/${sessionId}/questions/order`, { questions: orderedIds });

      setInlineEditor((prev) => {
        if (!prev || prev.mode !== 'insert') return prev;
        return {
          mode: 'edit',
          questionId: created._id,
          key: prev.key,
          baselineQuestion: cloneQuestionForBaseline(created),
        };
      });

      return created;
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.sessionEditor.failedAutoSave') });
      throw err;
    }
  }, [courseId, inlineEditor, questions, session, sessionId, t, upsertQuestionLocally]);

  // Delete question
  const handleDeleteQuestion = async (qId) => {
    if (questionsEditingLocked) {
      setMsg({ severity: 'warning', text: t('professor.sessionEditor.unlockBeforeDelete') });
      return;
    }
    if (hasResponseDataForQuestion(qId)) {
      setDeleteQTarget(null);
      setMsg({ severity: 'warning', text: t('professor.sessionEditor.responsesPreventDelete') });
      return;
    }
    try {
      await apiClient.delete(`/sessions/${sessionId}/questions/${qId}`);
      await apiClient.delete(`/questions/${qId}`);
      setInlineEditor((prev) => {
        if (!prev) return prev;
        if (prev.mode === 'edit' && prev.questionId === qId) return null;
        return prev;
      });
      setDeleteQTarget(null);
      fetchSession();
      setMsg({ severity: 'success', text: t('professor.sessionEditor.questionDeleted') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('professor.sessionEditor.failedDeleteQuestion') });
    }
  };

  // Move question (reorder)
  const handleMove = async (idx, direction) => {
    if (questionsEditingLocked) {
      setMsg({ severity: 'warning', text: t('professor.sessionEditor.unlockBeforeReorder') });
      return;
    }
    const ids = questions.map(q => q._id);
    const target = idx + direction;
    if (target < 0 || target >= ids.length) return;
    const orderedIds = ids.slice();
    [orderedIds[idx], orderedIds[target]] = [orderedIds[target], orderedIds[idx]];

    applyQuestionOrderLocally(orderedIds);
    try {
      await apiClient.patch(`/sessions/${sessionId}/questions/order`, { questions: orderedIds });
    } catch {
      fetchSession();
      setMsg({ severity: 'error', text: t('professor.sessionEditor.failedReorder') });
    }
  };

  const getQuestionArrayIndex = (questionId) => questions.findIndex((q) => q._id === questionId);

  const getQuestionVisualIndex = (questionId) => {
    const questionIndex = getQuestionArrayIndex(questionId);
    if (questionIndex === -1) return -1;

    if (inlineEditor?.mode === 'insert' && questionIndex >= inlineEditor.index) {
      return questionIndex + 1;
    }

    return questionIndex;
  };

  const canMoveQuestionById = (questionId, direction) => {
    const visualIndex = getQuestionVisualIndex(questionId);
    if (visualIndex === -1) return false;
    if (direction < 0) return visualIndex > 0;

    const maxVisualIndex = inlineEditor?.mode === 'insert'
      ? questions.length
      : questions.length - 1;
    return visualIndex < maxVisualIndex;
  };

  const moveQuestionByQuestionId = (questionId, direction) => {
    const idx = questions.findIndex((q) => q._id === questionId);
    if (idx === -1) return;

    if (inlineEditor?.mode === 'insert') {
      const insertIdx = inlineEditor.index;
      const visualIndex = idx >= insertIdx ? idx + 1 : idx;
      const targetVisualIndex = visualIndex + direction;
      if (targetVisualIndex < 0 || targetVisualIndex > questions.length) return;

      if (targetVisualIndex === insertIdx) {
        shiftInsertEditor(direction > 0 ? -1 : 1);
        return;
      }
    }

    handleMove(idx, direction);
  };

  const allQuestionsExpanded = questions.length > 0
    && questions.every((question) => !!expandedQuestions[question._id]);

  const toggleAllQuestionsExpanded = () => {
    setExpandedQuestions(Object.fromEntries(
      questions.map((question) => [question._id, !allQuestionsExpanded])
    ));
  };

  const toggleQuestionExpanded = (questionId) => {
    setExpandedQuestions((prev) => ({ ...prev, [questionId]: !prev[questionId] }));
  };

  const handleQuestionPreviewKeyDown = (event, questionId) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleQuestionExpanded(questionId);
  };

  const openQuestionActions = (event, context) => {
    event.stopPropagation();
    setQuestionActions({ anchorEl: event.currentTarget, context });
  };

  const closeQuestionActions = () => {
    setQuestionActions({ anchorEl: null, context: null });
  };

  const runQuestionAction = (action) => {
    const context = questionActions.context;
    closeQuestionActions();
    if (!context) return;
    if (questionsEditingLocked) {
      setMsg({ severity: 'warning', text: t('professor.sessionEditor.unlockBeforeChange') });
      return;
    }

    if (action === 'move-up') {
      if (context.mode === 'insert') {
        shiftInsertEditor(-1);
      } else {
        const questionId = context.question?._id;
        if (questionId) moveQuestionByQuestionId(questionId, -1);
      }
      return;
    }

    if (action === 'move-down') {
      if (context.mode === 'insert') {
        shiftInsertEditor(1);
      } else {
        const questionId = context.question?._id;
        if (questionId) moveQuestionByQuestionId(questionId, 1);
      }
      return;
    }

    if (action === 'edit' && context.question?._id) {
      openEditEditor(context.question._id);
      return;
    }

    if (action === 'delete' && context.question) {
      if (hasResponseDataForQuestion(context.question._id)) {
        setMsg({ severity: 'warning', text: t('professor.sessionEditor.responsesPreventDelete') });
        return;
      }
      setDeleteQTarget(context.question);
    }
  };

  const editingQuestionId = inlineEditor?.mode === 'edit' ? inlineEditor.questionId : null;
  const insertingAtIndex = inlineEditor?.mode === 'insert' ? inlineEditor.index : -1;
  const editingQuestionIndex = editingQuestionId
    ? questions.findIndex((q) => q._id === editingQuestionId)
    : -1;
  const activeEditorSlotIndex = inlineEditor
    ? (inlineEditor.mode === 'insert' ? inlineEditor.index : editingQuestionIndex)
    : -1;
  const actionContext = questionActions.context;
  const actionContextQuestionIndex = actionContext?.question?._id
    ? getQuestionVisualIndex(actionContext.question._id)
    : -1;
  const actionContextIndex = actionContext?.mode === 'insert'
    ? actionContext.index
    : actionContextQuestionIndex;
  const actionContextMaxIndex = actionContext
    ? (actionContext.mode === 'insert'
      ? questions.length
      : (insertingAtIndex !== -1 ? questions.length : questions.length - 1))
    : -1;
  const actionCanMoveUp = !questionsEditingLocked && !!actionContext && actionContextIndex > 0;
  const actionCanMoveDown = !!actionContext
    && !questionsEditingLocked
    && actionContextIndex >= 0
    && actionContextIndex < actionContextMaxIndex;
  const actionContextQuestionHasResponses = actionContext?.question?._id
    ? hasResponseDataForQuestion(actionContext.question._id)
    : false;
  const deleteTargetHasResponses = deleteQTarget?._id
    ? hasResponseDataForQuestion(deleteQTarget._id)
    : false;
  const studentById = useMemo(
    () => new Map(courseStudents.map((student) => [String(student._id), student])),
    [courseStudents]
  );
  const availableExtensionStudents = useMemo(
    () => courseStudents.filter(
      (student) => !extensionDrafts.some((extension) => String(extension.userId) === String(student._id))
    ),
    [courseStudents, extensionDrafts]
  );

  const openExtensionsDialog = () => {
    setExtensionStudent(null);
    setExtensionsOpen(true);
  };

  const addExtensionStudent = () => {
    if (!extensionStudent?._id) return;
    const userId = String(extensionStudent._id);
    if (extensionDrafts.some((extension) => String(extension.userId) === userId)) {
      return;
    }

    const defaultStart = quizStart || toDateTimeLocalString(session?.quizStart) || '';
    const defaultEnd = quizEnd || toDateTimeLocalString(session?.quizEnd) || '';

    setExtensionDrafts((prev) => [...prev, {
      userId,
      quizStart: defaultStart,
      quizEnd: defaultEnd,
    }]);
    setExtensionStudent(null);
  };

  const updateExtensionDraft = (userId, field, value) => {
    setExtensionDrafts((prev) => prev.map((extension) => (
      String(extension.userId) === String(userId)
        ? { ...extension, [field]: value }
        : extension
    )));
  };

  const removeExtensionDraft = (userId) => {
    setExtensionDrafts((prev) => prev.filter((extension) => String(extension.userId) !== String(userId)));
  };

  const saveExtensions = async () => {
    setSavingExtensions(true);
    try {
      const payloadExtensions = extensionDrafts.map((extension) => {
        const isoStart = toIsoIfValid(extension.quizStart);
        const isoEnd = toIsoIfValid(extension.quizEnd);
        if (!isoStart || !isoEnd) {
          throw new Error(t('professor.sessionEditor.extensionTimesRequired'));
        }
        if (new Date(isoEnd).getTime() <= new Date(isoStart).getTime()) {
          throw new Error(t('professor.sessionEditor.extensionEndAfterStart'));
        }
        return {
          userId: extension.userId,
          quizStart: isoStart,
          quizEnd: isoEnd,
        };
      });

      const { data } = await apiClient.patch(`/sessions/${sessionId}/extensions`, {
        extensions: payloadExtensions,
      });
      const updatedSession = data.session || data;
      setSession(updatedSession);
      setStatus(updatedSession.status);
      setExtensionDrafts((updatedSession.quizExtensions || []).map((extension) => ({
        userId: extension.userId,
        quizStart: toDateTimeLocalString(extension.quizStart),
        quizEnd: toDateTimeLocalString(extension.quizEnd),
      })));
      setReviewable(!!updatedSession.reviewable);
      setExtensionsOpen(false);
      setMsg({ severity: 'success', text: t('professor.sessionEditor.extensionsUpdated') });
    } catch (err) {
      const fallbackMessage = err.message || t('professor.sessionEditor.failedUpdateExtensions');
      setMsg({ severity: 'error', text: err.response?.data?.message || fallbackMessage });
    } finally {
      setSavingExtensions(false);
    }
  };

  const renderInlineEditorCard = ({
    key,
    index,
    initialQuestion = null,
    baselineQuestion = null,
  }) => {
    const questionHasResponses = initialQuestion?._id
      ? hasResponseDataForQuestion(initialQuestion._id)
      : false;
    const resolvedQuestionIndex = initialQuestion?._id
      ? getQuestionVisualIndex(initialQuestion._id)
      : -1;
    const currentIndex = resolvedQuestionIndex >= 0 ? resolvedQuestionIndex : index;
    const canMoveUp = !questionsEditingLocked && (initialQuestion?._id
      ? canMoveQuestionById(initialQuestion._id, -1)
      : currentIndex > 0);
    const canMoveDown = !questionsEditingLocked && (initialQuestion?._id
      ? canMoveQuestionById(initialQuestion._id, 1)
      : currentIndex < questions.length);

    return (
      <Card key={key} variant="outlined" sx={{ mb: PAGE_SECTION_GAP }}>
        <CardContent
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: { xs: 1, sm: 1.5 },
            alignItems: 'flex-start',
            minWidth: 0,
            overflow: 'hidden',
            '&:last-child': { pb: 2 },
          }}
        >
          <Box
            sx={{
              display: { xs: 'flex', sm: 'none' },
              width: '100%',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Typography variant="subtitle2" sx={{
              color: "text.secondary"
            }}>
              {initialQuestion ? t('professor.sessionEditor.questionNumber', { number: currentIndex + 1 }) : t('professor.sessionEditor.insertAt', { number: index + 1 })}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
              <Tooltip title={t('professor.sessionEditor.closeEditor')}>
                <IconButton size="small" aria-label={t('professor.sessionEditor.closeEditor')} onClick={requestInlineEditorClose}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <IconButton
                size="small"
                aria-label={t('common.moreActions')}
                onClick={(event) => openQuestionActions(event, {
                  mode: initialQuestion ? 'edit' : 'insert',
                  index,
                  question: initialQuestion || null,
                })}
              >
                <MoreIcon fontSize="small" />
              </IconButton>
            </Box>
          </Box>

          <Box
            sx={{
              display: { xs: 'none', sm: 'flex' },
              flexDirection: 'column',
              alignItems: 'center',
              minWidth: 34,
              flexShrink: 0,
            }}
          >
            <Tooltip title={t('professor.sessionEditor.closeEditor')}>
              <IconButton size="small" aria-label={t('professor.sessionEditor.closeEditor')} onClick={requestInlineEditorClose}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={initialQuestion ? t('professor.sessionEditor.moveUp') : t('professor.sessionEditor.moveInsertionUp')}>
              <span>
                <IconButton
                  size="small"
                  aria-label={t('common.moveUp')}
                  disabled={!canMoveUp}
                  onClick={() => {
                    if (initialQuestion?._id) moveQuestionByQuestionId(initialQuestion._id, -1);
                    else shiftInsertEditor(-1);
                  }}
                >
                  <UpIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Typography
              variant="subtitle2"
              sx={{
                color: "text.secondary",
                lineHeight: 1.2
              }}>
              {currentIndex + 1}.
            </Typography>
            <Tooltip title={initialQuestion ? t('professor.sessionEditor.moveDown') : t('professor.sessionEditor.moveInsertionDown')}>
              <span>
                <IconButton
                  size="small"
                  aria-label={t('common.moveDown')}
                  disabled={!canMoveDown}
                  onClick={() => {
                    if (initialQuestion?._id) moveQuestionByQuestionId(initialQuestion._id, 1);
                    else shiftInsertEditor(1);
                  }}
                >
                  <DownIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            {initialQuestion ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', mt: 0.5 }}>
                <Tooltip title={questionHasResponses ? t('professor.sessionEditor.cannotDeleteHasResponses') : t('common.delete')}>
                  <span>
                    <IconButton
                      size="small"
                      color="error"
                      aria-label={t('common.delete')}
                      disabled={questionsEditingLocked || questionHasResponses}
                      onClick={() => setDeleteQTarget(initialQuestion)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </Box>
            ) : null}
          </Box>

          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            <QuestionEditor
              ref={inlineQuestionEditorRef}
              key={`inline-editor-${inlineEditor?.key}`}
              inline
              open
              onClose={closeInlineEditor}
              onAutoSave={handleAutoSaveQuestion}
              initial={initialQuestion}
              initialBaseline={baselineQuestion}
              disableTypeSelection={questionHasResponses}
              disableOptionCountChanges={questionHasResponses}
              optionCountLockReason={t('professor.sessionEditor.questionOptionsLocked')}
              typeSelectionLockReason={t('professor.sessionEditor.questionTypeLocked')}
              tagSuggestions={course?.tags || []}
              showVisibilityControls={false}
              allowCustomTags={false}
              showCourseTagSettingsHint
            />
          </Box>

        </CardContent>
      </Card>
    );
  };

  if (loading) return <Box sx={{ p: 3 }}><CircularProgress /></Box>;
  if (!session) return <Box sx={{ p: 3 }}><Alert severity="error">{t('professor.sessionEditor.sessionNotFound')}</Alert></Box>;
  const courseTitle = course?._id ? buildCourseTitle(course, 'long') : '';
  const courseSection = String(course?.section || '').trim();
  const reviewSession = { ...session, status };
  const canReviewRunningQuiz = (session.quiz || session.practiceQuiz) && sessionCanShowLiveReviewAction(reviewSession);
  // Anonymity cannot change once students have joined or answered: their
  // records are stored under a different identifier in anonymous sessions.
  const anonymityLocked = !!session.participationStarted
    || !!session.hasResponses
    || (Array.isArray(session.joined) && session.joined.length > 0)
    || (Array.isArray(session.joinRecords) && session.joinRecords.length > 0)
    || Number(session.joinedCount || 0) > 0
    || (Array.isArray(session.submittedQuiz) && session.submittedQuiz.length > 0)
    || Number(session.submittedCount || 0) > 0;
  const canReviewEndedSession = status === 'done';
  const hasGradableQuestions = questions.some((question) => !isSlideType(question.type));
  const normalizedAllQuestionPoints = String(allQuestionPoints).trim();
  const parsedAllQuestionPoints = Number(normalizedAllQuestionPoints);
  const allQuestionPointsInvalid = normalizedAllQuestionPoints === ''
    || !Number.isFinite(parsedAllQuestionPoints)
    || parsedAllQuestionPoints < 0;

  return (
    <Box sx={{ px: { xs: 1.5, sm: 2 }, pt: 1.25, pb: 2, maxWidth: 980, mx: 'auto' }}>
      {session.anonymous && session.quiz && status === 'running' && (
        <LiveSessionWebSocketProvider sessionId={sessionId}>
          <AnonymousQuizReviewUpdates sessionId={sessionId} setSession={setSession} />
        </LiveSessionWebSocketProvider>
      )}
      {/* Header */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: PAGE_SECTION_GAP }}>
        <BackLinkButton
          label={returnToReview ? t('professor.sessionEditor.backToReview') : t('professor.sessionEditor.backToCourse')}
          onClick={() => navigate(backLink)}
        />
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, flexWrap: 'wrap' }}>
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            {courseTitle ? (
              <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.15 }}>
                {courseTitle}
              </Typography>
            ) : null}
            {courseSection ? (
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
            <Typography variant="h6" sx={{ lineHeight: 1.15 }}>{session.name}</Typography>
          </Box>
          <SessionStatusChip status={status} />
          {!session.quiz && status !== 'running' && status !== 'done' && (
            <Button
              variant="contained"
              color="primary"
              startIcon={<LaunchIcon />}
              onClick={() => setConfirmGoLiveOpen(true)}
              size="small"
              aria-label={t('professor.sessionEditor.joinLiveSession')}
            >
              {t('professor.course.launch')}
            </Button>
          )}
          {!session.quiz && status === 'running' && (
            <Button
              variant="contained"
              color="success"
              startIcon={<JoinIcon />}
              onClick={() => navigate(`/prof/course/${courseId}/session/${sessionId}/live`)}
              size="small"
              aria-label={t('professor.sessionEditor.joinLiveSession')}
            >
              {t('professor.course.joinSession')}
            </Button>
          )}
          {canReviewRunningQuiz && (
            <Button
              variant="contained"
              color="success"
              startIcon={<ReviewIcon />}
              size="small"
              onClick={() => navigate(sessionReviewLink)}
            >
              {t('professor.sessionEditor.reviewLiveResults')}
            </Button>
          )}
          {sessionWaitingForAnonymousReview(reviewSession) && (
            <Typography variant="body2" color="text.secondary" role="status">
              {t('professor.sessionReview.anonymousLiveWaiting')}
            </Typography>
          )}
          {canReviewEndedSession && (
            <Button
              variant="outlined"
              color="primary"
              startIcon={<ReviewIcon />}
              size="small"
              onClick={() => navigate(sessionReviewLink)}
            >
              {t('professor.sessionEditor.reviewResults')}
            </Button>
          )}
        </Box>
      </Box>

      {/* Session Properties */}
      <Paper sx={{ p: { xs: 2, sm: 2.25 }, mb: PAGE_SECTION_GAP }}>
        <Typography variant="h6" sx={{ mb: SETTINGS_STACK_GAP }}>{t('professor.sessionEditor.sessionSettings')}</Typography>
        <AutoSaveStatus status={sessionSaveStatus} errorText={sessionSaveError} />
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: SETTINGS_STACK_GAP }}>
          <TextField
            label={t('professor.sessionEditor.name')}
            fullWidth
            size="small"
            value={editFields.name}
            onChange={e => setEditFields({ ...editFields, name: e.target.value })}
            onBlur={() => {
              if (editFields.name !== (session.name || '')) {
                saveSessionPatch({ name: editFields.name });
              }
            }}
            disabled={savingSession}
            sx={{
              '& .MuiInputBase-input': {
                py: 1.05,
              },
            }}
          />
          <TextField
            label={t('professor.sessionEditor.description')}
            fullWidth
            size="small"
            value={editFields.description}
            onChange={e => setEditFields({ ...editFields, description: e.target.value })}
            onBlur={() => {
              if (editFields.description !== (session.description || '')) {
                saveSessionPatch({ description: editFields.description });
              }
            }}
            disabled={savingSession}
            sx={{ '& .MuiInputBase-input': { py: 1.05 } }}
          />

          <FormControl size="small" sx={{ maxWidth: quiz ? 360 : 280 }}>
            <InputLabel id="session-status-label">{t('professor.sessionEditor.status')}</InputLabel>
            <Select
              labelId="session-status-label"
              label={t('professor.sessionEditor.status')}
              value={status}
              onChange={(e) => handleStatusChange(e.target.value)}
              disabled={savingSession}
            >
              <MenuItem value="hidden">{t('sessionStatus.draft')}</MenuItem>
              <MenuItem value="visible">
                {quiz ? t('professor.sessionEditor.liveBasedOnDate') : t('sessionStatus.upcoming')}
              </MenuItem>
              <MenuItem value="running">{t('sessionStatus.live')}</MenuItem>
              <MenuItem value="done">{t('sessionStatus.ended')}</MenuItem>
            </Select>
          </FormControl>

          <Box sx={{ display: 'flex', gap: 1.25, flexWrap: 'wrap' }}>
            <FormControlLabel
              control={(
                <Switch
                  checked={quiz}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    const shouldDisablePractice = !checked && practiceQuiz;
                    setQuiz(checked);
                    if (shouldDisablePractice) {
                      setPracticeQuiz(false);
                    }
                    if (checked) {
                      const nextWindow = ensureQuizWindowDefaults(quizStart, quizEnd);
                      setQuizStart(nextWindow.quizStart);
                      setQuizEnd(nextWindow.quizEnd);
                      persistQuizWindow(
                        nextWindow.quizStart,
                        nextWindow.quizEnd,
                        shouldDisablePractice
                          ? { quiz: true, practiceQuiz: false }
                          : { quiz: true }
                      );
                      return;
                    }
                    saveSessionPatch(
                      shouldDisablePractice
                        ? { quiz: checked, practiceQuiz: false }
                        : { quiz: checked }
                    );
                  }}
                  disabled={savingSession || (anonymous && anonymityLocked)}
                />
              )}
              label={(
                <Tooltip title={t('professor.sessionEditor.quizHelp')} arrow>
                  <span>{t('professor.sessionEditor.quiz')}</span>
                </Tooltip>
              )}
            />
            <FormControlLabel
              control={(
                <Switch
                  checked={practiceQuiz}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setPracticeQuiz(checked);
                    if (checked && (!quiz || !quizStart || !quizEnd)) {
                      const nextWindow = ensureQuizWindowDefaults(quizStart, quizEnd);
                      setQuiz(true);
                      setQuizStart(nextWindow.quizStart);
                      setQuizEnd(nextWindow.quizEnd);
                      persistQuizWindow(nextWindow.quizStart, nextWindow.quizEnd, { quiz: true, practiceQuiz: true });
                      return;
                    }
                    saveSessionPatch({ practiceQuiz: checked });
                  }}
                  disabled={savingSession || anonymous}
                />
              )}
              label={(
                <Tooltip title={t('professor.sessionEditor.practiceQuizHelp')} arrow>
                  <span>{t('professor.sessionEditor.practiceQuiz')}</span>
                </Tooltip>
              )}
            />
            {quiz && !practiceQuiz && (
              <FormControlLabel
                control={(
                  <Switch
                    checked={!!session.allowSkippingZeroPointQuestions}
                    onChange={(e) => saveSessionPatch({ allowSkippingZeroPointQuestions: e.target.checked })}
                    disabled={savingSession}
                  />
                )}
                label={t('professor.sessionEditor.allowSkippingZeroPointQuestions')}
              />
            )}
            <FormControlLabel
              control={(
                <Switch
                  checked={anonymous}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setAnonymous(checked);
                    saveSessionPatch({ anonymous: checked });
                  }}
                  disabled={savingSession || practiceQuiz || anonymityLocked || (!anonymous && extensionDrafts.length > 0)}
                  slotProps={(anonymous || anonymityLocked || extensionDrafts.length > 0)
                    ? { input: { 'aria-describedby': 'session-anonymous-help' } }
                    : undefined}
                />
              )}
              label={(
                <Tooltip title={t('professor.sessionEditor.anonymousHelp')} arrow>
                  <span>{t('professor.sessionEditor.anonymous')}</span>
                </Tooltip>
              )}
            />
            <FormControlLabel
              control={(
                <Switch
                  checked={reviewable}
                  onChange={(e) => {
                    handleReviewableChange(e.target.checked);
                  }}
                  disabled={savingSession || status !== 'done' || session?.quizHasRemainingExtensions}
                />
              )}
              label={(
                <Tooltip title={t('professor.sessionEditor.reviewableHelp')} arrow>
                  <span>{t('professor.sessionEditor.reviewable')}</span>
                </Tooltip>
              )}
            />
            <SessionGradesVisibilityControl
              session={session}
              size="medium"
              disabled={savingSession}
              onChange={(checked) => saveSessionPatch({ gradesVisible: checked })}
            />
          </Box>

          {(anonymous || anonymityLocked || extensionDrafts.length > 0) && (
            <Typography id="session-anonymous-help" variant="body2" sx={{ color: 'text.secondary' }}>
              {[
                anonymous ? t('professor.sessionEditor.anonymousEnabledNote') : '',
                anonymityLocked ? t('professor.sessionEditor.anonymousLockedNote') : '',
                !anonymous && extensionDrafts.length > 0 ? t('professor.sessionEditor.anonymousNoExtensions') : '',
              ].filter(Boolean).join(' ')}
            </Typography>
          )}

          {course?.allowSharedActivities && <Paper variant="outlined" sx={{ p: 2, display: 'grid', gap: 1.5 }}>
            <FormControlLabel sx={{ m: 0 }}
              control={<Switch checked={!!activityShare.enabled}
                disabled={savingActivityShare || (!activityShare.enabled && (practiceQuiz || session?.studentCreated || !course?.allowSharedActivities || extensionDrafts.length > 0))}
                onChange={async (event) => {
                  const enabled = event.target.checked;
                  setSavingActivityShare(true);
                  try {
                    if (enabled) {
                      const { data } = await apiClient.post(`/sessions/${sessionId}/activity-share`, {});
                      setActivityCode(data.code);
                      setActivityShare({ enabled: true, expiresAt: data.expiresAt });
                    } else {
                      await apiClient.delete(`/sessions/${sessionId}/activity-share`);
                      setActivityShare({ enabled: false, expiresAt: null });
                      setActivityCode('');
                    }
                    await fetchSession();
                  } catch (error) {
                    setMsg({ severity: 'error', text: error.response?.data?.message || t('professor.sessionEditor.activityCodeError') });
                  } finally { setSavingActivityShare(false); }
                }} />}
              label={(
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <Typography variant="body2">{t('professor.sessionEditor.allowActivityCodeAccess')}</Typography>
                  <Tooltip arrow title={t('professor.sessionEditor.activityCodeHelp')}>
                    <InfoOutlinedIcon fontSize="small" color="action" tabIndex={0}
                      aria-label={t('professor.sessionEditor.activityCodeTitle')} />
                  </Tooltip>
                </Box>
              )}
            />
            {activityShare.enabled && <>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                {activityCode ? (
                  <Typography variant="body2">
                    {t('professor.sessionEditor.activityCodeLabel')}: <Box component="span" data-testid="activity-share-code" sx={{ fontWeight: 600 }}>{activityCode}</Box>
                  </Typography>
                ) : (
                  <Typography variant="body2" color="text.secondary">{t('professor.sessionEditor.activityCodeUnavailable')}</Typography>
                )}
                {activityCode && <Button size="small" startIcon={<CopyIcon />}
                  onClick={() => navigator.clipboard.writeText(activityCode)}>{t('common.copy')}</Button>}
                <Button size="small" startIcon={<RefreshIcon />} disabled={savingActivityShare || !course?.allowSharedActivities}
                  onClick={async () => {
                    setSavingActivityShare(true);
                    try {
                      const { data } = await apiClient.post(`/sessions/${sessionId}/activity-share`, { regenerate: true });
                      setActivityCode(data.code);
                      setActivityShare({ enabled: true, expiresAt: data.expiresAt });
                      await fetchSession();
                    } catch (error) {
                      setMsg({ severity: 'error', text: error.response?.data?.message || t('professor.sessionEditor.activityCodeError') });
                    } finally { setSavingActivityShare(false); }
                  }}>
                  {t('professor.sessionEditor.rotateActivityCode')}
                </Button>
              </Box>
              {activityShare.expiresAt && <Typography variant="body2" color="text.secondary">
                {t('professor.sessionEditor.activityCodeExpires', { date: new Date(activityShare.expiresAt).toLocaleString() })}
              </Typography>}
            </>}
            {extensionDrafts.length > 0 && <Typography variant="body2" color="text.secondary">{t('professor.sessionEditor.removeExtensionsBeforeSharing')}</Typography>}
          </Paper>}

          {/* Join code settings (for interactive sessions only) */}
          {!quiz && (
            <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: SETTINGS_STACK_GAP, alignItems: { sm: 'center' } }}>
                <FormControlLabel
                control={(
                  <Switch
                    checked={joinCodeEnabled}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setJoinCodeEnabled(checked);
                      saveSessionPatch({ joinCodeEnabled: checked });
                    }}
                    disabled={savingSession}
                  />
                )}
                label={(
                  <Tooltip title={t('professor.sessionEditor.passcodeHelp')} arrow>
                    <span>{t('professor.sessionEditor.requirePasscode')}</span>
                  </Tooltip>
                )}
              />
              {joinCodeEnabled && (
                <Tooltip title={t('professor.sessionEditor.codeRefreshHelp')} arrow>
                  <span>
                    <TextField
                      label={t('professor.sessionEditor.codeRefreshInterval')}
                      size="small"
                      type="number"
                      slotProps={{ htmlInput: { min: 5, max: 120 } }}
                      value={joinCodeInterval}
                      onChange={(e) => {
                        const val = Number(e.target.value);
                        if (val >= 5 && val <= 120) {
                          setJoinCodeInterval(val);
                          saveSessionPatch({ joinCodeInterval: val });
                        }
                      }}
                      disabled={savingSession}
                      sx={{ maxWidth: 220 }}
                    />
                  </span>
                </Tooltip>
              )}
            </Box>
          )}

          <FormControl size="small" sx={{ maxWidth: 360 }}>
            <InputLabel id="ms-scoring-method-label">{t('professor.sessionEditor.msScoring')}</InputLabel>
            <Select
              labelId="ms-scoring-method-label"
              label={t('professor.sessionEditor.msScoring')}
              value={msScoringMethod}
              onChange={(e) => {
                const nextMethod = e.target.value;
                setMsScoringMethod(nextMethod);
                saveSessionPatch({ msScoringMethod: nextMethod });
              }}
              disabled={savingSession}
            >
              <MenuItem value="right-minus-wrong">{t('professor.sessionEditor.rightMinusWrong')}</MenuItem>
              <MenuItem value="all-or-nothing">{t('professor.sessionEditor.allOrNothing')}</MenuItem>
              <MenuItem value="correctness-ratio">{t('professor.sessionEditor.correctnessRatio')}</MenuItem>
            </Select>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
                mt: 0.5
              }}>
              {t('professor.sessionEditor.msScoringHelp')}
            </Typography>
          </FormControl>

          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <Autocomplete
              multiple
              freeSolo={false}
              options={normalizeTagValues(course?.tags || [])}
              value={sessionTags}
              onChange={(_event, nextValue) => {
                const normalizedTags = normalizeTagValues(nextValue);
                setSessionTags(normalizedTags);
                saveSessionPatch({ tags: toTagObjects(normalizedTags) });
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={t('professor.sessionEditor.tags', { defaultValue: 'Session tags' })}
                  placeholder={t('professor.sessionEditor.tagsPlaceholder', { defaultValue: 'Add a topic tag' })}
                  helperText={t('professor.sessionEditor.tagsHelp', {
                    defaultValue: 'Create tags in Course Settings, then select the tags that describe this session and its questions.',
                  })}
                />
              )}
              sx={{ flex: 1, minWidth: 260 }}
            />
            {sessionTags.length > 0 ? (
              <Button
                variant="outlined"
                onClick={handleApplySessionTagsToQuestions}
                disabled={applyingSessionTags || questions.length === 0}
                sx={{ mt: { xs: 0, sm: 0.5 } }}
              >
                {applyingSessionTags
                  ? t('professor.sessionEditor.applyingTagsToQuestions', { defaultValue: 'Applying tags…' })
                  : t('professor.sessionEditor.applyTagsToAllQuestions', { defaultValue: 'Apply tags to all questions' })}
              </Button>
            ) : null}
          </Box>

          {(quiz || practiceQuiz) && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: SETTINGS_STACK_GAP }}>
              <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: SETTINGS_STACK_GAP }}>
                <Box sx={{ flex: 1 }}>
                  <DateTimePreferenceField
                    label={t('professor.sessionEditor.quizStart')}
                    value={quizStart}
                    onChange={(val) => {
                      setQuizStart(val);
                      const validationMessage = validateQuizWindow(val, quizEnd);
                      if (validationMessage) {
                        setMsg({ severity: 'error', text: t(validationMessage) });
                        return;
                      }
                      const iso = toIsoIfValid(val);
                      if (iso) saveSessionPatch({ quizStart: iso });
                    }}
                    disabled={savingSession}
                    fullWidth
                    use24Hour={use24HourTime}
                  />
                </Box>
                <Box sx={{ flex: 1 }}>
                  <DateTimePreferenceField
                    label={t('professor.sessionEditor.quizEnd')}
                    value={quizEnd}
                    onChange={(val) => {
                      setQuizEnd(val);
                      const validationMessage = validateQuizWindow(quizStart, val);
                      if (validationMessage) {
                        setMsg({ severity: 'error', text: t(validationMessage) });
                        return;
                      }
                      const iso = toIsoIfValid(val);
                      if (iso) saveSessionPatch({ quizEnd: iso });
                    }}
                    min={quizStart}
                    disabled={savingSession}
                    fullWidth
                    use24Hour={use24HourTime}
                  />
                </Box>
              </Box>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button
                  size="small"
                  variant="text"
                  onClick={applyTodayQuizWindow}
                  disabled={savingSession}
                >
                  {t('professor.sessionEditor.today')}
                </Button>
                <Button
                  size="small"
                  variant="text"
                  onClick={applyQuizEndExtension}
                  disabled={savingSession}
                >
                  {t('professor.sessionEditor.add12hToEndDate')}
                </Button>
                <Typography variant="caption" sx={{
                  color: "text.secondary"
                }}>
                  {t('professor.sessionEditor.defaultQuizWindows')}
                </Typography>
              </Box>
              {anonymous || session?.activityEverShared ? (
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  {t(session?.activityEverShared ? 'professor.sessionEditor.sharedNoExtensions' : 'professor.sessionEditor.anonymousNoExtensions')}
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    {t('professor.sessionEditor.quizExtensions', { count: extensionDrafts.length })}
                  </Typography>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={openExtensionsDialog}
                    disabled={savingSession}
                  >
                    {t('professor.sessionEditor.manageExtensions')}
                  </Button>
                </Box>
              )}
            </Box>
          )}

          {!(quiz || practiceQuiz) && (
            <Box sx={{ maxWidth: { xs: '100%', sm: 420 } }}>
              <DateTimePreferenceField
                label={t('professor.sessionEditor.sessionDate')}
                value={sessionDate}
                onChange={(val) => {
                  setSessionDate(val);
                  const iso = toIsoIfValid(val);
                  if (iso) saveSessionPatch({ date: iso });
                }}
                disabled={savingSession}
                fullWidth
                use24Hour={use24HourTime}
              />
            </Box>
          )}

          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              hidden
              data-testid="session-import-input"
              aria-label={t('professor.sessionEditor.importSessionFile')}
              onChange={handleImportSessionFile}
            />
            <Button startIcon={<DownloadIcon />} onClick={() => setExportOpen(true)} disabled={exportingSession}>
              {exportingSession ? t('professor.sessionEditor.exporting') : t('professor.sessionEditor.exportSession')}
            </Button>
            <Button
              startIcon={<UploadIcon />}
              onClick={openSessionImportPicker}
              disabled={importingSession}
            >
              {importingSession ? t('professor.sessionEditor.importingSession') : t('professor.sessionEditor.importSession')}
            </Button>
            <Button startIcon={<CopyIcon />} onClick={handleCopySession} disabled={copying}>
              {copying ? t('professor.sessionEditor.copying') : t('professor.sessionEditor.copySession')}
            </Button>
            <Button color="error" startIcon={<DeleteIcon />} onClick={() => setDeleteOpen(true)}>
              {t('professor.sessionEditor.deleteSession')}
            </Button>
          </Box>
        </Box>
      </Paper>

      {/* Questions */}
      <Paper sx={{ p: { xs: 2, sm: 2.25 } }}>
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: { xs: 'stretch', sm: 'flex-start' },
            justifyContent: 'space-between',
            gap: 1.25,
            mb: SETTINGS_STACK_GAP,
          }}
        >
          <Typography variant="h6">{t('professor.sessionEditor.questionsCount', { count: questions.length })}</Typography>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, flexWrap: 'wrap' }}>
            <Button
              variant="outlined"
              onClick={toggleAllQuestionsExpanded}
              disabled={questions.length === 0}
              aria-expanded={allQuestionsExpanded}
              sx={{ minHeight: 40 }}
            >
              {t(allQuestionsExpanded
                ? 'professor.sessionEditor.collapseAllPreviews'
                : 'professor.sessionEditor.expandAllPreviews')}
            </Button>
            <TextField
              label={t('professor.sessionEditor.pointsPerQuestion')}
              type="number"
              size="small"
              value={allQuestionPoints}
              onChange={(event) => setAllQuestionPoints(event.target.value)}
              error={normalizedAllQuestionPoints !== '' && allQuestionPointsInvalid}
              slotProps={{ htmlInput: { min: 0, step: 'any' } }}
              sx={{ width: { xs: 160, sm: 180 } }}
            />
            <Button
              variant="outlined"
              onClick={handleApplyPointsToAllQuestions}
              disabled={
                applyingQuestionPoints
                || allQuestionPointsInvalid
                || !hasGradableQuestions
                || questionsEditingLocked
                || !!inlineEditor
              }
              sx={{ minHeight: 40 }}
            >
              {applyingQuestionPoints
                ? t('professor.sessionEditor.applyingPointsToQuestions')
                : t('professor.sessionEditor.applyPointsToAllQuestions')}
            </Button>
          </Box>
        </Box>

        {status === 'done' && questionsEditingLocked && (
          <Alert
            severity="warning"
            sx={{ mb: SETTINGS_STACK_GAP }}
            action={(
              <Button
                color="inherit"
                size="small"
                onClick={() => setUnlockEndedEditing(true)}
                aria-label={t('professor.sessionEditor.unlockEditing')}
              >
                {t('professor.sessionEditor.unlockEditing')}
              </Button>
            )}
          >
            {t('professor.sessionEditor.endedEditNote')}
          </Alert>
        )}
        {status === 'done' && !questionsEditingLocked && (
          <Alert severity="warning" sx={{ mb: SETTINGS_STACK_GAP }}>
            {t('professor.sessionEditor.editingUnlocked')}
          </Alert>
        )}

        <Box
          sx={{
            opacity: questionsEditingLocked ? 0.42 : 1,
            transition: 'opacity 0.2s ease',
            pointerEvents: questionsEditingLocked ? 'none' : 'auto',
          }}
          aria-disabled={questionsEditingLocked}
        >
          {questions.length === 0 && (
            <Typography
              sx={{
                color: "text.secondary",
                pb: 1.5,
                textAlign: 'center'
              }}>
              {t('professor.sessionEditor.noQuestionsYet')}
            </Typography>
          )}

          {[...Array(questions.length + 1).keys()].map((slotIdx) => {
          const slotKey = `slot-${slotIdx}`;
          const currentQuestion = questions[slotIdx];
          const isQuestionExpanded = currentQuestion
            ? !!expandedQuestions[currentQuestion._id]
            : false;
          const isEdgeInsertSlot = slotIdx === 0 || slotIdx === questions.length;
          const activeBaseline = inlineEditor?.mode === 'edit' && currentQuestion?._id === inlineEditor.questionId
            ? inlineEditor.baselineQuestion
            : null;
          const insertionNumberOffset = insertingAtIndex !== -1 && slotIdx >= insertingAtIndex ? 1 : 0;
          const displayedQuestionNumber = slotIdx + 1 + insertionNumberOffset;
          const questionHasResponses = currentQuestion?._id
            ? hasResponseDataForQuestion(currentQuestion._id)
            : false;
          const canMoveCurrentQuestionUp = currentQuestion?._id
            ? !questionsEditingLocked && canMoveQuestionById(currentQuestion._id, -1)
            : false;
          const canMoveCurrentQuestionDown = currentQuestion?._id
            ? !questionsEditingLocked && canMoveQuestionById(currentQuestion._id, 1)
            : false;

            return (
              <Box key={slotKey}>
                {activeEditorSlotIndex === slotIdx ? (
                  renderInlineEditorCard({
                    key: `inline-editor-${inlineEditor?.key}`,
                    index: slotIdx,
                    initialQuestion: inlineEditor?.mode === 'edit' ? currentQuestion : null,
                    baselineQuestion: inlineEditor?.mode === 'edit' ? activeBaseline : null,
                  })
                ) : (
                  <Box sx={{ display: 'flex', justifyContent: 'center', mb: PAGE_SECTION_GAP }}>
                    {isEdgeInsertSlot ? (
                      <Button
                        variant="outlined"
                        size="small"
                        startIcon={<AddIcon />}
                        onClick={() => openAddQuestionDialogAt(slotIdx)}
                        disabled={questionsEditingLocked}
                        aria-label={t('professor.sessionEditor.addQuestionAtPositionAria', { position: slotIdx + 1 })}
                      >
                        {t('professor.sessionEditor.addQuestion')}
                      </Button>
                    ) : (
                      <Button
                        variant="text"
                        size="small"
                        onClick={() => openAddQuestionDialogAt(slotIdx)}
                        disabled={questionsEditingLocked}
                        aria-label={t('professor.sessionEditor.addQuestionAtPositionAria', { position: slotIdx + 1 })}
                        sx={{
                          width: '100%',
                          minWidth: 0,
                          maxWidth: { xs: '100%', sm: 620 },
                          px: 0.5,
                          py: 0.35,
                          borderRadius: 1.5,
                          color: 'text.secondary',
                          justifyContent: 'flex-end',
                          textTransform: 'none',
                          '& .insert-question-line': {
                            flexGrow: 1,
                            borderTop: '3px solid',
                            borderColor: 'divider',
                            borderRadius: 999,
                            mr: 0.9,
                            transition: 'border-color 0.2s ease',
                          },
                          '&:hover .insert-question-line': {
                            borderColor: 'text.secondary',
                          },
                        }}
                      >
                        <Box className="insert-question-line" />
                        <AddIcon fontSize="small" />
                        <Typography variant="caption" sx={{ ml: 0.2, display: { xs: 'none', sm: 'inline' } }}>
                          {t('common.add')}
                        </Typography>
                      </Button>
                    )}
                  </Box>
                )}

                {currentQuestion && slotIdx !== editingQuestionIndex ? (
                    <Card key={currentQuestion._id} variant="outlined" sx={{ mb: PAGE_SECTION_GAP }}>
                      <CardContent
                        sx={{
                          display: 'flex',
                          flexDirection: { xs: 'column', sm: 'row' },
                          gap: { xs: 1, sm: 1.5 },
                          alignItems: 'flex-start',
                          minWidth: 0,
                          overflow: 'hidden',
                          '&:last-child': { pb: 2 },
                        }}
                      >
                        <Box
                          sx={{
                            display: { xs: 'flex', sm: 'none' },
                            width: '100%',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          }}
                        >
                          <Typography variant="subtitle2" sx={{
                            color: "text.secondary"
                          }}>
                            {t('professor.sessionEditor.questionNumber', { number: displayedQuestionNumber })}
                          </Typography>
                          <IconButton
                            size="small"
                            aria-label={t('common.moreActions')}
                            disabled={questionsEditingLocked}
                            onClick={(event) => openQuestionActions(event, {
                              mode: 'view',
                              index: slotIdx,
                              question: currentQuestion,
                            })}
                          >
                            <MoreIcon fontSize="small" />
                          </IconButton>
                        </Box>

                        <Box
                          sx={{
                            display: { xs: 'none', sm: 'flex' },
                            flexDirection: 'column',
                            alignItems: 'center',
                            minWidth: 34,
                            flexShrink: 0,
                          }}
                        >
                          <Tooltip title={t('common.edit')}>
                            <span>
                              <IconButton
                                size="small"
                                aria-label={t('common.edit')}
                                disabled={questionsEditingLocked}
                                onClick={() => openEditEditor(currentQuestion._id)}
                              >
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title={t('professor.sessionEditor.moveUp')}>
                            <span>
                              <IconButton
                                size="small"
                                aria-label={t('common.moveUp')}
                                disabled={!canMoveCurrentQuestionUp}
                                onClick={() => moveQuestionByQuestionId(currentQuestion._id, -1)}
                              >
                                <UpIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Typography
                            variant="subtitle2"
                            sx={{
                              color: "text.secondary",
                              lineHeight: 1.2
                            }}>
                            {displayedQuestionNumber}.
                          </Typography>
                          <Tooltip title={t('professor.sessionEditor.moveDown')}>
                            <span>
                              <IconButton
                                size="small"
                                aria-label={t('common.moveDown')}
                                disabled={!canMoveCurrentQuestionDown}
                                onClick={() => moveQuestionByQuestionId(currentQuestion._id, 1)}
                              >
                                <DownIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title={questionHasResponses ? t('professor.sessionEditor.cannotDeleteHasResponses') : t('common.delete')}>
                            <span>
                              <IconButton
                                size="small"
                                color="error"
                                aria-label={t('common.delete')}
                                disabled={questionsEditingLocked || questionHasResponses}
                                onClick={() => setDeleteQTarget(currentQuestion)}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Box>

                        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                          <Box
                            sx={{
                              position: 'relative',
                              cursor: 'pointer',
                              borderRadius: 1,
                              px: { xs: 0.2, sm: 0.35 },
                              py: 0.2,
                              '&:hover': {
                                backgroundColor: 'action.hover',
                              },
                            }}
                            onClick={() => toggleQuestionExpanded(currentQuestion._id)}
                            onKeyDown={(event) => handleQuestionPreviewKeyDown(event, currentQuestion._id)}
                            role="button"
                            tabIndex={0}
                            aria-expanded={isQuestionExpanded}
                            aria-label={t(isQuestionExpanded
                              ? 'professor.sessionEditor.collapseQuestion'
                              : 'professor.sessionEditor.expandQuestion', { number: displayedQuestionNumber })}
                          >
                            {normalizeTagValues(currentQuestion.tags || []).filter((tag) => tag.toLowerCase() !== 'qlicker').length > 0 ? (
                              <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', px: { xs: 0.25, sm: 0.5 }, pb: 0.5 }}>
                                {normalizeTagValues(currentQuestion.tags || [])
                                  .filter((tag) => tag.toLowerCase() !== 'qlicker')
                                  .map((tag) => (
                                    <Chip
                                      key={`${currentQuestion._id}-tag-${tag}`}
                                      size="small"
                                      variant="outlined"
                                      label={tag}
                                    />
                                  ))}
                              </Box>
                            ) : null}
                            <Box
                              sx={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                px: { xs: 0.25, sm: 0.5 },
                                pb: 0.5,
                              }}
                            >
                              <Typography variant="caption" sx={{
                                color: "text.secondary"
                              }}>
                                {isQuestionExpanded ? t('professor.sessionEditor.tapCollapse') : t('professor.sessionEditor.tapExpand')}
                              </Typography>
                              <ExpandMoreIcon
                                fontSize="small"
                                sx={{
                                  transform: isQuestionExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                  transition: 'transform 0.2s ease',
                                  color: 'text.secondary',
                                }}
                              />
                            </Box>
                            <Box
                              sx={{
                                maxHeight: isQuestionExpanded ? 'none' : { xs: 180, sm: 210 },
                                overflow: 'hidden',
                                position: 'relative',
                              }}
                            >
                              <QuestionDisplay question={currentQuestion} />
                              {!isQuestionExpanded && (
                                <Box
                                  sx={{
                                    position: 'absolute',
                                    left: 0,
                                    right: 0,
                                    bottom: 0,
                                    height: 40,
                                    background: theme => `linear-gradient(to bottom, rgba(255,255,255,0), ${theme.palette.background.paper})`,
                                  }}
                                />
                              )}
                            </Box>
                          </Box>
                        </Box>
                      </CardContent>
                    </Card>

                ) : null}
              </Box>
            );
          })}
        </Box>
      </Paper>

      <Dialog open={exportOpen} onClose={() => !exportingSession && setExportOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{t('professor.sessionEditor.exportTitle')}</DialogTitle>
        <DialogContent dividers>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>
              {t('professor.sessionEditor.exportDescription')}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Button
                variant={exportFormat === 'pdf' ? 'contained' : 'outlined'}
                onClick={() => setExportFormat('pdf')}
              >
                {t('professor.sessionEditor.exportFormatPdf')}
              </Button>
              <Button
                variant={exportFormat === 'json' ? 'contained' : 'outlined'}
                onClick={() => setExportFormat('json')}
              >
                {t('professor.sessionEditor.exportFormatJson')}
              </Button>
            </Box>

            {exportFormat === 'json' ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Typography variant="body2" sx={{
                  color: "text.secondary"
                }}>
                  {t('professor.sessionEditor.exportJsonDescription')}
                </Typography>
                <Button
                  variant="contained"
                  startIcon={<DownloadIcon />}
                  onClick={handleExportJson}
                  disabled={exportingSession}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  {exportingSession ? t('professor.sessionEditor.exporting') : t('professor.sessionEditor.exportJson')}
                </Button>
              </Box>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                <Typography variant="body2" sx={{
                  color: "text.secondary"
                }}>
                  {t('professor.sessionEditor.exportPdfDescription')}
                </Typography>
                <Button variant="outlined" onClick={() => handleExportPdfVariant('questions')} disabled={exportingSession}>
                  {t('professor.sessionEditor.pdfQuestions')}
                </Button>
                <Button variant="outlined" onClick={() => handleExportPdfVariant('answers')} disabled={exportingSession}>
                  {t('professor.sessionEditor.pdfAnswers')}
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => handleExportPdfVariant('answers-solutions')}
                  disabled={exportingSession}
                >
                  {t('professor.sessionEditor.pdfAnswersSolutions')}
                </Button>
                <Typography variant="caption" sx={{
                  color: "text.secondary"
                }}>
                  {t('professor.sessionEditor.exportPdfHint')}
                </Typography>
              </Box>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExportOpen(false)}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={addQuestionDialog.open} onClose={() => setAddQuestionDialog((current) => ({ ...current, open: false }))} maxWidth="xs" fullWidth>
        <DialogTitle>{t('professor.sessionEditor.addQuestion')}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => {
                openInsertEditorAt(addQuestionDialog.index);
                setAddQuestionDialog((current) => ({ ...current, open: false }));
              }}
            >
              {t('student.course.createNewQuestion', { defaultValue: 'Create New' })}
            </Button>
            <Button
              variant="outlined"
              startIcon={<CopyIcon />}
              onClick={() => {
                setLibrarySelectionCount(0);
                setLibraryDialogOpen(true);
                setAddQuestionDialog((current) => ({ ...current, open: false }));
              }}
            >
              {t('student.course.copyFromQuestionLibrary', { defaultValue: 'Copy from Question Library' })}
            </Button>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddQuestionDialog((current) => ({ ...current, open: false }))}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={libraryDialogOpen}
        onClose={() => {
          setLibraryDialogOpen(false);
          setLibrarySelectionCount(0);
        }}
        maxWidth="lg"
        fullWidth
      >
        <DialogTitle>{t('student.course.copyFromQuestionLibrary', { defaultValue: 'Copy from Question Library' })}</DialogTitle>
        <DialogContent dividers sx={{ p: 0 }}>
          <Box sx={{ p: 2 }}>
            <QuestionLibraryPanel
              ref={libraryPanelRef}
              courseId={courseId}
              currentCourse={course}
              availableSessions={[]}
              allowQuestionCreate={false}
              selectionAction={{
                buttonLabel: t('questionLibrary.bulk.addToSession', { defaultValue: 'Add to session' }),
                hideImport: true,
                onSubmit: handleAddQuestionsFromLibrary,
                onSelectionChange: (questionIds) => setLibrarySelectionCount(questionIds.length),
              }}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button
            variant="contained"
            disabled={librarySelectionCount === 0}
            onClick={async () => {
              await libraryPanelRef.current?.submitSelectedQuestions();
            }}
          >
            {t('questionLibrary.bulk.addToSession', { defaultValue: 'Add to session' })}
          </Button>
          <Button
            onClick={() => {
              setLibraryDialogOpen(false);
              setLibrarySelectionCount(0);
            }}
          >
            {t('common.cancel')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!sessionImportPreview} onClose={() => !importingSession && setSessionImportPreview(null)} maxWidth="lg" fullWidth>
        <DialogTitle>{t('professor.sessionEditor.importSession')}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>
              {t('professor.sessionEditor.importPreviewDescription', {
                defaultValue: 'Review the imported questions, remove any you do not want, and choose tags to apply to all imported questions.',
              })}
            </Typography>
            <TextField
              label={t('professor.sessionEditor.sessionName', { defaultValue: 'Session name' })}
              value={sessionImportPreview?.session?.name || ''}
              slotProps={{ input: { readOnly: true } }}
            />
            <Autocomplete
              multiple
              freeSolo
              options={[...new Set(['Imported', ...normalizeTagValues(course?.tags || [])])]}
              value={sessionImportTags}
              onChange={(_event, nextValue) => setSessionImportTags(normalizeTagValues(nextValue))}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={t('questionLibrary.import.tags', { defaultValue: 'Tags to apply to all imported questions' })}
                  placeholder={t('questionLibrary.import.tagsPlaceholder', { defaultValue: 'Imported' })}
                />
              )}
            />
            <Stack spacing={1.25}>
              {(sessionImportPreview?.session?.questions || []).map((question, index) => {
                const previewId = question._previewId || `session-import-${index}`;
                const checked = sessionImportSelectedIds.includes(previewId);
                return (
                  <Card key={previewId} variant="outlined">
                    <CardContent sx={{ display: 'flex', gap: 1.25, alignItems: 'flex-start' }}>
                      <Checkbox
                        checked={checked}
                        onChange={() => {
                          setSessionImportSelectedIds((previous) => (
                            checked
                              ? previous.filter((id) => id !== previewId)
                              : [...previous, previewId]
                          ));
                        }}
                      />
                      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                          <Chip
                            size="small"
                            label={t('professor.sessionEditor.questionNumber', { number: index + 1 })}
                          />
                        </Box>
                        <QuestionDisplay question={question} />
                      </Box>
                    </CardContent>
                  </Card>
                );
              })}
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSessionImportPreview(null)} disabled={importingSession}>{t('common.cancel')}</Button>
          <Button
            variant="contained"
            data-testid="confirm-session-import"
            onClick={handleConfirmSessionImport}
            disabled={importingSession}
          >
            {importingSession ? t('common.saving', { defaultValue: 'Saving…' }) : t('professor.sessionEditor.importSession')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Session Confirmation */}
      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)}>
        <DialogTitle>{t('professor.sessionEditor.deleteSessionTitle')}</DialogTitle>
        <DialogContent>
          <Typography>{t('professor.sessionEditor.deleteSessionMessage', { name: session.name })}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)}>{t('common.cancel')}</Button>
          <Button color="error" variant="contained" onClick={handleDeleteSession} disabled={deleting}>
            {deleting ? t('professor.course.deleting') : t('common.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Go Live Confirmation */}
      <Dialog open={confirmGoLiveOpen} onClose={() => setConfirmGoLiveOpen(false)}>
        <DialogTitle>{t('professor.sessionEditor.goLiveTitle')}</DialogTitle>
        <DialogContent>
          <Typography>
            {t('professor.sessionEditor.goLiveMessage')}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmGoLiveOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" color="success" onClick={confirmGoLive}>
            {t('professor.sessionEditor.goLive')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Scheduled quiz activation confirmation */}
      <Dialog
        open={confirmScheduledQuizLiveOpen}
        onClose={() => setConfirmScheduledQuizLiveOpen(false)}
      >
        <DialogTitle>{t('professor.sessionEditor.liveBasedOnDate')}</DialogTitle>
        <DialogContent>
          <Typography>{t('professor.sessionEditor.scheduledQuizLiveWarning')}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmScheduledQuizLiveOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" color="warning" onClick={saveScheduledQuizStatus}>
            {t('professor.sessionEditor.makeQuizLive')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete Question Confirmation */}
      <Dialog open={!!deleteQTarget} onClose={() => setDeleteQTarget(null)}>
        <DialogTitle>{t('professor.sessionEditor.deleteQuestionTitle')}</DialogTitle>
        <DialogContent>
          <Typography>
            {deleteTargetHasResponses
              ? t('professor.sessionEditor.responsesPreventDelete')
              : t('professor.sessionEditor.deleteQuestionMessage')}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteQTarget(null)}>{t('common.cancel')}</Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteTargetHasResponses || questionsEditingLocked}
            onClick={() => handleDeleteQuestion(deleteQTarget._id)}
          >
            {t('common.delete')}
          </Button>
        </DialogActions>
      </Dialog>

      <Menu
        anchorEl={questionActions.anchorEl}
        open={Boolean(questionActions.anchorEl)}
        onClose={closeQuestionActions}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem onClick={() => runQuestionAction('move-up')} disabled={!actionCanMoveUp}>
          {t('professor.sessionEditor.moveUp')}
        </MenuItem>
        <MenuItem onClick={() => runQuestionAction('move-down')} disabled={!actionCanMoveDown}>
          {t('professor.sessionEditor.moveDown')}
        </MenuItem>
        {actionContext?.mode === 'view' && (
          <MenuItem onClick={() => runQuestionAction('edit')} disabled={questionsEditingLocked}>
            {t('common.edit')}
          </MenuItem>
        )}
        {(actionContext?.mode === 'view' || actionContext?.mode === 'edit') && (
          <MenuItem
            onClick={() => runQuestionAction('delete')}
            disabled={questionsEditingLocked || actionContextQuestionHasResponses}
            sx={{ color: 'error.main' }}
          >
            {t('common.delete')}
          </MenuItem>
        )}
      </Menu>

      <Dialog
        open={extensionsOpen}
        onClose={() => {
          if (!savingExtensions) setExtensionsOpen(false);
        }}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{t('professor.sessionEditor.extensionsTitle')}</DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t('professor.sessionEditor.extensionsMessage')}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexDirection: { xs: 'column', sm: 'row' } }}>
            <Autocomplete
              options={availableExtensionStudents}
              value={extensionStudent}
              onChange={(_, value) => setExtensionStudent(value)}
              getOptionLabel={formatStudentLabel}
              renderInput={(params) => (
                <TextField
                  {...params}
                  size="small"
                  label={t('professor.sessionEditor.selectStudent')}
                  placeholder={t('professor.sessionEditor.searchByNameOrEmail')}
                />
              )}
              sx={{ flex: 1 }}
            />
            <Button
              variant="outlined"
              onClick={addExtensionStudent}
              disabled={!extensionStudent?._id}
            >
              {t('common.add')}
            </Button>
          </Box>

          {extensionDrafts.length === 0 ? (
            <Alert severity="info">{t('professor.sessionEditor.noExtensions')}</Alert>
          ) : (
            extensionDrafts.map((extension) => {
              const student = studentById.get(String(extension.userId));
              return (
                <Paper key={extension.userId} variant="outlined" sx={{ p: 1.25 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 1 }}>
                    <Typography variant="subtitle2">
                      {student ? formatStudentLabel(student) : extension.userId}
                    </Typography>
                    <IconButton
                      size="small"
                      color="error"
                      onClick={() => removeExtensionDraft(extension.userId)}
                      aria-label={t('professor.sessionEditor.removeExtension')}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1, flexDirection: { xs: 'column', sm: 'row' } }}>
                    <Box sx={{ flex: 1 }}>
                      <DateTimePreferenceField
                        label={t('professor.sessionEditor.start')}
                        value={extension.quizStart || ''}
                        onChange={(value) => updateExtensionDraft(extension.userId, 'quizStart', value)}
                        fullWidth
                        use24Hour={use24HourTime}
                      />
                    </Box>
                    <Box sx={{ flex: 1 }}>
                      <DateTimePreferenceField
                        label={t('professor.sessionEditor.end')}
                        value={extension.quizEnd || ''}
                        onChange={(value) => updateExtensionDraft(extension.userId, 'quizEnd', value)}
                        fullWidth
                        use24Hour={use24HourTime}
                      />
                    </Box>
                  </Box>
                </Paper>
              );
            })
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExtensionsOpen(false)} disabled={savingExtensions}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={saveExtensions} disabled={savingExtensions}>
            {savingExtensions ? '...' : t('professor.sessionEditor.saveExtensions')}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar */}
      <Snackbar open={!!msg} autoHideDuration={msg?.severity === 'warning' ? 8000 : 4000} onClose={() => setMsg(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        {msg ? <Alert severity={msg.severity} onClose={() => setMsg(null)}>{msg.text}</Alert> : undefined}
      </Snackbar>
    </Box>
  );
}
