import { render, screen } from '@testing-library/react';
import { useTheme } from '@mui/material/styles';
import { describe, expect, it, vi } from 'vitest';
import AppThemeProvider from './AppThemeProvider';

const auth = vi.hoisted(() => ({ user: null }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

function Appearance() {
  const theme = useTheme();
  return <div data-testid="appearance">{theme.palette.mode}</div>;
}

describe('account appearance', () => {
  it('follows saved preferences and resets for logout or a legacy account', () => {
    auth.user = null;
    const { rerender } = render(<AppThemeProvider><Appearance /></AppThemeProvider>);
    expect(screen.getByTestId('appearance')).toHaveTextContent('light');

    for (const [user, mode] of [
      [{ _id: 'a', themeMode: 'dark' }, 'dark'],
      [{ _id: 'a', themeMode: 'light' }, 'light'],
      [{ _id: 'a', themeMode: 'dark' }, 'dark'],
      [{ _id: 'legacy' }, 'light'],
      [{ _id: 'a', themeMode: 'dark' }, 'dark'],
      [null, 'light'],
    ]) {
      auth.user = user;
      rerender(<AppThemeProvider><Appearance /></AppThemeProvider>);
      expect(screen.getByTestId('appearance')).toHaveTextContent(mode);
    }
  });
});
