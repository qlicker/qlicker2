import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import apiClient from '../api/client';
import { useLiveSessionWebSocket } from '../contexts/LiveSessionWebSocketContext';
import useLiveSessionTelemetry from './useLiveSessionTelemetry';
import { applyLiveResponseAddedDelta } from '../utils/responses';
import {
  applyCurrentQuestionUpdate, applyQuestionChanged, applyVisibilityChanged,
  applyAttemptChanged, applyJoinCodeChanged, applyVisualizationChanged,
} from '../utils/liveSessionUpdates';

export default function useLiveSessionData({ sessionId, role, onChatEvent }) {
  const { t } = useTranslation();
  const { lastEvent, registerRefreshHandler, subscribe, transport } = useLiveSessionWebSocket();
  const { recordEventReceipt, recordLiveFetch, scheduleUiSyncMeasurement } = useLiveSessionTelemetry({ sessionId, role, transport });
  const [liveData, setLiveData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const handledEventRef = useRef(null);
  const pendingFetchRef = useRef(null);
  const requestIdRef = useRef(0);
  const chatHandlerRef = useRef(onChatEvent);
  chatHandlerRef.current = onChatEvent;

  const fetchLive = useCallback(async (syncContext = null) => {
    const requestId = ++requestIdRef.current;
    const pending = { updates: [] };
    pendingFetchRef.current = pending;
    const startedAtMs = Date.now();
    try {
      const { data } = await apiClient.get(`/sessions/${sessionId}/live`, role === 'presentation'
        ? { params: { view: 'presentation', includeJoinedStudents: false } } : undefined);
      if (requestId !== requestIdRef.current) return;
      const fetchMeasurement = recordLiveFetch({
        startedAtMs,
        completedAtMs: Date.now(),
        success: true,
        transportOverride: syncContext?.transport,
      });
      setLiveData(pending.updates.reduce((snapshot, update) => update(snapshot), data));
      // Polling and reconnect recovery must refresh chat as well as the question.
      chatHandlerRef.current?.();
      scheduleUiSyncMeasurement({
        fetchStartedAtMs: fetchMeasurement?.startedAtMs || startedAtMs,
        emittedAtMs: syncContext?.emittedAtMs,
        receivedAtMs: syncContext?.receivedAtMs,
        success: true,
        transportOverride: syncContext?.transport,
      });
      setError(null);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      recordLiveFetch({
        startedAtMs,
        completedAtMs: Date.now(),
        success: false,
        transportOverride: syncContext?.transport,
      });
      setError(err.response?.data?.message || t(role === 'presentation' ? 'professor.secondDesktop.failedLoadLiveSession' : 'student.liveSession.failedLoadLiveSession'));
    } finally {
      if (requestId === requestIdRef.current) {
        pendingFetchRef.current = null;
        setLoading(false);
      }
    }
  }, [recordLiveFetch, scheduleUiSyncMeasurement, sessionId, role, t]);

  useEffect(() => { fetchLive(); }, [fetchLive]);

  useEffect(() => registerRefreshHandler(fetchLive), [fetchLive, registerRefreshHandler]);

  const fetchThrottleRef = useRef(null);
  const scheduleFetchLive = useCallback((syncContext = null) => {
    if (fetchThrottleRef.current) return;
    fetchThrottleRef.current = setTimeout(() => {
      fetchThrottleRef.current = null;
      fetchLive(syncContext);
    }, 2000);
  }, [fetchLive]);

  // Keep deltas received during an HTTP refresh so its older snapshot cannot
  // roll the display back. Replaying local patches avoids extra live fetches.
  const applyUpdate = useCallback((update) => {
    pendingFetchRef.current?.updates.push(update);
    setLiveData(update);
  }, []);

  const handleEvent = useCallback((lastEvent) => {
    if (!lastEvent || handledEventRef.current === lastEvent) return;
    handledEventRef.current = lastEvent;

    const syncContext = recordEventReceipt({
      emittedAt: lastEvent?.data?.emittedAt,
      receivedAtMs: lastEvent?.receivedAtMs,
      success: true,
    });
    const { event } = lastEvent;
    let data = lastEvent.data;
    if (role === 'presentation' && [
      'session:question-changed', 'session:visibility-changed',
      'session:question-updated', 'session:response-added',
    ].includes(event)) {
      // Instructor sockets also serve the controls. Only consume the public
      // snapshot, never their named responses or unrevealed answer fields.
      if (!Object.prototype.hasOwnProperty.call(data || {}, 'audience')) {
        if (event === 'session:response-added') scheduleFetchLive(syncContext);
        else fetchLive(syncContext);
        return;
      }
      if (!data.audience) return;
      data = { ...data.audience, sessionId: data.sessionId, questionId: data.questionId };
    }
    switch (event) {
      // Students receive this only while joined and live stats are visible.
      case 'session:response-added':
        if (data?.responseStats || data?.response || (data?.anonymous && data?.responseCount !== undefined)) {
          applyUpdate((prev) => applyLiveResponseAddedDelta(prev, data));
          scheduleUiSyncMeasurement({
            emittedAtMs: syncContext?.emittedAtMs,
            receivedAtMs: syncContext?.receivedAtMs,
            success: true,
            transportOverride: syncContext?.transport,
          });
        } else {
          scheduleFetchLive(syncContext);
        }
        break;
      case 'session:question-changed':
        if (Object.prototype.hasOwnProperty.call(data || {}, 'question')) {
          applyUpdate((prev) => applyQuestionChanged(prev, data));
          // A complete question-change snapshot includes aggregate data when
          // stats are visible. Recover immediately from an older/incomplete
          // server event instead of waiting for a focus or click refresh.
          if (data?.showStats && !data?.responseStats) {
            fetchLive(syncContext);
          }
          scheduleUiSyncMeasurement({
            emittedAtMs: syncContext?.emittedAtMs,
            receivedAtMs: syncContext?.receivedAtMs,
            success: true,
            transportOverride: syncContext?.transport,
          });
        } else {
          fetchLive(syncContext);
        }
        break;
      case 'session:status-changed':
      case 'session:metadata-changed':
        fetchLive(syncContext);
        break;
      case 'session:visibility-changed':
        if (Object.prototype.hasOwnProperty.call(data || {}, 'question')) {
          applyUpdate((prev) => applyVisibilityChanged(prev, data));
          scheduleUiSyncMeasurement({
            emittedAtMs: syncContext?.emittedAtMs,
            receivedAtMs: syncContext?.receivedAtMs,
            success: true,
            transportOverride: syncContext?.transport,
          });
        } else {
          fetchLive(syncContext);
        }
        break;
      case 'session:question-updated':
        applyUpdate((prev) => applyCurrentQuestionUpdate(prev, data));
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:attempt-changed':
        applyUpdate((prev) => applyAttemptChanged(prev, data));
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:join-code-changed':
        applyUpdate((prev) => applyJoinCodeChanged(prev, data));
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:participant-admitted':
        fetchLive(syncContext);
        break;
      case 'session:chat-settings-changed':
        applyUpdate((prev) => prev ? {
          ...prev,
          session: {
            ...prev.session,
            chatEnabled: data?.chatEnabled ?? prev.session?.chatEnabled,
            richTextChatEnabled: data?.richTextChatEnabled ?? prev.session?.richTextChatEnabled,
          },
        } : prev);
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:chat-updated':
        chatHandlerRef.current?.(data);
        break;
      case 'session:word-cloud-updated':
        applyUpdate((prev) => applyVisualizationChanged(prev, data, 'wordCloudData'));
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      case 'session:histogram-updated':
        applyUpdate((prev) => applyVisualizationChanged(prev, data, 'histogramData'));
        scheduleUiSyncMeasurement({
          emittedAtMs: syncContext?.emittedAtMs,
          receivedAtMs: syncContext?.receivedAtMs,
          success: true,
          transportOverride: syncContext?.transport,
        });
        break;
      default:
        break;
    }
  }, [
    fetchLive,
    applyUpdate,
    role,
    recordEventReceipt,
    scheduleFetchLive,
    scheduleUiSyncMeasurement,
  ]);

  useEffect(() => subscribe?.(handleEvent), [subscribe, handleEvent]);
  useEffect(() => {
    if (!subscribe) handleEvent(lastEvent);
  }, [subscribe, handleEvent, lastEvent]);

  useEffect(() => () => {
    requestIdRef.current += 1;
    if (fetchThrottleRef.current) clearTimeout(fetchThrottleRef.current);
    fetchThrottleRef.current = null;
  }, []);

  return { liveData, setLiveData, loading, error, fetchLive, transport };
}
