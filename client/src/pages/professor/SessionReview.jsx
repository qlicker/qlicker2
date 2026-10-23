import {
  useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box, Typography, Button, Paper, Alert, CircularProgress, Chip, Collapse,
  Switch, Checkbox, FormControlLabel, Table, TableBody, TableCell, TableContainer, Dialog, DialogActions, DialogContent, DialogTitle,
  TableHead, TableRow, TableSortLabel, LinearProgress, TextField, Autocomplete,
} from '@mui/material';
import {
  Download as DownloadIcon,
  Edit as EditIcon,
  Login as JoinIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  VisibilityOff as VisibilityOffIcon,
} from '@mui/icons-material';
import apiClient from '../../api/client';
import { LiveSessionWebSocketProvider, useLiveSessionWebSocket } from '../../contexts/LiveSessionWebSocketContext';
import {
  QUESTION_TYPES,
  TYPE_COLORS,
  getQuestionTypeLabel,
  buildQuestionProgressList,
  isOptionBasedQuestionType,
  isSlideType,
  normalizeQuestionType,
} from '../../components/questions/constants';
import {
  normalizeStoredHtml,
  prepareRichTextInput,
  renderKatexInElement,
} from '../../components/questions/richTextUtils';
import SessionQuestionGradingPanel from '../../components/grades/SessionQuestionGradingPanel';
import AnonymousResponsesPanel from '../../components/grades/AnonymousResponsesPanel';
import AiSummaryInstructionForm from '../../components/grades/AiSummaryInstructionForm';
import AiMarkdownContent from '../../components/ai/AiMarkdownContent';
import AiModelSelect, { parseAiModelValue } from '../../components/ai/AiModelSelect';
import SessionChatPanel from '../../components/live/SessionChatPanel';
import WordCloudPanel from '../../components/questions/WordCloudPanel';
import HistogramPanel from '../../components/questions/HistogramPanel';
import ResponseTimeline from '../../components/questions/ResponseTimeline';
import BackLinkButton from '../../components/common/BackLinkButton';
import StudentIdentity from '../../components/common/StudentIdentity';
import ResponsiveTabsNavigation from '../../components/common/ResponsiveTabsNavigation';
import { buildCourseTitle } from '../../utils/courseTitle';
import { formatCsvTimestamp, formatResponseTimestamp, getLatestResponse, sortResponsesNewestFirst } from '../../utils/responses';
import { collectResponseTimeline } from '../../utils/responseTimeline';
import { toggleSessionReviewable } from '../../utils/reviewableToggle';
import SessionGradesVisibilityControl from '../../components/common/SessionGradesVisibilityControl';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const COMPACT_CHIP_SX = {
  borderRadius: 1.4,
  '& .MuiChip-label': { px: 1.15 },
};

const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// At or below this many respondents, answers may be attributable by elimination.

const richContentSx = {
  '& p': { my: 0.5 },
  '& ul, & ol': { my: 0.5, pl: 3 },
  '& img': {
    display: 'block',
    maxWidth: '90% !important',
    height: 'auto !important',
    borderRadius: 0,
    my: 0.75,
  },
};

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

function AiSummaryControls({
  summary,
  halting,
  actionError,
  onGenerate,
  onHalt,
  onView,
  t,
}) {
  if (['queued', 'running'].includes(summary?.status)) {
    const generating = summary?.phase === 'generating';
    const progress = summary?.total ? (summary.completed || 0) / summary.total * 100 : 0;
    return (
      <Box sx={{ minWidth: 220 }}>
        <Typography variant="caption">
          {generating
            ? t('professor.sessionReview.aiSummaryGenerating')
            : t('professor.sessionReview.aiSummaryInProgress', { completed: summary?.completed || 0, total: summary?.total || 0 })}
        </Typography>
        <LinearProgress variant={generating ? 'indeterminate' : 'determinate'} value={generating ? undefined : progress} />
        <Button size="small" color="error" sx={{ mt: 0.5 }} disabled={halting} onClick={onHalt}>
          {halting ? t('professor.sessionReview.haltingAiResponseSummary') : t('professor.sessionReview.haltAiResponseSummary')}
        </Button>
      </Box>
    );
  }

  const statusMessage = summary?.status === 'halted'
    ? t('professor.sessionReview.aiSummaryHalted')
    : summary?.status === 'failed'
      ? t('professor.sessionReview.aiSummaryFailed', { error: summary.error || '' })
      : '';
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5 }}>
      {statusMessage ? <Typography variant="caption" color={summary?.status === 'failed' ? 'error' : 'text.secondary'}>{statusMessage}</Typography> : null}
      {actionError ? <Typography variant="caption" color="error">{actionError}</Typography> : null}
      <Box sx={{ display: 'flex', gap: 1 }}>
        {summary?.status === 'completed' ? <Button size="small" variant="outlined" onClick={onView}>{t('professor.sessionReview.viewAiResponseSummary')}</Button> : null}
        <Button size="small" variant="outlined" onClick={onGenerate}>{t('professor.sessionReview.generateAiResponseSummary')}</Button>
      </Box>
    </Box>
  );
}

