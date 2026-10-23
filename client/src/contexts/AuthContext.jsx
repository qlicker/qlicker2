import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import apiClient, {
  setAccessToken,
  getAccessToken,
  clearAccessToken,
  refreshAccessToken,
  markExplicitLogout,
  clearExplicitLogout,
  hasExplicitLogout,
} from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const setCurrentUser = useCallback((nextUser) => {
    setUser(nextUser);
  }, []);

  const loadUser = useCallback(async () => {
    // On initial load, try refreshing via httpOnly cookie (access token is memory-only)
    if (!getAccessToken()) {
      if (hasExplicitLogout()) {
        clearAccessToken();
        setUser(null);
        setLoading(false);
        return;
      }
      try {
        await refreshAccessToken();
      } catch {
        setLoading(false);
        return;
      }
    }
    try {
      const { data } = await apiClient.get('/users/me');
      setUser(data.user);
      clearExplicitLogout();
    } catch {
      clearAccessToken();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  // Cross-tab auth sync: listen for a custom localStorage signal key.
  // We don't store the token itself; we just use a flag to notify other tabs.
  useEffect(() => {
    const handleStorageChange = (e) => {
      if (e.key === 'qlicker_auth_event') {
        if (e.newValue === 'logout') {
          markExplicitLogout();
          clearAccessToken();
          setUser(null);
        } else if (e.newValue === 'login') {
          clearExplicitLogout();
          loadUser();
        }
      }
    };
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [loadUser]);

  const login = async (email, password) => {
    const { data } = await apiClient.post('/auth/login', { email, password });
    clearExplicitLogout();
    setAccessToken(data.token);
    setUser(data.user);
    // Signal other tabs
    localStorage.setItem('qlicker_auth_event', 'login');
    localStorage.removeItem('qlicker_auth_event');
    return data.user;
  };

  const register = async (email, password, firstname, lastname) => {
    const { data } = await apiClient.post('/auth/register', { email, password, firstname, lastname });
    if (data?.token && data?.user) {
      clearExplicitLogout();
      setAccessToken(data.token);
      setUser(data.user);
      localStorage.setItem('qlicker_auth_event', 'login');
      localStorage.removeItem('qlicker_auth_event');
      return data.user;
    }
    return data;
  };

  const logout = async () => {
    try {
      await apiClient.post('/auth/logout');
    } catch { /* ignore */ }
    markExplicitLogout();
    clearAccessToken();
    setUser(null);
    // Signal other tabs
    localStorage.setItem('qlicker_auth_event', 'logout');
    localStorage.removeItem('qlicker_auth_event');
  };

  const value = { user, loading, login, register, logout, loadUser, setCurrentUser };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
