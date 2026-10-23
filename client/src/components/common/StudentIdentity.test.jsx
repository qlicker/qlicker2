import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StudentIdentity from './StudentIdentity';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => ({
      'common.close': 'Close',
      'common.unknown': 'Unknown',
    }[key] ?? key),
  }),
}));

describe('StudentIdentity', () => {
  it('uses the thumbnail for the avatar and opens the full-size profile image dialog', () => {
    render(
      <StudentIdentity
        student={{
          emails: [{ address: 'ada@example.com' }],
          profile: {
            firstname: 'Ada',
            lastname: 'Lovelace',
            profileThumbnail: '/uploads/ada-thumb.jpg',
            profileImage: '/uploads/ada-full.jpg',
          },
        }}
      />
    );

    expect(screen.getByAltText('Ada Lovelace')).toHaveAttribute('src', '/uploads/ada-thumb.jpg');

    const avatarButton = screen.getByRole('button', { name: 'Ada Lovelace' });
    fireEvent.keyDown(avatarButton, { key: 'Enter' });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: 'Ada Lovelace' }).at(-1)).toHaveAttribute('src', '/uploads/ada-full.jpg');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    return waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('falls back to an unknown label when the student record has no display fields', () => {
    render(<StudentIdentity student={{}} showEmail={false} />);

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByText('?')).toBeInTheDocument();
  });
  it('distinguishes course membership from a guest professor account', () => {
    const { rerender } = render(<StudentIdentity student={{ firstname: 'Ada', participantRole: 'guest', isProfessor: true }} />);
    expect(screen.getByText('common.participantRoles.guest')).toBeInTheDocument();
    expect(screen.getByText('common.participantRoles.professor')).toBeInTheDocument();
    rerender(<StudentIdentity student={{ firstname: 'Ada', participantRole: 'student' }} />);
    expect(screen.getByText('common.participantRoles.student')).toBeInTheDocument();
    expect(screen.queryByText('common.participantRoles.guest')).not.toBeInTheDocument();
    rerender(<StudentIdentity student={{ firstname: 'Respondent 1' }} />);
    expect(screen.queryByText('common.participantRoles.student')).not.toBeInTheDocument();
    expect(screen.queryByText('common.participantRoles.professor')).not.toBeInTheDocument();
  });

});
