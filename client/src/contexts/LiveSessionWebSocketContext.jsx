import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import apiClient, { getUsableAccessToken } from '../api/client';
import { closeWebSocketQuietly } from '../utils/liveSocket';

const LiveSessionWebSocketContext = createContext(null);

function buildWebsocketUrl(token) {
  const encodedToken = encodeURIComponent(token);
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws?token=${encodedToken}`;
}

export function LiveSessionWebSocketProvider({ sessionId, children }) {
  const [lastEvent, setLastEvent] = useState(null);
  const [transport, setTransport] = useState('connecting');
  const eventIdRef = useRef(0);
  const refreshHandlerRef = useRef(null);
  const eventHandlersRef = useRef(new Set());

  const subscribe = useCallback((handler) => {
    eventHandlersRef.current.add(handler);
    return () => eventHandlersRef.current.delete(handler);
  }, []);

  const registerRefreshHandler = useCallback((handler) => {
    refreshHandlerRef.current = handler;
    return () => {
      if (refreshHandlerRef.current === handler) {
        refreshHandlerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let ws = null;
    let reconnectTimer = null;
    let pollingTimer = null;
    let closed = false;

    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      refreshHandlerRef.current?.();
    };

    const startPolling = () => {
      if (pollingTimer || closed) return;
      setTransport('polling');
      pollingTimer = setInterval(refresh, 3000);
    };

    const stopPolling = () => {
      if (!pollingTimer) return;
      clearInterval(pollingTimer);
      pollingTimer = null;
    };

    const connect = async () => {
      if (closed) return;
      const latestToken = await getUsableAccessToken({ refreshIfMissing: true, refreshIfExpiring: true });
      if (closed) return;
      if (!latestToken) {
        startPolling();
        reconnectTimer = setTimeout(() => { void connect(); }, 2500);
        return;
      }

      try {
        ws = new WebSocket(buildWebsocketUrl(latestToken));
      } catch {
        startPolling();
        reconnectTimer = setTimeout(() => { void connect(); }, 2500);
        return;
      }

      ws.onopen = () => {
        stopPolling();
        setTransport('websocket');
        // Recover changes missed before the handshake or during a disconnect,
        // including when the presentation is on another display/background tab.
        refreshHandlerRef.current?.();
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          const evt = message?.event;
          const data = message?.data;
          if (!evt || String(data?.sessionId || '') !== String(sessionId)) return;

          const receivedAtMs = Date.now();
          eventIdRef.current += 1;
          const nextEvent = {
            id: eventIdRef.current,
            event: evt,
            data,
            receivedAtMs,
            receivedAt: new Date(receivedAtMs).toISOString(),
          };
          // Deliver every delta, even when React batches several messages into
          // one render. lastEvent remains available to older consumers.
          eventHandlersRef.current.forEach((handler) => handler(nextEvent));
          setLastEvent(nextEvent);
        } catch {
          // Ignore malformed websocket payloads.
        }
      };

      ws.onclose = () => {
        if (closed) return;
        startPolling();
        reconnectTimer = setTimeout(() => { void connect(); }, 2500);
      };
    };

    const init = async () => {
      try {
        const { data } = await apiClient.get('/health');
        if (closed) return;
        if (data?.websocket === true) {
          void connect();
          return;
        }
      } catch {
        // Fall through to polling when websocket health is unavailable.
      }
      startPolling();
    };

    init();

    const handleVisibility = () => refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopPolling();
      closeWebSocketQuietly(ws);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [sessionId]);

  const value = useMemo(() => ({
    lastEvent,
    transport,
    registerRefreshHandler,
    subscribe,
  }), [lastEvent, registerRefreshHandler, subscribe, transport]);

  return (
    <LiveSessionWebSocketContext.Provider value={value}>
      {children}
    </LiveSessionWebSocketContext.Provider>
  );
}

export function useLiveSessionWebSocket() {
  const context = useContext(LiveSessionWebSocketContext);
  if (!context) {
    throw new Error('useLiveSessionWebSocket must be used within a LiveSessionWebSocketProvider');
  }
  return context;
}
