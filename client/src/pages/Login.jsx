import { useState, useEffect } from 'react';
import { useNavigate, Navigate, Link } from 'react-router-dom';
import {
  Box, Card, CardContent, TextField, Button, Typography, Alert, Divider, Dialog, DialogTitle, DialogContent, DialogActions, CircularProgress,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import apiClient from '../api/client';
import ResponsiveTabsNavigation from '../components/common/ResponsiveTabsNavigation';
import QlickerWordmark from '../components/common/QlickerWordmark';
import { getDashboardPath } from '../utils/dashboard';

export default function Login() {
  const { t } = useTranslation();
  const [tab, setTab] = useState(0);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstname, setFirstname] = useState('');
  const [lastname, setLastname] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [ssoInstitutionName, setSsoInstitutionName] = useState('SSO');
  const [registrationDisabled, setRegistrationDisabled] = useState(false);
  const [showEmailLogin, setShowEmailLogin] = useState(false);
  const [publicSettingsLoading, setPublicSettingsLoading] = useState(true);
  const [publicSettingsError, setPublicSettingsError] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMsg, setForgotMsg] = useState(null);
  const [forgotLoading, setForgotLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);
  const {
    user,
    loading: authLoading,
    login,
    register,
  } = useAuth();

  useEffect(() => {
    let active = true;

    setPublicSettingsLoading(true);
    setPublicSettingsError(false);

    apiClient.get('/settings/public').then(({ data }) => {
      if (!active) return;
      const enabled = !!data.SSO_enabled;
      setSsoEnabled(enabled);
      setRegistrationDisabled(!!data.registrationDisabled);
      const institution = (data.SSO_institutionName || '').trim();
      setSsoInstitutionName(institution || 'SSO');
      setShowEmailLogin(!enabled);
      if (!!data.registrationDisabled) setTab(0);
      setPublicSettingsLoading(false);
    }).catch(() => {
      if (!active) return;
      setPublicSettingsError(true);
      setPublicSettingsLoading(false);
    });

    return () => {
      active = false;
    };
  }, []);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setStatusMessage(null);
    setLoading(true);
    try {
      const user = await login(email, password);
      navigate(getDashboardPath(user), { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    setForgotMsg(null);
    setForgotLoading(true);
    try {
      await apiClient.post('/auth/forgot-password', { email: forgotEmail });
      setForgotMsg({ severity: 'success', text: t('auth.resetLinkSent') });
      setTimeout(() => setForgotOpen(false), 5000);
    } catch {
      setForgotMsg({ severity: 'error', text: t('auth.resetEmailFailed') });
    } finally {
      setForgotLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');
    setStatusMessage(null);
    setLoading(true);
    try {
      const result = await register(email, password, firstname, lastname);
      if (result?.requiresEmailVerification) {
        setStatusMessage({ severity: 'success', text: result.message || t('auth.verifyBeforeLogin') });
        setTab(0);
        setPassword('');
        return;
      }
      const user = result;
      navigate(getDashboardPath(user), { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const renderEmailLoginForm = ({ showBackToSso = false } = {}) => (
    <Box component="form" onSubmit={handleLogin} autoComplete="on" aria-label={t('auth.login')}>
      <TextField
        fullWidth
        id="login-email"
        name="email"
        label={t('auth.email')}
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        margin="normal"
        slotProps={{
          htmlInput: { inputMode: 'email', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: 'false' }
        }}
      />
      <TextField
        fullWidth
        id="login-password"
        name="password"
        label={t('auth.password')}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        margin="normal"
      />
      <Button fullWidth variant="contained" type="submit" disabled={loading} sx={{ mt: 2 }}>
        {loading ? t('auth.loggingIn') : t('auth.login')}
      </Button>
      <Button type="button" size="small" sx={{ mt: 1 }} onClick={() => { setForgotOpen(true); setForgotMsg(null); setForgotEmail(''); }}>
        {t('auth.forgotPassword')}
      </Button>
      {showBackToSso && (
        <Button type="button" size="small" sx={{ mt: 1 }} onClick={() => { setShowEmailLogin(false); setError(''); }}>
          {t('auth.backToSSO')}
        </Button>
      )}
    </Box>
  );

  if (user) {
    return <Navigate to={getDashboardPath(user)} replace />;
  }

  if (authLoading || publicSettingsLoading) {
    return (
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "100vh"
        }}>
        <CircularProgress />
      </Box>
    );
  }

  if (publicSettingsError) {
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
            <Box
              component={Link}
              to="/"
              aria-label={t('auth.goToLandingPage')}
              sx={{
                display: 'flex',
                justifyContent: 'center',
                m: 0,
                mb: 2,
                color: 'primary.main',
                textDecoration: 'none',
              }}
            >
              <QlickerWordmark height={42} title={t('common.appName')} />
            </Box>
            <Alert severity="warning" sx={{ mb: 2 }}>
              {t('auth.loadingLoginOptions', { defaultValue: 'Qlicker is still loading sign-in options. Please try again in a moment.' })}
            </Alert>
            <Button fullWidth variant="contained" onClick={() => window.location.reload()}>
              {t('common.retry', { defaultValue: 'Retry' })}
            </Button>
          </CardContent>
        </Card>
      </Box>
    );
  }

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
          <Box
            component={Link}
            to="/"
            aria-label={t('auth.goToLandingPage')}
            sx={{
              display: 'flex',
              justifyContent: 'center',
              m: 0,
              mb: 2,
              color: 'primary.main',
              textDecoration: 'none',
            }}
          >
            <QlickerWordmark height={42} title={t('common.appName')} />
          </Box>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          {statusMessage && <Alert severity={statusMessage.severity} sx={{ mb: 2 }}>{statusMessage.text}</Alert>}
          {ssoEnabled ? (
            <>
              <Button
                fullWidth
                variant="contained"
                size="large"
                // Full page redirect required — SSO login is an external IdP redirect, not an API call
                onClick={() => { window.location.href = '/api/v1/auth/sso/login'; }}
                sx={{ py: 1.6, mt: 1, fontWeight: 700 }}
              >
                {t('auth.loginThrough', { institution: ssoInstitutionName || t('auth.ssoDefault') })}
              </Button>
              {!showEmailLogin ? (
                <Box
                  sx={{
                    textAlign: "center",
                    mt: 1.5
                  }}>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => { setShowEmailLogin(true); setError(''); }}
                    sx={{ textTransform: 'none', minHeight: 'unset', p: 0, fontSize: '0.8rem' }}
                  >
                    {t('auth.haveEmailAccount')}
                  </Button>
                </Box>
              ) : (
                <>
                  <Divider sx={{ my: 2 }}>{t('common.or')}</Divider>
                  {renderEmailLoginForm({ showBackToSso: true })}
                </>
              )}
            </>
          ) : (
            <>
              {registrationDisabled ? (
                <>
                  <Alert severity="info" sx={{ mb: 2 }}>
                    {t('auth.selfRegistrationDisabled')}
                  </Alert>
                  {renderEmailLoginForm()}
                </>
              ) : (
                <>
                  <ResponsiveTabsNavigation
                    value={tab}
                    onChange={(nextTab) => {
                      setTab(nextTab);
                      setError('');
                      setStatusMessage(null);
                    }}
                    ariaLabel={t('auth.login')}
                    dropdownLabel={t('common.view')}
                    dropdownSx={{ mb: 2, width: '100%' }}
                    tabs={[
                      { value: 0, label: t('auth.login') },
                      { value: 1, label: t('auth.register') },
                    ]}
                    tabsProps={{ centered: true, sx: { mb: 2 } }}
                  />
                  {tab === 0 ? (
                    renderEmailLoginForm()
                  ) : (
                    <Box component="form" onSubmit={handleRegister} autoComplete="on" aria-label={t('auth.register')}>
                      <TextField
                        fullWidth
                        id="register-firstname"
                        name="firstname"
                        label={t('auth.firstName')}
                        autoComplete="given-name"
                        value={firstname}
                        onChange={(e) => setFirstname(e.target.value)}
                        required
                        margin="normal"
                      />
                      <TextField
                        fullWidth
                        id="register-lastname"
                        name="lastname"
                        label={t('auth.lastName')}
                        autoComplete="family-name"
                        value={lastname}
                        onChange={(e) => setLastname(e.target.value)}
                        required
                        margin="normal"
                      />
                      <TextField
                        fullWidth
                        id="register-email"
                        name="email"
                        label={t('auth.email')}
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        margin="normal"
                        slotProps={{
                          htmlInput: { inputMode: 'email', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: 'false' }
                        }}
                      />
                      <TextField
                        fullWidth
                        id="register-password"
                        name="password"
                        label={t('auth.password')}
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                        margin="normal"
                      />
                      <Button fullWidth variant="contained" type="submit" disabled={loading} sx={{ mt: 2 }}>
                        {loading ? t('auth.creatingAccount') : t('auth.createAccount')}
                      </Button>
                    </Box>
                  )}
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>
      <Dialog open={forgotOpen} onClose={() => setForgotOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('auth.forgotPasswordTitle')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            {t('auth.forgotPasswordMessage')}
          </Typography>
          {ssoEnabled ? (
            <Alert severity="info" sx={{ mb: 1 }}>
              {t('auth.forgotPasswordSsoNotice')}
            </Alert>
          ) : null}
          <TextField
            fullWidth
            id="forgot-password-email"
            name="email"
            label={t('auth.email')}
            type="email"
            autoComplete="email"
            value={forgotEmail}
            onChange={(e) => setForgotEmail(e.target.value)}
            margin="normal"
            slotProps={{
              htmlInput: { inputMode: 'email', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: 'false' }
            }}
          />
          {forgotMsg && <Alert severity={forgotMsg.severity} sx={{ mt: 1 }}>{forgotMsg.text}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setForgotOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="contained" onClick={handleForgotPassword} disabled={forgotLoading || !forgotEmail}>
            {forgotLoading ? t('auth.sending') : t('auth.sendResetLink')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
