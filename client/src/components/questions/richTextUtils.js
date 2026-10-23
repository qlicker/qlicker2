import renderMathInElement from 'katex/contrib/auto-render';
import DOMPurify from 'dompurify';
import { isAllowedVideoHost, toEmbedUrl } from './VideoEmbed';

const EMPTY_PARAGRAPH_REGEX = /<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi;
const BLOCK_SPLIT_REGEX = /<\/p>\s*<p>/gi;
const CURRENCY_PATTERN = /\$\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:USD|CAD|EUR|GBP))?(?!\$)/gi;
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, [role="button"], a[href], label, iframe, video, audio, embed, object, [data-video-embed]';
const BASE_RICH_TEXT_ALLOWED_ATTRIBUTES = [
  'width', 'height', 'data-width', 'data-height',
];
const VIDEO_RICH_TEXT_ALLOWED_ATTRIBUTES = [
  'data-video-embed', 'data-src',
  'allowfullscreen', 'loading', 'referrerpolicy', 'title',
];
const URL_ATTRIBUTES = ['src', 'href', 'srcset', 'poster', 'data', 'xlink:href'];
const IFRAME_ALLOWED_ATTRIBUTES = new Set([
  'src',
  'width',
  'height',
  'allowfullscreen',
  'loading',
  'referrerpolicy',
  'title',
]);
const DEFAULT_IFRAME_REFERRER_POLICY = 'strict-origin-when-cross-origin';

let allowVideoEmbedsForCurrentSanitize = false;

// ---------------------------------------------------------------------------
// DOMPurify hook: preserve <iframe> elements that point to allowed video hosts
// and their <div data-video-embed> wrapper.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName === 'iframe') {
      if (!allowVideoEmbedsForCurrentSanitize) {
        // iframe is not in the allowlist in default mode, so DOMPurify already
        // strips it. Detaching it here as well double-removes the node, which
        // DOMPurify 3.4.11+ rejects ("refusing to sanitize in place").
        return;
      }
      const normalizedSrc = toEmbedUrl(node.getAttribute('src') || '');
      if (!normalizedSrc || !isAllowedVideoHost(normalizedSrc)) {
        node.remove();
        return;
      }
      node.setAttribute('src', normalizedSrc);
    }
  });

  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (node.tagName === 'IFRAME') {
      if (!allowVideoEmbedsForCurrentSanitize) {
        data.keepAttr = false; // eslint-disable-line no-param-reassign
        return;
      }

      const normalizedAttrName = String(data.attrName || '').toLowerCase();
      if (!IFRAME_ALLOWED_ATTRIBUTES.has(normalizedAttrName)) {
        data.keepAttr = false; // eslint-disable-line no-param-reassign
        return;
      }

      if (normalizedAttrName === 'src') {
        const normalizedSrc = toEmbedUrl(data.attrValue);
        if (!normalizedSrc || !isAllowedVideoHost(normalizedSrc)) {
          data.keepAttr = false; // eslint-disable-line no-param-reassign
          return;
        }
        data.attrValue = normalizedSrc; // eslint-disable-line no-param-reassign
        data.forceKeepAttr = true; // eslint-disable-line no-param-reassign
      }
    }
  });

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'IFRAME') {
      if (!allowVideoEmbedsForCurrentSanitize) {
        node.remove();
        return;
      }

      const normalizedSrc = toEmbedUrl(node.getAttribute('src') || '');
      if (!normalizedSrc || !isAllowedVideoHost(normalizedSrc)) {
        node.remove();
        return;
      }

      node.setAttribute('src', normalizedSrc);
      node.setAttribute('allowfullscreen', 'true');
      node.setAttribute('loading', 'lazy');
      node.setAttribute('referrerpolicy', DEFAULT_IFRAME_REFERRER_POLICY);
      if (!node.getAttribute('title')) node.setAttribute('title', 'Embedded video');

      Array.from(node.attributes).forEach((attribute) => {
        if (!IFRAME_ALLOWED_ATTRIBUTES.has(String(attribute.name || '').toLowerCase())) {
          node.removeAttribute(attribute.name);
        }
      });
      return;
    }

    if (node.tagName === 'DIV' && node.hasAttribute('data-video-embed')) {
      if (!allowVideoEmbedsForCurrentSanitize) {
        node.removeAttribute('data-video-embed');
        node.removeAttribute('data-src');
        return;
      }

      const normalizedSrc = toEmbedUrl(node.getAttribute('data-src') || '');
      if (!normalizedSrc || !isAllowedVideoHost(normalizedSrc)) {
        node.removeAttribute('data-video-embed');
        node.removeAttribute('data-src');
        return;
      }
      node.setAttribute('data-src', normalizedSrc);
    }
  });
}

