import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Profile from './Profile';

const {
  apiClientMock,
  authState,
  createAvatarThumbnailFileMock,
  loadImageMock,
  loadUserMock,
  normalizeImageFileMock,
  readFileAsDataUrlMock,
  setCurrentUserMock,
} = vi.hoisted(() => ({
  apiClientMock: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
  },
  authState: {
    user: null,
  },
  createAvatarThumbnailFileMock: vi.fn(),
  loadImageMock: vi.fn(),
  loadUserMock: vi.fn(),
  normalizeImageFileMock: vi.fn(),
  readFileAsDataUrlMock: vi.fn(),
  setCurrentUserMock: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => ({
      'profile.firstName': 'First Name',
      'profile.lastName': 'Last Name',
      'profile.language': 'Language',
      'profile.personalInfo': 'Personal Information',
      'profile.currentPassword': 'Current Password',
      'profile.newPassword': 'New Password',
      'profile.confirmNewPassword': 'Confirm New Password',
      'profile.openPhotoEditor': 'Open profile photo editor',
      'profile.adjustPhoto': 'Adjust profile photo',
      'profile.photoUpdated': 'Profile photo updated',
      'profile.photoFailed': 'Failed to upload photo',
      'profile.uploadPhoto': 'Upload photo',
      'profile.uploading': 'Uploading…',
      'profile.ssoNameManagedNote': 'Your name is managed by your SSO provider and cannot be changed here.',
      'profile.ssoPasswordManagedNote': 'Password changes are unavailable while you are signed in through SSO.',
      'profile.ssoEmailLoginApprovalNote': 'This account was created through SSO. An administrator must approve email login before password reset or email-based sign-in can be used.',
      'common.save': 'Save',
      'common.cancel': 'Cancel',
      'common.saving': 'Saving',
    }[key] ?? key),
  }),
}));

vi.mock('../i18n', () => ({
  default: {
    changeLanguage: vi.fn(),
  },
  SUPPORTED_LOCALES: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'Français' },
  ],
}));

vi.mock('../api/client', () => ({
  default: apiClientMock,
}));

vi.mock('../utils/imageUpload', async () => {
  const actual = await vi.importActual('../utils/imageUpload');
  return {
    ...actual,
    createAvatarThumbnailFile: createAvatarThumbnailFileMock,
    loadImage: loadImageMock,
    normalizeImageFile: normalizeImageFileMock,
    prepareImageFileForUpload: normalizeImageFileMock,
    readFileAsDataUrl: readFileAsDataUrlMock,
  };
});

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: authState.user,
    loadUser: loadUserMock,
    setCurrentUser: setCurrentUserMock,
  }),
}));

vi.mock('../components/common/AutoSaveStatus', () => ({
  default: () => null,
}));

