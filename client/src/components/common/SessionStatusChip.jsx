import { Chip } from '@mui/material';
import { useTranslation } from 'react-i18next';

const STATUS_META = {
  hidden: { labelKey: 'sessionStatus.draft', color: 'default' },
  visible: { labelKey: 'sessionStatus.upcoming', color: 'info' },
  running: { labelKey: 'sessionStatus.live', color: 'success' },
  done: { labelKey: 'sessionStatus.ended', color: 'warning' },
};

export default function SessionStatusChip({
  status = 'hidden',
  size = 'small',
  sx,
  ...chipProps
}) {
  const { t } = useTranslation();
  const meta = STATUS_META[status];
  const statusMeta = meta
    ? { label: t(meta.labelKey), color: meta.color }
    : { label: status || t('sessionStatus.unknown'), color: 'default' };
  const isHidden = status === 'hidden';

  return (
    <Chip
      label={statusMeta.label}
      color={statusMeta.color}
      variant="outlined"
      size={size}
      sx={{
        borderRadius: 1.4,
        fontWeight: isHidden ? 500 : 600,
        borderColor: isHidden ? 'action.disabledBackground' : undefined,
        color: isHidden ? 'text.disabled' : undefined,
        '& .MuiChip-label': {
          px: size === 'small' ? 1.15 : 1.4,
          color: isHidden ? 'text.disabled' : undefined,
          fontWeight: isHidden ? 500 : 600,
        },
        ...sx,
      }}
      {...chipProps}
    />
  );
}
