import { useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  AppBar, Toolbar, IconButton, Menu, MenuItem, Avatar, Box, Container, Button, Tooltip, Badge, Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import apiClient from '../../api/client';
import ConnectionStatus from '../common/ConnectionStatus';
import QlickerWordmark from '../common/QlickerWordmark';
import { getManualPath, getPreferredManualRole } from '../../utils/userManuals';
import { getDashboardPath } from '../../utils/dashboard';
import NotificationsDialog from '../notifications/NotificationsDialog';

export default function AppLayout() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [anchorEl, setAnchorEl] = useState(null);
  const [notificationCount, setNotificationCount] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const mainContentRef = useRef(null);
  const roles = user?.profile?.roles || [];
  const isAdmin = roles.includes('admin');
  const manualPath = getManualPath(getPreferredManualRole(roles, user?.hasInstructorCourses));

  const handleMenuOpen = (event) => setAnchorEl(event.currentTarget);
  const handleMenuClose = () => setAnchorEl(null);

  const refreshNotificationSummary = async () => {
    try {
      const { data } = await apiClient.get('/notifications/summary');
      setNotificationCount(Number(data?.count) || 0);
    } catch {
      setNotificationCount(0);
    }
  };

  const loadNotifications = async () => {
    setNotificationsLoading(true);
    try {
      const { data } = await apiClient.get('/notifications');
      const nextNotifications = data?.notifications || [];
      setNotifications(nextNotifications);
      setNotificationCount(nextNotifications.length);
    } catch {
      setNotifications([]);
      setNotificationCount(0);
    } finally {
      setNotificationsLoading(false);
    }
  };

  const handleLogout = async () => {
    handleMenuClose();
    let ssoLogoutUrl = '';
    if (user?.lastAuthProvider === 'sso') {
      try {
        const { data } = await apiClient.get('/auth/sso/logout-url');
        ssoLogoutUrl = data?.url || '';
      } catch {
        ssoLogoutUrl = '';
      }
    }

    await logout();
    if (ssoLogoutUrl) {
      window.location.assign(ssoLogoutUrl);
      return;
    }
    navigate('/login', { replace: true });
  };

  const handleProfile = () => {
    handleMenuClose();
    navigate('/profile');
  };

  const handleNotificationsOpen = async () => {
    handleMenuClose();
    setNotificationsOpen(true);
    await loadNotifications();
  };

  const handleDismissNotification = async (notification) => {
    try {
      await apiClient.post(`/notifications/${notification._id}/dismiss`);
      setNotifications((current) => current.filter((entry) => entry._id !== notification._id));
      setNotificationCount((current) => Math.max(0, current - 1));
    } catch {
      await loadNotifications();
    }
  };

  const getInitials = () => {
    if (!user?.profile) return '?';
    const f = user.profile.firstname?.[0] || '';
    const l = user.profile.lastname?.[0] || '';
    return (f + l).toUpperCase() || '?';
  };

  const currentPath = location.pathname;
  const dashboardPath = getDashboardPath(user);
  const isOnCourseList = currentPath === '/prof';

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      mainContentRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [currentPath]);

  useEffect(() => {
    refreshNotificationSummary();
  }, []);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <Box
        component="a"
        href="#main-content"
        sx={{
          position: 'absolute',
          left: -9999,
          top: 'auto',
          zIndex: 1500,
          px: 1.25,
          py: 0.75,
          borderRadius: 1,
          bgcolor: 'background.paper',
          color: 'text.primary',
          border: '1px solid',
          borderColor: 'divider',
          '&:focus': {
            left: 12,
            top: 12,
          },
        }}
      >
        {t('nav.skipToMain')}
      </Box>
      <ConnectionStatus />
      <AppBar position="static">
        <Toolbar>
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <Button
              color="inherit"
              onClick={() => navigate(dashboardPath)}
              aria-label={t('nav.goToDashboard')}
              sx={{
                p: 0,
                minWidth: 0,
                textTransform: 'none',
                '&:hover': { backgroundColor: 'transparent' },
              }}
            >
              <QlickerWordmark
                ariaHidden
                height={34}
                style={{ color: 'currentColor' }}
              />
            </Button>
          </Box>
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title={t('nav.openAccountMenuTooltip')} arrow>
            <IconButton
              onClick={(event) => {
                handleMenuOpen(event);
                refreshNotificationSummary();
              }}
              color="inherit"
              aria-label={t('nav.openAccountMenu')}
            >
              <Badge
                color="error"
                badgeContent={notificationCount}
                invisible={notificationCount <= 0}
                overlap="circular"
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              >
                <Avatar
                  alt={`${user?.profile?.firstname || ''} ${user?.profile?.lastname || ''}`.trim() || 'User avatar'}
                  src={user?.profile?.profileThumbnail || user?.profile?.profileImage}
                  slotProps={{
                    img: {
                      alt: `${user?.profile?.firstname || ''} ${user?.profile?.lastname || ''}`.trim() || 'User avatar',
                    },
                  }}
                  sx={{ width: 40, height: 40, bgcolor: 'secondary.main', fontSize: '1rem' }}
                >
                  {getInitials()}
                </Avatar>
              </Badge>
            </IconButton>
          </Tooltip>
          <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={handleMenuClose}>
            <MenuItem disabled>
              {user?.profile?.firstname} {user?.profile?.lastname}
            </MenuItem>
            {notificationCount > 0 && (
              <MenuItem onClick={handleNotificationsOpen}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <span>{t('notifications.title')}</span>
                  <Box
                    component="span"
                    sx={{
                      minWidth: 20,
                      height: 20,
                      px: 0.75,
                      borderRadius: 10,
                      bgcolor: 'error.main',
                      color: 'error.contrastText',
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      lineHeight: 1,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {notificationCount}
                  </Box>
                </Box>
              </MenuItem>
            )}
            {currentPath !== dashboardPath && (
              <MenuItem onClick={() => { handleMenuClose(); navigate(dashboardPath); }}>{t('nav.dashboard')}</MenuItem>
            )}
            {currentPath !== '/profile' && (
              <MenuItem onClick={handleProfile}>{t('nav.profile')}</MenuItem>
            )}
            {currentPath !== manualPath && (
              <MenuItem onClick={() => { handleMenuClose(); navigate(manualPath); }}>{t('nav.userManual')}</MenuItem>
            )}
            {isAdmin && !isOnCourseList && (
              <MenuItem onClick={() => { handleMenuClose(); navigate('/prof'); }}>{t('nav.courses')}</MenuItem>
            )}
            <MenuItem onClick={handleLogout}>{t('nav.logout')}</MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>
      <Container
        component="main"
        id="main-content"
        ref={mainContentRef}
        tabIndex={-1}
        maxWidth="lg"
        sx={{ flex: 1, py: 3, outline: 'none' }}
      >
        <Outlet />
      </Container>
      <NotificationsDialog
        open={notificationsOpen}
        onClose={() => setNotificationsOpen(false)}
        notifications={notifications}
        loading={notificationsLoading}
        onDismiss={handleDismissNotification}
      />
    </Box>
  );
}
