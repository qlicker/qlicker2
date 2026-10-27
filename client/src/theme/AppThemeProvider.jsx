import { ThemeProvider, CssBaseline } from '@mui/material';
import { useAuth } from '../contexts/AuthContext';
import lightTheme, { createAppTheme } from './index';

const darkTheme = createAppTheme('dark');

export default function AppThemeProvider({ children }) {
  const { user } = useAuth();
  const theme = user?.themeMode === 'dark' ? darkTheme : lightTheme;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline enableColorScheme />
      {children}
    </ThemeProvider>
  );
}
