import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Typography } from '@mui/material';
import { Login as JoinIcon } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';

export default function JoinActivityButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');

  const close = () => {
    if (joining) return;
    setOpen(false);
    setCode('');
    setError('');
  };
  const join = async (event) => {
    event.preventDefault();
    if (joining || !code.trim()) return;
    if (!/^S-/i.test(code.trim())) {
      setError(t('student.dashboard.activityCodeRequired'));
      return;
    }
    setJoining(true);
    setError('');
    try {
      const { data } = await apiClient.post('/activity-codes/redeem', { code: code.trim() });
      setOpen(false);
      setCode('');
      navigate(`/activity/${data.courseId}/session/${data.sessionId}/${data.quiz ? 'quiz' : 'live'}`);
    } catch (err) {
      setError(err.response?.data?.message || t('student.dashboard.failedJoinActivity'));
    } finally {
      setJoining(false);
    }
  };

  return (
    <>
      <Button variant="outlined" startIcon={<JoinIcon />} onClick={() => setOpen(true)}>
        {t('student.dashboard.joinActivity')}
      </Button>
      <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
        <DialogTitle>{t('student.dashboard.joinActivity')}</DialogTitle>
        <Box component="form" onSubmit={join}>
          <DialogContent sx={{ pt: '8px !important' }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t('student.dashboard.activityCodeHelp')}
            </Typography>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            <TextField label={t('student.dashboard.activityCode')} value={code}
              onChange={(event) => { setCode(event.target.value); setError(''); }}
              disabled={joining} fullWidth autoFocus />
          </DialogContent>
          <DialogActions>
            <Button onClick={close} disabled={joining}>{t('common.cancel')}</Button>
            <Button type="submit" variant="contained" disabled={joining || !code.trim()}>
              {t(joining ? 'student.dashboard.joiningActivity' : 'student.dashboard.joinActivity')}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>
    </>
  );
}
