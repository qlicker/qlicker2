import { Box, ButtonBase, Paper, Typography } from '@mui/material';

export default function SessionListCard({
  title,
  subtitle = null,
  badges = null,
  actions = null,
  onClick,
  disabled = false,
  highlighted = false,
  sx = {},
}) {
  const clickable = typeof onClick === 'function' && !disabled;

  const content = (
    <Box sx={{ p: 1.75, width: '100%', textAlign: 'left' }}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        {typeof title === 'string' ? (
          <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
            {title}
          </Typography>
        ) : title}
        {badges ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8, flexWrap: 'wrap' }}>
            {badges}
          </Box>
        ) : null}
        {subtitle ? (
          typeof subtitle === 'string' ? (
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>
              {subtitle}
            </Typography>
          ) : subtitle
        ) : null}
      </Box>
    </Box>
  );

  return (
    <Paper
      variant="outlined"
      sx={{
        overflow: 'hidden',
        borderColor: highlighted ? 'success.light' : 'divider',
        bgcolor: highlighted ? 'success.50' : 'background.paper',
        boxShadow: highlighted ? '0 0 0 1px rgba(46, 125, 50, 0.1)' : 'none',
        transition: 'box-shadow 0.18s ease, border-color 0.18s ease, transform 0.18s ease',
        ...(clickable ? {
          '&:hover': {
            bgcolor: highlighted ? 'rgba(232, 245, 233, 0.95)' : 'action.hover',
          },
        } : {}),
        ...sx,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'stretch', flexWrap: { xs: 'wrap', md: 'nowrap' } }}>
        {clickable ? (
          <ButtonBase
            onClick={onClick}
            sx={{
              flex: 1,
              alignItems: 'stretch',
              justifyContent: 'flex-start',
            }}
          >
            {content}
          </ButtonBase>
        ) : (
          <Box sx={{ flex: 1 }}>
            {content}
          </Box>
        )}

        {actions ? (
          <Box
            onClick={(event) => event.stopPropagation()}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: { xs: 'flex-start', md: 'flex-end' },
              gap: 1,
              flexWrap: 'wrap',
              px: 1.25,
              py: { xs: 1.25, md: 1 },
              width: { xs: '100%', md: 'auto' },
            }}
          >
            {actions}
          </Box>
        ) : null}
      </Box>
    </Paper>
  );
}
