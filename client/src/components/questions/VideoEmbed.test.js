import { describe, it, expect } from 'vitest';
import { toEmbedUrl, isAllowedVideoHost, ALLOWED_VIDEO_HOSTS } from './VideoEmbed';

describe('VideoEmbed', () => {
  describe('toEmbedUrl', () => {
    it('converts a YouTube watch URL to an embed URL', () => {
      expect(toEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
        .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    });

    it('preserves YouTube start time from watch URLs', () => {
      expect(toEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s'))
        .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=90');
    });

    it('converts a youtu.be short URL', () => {
      expect(toEmbedUrl('https://youtu.be/dQw4w9WgXcQ'))
        .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    });

    it('preserves YouTube start time from youtu.be URLs', () => {
      expect(toEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=75'))
        .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=75');
    });

    it('passes through an existing YouTube embed URL', () => {
      expect(toEmbedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ'))
        .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    });

    it('preserves start time from YouTube embed URL hash', () => {
      expect(toEmbedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ#t=45'))
        .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=45');
    });

    it('converts a YouTube Shorts URL', () => {
      expect(toEmbedUrl('https://www.youtube.com/shorts/abc123'))
        .toBe('https://www.youtube.com/embed/abc123');
    });

    it('passes through youtube-nocookie embed URL', () => {
      expect(toEmbedUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'))
        .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
    });

    it('converts a Vimeo watch URL', () => {
      expect(toEmbedUrl('https://vimeo.com/123456'))
        .toBe('https://player.vimeo.com/video/123456');
    });

    it('passes through a Vimeo player URL', () => {
      expect(toEmbedUrl('https://player.vimeo.com/video/123456'))
        .toBe('https://player.vimeo.com/video/123456');
    });

    it('converts a Dailymotion video URL', () => {
      expect(toEmbedUrl('https://www.dailymotion.com/video/x7tgad0'))
        .toBe('https://www.dailymotion.com/embed/video/x7tgad0');
    });

    it('converts a Loom share URL', () => {
      expect(toEmbedUrl('https://www.loom.com/share/abc123def456'))
        .toBe('https://www.loom.com/embed/abc123def456');
    });

    it('passes through a Loom embed URL', () => {
      expect(toEmbedUrl('https://www.loom.com/embed/abc123def456'))
        .toBe('https://www.loom.com/embed/abc123def456');
    });

    it('returns null for an invalid URL', () => {
      expect(toEmbedUrl('not a url')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(toEmbedUrl('')).toBeNull();
    });

    it('returns null for null/undefined', () => {
      expect(toEmbedUrl(null)).toBeNull();
      expect(toEmbedUrl(undefined)).toBeNull();
    });

    it('returns null for a disallowed host', () => {
      expect(toEmbedUrl('https://evil.example.com/video')).toBeNull();
    });

    it('returns null for a non-http protocol', () => {
      expect(toEmbedUrl('ftp://www.youtube.com/watch?v=abc')).toBeNull();
    });

    it('returns null for a YouTube URL without a video ID', () => {
      expect(toEmbedUrl('https://www.youtube.com/')).toBeNull();
    });

    it('passes through URLs on other allowed hosts', () => {
      const result = toEmbedUrl('https://fast.wistia.net/medias/abc123');
      expect(result).toBe('https://fast.wistia.net/medias/abc123');
    });

    it('handles protocol-relative URLs', () => {
      expect(toEmbedUrl('//www.youtube.com/embed/dQw4w9WgXcQ'))
        .toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
    });
  });

  describe('isAllowedVideoHost', () => {
    it('returns true for YouTube URLs', () => {
      expect(isAllowedVideoHost('https://www.youtube.com/embed/abc')).toBe(true);
    });

    it('returns true for Vimeo player URLs', () => {
      expect(isAllowedVideoHost('https://player.vimeo.com/video/123')).toBe(true);
    });

    it('returns false for unknown hosts', () => {
      expect(isAllowedVideoHost('https://evil.example.com/video')).toBe(false);
    });

    it('returns false for invalid URLs', () => {
      expect(isAllowedVideoHost('not a url')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isAllowedVideoHost('')).toBe(false);
    });
  });

  describe('ALLOWED_VIDEO_HOSTS', () => {
    it('includes expected major video platforms', () => {
      expect(ALLOWED_VIDEO_HOSTS).toContain('www.youtube.com');
      expect(ALLOWED_VIDEO_HOSTS).toContain('player.vimeo.com');
      expect(ALLOWED_VIDEO_HOSTS).toContain('www.dailymotion.com');
      expect(ALLOWED_VIDEO_HOSTS).toContain('www.loom.com');
    });
  });
});
