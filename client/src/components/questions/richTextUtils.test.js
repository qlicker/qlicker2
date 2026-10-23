import { describe, expect, it } from 'vitest';
import {
  normalizeStoredHtml,
  prepareRichTextForDisplay,
  prepareRichTextInput,
  renderKatexInElement,
} from './richTextUtils';

describe('richTextUtils image attribute preservation', () => {
  it('preserves resized image width attributes through sanitization', () => {
    const html = '<p><img src="https://example.com/image.png" width="240" data-width="240"></p>';

    const prepared = prepareRichTextInput(html);
    const normalized = normalizeStoredHtml(html);

    expect(prepared).toContain('width="240"');
    expect(prepared).toContain('data-width="240"');
    expect(normalized).toContain('width="240"');
    expect(normalized).toContain('data-width="240"');
  });

  it('removes persisted blob image URLs that cannot be reloaded safely', () => {
    const staleBlobUrl = 'blob:https://stale-origin.invalid/a4504e7d-e942-4fca-a441-d2a9ccb2c176';
    const html = [
      '<p>Prompt</p>',
      `<p><img src="${staleBlobUrl}" width="240" data-width="240"></p>`,
      '<p><img src="https://example.com/keep.png" width="160" data-width="160"></p>',
      `<p><a href="${staleBlobUrl}">download</a></p>`,
      `<p><video src="${staleBlobUrl}" controls></video></p>`,
    ].join('');

    const prepared = prepareRichTextInput(html);
    const normalized = normalizeStoredHtml(html);

    expect(prepared).toContain('<p>Prompt</p>');
    expect(prepared).not.toContain('blob:');
    expect(prepared).toContain('src="https://example.com/keep.png"');
    expect(prepared).toContain('width="160"');
    expect(prepared).toContain('data-width="160"');
    expect(prepared).toContain('<a>download</a>');
    expect(prepared).not.toContain('<video src=');

    expect(normalized).toContain('<p>Prompt</p>');
    expect(normalized).not.toContain('blob:');
    expect(normalized).toContain('src="https://example.com/keep.png"');
    expect(normalized).toContain('width="160"');
    expect(normalized).toContain('data-width="160"');
    expect(normalized).toContain('<a>download</a>');
    expect(normalized).not.toContain('<video src=');
  });

  it('strips iframe embeds by default outside question-body context', () => {
    const html = '<p>Prompt</p><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>';

    const prepared = prepareRichTextInput(html);
    const normalized = normalizeStoredHtml(html);

    expect(prepared).not.toContain('<iframe');
    expect(normalized).not.toContain('<iframe');
  });

  it('preserves allowed video embeds only when explicitly enabled', () => {
    const html = '<p>Prompt</p><iframe src="https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s"></iframe>';

    const prepared = prepareRichTextInput(html, '', { allowVideoEmbeds: true });
    const normalized = normalizeStoredHtml(html, { allowVideoEmbeds: true });

    expect(prepared).toContain('<iframe');
    expect(prepared).toContain('src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=90"');
    expect(prepared).not.toContain('allow="');
    expect(normalized).toContain('<iframe');
    expect(normalized).toContain('referrerpolicy="strict-origin-when-cross-origin"');
    expect(normalized).not.toContain('allow="');
  });

  it('drops disallowed iframe hosts even when video embeds are enabled', () => {
    const html = '<p>Prompt</p><iframe src="https://evil.example.com/video/abc"></iframe>';

    const prepared = prepareRichTextInput(html, '', { allowVideoEmbeds: true });
    const normalized = normalizeStoredHtml(html, { allowVideoEmbeds: true });

    expect(prepared).not.toContain('<iframe');
    expect(normalized).not.toContain('<iframe');
  });

  it('keeps existing iframe nodes stable when rendering KaTeX with no block math', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>Prompt without math</p><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>';

    const initialIframe = container.querySelector('iframe');
    expect(initialIframe).toBeTruthy();

    renderKatexInElement(container);

    const finalIframe = container.querySelector('iframe');
    expect(finalIframe).toBe(initialIframe);
  });
});

describe('richTextUtils KaTeX rendering', () => {
  it('uses fallback when value is empty-but-truthy HTML', () => {
    const emptyHtml = '<p><br></p>';
    const mathFallback = '\\(x^2\\)';

    // normalizeStoredHtml correctly identifies empty HTML
    expect(normalizeStoredHtml(emptyHtml)).toBe('');

    // When normalized HTML is used as value with math fallback, KaTeX can render
    const prepared = prepareRichTextInput(normalizeStoredHtml(emptyHtml), mathFallback);
    expect(prepared).toContain('x^2');

    const container = document.createElement('div');
    container.innerHTML = prepared;
    renderKatexInElement(container);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('renders inline math delimiters from plain text fallback', () => {
    const prepared = prepareRichTextInput('', '$x^2 + y^2$');
    const container = document.createElement('div');
    container.innerHTML = prepared;
    renderKatexInElement(container);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('renders math in HTML content directly', () => {
    const prepared = prepareRichTextInput('<p>Calculate $\\frac{1}{2}$</p>');
    const container = document.createElement('div');
    container.innerHTML = prepared;
    renderKatexInElement(container);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('does not mistake decimal-leading inline math for currency', () => {
    const prepared = prepareRichTextInput(
      '<p>A spring with $k = 200 \\text{ N/m}$ is compressed by $0.1 \\text{ m}$.</p>'
    );
    const container = document.createElement('div');
    container.innerHTML = prepared;
    renderKatexInElement(container);

    expect(container.querySelectorAll('.katex')).toHaveLength(2);
    expect(container.textContent).toContain('0.1');
    expect(container.textContent).not.toContain('$0.1');
  });

  it('continues to protect unpaired currency amounts from math rendering', () => {
    const prepared = prepareRichTextInput('<p>The first book costs $5 and the second costs $10.</p>');
    const container = document.createElement('div');
    container.innerHTML = prepared;
    renderKatexInElement(container);

    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('$5');
    expect(container.textContent).toContain('$10');
  });

  it('converts stored math nodes to delimiters and renders', () => {
    const html = '<p>Answer: <span data-type="inline-math" data-latex="x^2"></span></p>';
    const prepared = prepareRichTextInput(html);
    expect(prepared).toContain('x^2');

    const container = document.createElement('div');
    container.innerHTML = prepared;
    renderKatexInElement(container);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('pre-renders math markup for display containers', () => {
    const rendered = prepareRichTextForDisplay('<p>Area is $x^2$</p>');
    expect(rendered).toContain('class="katex"');
    expect(rendered).not.toContain('$x^2$');
  });
});
