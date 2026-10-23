import {
  useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  CheckCircle as ApproveIcon,
  Close as CloseIcon,
  ContentCopy as CopyIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
  Public as PublicIcon,
  Upload as UploadIcon,
  Download as DownloadIcon,
  FilterList as FilterListIcon,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';
import { buildCourseSelectionLabel, sortCoursesByRecent } from '../../utils/courseTitle';
import { useAuth } from '../../contexts/AuthContext';
import QuestionDisplay from './QuestionDisplay';
import QuestionEditor from './QuestionEditor';
import { TYPE_COLORS, getQuestionTypeLabel, normalizeQuestionType } from './constants';
import SessionSelectorDialog from '../common/SessionSelectorDialog';

const DEFAULT_LIMIT = 10;

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function slugifyFilenamePart(value, fallback = 'question-library') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function normalizeTagValues(tags = []) {
  return [...new Set(
    (tags || [])
      .map((tag) => String(tag?.label || tag?.value || tag || '').trim())
      .filter(Boolean)
  )];
}

function cloneQuestionForBaseline(question) {
  if (!question) return null;
  if (typeof structuredClone === 'function') {
    return structuredClone(question);
  }
  return JSON.parse(JSON.stringify(question));
}

function buildQueryString(params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    searchParams.set(key, String(value));
  });
  return searchParams.toString();
}

function createVisibilityForm(source = {}) {
  return {
    public: !!source.public,
    publicOnQlicker: !!source.publicOnQlicker,
    publicOnQlickerForStudents: !!source.publicOnQlickerForStudents,
  };
}

function buildVisibilityPayload(form = {}) {
  const publicOnQlicker = !!form.publicOnQlicker;
  return {
    public: publicOnQlicker ? true : !!form.public,
    publicOnQlicker,
    publicOnQlickerForStudents: publicOnQlicker ? !!form.publicOnQlickerForStudents : false,
  };
}

function resolveBulkVisibilityInitialForm(selectedQuestions = []) {
  if (!selectedQuestions.length) return createVisibilityForm();
  const first = buildVisibilityPayload(selectedQuestions[0]);
  const allMatch = selectedQuestions.every((question) => {
    const next = buildVisibilityPayload(question);
    return next.public === first.public
      && next.publicOnQlicker === first.publicOnQlicker
      && next.publicOnQlickerForStudents === first.publicOnQlickerForStudents;
  });
  return allMatch ? createVisibilityForm(first) : createVisibilityForm();
}

function questionOwnerId(question) {
  return String(question?.owner || '');
}

function isQuestionOwnedByUser(question, userId) {
  return questionOwnerId(question) !== '' && questionOwnerId(question) === String(userId || '');
}

function canStudentManageQuestion(question, userId) {
  return isQuestionOwnedByUser(question, userId) && !question?.hasResponses;
}

function canDeleteLibraryQuestion(question, { isStudentLibrary, currentUserId }) {
  if (question?.hasResponses) return false;
  if (!isStudentLibrary) return true;
  return canStudentManageQuestion(question, currentUserId);
}

function QuestionCopyDialog({
  open,
  courses = [],
  selectedCount = 0,
  defaultCourseId = '',
  onClose,
  onConfirm,
}) {
  const { t } = useTranslation();
  const [targetCourseId, setTargetCourseId] = useState(defaultCourseId || '');
  const [targetSessionId, setTargetSessionId] = useState('');
  const [sessions, setSessions] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTargetCourseId(defaultCourseId || '');
    setTargetSessionId('');
  }, [defaultCourseId, open]);

  useEffect(() => {
    if (!open || !targetCourseId) {
      setSessions([]);
      return;
    }

    let active = true;
    setLoadingSessions(true);
    apiClient.get(`/courses/${targetCourseId}/sessions`)
      .then(({ data }) => {
        if (!active) return;
        setSessions(data.sessions || []);
      })
      .catch(() => {
        if (!active) return;
        setSessions([]);
      })
      .finally(() => {
        if (active) setLoadingSessions(false);
      });

    return () => {
      active = false;
    };
  }, [open, targetCourseId]);

  const selectedCourse = courses.find((course) => String(course._id) === String(targetCourseId)) || null;
  const selectedSession = sessions.find((session) => String(session._id) === String(targetSessionId)) || null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {t('questionLibrary.copyDialog.title', {
          count: selectedCount,
          defaultValue: selectedCount === 1 ? 'Copy question' : `Copy ${selectedCount} questions`,
        })}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Autocomplete
            options={courses}
            value={selectedCourse}
            onChange={(_event, nextValue) => {
              setTargetCourseId(nextValue?._id || '');
              setTargetSessionId('');
            }}
            getOptionLabel={(option) => buildCourseSelectionLabel(option)}
            getOptionKey={(option) => String(option?._id || buildCourseSelectionLabel(option))}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('questionLibrary.filters.course', { defaultValue: 'Course' })}
              />
            )}
          />
          <Autocomplete
            options={sessions}
            value={selectedSession}
            loading={loadingSessions}
            onChange={(_event, nextValue) => setTargetSessionId(nextValue?._id || '')}
            getOptionLabel={(option) => option?.name || ''}
            getOptionKey={(option) => String(option?._id || option?.name || '')}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('questionLibrary.filters.copySession', { defaultValue: 'Session (optional)' })}
                helperText={t('questionLibrary.filters.copySessionHelp', {
                  defaultValue: 'Leave blank to copy into the selected course library.',
                })}
              />
            )}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="contained"
          disabled={!targetCourseId}
          onClick={() => onConfirm?.({
            targetCourseId,
            targetSessionId,
          })}
        >
          {t('common.copy', { defaultValue: 'Copy' })}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function ImportQuestionsDialog({
  open,
  sessions = [],
  tagSuggestions = [],
  importTags = [],
  previewQuestions = [],
  selectedIds = [],
  onImportTagsChange,
  onFileSelected,
  onSelectionChange,
  onClose,
  onConfirm,
}) {
  const { t } = useTranslation();
  const [targetSessionId, setTargetSessionId] = useState('');

  useEffect(() => {
    if (!open) setTargetSessionId('');
  }, [open]);

  const selectedSet = new Set(selectedIds);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{t('questionLibrary.import.title', { defaultValue: 'Import questions' })}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Button variant="outlined" component="label" startIcon={<UploadIcon />}>
            {t('questionLibrary.import.chooseFile', { defaultValue: 'Choose JSON file' })}
            <input
              type="file"
              accept="application/json,.json"
              hidden
              onChange={onFileSelected}
            />
          </Button>

          <TextField
            select
            label={t('questionLibrary.filters.copySession', { defaultValue: 'Session (optional)' })}
            value={targetSessionId}
            onChange={(event) => setTargetSessionId(event.target.value)}
          >
            <MenuItem value="">{t('questionLibrary.import.libraryOnly', { defaultValue: 'Course library only' })}</MenuItem>
            {sessions.map((session) => (
              <MenuItem key={session._id} value={session._id}>{session.name}</MenuItem>
            ))}
          </TextField>

          <Autocomplete
            multiple
            freeSolo
            options={[...new Set([
              'Imported',
              ...normalizeTagValues(tagSuggestions),
            ])]}
            value={importTags}
            onChange={(_event, nextValue) => onImportTagsChange?.(normalizeTagValues(nextValue))}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t('questionLibrary.import.tags', { defaultValue: 'Tags to apply to all imported questions' })}
                placeholder={t('questionLibrary.import.tagsPlaceholder', { defaultValue: 'Imported' })}
              />
            )}
          />

          {previewQuestions.length === 0 ? (
            <Alert severity="info">
              {t('questionLibrary.import.empty', {
                defaultValue: 'Choose a JSON export to preview importable questions.',
              })}
            </Alert>
          ) : (
            <>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="body2" sx={{
                  color: "text.secondary"
                }}>
                  {t('questionLibrary.import.previewCount', {
                    count: previewQuestions.length,
                    defaultValue: `${previewQuestions.length} questions ready to import`,
                  })}
                </Typography>
                <FormSelectionActions
                  total={previewQuestions.length}
                  selectedCount={selectedIds.length}
                  onSelectAll={() => onSelectionChange(previewQuestions.map((question, index) => question._previewId || `preview-${index}`))}
                  onClear={() => onSelectionChange([])}
                />
              </Box>
              <Stack spacing={1.25}>
                {previewQuestions.map((question, index) => {
                  const previewId = question._previewId || `preview-${index}`;
                  const checked = selectedSet.has(previewId);
                  const normalizedType = normalizeQuestionType(question);
                  return (
                    <Card key={previewId} variant="outlined">
                      <CardContent sx={{ display: 'flex', gap: 1.25, alignItems: 'flex-start' }}>
                        <Checkbox
                          checked={checked}
                          onChange={() => {
                            if (checked) {
                              onSelectionChange(selectedIds.filter((id) => id !== previewId));
                              return;
                            }
                            onSelectionChange([...selectedIds, previewId]);
                          }}
                        />
                        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                            <Chip
                              size="small"
                              color={TYPE_COLORS[normalizedType] || 'default'}
                              label={getQuestionTypeLabel(t, normalizedType, { defaultValue: String(normalizedType) })}
                            />
                            <Chip size="small" variant="outlined" label={t('questionLibrary.import.importedTag', { defaultValue: 'imported tag will be added' })} />
                          </Box>
                          <QuestionDisplay question={question} />
                        </Box>
                      </CardContent>
                    </Card>
                  );
                })}
              </Stack>
              <DialogActions sx={{ px: 0 }}>
                <Button onClick={onClose}>{t('common.cancel')}</Button>
                <Button
                  variant="contained"
                  disabled={selectedIds.length === 0}
                  onClick={() => onConfirm?.({ targetSessionId })}
                >
                  {t('questionLibrary.import.confirm', {
                    count: selectedIds.length,
                    defaultValue: selectedIds.length === 1 ? 'Import 1 question' : `Import ${selectedIds.length} questions`,
                  })}
                </Button>
              </DialogActions>
            </>
          )}
        </Stack>
      </DialogContent>
    </Dialog>
  );
}

