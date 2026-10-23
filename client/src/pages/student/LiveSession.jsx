import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { useParams, useNavigate, useLocation, Navigate } from 'react-router-dom';
import {
  Box, Typography, Button, Paper, Alert, CircularProgress, Chip,
  TextField, Radio, RadioGroup, FormControlLabel, Checkbox, FormGroup,
} from '@mui/material';
import apiClient from '../../api/client';
import StudentRichTextEditor, { MathPreview } from '../../components/questions/StudentRichTextEditor';
import BackLinkButton from '../../components/common/BackLinkButton';
import AnonymousSessionNotice from '../../components/common/AnonymousSessionNotice';
import SessionChatPanel from '../../components/live/SessionChatPanel';
import LiveSessionPanelNavigation from '../../components/live/LiveSessionPanelNavigation';
import WordCloudPanel from '../../components/questions/WordCloudPanel';
import HistogramPanel from '../../components/questions/HistogramPanel';
import {
  QUESTION_TYPES,
  TYPE_COLORS,
  getQuestionTypeLabel,
  isOptionBasedQuestionType,
  isSlideType,
  normalizeQuestionType,
} from '../../components/questions/constants';
import { useTranslation } from 'react-i18next';
import {
  normalizeStoredHtml,
  prepareRichTextInput,
  renderKatexInElement,
} from '../../components/questions/richTextUtils';
import {
  LiveSessionWebSocketProvider,
} from '../../contexts/LiveSessionWebSocketContext';
import useLiveSessionData from '../../hooks/useLiveSessionData';
import { formatToleranceValue } from '../../utils/numericalFormatting';
import { sortResponsesNewestFirst } from '../../utils/responses';
import { useAuth } from '../../contexts/AuthContext';
import { getDashboardPath } from '../../utils/dashboard';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const COMPACT_CHIP_SX = {
  borderRadius: 1.4,
  '& .MuiChip-label': { px: 1.15 },
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

function getOptionRichContentProps(option) {
  return {
    html: normalizeStoredHtml(option?.content || ''),
    fallback: option?.plainText || option?.answer || '',
  };
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

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function LiveSessionContent() {
  const { courseId, sessionId } = useParams();
  const navigate = useNavigate();
  const isOutsideActivity = useLocation().pathname.startsWith('/activity/');
  const { user } = useAuth();
  const dashboardPath = getDashboardPath(user);
  const { t, i18n } = useTranslation();
  const courseBackLink = isOutsideActivity ? dashboardPath : `/student/course/${courseId}`;

  // Join state
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState(null);
  const [autoJoinAttempted, setAutoJoinAttempted] = useState(false);

  // Answer state
  const [answer, setAnswer] = useState(null); // string for MC/TF/SA/NUM, array for MS
  const [answerWysiwyg, setAnswerWysiwyg] = useState(''); // rich text HTML for SA
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [activePanel, setActivePanel] = useState('question');
  const [chatRefreshToken, setChatRefreshToken] = useState(0);
  const [chatEvent, setChatEvent] = useState(null);
  const [chatUnseenCount, setChatUnseenCount] = useState(0);
  const pendingChatRefreshRef = useRef(false);

  // Track current question/attempt to detect changes
  const prevQuestionRef = useRef(null);
  const prevAttemptRef = useRef(null);

  // --------------------------------------------------
  // Data fetching
  // --------------------------------------------------

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

  const { liveData, setLiveData, loading, error, fetchLive, transport } = useLiveSessionData({
    sessionId, role: 'student', onChatEvent: queueChatRefresh,
  });

  useEffect(() => {
    if (activePanel === 'chat') setChatUnseenCount(0);
  }, [activePanel]);

  const handlePanelChange = useCallback((nextPanel) => {
    if (nextPanel === 'chat') setChatUnseenCount(0);
    setActivePanel(nextPanel);
  }, []);

  // --------------------------------------------------
  // Reset answer when question or attempt changes
  // --------------------------------------------------

  useEffect(() => {
    if (!liveData) return;
    const qId = liveData.currentQuestion?._id || null;
    const attemptNum = liveData.currentAttempt?.number ?? null;

    const questionChanged = qId !== prevQuestionRef.current;
    const attemptChanged = attemptNum !== prevAttemptRef.current;

    if (questionChanged || attemptChanged) {
      // Reset local answer state
      const qType = liveData.currentQuestion
        ? normalizeQuestionType(liveData.currentQuestion)
        : null;
      if (qType === QUESTION_TYPES.MULTI_SELECT) {
        setAnswer([]);
      } else {
        setAnswer('');
      }
      setAnswerWysiwyg('');
      setSubmitError(null);
    }

    prevQuestionRef.current = qId;
    prevAttemptRef.current = attemptNum;
  }, [liveData]);

  // --------------------------------------------------
  // Auto-join (when no join code required)
  // --------------------------------------------------

  useEffect(() => {
    if (!liveData || liveData.session?.status !== 'running' || liveData.isJoined || autoJoinAttempted) return;
    if (liveData.session?.joinCodeActive || liveData.session?.joinCodeEnabled) return; // passcode protection enabled

    setAutoJoinAttempted(true);
    setJoining(true);
    apiClient.post(`/sessions/${sessionId}/join`, {})
      .then(() => fetchLive())
      .catch((err) => {
        setJoinError(err.response?.data?.message || t('student.liveSession.failedJoinSession'));
      })
      .finally(() => setJoining(false));
  }, [liveData, sessionId, fetchLive, autoJoinAttempted]);

  // --------------------------------------------------
  // Join with code
  // --------------------------------------------------

  const handleJoinWithCode = useCallback(async () => {
    if (!joinCode.trim()) return;
    setJoining(true);
    setJoinError(null);
    try {
      await apiClient.post(`/sessions/${sessionId}/join`, { joinCode: joinCode.trim() });
      await fetchLive();
    } catch (err) {
      setJoinError(err.response?.data?.message || t('student.liveSession.invalidJoinCode'));
    } finally {
      setJoining(false);
    }
  }, [joinCode, sessionId, fetchLive]);

  // --------------------------------------------------
  // Submit response
  // --------------------------------------------------

  const handleSubmit = useCallback(async () => {
    if (answer === null || answer === '' || (Array.isArray(answer) && answer.length === 0)) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload = { answer };
      if (answerWysiwyg) payload.answerWysiwyg = answerWysiwyg;
      const { data } = await apiClient.post(`/sessions/${sessionId}/respond`, payload);
      // Update local state with the submitted response — avoids a full re-fetch of /live
      setLiveData((prev) => prev ? { ...prev, studentResponse: data.response || prev.studentResponse } : prev);
    } catch (err) {
      setSubmitError(err.response?.data?.message || t('student.liveSession.failedSubmitResponse'));
    } finally {
      setSubmitting(false);
    }
  }, [answer, answerWysiwyg, sessionId]);

  // --------------------------------------------------
  // Derived values
  // --------------------------------------------------

  const session = liveData?.session;
  const currentQ = liveData?.currentQuestion;
  const currentAttempt = liveData?.currentAttempt;
  const studentResponse = liveData?.studentResponse;
  const isJoined = liveData?.isJoined;
  const showStats = liveData?.showStats;
  const chatEnabled = !!session?.chatEnabled;
  const richTextChatEnabled = session?.richTextChatEnabled !== false;
  const showResponseList = liveData?.showResponseList !== false;
  const showCorrect = liveData?.showCorrect;
  const questionHidden = liveData?.questionHidden;
  const responseStats = liveData?.responseStats;
  const wordCloudData = liveData?.wordCloudData || null;
  const histogramData = liveData?.histogramData || null;
  const sortedShortAnswerResponses = useMemo(
    () => sortResponsesNewestFirst(responseStats?.answers || []),
    [responseStats?.answers]
  );
  const showShortAnswerStats = showStats
    && responseStats?.type === 'shortAnswer'
    && (!!showResponseList || !!wordCloudData?.wordFrequencies?.length);
  const questionNumber = liveData?.questionNumber;
  const questionCount = liveData?.questionCount ?? 0;
  const pageProgress = liveData?.pageProgress || (
    questionCount > 0 && questionNumber != null
      ? { current: questionNumber, total: questionCount }
      : null
  );
  const questionProgress = liveData?.questionProgress || null;
  const hasSlidesInSession = !!(pageProgress && questionProgress && pageProgress.total !== questionProgress.total);
  const liveSolutionHtml = currentQ?.solution || currentQ?.solutionHtml || '';
  const liveSolutionPlainText = currentQ?.solution_plainText || currentQ?.solutionPlainText || currentQ?.solutionText || '';

  useEffect(() => {
    if (!chatEnabled && activePanel === 'chat') {
      setActivePanel('question');
    }
  }, [activePanel, chatEnabled]);

  useEffect(() => {
    if (!chatEnabled) {
      pendingChatRefreshRef.current = false;
      return;
    }
    if (activePanel !== 'chat' || !pendingChatRefreshRef.current) return;

    pendingChatRefreshRef.current = false;
    setChatRefreshToken((prev) => prev + 1);
  }, [activePanel, chatEnabled]);

  const qType = currentQ ? normalizeQuestionType(currentQ) : null;
  const isSlide = isSlideType(qType);
  const hasSubmitted = !!studentResponse;
  const responseClosed = !!currentAttempt?.closed;
  const isLocked = hasSubmitted || responseClosed;
  const isOptionBasedQuestion = isOptionBasedQuestionType(qType) || qType === QUESTION_TYPES.TRUE_FALSE;
  const showInlineOptionStats = isOptionBasedQuestion
    && showStats
    && responseStats?.type === 'distribution';
  const inlineDistribution = showInlineOptionStats ? (responseStats.distribution || []) : [];
  const inlineDistributionTotal = Number(responseStats?.total) > 0
    ? Number(responseStats.total)
    : inlineDistribution.reduce((sum, d) => sum + (d.count || 0), 0);
  const liveStatusMessage = [
    hasSlidesInSession && pageProgress ? t('student.liveSession.pageProgress', pageProgress) : null,
    !isSlide && questionProgress ? t('student.liveSession.questionProgress', questionProgress) : null,
    currentAttempt ? t('student.liveSession.attemptNumber', { number: currentAttempt.number ?? 1 }) : null,
    isSlide
      ? null
      : hasSubmitted
      ? t('student.liveSession.responseSubmitted')
      : responseClosed
        ? t('student.liveSession.responsesCurrentlyClosed')
        : t('student.liveSession.responsesCurrentlyOpen'),
    showStats ? t('student.liveSession.statsVisible') : null,
    showCorrect ? t('student.liveSession.correctVisible') : null,
  ].filter(Boolean).join(' ');
  const panelTabs = [
    { value: 'question', label: t('student.liveSession.currentQuestion') },
    ...(chatEnabled ? [{
      value: 'chat',
      label: <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>{t('sessionChat.chat')}{chatUnseenCount > 0 ? <Chip size="small" color="error" label={chatUnseenCount} sx={{ height: 20 }} /> : null}</Box>,
      menuLabel: t('sessionChat.chat'),
    }] : []),
  ];

  // --------------------------------------------------
  // Render: loading state
  // --------------------------------------------------

  if (loading) {
    return (
      <Box sx={{ p: 4, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress aria-label={t('student.liveSession.loadingLiveSession')} />
      </Box>
    );
  }

  // --------------------------------------------------
  // Render: error state
  // --------------------------------------------------

  if (error || !session) {
    return (
        <Box sx={{ p: 3, maxWidth: 600, mx: 'auto' }}>
          <Alert severity="error" sx={{ mb: 2 }}>{error || t('student.liveSession.sessionNotFound')}</Alert>
          <BackLinkButton variant="outlined" label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.liveSession.backToCourse')} onClick={() => navigate(courseBackLink)} />
        </Box>
      );
  }

  // --------------------------------------------------
  // Render: inactive session. Keep the socket mounted for Upcoming/Ended so
  // returning to Live restores the question through the existing status refresh.
  // --------------------------------------------------

  if (session.status === 'hidden') {
    return <Navigate to={courseBackLink} replace />;
  }

  if (session.status === 'done' || session.status === 'visible') {
    return (
        <Box sx={{ p: 4, maxWidth: 600, mx: 'auto', textAlign: 'center' }}>
          <Alert severity="info" sx={{ mb: 3, justifyContent: 'center' }}>
            {t(session.status === 'done' ? 'student.liveSession.sessionEnded' : 'student.liveSession.sessionNotStarted')}
          </Alert>
          <BackLinkButton variant="outlined" label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.liveSession.backToCourse')} onClick={() => navigate(courseBackLink)} />
        </Box>
      );
  }

  // --------------------------------------------------
  // Render: join phase (with code)
  // --------------------------------------------------

  if (!isJoined && (session.joinCodeActive || session.joinCodeEnabled)) {
    // If join code is active, show the code entry form
    if (session.joinCodeActive) {
        return (
          <Box sx={{ p: 3, maxWidth: 400, mx: 'auto', textAlign: 'center' }}>
            <BackLinkButton
              variant="outlined"
              label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.liveSession.backToCourse')}
              onClick={() => navigate(courseBackLink)}
              sx={{ mb: 2 }}
            />
            <Paper variant="outlined" sx={{ p: 4 }}>
              <Typography variant="h5" sx={{ fontWeight: 700, mb: 1 }}>
                {t('student.liveSession.joinSession')}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                mb: 3
              }}>
              {t('student.liveSession.enterPasscode')}
            </Typography>

            {session.anonymous ? <AnonymousSessionNotice sx={{ textAlign: 'left' }} /> : null}

            {joinError && (
              <Alert severity="error" sx={{ mb: 2 }}>{joinError}</Alert>
            )}

            <TextField
              value={joinCode}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                setJoinCode(val);
              }}
              placeholder="000000"
              fullWidth
              autoFocus
              sx={{ mb: 3 }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && joinCode.length === 6) handleJoinWithCode();
              }}
              slotProps={{
                htmlInput: {
                  inputMode: 'numeric',
                  pattern: '[0-9]*',
                  maxLength: 6,
                  'aria-label': t('student.liveSession.joinCodeAriaLabel'),
                  style: {
                    textAlign: 'center',
                    fontSize: '2rem',
                    fontWeight: 700,
                    letterSpacing: '0.35em',
                  },
                }
              }}
            />

            <Button
              variant="contained"
              size="large"
              fullWidth
              onClick={handleJoinWithCode}
              disabled={joinCode.length < 6 || joining}
              sx={{ py: 1.5, fontSize: '1.1rem' }}
              aria-label={t('student.liveSession.joinSessionAction')}
            >
              {joining ? <CircularProgress size={24} color="inherit" /> : t('student.liveSession.joinSessionAction')}
            </Button>
          </Paper>
          </Box>
        );
    }

    // joinCodeEnabled but not active — wait for instructor to activate
    return (
      <Box sx={{ p: 4, maxWidth: 600, mx: 'auto', textAlign: 'center' }}>
        <BackLinkButton
          variant="outlined"
          label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.liveSession.backToCourse')}
          onClick={() => navigate(courseBackLink)}
          sx={{ mb: 2 }}
        />
        <Paper variant="outlined" sx={{ p: 4 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
            {session.name || t('student.liveSession.liveSessionFallback')}
          </Typography>
          <Typography
            variant="body1"
            sx={{
              color: "text.secondary",
              mt: 2
            }}>
            {t('student.liveSession.waitingForPasscode')}
          </Typography>
        </Paper>
      </Box>
    );
  }

  // --------------------------------------------------
  // Render: joining in progress (auto-join without code)
  // --------------------------------------------------

  if (!isJoined) {
    return (
      <Box sx={{ p: 4, maxWidth: 600, mx: 'auto', textAlign: 'center' }}>
        {joinError ? (
          <>
            <Alert severity="error" sx={{ mb: 2 }}>{joinError}</Alert>
            <BackLinkButton variant="outlined" label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.liveSession.backToCourse')} onClick={() => navigate(courseBackLink)} />
          </>
        ) : (
          <>
            <CircularProgress sx={{ mb: 2 }} aria-label={t('student.liveSession.joiningSession')} />
            <Typography variant="body1" sx={{
              color: "text.secondary"
            }}>
              {t('student.liveSession.joiningSessionEllipsis')}
            </Typography>
          </>
        )}
      </Box>
    );
  }

  // --------------------------------------------------
  // Render: waiting phase (join period active or question hidden)
  // --------------------------------------------------

  if (session.joinCodeActive || questionHidden || !currentQ) {
    if (!chatEnabled) {
      return (
        <Box sx={{ p: 4, maxWidth: 600, mx: 'auto', textAlign: 'center' }}>
          <BackLinkButton
            variant="outlined"
            label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.liveSession.backToCourse')}
            onClick={() => navigate(courseBackLink)}
            sx={{ mb: 2 }}
          />
          <Paper variant="outlined" sx={{ p: 4 }}>
            <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
              {session.name || t('student.liveSession.liveSessionFallback')}
            </Typography>

            <Box
              sx={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                my: 4,
              }}
            >
              <Box
                sx={{
                  width: 16,
                  height: 16,
                  borderRadius: '50%',
                  bgcolor: 'primary.main',
                  animation: 'pulse 1.5s ease-in-out infinite',
                  '@keyframes pulse': {
                    '0%, 100%': { opacity: 0.4, transform: 'scale(1)' },
                    '50%': { opacity: 1, transform: 'scale(1.3)' },
                  },
                }}
              />
            </Box>

            <Typography variant="body1" sx={{
              color: "text.secondary"
            }}>
              {t('student.liveSession.waitingForQuestion')}
            </Typography>
          </Paper>
        </Box>
      );
    }

    return (
      <Box sx={{ p: { xs: 1.5, sm: 2.5 }, maxWidth: 600, mx: 'auto' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
          <BackLinkButton
            variant="outlined"
            label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.liveSession.backToCourse')}
            onClick={() => navigate(courseBackLink)}
            sx={{ flexShrink: 0 }}
          />
          <Typography variant="h6" sx={{ fontWeight: 700, flexGrow: 1, minWidth: 0 }} noWrap>
            {session.name || t('student.liveSession.liveSessionFallback')}
          </Typography>
        </Box>
        <LiveSessionPanelNavigation
          value={activePanel}
          onChange={handlePanelChange}
          tabs={panelTabs}
          compactAdornment={chatEnabled && chatUnseenCount > 0 ? <Chip size="small" color="error" label={chatUnseenCount} /> : null}
          ariaLabel={t('student.liveSession.panelsLabel')}
        />
        {activePanel === 'chat' ? (
          <SessionChatPanel
            sessionId={sessionId}
            enabled={chatEnabled}
            role="student"
            syncTransport={transport}
            refreshToken={chatRefreshToken}
            chatEvent={chatEvent}
          />
        ) : (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
              {session.name || t('student.liveSession.liveSessionFallback')}
            </Typography>
            <Typography variant="body1" sx={{
              color: "text.secondary"
            }}>
              {t('student.liveSession.waitingForQuestion')}
            </Typography>
          </Paper>
        )}
      </Box>
    );
  }

  // --------------------------------------------------
  // Render: question phase (main view)
  // --------------------------------------------------

  // Resolve the student's previously submitted answer for display
  const submittedAnswer = studentResponse?.answer;

  // For MC/TF: selected option ID (string)
  // For MS: array of selected option IDs
  // For SA: text string
  // For Numerical: number string
  const displayAnswer = hasSubmitted ? submittedAnswer : answer;
  const displayAnswerString = displayAnswer == null ? '' : String(displayAnswer);
  const displayAnswerArray = Array.isArray(displayAnswer) ? displayAnswer.map((value) => String(value)) : [];

  return (
    <Box sx={{ p: { xs: 1.5, sm: 2.5 }, maxWidth: 600, mx: 'auto' }}>
      <Box role="status" aria-live="polite" aria-atomic="true" sx={SR_ONLY_SX}>
        {liveStatusMessage}
      </Box>

      {/* ============================================================ */}
      {/* Session header                                               */}
      {/* ============================================================ */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2, flexWrap: 'wrap' }}>
        <BackLinkButton
          variant="outlined"
          label={t(isOutsideActivity ? 'common.backToDashboard' : 'student.liveSession.backToCourse')}
          onClick={() => navigate(courseBackLink)}
          sx={{ flexShrink: 0 }}
        />
        <Typography variant="h6" sx={{ fontWeight: 700, flexGrow: 1, minWidth: 0 }} noWrap>
          {session.name || t('student.liveSession.liveSessionFallback')}
        </Typography>
        <Box role="status" aria-live="polite" aria-atomic="true" sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          {hasSlidesInSession && pageProgress && (
            <Chip
              label={t('student.liveSession.pageProgress', pageProgress)}
              size="small"
              variant="outlined"
              sx={COMPACT_CHIP_SX}
              aria-label={t('student.liveSession.pageProgress', pageProgress)}
            />
          )}
          {!isSlide && questionProgress && (
            <Chip
              label={t('student.liveSession.questionProgress', questionProgress)}
              size="small"
              variant="outlined"
              sx={COMPACT_CHIP_SX}
              aria-label={t('student.liveSession.questionProgress', questionProgress)}
            />
          )}
          {currentAttempt && (
            <Chip
              label={t('student.liveSession.attemptLabel', { number: currentAttempt.number ?? 1 })}
              size="small"
              variant="outlined"
              sx={COMPACT_CHIP_SX}
            />
          )}
        </Box>
      </Box>

      {session.anonymous ? <AnonymousSessionNotice /> : null}

      {chatEnabled ? (
        <LiveSessionPanelNavigation
          value={activePanel}
          onChange={handlePanelChange}
          tabs={panelTabs}
          compactAdornment={chatEnabled && chatUnseenCount > 0 ? <Chip size="small" color="error" label={chatUnseenCount} /> : null}
          ariaLabel={t('student.liveSession.panelsLabel')}
        />
      ) : null}

      {activePanel === 'chat' ? (
        <SessionChatPanel
          sessionId={sessionId}
          enabled={chatEnabled}
          role="student"
          richTextChatEnabled={richTextChatEnabled}
          syncTransport={transport}
          refreshToken={chatRefreshToken}
          chatEvent={chatEvent}
        />
      ) : (
        <>
      {/* ============================================================ */}
      {/* Question content                                             */}
      {/* ============================================================ */}
      <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }} aria-label={t('student.liveSession.currentQuestion')}>
        {/* Question header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
          <Chip
            label={getQuestionTypeLabel(t, qType, {
              key: 'grades.coursePanel.question',
              defaultValue: 'Question',
            })}
            color={TYPE_COLORS[qType] || 'default'}
            size="small"
            sx={COMPACT_CHIP_SX}
          />
          {!isSlide && responseClosed && (
            <Chip label={t('student.liveSession.responsesClosed')} size="small" color="warning" sx={COMPACT_CHIP_SX} />
          )}
        </Box>

        {/* Question body */}
        <Box sx={{ mb: 2 }}>
          <RichContent html={currentQ.content} fallback={currentQ.plainText} allowVideoEmbeds />
        </Box>

        {/* ============================================================ */}
        {/* Answer options                                               */}
        {/* ============================================================ */}

        {/* MC / TF: Radio buttons */}
        {(qType === QUESTION_TYPES.MULTIPLE_CHOICE || qType === QUESTION_TYPES.TRUE_FALSE) && (
          <RadioGroup
            value={displayAnswerString}
            onChange={(e) => {
              if (!isLocked) setAnswer(e.target.value);
            }}
          >
            {(currentQ.options || []).map((opt, i) => {
              const optId = String(opt._id ?? i);
              const isCorrectOpt = showCorrect && !!opt.correct;
              const isSelected = displayAnswerString === optId;
              const count = inlineDistribution?.[i]?.count || 0;
              const pct = inlineDistributionTotal > 0 ? Math.round(100 * count / inlineDistributionTotal) : 0;
              const optionContent = getOptionRichContentProps(opt);
              const barColor = showCorrect
                ? (isCorrectOpt ? 'rgba(46, 125, 50, 0.22)' : 'rgba(211, 47, 47, 0.14)')
                : 'rgba(25, 118, 210, 0.18)';
              return (
                <Paper
                  key={optId}
                  variant="outlined"
                  sx={{
                    position: 'relative',
                    overflow: 'hidden',
                    p: 1.5,
                    mb: 0.75,
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 1,
                    borderColor: isCorrectOpt ? 'success.main' : isSelected ? 'primary.main' : 'divider',
                    bgcolor: isCorrectOpt ? 'success.50' : isSelected && isLocked ? 'action.selected' : 'transparent',
                    opacity: isLocked ? 0.85 : 1,
                    cursor: isLocked ? 'default' : 'pointer',
                  }}
                  onClick={() => {
                    if (!isLocked) setAnswer(optId);
                  }}
                >
                  <Box
                    aria-hidden
                    sx={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${showInlineOptionStats ? pct : 0}%`,
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
                      gridTemplateColumns: showInlineOptionStats
                        ? '34px 30px minmax(0, 1fr) 58px'
                        : '34px 30px minmax(0, 1fr)',
                      columnGap: 1,
                      alignItems: 'start',
                      width: '100%',
                    }}
                  >
                  <FormControlLabel
                    value={optId}
                    control={<Radio disabled={isLocked} sx={{ p: 0.5 }} onClick={(e) => e.stopPropagation()} />}
                    label=""
                    sx={{ m: 0, mr: 0, width: 34, alignSelf: 'start' }}
                    aria-label={t('common.option', { letter: OPTION_LETTERS[i] })}
                  />
                   <Chip
                     label={OPTION_LETTERS[i]}
                     size="small"
                     color={isCorrectOpt ? 'success' : 'default'}
                     sx={{ ...COMPACT_CHIP_SX, fontWeight: 700, minWidth: 28, mt: 0.25, justifySelf: 'start' }}
                   />
                   <Box sx={{ minWidth: 0, pt: 0.25 }}>
                    <RichContent html={optionContent.html} fallback={optionContent.fallback} />
                   </Box>
                   {showInlineOptionStats && (
                     <Typography variant="body2" sx={{ fontWeight: 700, minWidth: 58, textAlign: 'right' }}>
                      {pct}%
                    </Typography>
                  )}
                  </Box>
                </Paper>
              );
            })}
          </RadioGroup>
        )}

        {/* MS: Checkboxes */}
        {qType === QUESTION_TYPES.MULTI_SELECT && (
          <FormGroup>
            {(currentQ.options || []).map((opt, i) => {
              const optId = String(opt._id ?? i);
              const isCorrectOpt = showCorrect && !!opt.correct;
              const checked = displayAnswerArray.includes(optId);
              const count = inlineDistribution?.[i]?.count || 0;
              const pct = inlineDistributionTotal > 0 ? Math.round(100 * count / inlineDistributionTotal) : 0;
              const optionContent = getOptionRichContentProps(opt);
              const barColor = showCorrect
                ? (isCorrectOpt ? 'rgba(46, 125, 50, 0.22)' : 'rgba(211, 47, 47, 0.14)')
                : 'rgba(25, 118, 210, 0.18)';
              return (
                <Paper
                  key={optId}
                  variant="outlined"
                  sx={{
                    position: 'relative',
                    overflow: 'hidden',
                    p: 1.5,
                    mb: 0.75,
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 1,
                    borderColor: isCorrectOpt ? 'success.main' : checked ? 'primary.main' : 'divider',
                    bgcolor: isCorrectOpt ? 'success.50' : checked && isLocked ? 'action.selected' : 'transparent',
                    opacity: isLocked ? 0.85 : 1,
                    cursor: isLocked ? 'default' : 'pointer',
                  }}
                  onClick={() => {
                    if (isLocked) return;
                    setAnswer((prev) => {
                      const arr = Array.isArray(prev) ? prev.map((value) => String(value)) : [];
                      return arr.includes(optId)
                        ? arr.filter((id) => id !== optId)
                        : [...arr, optId];
                    });
                  }}
                >
                  <Box
                    aria-hidden
                    sx={{
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${showInlineOptionStats ? pct : 0}%`,
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
                      gridTemplateColumns: showInlineOptionStats
                        ? '34px 30px minmax(0, 1fr) 58px'
                        : '34px 30px minmax(0, 1fr)',
                      columnGap: 1,
                      alignItems: 'start',
                      width: '100%',
                    }}
                  >
                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={checked}
                        disabled={isLocked}
                        sx={{ p: 0.5 }}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => {
                          if (isLocked) return;
                          setAnswer((prev) => {
                            const arr = Array.isArray(prev) ? prev.map((value) => String(value)) : [];
                            return arr.includes(optId)
                              ? arr.filter((id) => id !== optId)
                              : [...arr, optId];
                          });
                        }}
                      />
                    }
                    label=""
                    sx={{ m: 0, mr: 0, width: 34, alignSelf: 'start' }}
                    aria-label={t('common.option', { letter: OPTION_LETTERS[i] })}
                  />
                   <Chip
                     label={OPTION_LETTERS[i]}
                     size="small"
                     color={isCorrectOpt ? 'success' : 'default'}
                     sx={{ ...COMPACT_CHIP_SX, fontWeight: 700, minWidth: 28, mt: 0.25, justifySelf: 'start' }}
                   />
                   <Box sx={{ minWidth: 0, pt: 0.25 }}>
                    <RichContent html={optionContent.html} fallback={optionContent.fallback} />
                   </Box>
                   {showInlineOptionStats && (
                     <Typography variant="body2" sx={{ fontWeight: 700, minWidth: 58, textAlign: 'right' }}>
                      {pct}%
                    </Typography>
                  )}
                  </Box>
                </Paper>
              );
            })}
          </FormGroup>
        )}

        {/* SA: TipTap rich text editor with math support */}
        {qType === QUESTION_TYPES.SHORT_ANSWER && (
          <Box>
            {isLocked ? (
              <Paper variant="outlined" sx={{ p: 1.5, opacity: 0.85 }}>
                {studentResponse?.answerWysiwyg ? (
                  <RichContent html={studentResponse.answerWysiwyg} />
                ) : (
                  <Typography variant="body2">{displayAnswer || t('common.noAnswer')}</Typography>
                )}
              </Paper>
            ) : (
              <>
                <StudentRichTextEditor
                  value={answerWysiwyg || ''}
                  onChange={({ html, plainText }) => {
                    setAnswerWysiwyg(html);
                    setAnswer(plainText);
                  }}
                  placeholder={t('student.liveSession.typeAnswer')}
                  disabled={isLocked}
                />
              </>
            )}
          </Box>
        )}

        {/* Numerical: Number input */}
        {qType === QUESTION_TYPES.NUMERICAL && (
          <Box>
            <TextField
              value={displayAnswer ?? ''}
              onChange={(e) => {
                if (!isLocked) setAnswer(e.target.value);
              }}
              placeholder={t('student.liveSession.enterNumber')}
              type="number"
              fullWidth
              disabled={isLocked}
              helperText={currentQ.toleranceNumerical != null
                ? t('student.liveSession.toleranceHelper', {
                  value: formatToleranceValue(
                    currentQ.toleranceNumerical,
                    i18n.resolvedLanguage || i18n.language,
                  ),
                })
                : undefined}
              slotProps={{
                htmlInput: { 'aria-label': t('student.liveSession.numericalResponseAriaLabel') }
              }}
            />
          </Box>
        )}
      </Paper>

      {/* ============================================================ */}
      {/* Submit / status area                                         */}
      {/* ============================================================ */}
      {!isSlide && (
        <Box sx={{ mb: 2 }}>
          {submitError && (
            <Alert severity="error" sx={{ mb: 1.5 }}>{submitError}</Alert>
          )}
          <Box role="status" aria-live="polite" aria-atomic="true">
            {hasSubmitted ? (
              <Alert severity="success" icon={false} sx={{ justifyContent: 'center' }}>
                {t('student.liveSession.responseSubmittedCheck')}
              </Alert>
            ) : responseClosed ? (
              <Alert severity="warning" sx={{ justifyContent: 'center' }}>
                {t('student.liveSession.responsesCurrentlyClosedShort')}
              </Alert>
            ) : (
              <Button
                variant="contained"
                size="large"
                fullWidth
                onClick={handleSubmit}
                disabled={
                  submitting
                  || answer === null
                  || answer === ''
                  || (Array.isArray(answer) && answer.length === 0)
                }
                sx={{ py: 1.5, fontSize: '1.05rem' }}
                aria-label={t('student.liveSession.submitResponse')}
              >
                {submitting ? <CircularProgress size={24} color="inherit" /> : t('student.liveSession.submitResponse')}
              </Button>
            )}
          </Box>
        </Box>
      )}

      {qType === QUESTION_TYPES.SHORT_ANSWER && !isLocked && !isSlide && (
        <Box sx={{ mb: 2 }}>
          <MathPreview html={answerWysiwyg} />
        </Box>
      )}

      {/* ============================================================ */}
      {/* Stats phase                                                  */}
      {/* ============================================================ */}
      {showStats && responseStats?.type === 'numerical' && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }} aria-label={t('student.liveSession.numericalStatistics')}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1.5 }}>
            {t('student.liveSession.responseStatistics')}
          </Typography>
          <HistogramPanel histogramData={histogramData} />
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
            {[
              { label: t('common.count'), value: responseStats.total ?? responseStats.count ?? 0 },
              { label: t('professor.secondDesktop.mean'), value: responseStats.mean != null ? Number(responseStats.mean).toFixed(2) : '—' },
              { label: t('professor.secondDesktop.stdev'), value: responseStats.stdev != null ? Number(responseStats.stdev).toFixed(2) : '—' },
              { label: t('professor.secondDesktop.median'), value: responseStats.median != null ? Number(responseStats.median).toFixed(2) : '—' },
            ].map((e) => (
              <Paper key={e.label} variant="outlined" sx={{ p: 1.5, minWidth: 80, textAlign: 'center' }}>
                <Typography variant="caption" sx={{
                  color: "text.secondary"
                }}>{e.label}</Typography>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>{e.value}</Typography>
              </Paper>
            ))}
          </Box>
          {Array.isArray(responseStats.answers) && responseStats.answers.length > 0 && (
            <Box sx={{ maxHeight: 300, overflow: 'auto', mt: 1.5 }}>
              {responseStats.answers.map((r, i) => (
                <Paper key={i} variant="outlined" sx={{ p: 1, mb: 0.5 }}>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      display: 'block',
                      mb: 0.5
                    }}>
                    {t('common.unknown')}
                  </Typography>
                  <Typography variant="body2">{r.answer ?? t('common.noAnswer')}</Typography>
                </Paper>
              ))}
            </Box>
          )}
        </Paper>
      )}

      {showShortAnswerStats && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }} aria-label={t('student.liveSession.shortAnswerResponses')}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1.5 }}>
            {t('student.liveSession.responses')}
          </Typography>
          <WordCloudPanel wordCloudData={wordCloudData} />
          {showResponseList ? (
            <Box sx={{ maxHeight: 300, overflow: 'auto' }}>
              {sortedShortAnswerResponses.map((r, i) => (
                <Paper key={i} variant="outlined" sx={{ p: 1, mb: 0.5 }}>
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      display: 'block',
                      mb: 0.5
                    }}>
                    {t('common.unknown')}
                  </Typography>
                  {r.answerWysiwyg ? (
                    <RichContent html={r.answerWysiwyg} />
                  ) : (
                    <Typography variant="body2">{r.answer ?? t('common.noAnswer')}</Typography>
                  )}
                </Paper>
              ))}
            </Box>
          ) : null}
        </Paper>
      )}

      {/* ============================================================ */}
      {/* Correct answer phase                                         */}
      {/* ============================================================ */}
      {showCorrect && qType === QUESTION_TYPES.NUMERICAL && currentQ.correctNumerical != null && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2, borderColor: 'success.main' }}>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t('student.quiz.correctAnswer', { value: currentQ.correctNumerical })}
          </Typography>
          {currentQ.toleranceNumerical != null && (
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>
              {t('student.liveSession.tolerance', { value: currentQ.toleranceNumerical })}
            </Typography>
          )}
        </Paper>
      )}

      {showCorrect && (liveSolutionHtml || liveSolutionPlainText) && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2, borderColor: 'success.main' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 0.5, color: 'success.main' }}>
            {t('common.solution')}
          </Typography>
          <RichContent html={liveSolutionHtml} fallback={liveSolutionPlainText} />
        </Paper>
      )}
        </>
      )}
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
