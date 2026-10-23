import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LiveSessionPanelNavigation from './LiveSessionPanelNavigation';
import i18n from '../../i18n';

function mockMatchMedia(matches) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('LiveSessionPanelNavigation', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
  });

  it('renders tabs on wider screens', () => {
    mockMatchMedia(false);
    const onChange = vi.fn();

    render(
      <LiveSessionPanelNavigation
        value="question"
        onChange={onChange}
        ariaLabel="Live session panels"
        tabs={[
          { value: 'question', label: 'Controls' },
          { value: 'chat', label: 'Chat' },
        ]}
      />
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(onChange).toHaveBeenCalledWith('chat');
  });

  it('renders a dropdown on narrow screens', () => {
    mockMatchMedia(true);
    const onChange = vi.fn();

    render(
      <LiveSessionPanelNavigation
        value="question"
        onChange={onChange}
        ariaLabel="Live session panels"
        tabs={[
          { value: 'question', label: 'Controls' },
          { value: 'chat', label: 'Chat' },
        ]}
      />
    );

    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Chat' }));

    expect(onChange).toHaveBeenCalledWith('chat');
  });
});
