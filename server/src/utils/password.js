import { hash, verify, Algorithm, Version } from '@node-rs/argon2';

const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  version: Version.V0x13,
  // OWASP-oriented baseline tuned for interactive login.
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

export function isArgon2idHash(value) {
  return typeof value === 'string' && value.startsWith('$argon2id$');
}

export function isLegacyBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

export function requiresPasswordReset(value) {
  return isLegacyBcryptHash(value);
}

export async function hashPasswordArgon2id(password) {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPasswordArgon2id(password, hashValue) {
  if (!isArgon2idHash(hashValue)) return false;
  return verify(hashValue, password);
}