describe('Profile', () => {
  beforeEach(() => {
    apiClientMock.get.mockReset();
    apiClientMock.patch.mockReset();
    apiClientMock.post.mockReset();
    loadUserMock.mockReset();
    setCurrentUserMock.mockReset();
    createAvatarThumbnailFileMock.mockReset();
    loadImageMock.mockReset();
    normalizeImageFileMock.mockReset();
    readFileAsDataUrlMock.mockReset();

    authState.user = {
      email: 'sso-profile@example.com',
      role: 'student',
      profile: {
        firstname: 'SSO',
        lastname: 'User',
        roles: ['student'],
      },
      isSSOUser: true,
      isSSOCreatedUser: true,
      allowEmailLogin: false,
      lastAuthProvider: 'sso',
    };
    loadUserMock.mockResolvedValue(undefined);
    loadImageMock.mockResolvedValue({ naturalWidth: 1200, naturalHeight: 900 });
    createAvatarThumbnailFileMock.mockResolvedValue(new File(['thumb'], 'thumb.jpg', { type: 'image/jpeg' }));
    normalizeImageFileMock.mockImplementation(async (file) => ({ file }));
    readFileAsDataUrlMock.mockResolvedValue('data:image/png;base64,ZmFrZQ==');

    apiClientMock.get.mockImplementation((url) => {
      if (url === '/users/me') {
        return Promise.resolve({
          data: {
            user: {
              profile: {
                firstname: 'SSO',
                lastname: 'User',
                studentNumber: '12345',
              },
              locale: '',
            },
          },
        });
      }

      if (url === '/settings/public') {
        return Promise.resolve({
          data: {
            SSO_enabled: true,
            maxImageWidth: 1920,
            avatarThumbnailSize: 512,
          },
        });
      }

      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });

    apiClientMock.patch.mockResolvedValue({
      data: {
        profile: {
          profileImage: '/uploads/original-avatar.jpg',
          profileThumbnail: '/uploads/thumb-new.jpg',
        },
      },
    });
    apiClientMock.post.mockImplementation((url) => {
      if (url === '/images') {
        return Promise.resolve({
          data: {
            image: {
              url: '/uploads/thumb-new.jpg',
            },
          },
        });
      }
      if (url === '/users/me/image/thumbnail') {
        return Promise.resolve({
          data: {
            profile: {
              profileImage: '/uploads/original-avatar.jpg',
              profileThumbnail: '/uploads/thumb-new.jpg',
            },
          },
        });
      }
      return Promise.reject(new Error(`Unexpected POST ${url}`));
    });
  });

  it('greys out SSO-managed name and password fields', async () => {
    render(<Profile />);

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/users/me');
    });

    expect(screen.getByLabelText('First Name')).toBeDisabled();
    expect(screen.getByLabelText('Last Name')).toBeDisabled();
    expect(screen.getByLabelText('Current Password')).toBeDisabled();
    expect(screen.getByLabelText('New Password')).toBeDisabled();
    expect(screen.getByLabelText('Confirm New Password')).toBeDisabled();
    expect(screen.getByText('Your name is managed by your SSO provider and cannot be changed here.')).toBeInTheDocument();
    expect(screen.getByText('Password changes are unavailable while you are signed in through SSO.')).toBeInTheDocument();
    expect(screen.getByText('This account was created through SSO. An administrator must approve email login before password reset or email-based sign-in can be used.')).toBeInTheDocument();
    const [languageHeading] = screen.getAllByText('Language', { selector: 'h6' });
    const personalInfoHeading = screen.getByText('Personal Information', { selector: 'h6' });
    expect(languageHeading.compareDocumentPosition(personalInfoHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('replaces an existing avatar thumbnail client-side before falling back to the server route', async () => {
    authState.user = {
      ...authState.user,
      profile: {
        firstname: 'SSO',
        lastname: 'User',
        roles: ['student'],
        profileImage: '/uploads/original-avatar.jpg',
        profileThumbnail: '/uploads/original-thumb.jpg',
      },
    };

    render(<Profile />);

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/users/me');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open profile photo editor' }));
    await screen.findByText('Adjust profile photo');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(createAvatarThumbnailFileMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/images', expect.any(FormData), expect.objectContaining({ timeout: expect.any(Number) }));
    });
    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/users/me/image', {
        profileImage: '/uploads/original-avatar.jpg',
        profileThumbnail: '/uploads/thumb-new.jpg',
      });
    });
    expect(setCurrentUserMock).toHaveBeenCalledWith({
      profile: {
        profileImage: '/uploads/original-avatar.jpg',
        profileThumbnail: '/uploads/thumb-new.jpg',
      },
    });
    expect(apiClientMock.post).not.toHaveBeenCalledWith('/users/me/image/thumbnail', expect.anything());
  });

  it('falls back to the server thumbnail route when the browser cannot generate a thumbnail', async () => {
    authState.user = {
      ...authState.user,
      profile: {
        firstname: 'SSO',
        lastname: 'User',
        roles: ['student'],
        profileImage: '/uploads/original-avatar.jpg',
        profileThumbnail: '/uploads/original-thumb.jpg',
      },
    };
    const securityError = new Error('Canvas is tainted');
    securityError.name = 'SecurityError';
    createAvatarThumbnailFileMock.mockRejectedValueOnce(securityError);

    render(<Profile />);

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/users/me');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open profile photo editor' }));
    await screen.findByText('Adjust profile photo');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/users/me/image/thumbnail', {
        rotation: 0,
        cropX: 150,
        cropY: 0,
        cropSize: 900,
      });
    });
    expect(setCurrentUserMock).toHaveBeenCalledWith({
      profile: {
        profileImage: '/uploads/original-avatar.jpg',
        profileThumbnail: '/uploads/thumb-new.jpg',
      },
    });
  });

  it('falls back to the server thumbnail route for new uploads when client thumbnail generation fails', async () => {
    const securityError = new Error('Failed to prepare avatar thumbnail');
    securityError.name = 'SecurityError';
    createAvatarThumbnailFileMock.mockRejectedValueOnce(securityError);

    apiClientMock.post.mockImplementation((url) => {
      if (url === '/images') {
        return Promise.resolve({
          data: {
            image: {
              url: '/uploads/original-avatar.jpg',
            },
          },
        });
      }
      if (url === '/users/me/image/thumbnail') {
        return Promise.resolve({
          data: {
            profile: {
              profileImage: '/uploads/original-avatar.jpg',
              profileThumbnail: '/uploads/thumb-new.jpg',
            },
          },
        });
      }
      return Promise.reject(new Error(`Unexpected POST ${url}`));
    });

    apiClientMock.patch.mockResolvedValue({
      data: {
        profile: {
          profileImage: '/uploads/original-avatar.jpg',
          profileThumbnail: '/uploads/original-avatar.jpg',
        },
      },
    });

    const { container } = render(<Profile />);

    await waitFor(() => {
      expect(apiClientMock.get).toHaveBeenCalledWith('/users/me');
    });

    const fileInput = container.querySelector('input[type="file"]');
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await screen.findByText('Adjust profile photo');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/users/me/image', {
        profileImage: '/uploads/original-avatar.jpg',
        profileThumbnail: '/uploads/original-avatar.jpg',
      });
    });
    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/users/me/image/thumbnail', {
        rotation: 0,
        cropX: 150,
        cropY: 0,
        cropSize: 900,
      });
    });
    expect(setCurrentUserMock).toHaveBeenCalledWith({
      profile: {
        profileImage: '/uploads/original-avatar.jpg',
        profileThumbnail: '/uploads/thumb-new.jpg',
      },
    });
  });
});
