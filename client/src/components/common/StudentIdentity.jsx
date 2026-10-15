import { useMemo, useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import ParticipantRoleBadges from './ParticipantRoleBadges';

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export default function StudentIdentity({
  student,
  showEmail = true,
  avatarSize = 36,
  onClick,
  nameVariant = 'body2',
  emailVariant = 'caption',
  nameWeight = 600,
  sx,
}) {
  const { t } = useTranslation();
  const [imageViewUrl, setImageViewUrl] = useState(null);

  const firstname = normalizeValue(student?.profile?.firstname || student?.firstname);
  const lastname = normalizeValue(student?.profile?.lastname || student?.lastname);
  const email = normalizeValue(student?.emails?.[0]?.address || student?.email);
  const displayName = useMemo(() => {
    const fullName = `${firstname} ${lastname}`.trim();
    return fullName || normalizeValue(student?.displayName) || email || t('common.unknown');
  }, [email, firstname, lastname, student?.displayName, t]);
  const avatarSrc = normalizeValue(
    student?.avatarSrc
      || student?.profile?.profileThumbnail
      || student?.profileThumbnail
      || student?.profile?.profileImage
      || student?.profileImage
  );
  const fullImageSrc = normalizeValue(
    student?.fullImageSrc
      || student?.profile?.profileImage
      || student?.profileImage
      || student?.profile?.profileThumbnail
      || student?.profileThumbnail
  );
  const initials = `${firstname.charAt(0)}${lastname.charAt(0)}`.trim()
    || email.charAt(0)
    || '?';
  const canOpenImage = !!fullImageSrc;

  const handleOpenImage = (event) => {
    event.stopPropagation();
    if (canOpenImage) {
      setImageViewUrl(fullImageSrc);
    }
  };

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minWidth: 0,
          ...sx,
        }}
      >
        <Avatar
          alt={displayName}
          src={avatarSrc}
          slotProps={{
            img: {
              alt: displayName,
              loading: 'lazy',
              decoding: 'async',
            },
          }}
          sx={{
            width: avatarSize,
            height: avatarSize,
            cursor: canOpenImage ? 'pointer' : 'default',
            flexShrink: 0,
          }}
          role={canOpenImage ? 'button' : undefined}
          tabIndex={canOpenImage ? 0 : undefined}
          aria-label={canOpenImage ? displayName : undefined}
          onClick={handleOpenImage}
          onKeyDown={(event) => {
            if (!canOpenImage) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleOpenImage(event);
            }
          }}
        >
          {initials.toUpperCase()}
        </Avatar>
        <Box
          onClick={onClick}
          sx={{
            minWidth: 0,
            flexGrow: 1,
            cursor: onClick ? 'pointer' : 'default',
          }}
        >
          <Typography variant={nameVariant} sx={{ fontWeight: nameWeight }} noWrap>
            {displayName}
          </Typography>
          <ParticipantRoleBadges participant={student} />
          {showEmail && email ? (
            <Typography
              variant={emailVariant}
              noWrap
              sx={{
                color: "text.secondary",
                display: 'block'
              }}>
              {email}
            </Typography>
          ) : null}
        </Box>
      </Box>

      <Dialog open={!!imageViewUrl} onClose={() => setImageViewUrl(null)} maxWidth="sm" fullWidth>
        <DialogContent sx={{ textAlign: 'center', p: 2 }}>
          {imageViewUrl ? (
            <img
              src={imageViewUrl}
              alt={displayName}
              style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
            />
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImageViewUrl(null)}>{t('common.close')}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