function createInertContainer(html) {
  const template = document.createElement('template');
  template.innerHTML = html || '';
  return {
    root: template.content || template,
    toHtml: () => template.innerHTML,
  };
}

function isBlobUrl(value) {
  return /^blob:/i.test(String(value || '').trim());
}

function hasBlobUrlAttributeValue(attribute, value) {
  if (attribute === 'srcset') {
    return /(^|,)\s*blob:/i.test(String(value || '').trim());
  }
  return isBlobUrl(value);
}

function stripTransientBlobUrls(html) {
  if (!html || typeof document === 'undefined') return html ?? '';
  const { root, toHtml } = createInertContainer(html);

  root.querySelectorAll('*').forEach((node) => {
    let shouldRemoveNode = false;
    URL_ATTRIBUTES.forEach((attribute) => {
      if (shouldRemoveNode) return;
      const value = node.getAttribute(attribute);
      if (!hasBlobUrlAttributeValue(attribute, value)) return;
      if (node.tagName === 'IMG' && (attribute === 'src' || attribute === 'srcset')) {
        shouldRemoveNode = true;
        return;
      }
      node.removeAttribute(attribute);
    });
    if (shouldRemoveNode) {
      node.remove();
    }
  });

  return toHtml();
}

function isHtmlLike(value) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeHtmlAttribute(value) {
  if (!value || typeof document === 'undefined') return value || '';
  const el = document.createElement('textarea');
  el.innerHTML = value;
  return el.value;
}

function normalizeLatexForKatex(latex) {
  if (!latex) return latex;
  return latex
    .replace(/\\begin\{align\*?\}/g, '\\begin{aligned}')
    .replace(/\\end\{align\*?\}/g, '\\end{aligned}');
}

