import { FormControlLabel, Switch, Tooltip } from '@mui/material';
import { useTranslation } from 'react-i18next';

export default function SessionGradesVisibilityControl({ session, disabled = false, onChange, size = 'small', sx }) {
  const { t } = useTranslation();
  if (!session || session.anonymous || session.studentCreated) return null;

  return (
    <Tooltip title={t('grades.visibility.help')} arrow describeChild>
      <FormControlLabel
        sx={{ m: 0, ...sx }}
        control={(
          <Switch
            size={size}
            checked={!!(session.reviewable || session.gradesVisible)}
            disabled={disabled || !!session.reviewable || session.status !== 'done' || !!session.quizHasRemainingExtensions}
            onChange={(event) => onChange(event.target.checked)}
          />
        )}
        label={t('grades.visibility.label')}
      />
    </Tooltip>
  );
}
