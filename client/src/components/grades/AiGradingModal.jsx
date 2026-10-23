import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';
import AiGradingForm from './AiGradingForm';
import AiModelSelect, { parseAiModelValue } from '../ai/AiModelSelect';
import { QUESTION_TYPES, normalizeQuestionType } from '../questions/constants';

function canManualGrade(question) {
  return ![
    QUESTION_TYPES.MULTIPLE_CHOICE,
    QUESTION_TYPES.TRUE_FALSE,
    QUESTION_TYPES.MULTI_SELECT,
    QUESTION_TYPES.NUMERICAL,
  ].includes(normalizeQuestionType(question));
}

export default function AiGradingModal({
  open,
  onClose,
  courseId,
  sessionId,
  questions,
  needsGradingQuestionIds,
  onStarted,
}) {
  const { t } = useTranslation();
  const [instructions, setInstructions] = useState([]);
  const [activeId, setActiveId] = useState('');
  const [selected, setSelected] = useState([]);
  const [forms, setForms] = useState({});
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const initializedRubricRef = useRef(false);
  const selectedRef = useRef([]);
  const formsRef = useRef({});
  const manualQuestions = useMemo(() => questions.filter(canManualGrade), [questions]);

  useEffect(() => {
    if (!open) return undefined;
    setActiveId(String(manualQuestions[0]?._id || ''));
    setForms({});
    setError('');
    initializedRubricRef.current = false;
    let mounted = true;
    Promise.all([
      apiClient.get(`/ai/courses/${courseId}/grading-instructions`),
      apiClient.get(`/ai/courses/${courseId}/sessions/${sessionId}/ai-grading-rubric`),
    ])
      .then(([instructionResponse, rubricResponse]) => {
        if (!mounted) return;
        const rubric = rubricResponse.data?.rubric;
        const availableInstructions = instructionResponse.data.instructions || [];
        setInstructions(availableInstructions);
        const nextSelected = rubric?.questionIds?.length
          ? rubric.questionIds.map(String)
          : manualQuestions
            .filter((question) => needsGradingQuestionIds.includes(String(question._id)))
            .map((question) => String(question._id));
        const nextForms = rubric?.instructions || {};
        selectedRef.current = nextSelected;
        formsRef.current = nextForms;
        setSelected(nextSelected);
        setForms(nextForms);
        initializedRubricRef.current = true;
      })
      .catch(() => {
        if (mounted) setError(t('grades.aiGrading.failedLoad'));
      });
    return () => { mounted = false; };
  // A modal opening is the only time this state should be initialized. In
  // particular, do not reinitialize when a checkbox or instruction changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, courseId, sessionId]);

  const persistRubric = (nextSelected = selectedRef.current, nextForms = formsRef.current) => {
    if (!initializedRubricRef.current) return;
    apiClient.put(`/ai/courses/${courseId}/sessions/${sessionId}/ai-grading-rubric`, {
      questionIds: nextSelected,
      instructions: nextForms,
    }).catch(() => {});
  };

  const close = () => {
    persistRubric();
    onClose();
  };

  const saveInstruction = async (instruction) => {
    const { data } = await apiClient.post(`/ai/courses/${courseId}/grading-instructions`, instruction);
    setInstructions((current) => [
      ...current.filter((entry) => entry._id !== data.instruction._id),
      data.instruction,
    ]);
    return data.instruction;
  };

  const deleteInstruction = async (instruction) => {
    await apiClient.delete(`/ai/courses/${courseId}/grading-instructions/${instruction._id}`);
    setInstructions((current) => current.filter((entry) => entry._id !== instruction._id));
    setForms((current) => Object.fromEntries(Object.entries(current).map(([questionId, form]) => (
      form[`${instruction.kind}InstructionId`] === instruction._id
        ? [questionId, { ...form, [`${instruction.kind}InstructionId`]: '', [instruction.kind]: '' }]
        : [questionId, form]
    ))));
  };

  const toggleQuestion = (questionId) => {
    setSelected((current) => {
      const next = (
      current.includes(questionId)
        ? current.filter((id) => id !== questionId)
        : [...current, questionId]
      );
      selectedRef.current = next;
      persistRubric(next);
      return next;
    });
  };

  const start = async () => {
    setError('');
    const missing = selected.filter((questionId) => (
      !forms[questionId]?.gradingInstructionId || !forms[questionId]?.feedbackInstructionId
    ));
    if (missing.length) {
      setError(t('grades.aiGrading.instructionsRequired'));
      setActiveId(missing[0]);
      return;
    }

    setStarting(true);
    try {
      const prepared = Object.fromEntries(selected.map((questionId) => {
        const form = forms[questionId] || {};
        return [questionId, {
          grading: form.grading || '',
          feedback: form.feedback || '',
          gradingInstructionId: form.gradingInstructionId || '',
          feedbackInstructionId: form.feedbackInstructionId || '',
          regrade: !!form.regrade,
        }];
      }));
      const { data } = await apiClient.post(
        `/ai/courses/${courseId}/sessions/${sessionId}/ai-grading`,
        {
          questionIds: selected,
          instructions: prepared,
          ...parseAiModelValue(selectedModel),
        }
      );
      onStarted(data.job);
      close();
    } catch (err) {
      setError(err.response?.data?.message || t('grades.aiGrading.failedStart'));
    } finally {
      setStarting(false);
    }
  };

  const activeQuestion = manualQuestions.find((question) => String(question._id) === activeId);
  const activeQuestionNumber = activeQuestion ? questions.findIndex((question) => question === activeQuestion) + 1 : null;
  const form = activeId ? (forms[activeId] || {}) : null;
  const canStart = !!selectedModel && selected.length > 0 && selected.every((questionId) => (
    forms[questionId]?.gradingInstructionId && forms[questionId]?.feedbackInstructionId
  ));

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="md">
      <DialogTitle>{t('grades.aiGrading.title')}</DialogTitle>
      <DialogContent dividers>
        {error ? <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert> : null}
        <Box sx={{ mb: 2 }}><AiModelSelect courseId={courseId} value={selectedModel} onChange={setSelectedModel} disabled={starting} task="grading" /></Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '180px 1fr' }, gap: 2 }}>
          <List dense aria-label={t('grades.aiGrading.questionSelection')} sx={{ borderRight: { sm: 1 }, borderColor: 'divider', maxHeight: 440, overflowY: 'auto' }}>
            {questions.map((question, index) => {
              const id = String(question._id);
              const enabled = canManualGrade(question);
              const hasGuidance = !!forms[id]?.gradingInstructionId && !!forms[id]?.feedbackInstructionId;
              return (
                <ListItemButton
                  key={id}
                  disabled={!enabled}
                  selected={activeId === id}
                  onClick={() => setActiveId(id)}
                >
                  <Checkbox
                    size="small"
                    checked={selected.includes(id)}
                    disabled={!enabled}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      event.stopPropagation();
                      toggleQuestion(id);
                    }}
                    slotProps={{
                      input: { 'aria-label': t('grades.aiGrading.includeQuestion', { question: index + 1 }) }
                    }}
                  />
                  <ListItemText
                    primary={`Q${index + 1}`}
                    secondary={!enabled ? t('grades.aiGrading.notEligible') : selected.includes(id) && !hasGuidance ? t('grades.aiGrading.guidanceMissing') : t('grades.aiGrading.clickQuestionToEdit')}
                  />
                </ListItemButton>
              );
            })}
          </List>
          {activeQuestion ? (
            <AiGradingForm
              key={activeId}
              questionNumber={activeQuestionNumber}
              value={form}
              instructions={instructions}
              onChange={(value) => setForms((current) => {
                const next = { ...current, [activeId]: value };
                formsRef.current = next;
                persistRubric(selectedRef.current, next);
                return next;
              })}
              onSaveInstruction={saveInstruction}
              onDeleteInstruction={deleteInstruction}
            />
          ) : (
            <Box sx={{ display: 'flex', alignItems: 'center', minHeight: 180 }}>
              <Typography sx={{
                color: "text.secondary"
              }}>
                {t('grades.aiGrading.selectQuestionGuidance')}
              </Typography>
            </Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{t('common.cancel')}</Button>
        <Button variant="contained" disabled={!canStart || starting} onClick={start}>
          {t('grades.aiGrading.start')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