// Older Qlicker content used literal parenthesis delimiters ("( x^2 (") for
// inline TeX. Normalize that legacy notation before KaTeX sees the content.
function convertLegacyParenthesisMath(value) {
  return String(value || '').replace(/(^|[\s>])\(\s*([^\n<][\s\S]*?)\s*\((?=[\s<.,;:!?)]|$)/g, (match, prefix, latex) => (
    `${prefix}\\(${latex.trim()}\\)`
  ));
}

function convertLegacyMathScriptTags(html) {
  if (!html || typeof document === 'undefined') return html;
  const { root, toHtml } = createInertContainer(html);

  root.querySelectorAll('script[type^="math/tex"]').forEach((scriptEl) => {
    const type = (scriptEl.getAttribute('type') || '').toLowerCase();
    const displayMode = type.includes('mode=display');
    const latex = normalizeLatexForKatex((scriptEl.textContent || '').trim());
    const textNode = document.createTextNode(displayMode ? `$$\n${latex}\n$$` : `\\(${latex}\\)`);
    scriptEl.parentNode?.replaceChild(textNode, scriptEl);
  });

  return toHtml();
}

function convertStoredMathNodesToDelimiters(html) {
  if (!html || typeof document === 'undefined') return html;
  const { root, toHtml } = createInertContainer(html);

  root.querySelectorAll('[data-type="inline-math"], [data-type="block-math"]').forEach((node) => {
    const rawLatex = decodeHtmlAttribute(node.getAttribute('data-latex') || '');
    const latex = normalizeLatexForKatex(rawLatex);
    const isBlock = node.getAttribute('data-type') === 'block-math';
    const replacement = document.createTextNode(isBlock ? `$$\n${latex}\n$$` : `\\(${latex}\\)`);
    node.parentNode?.replaceChild(replacement, node);
  });

  return toHtml();
}

function normalizeBlockMathMarkup(container) {
  if (!container) return;
  const html = container.innerHTML;
  const normalizedHtml = html.replace(/\$\$([\s\S]*?)\$\$/g, (fullMatch, inner) => {
    let cleaned = inner
      .replace(BLOCK_SPLIT_REGEX, '\n')
      .replace(/<br\s*\/?>/gi, '\n');

    // Strip HTML tags iteratively to prevent incomplete sanitization
    // (e.g. nested fragments like `<scr<b>ipt>` surviving a single pass).
    let previous;
    do {
      previous = cleaned;
      cleaned = cleaned.replace(/<[^>]+>/g, '');
    } while (cleaned !== previous);

    cleaned = cleaned.trim();
    if (!cleaned) return fullMatch;
    return `$$\n${normalizeLatexForKatex(cleaned)}\n$$`;
  });
  if (normalizedHtml !== html) {
    container.innerHTML = normalizedHtml;
  }
}

function hasInteractiveNodes(container) {
  if (!container || typeof container.querySelector !== 'function') return false;
  if (typeof container.matches === 'function' && container.matches(INTERACTIVE_SELECTOR)) return true;
  return Boolean(container.querySelector(INTERACTIVE_SELECTOR));
}

function normalizeBlockMathMarkupSafely(container) {
  if (!container) return;

  // Avoid rewriting an interactive container's innerHTML, which would detach React handlers.
  if (!hasInteractiveNodes(container)) {
    normalizeBlockMathMarkup(container);
    return;
  }

  container.querySelectorAll('p, li, div, span').forEach((node) => {
    if (hasInteractiveNodes(node)) return;
    normalizeBlockMathMarkup(node);
  });
}

function isEscapedDelimiter(value, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function dollarMathRanges(value) {
  const text = String(value || '');
  const ranges = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '$' || isEscapedDelimiter(text, cursor)) {
      cursor += 1;
      continue;
    }
    const delimiterLength = text[cursor + 1] === '$' ? 2 : 1;
    let closing = cursor + delimiterLength;
    while (closing < text.length) {
      const matches = delimiterLength === 2
        ? text.startsWith('$$', closing)
        : text[closing] === '$' && text[closing - 1] !== '$' && text[closing + 1] !== '$';
      const looksLikeAnotherPrice = delimiterLength === 1 && /\d/.test(text[closing + 1] || '');
      if (matches && !isEscapedDelimiter(text, closing) && !looksLikeAnotherPrice) break;
      closing += 1;
    }
    if (closing >= text.length) {
      cursor += delimiterLength;
      continue;
    }
    const end = closing + delimiterLength;
    ranges.push([cursor, end]);
    cursor = end;
  }
  return ranges;
}

function maskCurrencyTokens(container) {
  if (!container || typeof document === 'undefined') return () => {};
  const replacements = [];
  const showTextNode = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;
  const walker = document.createTreeWalker(container, showTextNode);

  let node = walker.nextNode();
  while (node) {
    const originalText = node.nodeValue || '';
    if (originalText.includes('$')) {
      const mathRanges = dollarMathRanges(originalText);
      node.nodeValue = originalText.replace(CURRENCY_PATTERN, (match, offset) => {
        if (mathRanges.some(([start, end]) => offset >= start && offset < end)) return match;
        const token = `__QL_CUR_${replacements.length}__`;
        replacements.push({ token, value: match });
        return token;
      });
    }
    node = walker.nextNode();
  }

  return () => {
    if (!replacements.length) return;
    const restoreWalker = document.createTreeWalker(container, showTextNode);
    let textNode = restoreWalker.nextNode();
    while (textNode) {
      let value = textNode.nodeValue || '';
      replacements.forEach(({ token, value: original }) => {
        value = value.replaceAll(token, original);
      });
      textNode.nodeValue = value;
      textNode = restoreWalker.nextNode();
    }
  };
}

export function prepareRichTextInput(value, fallback = '', options = {}) {
  const source = ((value && String(value)) || (fallback && String(fallback)) || '').trim();
  if (!source) return '';

  let normalized = stripTransientBlobUrls(source);
  normalized = convertLegacyParenthesisMath(normalized);
  normalized = convertLegacyMathScriptTags(normalized);
  normalized = convertStoredMathNodesToDelimiters(normalized);

  if (!isHtmlLike(normalized)) {
    return `<p>${escapeHtml(normalized)}</p>`;
  }

  return sanitizeRichHtml(normalized, options);
}

