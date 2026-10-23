/**
 * Escape special regex characters in a string so it can be safely used
 * inside `new RegExp()`.  This prevents ReDoS (Regular-Expression Denial
 * of Service) when the string originates from user input.
 */
export function escapeForRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
