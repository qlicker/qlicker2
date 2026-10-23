import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Typography,
  Box,
  Avatar,
  Divider,
  CircularProgress,
  List,
  ListItem,
  ListItemText,
  Stack,
} from '@mui/material';
import apiClient from '../../api/client';
import StudentListItem from './StudentListItem';

function normalizeGroupMembers(group) {
  if (Array.isArray(group?.members)) return group.members;
  if (Array.isArray(group?.students)) return group.students;
  return [];
}

function normalizeGroupName(group, index) {
  return String(group?.name || group?.groupName || `Group ${index + 1}`).trim();
}

function roundToTenths(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

function formatStatPercent(value) {
  if (!Number.isFinite(value)) return '—';
  return `${roundToTenths(value)}%`;
}

function buildStudentStats({ sessions = [], grades = [] }) {
  const gradeBySessionId = new Map(
    (grades || []).map((grade) => [String(grade?.sessionId || ''), grade])
  );

  const interactiveSessions = (sessions || []).filter(
    (session) => !session?.quiz && !session?.practiceQuiz && Number(session?.joinedCount || 0) > 1
  );
  const endedQuizSessions = (sessions || []).filter(
    (session) => (session?.quiz || session?.practiceQuiz) && session?.status === 'done'
  );

  const joinedInteractions = interactiveSessions.filter((session) => {
    const grade = gradeBySessionId.get(String(session?._id || ''));
    return !!grade?.joined;
  }).length;

  const completedQuizzes = endedQuizSessions.filter((session) => {
    const grade = gradeBySessionId.get(String(session?._id || ''));
    return !!grade?.submitted;
  }).length;

  const average = (selectedSessions, field) => {
    const applicableGrades = selectedSessions
      .map((session) => gradeBySessionId.get(String(session?._id || '')))
      .filter((grade) => grade && (grade.hasGradeItem === true || grade._id)
        && grade.hasGradeItem !== false && !grade.notApplicable);
    return applicableGrades.length > 0
      ? roundToTenths(applicableGrades.reduce((sum, grade) => sum + (Number(grade[field]) || 0), 0) / applicableGrades.length)
      : null;
  };
  const interactiveGradeAverage = average(interactiveSessions, 'value');
  const quizGradeAverage = average(endedQuizSessions, 'value');
  const participationAverage = average(interactiveSessions, 'participation');

  return {
    joinedInteractions,
    totalInteractiveSessions: interactiveSessions.length,
    completedQuizzes,
    totalEndedQuizzes: endedQuizSessions.length,
    interactiveGradeAverage,
    quizGradeAverage,
    participationAverage,
  };
}

function buildGroupMemberships(course, studentId) {
  const categories = Array.isArray(course?.groupCategories) ? course.groupCategories : [];
  const students = Array.isArray(course?.students) ? course.students : [];

  return categories.flatMap((category) => (
    (category?.groups || []).flatMap((group, index) => {
      const memberIds = normalizeGroupMembers(group).map((memberId) => String(memberId));
      if (!memberIds.includes(String(studentId || ''))) return [];

      return [{
        categoryNumber: category?.categoryNumber,
        categoryName: String(category?.categoryName || '').trim(),
        groupIndex: index,
        groupName: normalizeGroupName(group, index),
        members: students.filter((member) => memberIds.includes(String(member?._id || ''))),
      }];
    })
  ));
}

function StatRow({ label, value }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
      <Typography variant="body2" sx={{
        color: "text.secondary"
      }}>{label}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 600, textAlign: 'right' }}>{value}</Typography>
    </Box>
  );
}

