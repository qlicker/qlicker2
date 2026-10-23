import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Box, Typography, Paper, Alert, CircularProgress, Chip, Button,
} from '@mui/material';
import { LiveSessionWebSocketProvider } from '../../contexts/LiveSessionWebSocketContext';
import {
  QUESTION_TYPES,
  TYPE_COLORS,
  getQuestionTypeLabel,
  isOptionBasedQuestionType,
  isSlideType,
  normalizeQuestionType,
} from '../../components/questions/constants';
import {
  normalizeStoredHtml,
  prepareRichTextInput,
  renderKatexInElement,
} from '../../components/questions/richTextUtils';
import { buildCourseTitle } from '../../utils/courseTitle';
import WordCloudPanel from '../../components/questions/WordCloudPanel';
import HistogramPanel from '../../components/questions/HistogramPanel';
import useLiveSessionData from '../../hooks/useLiveSessionData';
import SessionChatPanel from '../../components/live/SessionChatPanel';
import LiveSessionPanelNavigation from '../../components/live/LiveSessionPanelNavigation';
import { sortResponsesNewestFirst } from '../../utils/responses';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const COMPACT_CHIP_SX = {
  borderRadius: 1.4,
  '& .MuiChip-label': { px: 1.15 },
};

const OPTION_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

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

function getOptionRichContentProps(option) {
  return {
    html: normalizeStoredHtml(option?.content || ''),
    fallback: option?.plainText || option?.answer || '',
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Renders rich-text content with KaTeX math support (large display). */
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
      sx={{ ...richContentSx, fontSize: '1.35rem', lineHeight: 1.6 }}
      dangerouslySetInnerHTML={innerHtml}
    />
  );
}

/** Numerical statistics display (large format) with histogram. */
function NumericalStats({ stats }) {
  const { t } = useTranslation();
  if (!stats) {
    return (
      <Typography
        variant="body1"
        sx={{
          color: "text.secondary",
          textAlign: 'center'
        }}>
        {t('professor.secondDesktop.noResponsesYet')}
      </Typography>
    );
  }

  const entries = [
    { label: t('professor.secondDesktop.mean'), value: stats.mean != null ? Number(stats.mean).toFixed(2) : '—' },
    { label: t('professor.secondDesktop.stdev'), value: stats.stdev != null ? Number(stats.stdev).toFixed(2) : '—' },
    { label: t('professor.secondDesktop.median'), value: stats.median != null ? Number(stats.median).toFixed(2) : '—' },
    { label: t('professor.secondDesktop.min'), value: stats.min != null ? Number(stats.min).toFixed(2) : '—' },
    { label: t('professor.secondDesktop.max'), value: stats.max != null ? Number(stats.max).toFixed(2) : '—' },
  ];
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'center' }}>
      {entries.map((e) => (
        <Paper key={e.label} variant="outlined" sx={{ p: 2, minWidth: 110, textAlign: 'center' }}>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>{e.label}</Typography>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>{e.value}</Typography>
        </Paper>
      ))}
    </Box>
  );
}

