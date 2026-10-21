import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  AutoFixHigh as AutoFixHighIcon,
  Download as DownloadIcon,
  Edit as EditIcon,
  Refresh as RefreshIcon,
  RateReview as ReviewIcon,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';
import StudentIdentity from '../common/StudentIdentity';
import StudentRichTextEditor, { MathPreview } from '../questions/StudentRichTextEditor';
import QuestionDisplay from '../questions/QuestionDisplay';
import {
  TYPE_COLORS,
  getQuestionTypeLabel,
  normalizeQuestionType,
} from '../questions/constants';
import { getLatestResponse } from '../../utils/responses';

function normalizeAnswerValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function escapeCsvCell(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
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

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return String(Math.round(numeric * 10) / 10);
}

function buildSortValueForField(row, field) {
  if (field === 'name') {
    return normalizeAnswerValue(row?.studentSortLastName).toLowerCase();
  }
  if (field === 'email') {
    return normalizeAnswerValue(row?.studentSortEmail).toLowerCase();
  }
  if (field === 'avgParticipation' || field === 'avgGrade') {
    return Number(row?.[field]) || 0;
  }

  if (field.endsWith('_smark')) {
    const sessionId = field.replace('_smark', '');
    const grade = row?.gradeBySession?.[sessionId];
    return Number(grade?.value) || 0;
  }

  if (field.endsWith('_spart')) {
    const sessionId = field.replace('_spart', '');
    const grade = row?.gradeBySession?.[sessionId];
    return Number(grade?.participation) || 0;
  }

  return 0;
}

function buildStudentSearchIndex(student = {}) {
  return [
    normalizeAnswerValue(student?.firstname),
    normalizeAnswerValue(student?.lastname),
    normalizeAnswerValue(student?.email),
    normalizeAnswerValue(student?.displayName),
  ]
    .join(' ')
    .toLowerCase();
}

function normalizeGradeRows(rows = []) {
  return rows.map((row) => {
    const gradeBySession = {};
    (row.grades || []).forEach((grade) => {
      gradeBySession[String(grade.sessionId)] = grade;
    });

    return {
      ...row,
      gradeBySession,
      studentSortLastName: normalizeAnswerValue(row?.student?.lastname),
      studentSortFirstName: normalizeAnswerValue(row?.student?.firstname),
      studentSortEmail: normalizeAnswerValue(row?.student?.email),
      studentSearchIndex: buildStudentSearchIndex(row?.student),
    };
  });
}

function getSessionSortTime(session) {
  const status = normalizeAnswerValue(session?.status);
  const isQuiz = !!(session?.quiz || session?.practiceQuiz);
  let candidate = session?.date || session?.createdAt || session?.quizStart || session?.quizEnd;

  if (isQuiz && status === 'visible') {
    candidate = session?.quizStart || session?.date || session?.createdAt || session?.quizEnd;
  } else if (isQuiz && status === 'done') {
    candidate = session?.quizEnd || session?.date || session?.quizStart || session?.createdAt;
  } else if (isQuiz) {
    candidate = session?.quizStart || session?.date || session?.createdAt || session?.quizEnd;
  }

  const timestamp = new Date(candidate || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getSessionSortBucket(session) {
  const status = normalizeAnswerValue(session?.status);
  if (status === 'running') return 0;
  if (status === 'hidden') return 1;
  if (status === 'visible') return 2;
  if (status === 'done') return 3;
  return 4;
}

function buildFilteredSortedRows(rows, searchTerm, sort) {
  const normalizedSearch = normalizeAnswerValue(searchTerm).toLowerCase();
  const filteredRows = normalizedSearch
    ? rows.filter((row) => normalizeAnswerValue(row?.studentSearchIndex).includes(normalizedSearch))
    : rows;

  const nextRows = [...filteredRows];
  nextRows.sort((a, b) => {
    const aValue = buildSortValueForField(a, sort.field);
    const bValue = buildSortValueForField(b, sort.field);
    let compare = 0;
    if (typeof aValue === 'number' && typeof bValue === 'number') {
      compare = aValue - bValue;
    } else {
      compare = String(aValue).localeCompare(String(bValue));
    }

    if (sort.field === 'name' && compare === 0) {
      compare = normalizeAnswerValue(a?.studentSortFirstName)
        .localeCompare(normalizeAnswerValue(b?.studentSortFirstName));
      if (compare === 0) {
        compare = normalizeAnswerValue(a?.studentSortEmail)
          .localeCompare(normalizeAnswerValue(b?.studentSortEmail));
      }
    }

    return sort.direction === 'asc' ? compare : -compare;
  });

  return nextRows;
}

const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const QUESTION_TYPES = {
  MULTIPLE_CHOICE: 0,
  TRUE_FALSE: 1,
  SHORT_ANSWER: 2,
  MULTI_SELECT: 3,
  NUMERICAL: 4,
};
const AUTO_GRADEABLE_QUESTION_TYPES = new Set([
  QUESTION_TYPES.MULTIPLE_CHOICE,
  QUESTION_TYPES.TRUE_FALSE,
  QUESTION_TYPES.MULTI_SELECT,
  QUESTION_TYPES.NUMERICAL,
]);

function collectAnswerEntries(answer) {
  if (answer === undefined || answer === null) return [];
  if (Array.isArray(answer)) return answer;
  if (typeof answer === 'string') {
    const trimmed = answer.trim();
    if (!trimmed) return [];

    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== answer) return collectAnswerEntries(parsed);
      } catch {
        // Fall through.
      }
    }

    if (/[|,;]/.test(trimmed) && !/<[^>]*>/.test(trimmed)) {
      return trimmed.split(/[|,;]/).map((entry) => entry.trim()).filter(Boolean);
    }
  }
  return [answer];
}

function resolveOptionIndex(answer, options = []) {
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

  return options.findIndex((option) => {
    const optionId = normalizeAnswerValue(option?._id).toLowerCase();
    const optionValue = normalizeAnswerValue(
      option?.content
      || option?.plainText
      || option?.text
      || option?.label
      || option?.answer
      || ''
    ).toLowerCase();
    return optionId === normalized || optionValue === normalized;
  });
}

function isCorrectOption(option) {
  const value = option?.correct;
  if (value === true || value === 1 || value === '1') return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return Boolean(value);
}

function formatAnswerValue(question, answer) {
  if (!question) return normalizeAnswerValue(answer) || '—';
  const type = Number(question?.type);
  const options = Array.isArray(question?.options) ? question.options : [];

  if ([QUESTION_TYPES.MULTIPLE_CHOICE, QUESTION_TYPES.TRUE_FALSE, QUESTION_TYPES.MULTI_SELECT].includes(type)) {
    const labels = collectAnswerEntries(answer)
      .map((entry) => {
        const optionIndex = resolveOptionIndex(entry, options);
        return optionIndex >= 0 && optionIndex < OPTION_LETTERS.length
          ? OPTION_LETTERS[optionIndex]
          : normalizeAnswerValue(entry);
      })
      .filter(Boolean);
    return labels.length ? labels.join(', ') : '—';
  }

  if (type === QUESTION_TYPES.NUMERICAL) {
    const numeric = Number(answer);
    return Number.isFinite(numeric) ? String(numeric) : normalizeAnswerValue(answer) || '—';
  }

  if (typeof answer === 'object' && answer !== null) {
    try {
      return JSON.stringify(answer);
    } catch {
      return String(answer);
    }
  }

  return normalizeAnswerValue(answer) || '—';
}

const QUESTION_TYPE_ABBREVIATIONS = {
  [QUESTION_TYPES.MULTIPLE_CHOICE]: 'MC',
  [QUESTION_TYPES.TRUE_FALSE]: 'TF',
  [QUESTION_TYPES.SHORT_ANSWER]: 'SA',
  [QUESTION_TYPES.MULTI_SELECT]: 'MS',
  [QUESTION_TYPES.NUMERICAL]: 'NU',
};

function getQuestionTypeAbbreviation(questionOrType) {
  const rawType = Number(questionOrType?.type ?? questionOrType?.questionType ?? questionOrType?.sessionQuestionType ?? questionOrType);
  return QUESTION_TYPE_ABBREVIATIONS[rawType] || '';
}

function buildConflictQuestionLabel(conflict, t) {
  const sessionName = normalizeAnswerValue(conflict?.sessionName) || t('grades.coursePanel.session');
  const questionNumber = Number(conflict?.questionNumber);
  if (Number.isInteger(questionNumber) && questionNumber > 0) {
    return `${sessionName}/${t('grades.coursePanel.questionShort', { index: questionNumber })}`;
  }
  return `${sessionName}/${normalizeAnswerValue(conflict?.questionId) || t('grades.coursePanel.question')}`;
}

function isAutoGradeableConflict(conflict, question = null) {
  const questionType = Number(question?.type ?? conflict?.questionType);
  return AUTO_GRADEABLE_QUESTION_TYPES.has(questionType);
}

function isMarkAutoGradeable(mark, autoGradeableQuestionIdSet = null) {
  if (!(autoGradeableQuestionIdSet instanceof Set)) return true;
  const questionId = normalizeAnswerValue(mark?.questionId);
  if (!questionId) return false;
  return autoGradeableQuestionIdSet.has(questionId);
}

function getEffectiveMarkOutOf(mark, question = null) {
  const markOutOf = Number(mark?.outOf);
  if (Number.isFinite(markOutOf) && markOutOf >= 0) return markOutOf;
  const questionOutOf = Number(question?.sessionOptions?.points);
  if (Number.isFinite(questionOutOf) && questionOutOf >= 0) return questionOutOf;
  return 0;
}

function markActuallyNeedsGrading(mark, { question = null, latestResponse = null } = {}) {
  const effectiveOutOf = getEffectiveMarkOutOf(mark, question);
  if (effectiveOutOf <= 0) return false;

  const questionType = Number(question?.type ?? mark?.questionType ?? question?.questionType);
  const markNeedsGrading = !!mark?.needsGrading;
  const questionNeedsManualGrading = !AUTO_GRADEABLE_QUESTION_TYPES.has(questionType);
  const needsManualGrading = questionNeedsManualGrading
    && !!latestResponse
    && (!mark || markNeedsGrading);

  return markNeedsGrading || needsManualGrading;
}

