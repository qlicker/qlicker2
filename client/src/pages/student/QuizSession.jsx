import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import {
  Box,
  Typography,
  Paper,
  Alert,
  CircularProgress,
  Button,
  Chip,
  FormControlLabel,
  Switch,
  TextField,
  Radio,
  RadioGroup,
  Checkbox,
  FormGroup,
  Divider,
} from '@mui/material';
import apiClient, { getUsableAccessToken } from '../../api/client';
import { closeWebSocketQuietly } from '../../utils/liveSocket';
import StudentRichTextEditor, { MathPreview } from '../../components/questions/StudentRichTextEditor';
import BackLinkButton from '../../components/common/BackLinkButton';
import AnonymousSessionNotice from '../../components/common/AnonymousSessionNotice';
import {
  QUESTION_TYPES,
  TYPE_COLORS,
  getQuestionTypeLabel,
  buildQuestionProgressList,
  isResponseQuestionType,
  isSlideType,
  normalizeQuestionType,
} from '../../components/questions/constants';
import { useTranslation } from 'react-i18next';
import {
  normalizeStoredHtml,
  prepareRichTextInput,
  renderKatexInElement,
} from '../../components/questions/richTextUtils';
import { formatToleranceValue } from '../../utils/numericalFormatting';
import { useAuth } from '../../contexts/AuthContext';
import { getDashboardPath } from '../../utils/dashboard';

const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

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

