import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import AiMarkdownContent from './AiMarkdownContent';

describe('AI Markdown math', () => {
  it('renders inline and display math through the real remark/rehype pipeline', () => {
    const { container } = render(<AiMarkdownContent content={String.raw`Inline \(x^2\).

\[\frac{1}{2}\]`} />);

    expect(container.querySelectorAll('.katex')).toHaveLength(2);
    expect(container.querySelectorAll('.katex-display')).toHaveLength(1);
    expect(container.querySelector('mfrac')).not.toBeNull();
    expect(container.querySelector('.katex-error')).toBeNull();
  });

  it('does not enable trusted HTML or unsafe links in math', () => {
    const { container } = render(<AiMarkdownContent content={String.raw`$\href{javascript:alert(1)}{click}$

$\htmlClass{injected-class}{x}$`} />);

    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('.injected-class')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });
});
