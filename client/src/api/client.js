import axios from 'axios';
import { getRefreshDelayMs, isTokenExpiringSoon } from './tokenLifecycle';

// In-memory token storage — not accessible to XSS like localStorage.
// On page reload the token is lost; the first 401 triggers a refresh via the
// httpOnly cookie, which transparently restores the access token.
let accessToken = null;
let refreshRequest = null;
let accessTokenRefreshTimer = null;
const EXPLICIT_LOGOUT_KEY = 'qlicker_explicit_logout';
const PROACTIVE_REFRESH_EXEMPT_PATH_PREFIXES = [
  '/health',
  '/settings/public',
  '/auth/login',
  '/auth/register',
  '/auth/forgot-password',
  '/auth/refresh',
  '/auth/logout',
];

function safeStorage(action) {
  try {
    return action();
  } catch {
    return null;
  }
}

export function setAccessToken(token) {
  accessToken = token;
  scheduleAccessTokenRefresh(token);
}

export function getAccessToken() {
  return accessToken;
}

export function clearAccessToken() {
  accessToken = null;
  clearAccessTokenRefreshTimer();
}

export function markExplicitLogout() {
  safeStorage(() => localStorage.setItem(EXPLICIT_LOGOUT_KEY, '1'));
}

export function clearExplicitLogout() {
  safeStorage(() => localStorage.removeItem(EXPLICIT_LOGOUT_KEY));
}

export function hasExplicitLogout() {
  return safeStorage(() => localStorage.getItem(EXPLICIT_LOGOUT_KEY) === '1') === true;
}

function clearAccessTokenRefreshTimer() {
  if (accessTokenRefreshTimer) {
    window.clearTimeout(accessTokenRefreshTimer);
    accessTokenRefreshTimer = null;
  }
}

function scheduleAccessTokenRefresh(token) {
  clearAccessTokenRefreshTimer();

  if (typeof window === 'undefined' || !token) return;

  const delayMs = getRefreshDelayMs(token);
  if (!Number.isFinite(delayMs)) return;

  accessTokenRefreshTimer = window.setTimeout(async () => {
    accessTokenRefreshTimer = null;

    if (accessToken !== token || hasExplicitLogout()) return;

    try {
      await refreshAccessToken();
    } catch {
      clearAccessToken();
    }
  }, delayMs);
}

export async function refreshAccessToken() {
  if (hasExplicitLogout()) {
    throw new Error('Refresh suppressed after explicit logout');
  }
  if (!refreshRequest) {
    refreshRequest = axios.post('/api/v1/auth/refresh', {}, {
      withCredentials: true,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    }).then(({ data }) => {
      if (!data?.token) {
        throw new Error('Missing access token in refresh response');
      }
      setAccessToken(data.token);
      return data.token;
    }).finally(() => {
      refreshRequest = null;
    });
  }
  return refreshRequest;
}

export async function getUsableAccessToken({ refreshIfMissing = false, refreshIfExpiring = false } = {}) {
  if (!accessToken) {
    if (!refreshIfMissing) {
      return null;
    }
    try {
      return await refreshAccessToken();
    } catch {
      clearAccessToken();
      return null;
    }
  }

  if (refreshIfExpiring && isTokenExpiringSoon(accessToken)) {
    try {
      return await refreshAccessToken();
    } catch {
      clearAccessToken();
      return null;
    }
  }

  return accessToken;
}

function shouldBypassProactiveRefresh(url = '') {
  return PROACTIVE_REFRESH_EXEMPT_PATH_PREFIXES.some((prefix) => url.startsWith(prefix));
}

const apiClient = axios.create({
  baseURL: '/api/v1',
  withCredentials: true,
  headers: {
    'X-Requested-With': 'XMLHttpRequest',
  },
});

// Attach JWT token to every request
apiClient.interceptors.request.use(async (config) => {
  config.headers = config.headers || {};

  const requestUrl = typeof config.url === 'string' ? config.url : '';
  const usableToken = shouldBypassProactiveRefresh(requestUrl)
    ? accessToken
    : await getUsableAccessToken({ refreshIfExpiring: true });

  if (usableToken) {
    config.headers.Authorization = `Bearer ${usableToken}`;
  }
  return config;
});

// Handle 401 responses - attempt refresh or redirect to login
// Skip retry for auth endpoints (login/register) so error messages display properly
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const isAuthEndpoint = originalRequest?.url?.startsWith('/auth/');
    if (error.response?.status === 401 && !originalRequest._retry && !isAuthEndpoint) {
      originalRequest._retry = true;
      try {
        const refreshedToken = await refreshAccessToken();
        originalRequest.headers = originalRequest.headers || {};
        originalRequest.headers.Authorization = `Bearer ${refreshedToken}`;
        return apiClient(originalRequest);
      } catch {
        clearAccessToken();
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default apiClient;