function isCorrectOption(option) {
  const value = option?.correct;
  if (value === true || value === 1 || value === '1') return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return Boolean(value);
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

function formatParticipation(participation) {
  if (participation == null) return '—';
  const numeric = Number(participation);
  if (!Number.isFinite(numeric)) return '0%';
  return `${Math.round(numeric)}%`;
}

function formatPercent(value) {
  if (value == null) return '—';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return `${Math.round(numeric * 10) / 10}%`;
}

function summarizeUngradedMarks(grades = []) {
  const questionIds = new Set();
  const studentIds = new Set();
  let marks = 0;

  grades.forEach((grade) => {
    let studentHasUngradedMark = false;
    (grade?.marks || []).forEach((mark) => {
      if (!mark?.needsGrading) return;
      marks += 1;
      studentHasUngradedMark = true;
      if (mark?.questionId) questionIds.add(String(mark.questionId));
    });
    if (studentHasUngradedMark && grade?.userId) {
      studentIds.add(String(grade.userId));
    }
  });

  return {
    marks,
    students: studentIds.size,
    questions: questionIds.size,
  };
}

function formatJoinedAt(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(parsed);
}

function buildStudentDisplayName(student, fallbackName) {
  const first = normalizeAnswerValue(student?.firstname);
  const last = normalizeAnswerValue(student?.lastname);
  const fullName = `${first} ${last}`.trim();
  if (fullName) return fullName;
  const email = normalizeAnswerValue(student?.email);
  if (email) return email;
  return fallbackName;
}

function optionDisplayHtml(option) {
  return option?.content
    || option?.plainText
    || option?.text
    || option?.label
    || option?.value
    || option?.option
    || option?.answer
    || '';
}

function getOptionRichContentProps(option) {
  return {
    html: normalizeStoredHtml(option?.content || ''),
    fallback: option?.plainText || option?.text || option?.label || option?.value || option?.option || option?.answer || '',
  };
}

function collectAttemptNumbersForQuestion(question, studentResults = []) {
  const attemptNumbers = new Set((question?.anonymousResponseAttempts || []).map((entry) => entry.attempt));

  (question?.sessionOptions?.attempts || []).forEach((attempt) => {
    const number = Number(attempt?.number);
    if (Number.isInteger(number) && number > 0) {
      attemptNumbers.add(number);
    }
  });

  (question?.sessionOptions?.attemptStats || []).forEach((attempt) => {
    const number = Number(attempt?.number);
    if (Number.isInteger(number) && number > 0) {
      attemptNumbers.add(number);
    }
  });

  studentResults.forEach((student) => {
    const qr = (student?.questionResults || []).find(
      (result) => String(result?.questionId) === String(question?._id),
    );
    (qr?.responses || []).forEach((response) => {
      const attemptNumber = Number(response?.attempt);
      if (Number.isInteger(attemptNumber) && attemptNumber > 0) {
        attemptNumbers.add(attemptNumber);
      }
    });
  });

  const sorted = [...attemptNumbers].sort((a, b) => a - b);
  if (sorted.length === 0) sorted.push(1);
  return sorted;
}

function collectAnswerEntries(answer) {
  if (answer === undefined || answer === null) return [];
  if (Array.isArray(answer)) return answer;
  if (typeof answer === 'string') {
    const trimmed = answer.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Fall back to scalar interpretation.
      }
    }
    if (trimmed.includes(',') && !/<[^>]*>/.test(trimmed)) {
      return trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return [answer];
}

function isLatestResponseCorrect(question, response) {
  if (!question || !response) return null;
  if (typeof response.correct === 'boolean') return response.correct;

  const score = Number(response?.mark ?? response?.points);
  if (Number.isFinite(score)) {
    return score > 0;
  }

  const qType = normalizeQuestionType(question);
  const options = Array.isArray(question.options) ? question.options : [];

  if (
    [QUESTION_TYPES.MULTIPLE_CHOICE, QUESTION_TYPES.TRUE_FALSE, QUESTION_TYPES.MULTI_SELECT].includes(qType)
  ) {
    if (!options.length) return null;

    const correctIndices = options.reduce((acc, option, idx) => {
      if (isCorrectOption(option)) acc.push(idx);
      return acc;
    }, []);
    if (!correctIndices.length) return null;

    const selectedIndices = [...new Set(
      collectAnswerEntries(response.answer)
        .map((entry) => resolveOptionIndex(entry, options))
        .filter((idx) => idx >= 0 && idx < options.length),
    )];

    if (selectedIndices.length !== correctIndices.length) return false;
    return selectedIndices.every((idx) => correctIndices.includes(idx));
  }

  if (qType === QUESTION_TYPES.NUMERICAL) {
    const expected = Number(question.correctNumerical);
    if (!Number.isFinite(expected)) return null;

    const toleranceRaw = Number(question.toleranceNumerical ?? 0);
    const tolerance = Number.isFinite(toleranceRaw) ? Math.abs(toleranceRaw) : 0;
    const actual = Number(response.answer);
    if (!Number.isFinite(actual)) return false;
    return Math.abs(actual - expected) <= tolerance;
  }

  return null;
}

function escapeCsvCell(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildGradesByStudentId(grades = []) {
  return Object.fromEntries(
    (grades || [])
      .filter((grade) => grade?.userId)
      .map((grade) => [String(grade.userId), grade])
  );
}

function getStudentQuestionPoints(gradesByStudentId = {}, studentId, questionId) {
  const grade = gradesByStudentId[String(studentId)];
  const mark = (grade?.marks || []).find((entry) => String(entry?.questionId) === String(questionId));
  if (mark?.points === undefined || mark.points === null || mark.points === '') return null;
  const points = Number(mark.points);
  return Number.isFinite(points) ? points : null;
}

function formatAnswerText(question, answer, t) {
  let answerText = answer ?? '';
  const normType = normalizeQuestionType(question);

  if (
    [QUESTION_TYPES.MULTIPLE_CHOICE, QUESTION_TYPES.TRUE_FALSE, QUESTION_TYPES.MULTI_SELECT]
      .includes(normType) && question.options
  ) {
    answerText = collectAnswerEntries(answerText)
      .map((entry) => {
        const idx = resolveOptionIndex(entry, question.options);
        if (idx < 0) return entry;
        if (normType === QUESTION_TYPES.TRUE_FALSE) {
          const option = question.options[idx];
          const label = normalizeComparableText(option?.plainText || option?.content || option?.answer);
          return label === 'true' || label === 'false'
            ? t(`questions.editor.${label}`)
            : label || t(idx === 0 ? 'questions.editor.true' : 'questions.editor.false');
        }
        return OPTION_LETTERS[idx];
      })
      .join(', ');
  } else if (answerText && typeof answerText === 'object') {
    try {
      answerText = JSON.stringify(answerText);
    } catch {
      answerText = String(answerText);
    }
  }

  return String(answerText || '');
}

export function buildSessionResultsCsv({
  anonymous = false,
  ungraded = false,
  includeResponseTimestamps = false,
  csvQuestionAttempts,
  gradesByStudentId,
  sessionName,
  studentResults,
  visibleStudents = [],
  t,
}) {
  const orderedStudents = visibleStudents.length > 0
    ? visibleStudents
    : studentResults;
  if (!csvQuestionAttempts.length || !orderedStudents.length) return null;
  const includeTimes = includeResponseTimestamps && !anonymous;

  const studentResultsById = new Map(
    studentResults.map((student) => [String(student?.studentId || ''), student]),
  );

  const answersWithheld = anonymous && csvQuestionAttempts.some(({ question }) => (
    question.anonymousResponseAttempts?.some((entry) => entry.responsesWithheld)
  ));

  const headers = anonymous
    ? [
      t('professor.sessionReview.respondent'),
      t('professor.sessionReview.csvParticipation'),
      t('professor.sessionReview.percentCorrect'),
    ]
    : [
      t('professor.sessionReview.csvLastName'),
      t('professor.sessionReview.csvFirstName'),
      t('professor.sessionReview.csvEmail'),
      ...(!ungraded ? [t('professor.sessionReview.grade')] : []),
      t('professor.sessionReview.inSession'),
      t('professor.sessionReview.csvParticipation'),
      t('professor.sessionReview.percentCorrect'),
      t('professor.sessionReview.joinedSession'),
    ];
  csvQuestionAttempts.forEach(({ questionNumber, attempts }) => {
    if (attempts.length <= 1) {
      headers.push(t('professor.sessionReview.csvResponse', { number: questionNumber }));
      headers.push(t('professor.sessionReview.csvPoints', { number: questionNumber }));
      if (includeTimes) headers.push(t('professor.sessionReview.csvTime', { number: questionNumber }));
      return;
    }
    attempts.forEach((attemptNumber) => {
      headers.push(t('professor.sessionReview.csvAttemptResponse', { number: questionNumber, attempt: attemptNumber }));
      headers.push(t('professor.sessionReview.csvAttemptPoints', { number: questionNumber, attempt: attemptNumber }));
      if (includeTimes) headers.push(t('professor.sessionReview.csvAttemptTime', { number: questionNumber, attempt: attemptNumber }));
    });
  });

  const rows = orderedStudents.map((visibleStudent) => {
    const student = studentResultsById.get(String(visibleStudent?.studentId || ''));
    if (!student) return null;
    const questionResultsById = new Map(
      (student.questionResults || []).map((result) => [String(result.questionId), result]),
    );
    const gradeValue = gradesByStudentId[String(student.studentId)]?.value;

    const row = anonymous
      ? [
        escapeCsvCell(student.firstname),
        escapeCsvCell(formatParticipation(answersWithheld ? null : student.participation)),
        escapeCsvCell(formatPercent(answersWithheld ? null : visibleStudent?.percentCorrectValue)),
      ]
      : [
        escapeCsvCell(student.lastname),
        escapeCsvCell(student.firstname),
        escapeCsvCell(student.email),
        ...(!ungraded ? [escapeCsvCell(student.guest ? t('professor.sessionReview.guestNoGrade') : formatPercent(gradeValue))] : []),
        escapeCsvCell(student.inSession ? t('common.yes') : t('common.no')),
        escapeCsvCell(formatParticipation(student.participation)),
        escapeCsvCell(formatPercent(visibleStudent?.percentCorrectValue)),
        escapeCsvCell(formatCsvTimestamp(student.joinedAt)),
      ];

    csvQuestionAttempts.forEach(({ question, attempts }) => {
      const qr = questionResultsById.get(String(question._id));
      const responsesByAttempt = new Map();
      (qr?.responses || []).forEach((response) => {
        const attemptNumber = Number(response?.attempt);
        const normalizedAttempt = Number.isInteger(attemptNumber) && attemptNumber > 0 ? attemptNumber : 1;
        const current = responsesByAttempt.get(normalizedAttempt);
        if (!current) {
          responsesByAttempt.set(normalizedAttempt, response);
          return;
        }
        responsesByAttempt.set(normalizedAttempt, getLatestResponse([current, response]));
      });

      attempts.forEach((attemptNumber) => {
        const release = question.anonymousResponseAttempts?.find((entry) => entry.attempt === attemptNumber);
        if (anonymous && release?.responsesWithheld) {
          row.push(escapeCsvCell(t('professor.sessionReview.anonymousAnswersHidden', { minimum: release.minimumRespondents })));
          row.push('');
          return;
        }
        const attemptResponse = responsesByAttempt.get(attemptNumber);
        if (!attemptResponse) {
          row.push(escapeCsvCell(''));
          row.push(escapeCsvCell(''));
          if (includeTimes) row.push('');
          return;
        }

        const answerText = formatAnswerText(question, attemptResponse?.answer, t);
        const points = getStudentQuestionPoints(
          gradesByStudentId,
          student.studentId,
          question._id
        );

        row.push(escapeCsvCell(answerText));
        row.push(escapeCsvCell(points ?? ''));
        if (includeTimes) row.push(escapeCsvCell(formatResponseTimestamp(attemptResponse)));
      });
    });

    return row.join(',');
  }).filter(Boolean);

  return {
    csvContent: [headers.map(escapeCsvCell).join(','), ...rows].join('\n'),
    filename: `${(sessionName || 'session').replace(/[^a-zA-Z0-9]/g, '_')}_results.csv`,
  };
}

function downloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Renders rich-text content with KaTeX math support. */
function RichContent({ html, fallback, allowVideoEmbeds = false }) {
  const ref = useRef(null);
  const prepared = prepareRichTextInput(
    html || '',
    fallback || '',
    { allowVideoEmbeds }
  );
  const innerHtml = useMemo(() => ({ __html: prepared }), [prepared]);

  useLayoutEffect(() => {
    if (ref.current) renderKatexInElement(ref.current);
  }, [prepared]);

  if (!prepared) return null;
  return (
    <Box
      ref={ref}
      sx={richContentSx}
      dangerouslySetInnerHTML={innerHtml}
    />
  );
}

/** Tab panel helper. */
function TabPanel({ children, value, index }) {
  return value === index ? <Box sx={{ pt: 3 }}>{children}</Box> : null;
}

/** Meteor-style inline response bars for MC/MS/TF (options as bars). */
function DistributionBars({
  data, highlightCorrect, correctIndices, options, responseCount,
}) {
  const { t } = useTranslation();
  if (!data || !data.length) {
    return (
      <Typography variant="body2" sx={{
        color: "text.secondary"
      }}>{t('professor.sessionReview.noResponsesYet')}</Typography>
    );
  }
  const total = Number(responseCount) > 0
    ? Number(responseCount)
    : data.reduce((sum, d) => sum + d.count, 0);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {data.map((item, i) => {
        const pct = total > 0 ? Math.round(100 * item.count / total) : 0;
        const isCorrect = highlightCorrect && correctIndices?.includes(i);
        const barColor = isCorrect ? 'success.main' : !highlightCorrect || !correctIndices?.length ? 'primary.main' : 'error.light';
        const optionContent = getOptionRichContentProps(options?.[i]);
        return (
          <Box key={i}>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: '30px minmax(0, 1fr) 72px',
                columnGap: 1,
                alignItems: 'start',
                mb: 0.25,
              }}
            >
              <Chip
                label={item.label}
                size="small"
                color={isCorrect ? 'success' : 'default'}
                sx={{ ...COMPACT_CHIP_SX, fontWeight: 700, minWidth: 28, justifySelf: 'start' }}
              />
              <Box sx={{ minWidth: 0 }}>
                <RichContent
                  html={optionContent.html}
                  fallback={optionContent.fallback}
                />
              </Box>
              <Typography variant="body2" sx={{ fontWeight: 700, minWidth: 56, textAlign: 'right' }}>
                {pct}% ({item.count})
              </Typography>
            </Box>
            <LinearProgress
              variant="determinate"
              value={pct}
              sx={{
                height: 8,
                borderRadius: 1,
                bgcolor: 'grey.200',
                '& .MuiLinearProgress-bar': { bgcolor: barColor, borderRadius: 1 },
              }}
            />
          </Box>
        );
      })}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

// Refresh quiz results on submission/status events, never on each autosave.
// Coalesce a submission burst and serialize requests to avoid stale snapshots.
function QuizReviewUpdates({ onRefresh, refreshAt }) {
  const { subscribe, registerRefreshHandler } = useLiveSessionWebSocket();
  useEffect(() => {
    let timer = null;
    let inFlight = false;
    let pending = false;
    let fullRefresh = false;
    let stopped = false;
    const schedule = (full = false) => {
      if (stopped) return;
      pending = true;
      fullRefresh ||= full;
      // Keep a busy submission stream below the results endpoint’s 30/min limit.
      if (timer === null && !inFlight) timer = window.setTimeout(run, 2500);
    };
    const run = async () => {
      timer = null;
      pending = false;
      inFlight = true;
      const resultsOnly = !fullRefresh;
      fullRefresh = false;
      try {
        await onRefresh({ resultsOnly });
      } finally {
        inFlight = false;
        if (pending) schedule();
      }
    };
    const unsubscribe = subscribe(({ event }) => {
      if (event === 'session:quiz-submitted') schedule();
      if (event === 'session:status-changed' || event === 'session:metadata-changed') schedule(true);
    });
    const unregister = registerRefreshHandler(() => schedule(true));
    const deadlineTimer = Number.isFinite(refreshAt)
      ? window.setTimeout(() => schedule(true), Math.min(2147483647, Math.max(1000, refreshAt - Date.now() + 100)))
      : null;
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearTimeout(deadlineTimer);
      unsubscribe();
      unregister();
    };
  }, [onRefresh, refreshAt, subscribe, registerRefreshHandler]);
  return null;
}

