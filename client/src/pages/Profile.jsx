import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import {
  PhotoCamera as PhotoCameraIcon,
  RotateLeft as RotateLeftIcon,
  RotateRight as RotateRightIcon,
} from '@mui/icons-material';
import { useTranslation } from 'react-i18next';
import i18n, { SUPPORTED_LOCALES } from '../i18n';
import { useAuth } from '../contexts/AuthContext';
import apiClient from '../api/client';
import AutoSaveStatus from '../components/common/AutoSaveStatus';
import {
  clampAvatarCrop,
  createAvatarThumbnailFile,
  createCenteredAvatarCrop,
  getAvatarPreviewLayout,
  loadImage,
  prepareImageFileForUpload,
  readFileAsDataUrl,
  withTimeout,
  IMAGE_PREPARE_TIMEOUT_MS,
  IMAGE_UPLOAD_TIMEOUT_MS,
} from '../utils/imageUpload';
import {
  getDefaultAvatarThumbnailSize,
  getDefaultMaxImageWidth,
  getPublicSettings,
} from '../utils/publicSettings';

const AUTO_SAVE_DELAY_MS = 600;
const PROFILE_IMAGE_PREVIEW_SIZE = 320;

function normalizeProfile(source = {}) {
  return {
    firstname: source.firstname ?? '',
    lastname: source.lastname ?? '',
    studentNumber: source.studentNumber ?? '',
  };
}

function diffProfile(previousProfile, nextProfile) {
  const patchPayload = {};
  if (previousProfile.firstname !== nextProfile.firstname) patchPayload.firstname = nextProfile.firstname;
  if (previousProfile.lastname !== nextProfile.lastname) patchPayload.lastname = nextProfile.lastname;
  if (previousProfile.studentNumber !== nextProfile.studentNumber) patchPayload.studentNumber = nextProfile.studentNumber;
  return patchPayload;
}

function buildThumbnailFileName(originalName = '') {
  const baseName = String(originalName || 'profile-image').replace(/\.[^.]+$/, '') || 'profile-image';
  return `${baseName}-thumbnail.jpg`;
}

function buildImageFileNameFromUrl(sourceUrl = '') {
  const rawUrl = String(sourceUrl || '').trim();
  if (!rawUrl) return 'profile-image';

  try {
    const parsed = rawUrl.startsWith('/')
      ? new URL(rawUrl, window.location.origin)
      : new URL(rawUrl);
    const pathname = String(parsed.pathname || '');
    const segments = pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || 'profile-image';
  } catch {
    const stripped = rawUrl.split('?')[0].split('#')[0];
    const segments = stripped.split('/').filter(Boolean);
    return segments[segments.length - 1] || 'profile-image';
  }
}

function buildRoundedCropPayload(editorState = {}) {
  return {
    rotation: Math.round(editorState.rotation || 0),
    cropX: Math.round(editorState.cropX || 0),
    cropY: Math.round(editorState.cropY || 0),
    cropSize: Math.max(1, Math.round(editorState.cropSize || 0)),
  };
}

function shouldFallbackToServerThumbnailGeneration(error) {
  if (!error) return false;
  const name = String(error.name || '');
  const message = String(error.message || '');
  return (name === 'SecurityError'
  || /tainted/i.test(message)
  || /Failed to (decode|encode|prepare) image/i.test(message) || /Failed to prepare avatar/i.test(message));
}

function isDataUrl(value = '') {
  return /^data:/i.test(String(value || '').trim());
}

function isBlobUrl(value = '') {
  return /^blob:/i.test(String(value || '').trim());
}

