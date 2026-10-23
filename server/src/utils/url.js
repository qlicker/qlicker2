export function isSafeProfileImageUrl(value) {
  if (typeof value !== 'string') return false;

  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('//')) {
    return false;
  }

  if (trimmed.startsWith('/')) {
    if (/^\/{2,}/.test(trimmed)) {
      return false;
    }
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Returns true if `hostname` resolves to a private, loopback, or link-local
 * address that should never be reached by server-side fetches (SSRF protection).
 */
export function isPrivateHostname(hostname) {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();
  const normalized = lower.replace(/^\[/, '').replace(/\]$/, '');

  const isPrivateIpv4 = (ipv4) => {
    const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipv4);
    if (!ipv4Match) return false;

    const [a, b, c, d] = ipv4Match.slice(1).map(Number);
    if ([a, b, c, d].some((part) => part < 0 || part > 255)) return true;
    if (a === 10) return true;                           // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 127) return true;                          // 127.0.0.0/8
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local)
    if (a === 0) return true;                            // 0.0.0.0/8
    return false;
  };

  const extractMappedIpv4 = (ipv6) => {
    if (!ipv6.startsWith('::ffff:')) return '';
    const mapped = ipv6.slice('::ffff:'.length);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) {
      return mapped;
    }

    const hextets = mapped.split(':').filter(Boolean);
    if (hextets.length === 1 || hextets.length > 2) return '';
    const [high, low = '0'] = hextets;
    if (!/^[0-9a-f]{1,4}$/i.test(high) || !/^[0-9a-f]{1,4}$/i.test(low)) return '';
    const padded = `${high.padStart(4, '0')}${low.padStart(4, '0')}`;
    return [
      parseInt(padded.slice(0, 2), 16),
      parseInt(padded.slice(2, 4), 16),
      parseInt(padded.slice(4, 6), 16),
      parseInt(padded.slice(6, 8), 16),
    ].join('.');
  };

  // Loopback
  if (lower === 'localhost' || normalized === '::1' || normalized === '::') return true;
  // Cloud metadata endpoints
  if (lower === '169.254.169.254' || lower === 'metadata.google.internal') return true;
  // Common internal hostnames
  if (lower.endsWith('.internal') || lower.endsWith('.local')) return true;

  if (isPrivateIpv4(normalized)) return true;

  // IPv6 private/link-local ranges
  if (/^f[cd][0-9a-f:]*$/i.test(normalized)) return true; // fc00::/7 (ULA)
  if (/^fe[89ab][0-9a-f:]*$/i.test(normalized)) return true; // fe80::/10 (link-local)

  const mappedIpv4 = extractMappedIpv4(normalized);
  if (mappedIpv4 && isPrivateIpv4(mappedIpv4)) return true;

  return false;
}
