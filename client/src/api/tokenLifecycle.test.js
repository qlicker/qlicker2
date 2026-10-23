import { describe, expect, it } from 'vitest';
import {
  TOKEN_REFRESH_SKEW_MS,
  decodeJwtPayload,
  getRefreshDelayMs,
  getTokenExpiryMs,
  isTokenExpiringSoon,
} from './tokenLifecycle';

function buildToken(payload) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encode = (value) => Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  return `${encode(header)}.${encode(payload)}.signature`;
}

describe('tokenLifecycle', () => {
  it('decodes JWT payloads using base64url segments', () => {
    const token = buildToken({ sub: 'user-1', exp: 1234 });

    expect(decodeJwtPayload(token)).toEqual({ sub: 'user-1', exp: 1234 });
  });

  it('returns null for malformed tokens', () => {
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(getTokenExpiryMs('still-not-a-jwt')).toBeNull();
  });

  it('detects when a token is close to expiry', () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const expiringSoon = buildToken({ exp: Math.floor((nowMs + TOKEN_REFRESH_SKEW_MS - 1) / 1000) });
    const healthy = buildToken({ exp: Math.floor((nowMs + TOKEN_REFRESH_SKEW_MS + 5 * 60 * 1000) / 1000) });

    expect(isTokenExpiringSoon(expiringSoon, { nowMs })).toBe(true);
    expect(isTokenExpiringSoon(healthy, { nowMs })).toBe(false);
  });

  it('calculates the proactive refresh delay from the expiry time', () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const token = buildToken({ exp: Math.floor((nowMs + 10 * 60 * 1000) / 1000) });

    expect(getRefreshDelayMs(token, { nowMs })).toBe((10 * 60 * 1000) - TOKEN_REFRESH_SKEW_MS);
  });

  it('uses a minimum delay when the token is already inside the refresh window', () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const token = buildToken({ exp: Math.floor((nowMs + 30 * 1000) / 1000) });

    expect(getRefreshDelayMs(token, { nowMs, minDelayMs: 2500 })).toBe(2500);
  });
});
