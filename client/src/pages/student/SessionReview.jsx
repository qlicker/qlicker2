import {
  useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo,
} from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import {
  Box, Typography, Button, Paper, Alert, CircularProgress,
  Chip, ToggleButtonGroup, ToggleButton,
} from '@mui/material';
import {
  ChevronLeft as PrevIcon,
  ChevronRight as NextIcon,
  ViewList as AllIcon,
  ViewCarousel as OneIcon,
  Visibility as ShowIcon,
  VisibilityOff as HideIcon,
  CheckCircle as CorrectIcon,
} from '@mui/icons-material';
import apiClient from '../../api/client';
import {
  TYPE_COLORS,
  getQuestionTypeLabel,
  QUESTION_TYPES,
  buildQuestionProgressList,
  isOptionBasedQuestionType,
  isSlideType,
  normalizeQuestionType,
} from '../../components/questions/constants';
import BackLinkButton from '../../components/common/BackLinkButton';
import AnonymousSessionNotice from '../../components/common/AnonymousSessionNotice';
import { useTranslation } from 'react-i18next';
import { prepareRichTextInput, renderKatexInElement } from '../../components/questions/richTextUtils';
import { useAuth } from '../../contexts/AuthContext';
import { getDashboardPath } from '../../utils/dashboard';

/* ------------------------------------------------------------------ */
/*  Shared rich-text / image display styles                           */
/* ------------------------------------------------------------------ */
const richContentSx = {
  '& p': { my: 0.5 },
  '& ul, & ol': { my: 0.5, pl: 3 },
  '& [data-video-embed]': {
    display: 'block',
    width: '100%',
    maxWidth: '100%',
    my: 0.75,
  },
  '& iframe': {
    display: 'block',
    width: '100%',
    maxWidth: '100%',
    aspectRatio: '16 / 9',
    height: 'auto',
    border: 0,
    boxSizing: 'border-box',
    borderRadius: 0,
  },
  '& img': {
    display: 'block',
    maxWidth: '90% !important',
    height: 'auto !important',
    borderRadius: 0,
    my: 0.75,
  },
};

const COMPACT_CHIP_SX = {
  borderRadius: 1.4,
  '& .MuiChip-label': {
    px: 1.15,
  },
};

const MAX_STUDENT_TAB_INDEX = 2;

function parseCourseTab(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return 0;
  if (parsed < 0 || parsed > MAX_STUDENT_TAB_INDEX) return 0;
  return parsed;
}

function questionKey(question, fallbackIndex = 0) {
  const rawId = question?._id;
  if (rawId && typeof rawId === 'object') {
    if (rawId.$oid) return String(rawId.$oid);
    if (rawId._id) return String(rawId._id);
    if (rawId.type === 'Buffer' && Array.isArray(rawId.data)) {
      return rawId.data.map((n) => Number(n).toString(16).padStart(2, '0')).join('');
    }
    const text = String(rawId);
    if (text && text !== '[object Object]') return text;
    return `q-${fallbackIndex}`;
  }
  if (rawId !== undefined && rawId !== null && rawId !== '') {
    return String(rawId);
  }
  return `q-${fallbackIndex}`;
}

function questionStateKey(index) {
  return `idx-${index}`;
}

function responseKeysForQuestion(question, fallbackIndex = 0) {
  const keys = new Set();
  keys.add(questionKey(question, fallbackIndex));

  const rawId = question?._id;
  if (rawId && typeof rawId === 'object') {
    if (rawId.$oid) keys.add(String(rawId.$oid));
    if (rawId._id) keys.add(String(rawId._id));
    if (rawId.id) keys.add(String(rawId.id));
    if (rawId.type === 'Buffer' && Array.isArray(rawId.data)) {
      keys.add(rawId.data.map((n) => Number(n).toString(16).padStart(2, '0')).join(''));
    }
    const text = String(rawId);
    if (text && text !== '[object Object]') keys.add(text);
  } else if (rawId !== undefined && rawId !== null && rawId !== '') {
    keys.add(String(rawId));
  }

  return [...keys].filter(Boolean);
}

function getResponsesForQuestion(responsesByQuestion, question, fallbackIndex = 0) {
  const keys = responseKeysForQuestion(question, fallbackIndex);
  for (const key of keys) {
    if (Array.isArray(responsesByQuestion[key])) return responsesByQuestion[key];
  }
  return [];
}

function getMarkForQuestion(grade, question, fallbackIndex = 0) {
  if (!grade || !Array.isArray(grade.marks)) return null;
  const keys = new Set(responseKeysForQuestion(question, fallbackIndex).map((key) => String(key)));
  return grade.marks.find((mark) => keys.has(String(mark?.questionId))) || null;
}

