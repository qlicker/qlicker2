import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import AiGradingModal from './AiGradingModal';

const apiClientMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }));

vi.mock('../../api/client', () => ({ default: apiClientMock }));

describe('AiGradingModal', () => {
  it('keeps included questions checked until the instructor changes them', async () => {
    apiClientMock.get.mockResolvedValue({ data: { instructions: [] } });
    apiClientMock.put.mockResolvedValue({ data: {} });
    render(
      <I18nextProvider i18n={i18n}>
        <AiGradingModal
          open
          onClose={vi.fn()}
          onStarted={vi.fn()}
          courseId="course-1"
          sessionId="session-1"
          questions={[
            { _id: 'question-1', type: 2 },
            { _id: 'question-2', type: 2 },
          ]}
          needsGradingQuestionIds={[]}
        />
      </I18nextProvider>
    );

    await waitFor(() => expect(apiClientMock.get).toHaveBeenCalled());
    const [firstCheckbox] = screen.getAllByRole('checkbox');
    fireEvent.click(firstCheckbox);

    expect(firstCheckbox).toBeChecked();
    await waitFor(() => expect(apiClientMock.put).toHaveBeenCalledWith(
      '/ai/courses/course-1/sessions/session-1/ai-grading-rubric',
      expect.objectContaining({ questionIds: ['question-1'] })
    ));
    expect(screen.getByText(/AI Grading Form for question 1/i)).toBeInTheDocument();
  });
});
