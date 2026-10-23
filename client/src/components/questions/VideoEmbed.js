import { mergeAttributes, Node } from '@tiptap/core';

/**
 * Allowlist of hostnames permitted for video embedding.
 * Only iframes pointing to these domains (or their subdomains) are
 * preserved by the DOMPurify hook in richTextUtils and rendered by
 * this TipTap node.
 */
export const ALLOWED_VIDEO_HOSTS = [
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
  'player.vimeo.com',
  'vimeo.com',
  'www.dailymotion.com',
  'dailymotion.com',
  'fast.wistia.net',
  'fast.wistia.com',
  'www.loom.com',
  'loom.com',
  'play.vidyard.com',
  'mediaspace.kaltura.com',
  'cdnapisec.kaltura.com',
  'www.microsoft.com',
  'web.microsoftstream.com',
  'drive.google.com',
  'peertube.tv',
];

const YOUTUBE_TIME_SEGMENT_REGEX = /(\d+)(h|m|s)/g;

function parseYouTubeStartSeconds(rawValue) {
  const value = String(rawValue || '').trim().toLowerCase();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);

  let total = 0;
  let hasSegments = false;
  let match = YOUTUBE_TIME_SEGMENT_REGEX.exec(value);
  while (match) {
    hasSegments = true;
    const amount = Number.parseInt(match[1], 10);
    if (!Number.isFinite(amount)) return null;
    if (match[2] === 'h') total += amount * 3600;
    if (match[2] === 'm') total += amount * 60;
    if (match[2] === 's') total += amount;
    match = YOUTUBE_TIME_SEGMENT_REGEX.exec(value);
  }
  YOUTUBE_TIME_SEGMENT_REGEX.lastIndex = 0;

  if (!hasSegments) return null;
  return total > 0 ? total : null;
}

