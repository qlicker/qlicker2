import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';
import DateTimePreferenceField from '../common/DateTimePreferenceField';
import NotificationList from './NotificationList';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toLocalDateTimeValue(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function buildDefaultFormState() {
  const startAt = new Date();
  startAt.setSeconds(0, 0);
  const endAt = new Date(startAt.getTime() + (12 * 60 * 60 * 1000));
  return {
    recipientType: 'all',
    title: '',
    message: '',
    startAt: toLocalDateTimeValue(startAt),
    endAt: toLocalDateTimeValue(endAt),
    persistUntilDismissed: false,
  };
}

function toIsoOrNull(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function buildPayload(formState) {
  const startAt = toIsoOrNull(formState.startAt);
  const endAt = toIsoOrNull(formState.endAt);
  if (!startAt || !endAt) return null;
  return {
    recipientType: formState.recipientType || 'all',
    title: formState.title.trim(),
    message: formState.message.trim(),
    startAt,
    endAt,
    persistUntilDismissed: formState.persistUntilDismissed === true,
  };
}

export default function ManageNotificationsDialog({
  open,
  onClose,
  scopeType,
  courseId = '',
  title,
  use24Hour = true,
}) {
  const { t } = useTranslation();
  const [formState, setFormState] = useState(() => buildDefaultFormState());
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [editingNotification, setEditingNotification] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ scopeType });
    if (scopeType === 'course' && courseId) {
      params.set('courseId', courseId);
    }
    return params.toString();
  }, [courseId, scopeType]);
  const recipientScopeLabel = useMemo(() => (
    t(
      scopeType === 'course'
        ? `notifications.audience.course.${pendingAction?.payload?.recipientType || formState.recipientType || 'all'}`
        : `notifications.audience.system.${pendingAction?.payload?.recipientType || formState.recipientType || 'all'}`
    )
  ), [formState.recipientType, pendingAction?.payload?.recipientType, scopeType, t]);
  const recipientOptions = useMemo(() => ([
    {
      value: 'all',
      label: t(scopeType === 'course' ? 'notifications.audience.course.all' : 'notifications.audience.system.all'),
    },
    {
      value: 'students',
      label: t(scopeType === 'course' ? 'notifications.audience.course.students' : 'notifications.audience.system.students'),
    },
    {
      value: 'instructors',
      label: t(scopeType === 'course' ? 'notifications.audience.course.instructors' : 'notifications.audience.system.instructors'),
    },
  ]), [scopeType, t]);

  const loadNotifications = useCallback(async () => {
    if (!open) return;
    setLoading(true);
    try {
      const { data } = await apiClient.get(`/notifications/manage?${queryString}`);
      setNotifications(data.notifications || []);
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('notifications.manage.loadFailed') });
    } finally {
      setLoading(false);
    }
  }, [open, queryString, t]);

  useEffect(() => {
    if (!open) return;
    setPendingAction(null);
    loadNotifications();
  }, [loadNotifications, open]);

  useEffect(() => {
    if (!open) {
      setEditingNotification(null);
      setFormState(buildDefaultFormState());
      setPendingAction(null);
    }
  }, [open]);

  const resetForm = useCallback(() => {
    setEditingNotification(null);
    setFormState(buildDefaultFormState());
  }, []);

  const handlePrepareSubmit = (event) => {
    event?.preventDefault?.();
    const payload = buildPayload(formState);
    if (!payload?.title || !payload?.message) {
      setMsg({ severity: 'error', text: t('notifications.manage.validationRequired') });
      return;
    }
    if (new Date(payload.endAt).getTime() <= new Date(payload.startAt).getTime()) {
      setMsg({ severity: 'error', text: t('notifications.manage.validationEndAfterStart') });
      return;
    }
    setPendingAction({ type: editingNotification ? 'update' : 'create', payload });
  };

  const handleConfirmAction = async () => {
    if (!pendingAction) return;
    setSaving(true);
    try {
      if (pendingAction.type === 'delete') {
        await apiClient.delete(`/notifications/${pendingAction.notification._id}`);
        setMsg({ severity: 'success', text: t('notifications.manage.deleted') });
        if (editingNotification?._id === pendingAction.notification._id) {
          resetForm();
        }
      } else if (pendingAction.type === 'update') {
        await apiClient.patch(`/notifications/${editingNotification._id}`, pendingAction.payload);
        setMsg({ severity: 'success', text: t('notifications.manage.updated') });
        resetForm();
      } else {
        await apiClient.post('/notifications/manage', {
          scopeType,
          ...(scopeType === 'course' && courseId ? { courseId } : {}),
          ...pendingAction.payload,
        });
        setMsg({ severity: 'success', text: t('notifications.manage.created') });
        resetForm();
      }
      await loadNotifications();
      setPendingAction(null);
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('notifications.manage.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (notification) => {
    setEditingNotification(notification);
      setFormState({
        recipientType: notification.recipientType || 'all',
        title: notification.title || '',
        message: notification.message || '',
        startAt: toLocalDateTimeValue(notification.startAt),
      endAt: toLocalDateTimeValue(notification.endAt),
      persistUntilDismissed: notification.persistUntilDismissed === true,
    });
  };

  const handleDelete = (notification) => {
    setPendingAction({ type: 'delete', notification });
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
        <DialogTitle>{title}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Box component="form" onSubmit={handlePrepareSubmit}>
                <Stack spacing={2}>
                  <Box>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                      {editingNotification ? t('notifications.manage.editHeading') : t('notifications.manage.createHeading')}
                    </Typography>
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.secondary",
                        mt: 0.5
                      }}>
                      {t('notifications.manage.formHelp')}
                    </Typography>
                  </Box>
                  <TextField
                    label={t('notifications.fields.title')}
                    value={formState.title}
                    onChange={(event) => setFormState((current) => ({ ...current, title: event.target.value }))}
                    fullWidth
                    required
                  />
                  <TextField
                    label={t('notifications.fields.message')}
                    value={formState.message}
                    onChange={(event) => setFormState((current) => ({ ...current, message: event.target.value }))}
                    fullWidth
                    required
                    multiline
                    minRows={4}
                  />
                  <FormControl fullWidth>
                    <InputLabel id="notification-recipient-type-label">
                      {t('notifications.manage.recipientTypeLabel')}
                    </InputLabel>
                    <Select
                      labelId="notification-recipient-type-label"
                      value={formState.recipientType}
                      label={t('notifications.manage.recipientTypeLabel')}
                      onChange={(event) => setFormState((current) => ({
                        ...current,
                        recipientType: event.target.value,
                      }))}
                    >
                      {recipientOptions.map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {option.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Stack spacing={2} direction={{ xs: 'column', md: 'row' }}>
                    <DateTimePreferenceField
                      label={t('notifications.fields.startAt')}
                      value={formState.startAt}
                      onChange={(value) => setFormState((current) => ({ ...current, startAt: value }))}
                      fullWidth
                      use24Hour={use24Hour}
                    />
                    <DateTimePreferenceField
                      label={t('notifications.fields.endAt')}
                      value={formState.endAt}
                      onChange={(value) => setFormState((current) => ({ ...current, endAt: value }))}
                      fullWidth
                      min={formState.startAt}
                      use24Hour={use24Hour}
                      helperText={formState.persistUntilDismissed ? t('notifications.manage.endIgnoredHelp') : ''}
                    />
                  </Stack>
                  <FormControlLabel
                    control={(
                      <Checkbox
                        checked={formState.persistUntilDismissed}
                        onChange={(event) => setFormState((current) => ({
                          ...current,
                          persistUntilDismissed: event.target.checked,
                        }))}
                      />
                    )}
                    label={t('notifications.persistUntilDismissed')}
                  />
                  <Stack direction="row" spacing={1} useFlexGap sx={{
                    flexWrap: "wrap"
                  }}>
                    <Button type="submit" variant="contained" disabled={saving}>
                      {editingNotification ? t('notifications.manage.saveChanges') : t('notifications.manage.postNotification')}
                    </Button>
                    {editingNotification ? (
                      <Button variant="outlined" onClick={resetForm} disabled={saving}>
                        {t('notifications.manage.cancelEdit')}
                      </Button>
                    ) : null}
                  </Stack>
                </Stack>
              </Box>
            </Paper>

            <Paper variant="outlined" sx={{ p: 2 }}>
              <Stack spacing={1.5}>
                <Box>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                    {t('notifications.manage.existingHeading')}
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                      mt: 0.5
                    }}>
                    {t('notifications.manage.listHelp')}
                  </Typography>
                </Box>
                <Box sx={{ maxHeight: 360, overflowY: 'auto', pr: 0.5 }}>
                  <NotificationList
                    notifications={notifications}
                    loading={loading}
                    emptyText={t('notifications.manage.none')}
                    mode="manage"
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                  />
                </Box>
              </Stack>
            </Paper>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!pendingAction} onClose={() => setPendingAction(null)} maxWidth="xs" fullWidth>
        <DialogTitle>
          {pendingAction?.type === 'delete'
            ? t('notifications.manage.confirmDeleteTitle')
            : editingNotification
              ? t('notifications.manage.confirmUpdateTitle')
              : t('notifications.manage.confirmCreateTitle')}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2">
              {pendingAction?.type === 'delete'
                ? t('notifications.manage.confirmDeleteMessage', { title: pendingAction?.notification?.title || '' })
                : editingNotification
                  ? t('notifications.manage.confirmUpdateMessage', { recipientScope: recipientScopeLabel })
                  : t('notifications.manage.confirmCreateMessage', { recipientScope: recipientScopeLabel })}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingAction(null)} disabled={saving}>{t('common.cancel')}</Button>
          <Button
            onClick={handleConfirmAction}
            variant="contained"
            color={pendingAction?.type === 'delete' ? 'error' : 'primary'}
            disabled={saving}
          >
            {pendingAction?.type === 'delete' ? t('common.delete') : t('common.confirm')}
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={!!msg}
        autoHideDuration={4000}
        onClose={() => setMsg(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {msg ? <Alert severity={msg.severity} onClose={() => setMsg(null)}>{msg.text}</Alert> : null}
      </Snackbar>
    </>
  );
}
