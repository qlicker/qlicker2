import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import AiSummaryInstructionForm from './AiSummaryInstructionForm';

describe('AiSummaryInstructionForm', () => {
  it('keeps a new response-summary instruction editor open while its name is entered', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <AiSummaryInstructionForm
          instructionId=""
          instruction=""
          instructions={[]}
          onChange={vi.fn()}
          onSaveInstruction={vi.fn()}
          onDeleteInstruction={vi.fn()}
        />
      </I18nextProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /create a new instruction/i }));
    const name = screen.getByRole('textbox', { name: /^name$/i });
    fireEvent.change(name, { target: { value: 'Theme summary' } });

    expect(name).toHaveValue('Theme summary');
    expect(screen.getByRole('textbox', { name: /summary instructions/i })).toBeInTheDocument();
  });
});
