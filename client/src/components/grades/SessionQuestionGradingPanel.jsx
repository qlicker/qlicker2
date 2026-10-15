import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Check as CheckIcon, Close as CloseIcon, Refresh as RefreshIcon, Speed as SpeedIcon } from '@mui/icons-material';
import apiClient from '../../api/client';
import SpeedGradingModal from './SpeedGradingModal';
import AiGradingModal from './AiGradingModal';
import {
  QUESTION_TYPES,
  TYPE_COLORS,
  getQuestionTypeLabel,
  normalizeQuestionType,
} from '../questions/constants';
import {
  normalizeStoredHtml,
  prepareRichTextInput,
  renderKatexInElement,
} from '../questions/richTextUtils';
import RichTextEditor from '../questions/RichTextEditor';
import { getLatestResponse } from '../../utils/responses';
import ParticipantRoleBadges from '../common/ParticipantRoleBadges';

const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const COMPACT_CHIP_SX = {
  borderRadius: 1.4,
  '& .MuiChip-label': { px: 1.15 },
};

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

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function stripHtml(value) {
  return normalizeValue(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeComparableText(value) {
  return stripHtml(value).toLowerCase();
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return String(Math.round(numeric * 10) / 10);
}

function hasExplicitPointsValue(value) {
  return value !== '' && value !== null && value !== undefined;
}

function arePointValuesEqual(draftValue, markValue) {
  const draftHasPoints = hasExplicitPointsValue(draftValue);
  const markHasPoints = hasExplicitPointsValue(markValue);
  if (draftHasPoints !== markHasPoints) return false;
  if (!draftHasPoints) return true;

  const draftNumeric = Number(draftValue);
  const markNumeric = Number(markValue);
  if (Number.isFinite(draftNumeric) && Number.isFinite(markNumeric)) {
    return Math.abs(draftNumeric - markNumeric) <= 0.0001;
  }

  return normalizeValue(draftValue) === normalizeValue(markValue);
}

function isDraftChangedFromMark(draft, mark) {
  if (!draft) return false;
  const feedbackChanged = normalizeValue(draft.feedback) !== normalizeValue(mark?.feedback);
  const pointsChanged = !arePointValuesEqual(draft.points, mark?.points);
  return feedbackChanged || pointsChanged;
}

function formatDisplayName(student, fallback = 'Unknown Student') {
  const first = normalizeValue(student?.firstname);
  const last = normalizeValue(student?.lastname);
  const fullName = `${first} ${last}`.trim();
  if (fullName) return fullName;
  return normalizeValue(student?.email) || fallback;
}

function buildStudentInitials(student) {
  const first = normalizeValue(student?.firstname);
  const last = normalizeValue(student?.lastname);
  if (first || last) {
    return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
  }
  const email = normalizeValue(student?.email);
  return email ? email.charAt(0).toUpperCase() : '?';
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
        // Keep scalar interpretation for invalid JSON.
      }
    }
    if (trimmed.includes(',') && !/<[^>]*>/.test(trimmed)) {
      return trimmed.split(',').map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return [answer];
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

  const normalizedRaw = normalizeValue(answer);
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
    normalizeValue(opt?._id).toLowerCase() === normalized
    || normalizeComparableText(optionDisplayHtml(opt)) === normalizeComparableText(normalizedRaw)
  ));
}

function getQuestionPoints(question) {
  const numeric = Number(question?.sessionOptions?.points);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return numeric;
}

function getEffectiveQuestionOutOf(question, mark = null) {
  const markOutOf = Number(mark?.outOf);
  if (Number.isFinite(markOutOf) && markOutOf >= 0) return markOutOf;
  return getQuestionPoints(question);
}

function buildSessionOptionsPayload(sessionOptions = {}, nextPoints) {
  const payload = { points: nextPoints };

  if (sessionOptions.hidden !== undefined) payload.hidden = !!sessionOptions.hidden;
  if (sessionOptions.stats !== undefined) payload.stats = !!sessionOptions.stats;
  if (sessionOptions.correct !== undefined) payload.correct = !!sessionOptions.correct;
  if (sessionOptions.responseListVisible !== undefined) {
    payload.responseListVisible = !!sessionOptions.responseListVisible;
  }

  const maxAttempts = Number(sessionOptions.maxAttempts);
  if (Number.isFinite(maxAttempts)) {
    payload.maxAttempts = maxAttempts;
  }

  if (Array.isArray(sessionOptions.attemptWeights)) {
    payload.attemptWeights = sessionOptions.attemptWeights
      .map((weight) => Number(weight))
      .filter((weight) => Number.isFinite(weight));
  }

  if (Array.isArray(sessionOptions.attempts)) {
    payload.attempts = sessionOptions.attempts.map((attempt) => ({
      number: Number(attempt?.number) || 1,
      closed: !!attempt?.closed,
    }));
  }

  return payload;
}

function isAutoGradeableQuestionType(questionType) {
  return [
    QUESTION_TYPES.MULTIPLE_CHOICE,
    QUESTION_TYPES.TRUE_FALSE,
    QUESTION_TYPES.MULTI_SELECT,
    QUESTION_TYPES.NUMERICAL,
  ].includes(questionType);
}

export function buildResponseSummary(question, response, noAnswerLabel = '(no answer)') {
  if (!response) {
    return {
      displayText: '—',
      filterText: '',
      richHtml: '',
    };
  }

  const qType = normalizeQuestionType(question);
  const answer = response?.answer;

  if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    const richHtml = normalizeValue(response?.answerWysiwyg);
    const plain = normalizeValue(answer) || stripHtml(richHtml);
    return {
      displayText: plain || noAnswerLabel,
      filterText: [plain, stripHtml(richHtml)].filter(Boolean).join(' '),
      richHtml,
    };
  }

  if ([QUESTION_TYPES.MULTIPLE_CHOICE, QUESTION_TYPES.TRUE_FALSE, QUESTION_TYPES.MULTI_SELECT].includes(qType)) {
    const options = Array.isArray(question?.options) ? question.options : [];
    const selectedIndices = [...new Set(
      collectAnswerEntries(answer)
        .map((entry) => resolveOptionIndex(entry, options))
        .filter((idx) => idx >= 0 && idx < options.length)
    )];

    if (selectedIndices.length > 0) {
      const labels = selectedIndices.map((idx) => OPTION_LETTERS[idx] || String(idx + 1));
      const filterTerms = qType === QUESTION_TYPES.TRUE_FALSE
        ? selectedIndices.map((idx) => {
          const optionText = stripHtml(optionDisplayHtml(options[idx])).toLowerCase();
          if (optionText) return optionText;
          return idx === 0 ? 'true' : idx === 1 ? 'false' : OPTION_LETTERS[idx] || String(idx + 1);
        })
        : labels;
      return {
        displayText: labels.join(', '),
        filterText: filterTerms.join(' '),
        richHtml: '',
      };
    }
  }

  let displayText = '';
  if (answer && typeof answer === 'object') {
    try {
      displayText = JSON.stringify(answer);
    } catch {
      displayText = String(answer);
    }
  } else {
    displayText = normalizeValue(answer);
  }

  return {
    displayText: displayText || noAnswerLabel,
    filterText: displayText,
    richHtml: '',
  };
}

function formatCorrectAnswerSummary(question, labels = {}) {
  if (!question) return '—';
  const qType = normalizeQuestionType(question);

  if (qType === QUESTION_TYPES.NUMERICAL && question.correctNumerical != null) {
    if (question.toleranceNumerical != null) {
      return `${question.correctNumerical} | tolerance: ${question.toleranceNumerical}`;
    }
    return `${question.correctNumerical}`;
  }

  if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    return labels.manualGradingRequired || 'Manual grading required.';
  }

  return '—';
}

