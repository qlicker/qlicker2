import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Box, Card, CardContent, Button, Typography, Alert, CircularProgress,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import apiClient from '../api/client';

export default function VerifyEmail() {
  const { t } = useTranslation();
  const { token } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const verify = async () => {
      try {
        await apiClient.post('/auth/verify-email', { token });
      } catch {
        setError(t('verifyEmail.invalidLink'));
      } finally {
        setLoading(false);
      }
    };
    verify();
  }, [token]);

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
            {t('verifyEmail.title')}
          </Typography>
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          ) : error ? (
            <Alert severity="error">{error}</Alert>
          ) : (
            <>
              <Alert severity="success" sx={{ mb: 2 }}>{t('verifyEmail.verified')}</Alert>
              <Button fullWidth variant="contained" onClick={() => navigate('/login')}>
                {t('verifyEmail.goToLogin')}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}
