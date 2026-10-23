import { useState, useEffect, useCallback } from 'react';
import {
  Box, Typography, Paper, Button, Switch, FormControlLabel, Divider,
  List, ListItem, ListItemText, Chip, Tooltip, Alert, Snackbar,
  CircularProgress,
} from '@mui/material';
import {
  Videocam as VideocamIcon,
  VideocamOff as VideocamOffIcon,
  CleaningServices as ClearIcon,
  NotificationsActive as HelpIcon,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';

export default function VideoChatPanel({ courseId, course, isInstructor, isStudent, onCourseRefresh }) {
  const { t } = useTranslation();
  const [msg, setMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  const videoChatOptions = course?.videoChatOptions;
  const courseVideoEnabled = !!(videoChatOptions && videoChatOptions.urlId);
  const apiOptions = courseVideoEnabled ? (videoChatOptions.apiOptions || {}) : {};
  const joinedCount = courseVideoEnabled ? (videoChatOptions.joined || []).length : 0;
  const groupCategories = course?.groupCategories || [];
  const categoriesWithChat = groupCategories.filter((cat) => cat.catVideoChatOptions && cat.catVideoChatOptions.urlId);

  // ── Course-wide video toggle ──────────────────────────────────────────────
  const handleToggleCourseVideo = async () => {
    const question = courseVideoEnabled ? t('video.disableConfirm') : t('video.enableConfirm');
    if (!window.confirm(question)) return;

    try {
      await apiClient.post(`/courses/${courseId}/video/toggle`);
      const successMsg = courseVideoEnabled ? t('video.chatDisabled') : t('video.chatEnabled');
      setMsg({ severity: 'success', text: successMsg });
      onCourseRefresh?.();
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || 'Error' });
    }
  };

  // ── Course-wide API options toggles ───────────────────────────────────────
  const patchCourseApiOption = async (option, value) => {
    if (!courseVideoEnabled) {
      setMsg({ severity: 'error', text: t('video.errorNoVideoOptions') });
      return;
    }
    try {
      await apiClient.patch(`/courses/${courseId}/video/api-options`, { [option]: value });
      setMsg({ severity: 'success', text: t('video.updated') });
      onCourseRefresh?.();
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || 'Error' });
    }
  };

  // ── Clear course-wide participants ────────────────────────────────────────
  const handleClearCourseParticipants = async () => {
    try {
      await apiClient.post(`/courses/${courseId}/video/clear`);
      setMsg({ severity: 'success', text: t('video.roomCountersCleared') });
      onCourseRefresh?.();
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || 'Error' });
    }
  };

  // ── Category video toggle ─────────────────────────────────────────────────
  const handleToggleCategoryVideo = async (catNum, catEnabled) => {
    const question = catEnabled ? t('video.disableCategoryConfirm') : t('video.enableCategoryConfirm');
    if (!window.confirm(question)) return;

    try {
      await apiClient.post(`/courses/${courseId}/video/category/${catNum}/toggle`);
      const successMsg = catEnabled ? t('video.chatDisabled') : t('video.chatEnabled');
      setMsg({ severity: 'success', text: successMsg });
      onCourseRefresh?.();
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || 'Error' });
    }
  };

  // ── Category API options ──────────────────────────────────────────────────
  const patchCategoryApiOption = async (catNum, option, value) => {
    try {
      await apiClient.patch(`/courses/${courseId}/video/category/${catNum}/api-options`, { [option]: value });
      setMsg({ severity: 'success', text: t('video.updated') });
      onCourseRefresh?.();
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || 'Error' });
    }
  };

  // ── Clear category rooms ──────────────────────────────────────────────────
  const handleClearCategoryRooms = async (catNum) => {
    try {
      await apiClient.post(`/courses/${courseId}/video/category/${catNum}/clear`);
      setMsg({ severity: 'success', text: t('video.roomCountersCleared') });
      onCourseRefresh?.();
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || 'Error' });
    }
  };

  // ── Clear individual group room ───────────────────────────────────────────
  const handleClearGroupRoom = async (catNum, groupIdx) => {
    try {
      await apiClient.post(`/courses/${courseId}/video/category/${catNum}/group/${groupIdx}/clear`);
      setMsg({ severity: 'success', text: t('video.roomCleared') });
      onCourseRefresh?.();
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || 'Error' });
    }
  };

  // ── Open course-wide video chat ───────────────────────────────────────────
  const openCourseChat = () => {
    window.open(
      `/video/${courseId}`,
      'Qlicker Video Chat',
      'height=768,width=1024'
    );
  };

  // ── Open category group chat ──────────────────────────────────────────────
  const openGroupChat = (catNum, groupIdx) => {
    window.open(
      `/video/${courseId}/category/${catNum}/group/${groupIdx}`,
      `Video chat`,
      'height=768,width=1024'
    );
  };

  // ── Resolve student names for joined lists (instructor only) ──────────────
  const getJoinedNames = (joinedIds) => {
    if (!isInstructor || !joinedIds || joinedIds.length === 0) return '';
    const students = course?.students || [];
    return joinedIds.map((id) => {
      const s = students.find?.((st) => (st._id || st) === id);
      if (s && s.profile) return `${s.profile.lastname || ''}, ${s.profile.firstname || ''}`.trim();
      return id;
    }).join('; ');
  };

  return (
    <Box>
      {/* ── Instructor Controls ─────────────────────────────────────────── */}
      {isInstructor && (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5 }}>
            {t('video.enableDisable')}
          </Typography>

          {/* Course-wide video */}
          <List disablePadding>
            <ListItem sx={{ px: 0, flexWrap: 'wrap', gap: 1 }}>
              <ListItemText
                primary={t('video.courseWideVideoChat')}
              />
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <FormControlLabel
                  control={<Switch checked={courseVideoEnabled} onChange={handleToggleCourseVideo} size="small" />}
                  label={t('video.enabled')}
                />
                {courseVideoEnabled && (
                  <>
                    <FormControlLabel
                      control={<Switch checked={!!apiOptions.startVideoMuted} onChange={() => patchCourseApiOption('startVideoMuted', !apiOptions.startVideoMuted)} size="small" />}
                      label={t('video.muteVideo')}
                    />
                    <FormControlLabel
                      control={<Switch checked={!!apiOptions.startAudioMuted} onChange={() => patchCourseApiOption('startAudioMuted', !apiOptions.startAudioMuted)} size="small" />}
                      label={t('video.muteAudio')}
                    />
                    <FormControlLabel
                      control={<Switch checked={!!apiOptions.startTileView} onChange={() => patchCourseApiOption('startTileView', !apiOptions.startTileView)} size="small" />}
                      label={t('video.tileView')}
                    />
                    <Button size="small" variant="outlined" startIcon={<ClearIcon />} onClick={handleClearCourseParticipants}>
                      {t('video.clearParticipants')}
                    </Button>
                  </>
                )}
              </Box>
            </ListItem>
          </List>

          {groupCategories.length > 0 ? (
            <>
              <Divider sx={{ my: 1.5 }} />
              <List disablePadding>
                {groupCategories.map((cat) => {
                  const catEnabled = !!(cat.catVideoChatOptions && cat.catVideoChatOptions.urlId);
                  const catApiOpts = catEnabled ? (cat.catVideoChatOptions.apiOptions || {}) : {};
                  return (
                    <ListItem key={cat.categoryNumber} sx={{ px: 0, flexWrap: 'wrap', gap: 1 }}>
                      <ListItemText
                        primary={`${cat.categoryName} (${t('video.groupCount', { count: (cat.groups || []).length })})`}
                      />
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <FormControlLabel
                          control={<Switch checked={catEnabled} onChange={() => handleToggleCategoryVideo(cat.categoryNumber, catEnabled)} size="small" />}
                          label={t('video.enabled')}
                        />
                        {catEnabled && (
                          <>
                            <FormControlLabel
                              control={<Switch checked={!!catApiOpts.startVideoMuted} onChange={() => patchCategoryApiOption(cat.categoryNumber, 'startVideoMuted', !catApiOpts.startVideoMuted)} size="small" />}
                              label={t('video.muteVideo')}
                            />
                            <FormControlLabel
                              control={<Switch checked={!!catApiOpts.startAudioMuted} onChange={() => patchCategoryApiOption(cat.categoryNumber, 'startAudioMuted', !catApiOpts.startAudioMuted)} size="small" />}
                              label={t('video.muteAudio')}
                            />
                            <FormControlLabel
                              control={<Switch checked={!!catApiOpts.startTileView} onChange={() => patchCategoryApiOption(cat.categoryNumber, 'startTileView', !catApiOpts.startTileView)} size="small" />}
                              label={t('video.tileView')}
                            />
                            <Button size="small" variant="outlined" startIcon={<ClearIcon />} onClick={() => handleClearCategoryRooms(cat.categoryNumber)}>
                              {t('video.clearParticipants')}
                            </Button>
                          </>
                        )}
                      </Box>
                    </ListItem>
                  );
                })}
              </List>
            </>
          ) : (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                mt: 1
              }}>
              {t('video.createGroupsFirst')}
            </Typography>
          )}
        </Paper>
      )}

      {/* ── Join Chat Rooms ─────────────────────────────────────────────── */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5 }}>
          {t('video.joinChatRooms')}
        </Typography>

        {courseVideoEnabled ? (
          <Box sx={{ mb: 2 }}>
            <Typography variant="body2" sx={{ mb: 1, fontWeight: 500 }}>
              {t('video.courseWideVideoChat')}
            </Typography>
            <Tooltip title={isInstructor && joinedCount > 0 ? getJoinedNames(videoChatOptions.joined) : ''}>
              <Button
                variant="contained"
                startIcon={<VideocamIcon />}
                onClick={openCourseChat}
              >
                {t('video.joinCourseChat', { count: joinedCount })}
              </Button>
            </Tooltip>
          </Box>
        ) : categoriesWithChat.length === 0 ? (
          <Typography variant="body2" sx={{
            color: "text.secondary"
          }}>
            {t('video.noVideoChatsEnabled')}
          </Typography>
        ) : null}

        {categoriesWithChat.map((cat) => (
          <Box key={`cat-${cat.categoryNumber}`} sx={{ mb: 2 }}>
            <Typography variant="body2" sx={{ mb: 1, fontWeight: 500 }}>
              {cat.categoryName}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {(cat.groups || []).map((group, groupIdx) => {
                const nParticipants = (group.joinedVideoChat || []).length;
                const hasHelp = isInstructor && group.helpVideoChat;

                // Students can only join their own groups
                const canJoin = isInstructor || (group.members || []).includes(course?.currentUserId);

                return (
                  <Tooltip
                    key={`grp-${cat.categoryNumber}-${groupIdx}`}
                    title={isInstructor && nParticipants > 0 ? getJoinedNames(group.joinedVideoChat) : ''}
                  >
                    <Button
                      variant={nParticipants > 0 ? 'contained' : 'outlined'}
                      color={hasHelp ? 'warning' : 'primary'}
                      startIcon={nParticipants > 0 ? <VideocamIcon /> : <VideocamOffIcon />}
                      onClick={() => openGroupChat(cat.categoryNumber, groupIdx)}
                      disabled={!isInstructor && !canJoin}
                      sx={hasHelp ? {
                        animation: 'pulse 1.5s infinite',
                        '@keyframes pulse': {
                          '0%': { opacity: 1 },
                          '50%': { opacity: 0.6 },
                          '100%': { opacity: 1 },
                        },
                      } : undefined}
                    >
                      {t('video.joinGroupChat', { name: group.name || `Group ${groupIdx + 1}`, count: nParticipants })}
                      {hasHelp && <HelpIcon sx={{ ml: 0.5 }} fontSize="small" />}
                    </Button>
                  </Tooltip>
                );
              })}
            </Box>
          </Box>
        ))}
      </Paper>

      <Snackbar open={!!msg} autoHideDuration={3000} onClose={() => setMsg(null)}>
        {msg ? <Alert severity={msg.severity} onClose={() => setMsg(null)}>{msg.text}</Alert> : undefined}
      </Snackbar>
    </Box>
  );
}
