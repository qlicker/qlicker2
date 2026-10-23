import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Box, Typography, Button, Link, CircularProgress } from '@mui/material';
import { useTranslation } from 'react-i18next';
import apiClient from '../api/client';

export default function JitsiWindow() {
  const { t } = useTranslation();
  const { courseId, catNum, groupIdx } = useParams();
  const [searchParams] = useSearchParams();
  const [connectionInfo, setConnectionInfo] = useState(null);
  const [jitsiDomain, setJitsiDomain] = useState(null);
  const [error, setError] = useState(null);
  const [directLink, setDirectLink] = useState(null);
  const apiRef = useRef(null);
  const containerRef = useRef(null);
  const hasInitializedRef = useRef(false);

  const isCategory = catNum !== undefined && groupIdx !== undefined;

  // Load connection info and Jitsi domain
  useEffect(() => {
    let mounted = true;

    async function loadData() {
      try {
        // Get Jitsi domain from settings
        const domainRes = await apiClient.get('/settings/jitsi-domain');
        if (!mounted) return;
        const domain = domainRes.data.domain;
        if (!domain) {
          setError(t('video.jitsiNotAvailable'));
          return;
        }
        setJitsiDomain(domain);

        // Get connection info
        const infoUrl = isCategory
          ? `/courses/${courseId}/video/category/${catNum}/group/${groupIdx}/connection-info`
          : `/courses/${courseId}/video/connection-info`;

        const infoRes = await apiClient.get(infoUrl);
        if (!mounted) return;
        setConnectionInfo(infoRes.data);
      } catch (err) {
        if (!mounted) return;
        setError(err.response?.data?.message || t('video.noConnectionInfo'));
      }
    }

    loadData();
    return () => { mounted = false; };
  }, [courseId, catNum, groupIdx, isCategory, t]);

  // Initialize Jitsi API once we have domain and connection info
  useEffect(() => {
    if (!jitsiDomain || !connectionInfo || hasInitializedRef.current) return;
    if (!containerRef.current) return;

    hasInitializedRef.current = true;

    const options = connectionInfo.options || {};
    const apiOptions = connectionInfo.apiOptions || {};

    // Set audio/video muted in configOverwrite
    const configOverwrite = { ...(options.configOverwrite || {}) };
    if (apiOptions.startAudioMuted) configOverwrite.startWithAudioMuted = true;
    if (apiOptions.startVideoMuted) configOverwrite.startWithVideoMuted = true;

    const jitsiOptions = {
      roomName: options.roomName,
      parentNode: containerRef.current,
      userInfo: options.userInfo || {},
      configOverwrite,
      interfaceConfigOverwrite: options.interfaceConfigOverwrite || {},
    };

    // Load the Jitsi external API script dynamically
    const scriptId = 'jitsi-external-api-script';
    let script = document.getElementById(scriptId);

    const initializeApi = () => {
      if (typeof window.JitsiMeetExternalAPI !== 'function') {
        setError('JitsiMeetExternalAPI not available');
        return;
      }

      try {
        const api = new window.JitsiMeetExternalAPI(jitsiDomain, jitsiOptions);
        apiRef.current = api;

        const link = `https://${jitsiDomain}/${options.roomName}`;
        setDirectLink(link);

        // Join/leave tracking callbacks
        const joinCall = () => {
          const joinUrl = isCategory
            ? `/courses/${courseId}/video/category/${catNum}/group/${groupIdx}/join`
            : `/courses/${courseId}/video/join`;
          apiClient.post(joinUrl).catch(() => {});
        };

        const leaveCall = () => {
          const leaveUrl = isCategory
            ? `/courses/${courseId}/video/category/${catNum}/group/${groupIdx}/leave`
            : `/courses/${courseId}/video/leave`;
          apiClient.post(leaveUrl).catch(() => {});
        };

        const closeWindow = () => {
          leaveCall();
          if (apiRef.current) {
            apiRef.current.dispose();
            apiRef.current = null;
          }
          window.close();
        };

        // Event listeners
        api.addListener('videoConferenceJoined', joinCall);
        api.addListener('videoConferenceLeft', leaveCall);
        api.addListener('videoConferenceLeft', closeWindow);
        window.addEventListener('beforeunload', leaveCall);

        // Set subject title
        if (apiOptions.subjectTitle) {
          api.executeCommand('subject', apiOptions.subjectTitle);
        }

        // Audio mute on join
        if (apiOptions.startAudioMuted) {
          api.isAudioMuted().then((muted) => {
            if (!muted) api.executeCommand('toggleAudio');
          });
        }

        // Video mute on join
        if (apiOptions.startVideoMuted) {
          api.isVideoMuted().then((muted) => {
            if (!muted) api.executeCommand('toggleVideo');
          });
        }

        // Tile view management
        if (apiOptions.startTileView) {
          api.addListener('videoConferenceJoined', () => {
            const listener = ({ enabled }) => {
              if (!enabled) api.executeCommand('toggleTileView');
              api.removeListener('tileViewChanged', listener);
            };
            api.addListener('tileViewChanged', listener);
            api.executeCommand('toggleTileView');
          });
        } else if (apiOptions.startTileView === false) {
          api.addListener('videoConferenceJoined', () => {
            const listener = ({ enabled }) => {
              if (enabled) api.executeCommand('toggleTileView');
              api.removeListener('tileViewChanged', listener);
            };
            api.addListener('tileViewChanged', listener);
            api.executeCommand('toggleTileView');
          });
        }
      } catch (err) {
        setError(`Failed to initialize Jitsi: ${err.message}`);
      }
    };

    if (!script) {
      script = document.createElement('script');
      script.id = scriptId;
      script.src = `https://${jitsiDomain}/external_api.js`;
      script.async = true;
      script.onload = initializeApi;
      script.onerror = () => setError('Failed to load Jitsi API script');
      document.head.appendChild(script);
    } else if (typeof window.JitsiMeetExternalAPI === 'function') {
      initializeApi();
    } else {
      script.addEventListener('load', initializeApi);
    }

    return () => {
      // Cleanup only on unmount
    };
  }, [jitsiDomain, connectionInfo, courseId, catNum, groupIdx, isCategory]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (apiRef.current) {
        try { apiRef.current.dispose(); } catch { /* ignore */ }
        apiRef.current = null;
      }
    };
  }, []);

  // ── Help button handler (students in group chats) ─────────────────────────
  const handleToggleHelp = async () => {
    if (!isCategory) return;
    try {
      await apiClient.post(`/courses/${courseId}/video/category/${catNum}/group/${groupIdx}/toggle-help`);
    } catch (err) {
      // Silently fail — instructor-only errors are expected
    }
  };

  // ── Clear room handler (instructor only) ──────────────────────────────────
  const handleClearRoom = async () => {
    if (isCategory) {
      await apiClient.post(`/courses/${courseId}/video/category/${catNum}/group/${groupIdx}/clear`).catch(() => {});
    } else {
      await apiClient.post(`/courses/${courseId}/video/clear`).catch(() => {});
    }
  };

  if (error) {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <Typography color="error">{error}</Typography>
      </Box>
    );
  }

  if (!connectionInfo || !jitsiDomain) {
    return (
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <CircularProgress />
        <Typography sx={{ mt: 1 }}>{t('common.loading')}</Typography>
      </Box>
    );
  }

  const isInstructor = connectionInfo.isInstructor;
  const isStudentInGroupChat = isCategory && !isInstructor;
  const helpActive = connectionInfo.helpVideoChat;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100vh' }}>
      {/* Jitsi container */}
      <Box ref={containerRef} sx={{ flex: 1, width: '100%' }} />

      {/* Toolbar */}
      <Box sx={{
        p: 0.75,
        minHeight: 40,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        bgcolor: '#e8e8e8',
        flexWrap: 'wrap',
      }}>
        {directLink && (
          <Typography variant="caption">
            {t('video.directLink')}{' '}
            <Link href={directLink} target="_blank" rel="noopener noreferrer">{directLink}</Link>
          </Typography>
        )}

        {isStudentInGroupChat && (
          <Button
            size="small"
            variant={helpActive ? 'contained' : 'outlined'}
            color="warning"
            onClick={handleToggleHelp}
            sx={helpActive ? {
              animation: 'pulse 1.5s infinite',
              '@keyframes pulse': {
                '0%': { opacity: 1 },
                '50%': { opacity: 0.6 },
                '100%': { opacity: 1 },
              },
            } : undefined}
          >
            {helpActive ? t('video.callingInstructor') : t('video.callInstructor')}
          </Button>
        )}

        {isInstructor && (
          <Button size="small" variant="outlined" onClick={handleClearRoom}>
            {t('video.clearRoom')}
          </Button>
        )}
      </Box>
    </Box>
  );
}
