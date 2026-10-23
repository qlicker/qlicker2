import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import DateTimePreferenceField from './DateTimePreferenceField';

function ControlledDateTimePreferenceField({
  initialValue,
  ...props
}) {
  const [value, setValue] = useState(initialValue);

  return (
    <>
      <DateTimePreferenceField
        value={value}
        onChange={setValue}
        {...props}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

function renderField(props = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ControlledDateTimePreferenceField
        initialValue="2026-04-05T13:07"
        {...props}
      />
    </I18nextProvider>
  );
}

async function selectOption(label, option) {
  fireEvent.mouseDown(screen.getByLabelText(label));
  const listbox = await screen.findByRole('listbox');
  fireEvent.click(within(listbox).getByRole('option', { name: String(option) }));
}

describe('DateTimePreferenceField', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
  });

  it('updates controlled local date-time values in 24-hour mode', async () => {
    renderField();

    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: '2026-04-06' },
    });
    expect(screen.getByTestId('value')).toHaveTextContent('2026-04-06T13:07');

    await selectOption('Hour', '15');
    expect(screen.getByTestId('value')).toHaveTextContent('2026-04-06T15:07');

    await selectOption('Minute', '45');
    expect(screen.getByTestId('value')).toHaveTextContent('2026-04-06T15:45');
  });

  it('converts meridiem changes back to 24-hour values in 12-hour mode', async () => {
    renderField({ use24Hour: false });

    await selectOption('Period', 'AM');
    expect(screen.getByTestId('value')).toHaveTextContent('2026-04-05T01:07');

    await selectOption('Hour', '12');
    expect(screen.getByTestId('value')).toHaveTextContent('2026-04-05T00:07');
  });

  it('falls back to the minimum date-time parts when the current value is empty', () => {
    renderField({
      initialValue: '',
      min: '2026-09-14T09:30',
    });

    expect(screen.getByLabelText('Date')).toHaveValue('2026-09-14');
    expect(screen.getByLabelText('Date')).toHaveAttribute('min', '2026-09-14');
    expect(screen.getByLabelText('Hour')).toHaveTextContent('09');
    expect(screen.getByLabelText('Minute')).toHaveTextContent('30');
  });
});
