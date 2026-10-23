import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import ResponsiveTabsNavigation from '../common/ResponsiveTabsNavigation';

const LIVE_SESSION_TABS_SX = {
  minHeight: 0,
  '& .MuiTab-root': {
    minHeight: { xs: 44, sm: 46 },
    textTransform: 'none',
    fontWeight: 700,
    px: { sm: 1.5, md: 2 },
    minWidth: 0,
  },
};

export default function LiveSessionPanelNavigation({
  value,
  onChange,
  tabs,
  ariaLabel,
  dropdownLabel,
  disablePaper = false,
  compactAdornment = null,
  sx = {},
}) {
  const navigation = (
    <ResponsiveTabsNavigation
      value={value}
      onChange={onChange}
      tabs={tabs}
      ariaLabel={ariaLabel}
      dropdownLabel={dropdownLabel}
      dropdownSx={{ width: '100%', minWidth: 0, maxWidth: 'none' }}
      compactAdornment={compactAdornment}
      tabsProps={{
        variant: 'fullWidth',
        sx: LIVE_SESSION_TABS_SX,
      }}
    />
  );

  if (disablePaper) {
    return (
      <Box sx={sx}>
        {navigation}
      </Box>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: { xs: 1, sm: 0.5 }, mb: 2, ...sx }}>
      {navigation}
    </Paper>
  );
}