function formatNumeric(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return String(Math.round(numeric * 10) / 10);
}

function buildDefaultFeedbackSummary() {
  return {
    feedbackSeenAt: null,
    feedbackQuestionIds: [],
    feedbackCount: 0,
    newFeedbackQuestionIds: [],
    newFeedbackCount: 0,
    hasNewFeedback: false,
  };
}

function resolveAttemptIndex(responseAttemptIdx, stateKey, responses = []) {
  if (!Array.isArray(responses) || responses.length === 0) return 0;
  const currentIndex = responseAttemptIdx[stateKey];
  if (Number.isInteger(currentIndex)) {
    return Math.min(currentIndex, Math.max(responses.length - 1, 0));
  }
  return Math.max(responses.length - 1, 0);
}

function isCorrectOption(option) {
  const value = option?.correct;
  if (value === true || value === 1 || value === '1') return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return Boolean(value);
}

function normalizeAnswerValue(answer) {
  if (answer === null || answer === undefined) return '';
  return String(answer).trim();
}

function normalizeComparableText(answer) {
  return normalizeAnswerValue(answer)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function resolveOptionIndex(answer, options = []) {
  if (answer && typeof answer === 'object') {
    if (Array.isArray(answer)) return -1;
    if (answer.optionId !== undefined) return resolveOptionIndex(answer.optionId, options);
    if (answer._id !== undefined) return resolveOptionIndex(answer._id, options);
    if (answer.id !== undefined) return resolveOptionIndex(answer.id, options);
    if (answer.index !== undefined) return resolveOptionIndex(answer.index, options);
    if (answer.value !== undefined) return resolveOptionIndex(answer.value, options);
    if (answer.answer !== undefined) return resolveOptionIndex(answer.answer, options);
    if (answer.text !== undefined) return resolveOptionIndex(answer.text, options);
  }

  if (typeof answer === 'number' && Number.isInteger(answer)) {
    if (answer >= 0 && answer < options.length) return answer;
    if (answer >= 1 && answer <= options.length) return answer - 1;
    return -1;
  }

  const normalizedRaw = normalizeAnswerValue(answer);
  if (!normalizedRaw) return -1;
  const normalized = normalizedRaw.toLowerCase();

  if (/^-?\d+$/.test(normalizedRaw)) {
    const parsed = Number(normalizedRaw);
    if (parsed >= 0 && parsed < options.length) return parsed;
    if (parsed >= 1 && parsed <= options.length) return parsed - 1;
  }

  if (/^[a-z]$/.test(normalized)) {
    const idx = normalized.charCodeAt(0) - 97;
    if (idx >= 0 && idx < options.length) return idx;
  }

  return options.findIndex((opt) => (
    normalizeAnswerValue(opt?._id).toLowerCase() === normalized
    || normalizeComparableText(opt?.answer) === normalizeComparableText(normalizedRaw)
    || normalizeComparableText(opt?.content) === normalizeComparableText(normalizedRaw)
    || normalizeComparableText(opt?.plainText) === normalizeComparableText(normalizedRaw)
  ));
}

function collectAnswerEntries(answer) {
  if (answer === null || answer === undefined) return [];
  if (Array.isArray(answer)) {
    return answer.flatMap((entry) => collectAnswerEntries(entry));
  }
  if (answer && typeof answer === 'object') {
    if (Array.isArray(answer.answers)) return collectAnswerEntries(answer.answers);
    if (answer.answer !== undefined) return collectAnswerEntries(answer.answer);
    if (answer.value !== undefined) return collectAnswerEntries(answer.value);
  }

  if (typeof answer === 'string') {
    const trimmed = answer.trim();
    if (!trimmed) return [];

    if ((trimmed.startsWith('[') && trimmed.endsWith(']'))
      || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== answer) return collectAnswerEntries(parsed);
      } catch {
        // Fall back to delimiter parsing below.
      }
    }

    if (/[|,;]/.test(trimmed)) {
      return trimmed
        .split(/[|,;]/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
  }

  return [answer];
}

/* ------------------------------------------------------------------ */
/*  Helper: render rich HTML with fallback                            */
/* ------------------------------------------------------------------ */
function RichHtml({
  value,
  fallback = '',
  sx = {},
  emptyText = '(no content)',
  allowVideoEmbeds = false,
}) {
  const ref = useRef(null);
  const html = useMemo(
    () => prepareRichTextInput(value || '', fallback || '', { allowVideoEmbeds }),
    [allowVideoEmbeds, value, fallback]
  );
  const innerHtml = useMemo(() => ({ __html: html }), [html]);

  useLayoutEffect(() => {
    if (!ref.current || !html) return;
    renderKatexInElement(ref.current);
  }, [html]);

  if (!html) return <Typography variant="body1">{emptyText}</Typography>;
  return <Box ref={ref} sx={sx} dangerouslySetInnerHTML={innerHtml} />;
}

/* ------------------------------------------------------------------ */
/*  Single question card (shared by both view modes)                  */
/* ------------------------------------------------------------------ */
function ReviewQuestionCard({
  question,
  progress,
  responseVisible = false,
  response = null,
  mark = null,
}) {
  const { t } = useTranslation();
  const [solutionVisible, setSolutionVisible] = useState(false);
  const normalizedType = useMemo(() => normalizeQuestionType(question), [question]);
  const isSlide = isSlideType(normalizedType);
  const opts = question.options || [];
  const points = question.sessionOptions?.points;
  const markChipLabel = useMemo(() => {
    if (!mark) {
      if (!isSlide && points != null) return `${points} pt${points !== 1 ? 's' : ''}`;
      return null;
    }
    if (mark?.needsGrading) return t('student.sessionReview.pendingManualGrade');
    return `${formatNumeric(mark?.points)} / ${formatNumeric(mark?.outOf)}`;
  }, [isSlide, mark, points, t]);
  const markChipColor = mark?.needsGrading ? 'warning' : 'success';
  const shouldLetter = [QUESTION_TYPES.MULTIPLE_CHOICE, QUESTION_TYPES.MULTI_SELECT].includes(normalizedType);
  const hasWrittenSolution = Boolean(
    question.solution
    || question.solutionHtml
    || question.solution_plainText
    || question.solutionPlainText
    || question.solutionText
  );
  const writtenSolutionHtml = question.solution || question.solutionHtml || '';
  const writtenSolutionPlain = question.solution_plainText || question.solutionPlainText || question.solutionText || '';
  const hasMarkedCorrectOption = opts.some((opt) => isCorrectOption(opt));
  const optionType = isOptionBasedQuestionType(normalizedType) || normalizedType === QUESTION_TYPES.TRUE_FALSE;
  const selectedOptionIndices = useMemo(() => {
    if (!responseVisible || !response || !optionType || opts.length === 0) return [];
    const values = collectAnswerEntries(response.answer);
    const selected = values
      .map((entry) => resolveOptionIndex(entry, opts))
      .filter((idx) => idx >= 0 && idx < opts.length);
    return [...new Set(selected)];
  }, [responseVisible, response, optionType, opts]);

  return (
    <Paper variant="outlined" sx={{ p: 2.5, width: '100%', minWidth: 0, overflow: 'hidden' }}>
      {/* Header row */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
        {progress && (
          <>
            <Chip
              label={t('student.sessionReview.pageProgress', {
                current: progress.pageCurrent,
                total: progress.pageTotal,
              })}
              size="small"
              variant="outlined"
              sx={COMPACT_CHIP_SX}
            />
            <Chip
              label={t('student.sessionReview.questionProgress', {
                current: progress.questionCurrent,
                total: progress.questionTotal,
              })}
              size="small"
              variant="outlined"
              sx={COMPACT_CHIP_SX}
            />
          </>
        )}
        <Chip label={getQuestionTypeLabel(t, normalizedType)} color={TYPE_COLORS[normalizedType] || 'default'} size="small" sx={COMPACT_CHIP_SX} />
        {markChipLabel && (
          <Chip
            label={markChipLabel}
            size="small"
            color={mark ? markChipColor : 'default'}
            variant={mark ? (mark?.needsGrading ? 'outlined' : 'filled') : 'outlined'}
            sx={COMPACT_CHIP_SX}
          />
        )}
      </Box>

      {/* Question content */}
      <RichHtml value={question.content} fallback={question.plainText} sx={{ ...richContentSx, mb: 1 }} allowVideoEmbeds />

      {/* Options (MC / TF / MS) */}
      {[QUESTION_TYPES.MULTIPLE_CHOICE, QUESTION_TYPES.TRUE_FALSE, QUESTION_TYPES.MULTI_SELECT].includes(normalizedType)
        && opts.length > 0 && (
        <Box sx={{ pl: 2, mt: 1 }}>
          {opts.map((opt, i) => {
            const showCorrectMark = solutionVisible && isCorrectOption(opt);
            const showResponseMark = responseVisible && selectedOptionIndices.includes(i);
            return (
              <Box
                key={i}
                sx={{
                  display: 'grid',
                  gridTemplateColumns: shouldLetter ? '20px 20px minmax(0, 1fr)' : '20px minmax(0, 1fr)',
                  columnGap: 0.5,
                  alignItems: 'start',
                  mb: 0.5,
                  px: 0.25,
                  borderRadius: 0.75,
                  bgcolor: showCorrectMark
                    ? 'rgba(46, 125, 50, 0.08)'
                    : showResponseMark
                      ? 'rgba(25, 118, 210, 0.10)'
                      : 'transparent',
                }}
              >
                <Box sx={{ width: 20, display: 'flex', justifyContent: 'center', pt: 0.25 }}>
                  {showCorrectMark ? <CorrectIcon color="success" fontSize="small" /> : null}
                </Box>
                {shouldLetter && (
                  <Typography variant="body2" sx={{ lineHeight: 1.5 }}>
                    {String.fromCharCode(65 + i)}.
                  </Typography>
                )}
                <RichHtml
                  value={opt.content || opt.plainText || opt.answer}
                  fallback={`Option ${i + 1}`}
                  sx={{
                    color: showCorrectMark ? 'success.main' : 'text.primary',
                    '& p': { my: 0 },
                    '& ul, & ol': { my: 0, pl: 2.5 },
                    '& li': { my: 0 },
                    '& [data-video-embed]': {
                      display: 'block',
                      width: '100%',
                      maxWidth: '100%',
                      my: 0.5,
                    },
                    '& iframe': {
                      display: 'block',
                      width: '100%',
                      maxWidth: '100%',
                      aspectRatio: '16 / 9',
                      height: 'auto',
                      border: 0,
                      boxSizing: 'border-box',
                      borderRadius: 0,
                    },
                    '& img': {
                      display: 'block', maxWidth: '90% !important',
                      height: 'auto !important',
                      borderRadius: 0, my: 0.5,
                    },
                  }}
                />
                {showResponseMark && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "primary.main",
                      gridColumn: shouldLetter ? '3 / 4' : '2 / 3',
                      mt: -0.25,
                      mb: 0.2,
                      fontWeight: 600
                    }}>
                    {t('student.sessionReview.yourSelection')}
                  </Typography>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {solutionVisible
        && [QUESTION_TYPES.MULTIPLE_CHOICE, QUESTION_TYPES.TRUE_FALSE, QUESTION_TYPES.MULTI_SELECT].includes(normalizedType)
        && !hasWrittenSolution && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            pl: 2,
            mt: 0.5,
            display: 'block'
          }}>
          {hasMarkedCorrectOption
            ? t('student.sessionReview.correctHighlighted')
            : t('student.sessionReview.noSolutionOrCorrect')}
        </Typography>
      )}

      {/* Numerical correct answer */}
      {normalizedType === QUESTION_TYPES.NUMERICAL && solutionVisible && (
        <Box sx={{ pl: 2, mt: 1 }}>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t('student.sessionReview.correct', { value: question.correctNumerical ?? '—' })}
          </Typography>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t('student.sessionReview.tolerance', { value: question.toleranceNumerical ?? 0 })}
          </Typography>
        </Box>
      )}

      {/* Show / Hide Solution button */}
      {!isSlide && (
        <Box sx={{ mt: 2 }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={solutionVisible ? <HideIcon /> : <ShowIcon />}
            onClick={() => setSolutionVisible((prev) => !prev)}
          >
            {solutionVisible ? t('student.quiz.hideSolution') : t('student.quiz.showSolution')}
          </Button>
        </Box>
      )}

      {/* Solution text (when visible) */}
      {solutionVisible && hasWrittenSolution && (
        <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              display: 'block',
              mb: 0.5
            }}>
            {t('common.solution')}
          </Typography>
          <RichHtml value={writtenSolutionHtml} fallback={writtenSolutionPlain} sx={richContentSx} />
        </Box>
      )}

      {solutionVisible
        && !hasWrittenSolution
        && ![QUESTION_TYPES.MULTIPLE_CHOICE, QUESTION_TYPES.TRUE_FALSE, QUESTION_TYPES.MULTI_SELECT].includes(normalizedType) && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            mt: 1,
            display: 'block'
          }}>
          {t('student.sessionReview.noSolution')}
        </Typography>
      )}

      {mark?.feedback && (
        <Box sx={{ mt: 1.5, pt: 1.5, borderTop: '1px solid', borderColor: 'divider' }}>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              display: 'block',
              mb: 0.5
            }}>
            {t('student.sessionReview.instructorFeedback')}
          </Typography>
          <RichHtml value={mark.feedback} sx={richContentSx} />
        </Box>
      )}
    </Paper>
  );
}

