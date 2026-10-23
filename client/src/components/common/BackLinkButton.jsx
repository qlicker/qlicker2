import { Button } from '@mui/material';
import { ArrowBack as BackIcon } from '@mui/icons-material';

export default function BackLinkButton({
  label,
  onClick,
  variant = 'text',
  sx,
  ...buttonProps
}) {
  return (
    <Button
      size="small"
      startIcon={<BackIcon />}
      variant={variant}
      onClick={onClick}
      sx={{
        justifyContent: 'flex-start',
        textAlign: 'left',
        alignSelf: 'flex-start',
        ...sx,
      }}
      {...buttonProps}
    >
      {label}
    </Button>
  );
}