/** Short-answer responses list (large format, rendered rich text). */
function ShortAnswerList({ responses }) {
  const { t } = useTranslation();
  const sortedResponses = sortResponsesNewestFirst(responses);
  if (!sortedResponses.length) {
    return (
      <Typography
        variant="body1"
        sx={{
          color: "text.secondary",
          textAlign: 'center'
        }}>
        {t('professor.secondDesktop.noResponsesYet')}
      </Typography>
    );
  }
  return (
    <Box sx={{ maxHeight: 400, overflow: 'auto' }}>
      {sortedResponses.map((r, i) => (
        <Paper key={i} variant="outlined" sx={{ p: 1.5, mb: 0.75 }}>
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
            <Typography variant="body1">{r.answer ?? r.value ?? r.text ?? t('common.noAnswer')}</Typography>
          )}
        </Paper>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function PresentationContent() {
  const { t } = useTranslation();
  const { sessionId } = useParams();

  const [activePanel, setActivePanel] = useState('question');
  const [chatRefreshToken, setChatRefreshToken] = useState(0);
  const [chatEvent, setChatEvent] = useState(null);
  const pendingChatRefreshRef = useRef(false);
  const queueChatRefresh = useCallback((eventPayload = null) => {
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

  const { liveData, loading, error, transport: liveTransport } = useLiveSessionData({
    sessionId, role: 'presentation', onChatEvent: queueChatRefresh,
  });
  const sessionEnded = liveData?.session?.status === 'done';

  // ---- Derived state ----

  const session = liveData?.session;
  const courseTitle = useMemo(
    () => (liveData?.course?._id ? buildCourseTitle(liveData.course, 'long') : ''),
    [liveData?.course]
  );
  const currentQ = liveData?.currentQuestion;
  const responseStats = liveData?.responseStats;
  const wordCloudData = liveData?.wordCloudData || currentQ?.sessionOptions?.wordCloudData || null;
  const histogramData = liveData?.histogramData || currentQ?.sessionOptions?.histogramData || null;
  const allResponses = liveData?.allResponses || [];
  const qType = currentQ ? normalizeQuestionType(currentQ) : null;
  const isSlide = isSlideType(qType);
  const isHidden = !!liveData?.questionHidden;
  const showStats = !!liveData?.showStats;
  const showCorrect = !!liveData?.showCorrect;
  const showResponseList = liveData?.showResponseList !== false;
  const chatEnabled = !!session?.chatEnabled;
  const richTextChatEnabled = session?.richTextChatEnabled !== false;
  const showShortAnswerStats = showStats && responseStats?.type === 'shortAnswer'
    && (!!showResponseList || !!wordCloudData?.wordFrequencies?.length);
  const questionIds = session?.questions || [];
  const qIdx = session ? questionIds.indexOf(session.currentQuestion) : -1;
  const totalQ = questionIds.length || 0;
  const pageProgress = liveData?.pageProgress || (totalQ > 0 && qIdx >= 0
    ? { current: qIdx + 1, total: totalQ }
    : null);
  const questionProgress = liveData?.questionProgress || null;
  const hasSlidesInSession = !!(pageProgress && questionProgress && pageProgress.total !== questionProgress.total);
  const isOptionBasedQuestion = isOptionBasedQuestionType(qType) || qType === QUESTION_TYPES.TRUE_FALSE;
  const showInlineOptionStats = isOptionBasedQuestion
    && showStats
    && responseStats?.type === 'distribution';
  const inlineDistribution = showInlineOptionStats ? (responseStats.distribution || []) : [];
  const inlineDistributionTotal = Number(responseStats?.total) > 0
    ? Number(responseStats.total)
    : inlineDistribution.reduce((sum, d) => sum + (d.count || 0), 0);
  const waitingPanelTabs = [
    { value: 'question', label: t('professor.secondDesktop.currentQuestion') },
    ...(chatEnabled ? [{ value: 'chat', label: t('sessionChat.chat') }] : []),
  ];

  // ---- Auto-close popup window when session ends ----

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

  useEffect(() => {
    if (!sessionEnded) return;
    const timer = setTimeout(() => {
      if (window.opener) {
        window.close();
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [sessionEnded]);

  useEffect(() => {
    const name = session?.name || t('professor.secondDesktop.presentation');
    document.title = `${name} — Qlicker`;
  }, [session?.name, t]);

  const renderHeader = ({ compact = false, showSessionName = true } = {}) => (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 0.5 : 1,
        width: '100%',
        mb: compact ? 2 : 4,
        textAlign: 'center',
      }}
    >
      {courseTitle ? (
        <Typography variant={compact ? 'body1' : 'h5'} sx={{ fontWeight: 700 }}>
          {courseTitle}
        </Typography>
      ) : null}
      {showSessionName ? (
        <Typography variant={compact ? 'body2' : 'h6'} sx={{
          color: "text.secondary"
        }}>
          {session?.name || t('professor.secondDesktop.presentation')}
        </Typography>
      ) : null}
    </Box>
  );

  // ---- Render: loading ----

  if (loading) {
    return (
      <Box
        sx={{
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          minHeight: '100vh', bgcolor: 'background.default',
        }}
      >
        <CircularProgress size={48} />
      </Box>
    );
  }

  // ---- Render: error ----

  if (error) {
    return (
      <Box sx={{ p: 4, maxWidth: 600, mx: 'auto', mt: 8 }}>
        {renderHeader()}
        <Alert severity="error" sx={{ fontSize: '1.1rem' }}>{error}</Alert>
      </Box>
    );
  }

  // ---- Render: session ended ----

  if (sessionEnded) {
    return (
      <Box
        sx={{
          display: 'flex', justifyContent: 'center', alignItems: 'center',
          minHeight: '100vh', bgcolor: 'background.default',
          flexDirection: 'column',
          p: 4,
        }}
      >
        {renderHeader()}
        <Typography variant="h2" sx={{ fontWeight: 700, color: 'text.secondary' }}>
          {t('professor.secondDesktop.sessionEnded')}
        </Typography>
      </Box>
    );
  }

  // ---- Render: join code overlay ----

  if (session?.joinCodeActive && session?.currentJoinCode) {
    return (
      <Box
        sx={{
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          alignItems: 'center', minHeight: '100vh', bgcolor: 'background.default',
          p: 4, textAlign: 'center',
        }}
        aria-label={t('professor.secondDesktop.joinCodeDisplay')}
      >
        {renderHeader()}
        <Typography variant="h5" sx={{ fontWeight: 600, color: 'text.secondary', mb: 2 }}>
          {t('professor.secondDesktop.joinCode')}
        </Typography>
        <Typography
          variant="h1"
          sx={{
            fontWeight: 700,
            fontSize: { xs: '4rem', sm: '6rem', md: '8rem' },
            letterSpacing: 12,
            fontFamily: 'monospace',
            color: 'text.primary',
          }}
          aria-label={t('professor.secondDesktop.joinCodeAria', { code: session.currentJoinCode })}
        >
          {session.currentJoinCode}
        </Typography>
        <Typography variant="h6" sx={{ mt: 3, color: 'text.secondary' }}>
          {session.name || t('professor.secondDesktop.liveSession')}
        </Typography>
        {session.joinCodeInterval && (
          <Chip
            label={t('professor.secondDesktop.refreshesEvery', { interval: session.joinCodeInterval })}
            size="small"
            variant="outlined"
            sx={{ ...COMPACT_CHIP_SX, mt: 2 }}
          />
        )}
      </Box>
    );
  }

  // ---- Render: waiting for question ----

  if (!currentQ || isHidden) {
    if (!chatEnabled) {
      return (
        <Box
          sx={{
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            alignItems: 'center', minHeight: '100vh', bgcolor: 'background.default',
            p: 4, textAlign: 'center',
          }}
        >
          {renderHeader({ showSessionName: false })}
          <Typography variant="h3" sx={{ fontWeight: 700, color: 'text.secondary', mb: 2 }}>
            {session?.name || t('professor.secondDesktop.liveSession')}
          </Typography>
          <Typography variant="h5" sx={{ color: 'text.secondary' }}>
            {t('professor.secondDesktop.waitingForQuestion')}
          </Typography>
        </Box>
      );
    }

    return (
      <Box
        sx={{
          minHeight: '100vh',
          bgcolor: 'background.default',
          display: 'flex',
          flexDirection: 'column',
          p: { xs: 2, sm: 4 },
        }}
      >
        {renderHeader({ compact: true })}
        <LiveSessionPanelNavigation
          value={activePanel}
          onChange={setActivePanel}
          tabs={waitingPanelTabs}
          ariaLabel={t('professor.secondDesktop.panelsLabel')}
        />
        {activePanel === 'chat' ? (
          <SessionChatPanel
            sessionId={sessionId}
            enabled={chatEnabled}
            role="presentation"
            richTextChatEnabled={richTextChatEnabled}
            view="presentation"
            syncTransport={liveTransport}
            refreshToken={chatRefreshToken}
            chatEvent={chatEvent}
          />
        ) : (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
            <Typography variant="h3" sx={{ fontWeight: 700, color: 'text.secondary', mb: 2 }}>
              {session?.name || t('professor.secondDesktop.liveSession')}
            </Typography>
            <Typography variant="h5" sx={{ color: 'text.secondary' }}>
              {t('professor.secondDesktop.waitingForQuestion')}
            </Typography>
          </Paper>
        )}
      </Box>
    );
  }

  // ---- Render: active question ----

  return (
    <Box
      sx={{
        minHeight: '100vh', bgcolor: 'background.default',
        display: 'flex', flexDirection: 'column', p: { xs: 2, sm: 4 },
      }}
    >
      {renderHeader({ compact: true })}

      {chatEnabled ? (
        <LiveSessionPanelNavigation
          value={activePanel}
          onChange={setActivePanel}
          tabs={waitingPanelTabs}
          ariaLabel={t('professor.secondDesktop.panelsLabel')}
        />
      ) : null}

      {activePanel === 'chat' ? (
        <SessionChatPanel
          sessionId={sessionId}
          enabled={chatEnabled}
          role="presentation"
          richTextChatEnabled={richTextChatEnabled}
          view="presentation"
          syncTransport={liveTransport}
          refreshToken={chatRefreshToken}
          chatEvent={chatEvent}
        />
      ) : (
        <>

      {/* Top info bar */}
      <Box
        sx={{
          display: 'flex', alignItems: 'center', gap: 1.5,
          mb: 3, flexWrap: 'wrap',
        }}
      >
        {hasSlidesInSession && pageProgress && (
          <Chip
            label={t('professor.secondDesktop.pageProgress', pageProgress)}
            size="small"
            variant="outlined"
            sx={COMPACT_CHIP_SX}
          />
        )}
        {!isSlide && questionProgress && (
          <Chip
            label={t('professor.secondDesktop.questionProgress', questionProgress)}
            size="small"
            variant="outlined"
            sx={COMPACT_CHIP_SX}
          />
        )}
        <Chip
          label={getQuestionTypeLabel(t, qType, {
            key: 'professor.secondDesktop.question',
            defaultValue: 'Question',
          })}
          color={TYPE_COLORS[qType] || 'default'}
          size="small"
          sx={COMPACT_CHIP_SX}
        />
      </Box>

      {/* Question content */}
      <Paper
        variant="outlined"
        sx={{ p: { xs: 2, sm: 3 }, mb: 3, flex: '0 0 auto' }}
        aria-label={t('professor.secondDesktop.currentQuestion')}
      >
        <RichContent html={currentQ.content} fallback={currentQ.plainText} allowVideoEmbeds />
      </Paper>

      {/* Options for MC / TF / MS */}
      {isOptionBasedQuestion && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mb: 3 }}>
          {(currentQ.options || []).map((opt, i) => {
            const isCorrect = showCorrect && !!opt.correct;
            const count = inlineDistribution?.[i]?.count || 0;
            const pct = inlineDistributionTotal > 0 ? Math.round(100 * count / inlineDistributionTotal) : 0;
            const optionContent = getOptionRichContentProps(opt);
            const barColor = showCorrect
              ? (isCorrect ? 'rgba(46, 125, 50, 0.22)' : 'rgba(211, 47, 47, 0.14)')
              : 'rgba(25, 118, 210, 0.18)';
            return (
              <Paper
                key={opt._id || i}
                variant="outlined"
                sx={{
                  position: 'relative',
                  overflow: 'hidden',
                  p: { xs: 1.5, sm: 2 },
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 1.5,
                  borderColor: isCorrect ? 'success.main' : 'divider',
                  bgcolor: isCorrect ? 'success.50' : 'transparent',
                  borderWidth: isCorrect ? 2 : 1,
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
                      ? '34px minmax(0, 1fr) 88px'
                      : '34px minmax(0, 1fr)',
                    columnGap: 1.5,
                    alignItems: 'start',
                    width: '100%',
                  }}
                >
                <Chip
                  label={OPTION_LETTERS[i]}
                  size="small"
                  color={isCorrect ? 'success' : 'default'}
                  sx={{ ...COMPACT_CHIP_SX, fontWeight: 700, minWidth: 32, fontSize: '1rem', justifySelf: 'start' }}
                />
                <Box sx={{ minWidth: 0 }}>
                  <RichContent html={optionContent.html} fallback={optionContent.fallback} />
                </Box>
                {showInlineOptionStats && (
                  <Typography variant="h6" sx={{ minWidth: 80, textAlign: 'right', fontWeight: 600 }}>
                    {pct}%
                  </Typography>
                )}
                </Box>
              </Paper>
            );
          })}
        </Box>
      )}

      {/* Numerical placeholder */}
      {qType === QUESTION_TYPES.NUMERICAL && (
        <Paper variant="outlined" sx={{ p: 3, mb: 3, textAlign: 'center' }}>
          <Typography variant="h6" sx={{
            color: "text.secondary"
          }}>
            {t('professor.secondDesktop.numericalQuestion')}
          </Typography>
          {showCorrect && currentQ.correctNumerical != null && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="body1">
                {t('professor.secondDesktop.correct', { value: currentQ.correctNumerical })}
              </Typography>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>
                {t('professor.secondDesktop.tolerance', { value: currentQ.toleranceNumerical ?? 0 })}
              </Typography>
            </Box>
          )}
        </Paper>
      )}

      {/* Response statistics */}
      {showStats
        && !isSlide
        && (!isOptionBasedQuestion || responseStats?.type !== 'distribution')
        && (responseStats?.type !== 'shortAnswer' || showShortAnswerStats) && (
        <Paper
          variant="outlined"
          sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}
          aria-label={t('professor.secondDesktop.responseStatistics')}
        >
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>
            {t('professor.secondDesktop.responses')}
          </Typography>
          {responseStats?.type === 'shortAnswer' ? (
            <>
              <WordCloudPanel wordCloudData={wordCloudData} />
              {showResponseList ? (
                <ShortAnswerList responses={responseStats.answers || allResponses} />
              ) : null}
            </>
          ) : responseStats?.type === 'numerical' ? (
            <>
              <HistogramPanel histogramData={histogramData} />
              <NumericalStats stats={responseStats} />
              <ShortAnswerList responses={responseStats.answers || allResponses} />
            </>
          ) : allResponses.length > 0 ? (
            <ShortAnswerList responses={allResponses} />
          ) : (
            <Typography
              variant="body1"
              sx={{
                color: "text.secondary",
                textAlign: 'center'
              }}>
              {t('professor.secondDesktop.noResponsesYet')}
            </Typography>
          )}
        </Paper>
      )}

      {/* Solution (shown when showCorrect is enabled) */}
      {showCorrect && !isSlide && currentQ.solution && (
        <Paper
          variant="outlined"
          sx={{ p: { xs: 2, sm: 3 }, mb: 3, borderColor: 'success.main' }}
          aria-label={t('common.solution')}
        >
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1, color: 'success.main' }}>
            {t('common.solution')}
          </Typography>
          <RichContent html={currentQ.solution} fallback={currentQ.solution_plainText} />
        </Paper>
      )}
        </>
      )}
    </Box>
  );
}

export default function PresentationWindow() {
  const { sessionId } = useParams();
  return (
    <LiveSessionWebSocketProvider sessionId={sessionId}>
      <PresentationContent />
    </LiveSessionWebSocketProvider>
  );
}
