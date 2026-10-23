const MIME_TYPES_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function encodeStorageKey(key = '') {
  return encodeURIComponent(String(key || '')).replace(/%2F/g, '/');
}

export function toUploadsUrl(key = '') {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return '';
  return `/uploads/${encodeStorageKey(normalizedKey)}`;
}

export function extractStorageKeyFromUploadsUrl(value = '') {
  const rawValue = String(value || '').trim();
  if (!rawValue) return '';

  const extractFromPathname = (pathname = '') => {
    if (!pathname.startsWith('/uploads/')) return '';
    const rawKey = pathname.slice('/uploads/'.length);
    if (!rawKey) return '';
    return rawKey
      .split('/')
      .filter(Boolean)
      .map((segment) => safeDecodeURIComponent(segment))
      .join('/');
  };

  try {
    const parsed = rawValue.startsWith('/')
      ? new URL(rawValue, 'http://localhost')
      : new URL(rawValue);
    return extractFromPathname(parsed.pathname);
  } catch {
    const stripped = rawValue.split('?')[0].split('#')[0];
    return extractFromPathname(stripped);
  }
}

export function normalizeRequestedStorageKey(rawKey = '') {
  const key = String(rawKey || '').trim().replace(/^\/+/, '');
  if (!key || key.includes('\\') || key.includes('\0')) {
    return '';
  }

  const segments = key.split('/').filter(Boolean);
  if (segments.length === 0) {
    return '';
  }

  const decodedSegments = segments.map((segment) => safeDecodeURIComponent(segment));
  if (decodedSegments.some((segment) => segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\0'))) {
    return '';
  }

  return decodedSegments.join('/');
}

export function guessImageContentTypeFromKey(key = '') {
  const match = String(key || '').toLowerCase().match(/\.[a-z0-9]+$/);
  if (!match) return 'application/octet-stream';
  return MIME_TYPES_BY_EXTENSION[match[0]] || 'application/octet-stream';
}