export default function SessionReview() {
  const { courseId, sessionId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [course, setCourse] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [rawStudentResults, setStudentResults] = useState([]);
  const [anonymousSummary, setAnonymousSummary] = useState(null);
  const [quizResultsRefreshAt, setQuizResultsRefreshAt] = useState(null);
  const [chatPosts, setChatPosts] = useState([]);
  const [tab, setTab] = useState(0);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [includeResponseTimestamps, setIncludeResponseTimestamps] = useState(false);
  const [togglingReviewable, setTogglingReviewable] = useState(false);
  const [reviewableWarning, setReviewableWarning] = useState('');
  const [gradingNeedsSummary, setGradingNeedsSummary] = useState({ marks: 0, students: 0, questions: 0 });
  const [studentSort, setStudentSort] = useState({ field: 'name', direction: 'asc' });
  const [studentSearch, setStudentSearch] = useState('');
  const [gradesByStudentId, setGradesByStudentId] = useState({});
  const [groupCategories, setGroupCategories] = useState([]);
  const [selectedCatIdx, setSelectedCatIdx] = useState(-1);
  const [selectedGroupIdx, setSelectedGroupIdx] = useState(-1);
  const [expandedSARows, setExpandedSARows] = useState({});
  const [expandedNURows, setExpandedNURows] = useState({});
  const [wordCloudByRow, setWordCloudByRow] = useState({});
  const [histogramByRow, setHistogramByRow] = useState({});
  const [aiSummaries, setAiSummaries] = useState({});
  const [summaryQuestion, setSummaryQuestion] = useState(null);
  const [summaryInstructions, setSummaryInstructions] = useState([]);
  const [summaryInstructionId, setSummaryInstructionId] = useState('basic-summary');
  const [summaryInstructionEditing, setSummaryInstructionEditing] = useState(false);
  const summaryInstruction = summaryInstructions.find((entry) => entry._id === summaryInstructionId)?.content || '';
  const [summaryModel, setSummaryModel] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const [summaryView, setSummaryView] = useState(null);
  const [haltingSummaryIds, setHaltingSummaryIds] = useState({});
  const [summaryActionErrors, setSummaryActionErrors] = useState({});
  const requestedReturnTab = Number.parseInt(searchParams.get('returnTab') || '', 10);
  const resolvedReturnTab = Number.isInteger(requestedReturnTab) && requestedReturnTab >= 0 ? requestedReturnTab : 0;
  const backToCoursePath = resolvedReturnTab > 0
    ? `/prof/course/${courseId}?tab=${resolvedReturnTab}`
    : `/prof/course/${courseId}`;
  const editSessionParams = new URLSearchParams();
  if (resolvedReturnTab > 0) {
    editSessionParams.set('returnTab', String(resolvedReturnTab));
  }
  editSessionParams.set('returnTo', 'review');
  const editSessionPath = `/prof/course/${courseId}/session/${sessionId}?${editSessionParams.toString()}`;
  const anonymousSession = !!session?.anonymous;
  const ungradedSession = anonymousSession;
  // Anonymous results arrive without identities; give each respondent a
  // generic, stable label so the table, CSV, and charts stay readable.
  const studentResults = useMemo(() => (anonymousSession
    ? rawStudentResults.map((student) => ({
      ...student,
      firstname: t('professor.sessionReview.respondentLabel', { number: student.anonymousIndex }),
    }))
    : rawStudentResults), [anonymousSession, rawStudentResults, t]);

  // ---- Data fetching ----

  const fetchResults = useCallback(async ({ resultsOnly = false } = {}) => {
    try {
      const [{ data }, courseResponse] = await Promise.all([
        apiClient.get(`/sessions/${sessionId}/results`),
        resultsOnly ? Promise.resolve(null) : apiClient.get(`/courses/${courseId}`).catch(() => ({ data: null })),
      ]);
      setSession(data.session);
      if (!resultsOnly) {
        setCourse(courseResponse?.data?.course || courseResponse?.data || null);
        setQuestions(data.questions || []);
      }
      setStudentResults(data.studentResults || []);
      setAnonymousSummary(data.anonymousSummary || null);
      setQuizResultsRefreshAt(data.quizResultsRefreshAt ?? null);
      setChatPosts(data.chatPosts || []);
      if (data.session?.quiz) {
        setWordCloudByRow({});
        setHistogramByRow({});
      }
      if (resultsOnly) {
        setError(null);
        return;
      }

      if (data.session?.anonymous) {
        // Anonymous sessions never have grades.
        setGradesByStudentId({});
        setGradingNeedsSummary({ marks: 0, students: 0, questions: 0 });
        setError(null);
        return;
      }

      try {
        const gradesRes = await apiClient.get(`/sessions/${sessionId}/grades`);
        const grades = gradesRes.data?.grades || [];
        const summary = summarizeUngradedMarks(grades);
        setGradesByStudentId(buildGradesByStudentId(grades));
        setGradingNeedsSummary(summary);
      } catch {
        setGradesByStudentId({});
        setGradingNeedsSummary({ marks: 0, students: 0, questions: 0 });
      }

      setError(null);
    } catch (err) {
      const msg = err.response?.data?.message || t('professor.sessionReview.failedToLoadResults');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [courseId, sessionId, t]);

  useEffect(() => {
    if (!questions.length) return undefined;
    let mounted = true;
    const shortAnswerQuestions = questions.filter((question) => (
      normalizeQuestionType(question) === QUESTION_TYPES.SHORT_ANSWER
    ));
    const questionIds = shortAnswerQuestions.map((question) => String(question._id));
    apiClient.get(`/ai/courses/${courseId}/sessions/${sessionId}/ai-summaries`, {
      params: { questionIds: questionIds.join(',') },
    }).then(({ data }) => {
      if (!mounted) return;
      const byQuestionId = Object.fromEntries(
        (data.summaries || []).map((summary) => [String(summary.questionId), summary])
      );
      setAiSummaries(Object.fromEntries(questionIds.map((questionId) => [
        questionId,
        byQuestionId[questionId] || null,
      ])));
    }).catch(() => {
      if (mounted) setAiSummaries(Object.fromEntries(questionIds.map((questionId) => [questionId, null])));
    });
    return () => { mounted = false; };
  }, [courseId, sessionId, questions]);

  const activeSummaryQuestionIds = useMemo(() => Object.entries(aiSummaries)
    .filter(([, summary]) => ['queued', 'running'].includes(summary?.status))
    .map(([questionId]) => questionId)
    .sort(), [aiSummaries]);
  const activeSummaryQuestionKey = activeSummaryQuestionIds.join(',');

  useEffect(() => {
    if (!activeSummaryQuestionKey) return undefined;
    const pollingQuestionIds = activeSummaryQuestionKey.split(',').filter(Boolean);
    let mounted = true;
    let requestInFlight = false;
    const loadActive = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const { data } = await apiClient.get(`/ai/courses/${courseId}/sessions/${sessionId}/ai-summaries`, {
          params: { questionIds: pollingQuestionIds.join(',') },
        });
        const entries = (data.summaries || []).map((summary) => [String(summary.questionId), summary]);
        if (mounted) {
          setAiSummaries((current) => ({
            ...current,
            ...Object.fromEntries(entries.filter(Boolean)),
          }));
        }
      } catch {
        // A later poll can recover from a transient request failure.
      } finally {
        requestInFlight = false;
      }
    };
    const timer = window.setInterval(loadActive, 2500);
    return () => { mounted = false; window.clearInterval(timer); };
  }, [activeSummaryQuestionKey, courseId, sessionId]);

  useEffect(() => {
    if (!summaryQuestion) return;
    let active = true;
    setSummaryError('');
    apiClient.get(`/ai/courses/${courseId}/grading-instructions`)
      .then(({ data }) => {
        if (!active) return;
        const instructions = data.instructions || [];
        const basicSummary = instructions.find((entry) => entry._id === 'basic-summary');
        setSummaryInstructions(instructions);
        setSummaryInstructionId((current) => instructions.some((entry) => entry._id === current)
          ? current : basicSummary?._id || '');
      })
      .catch((err) => {
        if (active) setSummaryError(err.response?.data?.message || t('grades.aiGrading.failedLoad'));
      });
    return () => { active = false; };
  }, [summaryQuestion, courseId, t]);

  const saveSummaryInstruction = async (instruction) => {
    const { data } = await apiClient.post(`/ai/courses/${courseId}/grading-instructions`, instruction);
    setSummaryInstructions((current) => [...current.filter((entry) => entry._id !== data.instruction._id), data.instruction]);
    return data.instruction;
  };

  const deleteSummaryInstruction = async (instruction) => {
    await apiClient.delete(`/ai/courses/${courseId}/grading-instructions/${instruction._id}`);
    setSummaryInstructions((current) => current.filter((entry) => entry._id !== instruction._id));
    if (summaryInstructionId === instruction._id) {
      const basicSummary = summaryInstructions.find((entry) => entry._id === 'basic-summary');
      setSummaryInstructionId(basicSummary?._id || '');
    }
  };

  const startSummary = async () => {
    if (summaryInstructionEditing || !summaryInstruction.trim()) return;
    setSummaryError('');
    try {
      const { data } = await apiClient.post(`/ai/courses/${courseId}/sessions/${sessionId}/questions/${summaryQuestion._id}/ai-summary`, {
        instruction: summaryInstruction,
        ...parseAiModelValue(summaryModel),
      });
      setAiSummaries((current) => ({ ...current, [summaryQuestion._id]: data.summary }));
      setSummaryQuestion(null);
    } catch (err) {
      setSummaryError(err.response?.data?.message || t('grades.aiGrading.failedStart'));
    }
  };

  const haltSummary = async (questionId) => {
    setHaltingSummaryIds((current) => ({ ...current, [questionId]: true }));
    setSummaryActionErrors((current) => ({ ...current, [questionId]: '' }));
    try {
      const { data } = await apiClient.post(`/ai/courses/${courseId}/sessions/${sessionId}/questions/${questionId}/ai-summary/halt`);
      setAiSummaries((current) => ({ ...current, [questionId]: data.summary }));
    } catch (err) {
      setSummaryActionErrors((current) => ({
        ...current,
        [questionId]: err.response?.data?.message || t('professor.sessionReview.aiSummaryHaltFailed'),
      }));
    } finally {
      setHaltingSummaryIds((current) => ({ ...current, [questionId]: false }));
    }
  };

  useEffect(() => { fetchResults(); }, [fetchResults]);

  // ---- Fetch group categories for filtering ----
  useEffect(() => {
    if (!courseId) return;
    apiClient.get(`/courses/${courseId}/groups`)
      .then(({ data }) => setGroupCategories(data.groupCategories || []))
      .catch(() => setGroupCategories([]));
  }, [courseId]);

  // ---- Toggle reviewable ----

  const handleToggleReviewable = useCallback(async (checked, gradesOnly = false) => {
    setTogglingReviewable(true);
    try {
      const data = gradesOnly
        ? (await apiClient.patch(`/sessions/${sessionId}/grades/visibility`, { visibleToStudents: checked })).data
        : await toggleSessionReviewable({
          apiClient,
          sessionId,
          reviewable: checked,
        });
      const updatedSession = data.session || data;
      const warnings = data.grading?.warnings || [];
      setSession((prev) => (prev ? { ...prev, ...updatedSession } : prev));
      setReviewableWarning(warnings.join(' '));
    } catch (err) {
      setReviewableWarning(err.response?.data?.message || t(gradesOnly ? 'grades.visibility.failed' : 'professor.sessionReview.failedToUpdateReviewable'));
    } finally {
      setTogglingReviewable(false);
    }
  }, [sessionId, t]);

  // ---- Summary stats ----

  const totalQuestions = questions.length;
  const progressList = useMemo(() => buildQuestionProgressList(questions), [questions]);
  const totalStudents = studentResults.length;
  const courseTitle = course?._id ? buildCourseTitle(course, 'long') : '';
  const courseSection = normalizeAnswerValue(course?.section);
  const joinedStudents = useMemo(() => {
    return studentResults.filter((student) => !!student?.inSession).length;
  }, [studentResults]);

  const hasOutstandingManualGrading = gradingNeedsSummary.marks > 0;
  const liveInteractiveSession = session?.status === 'running' && !session?.quiz && !session?.practiceQuiz;
  const sessionChatAvailable = !!session?.chatEnabled || chatPosts.length > 0;

  // ---- Group-filtered student results for grading tab ----
  const selectedGroupCat = groupCategories[selectedCatIdx] || null;
  const selectedGroupObj = selectedGroupCat ? (selectedGroupCat.groups || [])[selectedGroupIdx] : null;
  const groupFilteredStudentResults = useMemo(() => {
    const gradeableResults = session?.activityEverShared
      ? studentResults.filter((student) => !student.guest)
      : studentResults;
    if (!selectedGroupObj) return gradeableResults;
    const memberSet = new Set(selectedGroupObj.members || []);
    return gradeableResults.filter((s) => memberSet.has(s.studentId));
  }, [studentResults, selectedGroupObj, session?.activityEverShared]);

  const handleUngradedSummaryChange = useCallback((summary) => {
    if (!summary || typeof summary !== 'object') return;
    setGradingNeedsSummary({
      marks: Number(summary.marks) || 0,
      students: Number(summary.students) || 0,
      questions: Number(summary.questions) || 0,
    });
  }, []);

  const toggleSARow = useCallback((rowKey) => {
    setExpandedSARows((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }));
  }, []);

  const toggleNURow = useCallback((rowKey) => {
    setExpandedNURows((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }));
  }, []);

  const handleGenerateWordCloudForQuestion = useCallback(async (questionId, rowKey) => {
    const stopWords = t('stopWords', { returnObjects: true });
    const payload = Array.isArray(stopWords) ? { stopWords } : {};
    try {
      const res = await apiClient.post(`/questions/${questionId}/word-cloud`, payload);
      if (res.data?.wordCloudData) {
        setWordCloudByRow((prev) => ({ ...prev, [rowKey]: res.data.wordCloudData }));
      }
    } catch {
      // silently fail — user can retry
    }
  }, [t]);

  const handleGenerateHistogramForQuestion = useCallback(async (questionId, rowKey, opts = {}) => {
    try {
      const res = await apiClient.post(`/questions/${questionId}/histogram`, opts);
      if (res.data?.histogramData) {
        setHistogramByRow((prev) => ({ ...prev, [rowKey]: res.data.histogramData }));
      }
    } catch {
      // silently fail — user can retry
    }
  }, []);

  // ---- Stats data for ALL questions / attempts ----

  const studentNameById = useMemo(() => {
    const names = new Map();
    studentResults.forEach((student) => {
      names.set(
        String(student?.studentId || ''),
        buildStudentDisplayName(student, t('professor.sessionReview.unknownStudent'))
      );
    });
    return names;
  }, [studentResults, t]);

  const questionAttemptRows = useMemo(() => questions.flatMap((q, qi) => {
    const qType = normalizeQuestionType(q);
    const isOptionType = isOptionBasedQuestionType(qType) || qType === QUESTION_TYPES.TRUE_FALSE;

    const responsesByAttempt = new Map();
    const attemptNumbers = new Set(collectAttemptNumbersForQuestion(q, studentResults));
    const attemptStatsByNumber = new Map(
      (q?.sessionOptions?.attemptStats || [])
        .map((attempt) => [Number(attempt?.number), attempt])
        .filter(([number]) => Number.isInteger(number) && number > 0)
    );

    studentResults.forEach((student) => {
      const qr = (student.questionResults || []).find(
        (result) => String(result.questionId) === String(q._id),
      );
      if (!qr?.responses?.length) return;
      const studentName = buildStudentDisplayName(student, t('professor.sessionReview.unknownStudent'));

      qr.responses.forEach((response) => {
        const attemptNumber = Number(response?.attempt);
        const normalizedAttempt = Number.isInteger(attemptNumber) && attemptNumber > 0 ? attemptNumber : 1;
        attemptNumbers.add(normalizedAttempt);
        if (!responsesByAttempt.has(normalizedAttempt)) {
          responsesByAttempt.set(normalizedAttempt, []);
        }
        responsesByAttempt.get(normalizedAttempt).push({
          ...response,
          studentName,
        });
      });
    });

    const sortedAttempts = [...new Set([
      ...attemptNumbers,
      ...attemptStatsByNumber.keys(),
    ])].sort((a, b) => a - b);

    const correctIndices = (q.options || []).reduce((acc, option, idx) => {
      if (isCorrectOption(option)) acc.push(idx);
      return acc;
    }, []);

    return sortedAttempts.map((attemptNumber, attemptIndex) => {
      const release = q.anonymousResponseAttempts?.find((entry) => entry.attempt === attemptNumber);
      const cachedAttemptStats = attemptStatsByNumber.get(attemptNumber) || null;
      const attemptResponses = responsesByAttempt.get(attemptNumber) || [];
      const distribution = isOptionType && q.options ? q.options.map((_, optionIndex) => {
        const cachedEntry = Array.isArray(cachedAttemptStats?.distribution)
          ? cachedAttemptStats.distribution.find((entry) => Number(entry?.index) === optionIndex)
          : null;
        return Number(cachedEntry?.count || 0);
      }) : [];

      if (!cachedAttemptStats && isOptionType && q.options) {
        attemptResponses.forEach((response) => {
          const answer = response?.answer;
          if (answer === undefined || answer === null || answer === '') return;
          const answers = Array.isArray(answer) ? answer : [answer];
          answers
            .filter((entry) => entry !== undefined && entry !== null && !(typeof entry === 'string' && entry.trim() === ''))
            .forEach((entry) => {
              const idx = resolveOptionIndex(entry, q.options);
              if (idx >= 0 && idx < distribution.length) distribution[idx] += 1;
            });
        });
      }

      const chartData = isOptionType && q.options
        ? q.options.map((_, idx) => ({
          label: OPTION_LETTERS[idx] || String(idx + 1),
          count: distribution[idx] || 0,
        }))
        : null;

      const saResponses = qType === QUESTION_TYPES.SHORT_ANSWER
        ? sortResponsesNewestFirst(
          Array.isArray(cachedAttemptStats?.answers) && cachedAttemptStats.answers.length > 0
            ? cachedAttemptStats.answers.map((response) => ({
              answer: response?.answer,
              answerWysiwyg: response?.answerWysiwyg,
              createdAt: response?.createdAt,
              updatedAt: response?.updatedAt,
              studentName: studentNameById.get(String(response?.studentUserId || '')) || t('professor.sessionReview.unknownStudent'),
            }))
            : attemptResponses.map((response) => ({
              answer: response?.answer,
              answerWysiwyg: response?.answerWysiwyg,
              createdAt: response?.createdAt,
              updatedAt: response?.updatedAt,
              studentName: response?.studentName || t('professor.sessionReview.unknownStudent'),
            }))
        )
        : null;

      const nuResponses = qType === QUESTION_TYPES.NUMERICAL
        ? (
          Array.isArray(cachedAttemptStats?.answers) && cachedAttemptStats.answers.length > 0
            ? cachedAttemptStats.answers.map((response) => ({
              answer: response?.answer,
              studentName: studentNameById.get(String(response?.studentUserId || '')) || t('professor.sessionReview.unknownStudent'),
            }))
            : attemptResponses.map((response) => ({
              answer: response?.answer,
              studentName: response?.studentName || t('professor.sessionReview.unknownStudent'),
            }))
        )
        : null;

      return {
        key: `${String(q._id || qi)}-attempt-${attemptNumber}`,
        question: q,
        questionNumber: qi + 1,
        progress: progressList[qi] || null,
        attemptNumber,
        attemptIndex: attemptIndex + 1,
        attemptTotal: sortedAttempts.length,
        qType,
        isOptionType,
        chartData: release?.responsesWithheld ? null : chartData,
        responsesWithheld: !!release?.responsesWithheld,
        minimumRespondents: release?.minimumRespondents,
        correctIndices,
        responseCount: release?.respondentCount ?? (cachedAttemptStats ? Number(cachedAttemptStats.total || 0) : attemptResponses.length),
        timeline: !anonymousSession && !isSlideType(qType) ? collectResponseTimeline(attemptResponses) : null,
        saResponses,
        nuResponses,
      };
    });
  }), [anonymousSession, progressList, questions, studentNameById, studentResults, t]);

  const sessionTimeline = useMemo(() => {
    if (anonymousSession) return null;
    const timestamps = [];
    let missingCount = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const { timeline } of questionAttemptRows) {
      if (!timeline) continue;
      for (const timestamp of timeline.timestamps) timestamps.push(timestamp);
      missingCount += timeline.missingCount;
      if (timeline.range) {
        min = Math.min(min, timeline.range.min);
        max = Math.max(max, timeline.range.max);
      }
    }
    return { timestamps, missingCount, range: timestamps.length ? { min, max } : null };
  }, [anonymousSession, questionAttemptRows]);

  const csvQuestionAttempts = useMemo(() => questions.map((question, questionIndex) => ({
    question,
    questionNumber: questionIndex + 1,
    attempts: collectAttemptNumbersForQuestion(question, studentResults),
  })), [questions, studentResults]);

  const responseDataColumns = useMemo(() => csvQuestionAttempts.flatMap(({ question, questionNumber, attempts }) => (
    (anonymousSession ? attempts : [null]).map((attempt) => ({
      key: anonymousSession ? `${question._id}:${attempt}` : String(question._id),
      question,
      attempt,
      label: anonymousSession && attempts.length > 1
        ? t('professor.sessionReview.csvAttemptResponse', { number: questionNumber, attempt })
        : t('grades.coursePanel.questionShort', { index: questionNumber }),
      release: question.anonymousResponseAttempts?.find((entry) => entry.attempt === attempt),
    }))
  )), [anonymousSession, csvQuestionAttempts, t]);

  const studentsTabRows = useMemo(() => studentResults.map((student) => {
    const questionResultsById = new Map(
      (student.questionResults || []).map((result) => [String(result.questionId), result]),
    );

    let gradedCount = 0;
    let correctCount = 0;
    const questionCells = {};
    responseDataColumns.forEach(({ question, attempt, key, release }) => {
      const qr = questionResultsById.get(String(question._id));
      const responses = qr?.responses || [];
      const latestResponse = getLatestResponse(attempt === null ? responses : responses.filter((response) => (Number(response.attempt) || 1) === attempt));
      const responseDisplay = latestResponse ? (formatAnswerText(question, latestResponse?.answer, t) || '—') : '—';
      const responsePoints = getStudentQuestionPoints(gradesByStudentId, student.studentId, question._id);
      questionCells[key] = {
        display: release?.responsesWithheld
          ? t('professor.sessionReview.anonymousAnswersHidden', { minimum: release.minimumRespondents })
          : responseDisplay,
        sortDisplay: normalizeComparableText(responseDisplay),
        pointsValue: responsePoints,
        hasResponse: !!latestResponse,
      };
    });
    questions.forEach((question) => {
      const latestResponse = getLatestResponse(questionResultsById.get(String(question._id))?.responses || []);
      if (!latestResponse) return;
      const correct = isLatestResponseCorrect(question, latestResponse);
      if (correct === null) return;
      gradedCount += 1;
      if (correct) correctCount += 1;
    });

    const first = normalizeAnswerValue(student.firstname);
    const last = normalizeAnswerValue(student.lastname);
    const fullName = `${first} ${last}`.trim();
    const displayName = fullName || student.email || t('professor.sessionReview.unknownStudent');
    const joinedAtMillis = student.joinedAt ? new Date(student.joinedAt).getTime() : NaN;
    const gradeValue = Number(gradesByStudentId[String(student.studentId)]?.value);

    return {
      ...student,
      displayName,
      avatarSrc: student.profileThumbnail || student.profileImage || '',
      // Respondent labels sort numerically rather than as text.
      sortLastName: anonymousSession ? String(student.anonymousIndex || 0).padStart(8, '0') : last,
      sortFirstName: first,
      sortEmail: normalizeAnswerValue(student.email),
      inSessionValue: student.inSession ? 1 : 0,
      gradeValue: Number.isFinite(gradeValue) ? gradeValue : null,
      participationValue: student.participation == null ? null : Number(student.participation) || 0,
      percentCorrectValue: !(anonymousSession && anonymousSummary?.responsesWithheld) && gradedCount > 0 ? Math.round((1000 * correctCount) / gradedCount) / 10 : null,
      joinedAtValue: Number.isFinite(joinedAtMillis) ? joinedAtMillis : null,
      questionCells,
    };
  }), [anonymousSession, anonymousSummary, gradesByStudentId, questions, responseDataColumns, studentResults, t]);

  const handleStudentsSort = useCallback((field) => {
    setStudentSort((prev) => {
      if (prev.field === field) {
        return {
          field,
          direction: prev.direction === 'asc' ? 'desc' : 'asc',
        };
      }
      const defaultDirection = ['grade', 'participation', 'percentCorrect'].includes(field) ? 'desc' : 'asc';
      return { field, direction: defaultDirection };
    });
  }, []);

  const sortedStudentsTabRows = useMemo(() => {
    const compareNullableNumber = (a, b) => {
      const aFinite = Number.isFinite(a);
      const bFinite = Number.isFinite(b);
      if (!aFinite && !bFinite) return 0;
      if (!aFinite) return 1;
      if (!bFinite) return -1;
      return a - b;
    };
    const compareQuestionCell = (a, b) => {
      if (!a?.hasResponse && !b?.hasResponse) return 0;
      if (!a?.hasResponse) return 1;
      if (!b?.hasResponse) return -1;
      const textCompare = normalizeAnswerValue(a?.sortDisplay).localeCompare(normalizeAnswerValue(b?.sortDisplay));
      if (textCompare !== 0) return textCompare;
      return compareNullableNumber(a?.pointsValue, b?.pointsValue);
    };

    const query = normalizeAnswerValue(studentSearch).toLowerCase();
    const rows = studentsTabRows.filter((row) => {
      if (!query) return true;
      const haystack = [
        row.sortFirstName,
        row.sortLastName,
        row.displayName,
        row.sortEmail,
      ]
        .map((value) => normalizeAnswerValue(value).toLowerCase())
        .join(' ');
      return haystack.includes(query);
    });

    rows.sort((a, b) => {
      let cmp = 0;
      if (studentSort.field === 'participation') {
        cmp = compareNullableNumber(a.participationValue, b.participationValue);
      } else if (studentSort.field === 'grade') {
        cmp = compareNullableNumber(a.gradeValue, b.gradeValue);
      } else if (studentSort.field === 'percentCorrect') {
        cmp = compareNullableNumber(a.percentCorrectValue, b.percentCorrectValue);
      } else if (studentSort.field === 'joinedAt') {
        cmp = compareNullableNumber(a.joinedAtValue, b.joinedAtValue);
      } else if (studentSort.field === 'inSession') {
        cmp = compareNullableNumber(a.inSessionValue, b.inSessionValue);
      } else if (studentSort.field.startsWith('question:')) {
        const questionId = studentSort.field.slice('question:'.length);
        cmp = compareQuestionCell(a.questionCells?.[questionId], b.questionCells?.[questionId]);
      } else if (studentSort.field === 'email') {
        cmp = normalizeAnswerValue(a.sortEmail).localeCompare(normalizeAnswerValue(b.sortEmail));
      } else {
        cmp = normalizeAnswerValue(a.sortLastName).localeCompare(normalizeAnswerValue(b.sortLastName));
        if (cmp === 0) {
          cmp = normalizeAnswerValue(a.sortFirstName).localeCompare(normalizeAnswerValue(b.sortFirstName));
        }
        if (cmp === 0) {
          cmp = normalizeAnswerValue(a.sortEmail).localeCompare(normalizeAnswerValue(b.sortEmail));
        }
      }
      return studentSort.direction === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [studentsTabRows, studentSort, studentSearch]);

  const studentSearchOptions = useMemo(() => {
    const options = new Set();
    studentsTabRows.forEach((row) => {
      if (row.displayName) options.add(row.displayName);
      if (row.sortEmail) options.add(row.sortEmail);
    });
    return [...options].sort((a, b) => a.localeCompare(b));
  }, [studentsTabRows]);

  // ---- CSV export ----

  const handleExportCsv = useCallback(() => {
    const csvExport = buildSessionResultsCsv({
      anonymous: anonymousSession,
      ungraded: ungradedSession,
      includeResponseTimestamps,
      csvQuestionAttempts,
      gradesByStudentId,
      sessionName: session?.name,
      studentResults,
      visibleStudents: sortedStudentsTabRows,
      t,
    });
    if (!csvExport) return;

    downloadCsv(csvExport.filename, csvExport.csvContent);
    setExportDialogOpen(false);
  }, [anonymousSession, ungradedSession, includeResponseTimestamps, csvQuestionAttempts, gradesByStudentId, sortedStudentsTabRows, studentResults, session?.name, t]);

  // ---- Render: loading ----

  if (loading) {
    return (
      <Box sx={{ p: 3, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  // ---- Render: error ----

  if (error) {
    return (
      <Box sx={{ p: 3, maxWidth: 800 }}>
        <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>
        <BackLinkButton variant="outlined" label={t('professor.sessionReview.backToCourse')} onClick={() => navigate(backToCoursePath)} />
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2.5, maxWidth: 1120 }}>
      {/* Header */}
      <Box sx={{ mb: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
          <BackLinkButton label={t('professor.sessionReview.backToCourse')} onClick={() => navigate(backToCoursePath)} />
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {liveInteractiveSession ? (
              <Button
                size="small"
                variant="contained"
                color="success"
                startIcon={<JoinIcon />}
                onClick={() => navigate(`/prof/course/${courseId}/session/${sessionId}/live`)}
              >
                {t('professor.sessionReview.joinLiveSession')}
              </Button>
            ) : null}
            <Button
              size="small"
              variant="outlined"
              startIcon={<EditIcon />}
              onClick={() => navigate(editSessionPath, { state: { returnTab: resolvedReturnTab, returnTo: 'review' } })}
            >
              {t('professor.sessionReview.editSession')}
            </Button>
          </Box>
        </Box>
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
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          {session?.name || t('professor.sessionReview.sessionReview')}
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

      {/* Summary stats */}
      <Box
        sx={{
          display: 'flex', gap: 2, mb: 3, flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <Paper variant="outlined" sx={{ p: 1.5, minWidth: 110, textAlign: 'center' }}>
          <Typography variant="caption" sx={{
            color: "text.secondary"
          }}>{t('professor.sessionReview.questions')}</Typography>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>{totalQuestions}</Typography>
        </Paper>
        {anonymousSession ? (
          <>
            <Paper variant="outlined" sx={{ p: 1.5, minWidth: 110, textAlign: 'center' }}>
              <Typography variant="caption" sx={{
                color: "text.secondary"
              }}>{t('professor.sessionReview.respondents')}</Typography>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>{anonymousSummary?.respondentCount ?? totalStudents}</Typography>
            </Paper>
            <Paper variant="outlined" sx={{ p: 1.5, minWidth: 110, textAlign: 'center' }}>
              <Typography variant="caption" sx={{
                color: "text.secondary"
              }}>{t('professor.sessionReview.joinedSession')}</Typography>
              <Typography variant="h6" sx={{ fontWeight: 700 }}>
                {t('professor.sessionReview.joinedCount', {
                  joined: anonymousSummary?.joinedCount ?? 0,
                  total: anonymousSummary?.enrolledCount ?? 0,
                })}
              </Typography>
            </Paper>
          </>
        ) : (
          <Paper variant="outlined" sx={{ p: 1.5, minWidth: 110, textAlign: 'center' }}>
            <Typography variant="caption" sx={{
              color: "text.secondary"
            }}>{t('professor.sessionReview.joinedSession')}</Typography>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>{t('professor.sessionReview.joinedCount', { joined: joinedStudents, total: totalStudents })}</Typography>
          </Paper>
        )}

        <Box sx={{ flex: 1 }} />

        <FormControlLabel
          control={
            <Switch
              checked={!!session?.reviewable}
              onChange={(e) => handleToggleReviewable(e.target.checked)}
              disabled={togglingReviewable || session?.status !== 'done' || session?.quizHasRemainingExtensions}
              size="small"
            />
          }
          label={t('professor.sessionReview.studentsCanReview')}
          aria-label={t('professor.sessionReview.toggleReview')}
        />

        <SessionGradesVisibilityControl
          session={session}
          disabled={togglingReviewable}
          onChange={(checked) => handleToggleReviewable(checked, true)}
        />
      </Box>
      {anonymousSession ? (
        <Alert severity="info" icon={<VisibilityOffIcon fontSize="inherit" />} sx={{ mb: 2 }}>
          {t('professor.sessionReview.anonymousSessionNotice')}
        </Alert>
      ) : session?.activityEverShared ? (
        <Alert severity="info" sx={{ mb: 2 }}>{t('professor.sessionEditor.sharedNamedGradingInfo')}</Alert>
      ) : null}
      {anonymousSession && anonymousSummary?.responsesWithheld ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {t('professor.sessionReview.anonymousResponsesWithheld', {
            minimum: anonymousSummary.minimumRespondents,
          })}
        </Alert>
      ) : null}
      {reviewableWarning ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {reviewableWarning}
        </Alert>
      ) : null}
      {session?.quiz && !session?.practiceQuiz && !anonymousSession ? (
        <LiveSessionWebSocketProvider sessionId={sessionId}>
          <QuizReviewUpdates onRefresh={fetchResults} refreshAt={quizResultsRefreshAt} />
        </LiveSessionWebSocketProvider>
      ) : null}
      {session?.quiz && !session?.practiceQuiz && session?.status !== 'done' ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('professor.sessionReview.quizSubmittedResultsOnly')}
        </Alert>
      ) : null}
      {liveInteractiveSession ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('professor.sessionReview.liveResultsAvailableWhileRunning')}
        </Alert>
      ) : null}
      {hasOutstandingManualGrading ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {t('professor.sessionReview.ungradedSummary', {
            verb: gradingNeedsSummary.questions === 1 ? 'is' : 'are',
            questions: gradingNeedsSummary.questions,
            questionWord: gradingNeedsSummary.questions === 1 ? 'question' : 'questions',
            students: gradingNeedsSummary.students,
            studentWord: gradingNeedsSummary.students === 1 ? 'student' : 'students',
            marks: gradingNeedsSummary.marks,
            markWord: gradingNeedsSummary.marks === 1 ? 'mark' : 'marks',
          })}
        </Alert>
      ) : null}

      {/* Tabs */}
      <ResponsiveTabsNavigation
        value={tab}
        onChange={setTab}
        ariaLabel={t('professor.sessionReview.sessionReviewTabs')}
        dropdownLabel={t('common.view')}
        dropdownSx={{ mb: 1.5 }}
        tabs={[
          { value: 0, label: t('professor.sessionReview.results') },
          { value: 1, label: t('professor.sessionReview.responseData') },
          ungradedSession ? {
            value: 2,
            label: t('professor.sessionReview.responsesByQuestion'),
          } : {
            value: 2,
            label: (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <span>{t('professor.sessionReview.grading')}</span>
                {hasOutstandingManualGrading && (
                  <Chip size="small" color="error" label={t('professor.sessionReview.needsGradingCount', { count: gradingNeedsSummary.marks })} />
                )}
              </Box>
            ),
            dropdownLabel: t('professor.sessionReview.grading'),
            tabProps: {
              sx: hasOutstandingManualGrading ? { color: 'error.main !important', fontWeight: 700 } : undefined,
            },
          },
          ...(sessionChatAvailable ? [{ value: 3, label: t('sessionChat.chat') }] : []),
        ]}
      />

      {/* Questions tab – all questions shown at once with inline stats */}
      <TabPanel value={tab} index={0}>
        {totalQuestions === 0 ? (
          <Alert severity="info">{t('professor.sessionReview.noQuestions')}</Alert>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {sessionTimeline && <Paper variant="outlined" sx={{ p: 2.5, minWidth: 0 }}>
              <ResponseTimeline key={sessionId} title={t('responseTimeline.overview')} data={sessionTimeline}
                quiz={session?.quiz} quizStart={session?.quizStart} quizEnd={session?.quizEnd} />
            </Paper>}
            {questionAttemptRows.map((row) => {
              const q = row.question;
              const qT = row.qType;
              const isOptionType = row.isOptionType;
              const isSlide = isSlideType(qT);

              return (
                <Paper key={row.key} variant="outlined" sx={{ p: 2.5 }}>
                  {/* Question header */}
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
                    {row.progress && (
                      <>
                        <Chip
                          label={t('professor.sessionReview.pageProgress', {
                            current: row.progress.pageCurrent,
                            total: row.progress.pageTotal,
                          })}
                          size="small"
                          variant="outlined"
                          sx={COMPACT_CHIP_SX}
                        />
                        <Chip
                          label={t('professor.sessionReview.questionProgress', {
                            current: row.progress.questionCurrent,
                            total: row.progress.questionTotal,
                          })}
                          size="small"
                          variant="outlined"
                          sx={COMPACT_CHIP_SX}
                        />
                      </>
                    )}
                    {row.attemptTotal > 1 && (
                      <Chip
                        label={t('professor.sessionReview.attemptProgress', { current: row.attemptIndex, total: row.attemptTotal })}
                        size="small"
                        variant="outlined"
                        sx={COMPACT_CHIP_SX}
                      />
                    )}
                    <Chip
                      label={getQuestionTypeLabel(t, qT)}
                      color={TYPE_COLORS[qT] || 'default'}
                      size="small"
                      sx={COMPACT_CHIP_SX}
                    />
                    {!isSlide && q.sessionOptions?.points != null && (
                      <Chip
                        label={t('professor.sessionReview.pointsAbbrev', { count: q.sessionOptions.points })}
                        size="small"
                        variant="outlined"
                        sx={COMPACT_CHIP_SX}
                      />
                    )}
                    <Chip
                      label={t('professor.sessionReview.responseCountLabel', { count: row.responseCount || 0 })}
                      size="small"
                      variant="outlined"
                      sx={COMPACT_CHIP_SX}
                    />
                    {qT === QUESTION_TYPES.SHORT_ANSWER ? (
                      <Box sx={{ ml: 'auto' }}>
                        <AiSummaryControls
                          summary={aiSummaries[q._id]}
                          halting={!!haltingSummaryIds[q._id]}
                          actionError={summaryActionErrors[q._id]}
                          onGenerate={() => setSummaryQuestion(q)}
                          onHalt={() => haltSummary(q._id)}
                          onView={() => setSummaryView(aiSummaries[q._id])}
                          t={t}
                        />
                      </Box>
                    ) : null}
                  </Box>

                  {/* Question content */}
                  <Box sx={{ mb: 2 }}>
                    <RichContent html={q.content} fallback={q.plainText} allowVideoEmbeds />
                  </Box>

                  {row.timeline && <Box sx={{ mb: 2 }}>
                    <ResponseTimeline title={t('responseTimeline.question', { number: row.questionNumber, attempt: row.attemptNumber })}
                      data={row.timeline}
                      quiz={session?.quiz} quizStart={session?.quizStart} quizEnd={session?.quizEnd} />
                  </Box>}

                  {row.responsesWithheld && (
                    <Alert severity="info" sx={{ mb: 1 }}>
                      {t('professor.sessionReview.anonymousAnswersHidden', { minimum: row.minimumRespondents })}
                    </Alert>
                  )}

                  {/* Inline stats for MC/TF/MS using option bars */}
                  {isOptionType && row.chartData && (
                    <Box sx={{ mb: 1 }}>
                      <DistributionBars
                        data={row.chartData}
                        highlightCorrect
                        correctIndices={row.correctIndices}
                        options={q.options}
                        responseCount={row.responseCount}
                      />
                    </Box>
                  )}

                  {/* Fallback: show options without stats for types that don't have chart data */}
                  {isOptionType && !row.chartData && (q.options || []).length > 0 && (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mb: 1 }}>
                      {(q.options || []).map((opt, i) => {
                        const isCorrect = isCorrectOption(opt);
                        const optionContent = getOptionRichContentProps(opt);
                        return (
                          <Paper
                            key={opt._id || i}
                            variant="outlined"
                            sx={{
                              p: 1, display: 'flex', alignItems: 'flex-start', gap: 1,
                              borderColor: isCorrect ? 'success.main' : 'divider',
                              bgcolor: isCorrect ? 'success.50' : 'transparent',
                            }}
                          >
                            <Chip
                              label={OPTION_LETTERS[i]}
                              size="small"
                              color={isCorrect ? 'success' : 'default'}
                              sx={{ ...COMPACT_CHIP_SX, fontWeight: 700, minWidth: 28 }}
                            />
                            <Box sx={{ flex: 1, minWidth: 0 }}>
                              <RichContent html={optionContent.html} fallback={optionContent.fallback} />
                            </Box>
                          </Paper>
                        );
                      })}
                    </Box>
                  )}

                  {/* Numerical correct answer */}
                  {qT === QUESTION_TYPES.NUMERICAL && q.correctNumerical != null && (
                    <Box sx={{ mb: 1 }}>
                      <Typography variant="body2" sx={{
                        color: "text.secondary"
                      }}>
                        {t('professor.sessionReview.correct', { value: q.correctNumerical })}
                      </Typography>
                      <Typography variant="body2" sx={{
                        color: "text.secondary"
                      }}>
                        {t('professor.sessionReview.tolerance', { value: q.toleranceNumerical ?? 0 })}
                      </Typography>
                    </Box>
                  )}

                  {/* SA: expandable responses + word cloud */}
                  {qT === QUESTION_TYPES.SHORT_ANSWER && row.saResponses && row.saResponses.length > 0 && (
                    <Box sx={{ mt: 1 }}>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => toggleSARow(row.key)}
                        startIcon={expandedSARows[row.key] ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      >
                        {expandedSARows[row.key]
                          ? t('professor.sessionReview.hideResponses')
                          : t('professor.sessionReview.showResponses')}
                      </Button>
                      <Collapse in={!!expandedSARows[row.key]}>
                        <Box sx={{ mt: 1 }}>
                          <WordCloudPanel
                            wordCloudData={wordCloudByRow[row.key] || q.sessionOptions?.wordCloudData}
                            onGenerate={() => handleGenerateWordCloudForQuestion(q._id, row.key)}
                            showControls
                          />
                          <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
                            {row.saResponses.map((r, idx) => (
                              <Paper key={idx} variant="outlined" sx={{ p: 1, mb: 0.5 }}>
                                <Typography
                                  variant="caption"
                                  sx={{
                                    color: "text.secondary",
                                    display: 'block',
                                    mb: 0.5
                                  }}>
                                  {normalizeAnswerValue(r.studentName) || t('professor.sessionReview.unknownStudent')}
                                </Typography>
                                {r.answerWysiwyg ? (
                                  <RichContent html={r.answerWysiwyg} />
                                ) : (
                                  <Typography variant="body2">
                                    {normalizeAnswerValue(r.answer) || t('common.noAnswer')}
                                  </Typography>
                                )}
                              </Paper>
                            ))}
                          </Box>
                        </Box>
                      </Collapse>
                    </Box>
                  )}

                  {/* NU: expandable responses + histogram */}
                  {qT === QUESTION_TYPES.NUMERICAL && row.nuResponses && row.nuResponses.length > 0 && (
                    <Box sx={{ mt: 1 }}>
                      <Button
                        size="small"
                        variant="text"
                        onClick={() => toggleNURow(row.key)}
                        startIcon={expandedNURows[row.key] ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      >
                        {expandedNURows[row.key]
                          ? t('professor.sessionReview.hideResponses')
                          : t('professor.sessionReview.showResponses')}
                      </Button>
                      <Collapse in={!!expandedNURows[row.key]}>
                        <Box sx={{ mt: 1 }}>
                          <HistogramPanel
                            histogramData={histogramByRow[row.key] || q.sessionOptions?.histogramData}
                            onGenerate={(opts) => handleGenerateHistogramForQuestion(q._id, row.key, opts)}
                            showControls
                          />
                          <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
                            {row.nuResponses.map((r, idx) => (
                              <Paper key={idx} variant="outlined" sx={{ p: 1, mb: 0.5 }}>
                                <Typography
                                  variant="caption"
                                  sx={{
                                    color: "text.secondary",
                                    display: 'block',
                                    mb: 0.5
                                  }}>
                                  {normalizeAnswerValue(r.studentName) || t('professor.sessionReview.unknownStudent')}
                                </Typography>
                                <Typography variant="body2">
                                  {normalizeAnswerValue(r.answer) || t('common.noAnswer')}
                                </Typography>
                              </Paper>
                            ))}
                          </Box>
                        </Box>
                      </Collapse>
                    </Box>
                  )}
                </Paper>
              );
            })}
          </Box>
        )}
      </TabPanel>

      {/* Response Data tab */}
      <TabPanel value={tab} index={1}>
        {studentResults.length === 0 ? (
          anonymousSummary?.responsesWithheld ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {questionAttemptRows.filter((row) => !isSlideType(row.qType)).map((row) => (
                <Alert key={row.key} severity="info">
                  {t('professor.sessionReview.csvAttemptResponse', { number: row.questionNumber, attempt: row.attemptNumber })}
                  {' — '}{t('professor.sessionReview.responseCountLabel', { count: row.responseCount })}
                  {row.responsesWithheld && <>. {t('professor.sessionReview.anonymousAnswersHidden', { minimum: row.minimumRespondents })}</>}
                </Alert>
              ))}
            </Box>
          ) : <Alert severity="info">{t('professor.sessionReview.noResults')}</Alert>
        ) : (
          <>
            <Box
              sx={{
                display: 'flex',
                gap: 1.5,
                mb: 1.5,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              <Autocomplete
                freeSolo
                options={studentSearchOptions}
                value={studentSearch}
                onInputChange={(_, value) => setStudentSearch(value || '')}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={anonymousSession ? t('professor.sessionReview.searchRespondents') : t('professor.sessionReview.searchStudents')}
                    placeholder={anonymousSession ? t('professor.sessionReview.respondentLabel', { number: 1 }) : t('professor.sessionReview.nameOrEmail')}
                    size="small"
                  />
                )}
                sx={{ flex: '1 1 320px', maxWidth: 420 }}
              />
              <Button
                variant="outlined"
                size="small"
                startIcon={<DownloadIcon />}
                onClick={() => setExportDialogOpen(true)}
                disabled={!sortedStudentsTabRows.length}
                aria-label={t('professor.sessionReview.exportResultsCSV')}
              >
                {t('professor.sessionReview.exportCSV')}
              </Button>
            </Box>

            {sortedStudentsTabRows.length === 0 ? (
              <Alert severity="info">{t('professor.sessionReview.noStudentsMatch')}</Alert>
            ) : (
              <TableContainer component={Paper} variant="outlined">
                <Table
                  size="small"
                  aria-label={t('professor.sessionReview.studentResults')}
                  sx={{ '& .MuiTableCell-root': { px: 0.65, py: 0.5 } }}
                >
                  <TableHead>
                    <TableRow>
                      <TableCell component="th" scope="col" sx={{ fontWeight: 700, minWidth: 220 }}>
                        <TableSortLabel
                          active={studentSort.field === 'name'}
                          direction={studentSort.field === 'name' ? studentSort.direction : 'asc'}
                          onClick={() => handleStudentsSort('name')}
                        >
                          {anonymousSession ? t('professor.sessionReview.respondent') : t('professor.sessionReview.name')}
                        </TableSortLabel>
                      </TableCell>
                      {!anonymousSession && (
                        <>
                          {!ungradedSession && <TableCell component="th" scope="col" align="center" sx={{ fontWeight: 700 }}>
                            <TableSortLabel
                              active={studentSort.field === 'grade'}
                              direction={studentSort.field === 'grade' ? studentSort.direction : 'desc'}
                              onClick={() => handleStudentsSort('grade')}
                            >
                              {t('professor.sessionReview.grade')}
                            </TableSortLabel>
                          </TableCell>}
                          <TableCell component="th" scope="col" align="center" sx={{ fontWeight: 700 }}>
                            <TableSortLabel
                              active={studentSort.field === 'inSession'}
                              direction={studentSort.field === 'inSession' ? studentSort.direction : 'asc'}
                              onClick={() => handleStudentsSort('inSession')}
                            >
                              {t('professor.sessionReview.inSession')}
                            </TableSortLabel>
                          </TableCell>
                        </>
                      )}
                      <TableCell component="th" scope="col" align="center" sx={{ fontWeight: 700 }}>
                        <TableSortLabel
                          active={studentSort.field === 'participation'}
                          direction={studentSort.field === 'participation' ? studentSort.direction : 'desc'}
                          onClick={() => handleStudentsSort('participation')}
                        >
                          {t('professor.sessionReview.participation')}
                        </TableSortLabel>
                      </TableCell>
                      <TableCell component="th" scope="col" align="center" sx={{ fontWeight: 700 }}>
                        <TableSortLabel
                          active={studentSort.field === 'percentCorrect'}
                          direction={studentSort.field === 'percentCorrect' ? studentSort.direction : 'desc'}
                          onClick={() => handleStudentsSort('percentCorrect')}
                        >
                          {t('professor.sessionReview.percentCorrect')}
                        </TableSortLabel>
                      </TableCell>
                      {!anonymousSession && (
                        <TableCell component="th" scope="col" align="center" sx={{ fontWeight: 700 }}>
                          <TableSortLabel
                            active={studentSort.field === 'joinedAt'}
                            direction={studentSort.field === 'joinedAt' ? studentSort.direction : 'asc'}
                            onClick={() => handleStudentsSort('joinedAt')}
                          >
                            {t('professor.sessionReview.joinedSession')}
                          </TableSortLabel>
                        </TableCell>
                      )}
                      {responseDataColumns.map((column) => (
                        <TableCell key={column.key} component="th" scope="col" sx={{ fontWeight: 700 }} align="center">
                          <TableSortLabel
                            active={studentSort.field === `question:${column.key}`}
                            direction={studentSort.field === `question:${column.key}` ? studentSort.direction : 'asc'}
                            onClick={() => handleStudentsSort(`question:${column.key}`)}
                          >
                            {column.label}
                          </TableSortLabel>
                          {anonymousSession && column.release && (
                            <Typography variant="caption" component="div">
                              {t('professor.sessionReview.responseCountLabel', { count: column.release.respondentCount })}
                            </Typography>
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {sortedStudentsTabRows.map((student) => (
                      <TableRow key={student.studentId}>
                        <TableCell component="th" scope="row">
                          {anonymousSession ? (
                            <Typography variant="body2" sx={{ fontWeight: 600 }}>{student.displayName}</Typography>
                          ) : (
                            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                              <StudentIdentity
                                student={student}
                                showEmail
                                avatarSize={30}
                                nameVariant="body2"
                                nameWeight={600}
                              />
                            </Box>
                          )}
                        </TableCell>
                        {!anonymousSession && (
                          <>
                            {!ungradedSession && <TableCell align="center">
                              {student.guest ? t('professor.sessionReview.guestNoGrade') : formatPercent(student.gradeValue)}
                            </TableCell>}
                            <TableCell align="center">
                              <Chip
                                label={student.inSession ? t('common.yes') : t('common.no')}
                                color={student.inSession ? 'success' : 'default'}
                                size="small"
                                variant={student.inSession ? 'filled' : 'outlined'}
                              />
                            </TableCell>
                          </>
                        )}
                        <TableCell align="center">{formatParticipation(student.participationValue)}</TableCell>
                        <TableCell align="center">{formatPercent(student.percentCorrectValue)}</TableCell>
                        {!anonymousSession && (
                          <TableCell align="center">{formatJoinedAt(student.joinedAt)}</TableCell>
                        )}
                        {responseDataColumns.map((column) => {
                          const questionCell = student.questionCells?.[column.key];
                          return (
                            <TableCell key={column.key} align="center">
                              <Typography variant="body2">
                                {questionCell?.display || '—'}
                                {questionCell?.pointsValue != null ? ` (${questionCell.pointsValue})` : ''}
                              </Typography>
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </>
        )}
      </TabPanel>

      {/* Grading tab (read-only responses by question for anonymous sessions) */}
      <TabPanel value={tab} index={2}>
        {ungradedSession ? (
          <AnonymousResponsesPanel
            questions={questions.filter((question) => !isSlideType(normalizeQuestionType(question)))}
            studentResults={studentResults}
            anonymous={anonymousSession}
            getResponseCorrectness={isLatestResponseCorrect}
          />
        ) : (
          <>
            <SessionQuestionGradingPanel
              sessionId={sessionId}
              courseId={courseId}
              session={session}
              questions={questions.filter((question) => !isSlideType(normalizeQuestionType(question)))}
              studentResults={groupFilteredStudentResults}
              onSessionDataRefresh={fetchResults}
              onUngradedSummaryChange={handleUngradedSummaryChange}
              filterSlot={groupCategories.length > 0 ? (
                <>
                  <TextField
                    select
                    size="small"
                    label={t('professor.sessionReview.selectCategoryFilter')}
                    value={selectedCatIdx >= 0 ? String(selectedCatIdx) : ''}
                    onChange={(e) => {
                      const idx = e.target.value === '' ? -1 : Number(e.target.value);
                      setSelectedCatIdx(idx);
                      const cat = idx >= 0 ? groupCategories[idx] : null;
                      setSelectedGroupIdx(cat && cat.groups && cat.groups.length > 0 ? 0 : -1);
                    }}
                    slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
                    sx={{ minWidth: 180 }}
                  >
                    <option value="">{t('professor.sessionReview.allStudentsFilter')}</option>
                    {groupCategories.map((cat, idx) => (
                      <option key={cat.categoryNumber} value={String(idx)}>{cat.categoryName}</option>
                    ))}
                  </TextField>
                  {selectedGroupCat && (
                    <TextField
                      select
                      size="small"
                      label={t('professor.sessionReview.selectGroupFilter')}
                      value={selectedGroupIdx >= 0 ? String(selectedGroupIdx) : ''}
                      onChange={(e) => setSelectedGroupIdx(Number(e.target.value))}
                      slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
                      sx={{ minWidth: 180 }}
                    >
                      {(selectedGroupCat.groups || []).map((g, idx) => (
                        <option key={idx} value={String(idx)}>
                          {g.name} ({(g.members || []).length})
                        </option>
                      ))}
                    </TextField>
                  )}
                </>
              ) : null}
            />
            {session?.activityEverShared && studentResults.some((student) => student.guest) && (
              <Box sx={{ mt: 3 }}>
                <Typography variant="h6" component="h3" sx={{ mb: 1 }}>
                  {t('professor.sessionReview.guestResponses')}
                </Typography>
                <AnonymousResponsesPanel
                  questions={questions.filter((question) => !isSlideType(normalizeQuestionType(question)))}
                  studentResults={studentResults.filter((student) => student.guest)}
                  anonymous={false}
                  getResponseCorrectness={isLatestResponseCorrect}
                />
              </Box>
            )}
          </>
        )}
      </TabPanel>

      {sessionChatAvailable ? (
        <TabPanel value={tab} index={3}>
          <SessionChatPanel
            sessionId={sessionId}
            enabled={sessionChatAvailable}
            role="professor"
            view="review"
            initialData={{
              enabled: sessionChatAvailable,
              canPost: false,
              canComment: false,
              canVote: false,
              canDismiss: false,
              canViewNames: !anonymousSession,
              posts: chatPosts,
              quickPosts: [],
            }}
          />
        </TabPanel>
      ) : null}
      <Dialog open={exportDialogOpen} onClose={() => setExportDialogOpen(false)} fullWidth maxWidth="sm" aria-labelledby="export-results-title" aria-describedby="export-results-description">
        <DialogTitle id="export-results-title">{t('professor.sessionReview.exportResultsCSV')}</DialogTitle>
        <DialogContent>
          <FormControlLabel
            control={<Checkbox checked={!anonymousSession && includeResponseTimestamps} disabled={anonymousSession} onChange={(event) => setIncludeResponseTimestamps(event.target.checked)} />}
            label={t('professor.sessionReview.includeResponseTimestamps')}
          />
          <Typography id="export-results-description" variant="body2" color="text.secondary">
            {anonymousSession
              ? t('professor.sessionReview.anonymousTimestampsHidden')
              : t('professor.sessionReview.responseTimestampsHint', { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExportDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={handleExportCsv} disabled={!sortedStudentsTabRows.length}>{t('professor.sessionReview.exportCSV')}</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!summaryQuestion} onClose={() => setSummaryQuestion(null)} fullWidth maxWidth="sm">
        <DialogTitle>{t('professor.sessionReview.generateAiResponseSummary')}</DialogTitle>
        <DialogContent dividers>
          {summaryError ? <Alert severity="error" sx={{ mb: 2 }}>{summaryError}</Alert> : null}
          <Box sx={{ mb: 2 }}><AiModelSelect courseId={courseId} value={summaryModel} onChange={setSummaryModel} task="response-summary" /></Box>
          <AiSummaryInstructionForm
            instructionId={summaryInstructionId}
            instruction={summaryInstruction}
            instructions={summaryInstructions}
            onChange={({ instructionId }) => setSummaryInstructionId(instructionId)}
            onEditingChange={setSummaryInstructionEditing}
            onSaveInstruction={saveSummaryInstruction}
            onDeleteInstruction={deleteSummaryInstruction}
          />
        </DialogContent>
        <DialogActions><Button onClick={() => setSummaryQuestion(null)}>{t('common.cancel')}</Button><Button variant="contained" disabled={summaryInstructionEditing || !summaryModel || !summaryInstructionId || !summaryInstruction.trim()} onClick={startSummary}>{t('professor.sessionReview.generateAiResponseSummary')}</Button></DialogActions>
      </Dialog>
      <Dialog open={!!summaryView} onClose={() => setSummaryView(null)} fullWidth maxWidth="md"><DialogTitle>{t('professor.sessionReview.viewAiResponseSummary')}</DialogTitle><DialogContent dividers><AiMarkdownContent content={summaryView?.summary} /></DialogContent><DialogActions><Button onClick={() => setSummaryView(null)}>{t('common.close')}</Button></DialogActions></Dialog>
    </Box>
  );
}
