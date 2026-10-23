import { useCallback, useEffect, useRef } from 'react';
import apiClient from '../api/client';

const FLUSH_INTERVAL_MS = 30000;
const MAX_BATCH_SIZE = 20;
const MAX_QUEUE_SIZE = 200;
const ALLOWED_TRANSPORTS = new Set(['websocket', 'polling', 'direct', 'unknown']);

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDurationMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.round(numeric));
}

function normalizeTransport(value) {
  return ALLOWED_TRANSPORTS.has(value) ? value : 'unknown';
}

function scheduleNextPaint(callback) {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => callback(Date.now()));
    return;
  }

  setTimeout(() => callback(Date.now()), 0);
}

export default function useLiveSessionTelemetry({ sessionId, role, transport }) {
  const queueRef = useRef([]);
  const flushTimerRef = useRef(null);
  const flushInFlightRef = useRef(false);

  const clearFlushTimer = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  }, []);

  const flushTelemetry = useCallback(async () => {
    if (!sessionId || !role || flushInFlightRef.current) return;
    if (queueRef.current.length === 0) return;

    clearFlushTimer();
    const batch = queueRef.current.splice(0, MAX_BATCH_SIZE);
    if (batch.length === 0) return;

    flushInFlightRef.current = true;
    try {
      await apiClient.post(`/sessions/${sessionId}/live-telemetry`, {
        role,
        samples: batch,
      });
    } catch {
      queueRef.current = [...batch, ...queueRef.current].slice(0, MAX_QUEUE_SIZE);
    } finally {
      flushInFlightRef.current = false;
      if (queueRef.current.length > 0) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          flushTelemetry();
        }, FLUSH_INTERVAL_MS);
      }
    }
  }, [clearFlushTimer, role, sessionId]);

  const scheduleFlush = useCallback((delayMs = FLUSH_INTERVAL_MS) => {
    if (!sessionId || !role) return;
    if (flushTimerRef.current || flushInFlightRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushTelemetry();
    }, delayMs);
  }, [flushTelemetry, role, sessionId]);

  const enqueueSample = useCallback((sample) => {
    if (!sessionId || !role) return;

    const durationMs = normalizeDurationMs(sample?.durationMs);
    if (durationMs == null) return;

    queueRef.current.push({
      metric: sample.metric,
      durationMs,
      success: sample.success !== false,
      transport: normalizeTransport(sample.transport || transport || 'unknown'),
    });

    if (queueRef.current.length > MAX_QUEUE_SIZE) {
      queueRef.current.splice(0, queueRef.current.length - MAX_QUEUE_SIZE);
    }

    if (queueRef.current.length >= MAX_BATCH_SIZE) {
      flushTelemetry();
      return;
    }

    scheduleFlush();
  }, [flushTelemetry, role, scheduleFlush, sessionId, transport]);

  const recordLiveFetch = useCallback(({
    startedAtMs,
    completedAtMs = Date.now(),
    success = true,
    transportOverride,
  }) => {
    const startedAt = toEpochMs(startedAtMs);
    const completedAt = toEpochMs(completedAtMs);
    if (startedAt == null || completedAt == null || completedAt < startedAt) return null;

    const resolvedTransport = normalizeTransport(transportOverride || transport || 'unknown');
    enqueueSample({
      metric: 'live_fetch_request_ms',
      durationMs: completedAt - startedAt,
      success,
      transport: resolvedTransport,
    });

    return {
      startedAtMs: startedAt,
      completedAtMs: completedAt,
      success,
      transport: resolvedTransport,
    };
  }, [enqueueSample, transport]);

  const recordEventReceipt = useCallback(({
    emittedAt,
    receivedAtMs = Date.now(),
    success = true,
    transportOverride,
  }) => {
    const emittedAtMs = toEpochMs(emittedAt);
    const receivedAt = toEpochMs(receivedAtMs);
    const resolvedTransport = normalizeTransport(transportOverride || transport || 'unknown');

    if (emittedAtMs != null && receivedAt != null && receivedAt >= emittedAtMs) {
      enqueueSample({
        metric: 'ws_event_delivery_ms',
        durationMs: receivedAt - emittedAtMs,
        success,
        transport: resolvedTransport,
      });
    }

    return {
      emittedAtMs,
      receivedAtMs: receivedAt,
      success,
      transport: resolvedTransport,
    };
  }, [enqueueSample, transport]);

  const scheduleUiSyncMeasurement = useCallback(({
    fetchStartedAtMs,
    emittedAtMs,
    receivedAtMs,
    success = true,
    transportOverride,
  }) => {
    const resolvedTransport = normalizeTransport(transportOverride || transport || 'unknown');
    scheduleNextPaint((appliedAtMs) => {
      const fetchStartedAt = toEpochMs(fetchStartedAtMs);
      const emittedAt = toEpochMs(emittedAtMs);
      const receivedAt = toEpochMs(receivedAtMs);

      if (fetchStartedAt != null && appliedAtMs >= fetchStartedAt) {
        enqueueSample({
          metric: 'live_fetch_apply_ms',
          durationMs: appliedAtMs - fetchStartedAt,
          success,
          transport: resolvedTransport,
        });
      }

      if (receivedAt != null && appliedAtMs >= receivedAt) {
        enqueueSample({
          metric: 'ws_event_to_dom_ms',
          durationMs: appliedAtMs - receivedAt,
          success,
          transport: resolvedTransport,
        });
      }

      if (emittedAt != null && appliedAtMs >= emittedAt) {
        enqueueSample({
          metric: 'server_emit_to_dom_ms',
          durationMs: appliedAtMs - emittedAt,
          success,
          transport: resolvedTransport,
        });
      }
    });
  }, [enqueueSample, transport]);

  useEffect(() => () => {
    clearFlushTimer();
    if (!sessionId || !role || queueRef.current.length === 0) return;

    const batch = queueRef.current.splice(0, MAX_BATCH_SIZE);
    apiClient.post(`/sessions/${sessionId}/live-telemetry`, {
      role,
      samples: batch,
    }).catch(() => {});
  }, [clearFlushTimer, role, sessionId]);

  return {
    flushTelemetry,
    recordEventReceipt,
    recordLiveFetch,
    scheduleUiSyncMeasurement,
  };
}
