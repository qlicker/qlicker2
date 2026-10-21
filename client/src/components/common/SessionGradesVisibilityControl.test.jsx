import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SessionGradesVisibilityControl from './SessionGradesVisibilityControl';
import '../../i18n';

const ended = { status: 'done', reviewable: false, gradesVisible: false };

describe('SessionGradesVisibilityControl', () => {
  it('allows independent grade release only while review is off', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SessionGradesVisibilityControl session={ended} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Grades visible' }));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<SessionGradesVisibilityControl session={{ ...ended, gradesVisible: true }} onChange={onChange} />);
    expect(screen.getByRole('switch')).toBeChecked();
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenLastCalledWith(false);
    rerender(<SessionGradesVisibilityControl session={{ ...ended, reviewable: true }} onChange={onChange} />);
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it.each([{ status: 'running' }, { quizHasRemainingExtensions: true }])('locks publication when %j', (overrides) => {
    render(<SessionGradesVisibilityControl session={{ ...ended, ...overrides }} onChange={vi.fn()} />);
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it.each([{ anonymous: true }, { studentCreated: true }])('omits the control when %j', (overrides) => {
    render(<SessionGradesVisibilityControl session={{ ...ended, ...overrides }} onChange={vi.fn()} />);
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});
