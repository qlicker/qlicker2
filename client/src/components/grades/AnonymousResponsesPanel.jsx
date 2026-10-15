import {
  useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Box,
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { VisibilityOff as VisibilityOffIcon } from '@mui/icons-material';
import {
  TYPE_COLORS,
  getQuestionTypeLabel,
  normalizeQuestionType,
} from '../questions/constants';
import { prepareRichTextInput, renderKatexInElement } from '../questions/richTextUtils';
import { getLatestResponse } from '../../utils/responses';
import { buildResponseSummary } from './SessionQuestionGradingPanel';
import ParticipantRoleBadges from '../common/ParticipantRoleBadges';

const richContentSx = {
  '& p': { my: 0.5 },
  '& ul, & ol': { my: 0.5, pl: 3 },
  '& img': {
    display: 'block',
    maxWidth: '90% !important',
    height: 'auto !important',
    my: 0.75,
  },
};

function RichContent({ html, fallback, allowVideoEmbeds = false }) {
  const ref = useRef(null);
  const prepared = prepareRichTextInput(html || '', fallback || '', { allowVideoEmbeds });
  const innerHtml = useMemo(() => ({ __html: prepared }), [prepared]);

  useLayoutEffect(() => {
    if (ref.current) renderKatexInElement(ref.current);
  }, [prepared]);

  if (!prepared) return null;
  return <Box ref={ref} sx={richContentSx} dangerouslySetInnerHTML={innerHtml} />;
}

/**
 * Read-only, per-question view for anonymous respondents or named guests.
 * Anonymous respondents use generic labels; guests retain their names.
 * Neither group has grade items or feedback controls.
 */
export default function AnonymousResponsesPanel({
  questions = [],
  studentResults = [],
  getResponseCorrectness = null,
  anonymous = true,
}) {
  const { t } = useTranslation();
  const [selectedQuestionId, setSelectedQuestionId] = useState('');
  const [answerQuery, setAnswerQuery] = useState('');

  const activeQuestion = questions.find((question) => String(question._id) === selectedQuestionId)
    || questions[0]
    || null;
  const activeQuestionIndex = activeQuestion ? questions.indexOf(activeQuestion) : -1;
  const activeQuestionType = activeQuestion ? normalizeQuestionType(activeQuestion) : null;

  const rows = useMemo(() => {
    if (!activeQuestion) return [];
    const questionId = String(activeQuestion._id);
    return studentResults.flatMap((student) => {
      const result = (student.questionResults || []).find((entry) => String(entry.questionId) === questionId);
      const response = getLatestResponse(result?.responses || []);
      if (!response) return [];
      const summary = buildResponseSummary(activeQuestion, response, t('grades.questionPanel.noAnswer'));
      return [{
        key: String(student.studentId),
        participant: student,
        label: anonymous ? student.firstname : [student.firstname, student.lastname].filter(Boolean).join(' ') || student.email,
        summary,
        correct: typeof getResponseCorrectness === 'function'
          ? getResponseCorrectness(activeQuestion, response)
          : null,
      }];
    });
  }, [activeQuestion, anonymous, getResponseCorrectness, studentResults, t]);

  const filteredRows = useMemo(() => {
    const query = answerQuery.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => (
      `${row.summary.displayText} ${row.summary.filterText}`.toLowerCase().includes(query)
    ));
  }, [answerQuery, rows]);

  if (!activeQuestion) {
    return <Alert severity="info">{t('professor.sessionReview.noQuestions')}</Alert>;
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Alert severity="info" icon={<VisibilityOffIcon fontSize="inherit" />}>
        {anonymous ? t('professor.sessionReview.anonymousResponsesHelp') : t('professor.sessionReview.guestResponsesHelp')}
      </Alert>

      <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField
          select
          size="small"
          label={t('professor.sessionReview.selectQuestion')}
          value={String(activeQuestion._id)}
          onChange={(event) => setSelectedQuestionId(event.target.value)}
          slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
          sx={{ minWidth: 200 }}
        >
          {questions.map((question, index) => (
            <option key={question._id} value={String(question._id)}>
              {t('professor.sessionReview.questionNumberLabel', { number: index + 1 })}
            </option>
          ))}
        </TextField>
        <TextField
          size="small"
          label={t('professor.sessionReview.filterAnswers')}
          value={answerQuery}
          onChange={(event) => setAnswerQuery(event.target.value)}
          sx={{ flex: '1 1 220px', maxWidth: 360 }}
        />
      </Box>

      <Paper variant="outlined" sx={{ p: { xs: 1.5, sm: 2 } }}>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', mb: 1 }}>
          <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 700 }}>
            {t('professor.sessionReview.questionNumberLabel', { number: activeQuestionIndex + 1 })}
          </Typography>
          <Chip
            size="small"
            label={getQuestionTypeLabel(t, activeQuestionType)}
            color={TYPE_COLORS[activeQuestionType] || 'default'}
          />
          <Chip
            size="small"
            variant="outlined"
            label={t('professor.sessionReview.responseCountLabel', { count: rows.length })}
          />
        </Box>
        <RichContent html={activeQuestion.content} fallback={activeQuestion.plainText} allowVideoEmbeds />
      </Paper>

      {filteredRows.length === 0 ? (
        <Alert severity="info">
          {rows.length === 0
            ? t('professor.sessionReview.noResponsesYet')
            : t('professor.sessionReview.noAnswersMatch')}
        </Alert>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label={t('professor.sessionReview.anonymousResponsesTable')}>
            <TableHead>
              <TableRow>
                <TableCell component="th" scope="col" sx={{ fontWeight: 700, width: 160 }}>
                  {anonymous ? t('professor.sessionReview.respondent') : t('professor.sessionReview.name')}
                </TableCell>
                <TableCell component="th" scope="col" sx={{ fontWeight: 700 }}>
                  {t('professor.sessionReview.response')}
                </TableCell>
                <TableCell component="th" scope="col" align="center" sx={{ fontWeight: 700, width: 120 }}>
                  {t('professor.sessionReview.correctColumn')}
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredRows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell component="th" scope="row">
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{row.label}</Typography>
                    {!anonymous && <ParticipantRoleBadges participant={row.participant} />}
                  </TableCell>
                  <TableCell>
                    {row.summary.richHtml
                      ? <RichContent html={row.summary.richHtml} fallback={row.summary.displayText} />
                      : <Typography variant="body2">{row.summary.displayText}</Typography>}
                  </TableCell>
                  <TableCell align="center">
                    {row.correct === null ? '—' : (
                      <Chip
                        size="small"
                        color={row.correct ? 'success' : 'default'}
                        variant={row.correct ? 'filled' : 'outlined'}
                        label={row.correct ? t('common.yes') : t('common.no')}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
