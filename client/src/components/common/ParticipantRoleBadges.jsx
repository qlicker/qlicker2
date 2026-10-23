import { Box, Chip } from '@mui/material';
import { useTranslation } from 'react-i18next';

export default function ParticipantRoleBadges({ participant }) {
  const { t } = useTranslation();
  const role = participant?.participantRole;
  if (!['student', 'guest', 'instructor'].includes(role)) return null;
  return (
    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
      <Chip size="small" variant="outlined" label={t(`common.participantRoles.${role}`)} />
      {participant.isProfessor && role !== 'instructor' && (
        <Chip size="small" variant="outlined" label={t('common.participantRoles.professor')} />
      )}
    </Box>
  );
}