export function sanitizeRichHtml(html, options = {}) {
  const { allowVideoEmbeds = false } = options || {};
  const source = String(html || '').trim();
  if (!source) return '';
  if (typeof window === 'undefined') return source;

  allowVideoEmbedsForCurrentSanitize = allowVideoEmbeds;
  try {
    return DOMPurify.sanitize(stripTransientBlobUrls(source), {
      USE_PROFILES: { html: true },
      ADD_TAGS: allowVideoEmbeds ? ['iframe'] : [],
      ADD_ATTR: allowVideoEmbeds
        ? [...BASE_RICH_TEXT_ALLOWED_ATTRIBUTES, ...VIDEO_RICH_TEXT_ALLOWED_ATTRIBUTES]
        : BASE_RICH_TEXT_ALLOWED_ATTRIBUTES,
    });
  } finally {
    allowVideoEmbedsForCurrentSanitize = false;
  }
}

export function normalizeStoredHtml(html, options = {}) {
  const trimmed = String(html || '').trim();
  if (!trimmed) return '';
  const sanitized = sanitizeRichHtml(trimmed, options).trim();
  if (!sanitized || sanitized === '<p></p>' || sanitized === '<p><br></p>') return '';

  const noEmptyParagraphs = sanitized.replace(EMPTY_PARAGRAPH_REGEX, '').trim();
  if (!noEmptyParagraphs) return '';
  return sanitized;
}

export function extractPlainTextFromHtml(html) {
  if (!html) return '';
  if (typeof document === 'undefined') {
    return String(html).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const container = document.createElement('div');
  container.innerHTML = convertStoredMathNodesToDelimiters(html);
  return (container.textContent || '').replace(/\s+/g, ' ').trim();
}

export function hasRichTextContent(html, options = {}) {
  const normalized = normalizeStoredHtml(html, options);
  if (!normalized) return false;

  const plainText = extractPlainTextFromHtml(normalized);
  if (plainText.length > 0) return true;

  return /<img\b/i.test(normalized) || /<iframe\b/i.test(normalized);
}

function normalizeEmbeddedIframes(container) {
  if (!container || typeof container.querySelectorAll !== 'function') return;

  container.querySelectorAll('iframe').forEach((iframe) => {
    const width = Number.parseFloat(iframe.getAttribute('width') || '');
    const height = Number.parseFloat(iframe.getAttribute('height') || '');
    const hasValidRatio = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;

    iframe.style.display = 'block';
    iframe.style.width = '100%';
    iframe.style.maxWidth = '100%';
    iframe.style.height = 'auto';
    iframe.style.boxSizing = 'border-box';

    if (hasValidRatio) {
      iframe.style.aspectRatio = `${width} / ${height}`;
    } else if (!iframe.style.aspectRatio) {
      iframe.style.aspectRatio = '16 / 9';
    }
  });
}

export function renderKatexInElement(container) {
  if (!container) return;

  normalizeEmbeddedIframes(container);
  normalizeBlockMathMarkupSafely(container);
  const restoreCurrency = maskCurrencyTokens(container);
  const renderOptions = {
    throwOnError: false,
    strict: 'ignore',
    trust: true,
    output: 'html',
    preProcess: math => normalizeLatexForKatex(math),
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false },
      { left: '$', right: '$', display: false },
    ],
    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
  };

  try {
    renderMathInElement(container, renderOptions);
  } catch {
    // Fall back to smaller chunks if whole-container auto-render fails.
    const chunks = container.querySelectorAll('p, li, div, span');
    chunks.forEach((chunk) => {
      try {
        renderMathInElement(chunk, renderOptions);
      } catch {
        // Keep failing chunks unchanged.
      }
    });
  } finally {
    restoreCurrency();
  }
}

export function prepareRichTextForDisplay(value, fallback = '') {
  const prepared = prepareRichTextInput(value, fallback);
  if (!prepared) return '';
  if (typeof document === 'undefined') return prepared;

  const container = document.createElement('div');
  container.innerHTML = prepared;
  renderKatexInElement(container);
  return container.innerHTML;
}
