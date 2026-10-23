import crypto from 'crypto';

const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CHARS_LEN = CHARS.length; // 62

export function generateMeteorId(length = 17) {
  // Use rejection sampling to avoid modulo bias
  const maxValid = 256 - (256 % CHARS_LEN); // 248
  let result = '';
  while (result.length < length) {
    const bytes = crypto.randomBytes(length - result.length + 16);
    for (let i = 0; i < bytes.length && result.length < length; i++) {
      if (bytes[i] < maxValid) {
        result += CHARS.charAt(bytes[i] % CHARS_LEN);
      }
    }
  }
  return result;
}
