import {
  Box,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Close as CloseIcon,
  Delete as DeleteIcon,
  Edit as EditIcon,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import { formatDisplayDateTime } from '../../utils/date';
import { buildCourseTitle } from '../../utils/courseTitle';

function getSourceLabel(notification, t) {
  if (notification?.source?.type === 'course' && notification?.source?.course) {
    return buildCourseTitle(notification.source.course, 'long');
  }
  return t('notifications.systemWide');
}

function getAudienceLabel(notification, t) {
  const scopeKey = notification?.scopeType === 'course' ? 'course' : 'system';
  const recipientType = notification?.recipientType || 'all';
  return t(`notifications.audience.${scopeKey}.${recipientType}`);
}

export default function NotificationList({
  notifications = [],
  loading = false,
  emptyText = '',
  mode = 'user',
  onDismiss,
  onDelete,
  onEdit,
}) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  if (!notifications.length) {
    return (
      <Typography variant="body2" sx={{
        color: "text.secondary"
      }}>
        {emptyText}
      </Typography>
    );
  }

  return (
    <Stack spacing={1.25}>
      {notifications.map((notification) => {
        const emittedAt = formatDisplayDateTime(notification.startAt);
        const expiresAt = formatDisplayDateTime(notification.endAt);
        const sourceLabel = getSourceLabel(notification, t);
        const audienceLabel = getAudienceLabel(notification, t);

        return (
          <Paper key={notification._id} variant="outlined" sx={{ p: 1.5 }}>
            <Stack spacing={1.25}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', justifyContent: 'space-between' }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                    {notification.title}
                  </Typography>
                  <Stack
                    direction="row"
                    spacing={1}
                    useFlexGap
                    sx={{
                      flexWrap: "wrap",
                      mt: 0.75
                    }}>
                    <Chip size="small" label={sourceLabel} variant="outlined" />
                    <Chip size="small" label={audienceLabel} variant="outlined" />
                    <Chip
                      size="small"
                      label={t('notifications.emittedAtValue', { value: emittedAt || t('notifications.unknownTime') })}
                      variant="outlined"
                    />
                    {notification.persistUntilDismissed ? (
                      <Chip size="small" label={t('notifications.persistUntilDismissed')} color="info" variant="outlined" />
                    ) : null}
                  </Stack>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
                  {mode === 'manage' && onEdit ? (
                    <Tooltip title={t('notifications.edit')}>
                      <IconButton size="small" aria-label={t('notifications.edit')} onClick={() => onEdit(notification)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                  {mode === 'manage' && onDelete ? (
                    <Tooltip title={t('notifications.delete')}>
                      <IconButton size="small" color="error" aria-label={t('notifications.delete')} onClick={() => onDelete(notification)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                  {mode === 'user' && onDismiss ? (
                    <Tooltip title={t('notifications.dismiss')}>
                      <IconButton size="small" aria-label={t('notifications.dismiss')} onClick={() => onDismiss(notification)}>
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  ) : null}
                </Box>
              </Box>
              <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {notification.message}
              </Typography>
              {mode === 'manage' ? (
                <Typography variant="caption" sx={{
                  color: "text.secondary"
                }}>
                  {notification.persistUntilDismissed
                    ? t('notifications.expiresIgnoredValue', { value: expiresAt || t('notifications.unknownTime') })
                    : t('notifications.expiresAtValue', { value: expiresAt || t('notifications.unknownTime') })}
                </Typography>
              ) : null}
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}