function dataUrlToBlob(sourceUrl) {
  const normalizedUrl = String(sourceUrl || '').trim();
  const commaIndex = normalizedUrl.indexOf(',');
  if (commaIndex < 0) {
    throw new Error('Invalid data URL');
  }

  const header = normalizedUrl.slice(0, commaIndex);
  const payload = normalizedUrl.slice(commaIndex + 1);
  const mimeMatch = header.match(/^data:([^;,]+)/i);
  const mimeType = mimeMatch?.[1] || 'application/octet-stream';

  if (/;base64/i.test(header)) {
    const binary = window.atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  }

  return new Blob([decodeURIComponent(payload)], { type: mimeType });
}

async function loadExistingImageAsDataUrl(sourceUrl) {
  const normalizedUrl = String(sourceUrl || '').trim();
  const blob = isDataUrl(normalizedUrl)
    ? dataUrlToBlob(normalizedUrl)
    : await (async () => {
        const response = await fetch(normalizedUrl, isBlobUrl(normalizedUrl)
          ? undefined
          : { credentials: 'include' });
        if (!response.ok) {
          throw new Error(`Failed to load existing profile image: ${response.status}`);
        }
        return response.blob();
      })();

  const file = new File(
    [blob],
    buildImageFileNameFromUrl(sourceUrl),
    {
      type: blob.type || 'image/jpeg',
      lastModified: Date.now(),
    },
  );
  const dataUrl = await readFileAsDataUrl(file);
  return {
    file,
    source: dataUrl,
  };
}

