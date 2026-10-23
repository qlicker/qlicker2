import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { LiveSessionWebSocketProvider, useLiveSessionWebSocket } from './LiveSessionWebSocketContext';

vi.mock('../api/client', () => ({
  default: { get: vi.fn(async () => ({ data: { websocket: true } })) },
  getUsableAccessToken: vi.fn(async () => 'token'),
}));
let sockets;
beforeEach(() => {
  sockets = [];
  vi.stubGlobal('WebSocket', class {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    close = vi.fn();
    constructor() { sockets.push(this); }
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('refreshes on reconnect even in the background and delivers every delta without reopening on render', async () => {
  const refresh = vi.fn();
  const onEvent = vi.fn();
  function Consumer({ callback }) {
    const { registerRefreshHandler, subscribe } = useLiveSessionWebSocket();
    useEffect(() => registerRefreshHandler(callback), [callback, registerRefreshHandler]);
    useEffect(() => subscribe(onEvent), [subscribe]);
    return null;
  }
  const { rerender } = render(<LiveSessionWebSocketProvider sessionId="s1"><Consumer callback={refresh} /></LiveSessionWebSocketProvider>);
  await waitFor(() => expect(sockets).toHaveLength(1));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  act(() => {
    sockets[0].onopen();
    for (const event of ['session:question-changed', 'session:visibility-changed']) {
      sockets[0].onmessage({ data: JSON.stringify({ event, data: { sessionId: 's1' } }) });
    }
  });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(onEvent.mock.calls.map(([event]) => event.event)).toEqual(['session:question-changed', 'session:visibility-changed']);
  const nextRefresh = vi.fn();
  rerender(<LiveSessionWebSocketProvider sessionId="s1"><Consumer callback={nextRefresh} /></LiveSessionWebSocketProvider>);
  expect(sockets).toHaveLength(1);
  vi.useFakeTimers();
  act(() => sockets[0].onclose());
  await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
  expect(sockets).toHaveLength(2);
  act(() => sockets[1].onopen());
  expect(nextRefresh).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
});
