import { Alert } from '@mui/material';
import { VisibilityOff as VisibilityOffIcon } from '@mui/icons-material';
import { useTranslation } from 'react-i18next';

/** Tells students that their responses in this session are not linked to their name. */
export default function AnonymousSessionNotice({ sx }) {
  const { t } = useTranslation();
  return (
    <Alert severity="info" icon={<VisibilityOffIcon fontSize="inherit" />} sx={{ mb: 2, ...sx }}>
      {t('sessionAnonymity.studentNotice')}
    </Alert>
  );
}
