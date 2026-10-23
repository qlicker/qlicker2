import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import NotificationList from './NotificationList';

export default function NotificationsDialog({
  open,
  onClose,
  notifications = [],
  loading = false,
  onDismiss,
}) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('notifications.title')}</DialogTitle>
      <DialogContent dividers>
        <NotificationList
          notifications={notifications}
          loading={loading}
          emptyText={t('notifications.none')}
          onDismiss={onDismiss}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('common.close')}</Button>
      </DialogActions>
    </Dialog>
  );
}
