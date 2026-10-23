import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import ManageNotificationsDialog from './ManageNotificationsDialog';

const { apiClientMock } = vi.hoisted(() => ({
  apiClientMock: {
    delete: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('../../api/client', () => ({
  default: apiClientMock,
}));

function renderDialog(props = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ManageNotificationsDialog
        open
        onClose={vi.fn()}
        scopeType="course"
        courseId="course-1"
        title="Manage notifications"
        use24Hour
        {...props}
      />
    </I18nextProvider>
  );
}

describe('ManageNotificationsDialog', () => {
  beforeEach(() => {
    apiClientMock.delete.mockReset();
    apiClientMock.get.mockReset();
    apiClientMock.patch.mockReset();
    apiClientMock.post.mockReset();
    apiClientMock.get.mockResolvedValue({ data: { notifications: [] } });
    apiClientMock.post.mockResolvedValue({ data: {} });
    apiClientMock.patch.mockResolvedValue({ data: {} });
    apiClientMock.delete.mockResolvedValue({ data: {} });
  });

  it('creates a course notification after confirmation', async () => {
    renderDialog();

    expect(await screen.findByText(/no notifications have been posted yet/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/title/i), { target: { value: 'Course notice' } });
    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: 'Read chapter 5.' } });
    fireEvent.mouseDown(screen.getByLabelText(/send to/i));
    fireEvent.click(await screen.findByRole('option', { name: /all instructors in this course/i }));
    fireEvent.click(screen.getByRole('button', { name: /post notification/i }));
    expect(await screen.findByText(/become visible to all instructors in this course/i)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /^confirm$/i }));

    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/notifications/manage', expect.objectContaining({
        scopeType: 'course',
        courseId: 'course-1',
        recipientType: 'instructors',
        title: 'Course notice',
        message: 'Read chapter 5.',
      }));
    });
  });

  it('uses system-wide recipient copy in the confirmation dialog', async () => {
    renderDialog({ scopeType: 'system', courseId: '' });

    fireEvent.change(await screen.findByLabelText(/title/i), { target: { value: 'System notice' } });
    fireEvent.change(screen.getByLabelText(/message/i), { target: { value: 'Scheduled maintenance.' } });
    fireEvent.mouseDown(screen.getByLabelText(/send to/i));
    fireEvent.click(await screen.findByRole('option', { name: /all profs/i }));
    fireEvent.click(screen.getByRole('button', { name: /post notification/i }));

    expect(await screen.findByText(/visible to all profs/i)).toBeInTheDocument();
  });

  it('edits and deletes existing notifications', async () => {
    apiClientMock.get.mockResolvedValue({
      data: {
        notifications: [
            {
              _id: 'notification-1',
              scopeType: 'course',
              courseId: 'course-1',
              recipientType: 'students',
              title: 'Original title',
              message: 'Original message',
              startAt: '2026-03-31T12:00:00.000Z',
            endAt: '2026-03-31T18:00:00.000Z',
            persistUntilDismissed: false,
            source: {
              type: 'course',
              course: {
                _id: 'course-1',
                name: 'Algorithms',
                deptCode: 'CS',
                courseNumber: '401',
                section: '001',
                semester: 'Fall 2026',
              },
            },
          },
        ],
      },
    });

    renderDialog();

    expect(await screen.findByText('Original title')).toBeInTheDocument();
    expect(screen.getByText(/all students in this course/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /edit notification/i }));
    const titleInput = screen.getByLabelText(/title/i);
    fireEvent.change(titleInput, { target: { value: 'Updated title' } });
    fireEvent.mouseDown(screen.getByLabelText(/send to/i));
    fireEvent.click(await screen.findByRole('option', { name: /^everyone in this course$/i }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^confirm$/i }));

    await waitFor(() => {
      expect(apiClientMock.patch).toHaveBeenCalledWith('/notifications/notification-1', expect.objectContaining({
        recipientType: 'all',
        title: 'Updated title',
      }));
    });

    fireEvent.click(await screen.findByRole('button', { name: /delete notification/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(apiClientMock.delete).toHaveBeenCalledWith('/notifications/notification-1');
    });
  });
});
