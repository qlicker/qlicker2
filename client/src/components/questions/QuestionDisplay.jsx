import {
  Box, Typography, Chip, Paper,
} from '@mui/material';
import {
  CheckCircle as CorrectIcon,
} from '@mui/icons-material';
import { memo, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getQuestionTypeLabel,
  TYPE_COLORS,
  QUESTION_TYPES,
  isOptionBasedQuestionType,
  isSlideType,
  normalizeQuestionType,
} from './constants';
import { prepareRichTextInput, renderKatexInElement } from './richTextUtils';

const questionRichContentSx = {
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

function RichHtml({
  value,
  fallback = '',
  sx = {},
  emptyText = '(no content)',
  allowVideoEmbeds = false,
}) {
  const containerRef = useRef(null);
  const contentHtml = useMemo(
    () => prepareRichTextInput(value || '', fallback || '', { allowVideoEmbeds }),
    [allowVideoEmbeds, value, fallback]
  );
  const innerHtml = useMemo(() => ({ __html: contentHtml }), [contentHtml]);

  useEffect(() => {
    if (!containerRef.current || !contentHtml) return;
    renderKatexInElement(containerRef.current);
  }, [contentHtml]);

  if (!contentHtml) {
    return <Typography variant="body1">{emptyText}</Typography>;
  }
  return (
    <Box
      ref={containerRef}
      sx={sx}
      dangerouslySetInnerHTML={innerHtml}
    />
  );
}

function isCorrectOption(option) {
  const value = option?.correct;
  if (value === true || value === 1 || value === '1') return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return Boolean(value);
}

function QuestionDisplay({ question, allowVideoEmbeds = true }) {
  const { t } = useTranslation();
  if (!question) return null;
  const opts = question.options || [];
  const points = question.sessionOptions?.points;
  const normalizedType = useMemo(() => normalizeQuestionType(question), [question]);
  const isSlide = isSlideType(normalizedType);

  const shouldLetterOptions = [QUESTION_TYPES.MULTIPLE_CHOICE, QUESTION_TYPES.MULTI_SELECT].includes(normalizedType);

  return (
    <Paper variant="outlined" sx={{ p: 2, width: '100%', minWidth: 0, overflow: 'hidden' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Chip label={getQuestionTypeLabel(t, normalizedType)} color={TYPE_COLORS[normalizedType] || 'default'} size="small" sx={COMPACT_CHIP_SX} />
        {!isSlide && points != null && <Chip label={t(points !== 1 ? 'questions.display.pointsPlural' : 'questions.display.points', { points })} size="small" variant="outlined" sx={COMPACT_CHIP_SX} />}
      </Box>

      <RichHtml
        value={question.content}
        fallback={question.plainText}
        sx={{ ...questionRichContentSx, mb: 1 }}
        allowVideoEmbeds={allowVideoEmbeds}
      />

      {isOptionBasedQuestionType(normalizedType) && opts.length > 0 && (
        <Box sx={{ pl: 2 }}>
          {opts.map((opt, i) => (
            <Box
              key={i}
              sx={{
                display: 'grid',
                gridTemplateColumns: shouldLetterOptions ? '20px 20px minmax(0, 1fr)' : '20px minmax(0, 1fr)',
                columnGap: 0.5,
                alignItems: 'start',
                mb: 0.5,
              }}
            >
              <Box sx={{ width: 20, display: 'flex', justifyContent: 'center', pt: 0.25 }}>
                {isCorrectOption(opt) ? <CorrectIcon color="success" fontSize="small" /> : null}
              </Box>
              {shouldLetterOptions ? <Typography variant="body2" sx={{ lineHeight: 1.5 }}>{String.fromCharCode(65 + i)}.</Typography> : null}
              <RichHtml
                value={opt.content || opt.plainText || opt.answer}
                fallback={t('questions.display.option', { index: i + 1 })}
                sx={{
                  color: isCorrectOption(opt) ? 'success.main' : 'text.secondary',
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
                    display: 'block',
                    maxWidth: '90% !important',
                    height: 'auto !important',
                    borderRadius: 0,
                    my: 0.5,
                  },
                }}
              />
            </Box>
          ))}
        </Box>
      )}

      {normalizedType === QUESTION_TYPES.NUMERICAL && (
        <Box sx={{ pl: 2 }}>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t('questions.display.correct', { value: question.correctNumerical ?? '—' })}
          </Typography>
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t('questions.display.tolerance', { value: question.toleranceNumerical ?? 0 })}
          </Typography>
        </Box>
      )}

      {!isSlide && (question.solution || question.solution_plainText) && (
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
          <RichHtml
            value={question.solution}
            fallback={question.solution_plainText}
            sx={questionRichContentSx}
          />
        </Box>
      )}
    </Paper>
  );
}

export default memo(QuestionDisplay);