function buildQuestionNumberLabel(t, questionNumber, questionType) {
  const baseLabel = Number.isInteger(questionNumber) && questionNumber > 0
    ? t('grades.coursePanel.questionShort', { index: questionNumber })
    : t('grades.coursePanel.question');
  const questionTypeAbbrev = getQuestionTypeAbbreviation(questionType);
  return questionTypeAbbrev ? `${baseLabel}(${questionTypeAbbrev})` : baseLabel;
}

function resolveMarkQuestionType(mark, questionTypeById = {}) {
  const directQuestionType = Number(mark?.questionType ?? mark?.sessionQuestionType ?? mark?.type);
  if (Number.isFinite(directQuestionType)) return directQuestionType;

  const questionId = normalizeAnswerValue(mark?.questionId);
  if (!questionId) return null;

  const mappedQuestionType = Number(questionTypeById?.[questionId]);
  return Number.isFinite(mappedQuestionType) ? mappedQuestionType : null;
}

function isSameConflict(left, right) {
  return String(left?.gradeId || '') === String(right?.gradeId || '')
    && String(left?.questionId || '') === String(right?.questionId || '')
    && String(left?.studentId || '') === String(right?.studentId || '')
    && String(left?.sessionId || '') === String(right?.sessionId || '');
}

function mergeUniqueConflicts(existingConflicts = [], incomingConflicts = []) {
  const merged = [...existingConflicts];
  incomingConflicts.forEach((incoming) => {
    const alreadyPresent = merged.some((existing) => isSameConflict(existing, incoming));
    if (!alreadyPresent) {
      merged.push(incoming);
    }
  });
  return merged;
}

function MarkQuestionDetailPanel({
  loading = false,
  error = '',
  student = null,
  summary = null,
  mark = null,
  question = null,
  latestResponse = null,
  manualPoints = '0',
  onManualPointsChange = null,
  feedbackHtml = '',
  onFeedbackChange = null,
  saving = false,
  actionButtons = null,
  showFeedbackEditor = false,
  questionNumber = null,
}) {
  const { t } = useTranslation();
  const studentAnswer = formatAnswerValue(question, latestResponse?.answer);
  const questionType = normalizeQuestionType(question);
  const questionTypeLabel = question
    ? getQuestionTypeLabel(t, questionType, {
      key: 'grades.coursePanel.question',
      defaultValue: 'Question',
    })
    : '';
  const needsGrading = markActuallyNeedsGrading(mark, { question, latestResponse });
  const questionHeading = buildQuestionNumberLabel(t, questionNumber, questionType);

  if (loading) {
    return (
      <Box sx={{ py: 3, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  return (
    <>
      {error ? <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert> : null}

      <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5 }}>
        <StudentIdentity
          student={student || {}}
          showEmail
          avatarSize={40}
          nameVariant="body1"
          emailVariant="body2"
          nameWeight={700}
          sx={{ mb: summary ? 1 : 0 }}
        />
        {summary}
      </Paper>

      {question ? (
        <Paper variant="outlined" sx={{ p: 1.25, mb: 1.5 }}>
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: 1 }}>
            {questionTypeLabel ? (
              <Chip
                size="small"
                label={questionTypeLabel}
                color={TYPE_COLORS[questionType] || 'default'}
              />
            ) : null}
            {mark ? (
              <Chip
                size="small"
                label={needsGrading ? t('grades.coursePanel.needsGrading') : t('grades.coursePanel.graded')}
                color={needsGrading ? 'error' : 'success'}
                variant={needsGrading ? 'filled' : 'outlined'}
              />
            ) : null}
          </Box>
          <Typography variant="subtitle2" sx={{ mb: 0.75 }}>{questionHeading}</Typography>
          <QuestionDisplay question={question} />
        </Paper>
      ) : (
        <Alert severity="warning" sx={{ mb: 1.5 }}>
          {t('grades.coursePanel.questionContentNotLoaded')}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 1.25, mb: 1.5 }}>
        <Typography variant="body2" sx={{ mb: 0.5 }}>
          <strong>{t('grades.coursePanel.studentAnswer')}</strong> {studentAnswer}
        </Typography>
      </Paper>

      {onManualPointsChange ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          <TextField
            size="small"
            type="number"
            label={t('grades.coursePanel.manualPoints')}
            value={manualPoints}
            onChange={(event) => onManualPointsChange(event.target.value)}
            sx={{ width: 150 }}
            disabled={saving}
          />
          {showFeedbackEditor ? (
            <Box>
              <Typography variant="caption" sx={{
                color: "text.secondary"
              }}>{t('grades.coursePanel.feedback')}</Typography>
              <StudentRichTextEditor
                value={feedbackHtml}
                disabled={saving}
                onChange={({ html }) => onFeedbackChange?.(html)}
                placeholder={t('grades.coursePanel.addFeedback')}
              />
              <MathPreview html={feedbackHtml} />
            </Box>
          ) : null}
          {actionButtons}
        </Box>
      ) : actionButtons}
    </>
  );
}

function StudentSearchField({
  value,
  onSearchChange,
  disabled = false,
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => value || '');

  useEffect(() => {
    setDraft(value || '');
  }, [value]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      onSearchChange(draft);
    }, 180);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [draft, onSearchChange]);

  return (
    <TextField
      size="small"
      label={t('grades.coursePanel.searchStudents')}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      sx={{ minWidth: 240 }}
      disabled={disabled}
    />
  );
}