export default function StudentInfoModal({
  open,
  onClose,
  student,
  course,
  courseId,
  onRemoved,
}) {
  const { t } = useTranslation();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [stats, setStats] = useState(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [selectedMembership, setSelectedMembership] = useState(null);

  const firstname = student?.profile?.firstname || '';
  const lastname = student?.profile?.lastname || '';
  const displayName = `${firstname} ${lastname}`.trim() || 'Unknown';
  const email = student?.emails?.[0]?.address || student?.email || '';
  const avatarSrc = student?.profile?.profileThumbnail || student?.profile?.profileImage || '';

  const memberships = useMemo(
    () => buildGroupMemberships(course, student?._id),
    [course, student?._id]
  );

  const fetchStats = useCallback(async () => {
    if (!open || !student?._id || !courseId) return;
    setLoadingStats(true);
    try {
      const { data } = await apiClient.get(`/courses/${courseId}/grades`, {
        params: { studentId: student._id },
      });
      const row = Array.isArray(data?.rows) ? data.rows[0] : null;
      setStats(buildStudentStats({
        sessions: data?.sessions || [],
        grades: row?.grades || [],
      }));
    } catch {
      setStats(null);
    } finally {
      setLoadingStats(false);
    }
  }, [open, student?._id, courseId]);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  useEffect(() => {
    if (!open) {
      setConfirmRemove(false);
      setRemoving(false);
      setSelectedMembership(null);
    }
  }, [open]);

  const handleRemove = async () => {
    if (!student?._id || !courseId) return;
    setRemoving(true);
    try {
      await apiClient.delete(`/courses/${courseId}/students/${student._id}`);
      onRemoved?.();
      onClose();
    } catch {
      // handled silently
    } finally {
      setRemoving(false);
    }
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogTitle>{t('groups.studentInfo')}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
            <Avatar
              alt={displayName}
              src={avatarSrc}
              slotProps={{
                img: {
                  alt: displayName,
                  loading: 'lazy',
                  decoding: 'async',
                },
              }}
              sx={{ width: 64, height: 64 }}
            >
              {(firstname?.[0] || '').toUpperCase()}
            </Avatar>
            <Box>
              <Typography variant="h6">{displayName}</Typography>
              <Typography variant="body2" sx={{
                color: "text.secondary"
              }}>{email}</Typography>
            </Box>
          </Box>

          <Divider sx={{ mb: 2 }} />

          {loadingStats ? (
            <CircularProgress size={20} />
          ) : stats ? (
            <Stack spacing={1.25} sx={{ mb: 2 }}>
              <StatRow
                label={t('groups.interactiveSessionsJoined')}
                value={t('groups.fractionValue', {
                  current: stats.joinedInteractions,
                  total: stats.totalInteractiveSessions,
                })}
              />
              <StatRow
                label={t('groups.quizzesCompleted')}
                value={t('groups.fractionValue', {
                  current: stats.completedQuizzes,
                  total: stats.totalEndedQuizzes,
                })}
              />
              <StatRow
                label={t('groups.avgInteractiveGrade')}
                value={formatStatPercent(stats.interactiveGradeAverage)}
              />
              <StatRow
                label={t('groups.avgQuizGrade')}
                value={formatStatPercent(stats.quizGradeAverage)}
              />
              <StatRow
                label={t('groups.avgParticipation')}
                value={formatStatPercent(stats.participationAverage)}
              />
            </Stack>
          ) : (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                mb: 2
              }}>
              {t('groups.noStatsAvailable')}
            </Typography>
          )}

          <Divider sx={{ mb: 2 }} />

          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            {t('groups.groupMembership')}
          </Typography>
          {memberships.length > 0 ? (
            <List dense disablePadding sx={{ mb: 2 }}>
              {memberships.map((membership) => (
                <ListItem
                  key={`${membership.categoryNumber}-${membership.groupIndex}`}
                  disableGutters
                  secondaryAction={(
                    <Button size="small" onClick={() => setSelectedMembership(membership)}>
                      {membership.groupName}
                    </Button>
                  )}
                >
                  <ListItemText primary={membership.categoryName || t('groups.uncategorizedGroup')} />
                </ListItem>
              ))}
            </List>
          ) : (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                mb: 2
              }}>
              {t('groups.noGroupMembership')}
            </Typography>
          )}

          <Divider sx={{ mb: 2 }} />

          {confirmRemove ? (
            <Box>
              <Typography variant="body2" color="error" sx={{ mb: 1 }}>
                {t('professor.course.removeStudentConfirm', { name: displayName })}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button variant="contained" color="error" onClick={handleRemove} disabled={removing}>
                  {removing ? t('common.loading') : t('groups.confirmRemove')}
                </Button>
                <Button onClick={() => setConfirmRemove(false)}>{t('common.cancel')}</Button>
              </Box>
            </Box>
          ) : (
            <Button variant="outlined" color="error" onClick={() => setConfirmRemove(true)}>
              {t('groups.removeFromCourse')}
            </Button>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={!!selectedMembership}
        onClose={() => setSelectedMembership(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {selectedMembership
            ? t('groups.groupMembersTitle', {
              category: selectedMembership.categoryName || t('groups.uncategorizedGroup'),
              group: selectedMembership.groupName,
            })
            : ''}
        </DialogTitle>
        <DialogContent dividers>
          <List disablePadding>
            {(selectedMembership?.members || []).map((member, index) => (
              <StudentListItem
                key={member?._id || index}
                student={member}
                sx={{
                  px: 0,
                  ...(index > 0 ? { borderTop: 1, borderColor: 'divider' } : {}),
                }}
              />
            ))}
          </List>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedMembership(null)}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
