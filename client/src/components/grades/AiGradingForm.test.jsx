import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import AiGradingForm from './AiGradingForm';

function FormHarness() {
  const [value, setValue] = useState({});

  return (
    <AiGradingForm
      value={value}
      instructions={[]}
      onChange={setValue}
      onSaveInstruction={vi.fn()}
      onDeleteInstruction={vi.fn()}
    />
  );
}

describe('AiGradingForm', () => {
  it('keeps a new grading instruction editor open while its name is entered', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <FormHarness />
      </I18nextProvider>
    );

    fireEvent.click(screen.getAllByRole('button', { name: /create a new instruction/i })[0]);
    const name = screen.getByRole('textbox', { name: /^name$/i });
    fireEvent.change(name, { target: { value: 'Short-answer rubric' } });

    expect(name).toHaveValue('Short-answer rubric');
    expect(screen.getByRole('textbox', { name: /instructions for grading/i })).toBeInTheDocument();
  });

  it('keeps a new feedback instruction editor open while its name is entered', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <FormHarness />
      </I18nextProvider>
    );

    fireEvent.click(screen.getAllByRole('button', { name: /create a new instruction/i })[1]);
    const name = screen.getByRole('textbox', { name: /^name$/i });
    fireEvent.change(name, { target: { value: 'Constructive feedback' } });

    expect(name).toHaveValue('Constructive feedback');
    expect(screen.getByRole('textbox', { name: /instructions for feedback to student/i })).toBeInTheDocument();
  });

});
