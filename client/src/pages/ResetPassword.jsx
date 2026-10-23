import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, TextField, Button, Typography, Alert,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import apiClient from '../api/client';

export default function ResetPassword() {
  const { t } = useTranslation();
  const { token } = useParams();
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (newPassword !== confirmPassword) {
      setMsg({ severity: 'error', text: t('resetPassword.passwordsNoMatch') });
      return;
    }
    if (newPassword.length < 6) {
      setMsg({ severity: 'error', text: t('resetPassword.passwordTooShort') });
      return;
    }
    setLoading(true);
    try {
      await apiClient.post('/auth/reset-password', { token, newPassword });
      setMsg({ severity: 'success', text: t('resetPassword.passwordReset') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('resetPassword.invalidLink') });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "100vh",
        bgcolor: "background.default"
      }}>
      <Card sx={{ maxWidth: 450, width: '100%', mx: 2 }}>
        <CardContent>
          <Typography variant="h4" color="primary" gutterBottom sx={{
            textAlign: "center"
          }}>
            {t('resetPassword.title')}
          </Typography>
          {msg && <Alert severity={msg.severity} sx={{ mb: 2 }}>{msg.text}</Alert>}
          {msg?.severity === 'success' ? (
            <Button fullWidth variant="contained" onClick={() => navigate('/login')}>
              {t('resetPassword.goToLogin')}
            </Button>
          ) : (
            <Box component="form" onSubmit={handleSubmit}>
              <TextField fullWidth label={t('resetPassword.newPassword')} type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required margin="normal" />
              <TextField fullWidth label={t('resetPassword.confirmPassword')} type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required margin="normal" />
              <Button fullWidth variant="contained" type="submit" disabled={loading} sx={{ mt: 2 }}>
                {loading ? t('resetPassword.resetting') : t('resetPassword.title')}
              </Button>
            </Box>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