function extractYouTubeStartSeconds(url) {
  const directCandidate = url.searchParams.get('start')
    || url.searchParams.get('t')
    || url.searchParams.get('time_continue');
  const direct = parseYouTubeStartSeconds(directCandidate);
  if (direct != null) return direct;

  const hash = String(url.hash || '').replace(/^#/, '').trim();
  if (!hash) return null;
  const hashParams = new URLSearchParams(hash.includes('=') ? hash : `t=${hash}`);
  const hashCandidate = hashParams.get('t') || hashParams.get('start') || hash;
  return parseYouTubeStartSeconds(hashCandidate);
}

function buildYouTubeEmbedUrl(videoId, { noCookie = false, startSeconds = null } = {}) {
  const normalizedId = String(videoId || '').trim();
  if (!normalizedId) return null;

  const embedUrl = new URL(
    `https://${noCookie ? 'www.youtube-nocookie.com' : 'www.youtube.com'}/embed/${encodeURIComponent(normalizedId)}`
  );
  if (Number.isFinite(startSeconds) && startSeconds > 0) {
    embedUrl.searchParams.set('start', String(Math.floor(startSeconds)));
  }
  return embedUrl.toString();
}

function extractYouTubeVideoId(pathname = '') {
  if (pathname.startsWith('/embed/')) {
    return pathname.split('/embed/')[1]?.split(/[/?#]/)[0] || '';
  }
  if (pathname.startsWith('/shorts/')) {
    return pathname.split('/shorts/')[1]?.split(/[/?#]/)[0] || '';
  }
  return '';
}

/**
 * Parse a user-supplied URL (watch page or raw embed URL) into a safe
 * embed `src` value. Returns `null` when the URL cannot be mapped to
 * an allowed host.
 */
export function toEmbedUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  let url;
  try {
    url = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed);
  } catch {
    return null;
  }

  // Ensure https (or http on localhost for dev).
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase();

  // YouTube watch / short / embed
  if (host === 'www.youtube.com' || host === 'youtube.com') {
    const startSeconds = extractYouTubeStartSeconds(url);
    if (url.pathname === '/watch') {
      const videoId = url.searchParams.get('v');
      if (videoId) return buildYouTubeEmbedUrl(videoId, { startSeconds });
    }
    const id = extractYouTubeVideoId(url.pathname);
    if (id) return buildYouTubeEmbedUrl(id, { startSeconds });
    return null;
  }
  if (host === 'youtu.be') {
    const startSeconds = extractYouTubeStartSeconds(url);
    const id = url.pathname.slice(1).split(/[/?#]/)[0];
    if (id) return buildYouTubeEmbedUrl(id, { startSeconds });
    return null;
  }
  if (host === 'www.youtube-nocookie.com' || host === 'youtube-nocookie.com') {
    const startSeconds = extractYouTubeStartSeconds(url);
    const id = extractYouTubeVideoId(url.pathname);
    if (id) return buildYouTubeEmbedUrl(id, { noCookie: true, startSeconds });
    return null;
  }

  // Vimeo
  if (host === 'vimeo.com' || host === 'www.vimeo.com') {
    const match = url.pathname.match(/^\/(\d+)/);
    if (match) return `https://player.vimeo.com/video/${match[1]}`;
    return null;
  }
  if (host === 'player.vimeo.com') {
    if (url.pathname.startsWith('/video/')) return url.href;
    return null;
  }

  // Dailymotion
  if (host === 'www.dailymotion.com' || host === 'dailymotion.com') {
    const match = url.pathname.match(/\/video\/([a-zA-Z0-9]+)/);
    if (match) return `https://www.dailymotion.com/embed/video/${match[1]}`;
    if (url.pathname.startsWith('/embed/video/')) return url.href;
    return null;
  }

  // Loom
  if (host === 'www.loom.com' || host === 'loom.com') {
    const match = url.pathname.match(/\/share\/([a-f0-9]+)/);
    if (match) return `https://www.loom.com/embed/${match[1]}`;
    if (url.pathname.startsWith('/embed/')) return url.href;
    return null;
  }

  // For other allowed hosts, only pass through if already an embed-style URL
  if (ALLOWED_VIDEO_HOSTS.includes(host)) {
    return url.href;
  }

  return null;
}

/**
 * Check whether a given URL points to an allowed video host.
 */
export function isAllowedVideoHost(src) {
  return Boolean(toEmbedUrl(src));
}

/**
 * TipTap node extension that renders an iframe for embedded videos.
 *
 * Usage:
 *   editor.commands.setVideoEmbed({ src: 'https://www.youtube.com/embed/dQw4w9WgXcQ' })
 */
const VideoEmbed = Node.create({
  name: 'videoEmbed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      width: {
        default: 560,
        parseHTML: (el) => {
          const raw = el.getAttribute('width') || el.getAttribute('data-width');
          const parsed = Number.parseInt(raw, 10);
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 560;
        },
        renderHTML: (attrs) => {
          const w = Number(attrs.width) || 560;
          return { width: w, 'data-width': w };
        },
      },
      height: {
        default: 315,
        parseHTML: (el) => {
          const raw = el.getAttribute('height') || el.getAttribute('data-height');
          const parsed = Number.parseInt(raw, 10);
          return Number.isFinite(parsed) && parsed > 0 ? parsed : 315;
        },
        renderHTML: (attrs) => {
          const h = Number(attrs.height) || 315;
          return { height: h, 'data-height': h };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'iframe[src]',
        getAttrs: (dom) => {
          const src = dom.getAttribute('src') || '';
          const normalizedSrc = toEmbedUrl(src);
          if (!normalizedSrc || !isAllowedVideoHost(normalizedSrc)) return false;
          return { src: normalizedSrc };
        },
      },
      {
        tag: 'div[data-video-embed]',
        getAttrs: (dom) => {
          const src = dom.getAttribute('data-src') || '';
          const normalizedSrc = toEmbedUrl(src);
          if (!normalizedSrc || !isAllowedVideoHost(normalizedSrc)) return false;
          return { src: normalizedSrc };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      { 'data-video-embed': '', 'data-src': HTMLAttributes.src },
      [
        'iframe',
        mergeAttributes(
          {
            allowfullscreen: 'true',
            loading: 'lazy',
            referrerpolicy: 'strict-origin-when-cross-origin',
            title: 'Embedded video',
          },
          HTMLAttributes,
        ),
      ],
    ];
  },

  addCommands() {
    return {
      setVideoEmbed:
        (attrs) =>
        ({ commands }) => {
          const src = toEmbedUrl(attrs?.src);
          if (!src) return false;
          return commands.insertContent({
            type: this.name,
            attrs: { ...attrs, src },
          });
        },
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let currentNode = node;

      const wrapper = document.createElement('div');
      wrapper.className = 'tiptap-video-embed';
      wrapper.contentEditable = 'false';
      wrapper.style.position = 'relative';
      wrapper.style.maxWidth = '100%';
      wrapper.style.margin = '8px 0';

      const iframe = document.createElement('iframe');
      const initialSrc = currentNode.attrs.src || '';
      if (initialSrc) iframe.setAttribute('src', initialSrc);
      iframe.setAttribute('width', String(currentNode.attrs.width || 560));
      iframe.setAttribute('height', String(currentNode.attrs.height || 315));
      iframe.style.display = 'block';
      iframe.style.maxWidth = '100%';
      iframe.style.border = 'none';
      iframe.style.borderRadius = '4px';
      iframe.setAttribute('allowfullscreen', 'true');
      iframe.setAttribute('loading', 'lazy');
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      iframe.setAttribute('title', 'Embedded video');

      // Delete button overlay (only in editable mode)
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.textContent = '✕';
      deleteBtn.style.cssText =
        'position:absolute;top:4px;right:4px;z-index:2;background:rgba(0,0,0,0.6);color:#fff;' +
        'border:none;border-radius:50%;width:24px;height:24px;cursor:pointer;font-size:14px;' +
        'line-height:24px;text-align:center;display:none;';
      deleteBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const pos = getPos?.();
        if (typeof pos === 'number') {
          editor.chain().focus().command(({ tr }) => {
            tr.delete(pos, pos + currentNode.nodeSize);
            return true;
          }).run();
        }
      });

      const showDelete = () => {
        if (editor.isEditable) deleteBtn.style.display = 'block';
      };
      const hideDelete = () => {
        deleteBtn.style.display = 'none';
      };
      wrapper.addEventListener('mouseenter', showDelete);
      wrapper.addEventListener('mouseleave', hideDelete);

      wrapper.appendChild(iframe);
      wrapper.appendChild(deleteBtn);

      return {
        dom: wrapper,
        update(updatedNode) {
          if (updatedNode.type.name !== currentNode.type.name) return false;
          currentNode = updatedNode;
          const nextSrc = updatedNode.attrs.src || '';
          const currentSrc = iframe.getAttribute('src') || '';
          if (currentSrc !== nextSrc) {
            if (nextSrc) {
              iframe.setAttribute('src', nextSrc);
            } else {
              iframe.removeAttribute('src');
            }
          }
          const nextWidth = String(updatedNode.attrs.width || 560);
          if ((iframe.getAttribute('width') || '') !== nextWidth) {
            iframe.setAttribute('width', nextWidth);
          }
          const nextHeight = String(updatedNode.attrs.height || 315);
          if ((iframe.getAttribute('height') || '') !== nextHeight) {
            iframe.setAttribute('height', nextHeight);
          }
          return true;
        },
        destroy() {
          wrapper.removeEventListener('mouseenter', showDelete);
          wrapper.removeEventListener('mouseleave', hideDelete);
        },
      };
    };
  },
});

export default VideoEmbed;