function FormSelectionActions({ total, selectedCount, onSelectAll, onClear }) {
  const { t } = useTranslation();
  return (
    <Stack direction="row" spacing={1}>
      <Button size="small" onClick={onSelectAll}>
        {t('questionLibrary.bulk.selectAll', {
          count: total,
          defaultValue: `Select all (${total})`,
        })}
      </Button>
      <Button size="small" onClick={onClear}>
        {t('questionLibrary.bulk.clearSelection', {
          count: selectedCount,
          defaultValue: 'Clear selection',
        })}
      </Button>
    </Stack>
  );
}

function QuestionLibraryPanel({
  courseId,
  availableSessions = [],
  onSessionsChanged,
  currentCourse = null,
  allowQuestionCreate = true,
  selectionAction = null,
  permissionMode = null,
  ref,
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const roles = user?.roles || [];
  const isStudentLibrary = permissionMode === 'student'
    || (permissionMode !== 'instructor'
      && roles.includes('student')
      && !roles.includes('professor')
      && !roles.includes('admin'));
  const loadErrorTextRef = useRef('');
  loadErrorTextRef.current = t('questionLibrary.errors.load', { defaultValue: 'Failed to load question library.' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [questions, setQuestions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [message, setMessage] = useState(null);
  const [sourceCourseId, setSourceCourseId] = useState(courseId);
  const [courses, setCourses] = useState(currentCourse ? [currentCourse] : []);
  const [sourceSessions, setSourceSessions] = useState(availableSessions);
  const [availableTypes, setAvailableTypes] = useState([]);
  const [selectedType, setSelectedType] = useState('');
  const [selectedTags, setSelectedTags] = useState([]);
  const [tagOptions, setTagOptions] = useState([]);
  const [approvedFilter, setApprovedFilter] = useState('all');
  const [contentFilter, setContentFilter] = useState('');
  const [selectedSessionIds, setSelectedSessionIds] = useState([]);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [selectedQuestionIds, setSelectedQuestionIds] = useState([]);
  const [expandedQuestionIds, setExpandedQuestionIds] = useState({});
  const [editingQuestionId, setEditingQuestionId] = useState('');
  const [editingQuestionBaseline, setEditingQuestionBaseline] = useState(null);
  const [creatingQuestion, setCreatingQuestion] = useState(false);
  const [copyDialogState, setCopyDialogState] = useState({ open: false, questionIds: [] });
  const [practiceSessionDialogOpen, setPracticeSessionDialogOpen] = useState(false);
  const [selectedPracticeSessionIds, setSelectedPracticeSessionIds] = useState([]);
  const [visibilityDialogOpen, setVisibilityDialogOpen] = useState(false);
  const [bulkVisibilityForm, setBulkVisibilityForm] = useState(createVisibilityForm());
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importPreviewQuestions, setImportPreviewQuestions] = useState([]);
  const [importSelectedIds, setImportSelectedIds] = useState([]);
  const [importTags, setImportTags] = useState(['Imported']);
  const [randomSelectionCount, setRandomSelectionCount] = useState(10);
  const inlineQuestionEditorRef = useRef(null);
  const directSelectionMode = !!selectionAction?.onSubmit;
  const showInlineRandomSelectionControls = directSelectionMode && !selectionAction?.hideInlineRandomSelectionControls;

  const queryParams = useMemo(() => ({
    page,
    limit,
    ...(selectedType !== '' ? { type: selectedType } : {}),
    ...(selectedTags.length > 0 ? { tags: selectedTags.join(',') } : {}),
    ...(selectedSessionIds.length > 0 ? { sessionIds: selectedSessionIds.join(',') } : {}),
    ...(contentFilter.trim() ? { content: contentFilter.trim() } : {}),
    ...(approvedFilter === 'all' ? {} : { approved: approvedFilter === 'approved' }),
  }), [approvedFilter, contentFilter, limit, page, selectedSessionIds, selectedTags, selectedType]);

  const selectedIdSet = useMemo(() => new Set(selectedQuestionIds.map((id) => String(id))), [selectedQuestionIds]);
  const allPageSelected = questions.length > 0 && questions.every((question) => selectedIdSet.has(String(question._id)));
  const somePageSelected = questions.some((question) => selectedIdSet.has(String(question._id))) && !allPageSelected;
  const selectedQuestions = questions.filter((question) => selectedIdSet.has(String(question._id)));
  const studentPracticeSessions = useMemo(() => (
    (availableSessions || []).filter((session) => !!session?.studentCreated && !!session?.practiceQuiz)
  ), [availableSessions]);
  const selectedSourceCourse = useMemo(() => (
    courses.find((course) => String(course._id) === String(sourceCourseId)) || null
  ), [courses, sourceCourseId]);
  const currentUserId = String(user?._id || '');
  const selectedOwnedQuestions = useMemo(() => (
    selectedQuestions.filter((question) => canDeleteLibraryQuestion(question, { isStudentLibrary, currentUserId }))
  ), [currentUserId, isStudentLibrary, selectedQuestions]);
  const hasSelectedUndeletableQuestions = selectedQuestionIds.length !== selectedQuestions.length
    || selectedQuestions.some((question) => !canDeleteLibraryQuestion(question, { isStudentLibrary, currentUserId }));

  const fetchCourses = useCallback(async () => {
    if (isStudentLibrary) {
      setCourses(currentCourse ? [currentCourse] : []);
      return;
    }
    const { data } = await apiClient.get('/courses', { params: { limit: 500, view: 'instructor' } });
    const nextCourses = sortCoursesByRecent(
      (data.courses || []).filter((course) => Array.isArray(course.instructors))
    );
    setCourses(nextCourses);
  }, [currentCourse, isStudentLibrary]);

  const fetchSourceSessions = useCallback(async (nextCourseId) => {
    if (!nextCourseId) {
      setSourceSessions([]);
      return;
    }
    const { data } = await apiClient.get(`/courses/${nextCourseId}/sessions`);
    setSourceSessions(data.sessions || []);
  }, []);

  const fetchTagOptions = useCallback(async (nextCourseId) => {
    if (!nextCourseId) {
      setTagOptions([]);
      return;
    }
    const nextTags = normalizeTagValues(currentCourse?.tags || []).map((tag) => ({ value: tag, label: tag }));
    if (String(nextCourseId) === String(currentCourse?._id) && nextTags.length > 0) {
      setTagOptions(nextTags);
      return;
    }
    const { data } = await apiClient.get(`/courses/${nextCourseId}/question-tags?limit=100`);
    setTagOptions(data.tags || []);
  }, [currentCourse?._id, currentCourse?.tags]);

  const fetchQuestions = useCallback(async ({ background = false } = {}) => {
    if (!background) {
      setLoading(true);
    }
    try {
      const query = buildQueryString(queryParams);
      const { data } = await apiClient.get(`/courses/${sourceCourseId}/questions${query ? `?${query}` : ''}`);
      setQuestions(data.questions || []);
      setTotal(Number(data.total || 0));
      setAvailableTypes(data.questionTypes || []);
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || loadErrorTextRef.current,
      });
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  }, [queryParams, sourceCourseId]);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetchCourses(),
      fetchSourceSessions(sourceCourseId),
      fetchTagOptions(sourceCourseId),
    ]).catch((err) => {
      if (!active) return;
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || loadErrorTextRef.current,
      });
    });
    return () => {
      active = false;
    };
  }, [fetchCourses, fetchSourceSessions, fetchTagOptions, sourceCourseId]);

  useEffect(() => {
    if (!isStudentLibrary || !currentCourse?._id) return;
    setCourses([currentCourse]);
    setSourceCourseId(String(currentCourse._id));
  }, [currentCourse, isStudentLibrary]);

  useEffect(() => {
    fetchQuestions();
  }, [fetchQuestions]);

  useEffect(() => {
    if (String(sourceCourseId) === String(courseId)) {
      const currentIds = sourceSessions.map((session) => String(session._id)).join(',');
      const nextIds = (availableSessions || []).map((session) => String(session._id)).join(',');
      if (currentIds !== nextIds) {
        setSourceSessions(availableSessions);
      }
    }
  }, [availableSessions, courseId, sourceCourseId, sourceSessions]);

  const refreshQuestions = async (options) => {
    await fetchQuestions(options);
  };

  const upsertQuestionLocally = useCallback((savedQuestion) => {
    if (!savedQuestion?._id) return;
    setQuestions((previous) => previous.map((question) => (
      String(question._id) === String(savedQuestion._id)
        ? { ...question, ...savedQuestion }
        : question
    )));
  }, []);

  const handleEditorSave = async (payload, questionId) => {
    const nextPayload = {
      ...payload,
      courseId,
    };
    const { data } = questionId
      ? await apiClient.patch(`/questions/${questionId}`, nextPayload)
      : await apiClient.post('/questions', nextPayload);
    const savedQuestion = data.question || data;
    if (questionId) {
      upsertQuestionLocally(savedQuestion);
    }
    return savedQuestion;
  };

  const openEditEditor = (question) => {
    setCreatingQuestion(false);
    setEditingQuestionId(String(question?._id || ''));
    setEditingQuestionBaseline(cloneQuestionForBaseline(question));
  };

  const closeInlineEditor = async ({ persistedQuestionId } = {}) => {
    setEditingQuestionId('');
    setEditingQuestionBaseline(null);

    if (persistedQuestionId) {
      try {
        const { data } = await apiClient.get(`/questions/${persistedQuestionId}`);
        const refreshed = data.question || data;
        upsertQuestionLocally(refreshed);
      } catch {
        // Keep local state if the final refresh fails.
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

  const toggleExpanded = (questionId) => {
    setExpandedQuestionIds((previous) => ({
      ...previous,
      [questionId]: !previous[questionId],
    }));
  };

  const toggleQuestionSelection = (questionId) => {
    const normalizedQuestionId = String(questionId);
    setSelectedQuestionIds((previous) => (
      previous.includes(normalizedQuestionId)
        ? previous.filter((id) => id !== normalizedQuestionId)
        : [...previous, normalizedQuestionId]
    ));
  };

  const toggleCurrentPageSelection = (checked) => {
    if (checked) {
      setSelectedQuestionIds((previous) => [...new Set([...previous, ...questions.map((question) => String(question._id))])]);
      return;
    }
    setSelectedQuestionIds((previous) => previous.filter((id) => !questions.some((question) => String(question._id) === String(id))));
  };

  const selectAllFilteredQuestions = async () => {
    try {
      const query = buildQueryString({ ...queryParams, idsOnly: true });
      const { data } = await apiClient.get(`/courses/${sourceCourseId}/questions?${query}`);
      setSelectedQuestionIds(data.questionIds || []);
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('questionLibrary.errors.selectAll', { defaultValue: 'Failed to select all filtered questions.' }),
      });
    }
  };

  const handleApproveQuestion = async (questionId) => {
    setSaving(true);
    try {
      await apiClient.post(`/questions/${questionId}/approve`);
      await refreshQuestions({ background: true });
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('questionLibrary.errors.approve', { defaultValue: 'Failed to approve question.' }),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleMakeQuestionPublic = async (questionId) => {
    setSaving(true);
    try {
      await apiClient.post(`/questions/${questionId}/make-public`);
      await refreshQuestions({ background: true });
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('questionLibrary.errors.makePublic', { defaultValue: 'Failed to make question public.' }),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteQuestions = async (questionIds) => {
    if (!questionIds.length) return;
    if (!window.confirm(t('questionLibrary.deleteConfirm', {
      count: questionIds.length,
      defaultValue: questionIds.length === 1 ? 'Delete this question?' : `Delete ${questionIds.length} questions?`,
    }))) {
      return;
    }

    setSaving(true);
    try {
      const deletedIdSet = new Set(questionIds.map((questionId) => String(questionId)));
      setQuestions((previous) => previous.filter((question) => !deletedIdSet.has(String(question._id))));
      setTotal((previous) => Math.max(0, previous - questionIds.length));
      if (questionIds.length === 1) {
        await apiClient.delete(`/questions/${questionIds[0]}`);
      } else {
        await apiClient.post('/questions/bulk-delete', { questionIds });
      }
      setSelectedQuestionIds((previous) => previous.filter((id) => !questionIds.includes(id)));
      await refreshQuestions({ background: true });
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('questionLibrary.errors.delete', { defaultValue: 'Failed to delete questions.' }),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleCopyQuestions = async ({ targetCourseId, targetSessionId }) => {
    setSaving(true);
    try {
      await apiClient.post('/questions/bulk-copy', {
        questionIds: copyDialogState.questionIds,
        targetCourseId,
        ...(targetSessionId ? { targetSessionId } : {}),
      });
      setCopyDialogState({ open: false, questionIds: [] });
      if (typeof onSessionsChanged === 'function' && String(targetCourseId) === String(courseId) && targetSessionId) {
        await onSessionsChanged();
      }
      if (String(targetCourseId) === String(sourceCourseId)) {
        await refreshQuestions({ background: true });
      }
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('questionLibrary.errors.copy', { defaultValue: 'Failed to copy questions.' }),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleAddQuestionsToPracticeSession = async () => {
    const targetSessionId = String(selectedPracticeSessionIds[0] || '').trim();
    if (!targetSessionId || !selectedQuestionIds.length) return;

    setSaving(true);
    try {
      const { data } = await apiClient.get(`/sessions/${targetSessionId}`);
      const existingQuestionIds = (data?.session?.questions || data?.questions || []).map((questionId) => String(questionId));
      const mergedQuestionIds = [...new Set([...existingQuestionIds, ...selectedQuestionIds])];
      await apiClient.patch(`/sessions/${targetSessionId}/practice-questions`, {
        questionIds: mergedQuestionIds,
      });
      setPracticeSessionDialogOpen(false);
      setSelectedPracticeSessionIds([]);
      setMessage({
        severity: 'success',
        text: t('questionLibrary.bulk.practiceSessionSaved', {
          count: selectedQuestionIds.length,
          defaultValue: selectedQuestionIds.length === 1 ? 'Question added to the practice session.' : 'Questions added to the practice session.',
        }),
      });
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('questionLibrary.errors.copy', { defaultValue: 'Failed to copy questions.' }),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleCopyQuestionSingle = async (questionId) => {
    if (isStudentLibrary) {
      setSelectedQuestionIds([String(questionId)]);
      setPracticeSessionDialogOpen(true);
      return;
    }
    setSaving(true);
    try {
      setCopyDialogState({ open: true, questionIds: [questionId] });
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('questionLibrary.errors.copy', { defaultValue: 'Failed to copy questions.' }),
      });
    } finally {
      setSaving(false);
    }
  };

  const submitSelectedQuestionIds = useCallback(async (questionIds, selectedQuestionSubset = []) => {
    if (!directSelectionMode || !questionIds.length) return;
    setSaving(true);
    try {
      await selectionAction.onSubmit?.(questionIds, selectedQuestionSubset);
      setMessage({
        severity: 'success',
        text: selectionAction.successMessage || t('questionLibrary.bulk.questionsAddedToSession', {
          count: questionIds.length,
          defaultValue: questionIds.length === 1 ? 'Question added to the session.' : 'Questions added to the session.',
        }),
      });
      setSelectedQuestionIds([]);
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || selectionAction.errorMessage || t('questionLibrary.errors.copy', { defaultValue: 'Failed to copy questions.' }),
      });
    } finally {
      setSaving(false);
    }
  }, [directSelectionMode, questions, selectionAction, t]);

  const handleDirectSelectionSubmit = useCallback(async () => {
    if (!directSelectionMode || !selectedQuestionIds.length) return;
    await submitSelectedQuestionIds(
      selectedQuestionIds,
      questions.filter((question) => selectedIdSet.has(String(question._id)))
    );
  }, [directSelectionMode, questions, selectedIdSet, selectedQuestionIds, submitSelectedQuestionIds]);

  const getFilteredQuestionIds = useCallback(async () => {
    const query = buildQueryString({ ...queryParams, idsOnly: true });
    const { data } = await apiClient.get(`/courses/${sourceCourseId}/questions?${query}`);
    return [...new Set((data.questionIds || []).map((questionId) => String(questionId)).filter(Boolean))];
  }, [queryParams, sourceCourseId]);

  const getRandomFilteredQuestionIds = useCallback(async (requestedCount) => {
    const allQuestionIds = await getFilteredQuestionIds();
    const shuffledIds = [...allQuestionIds];
    for (let index = shuffledIds.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.floor(Math.random() * (index + 1));
      [shuffledIds[index], shuffledIds[randomIndex]] = [shuffledIds[randomIndex], shuffledIds[index]];
    }
    return shuffledIds.slice(0, Math.min(Math.max(1, Number(requestedCount) || 1), shuffledIds.length));
  }, [getFilteredQuestionIds]);

  const selectRandomFilteredQuestions = useCallback(async (requestedCount = randomSelectionCount) => {
    try {
      setSelectedQuestionIds(await getRandomFilteredQuestionIds(requestedCount));
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('questionLibrary.errors.selectRandom', { defaultValue: 'Failed to select random filtered questions.' }),
      });
    }
  }, [getRandomFilteredQuestionIds, randomSelectionCount, t]);

  useImperativeHandle(ref, () => ({
    submitSelectedQuestions: handleDirectSelectionSubmit,
    submitRandomFilteredQuestions: async (requestedCount = randomSelectionCount) => {
      if (!directSelectionMode) return;
      const randomQuestionIds = await getRandomFilteredQuestionIds(requestedCount);
      if (!randomQuestionIds.length) return;
      await submitSelectedQuestionIds(randomQuestionIds, []);
    },
  }), [directSelectionMode, getRandomFilteredQuestionIds, handleDirectSelectionSubmit, randomSelectionCount, submitSelectedQuestionIds]);

  useEffect(() => {
    if (!directSelectionMode || typeof selectionAction?.onSelectionChange !== 'function') return;
    selectionAction.onSelectionChange(selectedQuestionIds);
  }, [directSelectionMode, selectedQuestionIds, selectionAction]);

  const handleOpenVisibilityDialog = () => {
    setBulkVisibilityForm(resolveBulkVisibilityInitialForm(selectedQuestions));
    setVisibilityDialogOpen(true);
  };

  const handleBulkVisibilitySave = async () => {
    if (!selectedQuestionIds.length) return;
    setSaving(true);
    try {
      await apiClient.post('/questions/bulk-visibility', {
        questionIds: selectedQuestionIds,
        ...buildVisibilityPayload(bulkVisibilityForm),
      });
      setVisibilityDialogOpen(false);
      await refreshQuestions();
      setMessage({
        severity: 'success',
        text: t('questionLibrary.bulk.visibilitySaved', {
          count: selectedQuestionIds.length,
          defaultValue: selectedQuestionIds.length === 1 ? 'Question visibility updated.' : 'Question visibility updated.',
        }),
      });
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('questionLibrary.errors.visibility', { defaultValue: 'Failed to update question visibility.' }),
      });
    } finally {
      setSaving(false);
    }
  };

  const selectedLinkedSessionCount = selectedQuestions.reduce(
    (count, question) => count + (Array.isArray(question.linkedSessions) && question.linkedSessions.length > 0 ? 1 : 0),
    0
  );
  const showBulkVisibilityWarning = selectedLinkedSessionCount > 0
    && (bulkVisibilityForm.public || bulkVisibilityForm.publicOnQlicker);

  const handleExportQuestions = async () => {
    if (!selectedQuestionIds.length) return;
    try {
      const { data } = await apiClient.post('/questions/export', { questionIds: selectedQuestionIds });
      const filenamePrefix = slugifyFilenamePart(selectedSourceCourse?.name || courseId, `course-${courseId}`);
      downloadJson(`${filenamePrefix}-question-library.json`, { questions: data.questions || [] });
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('questionLibrary.errors.export', { defaultValue: 'Failed to export questions.' }),
      });
    }
  };

  const handleImportFileSelected = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text());
      const parsedQuestions = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.questions)
          ? parsed.questions
          : [];
      const preview = parsedQuestions.map((question, index) => ({
        ...question,
        _previewId: `preview-${index}`,
      }));
      setImportPreviewQuestions(preview);
      setImportSelectedIds(preview.map((question) => question._previewId));
    } catch {
      setMessage({
        severity: 'error',
        text: t('questionLibrary.errors.importParse', { defaultValue: 'The selected file is not valid question-library JSON.' }),
      });
    } finally {
      event.target.value = '';
    }
  };

  const handleConfirmImport = async ({ targetSessionId }) => {
    const selectedSetForImport = new Set(importSelectedIds);
    const questionsToImport = importPreviewQuestions.filter((question) => selectedSetForImport.has(question._previewId))
      .map((question) => {
        const sanitized = { ...question };
        delete sanitized._previewId;
        return sanitized;
      });

    if (!questionsToImport.length) return;

    setSaving(true);
    try {
      await apiClient.post(`/courses/${courseId}/questions/import`, {
        questions: questionsToImport,
        ...(targetSessionId ? { sessionId: targetSessionId } : {}),
        importTags,
      });
      setImportDialogOpen(false);
      setImportPreviewQuestions([]);
      setImportSelectedIds([]);
      setImportTags(['Imported']);
      if (typeof onSessionsChanged === 'function' && targetSessionId) {
        await onSessionsChanged();
      }
      if (String(sourceCourseId) === String(courseId)) {
        await refreshQuestions();
      }
    } catch (err) {
      setMessage({
        severity: 'error',
        text: err.response?.data?.message || t('questionLibrary.errors.import', { defaultValue: 'Failed to import questions.' }),
      });
    } finally {
      setSaving(false);
    }
  };

  const currentTagValues = selectedTags;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }} aria-label={isStudentLibrary ? t('questionLibrary.studentLibraryAria') : t('questionLibrary.professorLibraryAria')}>
      {message ? (
        <Alert severity={message.severity} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={2}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            <Box>
              <Typography variant="h6">
                {t('questionLibrary.title', { defaultValue: 'Question Library' })}
              </Typography>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                {isStudentLibrary
                  ? t('questionLibrary.studentSubtitle', {
                    defaultValue: 'Browse course questions, copy them into your library, and create your own private practice questions.',
                  })
                  : t('questionLibrary.subtitle', {
                    defaultValue: 'Browse, edit, copy, export, and import questions across your instructor courses.',
                  })}
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} sx={{
              flexWrap: "wrap"
            }}>
              {!isStudentLibrary && !selectionAction?.hideImport ? (
                <Button variant="outlined" startIcon={<UploadIcon />} onClick={() => setImportDialogOpen(true)}>
                  {t('questionLibrary.import.action', { defaultValue: 'Import JSON' })}
                </Button>
              ) : null}
              {allowQuestionCreate ? (
                <Button variant="contained" startIcon={<AddIcon />} onClick={() => {
                  setCreatingQuestion(true);
                  setEditingQuestionId('');
                }}>
                  {selectionAction?.newQuestionLabel || t('questionLibrary.newQuestion', { defaultValue: 'New question' })}
                </Button>
              ) : null}
            </Stack>
          </Box>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
            {!isStudentLibrary ? (
              <Autocomplete
                sx={{ minWidth: 220, flex: 1 }}
                options={courses}
                value={selectedSourceCourse}
                onChange={async (_event, nextValue) => {
                  const nextCourseId = nextValue?._id || courseId;
                  setSourceCourseId(nextCourseId);
                  setSelectedSessionIds([]);
                  setSelectedQuestionIds([]);
                  setPage(1);
                  await Promise.all([
                    fetchSourceSessions(nextCourseId),
                    fetchTagOptions(nextCourseId),
                  ]);
                }}
                getOptionLabel={(option) => buildCourseSelectionLabel(option)}
                getOptionKey={(option) => String(option?._id || buildCourseSelectionLabel(option))}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={t('questionLibrary.filters.course', { defaultValue: 'Course' })}
                  />
                )}
              />
            ) : null}

            <TextField
              select
              label={t('questionLibrary.filters.type', { defaultValue: 'Type' })}
              value={selectedType}
              onChange={(event) => {
                setSelectedType(event.target.value);
                setPage(1);
              }}
              sx={{ minWidth: 170 }}
            >
              <MenuItem value="">{t('questionLibrary.filters.allTypes', { defaultValue: 'All types' })}</MenuItem>
              {availableTypes.map((type) => (
                <MenuItem key={type} value={type}>
                  {getQuestionTypeLabel(t, type, { defaultValue: String(type) })}
                </MenuItem>
              ))}
            </TextField>

            <Autocomplete
              multiple
              freeSolo={false}
              sx={{ minWidth: 240, flex: 1 }}
              options={tagOptions.map((tag) => tag.label || tag.value)}
              value={currentTagValues}
              onChange={(_event, nextValue) => {
                setSelectedTags(normalizeTagValues(nextValue));
                setPage(1);
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={t('questionLibrary.filters.tags', { defaultValue: 'Tags' })}
                  placeholder={t('questionLibrary.filters.tagsPlaceholder', { defaultValue: 'Filter by tag' })}
                />
              )}
            />

            {!isStudentLibrary && !directSelectionMode ? (
              <Button
                variant="outlined"
                startIcon={<FilterListIcon />}
                onClick={() => setSessionDialogOpen(true)}
              >
                {selectedSessionIds.length > 0
                  ? t('questionLibrary.filters.sessionsButtonSelected', {
                    count: selectedSessionIds.length,
                    defaultValue: `Sessions (${selectedSessionIds.length})`,
                  })
                  : t('questionLibrary.filters.sessionsButton', { defaultValue: 'Sessions' })}
              </Button>
            ) : null}
          </Stack>

          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
            <TextField
              fullWidth
              label={t('questionLibrary.filters.content', { defaultValue: 'Content' })}
              placeholder={t('questionLibrary.filters.contentPlaceholder', {
                defaultValue: 'Search question text and option text',
              })}
              value={contentFilter}
              onChange={(event) => {
                setContentFilter(event.target.value);
                setPage(1);
              }}
            />
            <TextField
              select
              label={t('questionLibrary.filters.approved', { defaultValue: 'Approved' })}
              value={approvedFilter}
              onChange={(event) => {
                setApprovedFilter(event.target.value);
                setPage(1);
              }}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="all">{t('questionLibrary.filters.allApprovalStates', { defaultValue: 'All' })}</MenuItem>
              <MenuItem value="approved">{t('questionLibrary.filters.onlyApproved', { defaultValue: 'Approved only' })}</MenuItem>
              <MenuItem value="unapproved">{t('questionLibrary.filters.onlyUnapproved', { defaultValue: 'Unapproved only' })}</MenuItem>
            </TextField>
            <TextField
              select
              label={t('questionLibrary.filters.limit', { defaultValue: 'Rows' })}
              value={String(limit)}
              onChange={(event) => {
                setLimit(Number(event.target.value));
                setPage(1);
              }}
              sx={{ minWidth: 120 }}
            >
              {[10, 25, 50, 100].map((option) => (
                <MenuItem key={option} value={String(option)}>{option}</MenuItem>
              ))}
            </TextField>
          </Stack>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <Checkbox
                checked={allPageSelected}
                indeterminate={somePageSelected}
                onChange={(event) => toggleCurrentPageSelection(event.target.checked)}
              />
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                {t('questionLibrary.selection.pageSummary', {
                  count: total,
                  defaultValue: `${total} matching questions`,
                })}
              </Typography>
              <Button size="small" onClick={selectAllFilteredQuestions}>
                {t('questionLibrary.bulk.selectAllFiltered', { defaultValue: 'Select all filtered' })}
              </Button>
            </Box>
            <Stack direction="row" spacing={1} sx={{
              flexWrap: "wrap"
            }}>
              {!isStudentLibrary && !directSelectionMode ? (
                <Button
                  size="small"
                  startIcon={<EditIcon />}
                  disabled={selectedQuestionIds.length === 0 || saving}
                  onClick={handleOpenVisibilityDialog}
                >
                  {t('questionLibrary.bulk.visibility', { defaultValue: 'Change visibility' })}
                </Button>
              ) : null}
              {(!isStudentLibrary || directSelectionMode || studentPracticeSessions.length > 0) ? (
                <Button
                  size="small"
                  startIcon={<CopyIcon />}
                  disabled={selectedQuestionIds.length === 0 || saving}
                  onClick={() => {
                    if (directSelectionMode) {
                      handleDirectSelectionSubmit();
                      return;
                    }
                    if (isStudentLibrary) {
                      setPracticeSessionDialogOpen(true);
                      return;
                    }
                    setCopyDialogState({ open: true, questionIds: selectedQuestionIds });
                  }}
                >
                  {directSelectionMode
                    ? (selectionAction.buttonLabel || t('questionLibrary.bulk.addToSession', { defaultValue: 'Add to session' }))
                    : isStudentLibrary
                    ? t('questionLibrary.bulk.copyToPracticeSession', { defaultValue: 'Copy to practice session' })
                    : t('questionLibrary.bulk.copy', { defaultValue: 'Copy to course/session' })}
                </Button>
              ) : null}
              <Button
                size="small"
                startIcon={<DownloadIcon />}
                disabled={selectedQuestionIds.length === 0}
                onClick={handleExportQuestions}
              >
                {t('questionLibrary.bulk.export', { defaultValue: 'Export JSON' })}
              </Button>
              <Button
                size="small"
                color="error"
                startIcon={<DeleteIcon />}
                disabled={selectedQuestionIds.length === 0 || saving || (isStudentLibrary && hasSelectedUndeletableQuestions)}
                onClick={() => handleDeleteQuestions(isStudentLibrary ? selectedOwnedQuestions.map((question) => String(question._id)) : selectedQuestionIds)}
              >
                {t('common.delete')}
              </Button>
            </Stack>
          </Box>

          {creatingQuestion ? (
            <Card variant="outlined">
              <CardContent>
                <QuestionEditor
                  open
                  inline
                  initial={null}
                  tagSuggestions={tagOptions}
                  showVisibilityControls={!isStudentLibrary}
                  allowCustomTags={false}
                  showCourseTagSettingsHint={!isStudentLibrary}
                  onAutoSave={handleEditorSave}
                  onClose={async () => {
                    setCreatingQuestion(false);
                    await refreshQuestions();
                  }}
                />
              </CardContent>
            </Card>
          ) : null}

          {loading ? (
            <Box sx={{ py: 4, display: 'flex', justifyContent: 'center' }}>
              <CircularProgress />
            </Box>
          ) : questions.length === 0 ? (
            <Alert severity="info">
              {t('questionLibrary.empty', { defaultValue: 'No questions match the current filters.' })}
            </Alert>
          ) : (
            <Stack spacing={1.5}>
              {questions.map((question, index) => {
                const questionId = String(question._id);
                const studentCanManage = canStudentManageQuestion(question, currentUserId);
                const studentCanCopyQuestion = !isStudentLibrary || studentPracticeSessions.length > 0;
                const checked = selectedIdSet.has(questionId);
                const expanded = !!expandedQuestionIds[questionId];
                const editing = editingQuestionId === questionId;
                const normalizedType = normalizeQuestionType(question);
                const disableTypeSelection = !!question.hasResponses;
                const disableOptionCountChanges = !!question.hasResponses;
                const canDeleteQuestion = canDeleteLibraryQuestion(question, { isStudentLibrary, currentUserId });

                return (
                  <Card key={questionId} variant="outlined">
                    <CardContent sx={{ display: 'flex', gap: 1.25, alignItems: 'flex-start' }}>
                      <Checkbox checked={checked} onChange={() => toggleQuestionSelection(questionId)} />
                      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'flex-start', mb: 1 }}>
                        <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
                          <Chip
                            size="small"
                            color={TYPE_COLORS[normalizedType] || 'default'}
                            label={getQuestionTypeLabel(t, normalizedType, { defaultValue: String(normalizedType) })}
                          />
                          <Chip
                            size="small"
                            variant={question.approved ? 'filled' : 'outlined'}
                            color={question.approved ? 'success' : 'warning'}
                            label={question.approved
                              ? t('questionLibrary.status.approved', { defaultValue: 'Approved' })
                              : t('questionLibrary.status.unapproved', { defaultValue: 'Unapproved' })}
                          />
                          {(question.linkedSessions || []).map((session) => (
                            <Chip
                              key={`${questionId}-${session._id}`}
                              size="small"
                              variant="outlined"
                              label={session.name || t('grades.coursePanel.untitledSession', { defaultValue: 'Untitled session' })}
                            />
                          ))}
                          {!isStudentLibrary && question.hasResponses ? (
                            <Chip
                              size="small"
                              color="error"
                              variant="outlined"
                              label={t('questionLibrary.status.hasResponses', { defaultValue: 'Has responses' })}
                            />
                          ) : null}
                          {!isStudentLibrary && Number(question.responseCount || 0) > 0 ? (
                            <Chip
                              size="small"
                              variant="outlined"
                              label={t('questionLibrary.status.responseCount', {
                                count: Number(question.responseCount || 0),
                                defaultValue: Number(question.responseCount || 0) === 1
                                  ? '1 response'
                                  : `${Number(question.responseCount || 0)} responses`,
                              })}
                            />
                          ) : null}
                          {(question.tags || []).filter((tag) => (
                            String(tag?.label || tag?.value || '').trim().toLowerCase() !== 'qlicker'
                          )).map((tag, tagIndex) => (
                            <Chip
                              key={`${questionId}-tag-${tagIndex}`}
                              size="small"
                              variant="outlined"
                              label={tag.label || tag.value}
                            />
                          ))}
                        </Box>
                        <Stack direction="row" spacing={0.25}>
                          {!isStudentLibrary && !question.approved ? (
                            <Tooltip title={t('questionLibrary.actions.approve', { defaultValue: 'Approve question' })}>
                              <span>
                                <IconButton size="small" aria-label={t('common.approve')} disabled={saving} onClick={() => handleApproveQuestion(questionId)}>
                                  <ApproveIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          ) : null}
                          {!isStudentLibrary && !!question.studentCreated && !question.public ? (
                            <Tooltip title={t('questionLibrary.actions.makePublic', { defaultValue: 'Make question public to the course' })}>
                              <span>
                                <IconButton size="small" aria-label={t('common.makePublic')} disabled={saving} onClick={() => handleMakeQuestionPublic(questionId)}>
                                  <PublicIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          ) : null}
                          {!directSelectionMode && studentCanCopyQuestion ? (
                            <Tooltip
                              title={isStudentLibrary
                                ? t('questionLibrary.bulk.copyToPracticeSession', { defaultValue: 'Copy to practice session' })
                                : t('common.copy', { defaultValue: 'Copy' })}
                            >
                              <span>
                                <IconButton
                                  size="small"
                                  disabled={saving}
                                  aria-label={isStudentLibrary
                                    ? t('questionLibrary.bulk.copyToPracticeSession', { defaultValue: 'Copy to practice session' })
                                    : t('common.copy', { defaultValue: 'Copy' })}
                                  onClick={() => handleCopyQuestionSingle(questionId)}
                                >
                                  <CopyIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          ) : null}
                          {(!isStudentLibrary || studentCanManage) ? (
                            <Tooltip title={editing ? t('professor.sessionEditor.closeEditor') : t('common.edit')}>
                              <span>
                                <IconButton
                                  size="small"
                                  disabled={saving}
                                  aria-label={editing ? t('professor.sessionEditor.closeEditor') : t('common.edit')}
                                  onClick={() => {
                                    if (editing) {
                                      requestInlineEditorClose();
                                      return;
                                    }
                                    openEditEditor(question);
                                  }}
                                >
                                  {editing ? <CloseIcon fontSize="small" /> : <EditIcon fontSize="small" />}
                                </IconButton>
                              </span>
                            </Tooltip>
                          ) : null}
                          <Tooltip title={t('common.delete')}>
                            <span>
                              <IconButton
                                size="small"
                                color="error"
                                aria-label={t('common.delete')}
                                disabled={saving || !canDeleteQuestion}
                                onClick={() => handleDeleteQuestions([questionId])}
                              >
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                      </Box>

                      {editing ? (
                        <QuestionEditor
                          ref={inlineQuestionEditorRef}
                          open
                          inline
                          initial={question}
                          initialBaseline={editingQuestionBaseline}
                          tagSuggestions={tagOptions}
                          showVisibilityControls={!isStudentLibrary}
                          allowCustomTags={false}
                          showCourseTagSettingsHint={!isStudentLibrary}
                          onAutoSave={handleEditorSave}
                          onClose={closeInlineEditor}
                          disableTypeSelection={disableTypeSelection}
                          disableOptionCountChanges={disableOptionCountChanges}
                          typeSelectionLockReason={t('questionLibrary.editLocks.type', {
                            defaultValue: 'Question type is locked because responses already exist.',
                          })}
                          optionCountLockReason={t('questionLibrary.editLocks.options', {
                            defaultValue: 'Option count is locked because responses already exist.',
                          })}
                        />
                      ) : (
                        <Box
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleExpanded(questionId)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              toggleExpanded(questionId);
                            }
                          }}
                          sx={{
                            cursor: 'pointer',
                            borderRadius: 1,
                            p: 0.5,
                            '&:hover': { backgroundColor: 'action.hover' },
                          }}
                        >
                          <Typography
                            variant="caption"
                            sx={{
                              color: "text.secondary",
                              display: 'block',
                              mb: 0.5
                            }}>
                            {t('questionLibrary.previewHint', {
                              number: (page - 1) * limit + index + 1,
                              defaultValue: `Question ${(page - 1) * limit + index + 1}`,
                            })}
                          </Typography>
                          <Box sx={{ position: 'relative', maxHeight: expanded ? 'none' : 220, overflow: 'hidden' }}>
                            <QuestionDisplay question={question} />
                            {!expanded ? (
                              <Box
                                sx={{
                                  position: 'absolute',
                                  left: 0,
                                  right: 0,
                                  bottom: 0,
                                  height: 44,
                                  background: (theme) => `linear-gradient(to bottom, rgba(255,255,255,0), ${theme.palette.background.paper})`,
                                }}
                              />
                            ) : null}
                          </Box>
                        </Box>
                      )}
                    </Box>
                  </CardContent>
                  </Card>
                );
              })}
            </Stack>
          )}

          {showInlineRandomSelectionControls ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{
              alignItems: { xs: 'stretch', sm: 'center' }
            }}>
              <TextField
                size="small"
                type="number"
                label={t('questionLibrary.bulk.randomCount', { defaultValue: 'Random count' })}
                value={randomSelectionCount}
                onChange={(event) => setRandomSelectionCount(Math.max(1, Number(event.target.value) || 1))}
                sx={{ width: { xs: '100%', sm: 150 } }}
                slotProps={{
                  htmlInput: { min: 1 }
                }}
              />
              <Button variant="outlined" onClick={selectRandomFilteredQuestions} disabled={saving}>
                {t('questionLibrary.bulk.selectRandomFiltered', {
                  count: Math.max(1, Number(randomSelectionCount) || 1),
                  defaultValue: `Choose ${Math.max(1, Number(randomSelectionCount) || 1)} at random`,
                })}
              </Button>
            </Stack>
          ) : null}

          <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>
              {t('questionLibrary.pagination.summary', {
                page,
                pages: Math.max(Math.ceil(total / limit), 1),
                defaultValue: `Page ${page} of ${Math.max(Math.ceil(total / limit), 1)}`,
              })}
            </Typography>
            <Stack direction="row" spacing={1}>
              <Button disabled={page <= 1} onClick={() => setPage((previous) => Math.max(previous - 1, 1))}>
                {t('common.previous', { defaultValue: 'Previous' })}
              </Button>
              <Button
                disabled={page >= Math.max(Math.ceil(total / limit), 1)}
                onClick={() => setPage((previous) => previous + 1)}
              >
                {t('common.next', { defaultValue: 'Next' })}
              </Button>
            </Stack>
          </Box>
        </Stack>
      </Paper>

      <SessionSelectorDialog
        open={sessionDialogOpen}
        title={t('questionLibrary.filters.sessionsDialogTitle', { defaultValue: 'Filter by sessions' })}
        sessions={sourceSessions}
        selectedIds={selectedSessionIds}
        onChange={(ids) => setSelectedSessionIds(ids)}
        onClose={() => setSessionDialogOpen(false)}
        onConfirm={() => {
          setPage(1);
          setSessionDialogOpen(false);
        }}
        confirmLabel={t('questionLibrary.filters.applySessions', { defaultValue: 'Apply sessions' })}
      />

      <QuestionCopyDialog
        open={copyDialogState.open}
        courses={courses}
        selectedCount={copyDialogState.questionIds.length}
        defaultCourseId={courseId}
        onClose={() => setCopyDialogState({ open: false, questionIds: [] })}
        onConfirm={handleCopyQuestions}
      />

      <SessionSelectorDialog
        open={practiceSessionDialogOpen}
        title={t('questionLibrary.bulk.copyToPracticeSession', { defaultValue: 'Copy to practice session' })}
        sessions={studentPracticeSessions}
        selectedIds={selectedPracticeSessionIds}
        headerContent={(
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mb: 1.25
            }}>
            {studentPracticeSessions.length > 0
              ? t('questionLibrary.bulk.practiceSessionHelp', {
                defaultValue: 'Choose one of your practice sessions to receive the selected questions.',
              })
              : t('questionLibrary.bulk.practiceSessionEmpty', {
                defaultValue: 'Create a practice session first to reuse selected questions there.',
              })}
          </Typography>
        )}
        onChange={(ids) => setSelectedPracticeSessionIds(ids.length > 0 ? [ids[ids.length - 1]] : [])}
        onClose={() => {
          setPracticeSessionDialogOpen(false);
          setSelectedPracticeSessionIds([]);
        }}
        onConfirm={handleAddQuestionsToPracticeSession}
        confirmLabel={t('questionLibrary.bulk.addToPracticeSessionConfirm', { defaultValue: 'Add questions' })}
      />

      <Dialog open={visibilityDialogOpen} onClose={() => setVisibilityDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          {t('questionLibrary.bulk.visibilityTitle', {
            count: selectedQuestionIds.length,
            defaultValue: selectedQuestionIds.length === 1 ? 'Change question visibility' : `Change visibility for ${selectedQuestionIds.length} questions`,
          })}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>
              {t('questionLibrary.bulk.visibilityHelp', {
                defaultValue: 'Choose who can find the selected questions outside normal session review.',
              })}
            </Typography>
            <FormControlLabel
              control={(
                <Switch
                  checked={!!bulkVisibilityForm.public}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setBulkVisibilityForm((current) => ({
                      ...current,
                      public: checked,
                      ...(checked ? {} : {
                        publicOnQlicker: false,
                        publicOnQlickerForStudents: false,
                      }),
                    }));
                  }}
                />
              )}
              label={t('questions.editor.coursePublic', { defaultValue: 'Visible to students in this course' })}
            />
            <FormControlLabel
              control={(
                <Switch
                  checked={!!bulkVisibilityForm.publicOnQlicker}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setBulkVisibilityForm((current) => ({
                      ...current,
                      public: checked ? true : current.public,
                      publicOnQlicker: checked,
                      publicOnQlickerForStudents: checked ? current.publicOnQlickerForStudents : false,
                    }));
                  }}
                />
              )}
              label={t('questions.editor.qlickerPublic', { defaultValue: 'Visible to any prof on Qlicker' })}
            />
            {bulkVisibilityForm.publicOnQlicker ? (
              <FormControlLabel
                sx={{ ml: 3 }}
                control={(
                  <Switch
                    checked={!!bulkVisibilityForm.publicOnQlickerForStudents}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setBulkVisibilityForm((current) => ({
                        ...current,
                        publicOnQlickerForStudents: checked,
                      }));
                    }}
                  />
                )}
                label={t('questions.editor.qlickerPublicStudents', { defaultValue: 'Allow student accounts to view it outside this course' })}
              />
            ) : null}
            {showBulkVisibilityWarning ? (
              <Alert severity="warning">
                {t('questionLibrary.bulk.visibilitySessionWarning', {
                  count: selectedLinkedSessionCount,
                  defaultValue: 'Some selected questions are already used in a session. Students normally see session questions by making that session reviewable instead of making the individual question public.',
                })}
              </Alert>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setVisibilityDialogOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={handleBulkVisibilitySave} disabled={saving}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </DialogActions>
      </Dialog>

      <ImportQuestionsDialog
        open={importDialogOpen}
        sessions={availableSessions}
        tagSuggestions={tagOptions}
        importTags={importTags}
        previewQuestions={importPreviewQuestions}
        selectedIds={importSelectedIds}
        onImportTagsChange={setImportTags}
        onFileSelected={handleImportFileSelected}
        onSelectionChange={setImportSelectedIds}
        onClose={() => setImportDialogOpen(false)}
        onConfirm={handleConfirmImport}
      />
    </Box>
  );
}

export default QuestionLibraryPanel;
