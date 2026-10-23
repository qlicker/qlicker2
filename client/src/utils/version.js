const rawVersion = typeof import.meta.env.VITE_APP_VERSION === 'string'
  ? import.meta.env.VITE_APP_VERSION.trim()
  : '';

export const APP_VERSION = rawVersion || 'dev';
