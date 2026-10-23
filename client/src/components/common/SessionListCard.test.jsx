import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import SessionListCard from './SessionListCard';

function renderCard(props = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SessionListCard
        title="Quiz 1"
        subtitle="Visible to students"
        {...props}
      />
    </I18nextProvider>
  );
}

describe('SessionListCard', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
  });

  it('routes clicks through the card body while keeping action clicks isolated', () => {
    const onClick = vi.fn();
    const actionClick = vi.fn();

    renderCard({
      onClick,
      actions: <button type="button" onClick={actionClick}>Open menu</button>,
    });

    fireEvent.click(screen.getByText('Quiz 1'));
    expect(onClick).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(actionClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders non-clickable content when disabled', () => {
    const onClick = vi.fn();

    renderCard({ onClick, disabled: true });

    expect(screen.getByText('Quiz 1').closest('button')).toBeNull();
    fireEvent.click(screen.getByText('Quiz 1'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