function GradeDetailDialog({
  open,
  onClose,
  grade,
  student,
  sessionName,
  autoGradeableQuestionIdSet = null,
  sessionQuestionTypeById = {},
  instructorView,
  onGradeUpdated,
  onOpenMarkDetail,
}) {
  const { t } = useTranslation();
  const [workingGrade, setWorkingGrade] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editingGradeValue, setEditingGradeValue] = useState('0');

  useEffect(() => {
    if (!open || !grade) return;
    setWorkingGrade({ ...grade, marks: [...(grade.marks || [])] });
    setEditingGradeValue(String(grade.value ?? 0));
    setError('');
  }, [open, grade]);

  const persistGrade = useCallback(async (nextGrade) => {
    setWorkingGrade(nextGrade);
    if (onGradeUpdated) {
      await onGradeUpdated(nextGrade);
    }
  }, [onGradeUpdated]);


  const handleSaveGradeValue = useCallback(async () => {
    if (!workingGrade) return;
    setSaving(true);
    setError('');
    try {
      const { data } = await apiClient.patch(`/grades/${workingGrade._id}/value`, {
        value: Number(editingGradeValue),
      });
      await persistGrade(data.grade);
    } catch (err) {
      setError(err.response?.data?.message || t('grades.coursePanel.failedUpdateGradeValue'));
    } finally {
      setSaving(false);
    }
  }, [editingGradeValue, persistGrade, workingGrade]);

  const handleSetGradeAutomatic = useCallback(async () => {
    if (!workingGrade) return;
    setSaving(true);
    setError('');
    try {
      const { data } = await apiClient.post(`/grades/${workingGrade._id}/value/set-automatic`);
      await persistGrade(data.grade);
      setEditingGradeValue(String(data.grade?.value ?? 0));
    } catch (err) {
      setError(err.response?.data?.message || t('grades.coursePanel.failedRestoreAuto'));
    } finally {
      setSaving(false);
    }
  }, [persistGrade, workingGrade]);

  if (!workingGrade) return null;
  const gradingLocked = !!grade?.gradingLockReason;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Box>
            <StudentIdentity
              student={student || {}}
              showEmail
              avatarSize={40}
              nameVariant="body1"
              emailVariant="body2"
              nameWeight={700}
            />
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>{sessionName || workingGrade.name}</Typography>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            {workingGrade.needsGrading && <Chip size="small" color="error" label={t('grades.coursePanel.needsGrading')} />}
          </Box>
        </Box>
      </DialogTitle>
      <DialogContent dividers>
        {gradingLocked && <Alert severity="info" sx={{ mb: 2 }}>{t(`grades.questionPanel.${grade.gradingLockReason === 'extensions' ? 'gradingLockedExtensions' : 'gradingLockedUntilEnded'}`)}</Alert>}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t('grades.coursePanel.gradeValue', { percent: formatPercent(workingGrade.value), points: formatPercent(workingGrade.points), outOf: formatPercent(workingGrade.outOf) })}
          </Typography>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t('grades.coursePanel.participationValue', { percent: formatPercent(workingGrade.participation) })}
          </Typography>
          {instructorView && (
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
              <TextField
                size="small"
                type="number"
                label={t('grades.coursePanel.gradePercent')}
                disabled={gradingLocked}
                value={editingGradeValue}
                onChange={(event) => setEditingGradeValue(event.target.value)}
                sx={{ width: 140 }}
              />
              <Button size="small" variant="outlined" onClick={handleSaveGradeValue} disabled={saving || gradingLocked}>
                {t('grades.coursePanel.saveGradeValue')}
              </Button>
              {!workingGrade.automatic && (
                <Button
                  size="small"
                  variant="text"
                  startIcon={<AutoFixHighIcon />}
                  onClick={handleSetGradeAutomatic}
                  disabled={saving || gradingLocked}
                >
                  {t('grades.coursePanel.restoreAutomatic')}
                </Button>
              )}
            </Box>
          )}
        </Paper>

        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>{t('grades.coursePanel.question')}</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>{t('common.points')}</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>{t('grades.coursePanel.attempt')}</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>{t('common.status')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(workingGrade.marks || []).map((mark, index) => {
                const markCanAutoGrade = isMarkAutoGradeable(mark, autoGradeableQuestionIdSet);
                const resolvedQuestionType = resolveMarkQuestionType(mark, sessionQuestionTypeById);
                const rowNeedsGrading = markActuallyNeedsGrading({ ...mark, questionType: resolvedQuestionType });
                const questionLabel = buildQuestionNumberLabel(t, index + 1, resolvedQuestionType);
                return (
                  <TableRow key={`${mark.questionId}-${index}`}>
                    <TableCell>
                      <Button
                        size="small"
                        variant={instructorView ? 'outlined' : 'text'}
                        color={rowNeedsGrading ? 'error' : 'success'}
                        startIcon={instructorView ? <EditIcon fontSize="small" /> : undefined}
                        onClick={() => onOpenMarkDetail?.({
                          grade: workingGrade,
                          student,
                          sessionName,
                          mark,
                          questionNumber: index + 1,
                        })}
                        sx={{
                          minWidth: 0,
                          px: instructorView ? 1 : 0,
                          textTransform: 'none',
                          fontWeight: 700,
                        }}
                      >
                        {questionLabel}
                      </Button>
                    </TableCell>
                    <TableCell>{formatPercent(mark.points)} / {formatPercent(mark.outOf)}</TableCell>
                    <TableCell>{mark.attempt || 0}</TableCell>
                    <TableCell>
                      {rowNeedsGrading ? (
                        <Chip size="small" color="error" label={t('grades.coursePanel.needsGrading')} />
                      ) : !markCanAutoGrade ? (
                        <Chip size="small" color="success" variant="outlined" label={t('grades.coursePanel.manualOnly')} />
                      ) : (
                        <Chip size="small" color="success" variant="outlined" label={t('grades.coursePanel.graded')} />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function ConflictMarkDialog({
  open,
  onClose,
  loading,
  error,
  conflict,
  question,
  student,
  latestResponse,
  manualPoints,
  onManualPointsChange,
  saving,
  canAcceptAuto,
  onAcceptAuto,
  onSaveManual,
}) {
  const { t } = useTranslation();
  if (!open) return null;

  const questionLabel = buildConflictQuestionLabel(conflict, t);
  const fallbackStudent = student || {
    displayName: normalizeAnswerValue(conflict?.studentName) || normalizeAnswerValue(conflict?.studentId) || t('grades.coursePanel.student'),
    email: normalizeAnswerValue(conflict?.studentEmail),
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{questionLabel}</DialogTitle>
      <DialogContent dividers>
        <MarkQuestionDetailPanel
          loading={loading}
          error={error}
          student={fallbackStudent}
          mark={conflict}
          question={question}
          latestResponse={latestResponse}
          manualPoints={manualPoints}
          onManualPointsChange={onManualPointsChange}
          saving={saving}
          summary={(
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Typography variant="body2">
                <strong>{t('grades.coursePanel.currentManual')}</strong> {formatPercent(conflict?.existingPoints)} / {formatPercent(conflict?.outOf || question?.sessionOptions?.points || 0)}
              </Typography>
              <Typography variant="body2">
                <strong>{t('grades.coursePanel.recalculatedAuto')}</strong> {formatPercent(conflict?.calculatedPoints)}
              </Typography>
            </Box>
          )}
          actionButtons={(
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                size="small"
                variant="outlined"
                onClick={onSaveManual}
                disabled={saving}
              >
                {t('grades.coursePanel.saveManualGrade')}
              </Button>
              <Button
                size="small"
                variant="contained"
                startIcon={<AutoFixHighIcon />}
                onClick={onAcceptAuto}
                disabled={saving || !canAcceptAuto}
              >
                {t('grades.coursePanel.acceptAutoGrade')}
              </Button>
            </Box>
          )}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function QuestionMarkDialog({
  open,
  onClose,
  loading,
  error,
  sessionName,
  questionNumber,
  student,
  mark,
  question,
  latestResponse,
  manualPoints,
  feedbackHtml,
  onManualPointsChange,
  onFeedbackChange,
  saving,
  gradingLockReason,
  canSetAutomatic,
  onSetAutomatic,
  onSave,
}) {
  const { t } = useTranslation();
  if (!open) return null;

  const questionLabel = buildQuestionNumberLabel(
    t,
    Number.isInteger(questionNumber) ? questionNumber : null,
    question || mark
  );
  const titleParts = [
    normalizeAnswerValue(sessionName),
    questionLabel,
  ].filter(Boolean);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{titleParts.join(' / ') || t('grades.coursePanel.question')}</DialogTitle>
      <DialogContent dividers>
        {gradingLockReason && <Alert severity="info" sx={{ mb: 2 }}>{t(`grades.questionPanel.${gradingLockReason === 'extensions' ? 'gradingLockedExtensions' : 'gradingLockedUntilEnded'}`)}</Alert>}
        <MarkQuestionDetailPanel
          loading={loading}
          error={error}
          student={student}
          questionNumber={questionNumber}
          mark={mark}
          question={question}
          latestResponse={latestResponse}
          manualPoints={manualPoints}
          onManualPointsChange={onManualPointsChange}
          feedbackHtml={feedbackHtml}
          onFeedbackChange={onFeedbackChange}
          saving={saving || !!gradingLockReason}
          showFeedbackEditor
          summary={(
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <Typography variant="body2">
                <strong>{t('common.points')}</strong> {formatPercent(mark?.points)} / {formatPercent(mark?.outOf)}
              </Typography>
              <Typography variant="body2">
                <strong>{t('grades.coursePanel.attempt')}</strong> {mark?.attempt || 0}
              </Typography>
            </Box>
          )}
          actionButtons={(
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button size="small" variant="contained" onClick={onSave} disabled={saving || !!gradingLockReason}>
                {t('grades.coursePanel.saveMark')}
              </Button>
              {canSetAutomatic ? (
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<AutoFixHighIcon />}
                  onClick={onSetAutomatic}
                  disabled={saving || !!gradingLockReason}
                >
                  {t('grades.coursePanel.setAutomatic')}
                </Button>
              ) : null}
            </Box>
          )}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}

function buildInitialQuestionDetailState() {
  return {
    open: false,
    loading: false,
    saving: false,
    error: '',
    grade: null,
    student: null,
    sessionName: '',
    questionNumber: null,
    mark: null,
    question: null,
    latestResponse: null,
    manualPoints: '',
    feedbackHtml: '',
    canSetAutomatic: false,
  };
}

export default function CourseGradesPanel({
  courseId,
  instructorView = false,
  onOpenSession,
  availableSessions = [],
  gradingSummaryBySessionId = {},
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(() => !instructorView);
  const [loadingSessionOptions, setLoadingSessionOptions] = useState(false);
  const [error, setError] = useState('');
  const [sessionOptionsError, setSessionOptionsError] = useState('');
  const [fallbackSessionOptions, setFallbackSessionOptions] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [rows, setRows] = useState([]);
  const [tableVisible, setTableVisible] = useState(() => !instructorView);
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [studentSearchQuery, setStudentSearchQuery] = useState('');
  const [sort, setSort] = useState({ field: 'name', direction: 'asc' });
  const [refreshingSessionIds, setRefreshingSessionIds] = useState({});
  const [recalculateAllProgress, setRecalculateAllProgress] = useState({
    active: false,
    total: 0,
    completed: 0,
    currentSessionName: '',
  });
  const [globalMessage, setGlobalMessage] = useState('');
  const [globalMessageType, setGlobalMessageType] = useState('info');
  const [sessionPicker, setSessionPicker] = useState({ open: false, mode: 'show' });
  const [sessionPickerSearch, setSessionPickerSearch] = useState('');
  const [sessionPickerSelectedIds, setSessionPickerSelectedIds] = useState([]);
  const [sessionPickerSubmitting, setSessionPickerSubmitting] = useState(false);
  const [conflictsDialog, setConflictsDialog] = useState({ open: false, conflicts: [] });
  const [conflictDetailState, setConflictDetailState] = useState({
    open: false,
    loading: false,
    saving: false,
    error: '',
    conflict: null,
    question: null,
    student: null,
    latestResponse: null,
    manualPoints: '',
  });
  const [gradeDialogState, setGradeDialogState] = useState({
    open: false,
    grade: null,
    student: null,
    sessionName: '',
  });
  const [questionDetailState, setQuestionDetailState] = useState(buildInitialQuestionDetailState);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const [tableScrollWidth, setTableScrollWidth] = useState(0);
  const topScrollbarRef = useRef(null);
  const tableContainerRef = useRef(null);
  const conflictSessionResultsCacheRef = useRef(new Map());

  const hasProvidedSessionOptions = Array.isArray(availableSessions) && availableSessions.length > 0;

  const requestGradesData = useCallback(async (requestedSessionIds = []) => {
    const uniqueSessionIds = [...new Set((requestedSessionIds || []).map((id) => String(id)).filter(Boolean))];
    const params = {};
    if (uniqueSessionIds.length > 0) {
      params.sessionIds = uniqueSessionIds.join(',');
    }

    const requestConfig = Object.keys(params).length > 0 ? { params } : undefined;
    const { data } = await apiClient.get(`/courses/${courseId}/grades`, requestConfig);

    return {
      sessions: (data.sessions || []).map((session) => ({
        ...session,
        _id: String(session._id),
      })),
      rows: normalizeGradeRows(data.rows || []),
    };
  }, [courseId]);

  const fetchGrades = useCallback(async (requestedSessionIds = [], { applyToState = true } = {}) => {
    setLoading(true);
    setError('');
    try {
      const payload = await requestGradesData(requestedSessionIds);
      if (applyToState) {
        setSessions(payload.sessions);
        setRows(payload.rows);
      }
      return payload;
    } catch (err) {
      const message = err.response?.data?.message || t('grades.coursePanel.failedLoadGrades');
      if (applyToState) {
        setError(message);
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }, [requestGradesData]);

  const fetchFallbackSessionOptions = useCallback(async () => {
    if (!instructorView || hasProvidedSessionOptions) return;
    setLoadingSessionOptions(true);
    setSessionOptionsError('');
    try {
      const { data } = await apiClient.get(`/courses/${courseId}/grades`);
      setFallbackSessionOptions(
        (data.sessions || []).map((session) => ({
          ...session,
          _id: String(session._id),
        }))
      );
    } catch (err) {
      setSessionOptionsError(err.response?.data?.message || t('grades.coursePanel.failedLoadSessions'));
    } finally {
      setLoadingSessionOptions(false);
    }
  }, [courseId, hasProvidedSessionOptions, instructorView]);

  useEffect(() => {
    if (!instructorView) {
      fetchGrades([], { applyToState: true }).catch(() => {});
    }
  }, [fetchGrades, instructorView]);

  useEffect(() => {
    if (!instructorView || hasProvidedSessionOptions) {
      setFallbackSessionOptions([]);
      setLoadingSessionOptions(false);
      setSessionOptionsError('');
      return;
    }
    fetchFallbackSessionOptions();
  }, [fetchFallbackSessionOptions, hasProvidedSessionOptions, instructorView]);

  const sessionSelectionOptions = useMemo(() => {
    const sourceSessions = hasProvidedSessionOptions ? availableSessions : fallbackSessionOptions;
    const normalized = sourceSessions
      .filter((session) => !session.anonymous && !session.studentCreated)
      .map((session) => {
        const sessionId = String(session?._id || '').trim();
        if (!sessionId) return null;
        const summary = gradingSummaryBySessionId?.[sessionId] || {};
        return {
          ...session,
          _id: sessionId,
          hasGradeItems: session?.hasGradeItems ?? summary?.hasGradeItems,
          marksNeedingGrading: Number(
            session?.marksNeedingGrading
            ?? summary?.marksNeedingGrading
            ?? 0
          ) || 0,
        };
      })
      .filter(Boolean);

    return normalized.sort((a, b) => {
      const aBucket = getSessionSortBucket(a);
      const bBucket = getSessionSortBucket(b);
      if (aBucket !== bBucket) return aBucket - bBucket;
      return getSessionSortTime(b) - getSessionSortTime(a);
    });
  }, [availableSessions, fallbackSessionOptions, gradingSummaryBySessionId, hasProvidedSessionOptions]);

  const filteredSessionSelectionOptions = useMemo(() => {
    const normalizedSearch = normalizeAnswerValue(sessionPickerSearch).toLowerCase();
    if (!normalizedSearch) return sessionSelectionOptions;
    return sessionSelectionOptions.filter((session) => (
      normalizeAnswerValue(session?.name).toLowerCase().includes(normalizedSearch)
    ));
  }, [sessionPickerSearch, sessionSelectionOptions]);

  const visibleSessions = useMemo(() => sessions, [sessions]);

  const sortedRows = useMemo(() => (
    buildFilteredSortedRows(rows, studentSearchQuery, sort)
  ), [rows, sort, studentSearchQuery]);

  const paginatedRows = useMemo(() => {
    if (rowsPerPage === -1) return sortedRows;
    const start = page * rowsPerPage;
    return sortedRows.slice(start, start + rowsPerPage);
  }, [page, rowsPerPage, sortedRows]);

  const updateScrollWidth = useCallback(() => {
    const tableElement = tableContainerRef.current;
    if (!tableElement) return;
    setTableScrollWidth(tableElement.scrollWidth || 0);
  }, []);

  useEffect(() => {
    setPage(0);
  }, [studentSearchQuery]);

  useEffect(() => {
    if (rowsPerPage === -1) {
      setPage(0);
      return;
    }
    setPage((previousPage) => {
      const maxPage = Math.max(Math.ceil(sortedRows.length / rowsPerPage) - 1, 0);
      return Math.min(previousPage, maxPage);
    });
  }, [rowsPerPage, sortedRows.length]);

  useEffect(() => {
    if (!tableVisible) return undefined;
    const rafId = window.requestAnimationFrame(updateScrollWidth);
    const handleResize = () => updateScrollWidth();
    window.addEventListener('resize', handleResize);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', handleResize);
    };
  }, [tableVisible, updateScrollWidth, visibleSessions.length, paginatedRows.length, rowsPerPage]);

  const handleSort = useCallback((field) => {
    setSort((previousSort) => {
      if (previousSort.field === field) {
        return {
          field,
          direction: previousSort.direction === 'asc' ? 'desc' : 'asc',
        };
      }
      return {
        field,
        direction: field === 'avgParticipation' || field === 'avgGrade' || field.endsWith('_smark') || field.endsWith('_spart')
          ? 'desc'
          : 'asc',
      };
    });
  }, []);

  const handleTopScrollbarScroll = useCallback(() => {
    if (!topScrollbarRef.current || !tableContainerRef.current) return;
    tableContainerRef.current.scrollLeft = topScrollbarRef.current.scrollLeft;
  }, []);

  const handleTableScroll = useCallback(() => {
    if (!topScrollbarRef.current || !tableContainerRef.current) return;
    topScrollbarRef.current.scrollLeft = tableContainerRef.current.scrollLeft;
  }, []);

  const exportCsvWithData = useCallback((exportSessions, exportRows) => {
    if (!exportSessions.length || !exportRows.length) return;

    const header = [t('grades.coursePanel.lastName'), t('grades.coursePanel.firstName'), t('common.email'), t('grades.coursePanel.avgParticipation'), t('grades.coursePanel.avgGrade')];
    exportSessions.forEach((session) => {
      header.push(t('grades.coursePanel.sessionMarkHeader', { name: session.name }));
      header.push(t('grades.coursePanel.sessionPartHeader', { name: session.name }));
    });

    const lines = exportRows.map((row) => {
      const line = [
        escapeCsvCell(row?.student?.lastname || ''),
        escapeCsvCell(row?.student?.firstname || ''),
        escapeCsvCell(row?.student?.email || ''),
        escapeCsvCell(row?.avgParticipation == null ? '' : formatPercent(row.avgParticipation)),
        escapeCsvCell(row?.avgGrade == null ? '' : formatPercent(row.avgGrade)),
      ];

      exportSessions.forEach((session) => {
        const grade = row?.gradeBySession?.[session._id];
        line.push(escapeCsvCell((grade?.notApplicable || grade?.hasGradeItem === false) ? '' : formatPercent(grade?.value || 0)));
        line.push(escapeCsvCell((grade?.notApplicable || grade?.hasGradeItem === false) ? '' : formatPercent(grade?.participation || 0)));
      });

      return line.join(',');
    });

    const csvContent = [header.map(escapeCsvCell).join(','), ...lines].join('\n');
    downloadCsv(t('grades.coursePanel.csvFilename'), csvContent);
  }, [t]);

  const allSessionPickerIds = useMemo(() => (
    sessionSelectionOptions.map((session) => session._id)
  ), [sessionSelectionOptions]);
  const filteredSessionPickerIds = useMemo(() => (
    filteredSessionSelectionOptions.map((session) => String(session._id))
  ), [filteredSessionSelectionOptions]);

  const gradedSessionPickerIds = useMemo(() => (
    filteredSessionSelectionOptions.filter((session) => session.hasGradeItems === true)
      .map((session) => String(session._id))
  ), [filteredSessionSelectionOptions]);

  const validSessionPickerSelection = useMemo(() => {
    if (!allSessionPickerIds.length) return [];
    const validIdSet = new Set(allSessionPickerIds);
    return [...new Set(sessionPickerSelectedIds.filter((id) => validIdSet.has(id)))];
  }, [allSessionPickerIds, sessionPickerSelectedIds]);

  const selectedFilteredCount = filteredSessionPickerIds
    .filter((sessionId) => validSessionPickerSelection.includes(sessionId))
    .length;
  const allSessionsSelected = filteredSessionPickerIds.length > 0
    && selectedFilteredCount === filteredSessionPickerIds.length;
  const someSessionsSelected = selectedFilteredCount > 0 && !allSessionsSelected;

  const openSessionPicker = useCallback((mode) => {
    setSessionPickerSelectedIds([]);
    setSessionPickerSearch('');
    setSessionPicker({ open: true, mode });
  }, []);

  const closeSessionPicker = useCallback(() => {
    if (sessionPickerSubmitting) return;
    setSessionPicker({ open: false, mode: 'show' });
  }, [sessionPickerSubmitting]);

  const toggleSessionPickerSession = useCallback((sessionId) => {
    setSessionPickerSelectedIds((previousIds) => {
      if (previousIds.includes(sessionId)) {
        return previousIds.filter((entry) => entry !== sessionId);
      }
      return [...previousIds, sessionId];
    });
  }, []);

  const toggleSelectAllSessions = useCallback((checked) => {
    if (checked) {
      setSessionPickerSelectedIds((previousIds) => (
        [...new Set([...previousIds, ...filteredSessionPickerIds])]
      ));
      return;
    }
    setSessionPickerSelectedIds((previousIds) => (
      previousIds.filter((sessionId) => !filteredSessionPickerIds.includes(sessionId))
    ));
  }, [filteredSessionPickerIds]);

  const handleConfirmSessionPicker = useCallback(async () => {
    const selectedIds = [...new Set(validSessionPickerSelection)];
    if (!selectedIds.length) return;

    setSessionPickerSubmitting(true);
    try {
      if (sessionPicker.mode === 'show') {
        const payload = await fetchGrades(selectedIds, { applyToState: true });
        const resolvedSessionIds = payload.sessions.map((session) => String(session._id));
        setSelectedSessionIds(resolvedSessionIds.length ? resolvedSessionIds : selectedIds);
        setTableVisible(true);
        setPage(0);
      } else {
        const payload = await fetchGrades(selectedIds, { applyToState: false });
        const exportRows = buildFilteredSortedRows(payload.rows, '', sort);
        exportCsvWithData(payload.sessions, exportRows);
      }
      setSessionPicker({ open: false, mode: 'show' });
    } catch (err) {
      setGlobalMessage(err.response?.data?.message || t('grades.coursePanel.failedLoadGradeData'));
      setGlobalMessageType('error');
    } finally {
      setSessionPickerSubmitting(false);
    }
  }, [exportCsvWithData, fetchGrades, sessionPicker.mode, sort, validSessionPickerSelection]);

  const handleExportCsv = useCallback(() => {
    if (instructorView) {
      if (!tableVisible) {
        openSessionPicker('export');
        return;
      }
      exportCsvWithData(visibleSessions, sortedRows);
      return;
    }

    exportCsvWithData(visibleSessions, sortedRows);
  }, [
    exportCsvWithData,
    instructorView,
    openSessionPicker,
    sortedRows,
    tableVisible,
    visibleSessions,
  ]);

  const loadConflictSessionResults = useCallback(async (sessionId) => {
    const normalizedSessionId = normalizeAnswerValue(sessionId);
    if (!normalizedSessionId) return null;

    const cached = conflictSessionResultsCacheRef.current.get(normalizedSessionId);
    if (cached) return cached;

    const { data } = await apiClient.get(`/sessions/${normalizedSessionId}/results`);
    const questions = Array.isArray(data?.questions) ? data.questions : [];
    const questionById = new Map();
    const questionNumberById = new Map();
    questions.forEach((question, index) => {
      const questionId = normalizeAnswerValue(question?._id);
      if (!questionId) return;
      questionById.set(questionId, question);
      questionNumberById.set(questionId, index + 1);
    });

    const studentResultById = new Map();
    const studentResults = Array.isArray(data?.studentResults) ? data.studentResults : [];
    studentResults.forEach((entry) => {
      const studentId = normalizeAnswerValue(entry?.studentId);
      if (!studentId) return;
      studentResultById.set(studentId, entry);
    });

    const normalizedPayload = {
      questionById,
      questionNumberById,
      studentResultById,
    };
    conflictSessionResultsCacheRef.current.set(normalizedSessionId, normalizedPayload);
    return normalizedPayload;
  }, []);

  const enrichConflictsWithSessionData = useCallback(async (conflicts = []) => {
    if (!Array.isArray(conflicts) || conflicts.length === 0) return [];

    const uniqueSessionIds = [...new Set(
      conflicts
        .map((entry) => normalizeAnswerValue(entry?.sessionId))
        .filter(Boolean)
    )];

    const sessionResultsById = {};
    await Promise.all(uniqueSessionIds.map(async (sessionId) => {
      try {
        sessionResultsById[sessionId] = await loadConflictSessionResults(sessionId);
      } catch {
        sessionResultsById[sessionId] = null;
      }
    }));

    return conflicts.map((conflict) => {
      const sessionId = normalizeAnswerValue(conflict?.sessionId);
      const questionId = normalizeAnswerValue(conflict?.questionId);
      const sessionResults = sessionResultsById[sessionId];
      const questionNumber = sessionResults?.questionNumberById?.get(questionId);
      if (!questionNumber) return conflict;
      return {
        ...conflict,
        questionNumber,
      };
    });
  }, [loadConflictSessionResults]);

  const recalculateOneSession = useCallback(async (session) => {
    const sessionId = normalizeAnswerValue(session?._id);
    if (!sessionId) {
      return {
        summary: {},
        warnings: [],
        conflicts: [],
      };
    }

    setRefreshingSessionIds((prev) => ({ ...prev, [sessionId]: true }));
    try {
      const { data } = await apiClient.post(`/sessions/${sessionId}/grades/recalculate`, {
        missingOnly: false,
      });
      const summary = data?.summary || {};
      const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
      const conflicts = (Array.isArray(summary.manualMarkConflicts) ? summary.manualMarkConflicts : [])
        .map((conflict) => ({
          ...conflict,
          sessionId,
          sessionName: normalizeAnswerValue(session?.name) || normalizeAnswerValue(conflict?.sessionName) || t('grades.coursePanel.session'),
        }));
      return {
        summary,
        warnings,
        conflicts,
      };
    } finally {
      setRefreshingSessionIds((prev) => ({ ...prev, [sessionId]: false }));
    }
  }, [t]);

  const removeConflictFromDialogs = useCallback((targetConflict) => {
    setConflictsDialog((prev) => {
      const nextConflicts = prev.conflicts.filter((entry) => !isSameConflict(entry, targetConflict));
      return {
        ...prev,
        conflicts: nextConflicts,
      };
    });
    setConflictDetailState((prev) => {
      if (!prev.open || !isSameConflict(prev.conflict, targetConflict)) return prev;
      return {
        open: false,
        loading: false,
        saving: false,
        error: '',
        conflict: null,
        question: null,
        student: null,
        latestResponse: null,
        manualPoints: '',
      };
    });
  }, []);

  const handleRecalculateSession = useCallback(async (sessionId) => {
    if (!instructorView || recalculateAllProgress.active) return;

    const session = visibleSessions.find((entry) => String(entry._id) === String(sessionId));
    if (!session) return;

    try {
      const outcome = await recalculateOneSession(session);
      const enrichedConflicts = await enrichConflictsWithSessionData(outcome.conflicts);
      if (enrichedConflicts.length > 0) {
        setConflictsDialog((prev) => ({
          open: true,
          conflicts: mergeUniqueConflicts(prev.conflicts, enrichedConflicts),
        }));
      }
      if (outcome.warnings.length > 0) {
        setGlobalMessage(outcome.warnings.join(' '));
        setGlobalMessageType('warning');
      } else {
        setGlobalMessage(t('grades.coursePanel.gradesRecalculated'));
        setGlobalMessageType('success');
      }
      await fetchGrades(selectedSessionIds, { applyToState: true });
    } catch (err) {
      setGlobalMessage(err.response?.data?.message || t('grades.coursePanel.failedRecalculate'));
      setGlobalMessageType('error');
    }
  }, [
    enrichConflictsWithSessionData,
    fetchGrades,
    instructorView,
    recalculateAllProgress.active,
    recalculateOneSession,
    selectedSessionIds,
    visibleSessions,
  ]);

  const handleRecalculateAll = useCallback(async () => {
    if (!instructorView || recalculateAllProgress.active || !visibleSessions.length) return;

    const collectedConflicts = [];
    const warningMessages = [];
    const errorMessages = [];

    setRecalculateAllProgress({
      active: true,
      total: visibleSessions.length,
      completed: 0,
      currentSessionName: '',
    });

    try {
      for (let index = 0; index < visibleSessions.length; index += 1) {
        const session = visibleSessions[index];
        setRecalculateAllProgress((prev) => ({
          ...prev,
          completed: index,
          currentSessionName: normalizeAnswerValue(session?.name) || t('grades.coursePanel.session'),
        }));

        try {
          // eslint-disable-next-line no-await-in-loop
          const outcome = await recalculateOneSession(session);
          outcome.conflicts.forEach((conflict) => collectedConflicts.push(conflict));
          outcome.warnings.forEach((warning) => {
            warningMessages.push(`${normalizeAnswerValue(session?.name) || t('grades.coursePanel.session')}: ${warning}`);
          });
        } catch (err) {
          errorMessages.push(`${normalizeAnswerValue(session?.name) || t('grades.coursePanel.session')}: ${err.response?.data?.message || t('grades.coursePanel.failedRecalculate')}`);
        }

        setRecalculateAllProgress((prev) => ({
          ...prev,
          completed: index + 1,
        }));
      }

      if (collectedConflicts.length > 0) {
        const enrichedConflicts = await enrichConflictsWithSessionData(collectedConflicts);
        setConflictsDialog((prev) => ({
          open: true,
          conflicts: mergeUniqueConflicts(prev.conflicts, enrichedConflicts),
        }));
      }

      await fetchGrades(selectedSessionIds, { applyToState: true });

      if (errorMessages.length > 0) {
        setGlobalMessage(errorMessages.join(' '));
        setGlobalMessageType('error');
      } else if (warningMessages.length > 0) {
        setGlobalMessage(warningMessages.join(' '));
        setGlobalMessageType('warning');
      } else {
        setGlobalMessage(t('grades.coursePanel.finishedRecalculating'));
        setGlobalMessageType('success');
      }
    } catch (err) {
      setGlobalMessage(err.response?.data?.message || t('grades.coursePanel.failedRecalculateSome'));
      setGlobalMessageType('error');
    } finally {
      setRecalculateAllProgress({
        active: false,
        total: 0,
        completed: 0,
        currentSessionName: '',
      });
    }
  }, [
    enrichConflictsWithSessionData,
    fetchGrades,
    instructorView,
    recalculateAllProgress.active,
    recalculateOneSession,
    selectedSessionIds,
    visibleSessions,
  ]);

  const handleAcceptConflict = useCallback(async (conflict) => {
    if (!conflict?.gradeId || !conflict?.questionId) return;
    await apiClient.post(`/grades/${conflict.gradeId}/marks/${conflict.questionId}/set-automatic`);
  }, []);

  const handleAcceptConflictFromList = useCallback(async (conflict) => {
    if (!isAutoGradeableConflict(conflict)) {
      setGlobalMessage(t('grades.coursePanel.cannotAutoGrade'));
      setGlobalMessageType('warning');
      return;
    }

    try {
      await handleAcceptConflict(conflict);
      removeConflictFromDialogs(conflict);
      setGlobalMessage(t('grades.coursePanel.appliedAutoMark'));
      setGlobalMessageType('success');
      await fetchGrades(selectedSessionIds, { applyToState: true });
    } catch (err) {
      setGlobalMessage(err.response?.data?.message || t('grades.coursePanel.failedApplyAuto'));
      setGlobalMessageType('error');
    }
  }, [fetchGrades, handleAcceptConflict, removeConflictFromDialogs, selectedSessionIds]);

  const handleOpenConflictDetail = useCallback(async (conflict) => {
    if (!conflict) return;

    const baseManualPoints = Number.isFinite(Number(conflict?.existingPoints))
      ? String(conflict.existingPoints)
      : '0';

    setConflictDetailState({
      open: true,
      loading: true,
      saving: false,
      error: '',
      conflict,
      question: null,
      student: null,
      latestResponse: null,
      manualPoints: baseManualPoints,
    });

    try {
      const sessionId = normalizeAnswerValue(conflict?.sessionId);
      const questionId = normalizeAnswerValue(conflict?.questionId);
      const studentId = normalizeAnswerValue(conflict?.studentId);
      if (!sessionId || !questionId || !studentId) {
        setConflictDetailState((prev) => ({
          ...prev,
          loading: false,
          error: t('grades.coursePanel.conflictMissingIds'),
        }));
        return;
      }

      const sessionResults = await loadConflictSessionResults(sessionId);
      const question = sessionResults?.questionById?.get(questionId) || null;
      const questionNumber = sessionResults?.questionNumberById?.get(questionId);
      const studentResult = sessionResults?.studentResultById?.get(studentId) || null;
      const questionResult = (studentResult?.questionResults || [])
        .find((entry) => String(entry?.questionId) === questionId);
      const latestResponse = getLatestResponse(questionResult?.responses || []);
      const student = studentResult
        ? {
          studentId,
          firstname: studentResult.firstname,
          lastname: studentResult.lastname,
          email: studentResult.email,
        }
        : null;

      setConflictDetailState((prev) => ({
        ...prev,
        loading: false,
        error: '',
        question,
        student,
        latestResponse,
        conflict: questionNumber
          ? { ...prev.conflict, questionNumber }
          : prev.conflict,
      }));
    } catch (err) {
      setConflictDetailState((prev) => ({
        ...prev,
        loading: false,
        error: err.response?.data?.message || t('grades.coursePanel.failedLoadConflicts'),
      }));
    }
  }, [loadConflictSessionResults]);

  const handleCloseConflictDetail = useCallback(() => {
    if (conflictDetailState.saving) return;
    setConflictDetailState({
      open: false,
      loading: false,
      saving: false,
      error: '',
      conflict: null,
      question: null,
      student: null,
      latestResponse: null,
      manualPoints: '',
    });
  }, [conflictDetailState.saving]);

  const handleConflictManualPointsChange = useCallback((value) => {
    setConflictDetailState((prev) => ({
      ...prev,
      manualPoints: value,
      error: '',
    }));
  }, []);

  const handleAcceptConflictFromDetail = useCallback(async () => {
    const conflict = conflictDetailState.conflict;
    if (!conflict) return;
    if (!isAutoGradeableConflict(conflict, conflictDetailState.question)) {
      setConflictDetailState((prev) => ({
        ...prev,
        error: t('grades.coursePanel.cannotAutoGrade'),
      }));
      return;
    }

    setConflictDetailState((prev) => ({ ...prev, saving: true, error: '' }));
    try {
      await handleAcceptConflict(conflict);
      removeConflictFromDialogs(conflict);
      setGlobalMessage(t('grades.coursePanel.appliedAutoMark'));
      setGlobalMessageType('success');
      await fetchGrades(selectedSessionIds, { applyToState: true });
    } catch (err) {
      setConflictDetailState((prev) => ({
        ...prev,
        saving: false,
        error: err.response?.data?.message || t('grades.coursePanel.failedApplyAuto'),
      }));
    }
  }, [
    conflictDetailState.conflict,
    conflictDetailState.question,
    fetchGrades,
    handleAcceptConflict,
    removeConflictFromDialogs,
    selectedSessionIds,
  ]);

  const handleSaveManualConflictGrade = useCallback(async () => {
    const conflict = conflictDetailState.conflict;
    if (!conflict?.gradeId || !conflict?.questionId) return;

    const points = Number(conflictDetailState.manualPoints);
    if (!Number.isFinite(points) || points < 0) {
      setConflictDetailState((prev) => ({
        ...prev,
        error: t('grades.coursePanel.invalidManualPoints'),
      }));
      return;
    }

    setConflictDetailState((prev) => ({ ...prev, saving: true, error: '' }));
    try {
      await apiClient.patch(`/grades/${conflict.gradeId}/marks/${conflict.questionId}`, { points });
      removeConflictFromDialogs(conflict);
      setGlobalMessage(t('grades.coursePanel.manualGradeSaved'));
      setGlobalMessageType('success');
      await fetchGrades(selectedSessionIds, { applyToState: true });
    } catch (err) {
      setConflictDetailState((prev) => ({
        ...prev,
        saving: false,
        error: err.response?.data?.message || t('grades.coursePanel.failedSaveManual'),
      }));
    }
  }, [
    conflictDetailState.conflict,
    conflictDetailState.manualPoints,
    fetchGrades,
    removeConflictFromDialogs,
    selectedSessionIds,
  ]);

  const handleAcceptAllConflicts = useCallback(async () => {
    const autoConflicts = conflictsDialog.conflicts.filter((conflict) => isAutoGradeableConflict(conflict));
    if (!autoConflicts.length) {
      setGlobalMessage(t('grades.coursePanel.noAutoConflicts'));
      setGlobalMessageType('warning');
      return;
    }

    const acceptedConflicts = [];
    const errors = [];

    for (const conflict of autoConflicts) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await handleAcceptConflict(conflict);
        acceptedConflicts.push(conflict);
      } catch (err) {
        errors.push(err.response?.data?.message || t('grades.coursePanel.failedApplySomeAuto'));
      }
    }

    if (acceptedConflicts.length > 0) {
      setConflictsDialog((prev) => ({
        ...prev,
        conflicts: prev.conflicts.filter((entry) => !acceptedConflicts.some((accepted) => isSameConflict(entry, accepted))),
      }));
      setConflictDetailState((prev) => {
        if (!prev.open || !acceptedConflicts.some((accepted) => isSameConflict(prev.conflict, accepted))) {
          return prev;
        }
        return {
          open: false,
          loading: false,
          saving: false,
          error: '',
          conflict: null,
          question: null,
          student: null,
          latestResponse: null,
          manualPoints: '',
        };
      });
      await fetchGrades(selectedSessionIds, { applyToState: true });
    }

    if (errors.length > 0) {
      setGlobalMessage(errors.join(' '));
      setGlobalMessageType('error');
    } else {
      const skippedCount = conflictsDialog.conflicts.length - autoConflicts.length;
      if (skippedCount > 0) {
        setGlobalMessage(t('grades.coursePanel.appliedAutoPartial', { count: skippedCount }));
        setGlobalMessageType('warning');
      } else {
        setGlobalMessage(t('grades.coursePanel.appliedAutoMarks'));
        setGlobalMessageType('success');
      }
    }
  }, [conflictsDialog.conflicts, fetchGrades, handleAcceptConflict, selectedSessionIds]);

  const getAutoGradeableQuestionIdSetForSession = useCallback((sessionId) => {
    const normalizedSessionId = normalizeAnswerValue(sessionId);
    if (!normalizedSessionId) return null;
    const matchingSession = visibleSessions.find((session) => String(session._id) === normalizedSessionId);
    if (!matchingSession || !Array.isArray(matchingSession.autoGradeableQuestionIds)) {
      return null;
    }
    return new Set(
      matchingSession.autoGradeableQuestionIds
        .map((questionId) => String(questionId))
        .filter(Boolean)
    );
  }, [visibleSessions]);

  const handleOpenGradeDialog = useCallback((grade, student) => {
    if (!grade?._id) return;
    if (!instructorView) {
      onOpenSession?.(grade.sessionId);
      return;
    }
    const matchingSession = visibleSessions.find((session) => String(session._id) === String(grade?.sessionId));
    setGradeDialogState({
      open: true,
      grade,
      student,
      sessionName: matchingSession?.name || grade?.name || '',
    });
  }, [instructorView, onOpenSession, visibleSessions]);

  const handleGradeDialogUpdated = useCallback(async () => {
    await fetchGrades(selectedSessionIds, { applyToState: true });
  }, [fetchGrades, selectedSessionIds]);

  const handleCloseQuestionDetail = useCallback(() => {
    setQuestionDetailState(buildInitialQuestionDetailState());
  }, []);

  const handleOpenGradeMarkDetail = useCallback(async ({ grade, student, sessionName, mark, questionNumber }) => {
    const sessionId = normalizeAnswerValue(grade?.sessionId);
    const questionId = normalizeAnswerValue(mark?.questionId);
    const studentId = normalizeAnswerValue(student?.studentId || student?._id || student?.id);
    const autoGradeableQuestionIdSet = getAutoGradeableQuestionIdSetForSession(sessionId);

    setQuestionDetailState({
      open: true,
      loading: true,
      saving: false,
      error: '',
      grade,
      student,
      sessionName,
      questionNumber,
      mark,
      question: null,
      latestResponse: null,
      manualPoints: String(mark?.points ?? 0),
      feedbackHtml: mark?.feedback || '',
      canSetAutomatic: !mark?.automatic && isMarkAutoGradeable(mark, autoGradeableQuestionIdSet),
    });

    try {
      const sessionResults = await loadConflictSessionResults(sessionId);
      const question = sessionResults?.questionById?.get(questionId) || null;
      const resolvedQuestionNumber = sessionResults?.questionNumberById?.get(questionId) || questionNumber;
      const studentResult = sessionResults?.studentResultById?.get(studentId) || null;
      const questionResult = (studentResult?.questionResults || [])
        .find((entry) => String(entry?.questionId) === questionId);
      const latestResponse = getLatestResponse(questionResult?.responses || []);

      setQuestionDetailState((prev) => ({
        ...prev,
        loading: false,
        question,
        latestResponse,
        questionNumber: resolvedQuestionNumber,
      }));
    } catch (err) {
      setQuestionDetailState((prev) => ({
        ...prev,
        loading: false,
        error: err.response?.data?.message || t('grades.coursePanel.failedLoadConflicts'),
      }));
    }
  }, [getAutoGradeableQuestionIdSetForSession, loadConflictSessionResults, t]);

  const syncUpdatedGradeAcrossDialogs = useCallback((nextGrade) => {
    setGradeDialogState((prev) => {
      if (!prev.open || String(prev.grade?._id || '') !== String(nextGrade?._id || '')) {
        return prev;
      }
      return { ...prev, grade: nextGrade };
    });
    setQuestionDetailState((prev) => {
      if (!prev.open || String(prev.grade?._id || '') !== String(nextGrade?._id || '')) {
        return prev;
      }
      const nextMark = (nextGrade?.marks || []).find((entry) => String(entry?.questionId) === String(prev.mark?.questionId)) || null;
      return {
        ...prev,
        grade: nextGrade,
        mark: nextMark,
        manualPoints: String(nextMark?.points ?? 0),
        feedbackHtml: nextMark?.feedback || '',
        canSetAutomatic: Boolean(nextMark && !nextMark.automatic && prev.canSetAutomatic),
      };
    });
  }, []);

  const handleSaveQuestionDetail = useCallback(async () => {
    const gradeId = normalizeAnswerValue(questionDetailState.grade?._id);
    const questionId = normalizeAnswerValue(questionDetailState.mark?.questionId);
    if (!gradeId || !questionId) return;

    setQuestionDetailState((prev) => ({ ...prev, saving: true, error: '' }));
    try {
      const { data } = await apiClient.patch(`/grades/${gradeId}/marks/${questionId}`, {
        points: Number(questionDetailState.manualPoints),
        feedback: questionDetailState.feedbackHtml || '',
      });
      syncUpdatedGradeAcrossDialogs(data.grade);
      await fetchGrades(selectedSessionIds, { applyToState: true });
    } catch (err) {
      setQuestionDetailState((prev) => ({
        ...prev,
        error: err.response?.data?.message || t('grades.coursePanel.failedUpdateMark'),
      }));
    } finally {
      setQuestionDetailState((prev) => ({ ...prev, saving: false }));
    }
  }, [fetchGrades, questionDetailState.feedbackHtml, questionDetailState.grade?._id, questionDetailState.manualPoints, questionDetailState.mark?.questionId, selectedSessionIds, syncUpdatedGradeAcrossDialogs, t]);

  const handleSetQuestionDetailAutomatic = useCallback(async () => {
    const gradeId = normalizeAnswerValue(questionDetailState.grade?._id);
    const questionId = normalizeAnswerValue(questionDetailState.mark?.questionId);
    if (!gradeId || !questionId) return;

    setQuestionDetailState((prev) => ({ ...prev, saving: true, error: '' }));
    try {
      const { data } = await apiClient.post(`/grades/${gradeId}/marks/${questionId}/set-automatic`);
      syncUpdatedGradeAcrossDialogs(data.grade);
      await fetchGrades(selectedSessionIds, { applyToState: true });
    } catch (err) {
      setQuestionDetailState((prev) => ({
        ...prev,
        error: err.response?.data?.message || t('grades.coursePanel.failedAutoGrade'),
      }));
    } finally {
      setQuestionDetailState((prev) => ({ ...prev, saving: false }));
    }
  }, [fetchGrades, questionDetailState.grade?._id, questionDetailState.mark?.questionId, selectedSessionIds, syncUpdatedGradeAcrossDialogs, t]);

  const gradeDialogSessionId = normalizeAnswerValue(gradeDialogState.grade?.sessionId);
  const gradeDialogAutoGradeableQuestionIdSet = useMemo(() => {
    return getAutoGradeableQuestionIdSetForSession(gradeDialogSessionId);
  }, [getAutoGradeableQuestionIdSetForSession, gradeDialogSessionId]);
  const gradeDialogSessionQuestionTypeById = useMemo(() => {
    if (!gradeDialogSessionId) return {};
    const matchingSession = visibleSessions.find((session) => String(session?._id || '') === gradeDialogSessionId);
    if (!matchingSession || typeof matchingSession.questionTypeById !== 'object' || matchingSession.questionTypeById === null) {
      return {};
    }
    return matchingSession.questionTypeById;
  }, [gradeDialogSessionId, visibleSessions]);

  if (loading && !instructorView) {
    return (
      <Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !instructorView) {
    return <Alert severity="error">{error}</Alert>;
  }

  const canOpenSessionPicker = !loadingSessionOptions && allSessionPickerIds.length > 0;
  const canExportCurrentTable = tableVisible && visibleSessions.length > 0 && sortedRows.length > 0;

  return (
    <Box>
      {globalMessage ? (
        <Alert severity={globalMessageType} sx={{ mb: 1.5 }} onClose={() => setGlobalMessage('')}>
          {globalMessage}
        </Alert>
      ) : null}

      {instructorView && (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5, alignItems: 'center' }}>
          <Button
            size="small"
            variant="outlined"
            onClick={() => openSessionPicker('show')}
            disabled={!canOpenSessionPicker}
          >
            {tableVisible ? t('grades.coursePanel.editGradeTable') : t('grades.coursePanel.showGradeTable')}
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<DownloadIcon />}
            onClick={handleExportCsv}
            disabled={tableVisible ? !canExportCurrentTable : !canOpenSessionPicker}
          >
            {t('grades.coursePanel.exportGradesCSV')}
          </Button>
          {loadingSessionOptions && <CircularProgress size={18} />}
        </Box>
      )}

      {sessionOptionsError && !tableVisible && (
        <Alert severity="error" sx={{ mb: 1.5 }}>{sessionOptionsError}</Alert>
      )}

      {instructorView && !tableVisible && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          {t('grades.coursePanel.chooseSessionsInfo')}
        </Alert>
      )}

      <Dialog
        open={sessionPicker.open}
        onClose={closeSessionPicker}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {sessionPicker.mode === 'show' ? t('grades.coursePanel.selectSessionsTable') : t('grades.coursePanel.selectSessionsCSV')}
        </DialogTitle>
        <DialogContent dividers>
          <TextField
            size="small"
            fullWidth
            label={t('grades.coursePanel.searchSessions')}
            placeholder={t('grades.coursePanel.filterBySession')}
            value={sessionPickerSearch}
            onChange={(event) => setSessionPickerSearch(event.target.value)}
            sx={{ mb: 1.25 }}
          />
          <FormControlLabel
            control={(
              <Checkbox
                size="small"
                checked={allSessionsSelected}
                indeterminate={someSessionsSelected}
                onChange={(event) => toggleSelectAllSessions(event.target.checked)}
              />
            )}
            label={t('grades.coursePanel.selectAll', { count: filteredSessionPickerIds.length })}
            sx={{ mb: 1 }}
          />
          <Button
            size="small"
            disabled={!gradedSessionPickerIds.length}
            onClick={() => setSessionPickerSelectedIds(gradedSessionPickerIds)}
            sx={{ mb: 1 }}
          >
            {t('grades.coursePanel.selectWithGradeItems')}
          </Button>
          {filteredSessionSelectionOptions.length === 0 ? (
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>
              {t('grades.coursePanel.noSessionsMatch')}
            </Typography>
          ) : (
            <List dense sx={{ border: 1, borderColor: 'divider', borderRadius: 1, maxHeight: 360, overflowY: 'auto' }}>
              {filteredSessionSelectionOptions.map((session) => {
                const sessionId = String(session._id);
                const checked = validSessionPickerSelection.includes(sessionId);
                const ungradedCount = Number(session.marksNeedingGrading || 0);
                const sessionName = session.name || t('grades.coursePanel.untitledSession');
                return (
                  <ListItemButton key={sessionId} onClick={() => toggleSessionPickerSession(sessionId)}>
                    <Checkbox
                      size="small"
                      checked={checked}
                      slotProps={{
                        input: {
                          'aria-label': t('grades.coursePanel.toggleSessionSelection', {
                            session: sessionName,
                          }),
                        }
                      }}
                    />
                    <ListItemText
                      primary={sessionName}
                      secondary={session.status ? t('grades.coursePanel.sessionStatus', { status: session.status }) : undefined}
                    />
                    {session.hasGradeItems === false && (
                      <Chip size="small" variant="outlined" label={t('grades.coursePanel.noGradeItems')} />
                    )}
                    {ungradedCount > 0 && (
                      <Chip size="small" color="warning" variant="outlined" label={t('grades.coursePanel.needsGradingCount', { count: ungradedCount })} />
                    )}
                  </ListItemButton>
                );
              })}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeSessionPicker} disabled={sessionPickerSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="contained"
            onClick={handleConfirmSessionPicker}
            disabled={sessionPickerSubmitting || !validSessionPickerSelection.length}
          >
            {sessionPicker.mode === 'show' ? t('grades.coursePanel.showTable') : t('grades.coursePanel.exportCSV')}
          </Button>
        </DialogActions>
      </Dialog>

      {tableVisible && (
        <>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5, alignItems: 'center' }}>
            {instructorView && (
              <StudentSearchField
                value={studentSearchQuery}
                onSearchChange={setStudentSearchQuery}
                disabled={loading}
              />
            )}
            {instructorView && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<RefreshIcon />}
                onClick={handleRecalculateAll}
                disabled={!visibleSessions.length || recalculateAllProgress.active}
              >
                {t('grades.coursePanel.recalculateAll')}
              </Button>
            )}
            {!instructorView && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<DownloadIcon />}
                onClick={handleExportCsv}
                disabled={!visibleSessions.length || !sortedRows.length}
              >
                {t('grades.coursePanel.exportCSV')}
              </Button>
            )}
            {instructorView && (
              <Chip
                size="small"
                variant="outlined"
                label={t('grades.coursePanel.sessionsSelected', { count: visibleSessions.length })}
              />
            )}
          </Box>

          {recalculateAllProgress.active && (
            <Paper variant="outlined" sx={{ p: 1.25, mb: 1.25 }}>
              <Typography variant="body2" sx={{ mb: 0.5 }}>
                {recalculateAllProgress.currentSessionName
                  ? t('grades.coursePanel.recalculatingSession', { completed: recalculateAllProgress.completed, total: recalculateAllProgress.total, sessionName: recalculateAllProgress.currentSessionName })
                  : t('grades.coursePanel.recalculatingProgress', { completed: recalculateAllProgress.completed, total: recalculateAllProgress.total })}
              </Typography>
              <LinearProgress
                variant="determinate"
                value={recalculateAllProgress.total > 0
                  ? (100 * recalculateAllProgress.completed) / recalculateAllProgress.total
                  : 0}
              />
            </Paper>
          )}

          {loading ? (
            <Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}>
              <CircularProgress />
            </Box>
          ) : error ? (
            <Alert severity="error">{error}</Alert>
          ) : (
            <>
              {!instructorView && visibleSessions.length === 0 && (
                <Alert severity="info" sx={{ mb: 1.5 }}>
                  {t('grades.coursePanel.noReviewableSessions')}
                </Alert>
              )}
              <TablePagination
                component="div"
                count={sortedRows.length}
                page={rowsPerPage === -1 ? 0 : page}
                onPageChange={(_, nextPage) => {
                  if (rowsPerPage === -1) {
                    setPage(0);
                    return;
                  }
                  setPage(nextPage);
                }}
                rowsPerPage={rowsPerPage}
                onRowsPerPageChange={(event) => {
                  const nextValue = Number(event.target.value);
                  setRowsPerPage(Number.isFinite(nextValue) ? nextValue : 25);
                  setPage(0);
                }}
                rowsPerPageOptions={instructorView ? [25, 50, 100, { label: t('grades.coursePanel.all'), value: -1 }] : [rowsPerPage]}
                labelRowsPerPage={instructorView ? t('grades.coursePanel.rowsPerPage') : ''}
                sx={{ mb: 0.75 }}
              />

              <Box
                ref={topScrollbarRef}
                onScroll={handleTopScrollbarScroll}
                sx={{
                  overflowX: 'auto',
                  overflowY: 'hidden',
                  height: 12,
                  mb: 0.75,
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1,
                  bgcolor: 'background.paper',
                }}
              >
                <Box sx={{ width: Math.max(tableScrollWidth, 1), height: 1 }} />
              </Box>

              <TableContainer
                ref={tableContainerRef}
                component={Paper}
                variant="outlined"
                onScroll={handleTableScroll}
              >
                <Table size="small" aria-label={t('grades.coursePanel.gradeTable')} sx={{ '& .MuiTableCell-root': { py: 0.55, px: 0.75 } }}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700, minWidth: 130 }}>
                        <TableSortLabel
                          active={sort.field === 'name'}
                          direction={sort.field === 'name' ? sort.direction : 'asc'}
                          onClick={() => handleSort('name')}
                        >
                          {t('grades.coursePanel.student')}
                        </TableSortLabel>
                      </TableCell>
                      <TableCell sx={{ fontWeight: 700, minWidth: 160 }}>
                        <TableSortLabel
                          active={sort.field === 'email'}
                          direction={sort.field === 'email' ? sort.direction : 'asc'}
                          onClick={() => handleSort('email')}
                        >
                          {t('common.email')}
                        </TableSortLabel>
                      </TableCell>
                      <TableCell sx={{ fontWeight: 700, minWidth: 96 }}>
                        <TableSortLabel
                          active={sort.field === 'avgParticipation'}
                          direction={sort.field === 'avgParticipation' ? sort.direction : 'desc'}
                          onClick={() => handleSort('avgParticipation')}
                        >
                          {t('grades.coursePanel.avgParticipation')}
                        </TableSortLabel>
                      </TableCell>
                      <TableCell sx={{ fontWeight: 700, minWidth: 96 }}>
                        <TableSortLabel
                          active={sort.field === 'avgGrade'}
                          direction={sort.field === 'avgGrade' ? sort.direction : 'desc'}
                          onClick={() => handleSort('avgGrade')}
                        >
                          {t('grades.coursePanel.avgGrade')}
                        </TableSortLabel>
                      </TableCell>
                      {visibleSessions.flatMap((session) => {
                        const markSortKey = `${session._id}_smark`;
                        const participationSortKey = `${session._id}_spart`;
                        const ungradedCount = Number(session.marksNeedingGrading || 0);
                        const showUngradedChip = instructorView
                          ? ungradedCount > 0
                          : rows.some((row) => {
                            const grade = row?.gradeBySession?.[session._id];
                            return Boolean(grade?.needsGrading && grade?.joined);
                          });
                        return [
                          <TableCell key={`${session._id}-mark`} sx={{ fontWeight: 700, minWidth: 125 }}>
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.3 }}>
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                                <TableSortLabel
                                  active={sort.field === markSortKey}
                                  direction={sort.field === markSortKey ? sort.direction : 'desc'}
                                  onClick={() => handleSort(markSortKey)}
                                >
                                  {t('grades.coursePanel.sessionMarkHeader', { name: session.name })}
                                </TableSortLabel>
                                {typeof onOpenSession === 'function' && (
                                  <Tooltip title={t('grades.coursePanel.openSessionReview')}>
                                    <span>
                                      <IconButton
                                        size="small"
                                        aria-label={t('common.openReview')}
                                        onClick={() => onOpenSession(session._id)}
                                        sx={{ p: 0.25 }}
                                      >
                                        <ReviewIcon fontSize="inherit" />
                                      </IconButton>
                                    </span>
                                  </Tooltip>
                                )}
                                {instructorView && (
                                  <Tooltip title={t('grades.coursePanel.recalculateSessionTooltip')}>
                                    <span>
                                      <IconButton
                                        size="small"
                                        aria-label={t('common.recalculate')}
                                        onClick={() => handleRecalculateSession(session._id)}
                                        disabled={!!session.gradingLockReason || recalculateAllProgress.active || !!refreshingSessionIds[session._id]}
                                      >
                                        <RefreshIcon fontSize="inherit" />
                                      </IconButton>
                                    </span>
                                  </Tooltip>
                                )}
                              </Box>
                              {showUngradedChip && (
                                <Chip
                                  size="small"
                                  color="warning"
                                  variant="outlined"
                                  label={instructorView ? t('grades.coursePanel.ungradedCount', { count: ungradedCount }) : t('grades.coursePanel.ungraded')}
                                  sx={{ maxWidth: 140 }}
                                />
                              )}
                            </Box>
                          </TableCell>,
                          <TableCell key={`${session._id}-participation`} sx={{ fontWeight: 700, minWidth: 110 }}>
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.3 }}>
                              <TableSortLabel
                                active={sort.field === participationSortKey}
                                direction={sort.field === participationSortKey ? sort.direction : 'desc'}
                                onClick={() => handleSort(participationSortKey)}
                              >
                                {t('grades.coursePanel.sessionPartHeader', { name: session.name })}
                              </TableSortLabel>
                            </Box>
                          </TableCell>,
                        ];
                      })}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {paginatedRows.map((row) => (
                      <TableRow key={row.student.studentId} hover>
                        <TableCell>
                          <StudentIdentity
                            student={row.student}
                            showEmail={false}
                            avatarSize={32}
                            nameVariant="body2"
                            emailVariant="caption"
                            nameWeight={600}
                          />
                        </TableCell>
                        <TableCell sx={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.student.email}</TableCell>
                        <TableCell>{row.avgParticipation == null
                          ? t('grades.coursePanel.notApplicable')
                          : `${formatPercent(row.avgParticipation)}%`}</TableCell>
                        <TableCell>{row.avgGrade == null
                          ? t('grades.coursePanel.notApplicable')
                          : `${formatPercent(row.avgGrade)}%`}</TableCell>
                        {visibleSessions.map((session) => {
                          const grade = row.gradeBySession?.[session._id];
                          const markLabel = grade?.notApplicable || grade?.hasGradeItem === false
                            ? t('grades.coursePanel.notApplicable')
                            : `${formatPercent(grade?.value || 0)}%`;
                          const participationLabel = grade?.notApplicable || grade?.hasGradeItem === false
                            ? t('grades.coursePanel.notApplicable')
                            : `${formatPercent(grade?.participation || 0)}%`;
                          return (
                            <Fragment key={`${row.student.studentId}-${session._id}`}>
                              <TableCell>
                                <Button
                                  size="small"
                                  variant="text"
                                  onClick={() => handleOpenGradeDialog(grade, row.student)}
                                  disabled={!grade?._id}
                                  sx={{ textTransform: 'none', px: 0 }}
                                >
                                  {markLabel}
                                </Button>
                                {grade?.needsGrading && grade?.joined && (
                                  <Chip size="small" color="error" label={t('grades.coursePanel.needsGrading')} sx={{ ml: 0.5 }} />
                                )}
                              </TableCell>
                              <TableCell>
                                {participationLabel}
                              </TableCell>
                            </Fragment>
                          );
                        })}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          )}
        </>
      )}

      <Dialog
        open={conflictsDialog.open}
        onClose={() => setConflictsDialog({ open: false, conflicts: [] })}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{t('grades.coursePanel.manualOverrideConflicts')}</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t('grades.coursePanel.autoRecalcNote')}
          </Typography>
          {conflictsDialog.conflicts.length === 0 ? (
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>{t('grades.coursePanel.noConflicts')}</Typography>
          ) : (
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('grades.coursePanel.student')}</TableCell>
                    <TableCell>{t('grades.coursePanel.question')}</TableCell>
                    <TableCell>{t('grades.coursePanel.manual')}</TableCell>
                    <TableCell>{t('grades.coursePanel.auto')}</TableCell>
                    <TableCell>{t('common.actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {conflictsDialog.conflicts.map((conflict) => (
                    <TableRow key={`${conflict.gradeId}-${conflict.questionId}-${conflict.studentId}`}>
                      <TableCell>{conflict.studentName || conflict.studentId}</TableCell>
                      <TableCell>
                        <Button
                          size="small"
                          variant="text"
                          onClick={() => handleOpenConflictDetail(conflict)}
                          sx={{ px: 0, textTransform: 'none' }}
                        >
                          {buildConflictQuestionLabel(conflict)}
                        </Button>
                      </TableCell>
                      <TableCell>{formatPercent(conflict.existingPoints)}</TableCell>
                      <TableCell>{formatPercent(conflict.calculatedPoints)}</TableCell>
                      <TableCell>
                        <Button
                          size="small"
                          variant="outlined"
                          onClick={() => handleAcceptConflictFromList(conflict)}
                          disabled={!isAutoGradeableConflict(conflict)}
                        >
                          {t('grades.coursePanel.acceptAuto')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConflictsDialog({ open: false, conflicts: [] })}>{t('grades.coursePanel.keepManual')}</Button>
          <Button variant="contained" onClick={handleAcceptAllConflicts} disabled={!conflictsDialog.conflicts.length}>
            {t('grades.coursePanel.acceptAllAuto')}
          </Button>
        </DialogActions>
      </Dialog>

      <GradeDetailDialog
        open={gradeDialogState.open}
        onClose={() => setGradeDialogState({ open: false, grade: null, student: null, sessionName: '' })}
        grade={gradeDialogState.grade}
        student={gradeDialogState.student}
        sessionName={gradeDialogState.sessionName}
        autoGradeableQuestionIdSet={gradeDialogAutoGradeableQuestionIdSet}
        sessionQuestionTypeById={gradeDialogSessionQuestionTypeById}
        instructorView={instructorView}
        onGradeUpdated={handleGradeDialogUpdated}
        onOpenMarkDetail={handleOpenGradeMarkDetail}
      />

      <QuestionMarkDialog
        open={questionDetailState.open}
        onClose={handleCloseQuestionDetail}
        loading={questionDetailState.loading}
        error={questionDetailState.error}
        sessionName={questionDetailState.sessionName}
        questionNumber={questionDetailState.questionNumber}
        student={questionDetailState.student}
        mark={questionDetailState.mark}
        question={questionDetailState.question}
        latestResponse={questionDetailState.latestResponse}
        manualPoints={questionDetailState.manualPoints}
        feedbackHtml={questionDetailState.feedbackHtml}
        onManualPointsChange={(value) => setQuestionDetailState((prev) => ({ ...prev, manualPoints: value }))}
        onFeedbackChange={(value) => setQuestionDetailState((prev) => ({ ...prev, feedbackHtml: value }))}
        gradingLockReason={questionDetailState.grade?.gradingLockReason}
        saving={questionDetailState.saving}
        canSetAutomatic={questionDetailState.canSetAutomatic}
        onSetAutomatic={handleSetQuestionDetailAutomatic}
        onSave={handleSaveQuestionDetail}
      />

      <ConflictMarkDialog
        open={conflictDetailState.open}
        onClose={handleCloseConflictDetail}
        loading={conflictDetailState.loading}
        error={conflictDetailState.error}
        conflict={conflictDetailState.conflict}
        question={conflictDetailState.question}
        student={conflictDetailState.student}
        latestResponse={conflictDetailState.latestResponse}
        manualPoints={conflictDetailState.manualPoints}
        onManualPointsChange={handleConflictManualPointsChange}
        saving={conflictDetailState.saving}
        canAcceptAuto={isAutoGradeableConflict(conflictDetailState.conflict, conflictDetailState.question)}
        onAcceptAuto={handleAcceptConflictFromDetail}
        onSaveManual={handleSaveManualConflictGrade}
      />
    </Box>
  );
}