function ProfileImageEditorDialog({
  open,
  editorState,
  busy,
  onClose,
  onRotate,
  onMoveCrop,
  onSave,
  t,
}) {
  const dragStateRef = useRef(null);

  useEffect(() => {
    if (!open) {
      dragStateRef.current = null;
    }
  }, [open]);

  useEffect(() => () => {
    dragStateRef.current = null;
  }, []);

  const previewLayout = editorState
    ? getAvatarPreviewLayout({
      width: editorState.imageWidth,
      height: editorState.imageHeight,
      crop: editorState,
      viewportSize: PROFILE_IMAGE_PREVIEW_SIZE,
    })
    : null;

  const handlePointerMove = useCallback((event) => {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    onMoveCrop({
      cropX: dragState.cropX - ((event.clientX - dragState.clientX) / dragState.scale),
      cropY: dragState.cropY - ((event.clientY - dragState.clientY) / dragState.scale),
    });
  }, [onMoveCrop]);

  const handlePointerUp = useCallback(() => {
    dragStateRef.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  }, [handlePointerMove]);

  useEffect(() => () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  }, [handlePointerMove, handlePointerUp]);

  const handlePointerDown = (event) => {
    if (!previewLayout || busy) return;
    dragStateRef.current = {
      clientX: event.clientX,
      clientY: event.clientY,
      cropX: previewLayout.crop.cropX,
      cropY: previewLayout.crop.cropY,
      scale: PROFILE_IMAGE_PREVIEW_SIZE / previewLayout.crop.cropSize,
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t('profile.adjustPhoto')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '12px !important' }}>
        <Typography variant="body2" sx={{
          color: "text.secondary"
        }}>
          {t('profile.photoCropHelp')}
        </Typography>
        {previewLayout ? (
          <Box
            sx={{
              width: PROFILE_IMAGE_PREVIEW_SIZE,
              height: PROFILE_IMAGE_PREVIEW_SIZE,
              maxWidth: '100%',
              alignSelf: 'center',
              position: 'relative',
              overflow: 'hidden',
              borderRadius: 3,
              bgcolor: 'grey.100',
              border: '1px solid',
              borderColor: 'divider',
              cursor: busy ? 'default' : 'grab',
              touchAction: 'none',
            }}
            onPointerDown={handlePointerDown}
          >
            <Box
              sx={{
                position: 'absolute',
                left: `${previewLayout.offsetX}px`,
                top: `${previewLayout.offsetY}px`,
                width: `${previewLayout.wrapperWidth}px`,
                height: `${previewLayout.wrapperHeight}px`,
              }}
            >
              <Box
                component="img"
                src={editorState.source}
                alt={t('profile.profileImagePreview')}
                draggable={false}
                sx={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: `${previewLayout.imageWidth}px`,
                  height: `${previewLayout.imageHeight}px`,
                  maxWidth: 'none',
                  userSelect: 'none',
                  transformOrigin: 'top left',
                  transform: previewLayout.transform,
                }}
              />
            </Box>
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                borderRadius: '50%',
                boxShadow: '0 0 0 999px rgba(15, 23, 42, 0.45)',
                border: '2px solid',
                borderColor: 'common.white',
                pointerEvents: 'none',
              }}
            />
          </Box>
        ) : (
          <CircularProgress sx={{ alignSelf: 'center', my: 2 }} />
        )}
        <Box sx={{ display: 'flex', justifyContent: 'center', gap: 1 }}>
          <IconButton onClick={() => onRotate(-90)} disabled={busy || !editorState} aria-label={t('profile.rotateLeft')}>
            <RotateLeftIcon />
          </IconButton>
          <IconButton onClick={() => onRotate(90)} disabled={busy || !editorState} aria-label={t('profile.rotateRight')}>
            <RotateRightIcon />
          </IconButton>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
        <Button variant="contained" onClick={onSave} disabled={busy || !editorState}>
          {busy ? t('common.saving') : t('common.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function Profile() {
  const { t } = useTranslation();
  const { user, loadUser, setCurrentUser } = useAuth();
  const [profile, setProfile] = useState({ firstname: '', lastname: '', studentNumber: '' });
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState(null);
  const [pwMsg, setPwMsg] = useState(null);
  const [profileSaveStatus, setProfileSaveStatus] = useState('idle');
  const [profileSaveError, setProfileSaveError] = useState('');
  const [changingPw, setChangingPw] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [userLocale, setUserLocale] = useState('');
  const [publicSettings, setPublicSettings] = useState({
    SSO_enabled: false,
    maxImageWidth: getDefaultMaxImageWidth(),
    avatarThumbnailSize: getDefaultAvatarThumbnailSize(),
  });
  const [imageEditorState, setImageEditorState] = useState(null);
  const fileInputRef = useRef(null);
  const profileHydratedRef = useRef(false);
  const profileSaveInFlightRef = useRef(false);
  const queuedProfileRef = useRef(null);
  const lastSavedProfileRef = useRef(normalizeProfile());

  const isStaff = user?.profile?.roles?.some((r) => r === 'admin' || r === 'professor');
  const numberLabel = isStaff ? t('profile.employeeNumber') : t('profile.studentNumber');
  const localEmailLoginAllowed = !!user?.allowEmailLogin;
  const ssoManaged = publicSettings.SSO_enabled && !localEmailLoginAllowed;
  const nameLocked = ssoManaged;
  const passwordLocked = ssoManaged;
  const initials = `${user?.profile?.firstname?.[0] ?? ''}${user?.profile?.lastname?.[0] ?? ''}`.toUpperCase();
  const emailAddress = user?.emails?.[0]?.address || user?.email || '';
  const primaryRole = user?.profile?.roles?.[0] || user?.role || '';

  useEffect(() => {
    if (!user || profileHydratedRef.current) return;

    const fallbackProfile = normalizeProfile(user.profile);
    setProfile(fallbackProfile);
    lastSavedProfileRef.current = fallbackProfile;
    profileHydratedRef.current = true;

    const fallbackLocale = user.locale || '';
    setUserLocale(fallbackLocale);
    if (fallbackLocale) {
      i18n.changeLanguage(fallbackLocale);
      localStorage.setItem('qlicker_locale', fallbackLocale);
    }

    setLoading(false);
  }, [user]);

  useEffect(() => {
    let active = true;

    apiClient.get('/users/me')
      .then((userResponse) => {
        if (!active) return;
        const loadedUser = userResponse.data.user || userResponse.data;
        const normalizedProfile = normalizeProfile(loadedUser.profile);
        setProfile(normalizedProfile);
        lastSavedProfileRef.current = normalizedProfile;
        profileHydratedRef.current = true;

        const savedLocale = loadedUser.locale || '';
        setUserLocale(savedLocale);
        if (savedLocale) {
          i18n.changeLanguage(savedLocale);
          localStorage.setItem('qlicker_locale', savedLocale);
        }
      })
      .catch(() => {
        if (active) {
          setMsg({ severity: 'error', text: t('profile.profileFailed') });
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    getPublicSettings()
      .then((settings) => {
        if (active) {
          setPublicSettings(settings);
        }
      })
      .catch(() => {
        if (active) {
          setPublicSettings({
            SSO_enabled: false,
            maxImageWidth: getDefaultMaxImageWidth(),
            avatarThumbnailSize: getDefaultAvatarThumbnailSize(),
          });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => () => {
    profileHydratedRef.current = false;
    profileSaveInFlightRef.current = false;
    queuedProfileRef.current = null;
  }, []);

  const persistProfile = useCallback(async (nextProfile) => {
    const runSave = async (pendingProfile) => {
      if (profileSaveInFlightRef.current) {
        queuedProfileRef.current = pendingProfile;
        return;
      }

      const patchPayload = diffProfile(lastSavedProfileRef.current, pendingProfile);
      if (Object.keys(patchPayload).length === 0) {
        setProfileSaveStatus('success');
        return;
      }

      profileSaveInFlightRef.current = true;
      setProfileSaveStatus('saving');
      setProfileSaveError('');
      const requestedHash = JSON.stringify(pendingProfile);

      try {
        const { data } = await apiClient.patch('/users/me', patchPayload);
        const savedProfile = normalizeProfile(data?.profile);

        lastSavedProfileRef.current = savedProfile;
        setProfile((currentProfile) => (
          JSON.stringify(currentProfile) === requestedHash ? savedProfile : currentProfile
        ));
        setProfileSaveStatus('success');
        await loadUser();
      } catch (err) {
        setProfileSaveStatus('error');
        const message = err.response?.data?.message || t('profile.profileFailed');
        setProfileSaveError(`${message} ${t('profile.lastChangeNotRecorded')}`);
      } finally {
        profileSaveInFlightRef.current = false;

        if (queuedProfileRef.current) {
          const queuedProfile = queuedProfileRef.current;
          queuedProfileRef.current = null;
          const queuedPatch = diffProfile(lastSavedProfileRef.current, queuedProfile);
          if (Object.keys(queuedPatch).length > 0) {
            await runSave(queuedProfile);
          }
        }
      }
    };

    await runSave(nextProfile);
  }, [loadUser, t]);

  useEffect(() => {
    if (loading) return;
    if (!profileHydratedRef.current) return;

    const pendingChanges = diffProfile(lastSavedProfileRef.current, profile);
    if (Object.keys(pendingChanges).length === 0) return;

    const saveTimer = setTimeout(() => {
      persistProfile(profile);
    }, AUTO_SAVE_DELAY_MS);

    return () => clearTimeout(saveTimer);
  }, [profile, loading, persistProfile]);

  const handleChangePassword = async () => {
    setPwMsg(null);
    if (passwords.newPassword !== passwords.confirmPassword) {
      setPwMsg({ severity: 'error', text: t('profile.passwordsNoMatch') });
      return;
    }
    if (passwords.newPassword.length < 6) {
      setPwMsg({ severity: 'error', text: t('profile.passwordTooShort') });
      return;
    }
    setChangingPw(true);
    try {
      await apiClient.patch('/users/me/password', {
        currentPassword: passwords.currentPassword,
        newPassword: passwords.newPassword,
      });
      setPasswords({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setPwMsg({ severity: 'success', text: t('profile.passwordChanged') });
    } catch (err) {
      setPwMsg({ severity: 'error', text: err.response?.data?.message || t('profile.failedChangePassword') });
    } finally {
      setChangingPw(false);
    }
  };

  const prepareEditorState = useCallback(async ({
    source,
    file = null,
    fileName = '',
    isNewUpload = false,
  }) => {
    const image = await loadImage(source);
    const initialCrop = createCenteredAvatarCrop(image.naturalWidth || 1, image.naturalHeight || 1, 0);
    setImageEditorState({
      source,
      file,
      fileName,
      isNewUpload,
      imageWidth: image.naturalWidth || 1,
      imageHeight: image.naturalHeight || 1,
      ...initialCrop,
    });
  }, []);

  const handleImageUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setImageBusy(true);
    setMsg(null);
    try {
      const normalizedUpload = await prepareImageFileForUpload(file, {
        maxWidth: publicSettings.maxImageWidth,
      });
      const source = await withTimeout(
        readFileAsDataUrl(normalizedUpload.file),
        IMAGE_PREPARE_TIMEOUT_MS,
        'Timed out reading the selected image',
      );
      await prepareEditorState({
        source,
        file: normalizedUpload.file,
        fileName: normalizedUpload.file.name || file.name,
        isNewUpload: true,
      });
    } catch {
      setMsg({ severity: 'error', text: t('profile.photoFailed') });
    } finally {
      setImageBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openExistingImageEditor = async () => {
    if (!user?.profile?.profileImage) return;
    setImageBusy(true);
    setMsg(null);
    try {
      let source = user.profile.profileImage;
      let fileName = user.profile.profileImage;
      try {
        const existingImage = await loadExistingImageAsDataUrl(user.profile.profileImage);
        source = existingImage.source;
        fileName = existingImage.file.name;
      } catch {
        // Fall back to the URL source. Save will use the server-side recrop path if needed.
      }
      await prepareEditorState({
        source,
        fileName,
        isNewUpload: false,
      });
    } catch {
      setMsg({ severity: 'error', text: t('profile.photoFailed') });
    } finally {
      setImageBusy(false);
    }
  };

  const closeImageEditor = () => {
    if (imageBusy) return;
    setImageEditorState(null);
  };

  const rotateImageEditor = (delta) => {
    setImageEditorState((current) => {
      if (!current) return current;
      return {
        ...current,
        ...createCenteredAvatarCrop(
          current.imageWidth,
          current.imageHeight,
          current.rotation + delta,
        ),
      };
    });
  };

  const moveImageEditorCrop = useCallback((nextCrop) => {
    setImageEditorState((current) => {
      if (!current) return current;
      return {
        ...current,
        ...clampAvatarCrop(
          { ...current, ...nextCrop },
          current.imageWidth,
          current.imageHeight,
        ),
      };
    });
  }, []);

  const uploadSingleImage = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const { data } = await apiClient.post('/images', formData, { timeout: IMAGE_UPLOAD_TIMEOUT_MS });
    return data?.image?.url || '';
  };

  const saveImageEditor = async () => {
    if (!imageEditorState) return;
    setImageBusy(true);
    setMsg(null);
    try {
      let updatedUser = null;
      if (imageEditorState.isNewUpload && imageEditorState.file) {
        const profileImageUrl = await uploadSingleImage(imageEditorState.file);

        let thumbnailFile;
        try {
          thumbnailFile = await createAvatarThumbnailFile(
            imageEditorState.source,
            imageEditorState,
            {
              fileName: buildThumbnailFileName(imageEditorState.fileName),
              outputSize: publicSettings.avatarThumbnailSize,
            },
          );
        } catch (thumbErr) {
          if (!shouldFallbackToServerThumbnailGeneration(thumbErr)) {
            throw thumbErr;
          }
        }

        if (thumbnailFile) {
          const profileThumbnailUrl = await uploadSingleImage(thumbnailFile);
          const { data } = await apiClient.patch('/users/me/image', {
            profileImage: profileImageUrl,
            profileThumbnail: profileThumbnailUrl,
          });
          updatedUser = data;
        } else {
          await apiClient.patch('/users/me/image', {
            profileImage: profileImageUrl,
            profileThumbnail: profileImageUrl,
          });
          const { data } = await apiClient.post('/users/me/image/thumbnail', buildRoundedCropPayload(imageEditorState));
          updatedUser = data;
        }
      } else {
        let thumbnailFile;
        try {
          thumbnailFile = await createAvatarThumbnailFile(
            imageEditorState.source,
            imageEditorState,
            {
              fileName: buildThumbnailFileName(imageEditorState.fileName),
              outputSize: publicSettings.avatarThumbnailSize,
            },
          );
        } catch (thumbErr) {
          if (!shouldFallbackToServerThumbnailGeneration(thumbErr)) {
            throw thumbErr;
          }
        }

        if (thumbnailFile) {
          const profileThumbnailUrl = await uploadSingleImage(thumbnailFile);
          const { data } = await apiClient.patch('/users/me/image', {
            profileImage: user?.profile?.profileImage || imageEditorState.source,
            profileThumbnail: profileThumbnailUrl,
          });
          updatedUser = data;
        } else {
          const { data } = await apiClient.post('/users/me/image/thumbnail', buildRoundedCropPayload(imageEditorState));
          updatedUser = data;
        }
      }

      if (updatedUser) {
        setCurrentUser(updatedUser);
      } else {
        await loadUser();
      }
      setImageEditorState(null);
      setMsg({ severity: 'success', text: t('profile.photoUpdated') });
    } catch (err) {
      setMsg({ severity: 'error', text: err.response?.data?.message || t('profile.photoFailed') });
    } finally {
      setImageBusy(false);
    }
  };

  const handleLocaleChange = async (event) => {
    const newLocale = event.target.value;
    setUserLocale(newLocale);
    const effectiveLocale = newLocale || 'en';
    i18n.changeLanguage(effectiveLocale);
    localStorage.setItem('qlicker_locale', effectiveLocale);
    try {
      await apiClient.patch('/users/me', { locale: newLocale });
    } catch {
      // Best-effort; locale is also stored in localStorage.
    }
  };

  if (loading) {
    return (
      <Box sx={{ p: 3 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3, maxWidth: 600 }}>
      <Typography variant="h4" gutterBottom>{t('profile.title')}</Typography>
      <Typography variant="body2" gutterBottom sx={{
        color: "text.secondary"
      }}>
        {emailAddress} {primaryRole ? <>&middot; {primaryRole}</> : null}
      </Typography>

      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" gutterBottom>{t('profile.photo')}</Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            mb: 2
          }}>
          {t('profile.photoClickHelp')}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <Box
            component="button"
            type="button"
            onClick={openExistingImageEditor}
            disabled={!user?.profile?.profileImage || imageBusy}
            aria-label={t('profile.openPhotoEditor')}
            sx={{
              p: 0,
              border: 0,
              bgcolor: 'transparent',
              borderRadius: '50%',
              lineHeight: 0,
              cursor: user?.profile?.profileImage && !imageBusy ? 'pointer' : 'default',
            }}
          >
            <Avatar
              alt={emailAddress || t('profile.openPhotoEditor')}
              src={user?.profile?.profileThumbnail || user?.profile?.profileImage}
              slotProps={{
                img: {
                  alt: emailAddress || t('profile.openPhotoEditor'),
                },
              }}
              sx={{ width: 80, height: 80, fontSize: 32 }}
            >
              {initials}
            </Avatar>
          </Box>
          <Box>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={handleImageUpload}
            />
            <Button
              variant="outlined"
              startIcon={imageBusy ? <CircularProgress size={18} /> : <PhotoCameraIcon />}
              onClick={() => fileInputRef.current?.click()}
              disabled={imageBusy}
            >
              {imageBusy ? t('profile.uploading') : t('profile.uploadPhoto')}
            </Button>
          </Box>
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" gutterBottom>{t('profile.language')}</Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            mb: 2
          }}>
          {t('profile.languageHelp')}
        </Typography>
        <FormControl fullWidth>
          <InputLabel id="profile-locale-label">{t('profile.language')}</InputLabel>
          <Select
            labelId="profile-locale-label"
            value={userLocale}
            label={t('profile.language')}
            onChange={handleLocaleChange}
          >
            <MenuItem value="">{t('profile.useAppDefault')}</MenuItem>
            {SUPPORTED_LOCALES.map((loc) => (
              <MenuItem key={loc.code} value={loc.code}>{loc.label}</MenuItem>
            ))}
          </Select>
        </FormControl>
      </Paper>

      <Paper variant="outlined" sx={{ p: 3, mb: 3 }}>
        <Typography variant="h6" gutterBottom>{t('profile.personalInfo')}</Typography>
        <AutoSaveStatus status={profileSaveStatus} errorText={profileSaveError} />
        {nameLocked ? (
          <Alert severity="info" sx={{ mb: 2 }}>{t('profile.ssoNameManagedNote')}</Alert>
        ) : null}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label={t('profile.firstName')}
            value={profile.firstname}
            onChange={(event) => setProfile((current) => ({ ...current, firstname: event.target.value }))}
            fullWidth
            disabled={nameLocked}
          />
          <TextField
            label={t('profile.lastName')}
            value={profile.lastname}
            onChange={(event) => setProfile((current) => ({ ...current, lastname: event.target.value }))}
            fullWidth
            disabled={nameLocked}
          />
          <TextField
            label={numberLabel}
            value={profile.studentNumber}
            onChange={(event) => setProfile((current) => ({ ...current, studentNumber: event.target.value }))}
            fullWidth
          />
          {msg ? <Alert severity={msg.severity} onClose={() => setMsg(null)}>{msg.text}</Alert> : null}
        </Box>
      </Paper>

      <Paper variant="outlined" sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>{t('profile.changePassword')}</Typography>
        {passwordLocked ? (
          <Alert severity="info" sx={{ mb: 2 }}>{t('profile.ssoPasswordManagedNote')}</Alert>
        ) : null}
        {ssoManaged ? (
          <Alert severity="info" sx={{ mb: 2 }}>{t('profile.ssoEmailLoginApprovalNote')}</Alert>
        ) : null}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label={t('profile.currentPassword')}
            type="password"
            value={passwords.currentPassword}
            onChange={(event) => setPasswords((current) => ({ ...current, currentPassword: event.target.value }))}
            fullWidth
            disabled={passwordLocked}
          />
          <TextField
            label={t('profile.newPassword')}
            type="password"
            value={passwords.newPassword}
            onChange={(event) => setPasswords((current) => ({ ...current, newPassword: event.target.value }))}
            fullWidth
            disabled={passwordLocked}
          />
          <TextField
            label={t('profile.confirmNewPassword')}
            type="password"
            value={passwords.confirmPassword}
            onChange={(event) => setPasswords((current) => ({ ...current, confirmPassword: event.target.value }))}
            fullWidth
            disabled={passwordLocked}
          />
          <Button variant="contained" onClick={handleChangePassword} disabled={changingPw || passwordLocked}>
            {changingPw ? t('profile.changingPassword') : t('profile.changePassword')}
          </Button>
          {pwMsg ? <Alert severity={pwMsg.severity} onClose={() => setPwMsg(null)}>{pwMsg.text}</Alert> : null}
        </Box>
      </Paper>

      <ProfileImageEditorDialog
        open={!!imageEditorState}
        editorState={imageEditorState}
        busy={imageBusy}
        onClose={closeImageEditor}
        onRotate={rotateImageEditor}
        onMoveCrop={moveImageEditorCrop}
        onSave={saveImageEditor}
        t={t}
      />
    </Box>
  );
}
