import { useEffect, useState } from 'react';
import {
  Alert, Snackbar, useMediaQuery, useTheme,
} from '@mui/material';
import { alpha, darken } from '@mui/material/styles';
import { useTranslation } from 'react-i18next';

const DEFAULT_SAVE_ERROR_KEY = 'autoSave.errorNotSaved';
const DEFAULT_SAVE_SUCCESS_KEY = 'autoSave.saved';

export default function AutoSaveStatus({ status = 'idle', errorText = '' }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const [notice, setNotice] = useState({
    key: 0,
    open: false,
    severity: 'success',
    message: t(DEFAULT_SAVE_SUCCESS_KEY),
    autoHideDuration: 1200,
  });

  useEffect(() => {
    if (status === 'success') {
      setNotice((prev) => ({
        key: prev.key + 1,
        open: true,
        severity: 'success',
        message: t(DEFAULT_SAVE_SUCCESS_KEY),
        autoHideDuration: 1200,
      }));
      return;
    }

    if (status === 'error') {
      setNotice((prev) => ({
        key: prev.key + 1,
        open: true,
        severity: 'error',
        message: errorText || t(DEFAULT_SAVE_ERROR_KEY),
        autoHideDuration: null,
      }));
    }
  }, [status, errorText, t]);

  const closeNotice = () => {
    setNotice((prev) => ({ ...prev, open: false }));
  };

  if (!notice.open) {
    return null;
  }

  return (
    <Snackbar
      key={notice.key}
      open={notice.open}
      autoHideDuration={notice.autoHideDuration ?? undefined}
      onClose={closeNotice}
      anchorOrigin={{ vertical: 'bottom', horizontal: isMobile ? 'center' : 'right' }}
    >
      <Alert
        severity={notice.severity}
        variant="outlined"
        onClose={closeNotice}
        sx={(activeTheme) => ({
          width: '100%',
          color: activeTheme.palette[notice.severity][activeTheme.palette.mode === 'dark' ? 'light' : 'dark'],
          borderColor: notice.severity === 'success'
            ? alpha(activeTheme.palette.success.main, 0.35)
            : alpha(activeTheme.palette.error.main, 0.35),
          backgroundColor: activeTheme.palette.mode === 'dark'
            ? darken(activeTheme.palette[notice.severity].main, 0.85)
            : alpha(activeTheme.palette[notice.severity].main, 0.12),
          '& .MuiAlert-icon': {
            color: 'inherit',
          },
        })}
      >
        {notice.message}
      </Alert>
    </Snackbar>
  );
}
