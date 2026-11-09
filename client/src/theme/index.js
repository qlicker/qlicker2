import { alpha, createTheme } from '@mui/material/styles';

const COMPACT_SMALL_INPUT_PADDING = '8.5px';

export function createAppTheme(mode = 'light') {
  return createTheme({
    shape: { borderRadius: 10 },
    palette: {
      mode,
      primary: mode === 'dark'
        ? { main: '#66c9f2', contrastText: '#10212b' }
        : { main: '#30B0E7', contrastText: '#FFFFFF' },
      secondary: { main: '#FF9800' },
      multiSelect: mode === 'dark'
        ? { main: '#ce93d8', light: '#e1bee7', dark: '#ab47bc', contrastText: '#211126' }
        : { main: '#7b1fa2', light: '#ae52d4', dark: '#4a0072', contrastText: '#FFFFFF' },
      ...(mode === 'light' ? {
        success: { main: '#4CAF50' },
        error: { main: '#F44336' },
      } : {}),
      background: mode === 'dark'
        ? { default: '#101820', paper: '#1b2733' }
        : { default: '#f9fdfe', paper: '#FFFFFF' },
    },
    typography: {
      fontFamily: '"Helvetica Neue", "Helvetica", "Arial", sans-serif',
    },
    components: {
      MuiButton: {
        styleOverrides: {
          root: { textTransform: 'none' },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: ({ ownerState, theme: muiTheme }) => {
            if (ownerState.color !== 'info') return {};

            if (ownerState.variant === 'outlined') {
              return {
                color: muiTheme.palette.primary.main,
                borderColor: muiTheme.palette.primary.main,
                '& .MuiChip-deleteIcon': {
                  color: alpha(muiTheme.palette.primary.main, 0.72),
                  '&:hover': { color: muiTheme.palette.primary.main },
                },
              };
            }

            return {
              backgroundColor: muiTheme.palette.primary.main,
              color: muiTheme.palette.primary.contrastText,
              '& .MuiChip-deleteIcon': {
                color: alpha(muiTheme.palette.primary.contrastText, 0.72),
                '&:hover': { color: muiTheme.palette.primary.contrastText },
              },
            };
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          inputSizeSmall: {
            paddingTop: COMPACT_SMALL_INPUT_PADDING,
            paddingBottom: COMPACT_SMALL_INPUT_PADDING,
          },
        },
      },
      MuiSelect: {
        styleOverrides: {
          select: {
            '&.MuiInputBase-inputSizeSmall': {
              paddingTop: COMPACT_SMALL_INPUT_PADDING,
              paddingBottom: COMPACT_SMALL_INPUT_PADDING,
            },
          },
        },
      },
    },
  });
}

export default createAppTheme();
