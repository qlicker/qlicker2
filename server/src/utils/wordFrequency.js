/**
 * Compute word frequencies from an array of text responses.
 *
 * @param {string[]} texts - raw text strings (HTML is stripped internally)
 * @param {string[]} [stopWords=[]] - words to exclude (case-insensitive)
 * @param {number} [maxWords=100] - maximum number of words to return
 * @returns {{ text: string, count: number }[]} sorted descending by count
 */
export function computeWordFrequencies(texts, stopWords = [], maxWords = 100) {
  if (!texts || !Array.isArray(texts)) return [];
  const stopSet = new Set((stopWords || []).map((w) => w.toLowerCase().trim()).filter(Boolean));
  const freq = new Map();

  for (const raw of texts) {
    if (!raw || typeof raw !== 'string') continue;

    // Strip HTML tags and decode common HTML entities in a single pass
    // to avoid double-unescaping (e.g. &amp;lt; → &lt; → <).
    const ENTITY_MAP = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&nbsp;': ' ',
    };
    const plain = raw
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(?:amp|lt|gt|quot|nbsp);/g, (match) => ENTITY_MAP[match] || match)
      .replace(/&#(?:x([0-9a-fA-F]+)|(\d+));/g, (_, hex, decimal) => {
        const charCode = Number.parseInt(hex || decimal, hex ? 16 : 10);
        if (!Number.isFinite(charCode)) return ' ';
        if (charCode < 0 || charCode > 0x10FFFF) return ' ';
        if (charCode >= 0xD800 && charCode <= 0xDFFF) return ' ';
        try {
          return String.fromCodePoint(charCode);
        } catch {
          return ' ';
        }
      });

    // Tokenize: split on non-letter/non-digit boundaries.
    // Supports accented characters and unicode letters via \p{L}.
    const tokens = plain.match(/[\p{L}\p{N}]+/gu) || [];

    for (const token of tokens) {
      const word = token.toLowerCase();
      if (word.length < 2) continue; // ignore single-char tokens
      if (stopSet.has(word)) continue;
      freq.set(word, (freq.get(word) || 0) + 1);
    }
  }

  // Sort descending by count, then alphabetically for stability.
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxWords)
    .map(([text, count]) => ({ text, count }));
}
