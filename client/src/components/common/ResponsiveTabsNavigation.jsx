import { Box, MenuItem, Tab, Tabs, TextField, Tooltip } from '@mui/material';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTranslation } from 'react-i18next';

export default function ResponsiveTabsNavigation({
  value,
  onChange,
  tabs = [],
  ariaLabel = '',
  dropdownLabel = '',
  tabsProps = {},
  dropdownSx = {},
  compactAdornment = null,
  wrap = false,
}) {
  const { t } = useTranslation();
  const compact = useMediaQuery('(max-width:799px)');
  const normalizedTabs = tabs.map((tab, index) => ({
    ...tab,
    value: tab?.value ?? index,
  }));
  const valueMap = new Map(normalizedTabs.map((tab) => [String(tab.value), tab.value]));

  if (compact) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, ...dropdownSx }}>
      <TextField
        select
        size="small"
        label={dropdownLabel || t('common.view')}
        value={String(value)}
        onChange={(event) => onChange(valueMap.get(event.target.value))}
        sx={{ minWidth: 0, flexGrow: 1, maxWidth: 420 }}
      >
        {normalizedTabs.map((tab) => (
          <MenuItem key={String(tab.value)} value={String(tab.value)} disabled={tab.disabled}>
            {tab.dropdownLabel || tab.menuLabel || (typeof tab.label === 'string' ? tab.label : '')}
          </MenuItem>
        ))}
      </TextField>
      {compactAdornment}
      </Box>
    );
  }

  const { sx: tabsSx, ...restTabsProps } = tabsProps;
  const wrappedTabsSx = wrap ? {
    '& .MuiTabs-scroller': {
      overflow: 'visible !important',
    },
    '& .MuiTabs-list, & .MuiTabs-flexContainer': {
      flexWrap: 'wrap',
      width: '100%',
    },
    '& .MuiTabs-scrollButtons': {
      display: 'none',
    },
    '& .MuiTabs-indicator': {
      display: 'none',
    },
    '& .MuiTab-root': {
      alignSelf: 'stretch',
      borderBottom: 2,
      borderColor: 'transparent',
    },
    '& .MuiTab-root.Mui-selected': {
      borderColor: 'primary.main',
    },
  } : {};

  return (
    <Tabs
      value={value}
      onChange={(_, nextValue) => onChange(nextValue)}
      aria-label={ariaLabel}
      {...restTabsProps}
      sx={tabsSx ? [wrappedTabsSx, tabsSx] : wrappedTabsSx}
    >
      {normalizedTabs.map((tab) => (
        <Tab
          key={String(tab.value)}
          value={tab.value}
          label={tab.tooltip ? <Tooltip title={tab.tooltip} arrow describeChild><span>{tab.label}</span></Tooltip> : tab.label}
          disabled={tab.disabled}
          {...tab.tabProps}
        />
      ))}
    </Tabs>
  );
}
