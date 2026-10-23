import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Home from './Home';
import { APP_VERSION } from '../utils/version';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => ({
      'common.appName': 'Qlicker',
      'home.tagline': 'Fast feedback',
      'home.subtitle': 'Teach live',
      'home.description': 'Make class interactive.',
      'home.getStarted': 'Get Started',
      'home.motionNote': 'Motion respects `prefers-reduced-motion`.',
      'home.phoneAlt': 'App preview',
    }[key] ?? key),
  }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock('../components/common/ConnectionStatus', () => ({
  default: () => null,
}));

describe('Home', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
  });

  it('shows the app version above the motion note', () => {
    render(<Home />);

    const version = screen.getByText(APP_VERSION);
    const motionNote = screen.getByText('Motion respects `prefers-reduced-motion`.');

    expect(version).toBeInTheDocument();
    expect(motionNote).toBeInTheDocument();
    expect(version.className).toBe('homeHeroNote');
    expect(version.compareDocumentPosition(motionNote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
