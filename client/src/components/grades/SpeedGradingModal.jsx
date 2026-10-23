import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  ArrowBack as ArrowBackIcon,
  ArrowForward as ArrowForwardIcon,
  Save as SaveIcon,
} from '@mui/icons-material';
import { prepareRichTextInput, renderKatexInElement } from '../questions/richTextUtils';
import StudentRichTextEditor, { MathPreview } from '../questions/StudentRichTextEditor';

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

function RichContent({ html, fallback }) {
  const ref = useRef(null);
  const prepared = prepareRichTextInput(html || '', fallback || '');
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

/**
 * Speed grading modal for quickly grading short-answer / manual-grade
 * question responses one by one with keyboard-driven navigation.
 *
 * Props:
 *  - open          : boolean
 *  - onClose       : () => void
 *  - rows          : array of row objects from the grading panel (sorted/filtered)
 *  - initialIndex  : number – starting index within rows
 *  - activeQuestionId : string
 *  - onSaveGrade   : async (row, { points, feedback }) => void – saves a single grade
 *  - formatOutOf   : (mark) => string – e.g. "/ 5"
 */
export default memo(function SpeedGradingModal({
  open,
  onClose,
  rows = [],
  initialIndex = 0,
  activeQuestionId,
  onSaveGrade,
  formatOutOf,
}) {
  const { t } = useTranslation();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [points, setPoints] = useState('');
  const [feedback, setFeedback] = useState('');
  const [saving, setSaving] = useState(false);

  const pointsInputRef = useRef(null);
  const touchStartRef = useRef(null);
  const initializedRef = useRef(false);
  const pointsValueRef = useRef('');
  const feedbackValueRef = useRef('');

  function loadRowDraft(idx) {
    const row = rows[idx];
    if (!row) return;
    const mark = row.mark;
    const nextPoints = mark && mark.points !== null && mark.points !== undefined ? String(mark.points) : '';
    const nextFeedback = mark?.feedback || '';
    pointsValueRef.current = nextPoints;
    feedbackValueRef.current = nextFeedback;
    setPoints(nextPoints);
    setFeedback(nextFeedback);
  }

  // Initialize state when opening, and keep index in range when row count changes.
  useEffect(() => {
    if (!open) {
      initializedRef.current = false;
      return;
    }

    if (!initializedRef.current) {
      const idx = Math.max(0, Math.min(initialIndex, rows.length - 1));
      setCurrentIndex(idx);
      loadRowDraft(idx);
      initializedRef.current = true;
      return;
    }

    setCurrentIndex((previousIndex) => {
      const boundedIndex = Math.max(0, Math.min(previousIndex, rows.length - 1));
      if (boundedIndex !== previousIndex) {
        loadRowDraft(boundedIndex);
      }
      return boundedIndex;
    });
  }, [initialIndex, open, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentRow = rows[currentIndex] || null;

  const focusPointsInput = useCallback(() => {
    if (!open) return;
    window.requestAnimationFrame(() => {
      if (!pointsInputRef.current) return;
      pointsInputRef.current.focus();
      pointsInputRef.current.select?.();
    });
  }, [open]);

  function navigateTo(nextIdx) {
    if (nextIdx < 0 || nextIdx >= rows.length) return;
    setCurrentIndex(nextIdx);
    loadRowDraft(nextIdx);
  }

  function validatePoints(rawPoints = pointsValueRef.current) {
    const parsedPoints = Number(rawPoints);
    return Number.isFinite(parsedPoints) && parsedPoints >= 0 ? parsedPoints : null;
  }

  const handlePrev = useCallback(() => {
    navigateTo(currentIndex - 1);
  }, [currentIndex, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNext = useCallback(() => {
    navigateTo(currentIndex + 1);
  }, [currentIndex, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveAndNext = useCallback(async () => {
    if (!currentRow || saving) return;
    const parsedPoints = validatePoints(pointsValueRef.current);
    if (parsedPoints === null) return;

    setSaving(true);
    try {
      await onSaveGrade(currentRow, { points: parsedPoints, feedback: feedbackValueRef.current || '' });
      if (currentIndex < rows.length - 1) {
        navigateTo(currentIndex + 1);
      }
    } catch {
      // Error feedback is handled by the parent onSaveGrade callback;
      // swallow here so we don't navigate away from the failed row.
    } finally {
      setSaving(false);
    }
  }, [currentIndex, currentRow, navigateTo, onSaveGrade, rows.length, saving]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    if (!open) return undefined;

    function handleKeyDown(event) {
      // Don't intercept when typing in text fields (except for Enter and arrows)
      const tag = event.target?.tagName?.toLowerCase();
      const isInEditor = event.target?.closest?.('.tiptap') || event.target?.closest?.('.ProseMirror');
      const isInInput = tag === 'input' || tag === 'textarea';

      if (event.key === 'ArrowLeft' && !isInEditor && !isInInput) {
        event.preventDefault();
        navigateTo(currentIndex - 1);
      } else if (event.key === 'ArrowRight' && !isInEditor && !isInInput) {
        event.preventDefault();
        navigateTo(currentIndex + 1);
      } else if (event.key === 'Enter' && !event.shiftKey) {
        // Enter saves and goes next (unless in rich text editor)
        if (!isInEditor) {
          event.preventDefault();
          handleSaveAndNext();
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, currentIndex, rows.length, handleSaveAndNext]); // eslint-disable-line react-hooks/exhaustive-deps

  // Touch swipe support for mobile
  useEffect(() => {
    if (!open || !isMobile) return undefined;

    function handleTouchStart(event) {
      if (event.touches.length === 1) {
        touchStartRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      }
    }

    function handleTouchEnd(event) {
      if (!touchStartRef.current || event.changedTouches.length !== 1) return;
      const dx = event.changedTouches[0].clientX - touchStartRef.current.x;
      const dy = event.changedTouches[0].clientY - touchStartRef.current.y;
      touchStartRef.current = null;

      // Only treat as swipe if horizontal movement exceeds vertical
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (dx > 0) {
          navigateTo(currentIndex - 1);
        } else {
          navigateTo(currentIndex + 1);
        }
      }
    }

    window.addEventListener('touchstart', handleTouchStart, { passive: true });
    window.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', handleTouchStart);
      window.removeEventListener('touchend', handleTouchEnd);
    };
  }, [open, isMobile, currentIndex, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !currentRow) return;
    focusPointsInput();
  }, [currentRow, focusPointsInput, open]);

  const outOfDisplay = useMemo(() => {
    if (!currentRow?.mark) return '';
    return typeof formatOutOf === 'function'
      ? formatOutOf(currentRow.mark)
      : `/ ${currentRow.mark.outOf ?? 0}`;
  }, [currentRow, formatOutOf]);

  if (!open || rows.length === 0) return null;

  const desktopWidth = '50vw';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="md"
      fullWidth
      fullScreen={isMobile}
      aria-labelledby="speed-grading-title"
      slotProps={{
        paper: {
          sx: {
            width: isMobile ? '100%' : desktopWidth,
            maxWidth: isMobile ? '100%' : desktopWidth,
            minWidth: isMobile ? '100%' : 420,
          },
        }
      }}
    >
      <DialogTitle id="speed-grading-title" sx={{ pb: 1 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="subtitle1" component="span" sx={{ fontWeight: 700 }}>
            {currentRow
              ? t('grades.questionPanel.speedGrading.studentLabel', { name: currentRow.displayName })
              : t('grades.questionPanel.speedGrading.title')}
          </Typography>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t('grades.questionPanel.speedGrading.position', {
              current: currentIndex + 1,
              total: rows.length,
            })}
          </Typography>
        </Box>
      </DialogTitle>

      <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, py: 2 }}>
        {/* Student response */}
        {currentRow && (
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.75, fontWeight: 600 }}>
              {t('grades.questionPanel.speedGrading.studentResponse')}
            </Typography>
            <Box
              sx={{
                p: 1.5,
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                bgcolor: 'grey.50',
                minHeight: 60,
              }}
            >
              {currentRow.responseSummary?.richHtml ? (
                <RichContent html={currentRow.responseSummary.richHtml} />
              ) : (
                <Typography variant="body2">
                  {currentRow.responseSummary?.displayText || t('grades.questionPanel.noAnswer')}
                </Typography>
              )}
            </Box>
          </Box>
        )}

        {/* Points input */}
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.75, fontWeight: 600 }}>
            {t('common.points')}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <TextField
              inputRef={pointsInputRef}
              size="small"
              type="number"
              value={points}
              disabled={saving}
              onChange={(event) => {
                const nextValue = event.target.value;
                pointsValueRef.current = nextValue;
                setPoints(nextValue);
              }}
              sx={{ width: 120 }}
              slotProps={{
                htmlInput: { min: 0, 'aria-label': t('common.points') }
              }}
            />
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>
              {outOfDisplay}
            </Typography>
          </Box>
        </Box>

        {/* Feedback editor */}
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 0.75, fontWeight: 600 }}>
            {t('grades.coursePanel.feedback')}
          </Typography>
          <StudentRichTextEditor
            value={feedback}
            disabled={saving}
            onChangeDebounceMs={0}
            onChange={({ html }) => {
              const nextValue = html || '';
              feedbackValueRef.current = nextValue;
              setFeedback(nextValue);
            }}
            placeholder={t('grades.questionPanel.addFeedback')}
            ariaLabel={t('grades.coursePanel.feedback')}
            showMathHint
          />
          <MathPreview html={feedback} debounceMs={220} showLabel={false} />
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 2, py: 1.5, justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            onClick={handlePrev}
            disabled={currentIndex === 0 || saving}
            startIcon={<ArrowBackIcon />}
            size="small"
          >
            {t('common.previous')}
          </Button>
          <Button
            onClick={handleNext}
            disabled={currentIndex >= rows.length - 1 || saving}
            endIcon={<ArrowForwardIcon />}
            size="small"
          >
            {t('common.next')}
          </Button>
        </Box>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            onClick={handleSaveAndNext}
            disabled={saving}
            variant="contained"
            startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />}
            size="small"
          >
            {saving ? t('common.saving') : t('common.save')}
          </Button>
          <Button onClick={onClose} size="small">
            {t('common.close')}
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
});
