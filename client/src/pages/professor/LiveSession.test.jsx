import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import LiveSession from './LiveSession';
import apiClient from '../../api/client';
import i18n from '../../i18n';

const ws = vi.hoisted(() => ({ lastEvent: null, registerRefreshHandler: vi.fn(() => () => {}) }));
const telemetry = vi.hoisted(() => ({
  recordEventReceipt: vi.fn(), recordLiveFetch: vi.fn(), scheduleUiSyncMeasurement: vi.fn(),
}));
vi.mock('../../api/client', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } }));
vi.mock('../../contexts/LiveSessionWebSocketContext', () => ({
  LiveSessionWebSocketProvider: ({ children }) => children,
  useLiveSessionWebSocket: () => ws,
}));
vi.mock('../../hooks/useLiveSessionTelemetry', () => ({ default: () => telemetry }));

function view() {
  return <MemoryRouter initialEntries={['/prof/course/course-1/session/session-1/live']}>
    <Routes><Route path="/prof/course/:courseId/session/:sessionId/live" element={<LiveSession />} /></Routes>
  </MemoryRouter>;
}

describe('Professor live activity code', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ws.lastEvent = null;
    i18n.changeLanguage('en');
    apiClient.get.mockImplementation(async (url) => {
      if (url.endsWith('/activity-share')) return { data: { enabled: true, code: 'S-ABCDEFG' } };
      if (url.endsWith('/live')) return { data: {
        session: { _id: 'session-1', name: 'Live session', status: 'running', questions: [], joined: [] },
      } };
      throw new Error(`Unexpected GET ${url}`);
    });
  });

  it('shows the code without reading sharing metadata on response deltas or live refreshes', async () => {
    const { rerender } = render(view());
    expect(await screen.findByTestId('activity-share-code')).toHaveTextContent('S-ABCDEFG');
    const sharingReads = () => apiClient.get.mock.calls.filter(([url]) => url.endsWith('/activity-share'));
    expect(sharingReads()).toHaveLength(1);
    ws.lastEvent = { event: 'session:response-added', data: { responseCount: 1, responseStats: { total: 1 } } };
    rerender(view());
    await act(async () => { await ws.registerRefreshHandler.mock.calls.at(-1)[0](); });
    expect(sharingReads()).toHaveLength(1);
  });

  it('refreshes the code on return to the window and hides it when sharing is disabled', async () => {
    render(view());
    await screen.findByTestId('activity-share-code');
    apiClient.get.mockResolvedValueOnce({ data: { enabled: true, code: 'S-HJKLMNP' } });
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.getByTestId('activity-share-code')).toHaveTextContent('S-HJKLMNP'));
    apiClient.get.mockResolvedValueOnce({ data: { enabled: false, code: null } });
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.queryByTestId('activity-share-code')).not.toBeInTheDocument());
  });

  it('does not display a code when course sharing is unavailable', async () => {
    const defaultGet = apiClient.get.getMockImplementation();
    apiClient.get.mockImplementation((url, options) => url.endsWith('/activity-share')
      ? Promise.resolve({ data: { enabled: false, code: null } }) : defaultGet(url, options));
    render(view());
    await screen.findByRole('button', { name: 'Edit session' });
    expect(screen.queryByTestId('activity-share-code')).not.toBeInTheDocument();
  });
});
