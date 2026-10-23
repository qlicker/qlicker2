import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SpeedGradingModal from './SpeedGradingModal';
import i18n from '../../i18n';

vi.mock('../../api/client', () => ({
  default: {
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('../questions/StudentRichTextEditor', () => ({
  default: ({
    value,
    onChange,
    ariaLabel,
    disabled,
  }) => (
    <textarea
      aria-label={ariaLabel || 'feedback'}
      value={value}
      disabled={disabled}
      onChange={(event) => {
        const nextValue = event.target.value;
        onChange?.({ html: nextValue, plainText: nextValue });
      }}
    />
  ),
  MathPreview: () => null,
}));

function buildRows() {
  return [
    {
      studentId: 'student-a',
      displayName: 'Ada Lovelace',
      email: 'ada@example.edu',
      gradeId: 'grade-1',
      mark: { questionId: 'q-sa', points: null, outOf: 5, needsGrading: true, feedback: '' },
      responseSummary: { displayText: 'Because it works.', filterText: 'because it works', richHtml: '' },
      latestResponse: { attempt: 1, answer: 'Because it works.' },
      rowNeedsGrading: true,
    },
    {
      studentId: 'student-b',
      displayName: 'Grace Hopper',
      email: 'grace@example.edu',
      gradeId: 'grade-2',
      mark: { questionId: 'q-sa', points: 3, outOf: 5, needsGrading: false, feedback: '<p>Nice</p>' },
      responseSummary: { displayText: 'Debugging matters.', filterText: 'debugging matters', richHtml: '<p>Debugging matters.</p>' },
      latestResponse: { attempt: 1, answer: 'Debugging matters.' },
      rowNeedsGrading: false,
    },
    {
      studentId: 'student-c',
      displayName: 'Alan Turing',
      email: 'alan@example.edu',
      gradeId: 'grade-3',
      mark: { questionId: 'q-sa', points: 2, outOf: 5, needsGrading: true, feedback: '' },
      responseSummary: { displayText: 'Computable.', filterText: 'computable', richHtml: '' },
      latestResponse: { attempt: 1, answer: 'Computable.' },
      rowNeedsGrading: true,
    },
  ];
}

describe('SpeedGradingModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage('en');
  });

  it('renders student name and position indicator', async () => {
    const rows = buildRows();
    render(
      <SpeedGradingModal
        open
        onClose={vi.fn()}
        rows={rows}
        initialIndex={0}
        activeQuestionId="q-sa"
        onSaveGrade={vi.fn()}
      />
    );

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  it('shows the student response text', () => {
    const rows = buildRows();
    render(
      <SpeedGradingModal
        open
        onClose={vi.fn()}
        rows={rows}
        initialIndex={0}
        activeQuestionId="q-sa"
        onSaveGrade={vi.fn()}
      />
    );

    expect(screen.getByText('Because it works.')).toBeInTheDocument();
  });

  it('navigates to next student when Next is clicked', async () => {
    const rows = buildRows();
    render(
      <SpeedGradingModal
        open
        onClose={vi.fn()}
        rows={rows}
        initialIndex={0}
        activeQuestionId="q-sa"
        onSaveGrade={vi.fn()}
      />
    );

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => {
      expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
      expect(screen.getByText('2 of 3')).toBeInTheDocument();
    });
  });

  it('navigates to previous student when Previous is clicked', async () => {
    const rows = buildRows();
    render(
      <SpeedGradingModal
        open
        onClose={vi.fn()}
        rows={rows}
        initialIndex={1}
        activeQuestionId="q-sa"
        onSaveGrade={vi.fn()}
      />
    );

    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /previous/i }));

    await waitFor(() => {
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
      expect(screen.getByText('1 of 3')).toBeInTheDocument();
    });
  });

  it('disables Previous on first item and Next on last item', () => {
    const rows = buildRows();
    render(
      <SpeedGradingModal
        open
        onClose={vi.fn()}
        rows={rows}
        initialIndex={0}
        activeQuestionId="q-sa"
        onSaveGrade={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /next/i })).not.toBeDisabled();
  });

  it('calls onSaveGrade with points and feedback when Save is clicked', async () => {
    const onSaveGrade = vi.fn().mockResolvedValue();
    const rows = buildRows();
    render(
      <SpeedGradingModal
        open
        onClose={vi.fn()}
        rows={rows}
        initialIndex={1}
        activeQuestionId="q-sa"
        onSaveGrade={onSaveGrade}
      />
    );

    // Grace Hopper has points=3, change to 4
    const pointsInput = screen.getByRole('spinbutton', { name: /points/i });
    fireEvent.change(pointsInput, { target: { value: '4' } });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(onSaveGrade).toHaveBeenCalledTimes(1);
      expect(onSaveGrade).toHaveBeenCalledWith(
        rows[1],
        expect.objectContaining({ points: 4, feedback: '<p>Nice</p>' })
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Alan Turing')).toBeInTheDocument();
      expect(screen.getByText('3 of 3')).toBeInTheDocument();
    });
  });

  it('preserves points when only feedback is changed before saving', async () => {
    const onSaveGrade = vi.fn().mockResolvedValue();
    const rows = buildRows();
    render(
      <SpeedGradingModal
        open
        onClose={vi.fn()}
        rows={rows}
        initialIndex={1}
        activeQuestionId="q-sa"
        onSaveGrade={onSaveGrade}
      />
    );

    fireEvent.change(screen.getByRole('textbox', { name: /feedback/i }), {
      target: { value: 'Updated feedback text' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(onSaveGrade).toHaveBeenCalledWith(
        rows[1],
        { points: 3, feedback: 'Updated feedback text' }
      );
    });
  });

  it('calls onClose when Close is clicked', () => {
    const onClose = vi.fn();
    const rows = buildRows();
    render(
      <SpeedGradingModal
        open
        onClose={onClose}
        rows={rows}
        initialIndex={0}
        activeQuestionId="q-sa"
        onSaveGrade={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focuses the points input when the modal opens', async () => {
    const rows = buildRows();
    render(
      <SpeedGradingModal
        open
        onClose={vi.fn()}
        rows={rows}
        initialIndex={0}
        activeQuestionId="q-sa"
        onSaveGrade={vi.fn()}
      />
    );

    const pointsInput = screen.getByRole('spinbutton', { name: /points/i });
    await waitFor(() => {
      expect(pointsInput).toHaveFocus();
    });
  });

  it('returns focus to the points input after moving to the next student', async () => {
    const rows = buildRows();
    render(
      <SpeedGradingModal
        open
        onClose={vi.fn()}
        rows={rows}
        initialIndex={0}
        activeQuestionId="q-sa"
        onSaveGrade={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /next/i }));

    const pointsInput = await screen.findByRole('spinbutton', { name: /points/i });
    await waitFor(() => {
      expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
      expect(pointsInput).toHaveFocus();
    });
  });

  it('uses Enter as Save + Next and keeps current student when parent rows refresh', async () => {
    const onSaveGrade = vi.fn().mockResolvedValue();
    const rows = buildRows();
    const { rerender } = render(
      <SpeedGradingModal
        open
        onClose={vi.fn()}
        rows={rows}
        initialIndex={0}
        activeQuestionId="q-sa"
        onSaveGrade={onSaveGrade}
      />
    );

    const pointsInput = screen.getByRole('spinbutton', { name: /points/i });
    fireEvent.change(pointsInput, { target: { value: '5' } });
    fireEvent.keyDown(pointsInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() => {
      expect(onSaveGrade).toHaveBeenCalledTimes(1);
      expect(onSaveGrade).toHaveBeenCalledWith(
        rows[0],
        expect.objectContaining({ points: 5 })
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
      expect(screen.getByText('2 of 3')).toBeInTheDocument();
    });

    rerender(
      <SpeedGradingModal
        open
        onClose={vi.fn()}
        rows={buildRows()}
        initialIndex={0}
        activeQuestionId="q-sa"
        onSaveGrade={onSaveGrade}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
      expect(screen.getByText('2 of 3')).toBeInTheDocument();
    });
  });

  it('does not render when rows are empty', () => {
    const { container } = render(
      <SpeedGradingModal
        open
        onClose={vi.fn()}
        rows={[]}
        initialIndex={0}
        activeQuestionId="q-sa"
        onSaveGrade={vi.fn()}
      />
    );

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
