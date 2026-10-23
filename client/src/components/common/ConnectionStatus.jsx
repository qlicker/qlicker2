import { useState, useEffect, useCallback, useRef } from 'react';
import { Alert, Collapse } from '@mui/material';
import { useTranslation } from 'react-i18next';
import apiClient from '../../api/client';
import { isRequestCanceled } from '../../utils/requestCancellation';

const POLL_INTERVAL = 15000;
const FAILURE_THRESHOLD = 2;

export default function ConnectionStatus() {
  const { t } = useTranslation();
  const [isConnected, setIsConnected] = useState(true);
  const intervalRef = useRef(null);
  const consecutiveFailureCountRef = useRef(0);
  const requestControllerRef = useRef(null);

  const checkConnection = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    if (!navigator.onLine) {
      consecutiveFailureCountRef.current = FAILURE_THRESHOLD;
      setIsConnected(false);
      return;
    }

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    try {
      await apiClient.get('/health', { timeout: 5000, signal: controller.signal });
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
      consecutiveFailureCountRef.current = 0;
      setIsConnected(true);
    } catch (err) {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
      if (isRequestCanceled(err) || controller.signal.aborted) return;
      consecutiveFailureCountRef.current += 1;
      if (consecutiveFailureCountRef.current >= FAILURE_THRESHOLD) {
        setIsConnected(false);
      }
    }
  }, []);

  useEffect(() => {
    checkConnection();
    intervalRef.current = setInterval(checkConnection, POLL_INTERVAL);

    const handleOnline = () => checkConnection();
    const handleOffline = () => setIsConnected(false);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') checkConnection();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      clearInterval(intervalRef.current);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [checkConnection]);

  return (
    <Collapse in={!isConnected}>
      <Alert severity="warning" sx={{ borderRadius: 0 }}>
        {t('connection.serverUnavailable')}
      </Alert>
    </Collapse>
  );
}
