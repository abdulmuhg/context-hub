import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/web/markdown.js';

describe('renderMarkdown', () => {
  it('renders headings, paragraphs, lists, bold and code', () => {
    const html = renderMarkdown('# One\n## Two\n### Three\n#### Four\n\nA **bold** and `code` line.\n\n- a\n* b\n');
    expect(html).toContain('<h1>One</h1>');
    expect(html).toContain('<h2>Two</h2>');
    expect(html).toContain('<h3>Three</h3>');
    expect(html).toContain('<h4>Four</h4>');
    expect(html).toContain('<p>A <strong>bold</strong> and <code>code</code> line.</p>');
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>');
  });

  it('renders an https link with rel noopener noreferrer', () => {
    const html = renderMarkdown('See [the docs](https://example.com/a?b=1&c=2).');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" rel="noopener noreferrer">the docs</a>');
  });

  it('escapes raw HTML', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('renders links with other schemes as plain text with no anchor', () => {
    for (const md of ['[x](javascript:alert(1))', '[x](data:text/html,<b>hi</b>)', '[x](JaVaScRiPt:alert(1))', '[x]( javascript:alert(1))', '[x](//evil.test)']) {
      const html = renderMarkdown(md);
      expect(html).not.toContain('<a');
      expect(html).not.toContain('href');
      expect(html).toContain('<p>x</p>');
    }
  });

  it('cannot break out of the href attribute', () => {
    const html = renderMarkdown('[x](https://e.test/"onmouseover="alert(1))');
    expect(html).not.toMatch(/<a[^>]*"\s*onmouseover/);
    expect(html).not.toContain('" onmouseover');
  });

  it('does not format inside code spans', () => {
    expect(renderMarkdown('`**x** [a](https://e.test)`')).toBe('<p><code>**x** [a](https://e.test)</code></p>');
  });
});
