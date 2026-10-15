import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import useLiveSessionData from './useLiveSessionData';
import apiClient from '../api/client';

const socket = vi.hoisted(() => ({
  handler: null,
  subscribe: vi.fn((handler) => { socket.handler = handler; return () => { socket.handler = null; }; }),
  registerRefreshHandler: vi.fn(() => () => {}),
}));
const telemetry = vi.hoisted(() => ({
  recordEventReceipt: vi.fn(), recordLiveFetch: vi.fn(), scheduleUiSyncMeasurement: vi.fn(),
}));
vi.mock('../api/client', () => ({ default: { get: vi.fn() } }));
vi.mock('../contexts/LiveSessionWebSocketContext', () => ({
  useLiveSessionWebSocket: () => ({ ...socket, transport: 'websocket' }),
}));
vi.mock('./useLiveSessionTelemetry', () => ({ default: () => telemetry }));

const initial = {
  session: { _id: 's1', currentQuestion: 'q1', status: 'running' },
  currentQuestion: { _id: 'q1', type: 0, content: 'First question' },
  currentAttempt: { number: 1 }, showStats: false, showCorrect: false,
};
function emit(event, data) { socket.handler({ event, data }); }

beforeEach(() => {
  vi.clearAllMocks();
  apiClient.get.mockResolvedValue({ data: initial });
});

describe('shared student/presentation live state', () => {
  it.each(['student', 'presentation'])('applies a jump and visibility delta received in the same render for %s', async (role) => {
    const { result } = renderHook(() => useLiveSessionData({ sessionId: 's1', role, onChatEvent: vi.fn() }));
    await waitFor(() => expect(result.current.liveData).toEqual(initial));
    const jump = { questionId: 'q3', question: { _id: 'q3', content: 'Third question' }, currentAttempt: { number: 2 }, showStats: false };
    const visibility = { ...jump, showStats: true, responseStats: { type: 'distribution', total: 1, distribution: [{ count: 1 }] } };
    act(() => {
      emit('session:question-changed', role === 'student' ? jump : { questionId: 'q3', audience: jump });
      emit('session:visibility-changed', role === 'student' ? visibility : { questionId: 'q3', audience: visibility });
    });
    expect(result.current.liveData).toMatchObject({
      session: { currentQuestion: 'q3' }, currentQuestion: { _id: 'q3' },
      currentAttempt: { number: 2 }, showStats: true, responseStats: { total: 1 },
    });
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('ignores private instructor responses and recovers incomplete control events from the presentation API', async () => {
    const { result } = renderHook(() => useLiveSessionData({ sessionId: 's1', role: 'presentation', onChatEvent: vi.fn() }));
    await waitFor(() => expect(result.current.liveData).toEqual(initial));
    act(() => emit('session:response-added', { questionId: 'q1', response: { studentName: 'Private Student' }, audience: null }));
    expect(result.current.liveData).toEqual(initial);
    act(() => emit('session:visibility-changed', { questionId: 'q1', stats: true }));
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
    expect(apiClient.get).toHaveBeenLastCalledWith('/sessions/s1/live', { params: { view: 'presentation', includeJoinedStudents: false } });
    expect(JSON.stringify(result.current.liveData)).not.toContain('Private Student');
  });

  it('never lets an older HTTP response overwrite a newer navigation event', async () => {
    let resolveOld;
    const { result } = renderHook(() => useLiveSessionData({ sessionId: 's1', role: 'student', onChatEvent: vi.fn() }));
    await waitFor(() => expect(result.current.liveData).toEqual(initial));
    apiClient.get.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const latest = { ...initial, currentQuestion: { _id: 'q3' }, session: { ...initial.session, currentQuestion: 'q3' } };
    apiClient.get.mockResolvedValue({ data: latest });
    act(() => { void result.current.fetchLive(); });
    act(() => emit('session:question-changed', { questionId: 'q3', question: latest.currentQuestion }));
    await act(async () => { resolveOld({ data: initial }); });
    await waitFor(() => expect(result.current.liveData.currentQuestion._id).toBe('q3'));
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('keeps a closed join period closed when a delayed code-only rotation arrives', async () => {
    const { result } = renderHook(() => useLiveSessionData({ sessionId: 's1', role: 'presentation' }));
    await waitFor(() => expect(result.current.liveData).toEqual(initial));
    act(() => {
      emit('session:join-code-changed', { joinCodeEnabled: true, joinCodeActive: true, currentJoinCode: '123456' });
      emit('session:join-code-changed', { joinCodeEnabled: true, joinCodeActive: false, currentJoinCode: '' });
      emit('session:join-code-changed', { currentJoinCode: '654321' });
    });
    expect(result.current.liveData.session).toMatchObject({ joinCodeEnabled: true, joinCodeActive: false });
    expect(result.current.liveData.currentQuestion).toEqual(initial.currentQuestion);
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('does not replay a chat event when panel callbacks change', async () => {
    const onChatEvent = vi.fn();
    const { result, rerender } = renderHook((props) => useLiveSessionData({ sessionId: 's1', role: 'presentation', ...props }), { initialProps: { onChatEvent } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(onChatEvent).toHaveBeenCalledTimes(1);
    onChatEvent.mockClear();
    act(() => emit('session:chat-updated', { changeType: 'post-created' }));
    const nextCallback = vi.fn();
    rerender({ onChatEvent: nextCallback });
    expect(onChatEvent).toHaveBeenCalledTimes(1);
    expect(nextCallback).not.toHaveBeenCalled();
  });
});

it.each(['student', 'presentation'])('handles withheld anonymous batches for %s without scheduling HTTP refreshes', async (role) => {
  const { result, unmount } = renderHook(() => useLiveSessionData({ sessionId: 's1', role }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  vi.useFakeTimers();
  try {
    const pending = { anonymous: true, questionId: 'q1', attempt: 1, responseCount: 3 };
    act(() => emit('session:response-added', role === 'student' ? pending : { questionId: 'q1', audience: pending }));
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(result.current.liveData.responseCount).toBe(3);
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});
