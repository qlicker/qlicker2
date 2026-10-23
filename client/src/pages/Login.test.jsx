import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Login from './Login';
import { APP_VERSION } from '../utils/version';

const {
  apiClientMock,
  loginMock,
  registerMock,
  navigateMock,
} = vi.hoisted(() => ({
  apiClientMock: {
    get: vi.fn(),
    post: vi.fn(),
  },
  loginMock: vi.fn(),
  registerMock: vi.fn(),
  navigateMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, params) => ({
      'common.appName': 'Qlicker',
      'common.or': 'or',
      'common.cancel': 'Cancel',
      'auth.email': 'Email',
      'auth.password': 'Password',
      'auth.login': 'Login',
      'auth.register': 'Register',
      'auth.loggingIn': 'Logging in',
      'auth.creatingAccount': 'Creating account',
      'auth.createAccount': 'Create Account',
      'auth.verifyBeforeLogin': 'Account created. Please verify your email address before logging in.',
      'auth.firstName': 'First Name',
      'auth.lastName': 'Last Name',
      'auth.forgotPassword': 'Forgot Password?',
      'auth.backToSSO': 'Back to SSO login',
      'auth.haveEmailAccount': 'Have an email-based account',
      'auth.selfRegistrationDisabled': 'New accounts can only be created by an administrator.',
      'auth.goToLandingPage': 'Go to the Qlicker landing page',
      'auth.forgotPasswordTitle': 'Forgot Password',
      'auth.forgotPasswordMessage': 'Reset your password',
      'auth.forgotPasswordSsoNotice': 'When SSO is enabled, password reset is limited to approved email-login accounts.',
      'auth.sendResetLink': 'Send Reset Link',
      'auth.sending': 'Sending',
      'auth.loginThrough': `Login through ${params?.institution ?? 'SSO'}`,
      'auth.ssoDefault': 'SSO',
      'auth.resetLinkSent': 'Reset link sent',
      'auth.resetEmailFailed': 'Reset email failed',
    }[key] ?? key),
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
  Navigate: ({ to }) => <div data-testid="redirect-target">{to}</div>,
  Link: ({ to, children, ...props }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    login: loginMock,
    register: registerMock,
  }),
}));

vi.mock('../api/client', () => ({
  default: apiClientMock,
}));

describe('Login', () => {
  beforeEach(() => {
    apiClientMock.get.mockReset();
    apiClientMock.post.mockReset();
    loginMock.mockReset();
    registerMock.mockReset();
    navigateMock.mockReset();
  });

  it('waits for public auth settings before showing a login mode', async () => {
    let resolveSettings;
    apiClientMock.get.mockReturnValue(new Promise((resolve) => {
      resolveSettings = resolve;
    }));

    render(<Login />);

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Login' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Register' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Login through/i })).not.toBeInTheDocument();

    resolveSettings({
      data: {
        SSO_enabled: true,
        SSO_institutionName: 'Example University',
      },
    });

    expect(await screen.findByRole('button', { name: 'Login through Example University' })).toBeInTheDocument();
  });

  it('uses standard login field names and autocomplete tokens for email login when SSO is enabled', async () => {
    apiClientMock.get.mockResolvedValue({
      data: {
        SSO_enabled: true,
        SSO_institutionName: 'Example University',
      },
    });

    render(<Login />);

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/settings/public');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Have an email-based account' }));

    const emailField = screen.getByRole('textbox', { name: /^Email/i });
    const passwordField = document.getElementById('login-password');

    expect(emailField).toHaveAttribute('name', 'email');
    expect(emailField).toHaveAttribute('autocomplete', 'username');
    expect(passwordField).not.toBeNull();
    expect(passwordField).toHaveAttribute('name', 'password');
    expect(passwordField).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('form', { name: 'Login' })).toBeInTheDocument();
  });

  it('uses registration-friendly autocomplete tokens on the register tab', async () => {
    apiClientMock.get.mockResolvedValue({
      data: {
        SSO_enabled: false,
        registrationDisabled: false,
      },
    });

    render(<Login />);

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/settings/public');
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Register' }));

    expect(screen.getByRole('textbox', { name: /^First Name/i })).toHaveAttribute('autocomplete', 'given-name');
    expect(screen.getByRole('textbox', { name: /^Last Name/i })).toHaveAttribute('autocomplete', 'family-name');
    expect(screen.getByRole('textbox', { name: /^Email/i })).toHaveAttribute('autocomplete', 'email');
    const passwordField = document.getElementById('register-password');
    expect(passwordField).not.toBeNull();
    expect(passwordField).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByRole('form', { name: 'Register' })).toBeInTheDocument();
  });

  it('shows the SSO password-reset notice in the forgot-password dialog when SSO is enabled', async () => {
    apiClientMock.get.mockResolvedValue({
      data: {
        SSO_enabled: true,
        SSO_institutionName: 'Example University',
      },
    });

    render(<Login />);

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/settings/public');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Have an email-based account' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forgot Password?' }));

    expect(screen.getByText('When SSO is enabled, password reset is limited to approved email-login accounts.')).toBeInTheDocument();
  });

  it('sends student-role instructor accounts to the student dashboard', async () => {
    apiClientMock.get.mockResolvedValue({
      data: {
        SSO_enabled: false,
        registrationDisabled: false,
      },
    });
    loginMock.mockResolvedValue({
      profile: { roles: ['student'] },
      hasInstructorCourses: true,
      canAccessProfessorDashboard: false,
    });

    render(<Login />);

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/settings/public');
    });

    fireEvent.change(screen.getByRole('textbox', { name: /^Email/i }), { target: { value: 'mix@example.com' } });
    fireEvent.change(document.getElementById('login-password'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));

    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledWith('mix@example.com', 'password123');
      expect(navigateMock).toHaveBeenCalledWith('/student', { replace: true });
    });
  });

  it('hides self-registration when public settings disable it', async () => {
    apiClientMock.get.mockResolvedValue({
      data: {
        SSO_enabled: false,
        registrationDisabled: true,
      },
    });

    render(<Login />);

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/settings/public');
    });

    expect(screen.getByText('New accounts can only be created by an administrator.')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Register' })).not.toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Login' })).toBeInTheDocument();
  });

  it('links the Qlicker wordmark to the landing page', async () => {
    apiClientMock.get.mockResolvedValue({
      data: {
        SSO_enabled: false,
        registrationDisabled: false,
      },
    });

    render(<Login />);

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/settings/public');
    });

    expect(screen.getByRole('link', { name: 'Go to the Qlicker landing page' })).toHaveAttribute('href', '/');
  });

  it('does not show the app version on the login page', async () => {
    apiClientMock.get.mockResolvedValue({
      data: {
        SSO_enabled: false,
        registrationDisabled: false,
      },
    });

    render(<Login />);

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/settings/public');
    });

    expect(screen.queryByText(APP_VERSION)).not.toBeInTheDocument();
  });
});