function summarizeUngradedFromGrades(gradesByStudentId = {}) {
  const questionIds = new Set();
  const studentIds = new Set();
  let marks = 0;

  Object.values(gradesByStudentId || {}).forEach((grade) => {
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

const GradingTableRow = memo(function GradingTableRow({
  row,
  draft,
  saving,
  rowDisabled,
  rowDirty,
  selected,
  onToggleSelected,
  onUpdateDraft,
  onSave,
  onCancel,
  onOpenImage,
  t,
}) {
  const rowNeedsGrading = !!row.rowNeedsGrading;
  const [pointsValue, setPointsValue] = useState(draft.points);
  const feedbackValueRef = useRef(draft.feedback || '');
  const [feedbackDirty, setFeedbackDirty] = useState(false);

  useEffect(() => {
    setPointsValue(draft.points);
  }, [draft.points, row.studentId]);

  useEffect(() => {
    feedbackValueRef.current = draft.feedback || '';
    setFeedbackDirty(false);
  }, [draft.feedback, row.studentId]);

  const pointsChanged = !arePointValuesEqual(pointsValue, row.mark?.points);
  const feedbackChanged = normalizeValue(feedbackValueRef.current) !== normalizeValue(row.mark?.feedback);
  const numericPoints = Number(pointsValue);
  const confirmingManualGrade = rowNeedsGrading
    && hasExplicitPointsValue(pointsValue)
    && Number.isFinite(numericPoints)
    && numericPoints >= 0;
  const localRowDirty = rowDirty || pointsChanged || feedbackChanged || feedbackDirty || confirmingManualGrade;
  const rowStateSx = rowNeedsGrading
    ? {
      bgcolor: 'error.50',
      '&:hover': { bgcolor: 'error.100' },
    }
    : rowDisabled
      ? {
        bgcolor: 'action.disabledBackground',
        '&:hover': { bgcolor: 'action.disabledBackground' },
      }
      : {
        bgcolor: 'success.50',
        '&:hover': { bgcolor: 'success.100' },
      };

  const syncDraftToParent = useCallback((nextPoints = pointsValue, nextFeedback = feedbackValueRef.current) => {
    if (
      arePointValuesEqual(nextPoints, draft.points)
      && normalizeValue(nextFeedback) === normalizeValue(draft.feedback)
    ) {
      return;
    }
    onUpdateDraft(row.studentId, (current) => ({
      ...current,
      points: nextPoints,
      feedback: nextFeedback,
    }));
  }, [draft.feedback, draft.points, onUpdateDraft, pointsValue, row.studentId]);

  return (
    <TableRow
      hover
      selected={selected}
      sx={rowStateSx}
    >
      <TableCell padding="checkbox">
        <Checkbox
          size="small"
          checked={selected}
          onChange={(event) => onToggleSelected(row.studentId, event.target.checked)}
          slotProps={{
            input: {
              'aria-label': t('grades.questionPanel.selectStudent', { name: row.displayName }),
            }
          }}
        />
      </TableCell>
      <TableCell>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', minWidth: 0 }}>
          <Avatar
            alt={row.displayName}
            src={row.student?.profileThumbnail || row.student?.profileImage || ''}
            slotProps={{
              img: {
                alt: row.displayName,
                loading: 'lazy',
                decoding: 'async',
              },
            }}
            sx={{
              width: 30,
              height: 30,
              cursor: row.student?.profileImage ? 'pointer' : 'default',
            }}
            onClick={() => {
              if (row.student?.profileImage) onOpenImage(row.student.profileImage);
            }}
          >
            {buildStudentInitials(row.student)}
          </Avatar>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap>{row.displayName}</Typography>
            <ParticipantRoleBadges participant={row.student} />
            <Typography variant="caption" noWrap sx={{
              color: "text.secondary"
            }}>{row.email || '—'}</Typography>
          </Box>
        </Box>
      </TableCell>
      <TableCell>
        <Box sx={{ maxWidth: 210 }}>
          {row.responseSummary.richHtml ? (
            <RichContent html={row.responseSummary.richHtml} />
          ) : (
            <Typography variant="body2">{row.responseSummary.displayText}</Typography>
          )}
        </Box>
        {row.latestResponse?.attempt ? (
          <Typography variant="caption" sx={{
            color: "text.secondary"
          }}>
            {t('grades.questionPanel.attemptNumber', { number: row.latestResponse.attempt })}
          </Typography>
        ) : null}
      </TableCell>
      <TableCell>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
          <TextField
            size="small"
            type="number"
            value={pointsValue}
            disabled={rowDisabled || saving}
            onChange={(event) => {
              setPointsValue(event.target.value);
            }}
            onBlur={() => syncDraftToParent(pointsValue, feedbackValueRef.current)}
            sx={{ width: 82 }}
            slotProps={{
              htmlInput: { min: 0 }
            }}
          />
          <Typography variant="caption" sx={{
            color: "text.secondary"
          }}>
            {t('grades.questionPanel.outOf', { value: formatPercent(row.mark?.outOf || 0) })}
          </Typography>
        </Box>
        {rowNeedsGrading && (
          <Chip
            size="small"
            color="error"
            variant="outlined"
            label={t('grades.questionPanel.needsGrading')}
            sx={{ mt: 0.5 }}
          />
        )}
        {row.mark?.aiGraded && (
          <Chip
            size="small"
            color="secondary"
            variant="outlined"
            label={t('grades.questionPanel.gradedByAi')}
            sx={{ mt: 0.5 }}
          />
        )}
        {rowDisabled && (
          <Chip
            size="small"
            color="warning"
            variant="outlined"
            label={t('grades.questionPanel.noGradeItem')}
            sx={{ mt: 0.5 }}
          />
        )}
      </TableCell>
      <TableCell>
        <Box sx={{ minWidth: 170 }}>
          <RichTextEditor
            value={draft.feedback}
            disabled={rowDisabled || saving}
            onChange={({ html }) => {
              const nextFeedback = html || '';
              feedbackValueRef.current = nextFeedback;
              const changedFromServer = normalizeValue(nextFeedback) !== normalizeValue(row.mark?.feedback);
              setFeedbackDirty((previous) => (previous === changedFromServer ? previous : changedFromServer));
            }}
            onBlur={() => syncDraftToParent(pointsValue, feedbackValueRef.current)}
            placeholder={t('grades.questionPanel.addFeedback')}
            ariaLabel={`${t('grades.coursePanel.feedback')} — ${row.displayName}`}
            minHeight={30}
            compact
          />
        </Box>
      </TableCell>
      <TableCell align="right">
        <Box sx={{ display: 'flex', gap: 0.25, justifyContent: 'flex-end', alignItems: 'center' }}>
          <Tooltip title={t('common.save')}>
            <span>
              <IconButton
                size="small"
                color="primary"
                onClick={() => {
                  const nextFeedback = feedbackValueRef.current;
                  syncDraftToParent(pointsValue, nextFeedback);
                  onSave(row, { points: pointsValue, feedback: nextFeedback });
                }}
                disabled={rowDisabled || saving || !localRowDirty}
                aria-label={t('common.save')}
              >
                <CheckIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title={t('common.cancel')}>
            <span>
              <IconButton
                size="small"
                color="default"
                onClick={() => {
                  setPointsValue(row.mark ? String(row.mark.points ?? 0) : '');
                  feedbackValueRef.current = normalizeValue(row.mark?.feedback);
                  setFeedbackDirty(false);
                  onCancel(row);
                }}
                disabled={rowDisabled || saving || !localRowDirty}
                aria-label={t('common.cancel')}
                sx={{ visibility: localRowDirty ? 'visible' : 'hidden' }}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      </TableCell>
    </TableRow>
  );
});

export default function SessionQuestionGradingPanel({
  sessionId,
  courseId,
  session = null,
  questions = [],
  studentResults = [],
  onSessionDataRefresh = null,
  onUngradedSummaryChange = null,
  filterSlot = null,
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [globalMessage, setGlobalMessage] = useState('');
  const [globalMessageType, setGlobalMessageType] = useState('info');
  const [gradesByStudentId, setGradesByStudentId] = useState({});
  const [serverGradingLockReason, setServerGradingLockReason] = useState(null);
  const [activeQuestionId, setActiveQuestionId] = useState('');
  const [studentQuery, setStudentQuery] = useState('');
  const [answerQuery, setAnswerQuery] = useState('');
  const [debouncedAnswerQuery, setDebouncedAnswerQuery] = useState('');
  const [showNeedsGradingOnly, setShowNeedsGradingOnly] = useState(false);
  const [showResponsesOnly, setShowResponsesOnly] = useState(false);
  const [draftByStudentId, setDraftByStudentId] = useState({});
  const [editedStudentIds, setEditedStudentIds] = useState({});
  const [savingByStudentId, setSavingByStudentId] = useState({});
  const [bulkPoints, setBulkPoints] = useState('');
  const [bulkFeedback, setBulkFeedback] = useState('');
  const [bulkApplying, setBulkApplying] = useState(false);
  const [showSolution, setShowSolution] = useState(false);
  const [aiGradingOpen, setAiGradingOpen] = useState(false);
  const [aiGradingJob, setAiGradingJob] = useState(null);
  const [aiGradingReportOpen, setAiGradingReportOpen] = useState(false);
  const [aiGradingReportLoading, setAiGradingReportLoading] = useState(false);
  const [haltingAiGrading, setHaltingAiGrading] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [questionPointsDraft, setQuestionPointsDraft] = useState('');
  const [questionPointsDialogOpen, setQuestionPointsDialogOpen] = useState(false);
  const [questionPointsSaving, setQuestionPointsSaving] = useState(false);
  const [tableSort, setTableSort] = useState({ field: 'student', direction: 'asc' });
  const [imageViewUrl, setImageViewUrl] = useState('');
  const [selectedStudentIds, setSelectedStudentIds] = useState({});
  const [speedGradingOpen, setSpeedGradingOpen] = useState(false);
  const [speedGradingRowsSnapshot, setSpeedGradingRowsSnapshot] = useState([]);
  const latestGradesSessionRef = useRef(sessionId);
  const latestGradesRequestRef = useRef(0);
  const gradesLoadedRef = useRef(false);
  const lastDraftQuestionIdRef = useRef('');
  const previousAiGradingStatusRef = useRef('');
  const previousAiGradingCompletedRef = useRef(0);

  useEffect(() => {
    latestGradesSessionRef.current = sessionId;
    latestGradesRequestRef.current += 1;
    gradesLoadedRef.current = false;
    setGradesByStudentId({});
    setDraftByStudentId({});
    setEditedStudentIds({});
    setSavingByStudentId({});
    setSelectedStudentIds({});
    previousAiGradingStatusRef.current = '';
    previousAiGradingCompletedRef.current = 0;
  }, [sessionId]);

  const fetchSessionGrades = useCallback(async ({ background = false } = {}) => {
    if (background && !gradesLoadedRef.current) return;
    const requestId = latestGradesRequestRef.current + 1;
    latestGradesRequestRef.current = requestId;
    const requestSessionId = sessionId;
    if (!background) {
      setLoading(true);
      setError('');
    }
    try {
      const { data } = await apiClient.get(`/sessions/${sessionId}/grades`);
      if (
        latestGradesSessionRef.current !== requestSessionId
        || latestGradesRequestRef.current !== requestId
      ) {
        return;
      }
      const next = {};
      (data?.grades || []).forEach((grade) => {
        next[String(grade.userId)] = grade;
      });
      gradesLoadedRef.current = true;
      setGradesByStudentId(next);
      setServerGradingLockReason(data?.gradingLockReason || null);
    } catch (err) {
      if (
        latestGradesSessionRef.current !== requestSessionId
        || latestGradesRequestRef.current !== requestId
      ) {
        return;
      }
      if (!background) setError(err.response?.data?.message || t('grades.questionPanel.failedLoadGrades'));
    } finally {
      if (
        latestGradesSessionRef.current !== requestSessionId
        || latestGradesRequestRef.current !== requestId
      ) {
        return;
      }
      if (!background) setLoading(false);
    }
  }, [sessionId, t]);

  useEffect(() => {
    fetchSessionGrades();
  }, [fetchSessionGrades, session?.status, session?.quizHasRemainingExtensions]);

  const ungradedSummary = useMemo(
    () => summarizeUngradedFromGrades(gradesByStudentId),
    [gradesByStudentId]
  );

  useEffect(() => {
    if (typeof onUngradedSummaryChange !== 'function') return;
    onUngradedSummaryChange(ungradedSummary);
  }, [onUngradedSummaryChange, ungradedSummary]);

  useEffect(() => {
    const firstQuestionId = String(questions?.[0]?._id || '');
    if (!firstQuestionId) {
      setActiveQuestionId('');
      return;
    }
    const hasActiveQuestion = questions.some(
      (question) => String(question?._id) === String(activeQuestionId)
    );
    if (!hasActiveQuestion) {
      setActiveQuestionId(firstQuestionId);
    }
  }, [activeQuestionId, questions]);

  const activeQuestion = useMemo(() => {
    return questions.find((question) => String(question?._id) === String(activeQuestionId)) || null;
  }, [activeQuestionId, questions]);

  useEffect(() => {
    setQuestionPointsDraft(String(getQuestionPoints(activeQuestion)));
  }, [activeQuestion]);

  const isQuizSession = !!(session?.quiz || session?.practiceQuiz);
  const sessionNotEnded = normalizeValue(session?.status) && session?.status !== 'done';
  const hasRemainingExtensions = !!session?.quizHasRemainingExtensions;
  const missingGrades = Object.keys(gradesByStudentId).length === 0
    || studentResults.some((student) => {
      if (!(student.questionResults || []).some((result) => result.responses?.length)) return false;
      return !gradesByStudentId[String(student.studentId)];
    });
  const gradingLockReason = sessionNotEnded ? 'not-ended'
    : hasRemainingExtensions ? 'extensions'
      : serverGradingLockReason || (missingGrades ? 'missing-grades' : null);
  const gradingLocked = !!gradingLockReason;

  const questionStatuses = useMemo(() => {
    const eligibleStudents = studentResults.filter((student) => {
      if (isQuizSession) {
        return (student?.questionResults || []).some((result) => (
          Array.isArray(result?.responses) && result.responses.length > 0
        ));
      }
      return !!student?.inSession;
    });

    return questions.map((question, index) => {
      const questionId = String(question?._id || '');
      let needsGradingCount = 0;
      const questionType = normalizeQuestionType(question);
      const autoGradeable = isAutoGradeableQuestionType(questionType);
      const outOf = getQuestionPoints(question);

      if (!autoGradeable && outOf > 0) {
        eligibleStudents.forEach((student) => {
          const studentId = String(student?.studentId || '');
          const grade = gradesByStudentId[studentId] || null;
          const mark = (grade?.marks || []).find((entry) => String(entry?.questionId) === questionId) || null;
          const effectiveOutOf = getEffectiveQuestionOutOf(question, mark);
          const questionResult = (student?.questionResults || []).find(
            (result) => String(result?.questionId) === questionId
          );
          const latestResponse = getLatestResponse(questionResult?.responses || []);
          if (!latestResponse) return;
          if (effectiveOutOf <= 0) return;
          if (mark && !mark?.needsGrading) return;
          needsGradingCount += 1;
        });
      }

      return {
        questionId,
        label: `Q${index + 1}`,
        needsGradingCount,
      };
    });
  }, [gradesByStudentId, isQuizSession, questions, studentResults]);

  useEffect(() => {
    if (!courseId || !sessionId) return undefined;
    let mounted = true;
    const load = () => apiClient.get(`/ai/courses/${courseId}/sessions/${sessionId}/ai-grading`)
      .then(({ data }) => {
        if (!mounted) return;
        const job = data.job || null;
        const previousStatus = previousAiGradingStatusRef.current;
        const previousCompleted = previousAiGradingCompletedRef.current;
        const completed = Number(job?.completed) || 0;
        previousAiGradingStatusRef.current = job?.status || '';
        previousAiGradingCompletedRef.current = completed;
        setAiGradingJob((current) => (job ? {
          ...job,
          sessionLog: Object.prototype.hasOwnProperty.call(data, 'log') ? data.log : current?.sessionLog || null,
        } : null));
        if (['queued', 'running'].includes(job?.status) && completed > previousCompleted) {
          fetchSessionGrades({ background: true });
        }
        if (['completed', 'halted', 'failed'].includes(job?.status) && previousStatus !== job.status) {
          fetchSessionGrades({ background: true });
          if (job.status === 'completed') onSessionDataRefresh?.();
        }
      })
      .catch(() => {});
    load();
    const timer = setInterval(() => {
      if (aiGradingJob?.status === 'queued' || aiGradingJob?.status === 'running') load();
    }, 2500);
    return () => { mounted = false; clearInterval(timer); };
  }, [courseId, sessionId, aiGradingJob?.status, fetchSessionGrades, onSessionDataRefresh]);

  const openAiGradingReport = async () => {
    setAiGradingReportOpen(true);
    setAiGradingReportLoading(true);
    try {
      const { data } = await apiClient.get(`/ai/courses/${courseId}/sessions/${sessionId}/ai-grading`, {
        params: { includeLog: true },
      });
      setAiGradingJob((current) => (data.job ? {
        ...data.job,
        sessionLog: data.log || null,
      } : current));
    } catch (err) {
      setGlobalMessageType('error');
      setGlobalMessage(err.response?.data?.message || t('grades.aiGrading.failedLoad'));
    } finally {
      setAiGradingReportLoading(false);
    }
  };

  const haltAiGrading = async () => {
    setHaltingAiGrading(true);
    setGlobalMessage('');
    try {
      const { data } = await apiClient.post(`/ai/courses/${courseId}/sessions/${sessionId}/ai-grading/halt`);
      setAiGradingJob(data.job ? { ...data.job, sessionLog: data.log || null } : null);
      await fetchSessionGrades({ background: true });
      setAiGradingReportOpen(true);
    } catch (err) {
      setGlobalMessageType('error');
      setGlobalMessage(err.response?.data?.message || t('grades.aiGrading.failedHalt'));
    } finally {
      setHaltingAiGrading(false);
    }
  };

  const allRows = useMemo(() => {
    if (!activeQuestion) return [];
    const questionId = String(activeQuestion._id);
    const questionType = normalizeQuestionType(activeQuestion);
    const questionNeedsManualGrading = !isAutoGradeableQuestionType(questionType) && getQuestionPoints(activeQuestion) > 0;
    const eligibleStudents = studentResults.filter((student) => {
      if (isQuizSession) {
        return (student?.questionResults || []).some((result) => (
          Array.isArray(result?.responses) && result.responses.length > 0
        ));
      }
      return !!student?.inSession;
    });

    return eligibleStudents.map((student) => {
      const studentId = String(student?.studentId || '');
      const grade = gradesByStudentId[studentId] || null;
      const mark = (grade?.marks || []).find((entry) => String(entry?.questionId) === questionId) || null;
      const questionResult = (student?.questionResults || []).find(
        (result) => String(result?.questionId) === questionId
      );
      const latestResponse = getLatestResponse(questionResult?.responses || []);
      const responseSummary = buildResponseSummary(activeQuestion, latestResponse, t('grades.questionPanel.noAnswer'));
      const displayName = formatDisplayName(student, t('common.unknown'));
      const effectiveOutOf = getEffectiveQuestionOutOf(activeQuestion, mark);
      const markNeedsGrading = effectiveOutOf > 0 && !!mark?.needsGrading;
      const needsManualGrading = effectiveOutOf > 0
        && questionNeedsManualGrading
        && !!latestResponse
        && (!mark || markNeedsGrading);
      const rowNeedsGrading = markNeedsGrading || needsManualGrading;

      return {
        studentId,
        student,
        displayName,
        email: normalizeValue(student?.email),
        latestResponse,
        responseSummary,
        gradeId: normalizeValue(grade?._id),
        mark,
        needsManualGrading,
        rowNeedsGrading,
      };
    });
  }, [activeQuestion, gradesByStudentId, isQuizSession, studentResults]);

  useEffect(() => {
    const questionId = String(activeQuestionId || '');
    const questionChanged = lastDraftQuestionIdRef.current !== questionId;
    lastDraftQuestionIdRef.current = questionId;

    setDraftByStudentId((previousDrafts) => {
      const nextDrafts = {};
      allRows.forEach((row) => {
        const serverDraft = {
          points: row.mark ? String(row.mark.points ?? 0) : '',
          feedback: normalizeValue(row.mark?.feedback),
        };

        if (questionChanged) {
          nextDrafts[row.studentId] = serverDraft;
          return;
        }

        const existingDraft = previousDrafts[row.studentId];
        const shouldPreserveExistingDraft = !!existingDraft
          && !!editedStudentIds[row.studentId]
          && isDraftChangedFromMark(existingDraft, row.mark)
          && !savingByStudentId[row.studentId];
        nextDrafts[row.studentId] = shouldPreserveExistingDraft ? existingDraft : serverDraft;
      });

      return nextDrafts;
    });
  }, [activeQuestionId, allRows, editedStudentIds, savingByStudentId]);

  useEffect(() => {
    setSelectedStudentIds({});
    setEditedStudentIds({});
  }, [activeQuestionId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedAnswerQuery(answerQuery);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [answerQuery]);

  const filteredRows = useMemo(() => {
    const studentNeedle = normalizeValue(studentQuery).toLowerCase();
    const answerNeedle = normalizeComparableText(debouncedAnswerQuery);
    return allRows.filter((row) => {
      if (studentNeedle) {
        const studentHaystack = [
          normalizeValue(row.displayName),
          normalizeValue(row.email),
        ].join(' ').toLowerCase();
        if (!studentHaystack.includes(studentNeedle)) return false;
      }

      if (answerNeedle) {
        const answerHaystack = normalizeComparableText(row.responseSummary?.filterText);
        if (!answerHaystack.includes(answerNeedle)) return false;
      }

      if (showNeedsGradingOnly && !row.rowNeedsGrading) {
        return false;
      }

      if (showResponsesOnly && !row.latestResponse) {
        return false;
      }

      return true;
    });
  }, [allRows, debouncedAnswerQuery, showNeedsGradingOnly, showResponsesOnly, studentQuery]);

  const filteredStudentIds = useMemo(
    () => filteredRows.map((row) => row.studentId),
    [filteredRows]
  );

  const selectedFilteredCount = useMemo(
    () => filteredStudentIds.filter((studentId) => !!selectedStudentIds[studentId]).length,
    [filteredStudentIds, selectedStudentIds]
  );

  const sortedRows = useMemo(() => {
    const nextRows = [...filteredRows];
    const compareNullableNumber = (a, b) => {
      const aFinite = Number.isFinite(a);
      const bFinite = Number.isFinite(b);
      if (!aFinite && !bFinite) return 0;
      if (!aFinite) return 1;
      if (!bFinite) return -1;
      return a - b;
    };

    nextRows.sort((a, b) => {
      let compare = 0;
      if (tableSort.field === 'response') {
        compare = normalizeValue(a?.responseSummary?.displayText).localeCompare(
          normalizeValue(b?.responseSummary?.displayText)
        );
      } else if (tableSort.field === 'mark') {
        compare = compareNullableNumber(Number(a?.mark?.points), Number(b?.mark?.points));
      } else if (tableSort.field === 'feedback') {
        compare = normalizeValue(a?.mark?.feedback).localeCompare(normalizeValue(b?.mark?.feedback));
      } else {
        compare = normalizeValue(a?.displayName).localeCompare(normalizeValue(b?.displayName));
        if (compare === 0) {
          compare = normalizeValue(a?.email).localeCompare(normalizeValue(b?.email));
        }
      }

      return tableSort.direction === 'asc' ? compare : -compare;
    });

    return nextRows;
  }, [filteredRows, tableSort]);

  const handleTableSort = useCallback((field) => {
    setTableSort((previousSort) => {
      if (previousSort.field === field) {
        return {
          field,
          direction: previousSort.direction === 'asc' ? 'desc' : 'asc',
        };
      }
      const defaultDirection = field === 'mark' ? 'desc' : 'asc';
      return { field, direction: defaultDirection };
    });
  }, []);

  const applyUpdatedGrade = useCallback((updatedGrade) => {
    if (!updatedGrade?.userId) return;
    setGradesByStudentId((prev) => ({
      ...prev,
      [String(updatedGrade.userId)]: updatedGrade,
    }));
  }, []);

  const applyUpdatedGrades = useCallback((updatedGrades = []) => {
    const gradeEntries = (Array.isArray(updatedGrades) ? updatedGrades : [])
      .filter((grade) => grade?.userId)
      .map((grade) => [String(grade.userId), grade]);
    if (gradeEntries.length === 0) return;
    setGradesByStudentId((prev) => ({
      ...prev,
      ...Object.fromEntries(gradeEntries),
    }));
  }, []);

  const handleUpdateDraft = useCallback((studentId, updater) => {
    setDraftByStudentId((prev) => {
      const current = prev[studentId] || { points: '', feedback: '' };
      const next = typeof updater === 'function' ? updater(current) : updater;
      return { ...prev, [studentId]: next };
    });
    setEditedStudentIds((prev) => {
      if (prev[studentId]) return prev;
      return { ...prev, [studentId]: true };
    });
  }, []);

  const isRowDirty = useCallback((row) => {
    const draft = draftByStudentId[row.studentId] || { points: '', feedback: '' };
    const draftHasPoints = hasExplicitPointsValue(draft.points);
    const markHasPoints = hasExplicitPointsValue(row.mark?.points);
    const draftPoints = draftHasPoints ? Number(draft.points) : null;
    const confirmingManualGrade = !!row?.rowNeedsGrading
      && draftHasPoints
      && Number.isFinite(draftPoints)
      && draftPoints >= 0;
    if (draftHasPoints !== markHasPoints) return true;
    return confirmingManualGrade || isDraftChangedFromMark(draft, row.mark);
  }, [draftByStudentId]);

  const handleSaveRow = useCallback(async (row, draftOverride = null) => {
    if (!row?.gradeId || !row?.mark || !activeQuestionId) return;
    const persistedDraft = draftByStudentId[row.studentId] || { points: '', feedback: '' };
    const draft = draftOverride ? { ...persistedDraft, ...draftOverride } : persistedDraft;
    const parsedPoints = Number(draft.points);
    if (!Number.isFinite(parsedPoints) || parsedPoints < 0) {
      setGlobalMessage(t('grades.questionPanel.pointsInvalid'));
      setGlobalMessageType('error');
      return;
    }

    setSavingByStudentId((prev) => ({ ...prev, [row.studentId]: true }));
    try {
      const { data } = await apiClient.patch(
        `/grades/${row.gradeId}/marks/${activeQuestionId}`,
        {
          points: parsedPoints,
          feedback: draft.feedback || '',
        }
      );
      applyUpdatedGrade(data?.grade);
      setDraftByStudentId((prev) => ({
        ...prev,
        [row.studentId]: { points: String(parsedPoints), feedback: draft.feedback || '' },
      }));
      setEditedStudentIds((prev) => {
        if (!prev[row.studentId]) return prev;
        return { ...prev, [row.studentId]: false };
      });
      setGlobalMessage(t('grades.questionPanel.savedGrade', { name: row.displayName }));
      setGlobalMessageType('success');
    } catch (err) {
      setGlobalMessage(err.response?.data?.message || t('grades.questionPanel.failedSaveGrade', { name: row.displayName }));
      setGlobalMessageType('error');
    } finally {
      setSavingByStudentId((prev) => ({ ...prev, [row.studentId]: false }));
    }
  }, [activeQuestionId, applyUpdatedGrade, draftByStudentId, t]);

  const handleCancelRow = useCallback((row) => {
    if (!row?.studentId) return;
    setDraftByStudentId((prev) => ({
      ...prev,
      [row.studentId]: {
        points: row.mark ? String(row.mark.points ?? 0) : '',
        feedback: normalizeValue(row.mark?.feedback),
      },
    }));
    setEditedStudentIds((prev) => {
      if (!prev[row.studentId]) return prev;
      return { ...prev, [row.studentId]: false };
    });
  }, []);

  const handleBulkApplyPoints = useCallback(async () => {
    if (!activeQuestionId) return;
    const parsedPoints = Number(bulkPoints);
    if (!Number.isFinite(parsedPoints) || parsedPoints < 0) {
      setGlobalMessage(t('grades.questionPanel.bulkPointsInvalid'));
      setGlobalMessageType('error');
      return;
    }

    const targetRows = filteredRows.filter((row) => row.gradeId && row.mark);
    if (targetRows.length === 0) {
      setGlobalMessage(t('grades.questionPanel.noFilteredRows'));
      setGlobalMessageType('warning');
      return;
    }

    setBulkApplying(true);
    try {
      const { data } = await apiClient.patch(
        `/sessions/${sessionId}/grades/marks/${activeQuestionId}`,
        {
          gradeIds: targetRows.map((row) => row.gradeId),
          points: parsedPoints,
        }
      );
      applyUpdatedGrades(data?.grades);
      const updatedCount = Number(data?.updatedCount) || targetRows.length;
      setGlobalMessage(t('grades.questionPanel.updatedPoints', { count: updatedCount }));
      setGlobalMessageType('success');
    } catch (err) {
      setGlobalMessage(err.response?.data?.message || t('grades.questionPanel.bulkPointsFailed'));
      setGlobalMessageType('error');
    } finally {
      setBulkApplying(false);
    }
  }, [activeQuestionId, applyUpdatedGrades, bulkPoints, filteredRows, sessionId, t]);

  const handleBulkApplyFeedback = useCallback(async () => {
    if (!activeQuestionId) return;
    const targetRows = filteredRows.filter((row) => row.gradeId && row.mark);
    if (targetRows.length === 0) {
      setGlobalMessage(t('grades.questionPanel.noFilteredRows'));
      setGlobalMessageType('warning');
      return;
    }

    setBulkApplying(true);
    try {
      const { data } = await apiClient.patch(
        `/sessions/${sessionId}/grades/marks/${activeQuestionId}`,
        {
          gradeIds: targetRows.map((row) => row.gradeId),
          feedback: bulkFeedback || '',
        }
      );
      applyUpdatedGrades(data?.grades);
      const updatedCount = Number(data?.updatedCount) || targetRows.length;
      setGlobalMessage(t('grades.questionPanel.updatedFeedback', { count: updatedCount }));
      setGlobalMessageType('success');
    } catch (err) {
      setGlobalMessage(err.response?.data?.message || t('grades.questionPanel.bulkFeedbackFailed'));
      setGlobalMessageType('error');
    } finally {
      setBulkApplying(false);
    }
  }, [activeQuestionId, applyUpdatedGrades, bulkFeedback, filteredRows, sessionId, t]);

  const handleBulkSave = useCallback(async () => {
    if (!activeQuestionId) return;

    const hasPoints = bulkPoints !== '';
    const hasFeedback = bulkFeedback !== '';
    if (!hasPoints && !hasFeedback) return;

    if (hasPoints) {
      const parsedPoints = Number(bulkPoints);
      if (!Number.isFinite(parsedPoints) || parsedPoints < 0) {
        setGlobalMessage(t('grades.questionPanel.bulkPointsInvalid'));
        setGlobalMessageType('error');
        return;
      }
    }

    const targetRows = filteredRows.filter((row) => row.gradeId && row.mark && selectedStudentIds[row.studentId]);
    if (targetRows.length === 0) {
      setGlobalMessage(t('grades.questionPanel.noSelectedRows'));
      setGlobalMessageType('warning');
      return;
    }

    setBulkApplying(true);
    try {
      const payload = {
        gradeIds: targetRows.map((row) => row.gradeId),
      };
      if (hasPoints) payload.points = Number(bulkPoints);
      if (hasFeedback) payload.feedback = bulkFeedback;
      const { data } = await apiClient.patch(
        `/sessions/${sessionId}/grades/marks/${activeQuestionId}`,
        payload
      );
      applyUpdatedGrades(data?.grades);
      const updatedCount = Number(data?.updatedCount) || targetRows.length;
      setGlobalMessage(t('grades.questionPanel.bulkSaveSuccess', { count: updatedCount }));
      setGlobalMessageType('success');
    } catch (err) {
      setGlobalMessage(err.response?.data?.message || t('grades.questionPanel.bulkSaveFailed'));
      setGlobalMessageType('error');
    } finally {
      setBulkApplying(false);
    }
  }, [activeQuestionId, applyUpdatedGrades, bulkPoints, bulkFeedback, filteredRows, selectedStudentIds, sessionId, t]);

  const handleToggleRowSelected = useCallback((studentId, checked) => {
    setSelectedStudentIds((prev) => {
      if (checked) return { ...prev, [studentId]: true };
      const next = { ...prev };
      delete next[studentId];
      return next;
    });
  }, []);

  const handleToggleSelectAllFiltered = useCallback((checked) => {
    setSelectedStudentIds((prev) => {
      const next = { ...prev };
      filteredStudentIds.forEach((studentId) => {
        if (checked) {
          next[studentId] = true;
        } else {
          delete next[studentId];
        }
      });
      return next;
    });
  }, [filteredStudentIds]);

  const handleRecalculateAll = useCallback(async (missingOnly = false) => {
    if (!sessionId) return;
    setRecalculating(true);
    try {
      const { data } = await apiClient.post(`/sessions/${sessionId}/grades/recalculate`, {
        missingOnly,
      });
      const warnings = data?.summary?.warnings || [];
      if (warnings.length > 0) {
        setGlobalMessage(warnings.join(' '));
        setGlobalMessageType('warning');
      } else {
        setGlobalMessage(t('grades.questionPanel.gradesRecalculated'));
        setGlobalMessageType('success');
      }
      if (typeof onSessionDataRefresh === 'function') {
        await onSessionDataRefresh();
      }
      await fetchSessionGrades();
    } catch (err) {
      setGlobalMessage(err.response?.data?.message || t('grades.questionPanel.failedRecalculate'));
      setGlobalMessageType('error');
    } finally {
      setRecalculating(false);
    }
  }, [fetchSessionGrades, onSessionDataRefresh, sessionId, t]);

  const handleOpenQuestionPointsDialog = useCallback(() => {
    const parsedPoints = Number(questionPointsDraft);
    if (!Number.isFinite(parsedPoints) || parsedPoints < 0) {
      setGlobalMessage(t('grades.questionPanel.pointsInvalid'));
      setGlobalMessageType('error');
      return;
    }

    if (!activeQuestion?._id || Math.abs(parsedPoints - getQuestionPoints(activeQuestion)) < 0.0001) {
      return;
    }

    setQuestionPointsDialogOpen(true);
  }, [activeQuestion, questionPointsDraft, t]);

  const handleConfirmQuestionPointsUpdate = useCallback(async () => {
    if (!activeQuestion?._id || !sessionId) return;

    const nextPoints = Number(questionPointsDraft);
    if (!Number.isFinite(nextPoints) || nextPoints < 0) {
      setGlobalMessage(t('grades.questionPanel.pointsInvalid'));
      setGlobalMessageType('error');
      return;
    }

    setQuestionPointsSaving(true);
    try {
      await apiClient.patch(`/questions/${activeQuestion._id}`, {
        sessionOptions: buildSessionOptionsPayload(activeQuestion.sessionOptions, nextPoints),
      });

      const { data } = await apiClient.post(`/sessions/${sessionId}/grades/recalculate`, {
        missingOnly: false,
      });
      const warnings = data?.summary?.warnings || [];

      if (typeof onSessionDataRefresh === 'function') {
        await onSessionDataRefresh();
      }
      await fetchSessionGrades();
      setQuestionPointsDialogOpen(false);

      if (warnings.length > 0) {
        setGlobalMessage(warnings.join(' '));
        setGlobalMessageType('warning');
      } else {
        setGlobalMessage(t('grades.questionPanel.questionPointsUpdated'));
        setGlobalMessageType('success');
      }
    } catch (err) {
      setGlobalMessage(err.response?.data?.message || t('grades.questionPanel.failedUpdateQuestionPoints'));
      setGlobalMessageType('error');
    } finally {
      setQuestionPointsSaving(false);
    }
  }, [activeQuestion, fetchSessionGrades, onSessionDataRefresh, questionPointsDraft, sessionId, t]);

  // --- Speed-grading helpers ---

  const handleOpenSpeedGrading = useCallback(() => {
    const hasSelected = sortedRows.some((row) => !!selectedStudentIds[row.studentId]);
    const rowsForModal = hasSelected
      ? sortedRows.filter((row) => !!selectedStudentIds[row.studentId])
      : sortedRows;
    if (rowsForModal.length === 0) return;

    const snapshotRows = rowsForModal.map((row) => {
      const draft = draftByStudentId[row.studentId] || null;
      const draftPoints = Number(draft?.points);
      const draftFeedback = draft?.feedback || '';
      const pointsOverridden = !!draft
        && !arePointValuesEqual(draft.points, row.mark?.points)
        && hasExplicitPointsValue(draft.points)
        && Number.isFinite(draftPoints)
        && draftPoints >= 0;
      const feedbackOverridden = !!draft
        && normalizeValue(draftFeedback) !== normalizeValue(row.mark?.feedback);

      return {
        ...row,
        mark: row.mark
          ? {
            ...row.mark,
            points: pointsOverridden ? draftPoints : row.mark.points,
            feedback: feedbackOverridden ? draftFeedback : row.mark.feedback,
          }
          : row.mark,
      };
    });

    setSpeedGradingRowsSnapshot(snapshotRows);
    setSpeedGradingOpen(true);
  }, [draftByStudentId, selectedStudentIds, sortedRows]);

  const handleCloseSpeedGrading = useCallback(() => {
    setSpeedGradingOpen(false);
    setSpeedGradingRowsSnapshot([]);
  }, []);

  const handleSpeedGradingSave = useCallback(async (row, { points, feedback }) => {
    if (!row?.gradeId || !row?.mark || !activeQuestionId) {
      setGlobalMessage(t('grades.questionPanel.noGradeItem'));
      setGlobalMessageType('warning');
      throw new Error('Missing grade data');
    }
    try {
      const { data } = await apiClient.patch(
        `/grades/${row.gradeId}/marks/${activeQuestionId}`,
        { points, feedback }
      );
      applyUpdatedGrade(data?.grade);
      // Also update the local draft to keep the table in sync
      if (row.studentId) {
        setDraftByStudentId((prev) => ({
          ...prev,
          [row.studentId]: { points: String(points), feedback },
        }));
        setEditedStudentIds((prev) => {
          if (!prev[row.studentId]) return prev;
          return { ...prev, [row.studentId]: false };
        });
      }
      setSpeedGradingRowsSnapshot((prev) => prev.map((entry) => {
        if (entry.studentId !== row.studentId) return entry;
        return {
          ...entry,
          mark: entry.mark
            ? { ...entry.mark, points, feedback, needsGrading: false }
            : entry.mark,
        };
      }));
      setGlobalMessage(t('grades.questionPanel.savedGrade', { name: row.displayName }));
      setGlobalMessageType('success');
    } catch (err) {
      setGlobalMessage(err.response?.data?.message || t('grades.questionPanel.failedSaveGrade', { name: row.displayName }));
      setGlobalMessageType('error');
      throw err;
    }
  }, [activeQuestionId, applyUpdatedGrade, t]);

  if (loading) {
    return (
      <Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert
        severity="error"
        action={(
          <Button size="small" color="inherit" onClick={fetchSessionGrades}>
            {t('common.retry')}
          </Button>
        )}
      >
        {error}
      </Alert>
    );
  }

  if (!questions.length) {
    return <Alert severity="info">{t('grades.questionPanel.noQuestions')}</Alert>;
  }

  if (!activeQuestion) {
    return <Alert severity="info">{t('grades.questionPanel.selectQuestion')}</Alert>;
  }

  const activeQuestionType = normalizeQuestionType(activeQuestion);
  const activeQuestionPoints = getQuestionPoints(activeQuestion);
  const hasSolution = !!normalizeValue(activeQuestion.solution);
  const correctAnswerSummary = formatCorrectAnswerSummary(activeQuestion, {
    manualGradingRequired: t('grades.questionPanel.manualGradingRequired'),
  });
  const optionTypeQuestion = [
    QUESTION_TYPES.MULTIPLE_CHOICE,
    QUESTION_TYPES.TRUE_FALSE,
    QUESTION_TYPES.MULTI_SELECT,
  ].includes(activeQuestionType);
  const questionOptions = Array.isArray(activeQuestion.options) ? activeQuestion.options : [];
  const correctOptionEntries = optionTypeQuestion
    ? questionOptions
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => isCorrectOption(option))
    : [];
  const displayedStudentHint = isQuizSession
    ? t('grades.questionPanel.showingStudentsQuiz', { showing: sortedRows.length, total: allRows.length })
    : t('grades.questionPanel.showingStudentsSession', { showing: sortedRows.length, total: allRows.length });
  const allFilteredSelected = filteredStudentIds.length > 0 && selectedFilteredCount === filteredStudentIds.length;
  const someFilteredSelected = selectedFilteredCount > 0 && !allFilteredSelected;
  const questionNeedsManualGrading = !isAutoGradeableQuestionType(activeQuestionType) && activeQuestionPoints > 0;
  const parsedQuestionPointsDraft = Number(questionPointsDraft);
  const questionPointsDirty = Number.isFinite(parsedQuestionPointsDraft)
    && parsedQuestionPointsDraft >= 0
    && Math.abs(parsedQuestionPointsDraft - activeQuestionPoints) > 0.0001;

  const renderQuestionRibbon = () => (
    <Box
      component="nav"
      aria-label={t('grades.questionPanel.questionNavigator')}
      sx={{
        display: 'flex',
        mb: 1.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        p: 1,
        position: 'relative',
      }}
    >
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          position: 'absolute',
          top: -10,
          left: 8,
          px: 0.5,
          bgcolor: 'background.paper',
          fontWeight: 700
        }}>
        {t('grades.questionPanel.questionNavigator')}
      </Typography>
      <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
        {questionStatuses.map((entry) => {
          const isActive = entry.questionId === activeQuestionId;
          const needsGrading = entry.needsGradingCount > 0;
          return (
            <Chip
              key={entry.questionId}
              clickable
              onClick={() => {
                setActiveQuestionId(entry.questionId);
                setShowSolution(false);
              }}
              label={needsGrading ? `${entry.label} (${entry.needsGradingCount})` : entry.label}
              color={needsGrading ? 'error' : 'success'}
              variant={isActive ? 'filled' : 'outlined'}
              sx={COMPACT_CHIP_SX}
            />
          );
        })}
      </Box>
    </Box>
  );

  const aiGradingLogRuns = aiGradingJob?.sessionLog?.runs
    ?? [{ startedAt: aiGradingJob?.createdAt, entries: aiGradingJob?.log || [] }];
  const inappropriateAiResponses = aiGradingLogRuns.flatMap((run) => (run.entries || [])
    .filter((entry) => entry.inappropriate?.quote)
    .map((entry) => ({ ...entry.inappropriate, student: entry.student, question: entry.question })));

  return (
    <Box>
      {globalMessage ? (
        <Alert severity={globalMessageType} sx={{ mb: 1.5 }} onClose={() => setGlobalMessage('')}>
          {globalMessage}
        </Alert>
      ) : null}

      {gradingLocked && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          {t(`grades.questionPanel.${gradingLockReason === 'extensions' ? 'gradingLockedExtensions'
            : gradingLockReason === 'missing-grades' ? 'gradingLockedMissingGrades' : 'gradingLockedUntilEnded'}`)}
          {gradingLockReason === 'missing-grades' && (
            <Button size="small" onClick={() => handleRecalculateAll(true)} disabled={recalculating} sx={{ ml: 1 }}>
              {t('grades.questionPanel.createGradeItems')}
            </Button>
          )}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderColor: 'primary.main', borderLeftWidth: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            {t('grades.questionPanel.questionNumber', { number: questions.findIndex((question) => String(question?._id) === activeQuestionId) + 1 })}
          </Typography>
          <Chip
            label={getQuestionTypeLabel(t, activeQuestionType, {
              key: 'grades.coursePanel.question',
              defaultValue: 'Question',
            })}
            color={TYPE_COLORS[activeQuestionType] || 'default'}
            size="small"
            sx={COMPACT_CHIP_SX}
          />
          <Chip
            label={t('grades.questionPanel.pointsValue', { count: activeQuestionPoints })}
            size="small"
            variant="outlined"
            sx={COMPACT_CHIP_SX}
          />
        </Box>

        <RichContent html={activeQuestion.content} fallback={activeQuestion.plainText} allowVideoEmbeds />

        <Box sx={{ mt: 1.25, display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            size="small"
            type="number"
            label={t('grades.questionPanel.questionPoints')}
            value={questionPointsDraft}
            onChange={(event) => setQuestionPointsDraft(event.target.value)}
            sx={{ width: 160 }}
            disabled={gradingLocked}
            slotProps={{
              htmlInput: { min: 0, step: 'any' }
            }}
          />
          <Button
            size="small"
            variant="outlined"
            onClick={handleOpenQuestionPointsDialog}
            disabled={gradingLocked || !questionPointsDirty || questionPointsSaving || recalculating}
          >
            {questionPointsSaving ? t('common.saving') : t('grades.questionPanel.updateQuestionPoints')}
          </Button>
          <Typography variant="caption" sx={{
            color: "text.secondary"
          }}>
            {t('grades.questionPanel.updateQuestionPointsHelp')}
          </Typography>
        </Box>

        {optionTypeQuestion && questionOptions.length > 0 && (
          <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            {questionOptions.map((option, index) => {
              const isCorrect = isCorrectOption(option);
              const optionContent = getOptionRichContentProps(option);
              return (
                <Paper
                  key={option?._id || index}
                  variant="outlined"
                  sx={{
                    p: 0.85,
                    borderColor: isCorrect ? 'success.main' : 'divider',
                    bgcolor: isCorrect ? 'success.50' : 'transparent',
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75 }}>
                    <Chip
                      label={OPTION_LETTERS[index] || String(index + 1)}
                      size="small"
                      color={isCorrect ? 'success' : 'default'}
                      sx={COMPACT_CHIP_SX}
                    />
                    <Box sx={{ minWidth: 0 }}>
                      <RichContent html={optionContent.html} fallback={optionContent.fallback} />
                    </Box>
                  </Box>
                </Paper>
              );
            })}
          </Box>
        )}

        <Box sx={{ mt: 1, display: 'flex', alignItems: 'flex-start', gap: 0.75, flexWrap: 'wrap' }}>
          <Typography variant="body2" component="span" sx={{ fontWeight: 700 }}>
            {t('grades.questionPanel.correctAnswer')}
          </Typography>
          {optionTypeQuestion ? (
            correctOptionEntries.length > 0 ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0 }}>
                {correctOptionEntries.map(({ option, index }) => {
                  const optionContent = getOptionRichContentProps(option);
                  return (
                    <Box
                      key={option?._id || index}
                      sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, minWidth: 0 }}
                    >
                      <Typography variant="body2" component="span" sx={{ fontWeight: 700 }}>
                        {OPTION_LETTERS[index] || String(index + 1)}:
                      </Typography>
                      <RichContent html={optionContent.html} fallback={optionContent.fallback} />
                    </Box>
                  );
                })}
              </Box>
            ) : (
              <Typography variant="body2" component="span">
                {t('grades.questionPanel.noCorrectOption')}
              </Typography>
            )
          ) : (
            <Typography variant="body2" component="span">{correctAnswerSummary}</Typography>
          )}
        </Box>

        {hasSolution && (
          <Box sx={{ mt: 1 }}>
            <Button size="small" variant="outlined" onClick={() => setShowSolution((prev) => !prev)}>
              {showSolution ? t('grades.questionPanel.hideSolution') : t('grades.questionPanel.showSolution')}
            </Button>
            {showSolution && (
              <Paper variant="outlined" sx={{ mt: 1, p: 1.25 }}>
                <Typography variant="subtitle2" sx={{ mb: 0.5, fontWeight: 700 }}>
                  {t('common.solution')}
                </Typography>
                <RichContent html={activeQuestion.solution} fallback={activeQuestion.solution_plainText} />
              </Paper>
            )}
          </Box>
        )}
      </Paper>

      {renderQuestionRibbon()}
      <Divider sx={{ mb: 1.5 }} />

      <Paper variant="outlined" sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, p: 1.25, bgcolor: 'action.hover', borderColor: 'primary.light', flexWrap: 'wrap' }}>
        {['queued', 'running'].includes(aiGradingJob?.status) ? (
          <>
            <Box sx={{ minWidth: 320, flex: 1 }}><Typography variant="body2" sx={{ mb: 0.5 }}>{t('grades.aiGrading.inProgress', { student: aiGradingJob.currentStudent || 0, students: aiGradingJob.studentTotal || 0, question: aiGradingJob.currentQuestion || 0, questions: aiGradingJob.questionTotal || 0 })}</Typography><LinearProgress variant="determinate" value={aiGradingJob.total ? Math.round((aiGradingJob.completed || 0) / aiGradingJob.total * 100) : 0} /></Box>
            <Button color="warning" variant="outlined" disabled={haltingAiGrading} onClick={haltAiGrading}>
              {haltingAiGrading ? t('grades.aiGrading.halting') : t('grades.aiGrading.halt')}
            </Button>
          </>
        ) : (
          <Button variant="outlined" onClick={() => setAiGradingOpen(true)} disabled={gradingLocked}>
            {t('grades.aiGrading.assistant')}
          </Button>
        )}
        {['completed', 'failed', 'halted'].includes(aiGradingJob?.status) ? <Button variant="outlined" onClick={openAiGradingReport}>{t('grades.aiGrading.report')}</Button> : null}
        {aiGradingJob?.status === 'failed' ? <Alert severity="warning" sx={{ py: 0 }}>{t('grades.aiGrading.failedReportNotice')}</Alert> : null}
        {aiGradingJob?.status === 'halted' ? <Alert severity="info" sx={{ py: 0 }}>{t('grades.aiGrading.haltedReportNotice')}</Alert> : null}
      </Paper>

      <Paper variant="outlined" sx={{ p: 1.25, mb: 1.5 }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          {t('grades.questionPanel.bulkUpdateSelected', {
            selected: selectedFilteredCount,
            filtered: filteredRows.length,
          })}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
          <TextField
            size="small"
            type="number"
            label={t('grades.questionPanel.bulkPoints')}
            value={bulkPoints}
            onChange={(event) => setBulkPoints(event.target.value)}
            sx={{ width: 140 }}
            disabled={gradingLocked || bulkApplying}
          />
          <TextField
            size="small"
            label={t('grades.questionPanel.bulkFeedback')}
            value={bulkFeedback}
            onChange={(event) => setBulkFeedback(event.target.value)}
            sx={{ minWidth: 260, flex: 1 }}
            disabled={gradingLocked || bulkApplying}
          />
          <Button
            size="small"
            variant="contained"
            onClick={handleBulkSave}
            disabled={gradingLocked || bulkApplying || (!bulkPoints && !bulkFeedback) || selectedFilteredCount === 0}
          >
            {bulkApplying ? t('common.saving') : t('common.save')}
          </Button>
        </Box>
      </Paper>

      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.25, alignItems: 'center' }}>
        <TextField
          size="small"
          label={t('grades.questionPanel.searchStudents')}
          value={studentQuery}
          onChange={(event) => setStudentQuery(event.target.value)}
          sx={{ minWidth: 220 }}
        />
        {filterSlot}
        <TextField
          size="small"
          label={t('grades.questionPanel.searchAnswerContent')}
          value={answerQuery}
          onChange={(event) => setAnswerQuery(event.target.value)}
          sx={{ minWidth: 260, flex: 1 }}
        />
        <Button
          size="small"
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={() => handleRecalculateAll()}
          disabled={gradingLocked || recalculating}
        >
          {t('grades.questionPanel.recalculateGrades')}
        </Button>
        <FormControlLabel
          control={(
            <Checkbox
              size="small"
              checked={showNeedsGradingOnly}
              onChange={(event) => setShowNeedsGradingOnly(event.target.checked)}
            />
          )}
          label={t('grades.questionPanel.onlyNeedsGrading')}
          sx={{ ml: { xs: 0, sm: 0.5 } }}
        />
        <FormControlLabel
          control={(
            <Checkbox
              size="small"
              checked={showResponsesOnly}
              onChange={(event) => setShowResponsesOnly(event.target.checked)}
            />
          )}
          label={t('grades.questionPanel.onlyWithResponses')}
          sx={{ ml: { xs: 0, sm: 0.5 } }}
        />
      </Box>

      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          display: 'block',
          mb: 1.25
        }}>
        {displayedStudentHint}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          display: 'block',
          mb: 1.25
        }}>
        {t('grades.questionPanel.feedbackMathTip')}
      </Typography>

      {questionNeedsManualGrading && sortedRows.length > 0 && (
        <Box sx={{ mb: 1.25 }}>
          <Tooltip title={t('grades.questionPanel.speedGrading.buttonTooltip')} arrow>
            <span>
              <Button
                size="small"
                variant="outlined"
                startIcon={<SpeedIcon />}
                onClick={handleOpenSpeedGrading}
                disabled={gradingLocked}
              >
                {t('grades.questionPanel.speedGrading.buttonLabel')}
              </Button>
            </span>
          </Tooltip>
        </Box>
      )}

      <TableContainer component={Paper} variant="outlined">
        <Table
          size="small"
          aria-label={t('grades.questionPanel.questionGradingTable')}
          sx={{
            '& .MuiTableCell-root': {
              px: 0.55,
              py: 0.45,
              verticalAlign: 'top',
            },
          }}
        >
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox" sx={{ width: 46 }}>
                <Checkbox
                  size="small"
                  checked={allFilteredSelected}
                  indeterminate={someFilteredSelected}
                  disabled={filteredStudentIds.length === 0}
                  onChange={(event) => handleToggleSelectAllFiltered(event.target.checked)}
                  slotProps={{
                    input: {
                      'aria-label': t('grades.questionPanel.selectAllFiltered', { count: filteredStudentIds.length }),
                    }
                  }}
                />
              </TableCell>
              <TableCell sx={{ fontWeight: 700, minWidth: 150 }}>
                <TableSortLabel
                  active={tableSort.field === 'student'}
                  direction={tableSort.field === 'student' ? tableSort.direction : 'asc'}
                  onClick={() => handleTableSort('student')}
                >
                  {t('grades.coursePanel.student')}
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ fontWeight: 700, minWidth: 190 }}>
                <TableSortLabel
                  active={tableSort.field === 'response'}
                  direction={tableSort.field === 'response' ? tableSort.direction : 'asc'}
                  onClick={() => handleTableSort('response')}
                >
                  {t('grades.questionPanel.response')}
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ fontWeight: 700, minWidth: 132 }}>
                <TableSortLabel
                  active={tableSort.field === 'mark'}
                  direction={tableSort.field === 'mark' ? tableSort.direction : 'desc'}
                  onClick={() => handleTableSort('mark')}
                >
                  {t('grades.questionPanel.mark')}
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ fontWeight: 700, minWidth: 180 }}>
                <TableSortLabel
                  active={tableSort.field === 'feedback'}
                  direction={tableSort.field === 'feedback' ? tableSort.direction : 'asc'}
                  onClick={() => handleTableSort('feedback')}
                >
                  {t('grades.coursePanel.feedback')}
                </TableSortLabel>
              </TableCell>
              <TableCell sx={{ fontWeight: 700, minWidth: 80 }} align="right">{t('grades.questionPanel.action')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sortedRows.map((row) => {
              const draft = draftByStudentId[row.studentId] || { points: '', feedback: '' };
              const saving = !!savingByStudentId[row.studentId];
              const rowDisabled = gradingLocked || !row.gradeId || !row.mark;
              const rowDirty = isRowDirty(row);

              return (
                <GradingTableRow
                  key={row.studentId}
                  row={row}
                  draft={draft}
                  saving={saving}
                  rowDisabled={rowDisabled}
                  rowDirty={rowDirty}
                  selected={!!selectedStudentIds[row.studentId]}
                  onToggleSelected={handleToggleRowSelected}
                  onUpdateDraft={handleUpdateDraft}
                  onSave={handleSaveRow}
                  onCancel={handleCancelRow}
                  onOpenImage={setImageViewUrl}
                  t={t}
                />
              );
            })}
            {sortedRows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    {t('grades.questionPanel.noStudentsMatch')}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={!!imageViewUrl} onClose={() => setImageViewUrl('')} maxWidth="md" fullWidth>
        <DialogTitle>{t('grades.questionPanel.profileImage')}</DialogTitle>
        <DialogContent dividers>
          {imageViewUrl ? (
            <Box
              component="img"
              src={imageViewUrl}
              alt={t('grades.questionPanel.profileImage')}
              sx={{ width: '100%', maxHeight: 540, objectFit: 'contain', display: 'block' }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={questionPointsDialogOpen}
        onClose={() => (questionPointsSaving ? undefined : setQuestionPointsDialogOpen(false))}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{t('grades.questionPanel.confirmQuestionPointsTitle')}</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            {t('grades.questionPanel.confirmQuestionPointsMessage', {
              current: formatPercent(activeQuestionPoints),
              next: formatPercent(parsedQuestionPointsDraft),
            })}
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mt: 1.25
            }}>
            {t('grades.questionPanel.confirmQuestionPointsHelp')}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setQuestionPointsDialogOpen(false)} disabled={questionPointsSaving}>
            {t('common.cancel')}
          </Button>
          <Button variant="contained" onClick={handleConfirmQuestionPointsUpdate} disabled={questionPointsSaving}>
            {questionPointsSaving ? t('common.saving') : t('common.proceed')}
          </Button>
        </DialogActions>
      </Dialog>

      <SpeedGradingModal
        open={speedGradingOpen}
        onClose={handleCloseSpeedGrading}
        rows={speedGradingRowsSnapshot}
        initialIndex={0}
        activeQuestionId={activeQuestionId}
        onSaveGrade={handleSpeedGradingSave}
        formatOutOf={(mark) => t('grades.questionPanel.outOf', { value: formatPercent(mark?.outOf || 0) })}
      />
      <AiGradingModal
        open={aiGradingOpen}
        onClose={() => setAiGradingOpen(false)}
        courseId={courseId}
        sessionId={sessionId}
        questions={questions}
        needsGradingQuestionIds={questionStatuses.filter((entry) => entry.needsGradingCount > 0).map((entry) => entry.questionId)}
        onStarted={setAiGradingJob}
      />
      <Dialog open={aiGradingReportOpen} onClose={() => setAiGradingReportOpen(false)} fullWidth maxWidth="md">
        <DialogTitle>{t('grades.aiGrading.report')}</DialogTitle>
        <DialogContent dividers>
          {aiGradingReportLoading ? <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}><CircularProgress /></Box> : null}
          {aiGradingJob?.status === 'failed' ? <Alert severity="warning" sx={{ mb: 2 }}>{t('grades.aiGrading.failedReportNotice')}{aiGradingJob?.error ? ` ${t('grades.aiGrading.failedReportError', { error: aiGradingJob.error })}` : ''}</Alert> : aiGradingJob?.status === 'halted' ? <Alert severity="info" sx={{ mb: 2 }}>{aiGradingJob?.report?.summary || t('grades.aiGrading.halted')}</Alert> : <Typography sx={{ mb: 2 }}>{aiGradingJob?.report?.summary || t('grades.aiGrading.completed')}</Typography>}
          {(aiGradingJob?.report?.summaries || []).map((summary) => <Typography key={summary.question} variant="body2" sx={{ mb: 0.5 }}>{t('grades.aiGrading.reportSummary', { question: summary.question, graded: summary.graded, zeroed: summary.zeroed })}</Typography>)}
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}><Typography variant="subtitle2">{t('grades.aiGrading.log')}</Typography><Button size="small" color="error" onClick={async () => { await apiClient.delete(`/ai/courses/${courseId}/sessions/${sessionId}/ai-grading-log`); setAiGradingJob((current) => current ? { ...current, sessionLog: { runs: [] } } : current); }}>{t('grades.aiGrading.clearLog')}</Button></Box>
          {aiGradingLogRuns.map((run, runIndex) => <Box key={run.jobId || runIndex} sx={{ mb: 2 }}><Typography variant="caption" sx={{
            color: "text.secondary"
          }}>{t('grades.aiGrading.logRunAt', { timestamp: run.startedAt ? new Date(run.startedAt).toLocaleString() : '' })}</Typography>{(run.entries || []).map((entry, index) => <Paper key={index} variant="outlined" sx={{ p: 1, mb: 1 }}>{entry.question || entry.student ? <Typography variant="subtitle2">{[entry.question, entry.student].filter(Boolean).join(' · ')}</Typography> : null}{entry.status !== 'skipped' && entry.points !== undefined ? <Typography variant="body2">{t('grades.aiGrading.assignedGrade', { points: entry.points, outOf: entry.outOf })}</Typography> : null}{entry.note ? <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mt: 0.5 }}>{entry.note}</Typography> : null}{entry.justification ? <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mt: 0.5 }}><strong>{t('grades.aiGrading.justification')}:</strong> {entry.justification}</Typography> : null}{entry.feedback ? <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', mt: 0.5 }}>{entry.feedback}</Typography> : null}</Paper>)}</Box>)}
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle2" sx={{ mb: 1 }}>{t('grades.aiGrading.inappropriateResponses')}</Typography>
          {inappropriateAiResponses.length ? inappropriateAiResponses.map((entry, index) => <Alert key={`${entry.question}-${entry.student}-${index}`} severity="warning" sx={{ mb: 1 }}><Typography variant="subtitle2">{[entry.question, entry.student].filter(Boolean).join(' · ')}</Typography><Typography variant="body2">“{entry.quote}”</Typography>{entry.reason ? <Typography variant="caption">{entry.reason}</Typography> : null}</Alert>) : <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>{t('grades.aiGrading.noInappropriateResponses')}</Typography>}
        </DialogContent>
        <DialogActions><Button onClick={() => setAiGradingReportOpen(false)}>{t('common.close')}</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
