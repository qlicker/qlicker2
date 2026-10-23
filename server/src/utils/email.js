/**
 * Build a case-insensitive regex for matching an email address.
 * Used for user lookup queries against the legacy database where email
 * addresses may have been stored with mixed case.
 */
export function emailRegex(email) {
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
}
