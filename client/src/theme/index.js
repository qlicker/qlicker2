import { alpha, createTheme } from '@mui/material/styles';

const COMPACT_SMALL_INPUT_PADDING = '8.5px';

const theme = createTheme({
  shape: { borderRadius: 10 },
  palette: {
    primary: { main: '#30B0E7', contrastText: '#FFFFFF' },
    secondary: { main: '#FF9800' },
    success: { main: '#4CAF50' },
    error: { main: '#F44336' },
    background: {default: '#f9fdfe', paper: '#FFFFFF'  },
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

export default theme;