/* ================================================================== */
/*  SessionReview page                                                */
/* ================================================================== */
export default function SessionReview() {
  const { t } = useTranslation();
  const { courseId, sessionId } = useParams();
  const isOutsideActivity = useLocation().pathname.startsWith('/activity/');
  const { user } = useAuth();
  const dashboardPath = getDashboardPath(user);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedReturnTab = parseCourseTab(searchParams.get('returnTab'));
  const fallbackCourseBackLink = isOutsideActivity ? dashboardPath : requestedReturnTab === 0
    ? `/student/course/${courseId}`
    : `/student/course/${courseId}?tab=${requestedReturnTab}`;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [responsesByQuestion, setResponsesByQuestion] = useState({});
  const [sessionGrade, setSessionGrade] = useState(null);
  const [feedbackSummary, setFeedbackSummary] = useState(buildDefaultFeedbackSummary());
  const [dismissingFeedback, setDismissingFeedback] = useState(false);
  const [feedbackActionError, setFeedbackActionError] = useState('');

  // View mode: 'one' (single question) or 'all'
  const [viewMode, setViewMode] = useState('one');
  // Current question index (for single-question mode)
  const [questionIdx, setQuestionIdx] = useState(0);
  // Track whether response is shown per question (keyed by stable question index)
  const [responseVisible, setResponseVisible] = useState({});
  // Track which attempt index is shown per question (keyed by stable question index)
  const [responseAttemptIdx, setResponseAttemptIdx] = useState({});

  const fetchReview = useCallback(async ({ background = false } = {}) => {
    try {
      const reviewResult = await apiClient.get(`/sessions/${sessionId}/review`);

      const data = reviewResult?.data || {};
      setSession(data.session);
      setQuestions(data.questions || []);
      setResponsesByQuestion(data.responses || {});
      setFeedbackSummary(data.feedback || buildDefaultFeedbackSummary());
      setSessionGrade(data.grade || null);
      setFeedbackActionError('');
      if (!background) {
        setError(null);
      }
      return true;
    } catch (err) {
      const status = err.response?.status;
      const forbiddenMessage = err.response?.data?.message || t('student.sessionReview.noPermission');
      if (background && (status === 403 || status === 404)) {
        navigate(fallbackCourseBackLink, { replace: true });
        return false;
      }
      if (status === 403) {
        setError(forbiddenMessage);
      } else if (status === 404) {
        setError(t('student.sessionReview.sessionNotFound'));
      } else {
        setError(t('student.sessionReview.failedLoadReview'));
      }
      return false;
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  }, [courseId, sessionId, navigate, fallbackCourseBackLink]);

  useEffect(() => { fetchReview(); }, [fetchReview]);

  useEffect(() => {
    setQuestionIdx((prev) => {
      if (!questions.length) return 0;
      return Math.min(prev, questions.length - 1);
    });
  }, [questions.length]);

  useEffect(() => {
    if (loading || error) return undefined;

    const runCheck = () => {
      fetchReview({ background: true });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') runCheck();
    };

    const intervalId = setInterval(runCheck, 30000);
    window.addEventListener('focus', runCheck);
    window.addEventListener('online', runCheck);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener('focus', runCheck);
      window.removeEventListener('online', runCheck);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loading, error, fetchReview]);

  // Reset attempt index and current question when switching modes
  const handleViewModeChange = (_e, next) => {
    if (!next) return;
    setViewMode(next);
    setResponseVisible({});
    setResponseAttemptIdx({});
    setQuestionIdx(0);
  };

  // Reset attempt index when navigating to a new question
  const goTo = (idx) => {
    const bounded = Math.max(0, Math.min(idx, Math.max(questions.length - 1, 0)));
    setQuestionIdx(bounded);
    setResponseVisible({});
    setResponseAttemptIdx({});
  };

  const toggleResponseVisibility = (stateKey) => {
    setResponseVisible((prev) => ({ ...prev, [stateKey]: !prev[stateKey] }));
  };

  const cycleAttempt = (qKey, responses, direction) => {
    if (responses.length === 0) return;
    setResponseAttemptIdx((prev) => {
      const current = prev[qKey] || 0;
      const next = current + direction;
      if (next < 0 || next >= responses.length) return prev;
      return { ...prev, [qKey]: next };
    });
  };

  const questionNumberById = useMemo(() => {
    const entries = new Map();
    questions.forEach((question, idx) => {
      responseKeysForQuestion(question, idx).forEach((key) => {
        const normalizedKey = String(key || '');
        if (!normalizedKey || entries.has(normalizedKey)) return;
        entries.set(normalizedKey, idx + 1);
      });
    });
    return entries;
  }, [questions]);

  const feedbackQuestionNumbers = useMemo(() => {
    const questionIds = feedbackSummary?.newFeedbackQuestionIds || [];
    const numbers = questionIds
      .map((questionId) => questionNumberById.get(String(questionId)))
      .filter((value) => Number.isInteger(value));
    return [...new Set(numbers)].sort((a, b) => a - b);
  }, [feedbackSummary, questionNumberById]);

  const feedbackQuestionLabel = useMemo(() => {
    if (feedbackQuestionNumbers.length > 0) {
      return feedbackQuestionNumbers.map((number) => `Q${number}`).join(', ');
    }
    const fallbackIds = feedbackSummary?.newFeedbackQuestionIds || [];
    return fallbackIds.join(', ');
  }, [feedbackQuestionNumbers, feedbackSummary]);
  const progressList = useMemo(() => buildQuestionProgressList(questions), [questions]);

  const handleDismissFeedback = async () => {
    setDismissingFeedback(true);
    setFeedbackActionError('');
    try {
      const { data } = await apiClient.post(`/sessions/${sessionId}/review/feedback/dismiss`);
      const nextSummary = data?.feedback || buildDefaultFeedbackSummary();
      setFeedbackSummary(nextSummary);
      setSessionGrade((prev) => (prev
        ? {
          ...prev,
          feedbackSeenAt: nextSummary.feedbackSeenAt || new Date().toISOString(),
        }
        : prev));
    } catch {
      setFeedbackActionError(t('student.sessionReview.failedDismissFeedback'));
    } finally {
      setDismissingFeedback(false);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */
  if (loading) {
    return <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}><CircularProgress /></Box>;
  }

  if (error) {
    return (
      <Box sx={{ p: 3, maxWidth: 700 }}>
        <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
        <BackLinkButton
          variant="outlined"
          label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.sessionReview.backToCourse')}
          onClick={() => navigate(fallbackCourseBackLink)}
        />
      </Box>
    );
  }

  const total = questions.length;
  const resolvedReturnTab = session && (session.quiz || session.practiceQuiz)
    ? (session.studentCreated ? 2 : 1)
    : requestedReturnTab;
  const courseBackLink = isOutsideActivity ? dashboardPath : resolvedReturnTab === 0
    ? `/student/course/${courseId}`
    : `/student/course/${courseId}?tab=${resolvedReturnTab}`;
  const currentQ = questions[questionIdx];
  const currentProgress = progressList[questionIdx] || null;
  const currentQKey = currentQ ? questionKey(currentQ, questionIdx) : '';
  const currentQMark = currentQ ? getMarkForQuestion(sessionGrade, currentQ, questionIdx) : null;
  const currentStateKey = questionStateKey(questionIdx);
  const currentResponses = currentQ
    ? getResponsesForQuestion(responsesByQuestion, currentQ, questionIdx).sort((a, b) => a.attempt - b.attempt)
    : [];
  const currentQType = currentQ ? normalizeQuestionType(currentQ) : null;
  const currentIsOptionType = isOptionBasedQuestionType(currentQType) || currentQType === QUESTION_TYPES.TRUE_FALSE;

  return (
    <Box sx={{ p: 2.5, maxWidth: 860 }}>
      {/* Header */}
      <Box sx={{ mb: 2 }}>
        <BackLinkButton
          label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.sessionReview.backToCourse')}
          onClick={() => navigate(courseBackLink)}
          sx={{ mb: 1 }}
        />
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          {session?.name || t('student.sessionReview.sessionReviewFallback')}
        </Typography>
        {session?.description && (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mt: 0.5
            }}>
            {session.description}
          </Typography>
        )}
      </Box>

      {session?.anonymous ? <AnonymousSessionNotice /> : null}

      {feedbackSummary?.hasNewFeedback && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={(
            <Button
              color="inherit"
              size="small"
              onClick={handleDismissFeedback}
              disabled={dismissingFeedback}
            >
              {dismissingFeedback ? t('student.sessionReview.dismissing') : t('student.sessionReview.dismiss')}
            </Button>
          )}
        >
          {t('student.sessionReview.newFeedbackReceived')}
          {feedbackQuestionLabel ? t('student.sessionReview.feedbackQuestions', { questions: feedbackQuestionLabel }) : ''}
        </Alert>
      )}

      {feedbackActionError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {feedbackActionError}
        </Alert>
      )}

      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 2 }}>
        <Paper variant="outlined" sx={{ px: 1.5, py: 1 }}>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              display: 'block'
            }}>
            {t('student.sessionReview.sessionGrade')}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {sessionGrade
              ? `${formatNumeric(sessionGrade.value)}% (${formatNumeric(sessionGrade.points)} / ${formatNumeric(sessionGrade.outOf)})`
              : t('student.sessionReview.notAvailable')}
          </Typography>
        </Paper>
        <Paper variant="outlined" sx={{ px: 1.5, py: 1 }}>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              display: 'block'
            }}>
            {t('student.sessionReview.participation')}
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {sessionGrade ? `${formatNumeric(sessionGrade.participation)}%` : t('student.sessionReview.notAvailable')}
          </Typography>
        </Paper>
      </Box>

      {total === 0 ? (
        <Alert severity="info">{t('student.sessionReview.noQuestions')}</Alert>
      ) : (
        <>
          {/* View toggle */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2, flexWrap: 'wrap' }}>
            <ToggleButtonGroup
              value={viewMode}
              exclusive
              onChange={handleViewModeChange}
              size="small"
            >
              <ToggleButton value="one"><OneIcon sx={{ mr: 0.5 }} fontSize="small" />{t('student.sessionReview.oneAtATime')}</ToggleButton>
              <ToggleButton value="all"><AllIcon sx={{ mr: 0.5 }} fontSize="small" />{t('student.sessionReview.allQuestions')}</ToggleButton>
            </ToggleButtonGroup>

            {viewMode === 'one' && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                {currentProgress && (
                  <>
                    <Chip
                      label={t('student.sessionReview.pageProgress', {
                        current: currentProgress.pageCurrent,
                        total: currentProgress.pageTotal,
                      })}
                      size="small"
                      variant="outlined"
                    />
                    <Chip
                      label={t('student.sessionReview.questionProgress', {
                        current: currentProgress.questionCurrent,
                        total: currentProgress.questionTotal,
                      })}
                      size="small"
                      variant="outlined"
                    />
                  </>
                )}
                {total > 1 && (
                  <>
                    <Button
                      size="small"
                      variant="contained"
                      startIcon={<PrevIcon />}
                      disabled={questionIdx <= 0}
                      onClick={() => goTo(questionIdx - 1)}
                      aria-label={t('student.sessionReview.previousQuestion')}
                    >
                      {t('common.previous')}
                    </Button>
                    <Button
                      size="small"
                      variant="contained"
                      endIcon={<NextIcon />}
                      disabled={questionIdx >= total - 1}
                      onClick={() => goTo(questionIdx + 1)}
                      aria-label={t('student.sessionReview.nextQuestion')}
                    >
                      {t('common.next')}
                    </Button>
                  </>
                )}
              </Box>
            )}
          </Box>

          {/* Single question view */}
          {viewMode === 'one' && currentQ && (
            <Box>
              <ReviewQuestionCard
                key={currentQKey}
                question={currentQ}
                progress={currentProgress}
                responseVisible={!!responseVisible[currentStateKey]}
                response={currentResponses[resolveAttemptIndex(responseAttemptIdx, currentStateKey, currentResponses)] || null}
                mark={currentQMark}
              />

              {/* My Response section */}
              {(() => {
                const responses = currentResponses;
                const hasResponses = responses.length > 0;
                const attemptIdx = resolveAttemptIndex(responseAttemptIdx, currentStateKey, responses);
                const currentResponse = responses[attemptIdx];
                const isResponseVisible = !!responseVisible[currentStateKey];

                return (
                  <Box sx={{ mt: 2 }}>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => toggleResponseVisibility(currentStateKey)}
                      disabled={!hasResponses}
                    >
                      {isResponseVisible ? t('student.sessionReview.hideMyResponse') : t('student.sessionReview.showMyResponse')}
                    </Button>
                    {!hasResponses && (
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                          ml: 1
                        }}>
                        {t('student.sessionReview.noResponse')}
                      </Typography>
                    )}
                    {currentResponse && responses.length > 1 && (
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
                        <Button
                          size="small"
                          disabled={attemptIdx <= 0}
                          onClick={() => cycleAttempt(currentStateKey, responses, -1)}
                        >
                          ← {t('student.sessionReview.prevAttempt')}
                        </Button>
                        <Typography variant="body2" sx={{
                          color: "text.secondary"
                        }}>
                          {t('student.sessionReview.attemptProgress', { current: currentResponse.attempt, total: responses.length })}
                        </Typography>
                        <Button
                          size="small"
                          disabled={attemptIdx >= responses.length - 1}
                          onClick={() => cycleAttempt(currentStateKey, responses, 1)}
                        >
                          {t('student.sessionReview.nextAttempt')} →
                        </Button>
                      </Box>
                    )}
                    {isResponseVisible && currentResponse && currentIsOptionType && (
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                          mt: 1,
                          display: 'block',
                          ml: 0.5
                        }}>
                        {t('student.sessionReview.selectedOptionsNote')}
                      </Typography>
                    )}
                    {isResponseVisible && currentResponse && !currentIsOptionType && (
                      <Paper variant="outlined" sx={{ p: 2, mt: 1 }}>
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                            display: 'block',
                            mb: 0.5
                          }}>
                          {t('student.sessionReview.yourAnswer')}
                        </Typography>
                        {currentQType === QUESTION_TYPES.SHORT_ANSWER ? (
                          <RichHtml
                            value={currentResponse.answerWysiwyg || ''}
                            fallback={normalizeAnswerValue(currentResponse.answer)}
                            sx={richContentSx}
                          />
                        ) : (
                          <Typography variant="body2">
                            {normalizeAnswerValue(currentResponse.answer) || t('common.noAnswer')}
                          </Typography>
                        )}
                      </Paper>
                    )}
                  </Box>
                );
              })()}

            </Box>
          )}

          {/* All questions view */}
          {viewMode === 'all' && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {questions.map((q, i) => {
                const qKey = questionKey(q, i);
                const stateKey = questionStateKey(i);
                const responses = getResponsesForQuestion(responsesByQuestion, q, i).sort((a, b) => a.attempt - b.attempt);
                const hasResponses = responses.length > 0;
                const attemptIdx = resolveAttemptIndex(responseAttemptIdx, stateKey, responses);
                const currentResponse = responses[attemptIdx];
                const qType = normalizeQuestionType(q);
                const mark = getMarkForQuestion(sessionGrade, q, i);
                const isOptionType = isOptionBasedQuestionType(qType) || qType === QUESTION_TYPES.TRUE_FALSE;
                const isResponseVisible = !!responseVisible[stateKey];

                return (
                  <Box key={qKey}>
                    <ReviewQuestionCard
                      question={q}
                      progress={progressList[i] || null}
                      responseVisible={isResponseVisible}
                      response={currentResponse || null}
                      mark={mark}
                    />
                    <Box sx={{ mt: 1, ml: 1 }}>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => toggleResponseVisibility(stateKey)}
                        disabled={!hasResponses}
                      >
                        {isResponseVisible ? t('student.sessionReview.hideMyResponse') : t('student.sessionReview.showMyResponse')}
                      </Button>
                      {!hasResponses && (
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                            ml: 1
                          }}>
                          {t('student.sessionReview.noResponse')}
                        </Typography>
                      )}
                      {currentResponse && responses.length > 1 && (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
                          <Button
                            size="small"
                            disabled={attemptIdx <= 0}
                            onClick={() => cycleAttempt(stateKey, responses, -1)}
                          >
                            ← {t('student.sessionReview.prevAttempt')}
                          </Button>
                          <Typography variant="body2" sx={{
                            color: "text.secondary"
                          }}>
                            {t('student.sessionReview.attemptProgress', { current: currentResponse.attempt, total: responses.length })}
                          </Typography>
                          <Button
                            size="small"
                            disabled={attemptIdx >= responses.length - 1}
                            onClick={() => cycleAttempt(stateKey, responses, 1)}
                          >
                            {t('student.sessionReview.nextAttempt')} →
                          </Button>
                        </Box>
                      )}
                      {isResponseVisible && currentResponse && isOptionType && (
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                            mt: 1,
                            display: 'block',
                            ml: 0.5
                          }}>
                          {t('student.sessionReview.selectedOptionsNote')}
                        </Typography>
                      )}
                      {isResponseVisible && currentResponse && !isOptionType && (
                        <Paper variant="outlined" sx={{ p: 2, mt: 1 }}>
                          <Typography
                            variant="caption"
                            sx={{
                              color: "text.secondary",
                              display: 'block',
                              mb: 0.5
                            }}>
                            {t('student.sessionReview.yourAnswer')}
                          </Typography>
                          {qType === QUESTION_TYPES.SHORT_ANSWER ? (
                            <RichHtml
                              value={currentResponse.answerWysiwyg || ''}
                              fallback={normalizeAnswerValue(currentResponse.answer)}
                              sx={richContentSx}
                            />
                          ) : (
                            <Typography variant="body2">
                              {normalizeAnswerValue(currentResponse.answer) || t('common.noAnswer')}
                            </Typography>
                          )}
                        </Paper>
                      )}
                    </Box>
                  </Box>
                );
              })}
            </Box>
          )}
        </>
      )}

    </Box>
  );
}
