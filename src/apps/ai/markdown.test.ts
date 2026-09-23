import { describe, it, expect } from 'vitest';
import { renderMarkdown, stripThinking } from './markdown';

describe('claude renderMarkdown', () => {
  it('escapes HTML so replies cannot inject markup', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **ok**');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>ok</strong>');
  });

  it('only links http(s) URLs', () => {
    expect(renderMarkdown('[a](https://example.com)')).toContain('href="https://example.com"');
    expect(renderMarkdown('[a](javascript:alert(1))')).not.toContain('href');
  });

  it('renders lists, headings and fenced code', () => {
    const html = renderMarkdown('# Title\n- one\n- two\n1. first\n```\n<b>x</b>\n```');
    expect(html).toContain('<h3>Title</h3>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li></ol>');
    expect(html).toContain('<pre dir="ltr"><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
  });

  it('drops <think> blocks, even an unfinished one', () => {
    expect(stripThinking('<think>plan</think>\nAnswer')).toBe('Answer');
    expect(stripThinking('<think>still going')).toBe('');
    expect(renderMarkdown('<think>x</think>Hi')).toBe('<p>Hi</p>');
  });
});