function buildWebsocketUrl(token) {
  const encodedToken = encodeURIComponent(token);
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws?token=${encodedToken}`;
}

function normalizeValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function optionId(option, index) {
  return String(option?._id ?? index);
}

function parseMultiSelectAnswer(answer) {
  if (Array.isArray(answer)) return answer.map((entry) => String(entry));
  if (answer === undefined || answer === null || answer === '') return [];
  if (typeof answer === 'string' && answer.includes(',')) {
    return answer.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [String(answer)];
}

function hasAnswerForDraft(question, draft) {
  const qType = normalizeQuestionType(question);
  if (!isResponseQuestionType(qType)) {
    return true;
  }
  if (qType === QUESTION_TYPES.MULTI_SELECT) {
    return Array.isArray(draft?.answer) && draft.answer.length > 0;
  }
  if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    return normalizeValue(draft?.answer).length > 0;
  }
  return draft?.answer !== undefined && draft?.answer !== null && String(draft.answer) !== '';
}

function getDraftForQuestion(question, response) {
  const qType = normalizeQuestionType(question);
  if (!isResponseQuestionType(qType)) {
    return {
      answer: '',
      answerWysiwyg: '',
    };
  }

  if (qType === QUESTION_TYPES.MULTI_SELECT) {
    return {
      answer: parseMultiSelectAnswer(response?.answer),
      answerWysiwyg: normalizeValue(response?.answerWysiwyg),
    };
  }

  if (qType === QUESTION_TYPES.SHORT_ANSWER) {
    return {
      answer: normalizeValue(response?.answer),
      answerWysiwyg: normalizeValue(response?.answerWysiwyg),
    };
  }

  return {
    answer: response?.answer === undefined || response?.answer === null ? '' : String(response.answer),
    answerWysiwyg: normalizeValue(response?.answerWysiwyg),
  };
}

function getOptionRichContentProps(option) {
  return {
    html: normalizeStoredHtml(option?.content || ''),
    fallback: option?.plainText || option?.answer || '',
  };
}

function hasCorrectOption(options = []) {
  return options.some((option) => !!option?.correct);
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

export default function QuizSession() {
  const { courseId, sessionId } = useParams();
  const navigate = useNavigate();
  const isOutsideActivity = useLocation().pathname.startsWith('/activity/');
  const { user } = useAuth();
  const dashboardPath = getDashboardPath(user);
  const { t, i18n } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [session, setSession] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [responsesByQuestion, setResponsesByQuestion] = useState({});
  const [draftByQuestion, setDraftByQuestion] = useState({});
  const [autosaveStateByQuestion, setAutosaveStateByQuestion] = useState({});
  const [submittingQuiz, setSubmittingQuiz] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [singleQuestionMode, setSingleQuestionMode] = useState(false);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [showSolutionByQuestion, setShowSolutionByQuestion] = useState({});
  const [lockingQuestionId, setLockingQuestionId] = useState('');

  const autosaveTimersRef = useRef(new Map());
  const latestQuestionsRef = useRef([]);
  const courseQuizTabLink = useMemo(() => (
    isOutsideActivity ? dashboardPath : session?.studentCreated
      ? `/student/course/${courseId}?tab=2`
      : `/student/course/${courseId}?tab=1`
  ), [courseId, dashboardPath, isOutsideActivity, session?.studentCreated]);

  const hydrateFromPayload = useCallback((payload) => {
    const nextSession = payload?.session || null;
    const nextQuestions = payload?.questions || [];
    const nextResponses = payload?.responses || {};

    setSession(nextSession);
    setQuestions(nextQuestions);
    setResponsesByQuestion(nextResponses);

    setDraftByQuestion((prev) => {
      const previousQuestionById = new Map(
        latestQuestionsRef.current.map((question) => [String(question._id), question])
      );
      const nextDrafts = {};

      nextQuestions.forEach((question) => {
        const qId = String(question._id);
        const previousQuestion = previousQuestionById.get(qId);
        const draftCanCarryForward = prev[qId] !== undefined
          && previousQuestion
          && normalizeQuestionType(previousQuestion) === normalizeQuestionType(question)
          && (previousQuestion.options?.length || 0) === (question.options?.length || 0);

        nextDrafts[qId] = draftCanCarryForward
          ? prev[qId]
          : getDraftForQuestion(question, nextResponses[qId]);
      });

      return nextDrafts;
    });
    latestQuestionsRef.current = nextQuestions;
  }, []);

  const fetchQuiz = useCallback(async () => {
    try {
      const { data } = await apiClient.get(`/sessions/${sessionId}/quiz`);
      hydrateFromPayload(data);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || t('student.quiz.failedLoadQuiz'));
    } finally {
      setLoading(false);
    }
  }, [hydrateFromPayload, sessionId]);

  useEffect(() => {
    fetchQuiz();
  }, [fetchQuiz]);

  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let pollingTimer = null;
    let closed = false;

    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      fetchQuiz();
    };

    const startPolling = () => {
      if (pollingTimer || closed) return;
      pollingTimer = setInterval(refresh, 3000);
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

      ws.onopen = () => { stopPolling(); };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          const evt = message?.event;
          const data = message?.data;
          if (!evt || String(data?.sessionId || '') !== String(sessionId)) return;

          switch (evt) {
            case 'session:question-changed':
            case 'session:visibility-changed':
            case 'session:status-changed':
            case 'session:question-updated':
            case 'session:metadata-changed':
            case 'session:quiz-submitted':
              fetchQuiz();
              break;
            default:
              break;
          }
        } catch {
          // Ignore malformed payloads.
        }
      };

      ws.onclose = () => {
        if (closed) return;
        startPolling();
        reconnectTimer = setTimeout(() => { void connect(); }, 2500);
      };
    };

    const init = async () => {
      try {
        const { data } = await apiClient.get('/health');
        if (data?.websocket === true) {
          void connect();
          return;
        }
      } catch {
        // Fall back to polling when websocket health is unavailable.
      }
      startPolling();
    };

    init();

    const handleVisibility = () => refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPolling();
      closeWebSocketQuietly(ws);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchQuiz, sessionId]);

  useEffect(() => () => {
    autosaveTimersRef.current.forEach((timerId) => clearTimeout(timerId));
    autosaveTimersRef.current.clear();
  }, []);

  useEffect(() => {
    setCurrentQuestionIndex((previous) => Math.min(previous, Math.max(questions.length - 1, 0)));
  }, [questions.length]);

  const saveDraftNow = useCallback(async (questionId, draft) => {
    if (!draft) return null;
    setAutosaveStateByQuestion((prev) => ({ ...prev, [questionId]: 'saving' }));
    try {
      const payload = {
        questionId,
        answer: draft.answer,
      };
      if (draft.answerWysiwyg) payload.answerWysiwyg = draft.answerWysiwyg;
      const { data } = await apiClient.patch(`/sessions/${sessionId}/quiz-response`, payload);
      const response = data?.response;
      if (response) {
        setResponsesByQuestion((prev) => ({ ...prev, [questionId]: response }));
      }
      setAutosaveStateByQuestion((prev) => ({ ...prev, [questionId]: 'saved' }));
      return response || null;
    } catch (err) {
      setAutosaveStateByQuestion((prev) => ({ ...prev, [questionId]: 'error' }));
      return null;
    }
  }, [sessionId]);

  const queueAutosave = useCallback((questionId, draft) => {
    const timers = autosaveTimersRef.current;
    const currentTimer = timers.get(questionId);
    if (currentTimer) clearTimeout(currentTimer);

    const timerId = setTimeout(() => {
      saveDraftNow(questionId, draft);
      timers.delete(questionId);
    }, 450);

    timers.set(questionId, timerId);
  }, [saveDraftNow]);

  const updateDraft = useCallback((question, updater) => {
    const qId = String(question._id);
    const response = responsesByQuestion[qId];
    if (response && response.editable === false) return;

    setDraftByQuestion((prev) => {
      const current = prev[qId] || getDraftForQuestion(question, response);
      const next = typeof updater === 'function' ? updater(current) : updater;
      queueAutosave(qId, next);
      return { ...prev, [qId]: next };
    });
  }, [queueAutosave, responsesByQuestion]);

  const flushAutosaves = useCallback(async () => {
    const pendingEntries = [...autosaveTimersRef.current.entries()];
    pendingEntries.forEach(([, timerId]) => clearTimeout(timerId));
    autosaveTimersRef.current.clear();

    if (!pendingEntries.length) return;

    await Promise.all(
      pendingEntries.map(([questionId]) => saveDraftNow(questionId, draftByQuestion[questionId]))
    );
  }, [draftByQuestion, saveDraftNow]);

  const handleSubmitQuiz = useCallback(async () => {
    setSubmittingQuiz(true);
    setSubmitError('');
    try {
      await flushAutosaves();
      await apiClient.post(`/sessions/${sessionId}/submit`);
      navigate(courseQuizTabLink);
    } catch (err) {
      setSubmitError(err.response?.data?.message || t('student.quiz.failedSubmitQuiz'));
    } finally {
      setSubmittingQuiz(false);
    }
  }, [courseQuizTabLink, flushAutosaves, navigate, sessionId]);

  const handleFinishPracticeQuiz = useCallback(async () => {
    setSubmittingQuiz(true);
    setSubmitError('');
    try {
      await flushAutosaves();
      for (const question of questions) {
        if (isSlideType(normalizeQuestionType(question))) continue;
        const questionId = String(question._id);
        const response = responsesByQuestion[questionId];
        const locked = !!response && response.editable === false;
        if (locked) continue;

        const draft = draftByQuestion[questionId] || getDraftForQuestion(question, response);
        if (!hasAnswerForDraft(question, draft)) continue;

        // eslint-disable-next-line no-await-in-loop
        await saveDraftNow(questionId, draft);
        // eslint-disable-next-line no-await-in-loop
        await apiClient.post(`/sessions/${sessionId}/quiz-question-submit`, { questionId });
      }
      navigate(courseQuizTabLink);
    } catch (err) {
      setSubmitError(err.response?.data?.message || t('student.quiz.failedSubmitQuiz'));
    } finally {
      setSubmittingQuiz(false);
    }
  }, [courseQuizTabLink, draftByQuestion, flushAutosaves, navigate, questions, responsesByQuestion, saveDraftNow, sessionId]);

  const handleSubmitPracticeQuestion = useCallback(async (questionId) => {
    const question = questions.find((entry) => String(entry._id) === String(questionId));
    if (!question) return;
    if (isSlideType(normalizeQuestionType(question))) return;

    setLockingQuestionId(questionId);
    setSubmitError('');
    try {
      await saveDraftNow(questionId, draftByQuestion[questionId] || getDraftForQuestion(question, responsesByQuestion[questionId]));
      await apiClient.post(`/sessions/${sessionId}/quiz-question-submit`, { questionId });
      await fetchQuiz();
    } catch (err) {
      setSubmitError(err.response?.data?.message || t('student.quiz.failedSubmitQuestion'));
    } finally {
      setLockingQuestionId('');
    }
  }, [draftByQuestion, fetchQuiz, questions, responsesByQuestion, saveDraftNow, sessionId]);

  const practiceQuiz = !!session?.practiceQuiz;
  const answerableQuestions = useMemo(
    () => questions.filter((question) => isResponseQuestionType(normalizeQuestionType(question))),
    [questions]
  );
  const answerableQuestionCount = answerableQuestions.length;

  const answeredCount = useMemo(() => {
    return answerableQuestions.reduce((count, question) => {
      const qId = String(question._id);
      const response = responsesByQuestion[qId];
      const draft = draftByQuestion[qId] || getDraftForQuestion(question, response);
      return count + (hasAnswerForDraft(question, draft) ? 1 : 0);
    }, 0);
  }, [answerableQuestions, draftByQuestion, responsesByQuestion]);

  const canSubmitQuiz = useMemo(() => {
    if (practiceQuiz || submittingQuiz) return false;
    return answerableQuestions.every((question) => {
      const qId = String(question._id);
      const response = responsesByQuestion[qId];
      const draft = draftByQuestion[qId] || getDraftForQuestion(question, response);
      return hasAnswerForDraft(question, draft);
    });
  }, [answerableQuestions, draftByQuestion, practiceQuiz, responsesByQuestion, submittingQuiz]);
  const allQuestionsAnswered = useMemo(() => (
    answerableQuestionCount === 0 || answeredCount === answerableQuestionCount
  ), [answerableQuestionCount, answeredCount]);
  const showSubmitButton = !submittingQuiz && allQuestionsAnswered;

  const questionsToRender = useMemo(() => {
    if (!singleQuestionMode) return questions;
    if (!questions.length) return [];
    return [questions[currentQuestionIndex]];
  }, [currentQuestionIndex, questions, singleQuestionMode]);
  const progressList = useMemo(() => buildQuestionProgressList(questions), [questions]);
  const progressByQuestionId = useMemo(() => new Map(
    questions.map((question, index) => [String(question._id), progressList[index] || null])
  ), [progressList, questions]);
  const currentProgress = progressList[currentQuestionIndex] || null;

  if (loading) {
    return (
      <Box sx={{ p: 4, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress aria-label={t('student.quiz.loadingQuiz')} />
      </Box>
    );
  }

  if (error || !session) {
    return (
      <Box sx={{ p: 3, maxWidth: 760, mx: 'auto' }}>
        <Alert severity="error" sx={{ mb: 2 }}>{error || t('student.quiz.quizNotFound')}</Alert>
        <BackLinkButton variant="outlined" label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.quiz.backToCourse')} onClick={() => navigate(courseQuizTabLink)} />
      </Box>
    );
  }

  if (session.status === 'done') {
    return (
      <Box sx={{ p: 3, maxWidth: 760, mx: 'auto' }}>
        <Alert severity="info" sx={{ mb: 2 }}>
          {t('student.quiz.quizClosed')}
        </Alert>
        <BackLinkButton variant="outlined" label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.quiz.backToCourse')} onClick={() => navigate(courseQuizTabLink)} />
      </Box>
    );
  }

  if (session.quizSubmittedByCurrentUser && !practiceQuiz) {
    return (
      <Box sx={{ p: 3, maxWidth: 760, mx: 'auto' }}>
        <Alert severity="success" sx={{ mb: 2 }}>
          {t('student.quiz.alreadySubmitted')}
        </Alert>
        <BackLinkButton variant="outlined" label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.quiz.backToCourse')} onClick={() => navigate(courseQuizTabLink)} />
      </Box>
    );
  }

  return (
    <Box sx={{ p: { xs: 1.5, sm: 2.5 }, maxWidth: 860, mx: 'auto' }}>
      <Box sx={{ mb: 1.25 }}>
        <BackLinkButton variant="outlined" label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.quiz.backToCourse')} onClick={() => navigate(courseQuizTabLink)} />
      </Box>

      <Box sx={{ mb: 2, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, flexGrow: 1 }}>
          {session.name || t('student.quiz.quizFallback')}
        </Typography>
        <Chip label={practiceQuiz ? t('student.quiz.practiceQuizLabel') : t('student.quiz.quizLabel')} color={practiceQuiz ? 'info' : 'primary'} size="small" />
        <Chip label={t('student.quiz.answeredCount', { answered: answeredCount, total: answerableQuestionCount })} variant="outlined" size="small" />
      </Box>

      {session.anonymous ? <AnonymousSessionNotice /> : null}

      <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
        <FormControlLabel
          control={(
            <Switch
              checked={singleQuestionMode}
              onChange={(event) => setSingleQuestionMode(event.target.checked)}
            />
          )}
          label={t('student.quiz.oneAtATime')}
        />

        {singleQuestionMode && questions.length > 0 && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Button
              size="small"
              variant="outlined"
              onClick={() => setCurrentQuestionIndex((index) => Math.max(0, index - 1))}
              disabled={currentQuestionIndex <= 0}
            >
              {t('common.previous')}
            </Button>
            {currentProgress && (
              <>
                <Chip
                  label={t('student.quiz.pageProgress', {
                    current: currentProgress.pageCurrent,
                    total: currentProgress.pageTotal,
                  })}
                  size="small"
                  variant="outlined"
                />
                <Chip
                  label={t('student.quiz.questionProgress', {
                    current: currentProgress.questionCurrent,
                    total: currentProgress.questionTotal,
                  })}
                  size="small"
                  variant="outlined"
                />
              </>
            )}
            <Button
              size="small"
              variant="outlined"
              onClick={() => setCurrentQuestionIndex((index) => Math.min(questions.length - 1, index + 1))}
              disabled={currentQuestionIndex >= questions.length - 1}
            >
              {t('common.next')}
            </Button>
          </Box>
        )}
      </Paper>

      {submitError && <Alert severity="error" sx={{ mb: 2 }}>{submitError}</Alert>}

      {questionsToRender.map((question) => {
        const qId = String(question._id);
        const qType = normalizeQuestionType(question);
        const progress = progressByQuestionId.get(qId);
        const response = responsesByQuestion[qId];
        const draft = draftByQuestion[qId] || getDraftForQuestion(question, response);
        const locked = !!response && response.editable === false;
        const autosaveState = autosaveStateByQuestion[qId] || 'idle';
        const showSolution = !!showSolutionByQuestion[qId] && locked;
        const showCorrectForQuestion = showSolution && practiceQuiz;
        const isSlide = isSlideType(qType);
        const questionHasRevealableSolution = !!(
          question.solution
          || question.correctNumerical != null
          || hasCorrectOption(question.options)
        );
        const optionAnswers = qType === QUESTION_TYPES.MULTI_SELECT
          ? (Array.isArray(draft.answer) ? draft.answer : [])
          : [];

        return (
          <Paper key={qId} variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
              {progress && (
                <>
                  <Chip
                    label={t('student.quiz.pageProgress', {
                      current: progress.pageCurrent,
                      total: progress.pageTotal,
                    })}
                    size="small"
                    variant="outlined"
                  />
                  <Chip
                    label={t('student.quiz.questionProgress', {
                      current: progress.questionCurrent,
                      total: progress.questionTotal,
                    })}
                    size="small"
                    variant="outlined"
                  />
                </>
              )}
              <Chip
                label={getQuestionTypeLabel(t, qType, {
                  key: 'grades.coursePanel.question',
                  defaultValue: 'Question',
                })}
                color={TYPE_COLORS[qType] || 'default'}
                size="small"
              />
              {!isSlide && locked && <Chip label={t('student.quiz.submitted')} color="success" size="small" variant="outlined" />}
              {!isSlide && !locked && autosaveState === 'saving' && <Chip label={t('student.quiz.saving')} size="small" variant="outlined" />}
              {!isSlide && !locked && autosaveState === 'saved' && <Chip label={t('student.quiz.saved')} size="small" variant="outlined" />}
              {!isSlide && !locked && autosaveState === 'error' && <Chip label={t('student.quiz.saveFailed')} color="error" size="small" variant="outlined" />}
            </Box>

            <Box sx={{ mb: 2 }}>
              <RichContent html={question.content} fallback={question.plainText} allowVideoEmbeds />
            </Box>

            {(qType === QUESTION_TYPES.MULTIPLE_CHOICE || qType === QUESTION_TYPES.TRUE_FALSE) && (
              <RadioGroup
                value={draft.answer ?? ''}
                onChange={(event) => {
                  updateDraft(question, (current) => ({
                    ...current,
                    answer: event.target.value,
                  }));
                }}
              >
                {(question.options || []).map((option, index) => {
                  const value = optionId(option, index);
                  const selected = String(draft.answer || '') === value;
                  const isCorrect = showCorrectForQuestion && !!option.correct;
                  const optionContent = getOptionRichContentProps(option);
                  return (
                    <Paper
                      key={value}
                      variant="outlined"
                      sx={{
                        p: 1.25,
                        mb: 0.75,
                        borderColor: isCorrect ? 'success.main' : selected ? 'primary.main' : 'divider',
                        bgcolor: isCorrect ? 'success.50' : 'transparent',
                        opacity: locked ? 0.85 : 1,
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                        <Radio
                          value={value}
                          checked={selected}
                          disabled={locked}
                          onChange={() => {
                            updateDraft(question, (current) => ({
                              ...current,
                              answer: value,
                            }));
                          }}
                        />
                        <Chip label={OPTION_LETTERS[index]} size="small" />
                        <Box sx={{ minWidth: 0, pt: 0.6 }}>
                          <RichContent html={optionContent.html} fallback={optionContent.fallback} />
                        </Box>
                      </Box>
                    </Paper>
                  );
                })}
              </RadioGroup>
            )}

            {qType === QUESTION_TYPES.MULTI_SELECT && (
              <FormGroup>
                {(question.options || []).map((option, index) => {
                  const value = optionId(option, index);
                  const checked = optionAnswers.includes(value);
                  const isCorrect = showCorrectForQuestion && !!option.correct;
                  const optionContent = getOptionRichContentProps(option);
                  return (
                    <Paper
                      key={value}
                      variant="outlined"
                      sx={{
                        p: 1.25,
                        mb: 0.75,
                        borderColor: isCorrect ? 'success.main' : checked ? 'primary.main' : 'divider',
                        bgcolor: isCorrect ? 'success.50' : 'transparent',
                        opacity: locked ? 0.85 : 1,
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                        <Checkbox
                          checked={checked}
                          disabled={locked}
                          onChange={() => {
                            updateDraft(question, (current) => {
                              const currentValues = Array.isArray(current.answer) ? [...current.answer] : [];
                              return {
                                ...current,
                                answer: currentValues.includes(value)
                                  ? currentValues.filter((entry) => entry !== value)
                                  : [...currentValues, value],
                              };
                            });
                          }}
                        />
                        <Chip label={OPTION_LETTERS[index]} size="small" />
                        <Box sx={{ minWidth: 0, pt: 0.6 }}>
                          <RichContent html={optionContent.html} fallback={optionContent.fallback} />
                        </Box>
                      </Box>
                    </Paper>
                  );
                })}
              </FormGroup>
            )}

            {qType === QUESTION_TYPES.SHORT_ANSWER && (
              <Box>
                {locked ? (
                  <Paper variant="outlined" sx={{ p: 1.25, opacity: 0.85 }}>
                    {response?.answerWysiwyg ? (
                      <RichContent html={response.answerWysiwyg} />
                    ) : (
                      <Typography variant="body2">{normalizeValue(response?.answer) || t('common.noAnswer')}</Typography>
                    )}
                  </Paper>
                ) : (
                  <>
                    <StudentRichTextEditor
                      value={draft.answerWysiwyg || ''}
                      onChange={({ html, plainText }) => {
                        updateDraft(question, (current) => ({
                          ...current,
                          answerWysiwyg: html,
                          answer: plainText,
                        }));
                      }}
                      placeholder={t('student.quiz.typeAnswer')}
                      disabled={locked}
                    />
                    <MathPreview html={draft.answerWysiwyg || ''} />
                  </>
                )}
              </Box>
            )}

            {qType === QUESTION_TYPES.NUMERICAL && (
              <Box>
                <TextField
                  value={draft.answer ?? ''}
                  onChange={(event) => {
                    updateDraft(question, (current) => ({
                      ...current,
                      answer: event.target.value,
                    }));
                  }}
                  disabled={locked}
                  type="number"
                  slotProps={{
                    htmlInput: {
                      'aria-label': t('student.quiz.enterNumber'),
                      // Blur before the browser's wheel action to prevent accidental
                      // answer changes while still allowing the page to scroll.
                      onWheel: (event) => event.currentTarget.blur(),
                    },
                  }}
                  fullWidth
                  placeholder={t('student.quiz.enterNumber')}
                  helperText={question.toleranceNumerical != null
                    ? t('student.quiz.toleranceHelper', {
                      value: formatToleranceValue(
                        question.toleranceNumerical,
                        i18n.resolvedLanguage || i18n.language,
                      ),
                    })
                    : undefined}
                />
              </Box>
            )}

            {practiceQuiz && !isSlide && (
              <Box sx={{ mt: 1.5, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                {!locked && (
                  <Button
                    size="small"
                    variant="contained"
                    onClick={() => handleSubmitPracticeQuestion(qId)}
                    disabled={!hasAnswerForDraft(question, draft) || lockingQuestionId === qId}
                  >
                    {lockingQuestionId === qId ? t('student.quiz.submittingQuestion') : t('student.quiz.submitQuestion')}
                  </Button>
                )}
                {!locked && (
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      alignSelf: 'center'
                    }}>
                    {t('student.quiz.solutionAfterSubmit')}
                  </Typography>
                )}

                {locked && questionHasRevealableSolution && (
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => setShowSolutionByQuestion((prev) => ({ ...prev, [qId]: !prev[qId] }))}
                  >
                    {showSolution ? t('student.quiz.hideSolution') : t('student.quiz.showSolution')}
                  </Button>
                )}
              </Box>
            )}

            {showCorrectForQuestion && qType === QUESTION_TYPES.NUMERICAL && question.correctNumerical != null && (
              <Paper variant="outlined" sx={{ p: 1.25, mt: 1.5, borderColor: 'success.main' }}>
                <Typography variant="body2">
                  {t('student.quiz.correctAnswer', { value: question.correctNumerical })}
                </Typography>
                {question.toleranceNumerical != null && (
                  <Typography variant="body2" sx={{
                    color: "text.secondary"
                  }}>
                    {t('student.quiz.tolerance', { value: question.toleranceNumerical })}
                  </Typography>
                )}
              </Paper>
            )}

            {showCorrectForQuestion && question.solution && (
              <Paper variant="outlined" sx={{ p: 1.25, mt: 1.5, borderColor: 'success.main' }}>
                <Typography variant="subtitle2" sx={{ mb: 0.5, color: 'success.main', fontWeight: 700 }}>
                  {t('common.solution')}
                </Typography>
                <RichContent html={question.solution} fallback={question.solution_plainText} />
              </Paper>
            )}
          </Paper>
        );
      })}

      <Divider sx={{ my: 2 }} />
      {showSubmitButton ? (
        <Button
          variant="contained"
          size="large"
          fullWidth
          onClick={practiceQuiz ? handleFinishPracticeQuiz : handleSubmitQuiz}
          disabled={practiceQuiz ? submittingQuiz : !canSubmitQuiz}
        >
          {submittingQuiz
            ? t('student.quiz.submitting')
            : practiceQuiz
              ? t('student.quiz.submitPracticeQuiz')
              : t('student.quiz.submitQuiz')}
        </Button>
      ) : (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            display: 'block',
            textAlign: 'center'
          }}>
          {t('student.quiz.answerAllToSubmit')}
        </Typography>
      )}
    </Box>
  );
}
