import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import SessionSelectorDialog from './SessionSelectorDialog';

const sessions = [
  { _id: 'session-1', name: 'Quiz Alpha', status: 'hidden' },
  { _id: 'session-2', name: 'Quiz Beta', status: 'visible' },
  { _id: 'session-3', name: 'Lecture Gamma', status: 'done' },
];

function SessionSelectorHarness({ onConfirm = vi.fn() } = {}) {
  const [open, setOpen] = useState(true);
  const [selectedIds, setSelectedIds] = useState(['session-3']);

  return (
    <>
      <SessionSelectorDialog
        open={open}
        title="Select sessions"
        sessions={sessions}
        selectedIds={selectedIds}
        onChange={setSelectedIds}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          onConfirm(selectedIds);
          setOpen(false);
        }}
        confirmLabel="Show table"
      />
      <button type="button" onClick={() => setOpen(true)}>Reopen</button>
      <output data-testid="selected-ids">{selectedIds.join(',')}</output>
    </>
  );
}

function renderHarness(options = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SessionSelectorHarness {...options} />
    </I18nextProvider>
  );
}

describe('SessionSelectorDialog', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
  });

  it('selects only filtered sessions when select-all is used', async () => {
    renderHarness();

    fireEvent.change(screen.getByRole('textbox', { name: /search sessions/i }), {
      target: { value: 'Quiz' },
    });

    expect(screen.getByText('Quiz Alpha')).toBeInTheDocument();
    expect(screen.getByText('Quiz Beta')).toBeInTheDocument();
    expect(screen.queryByText('Lecture Gamma')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Toggle selection for Quiz Alpha' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /select all \(2\)/i }));

    await waitFor(() => {
      expect(screen.getByTestId('selected-ids')).toHaveTextContent('session-3,session-1,session-2');
    });
  });

  it('clears the search filter when the dialog closes and reopens', async () => {
    const onConfirm = vi.fn();
    renderHarness({ onConfirm });

    fireEvent.change(screen.getByRole('textbox', { name: /search sessions/i }), {
      target: { value: 'Gamma' },
    });
    expect(screen.queryByText('Quiz Alpha')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /search sessions/i })).toHaveValue('');
    });
    expect(screen.getByText('Quiz Alpha')).toBeInTheDocument();
    expect(screen.getByText('Lecture Gamma')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show table' }));
    expect(onConfirm).toHaveBeenCalledWith(['session-3']);
  });
});
