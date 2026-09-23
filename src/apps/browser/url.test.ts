import { describe, it, expect } from 'vitest';
import {
  resolveAddressInput,
  isAllowedFrameUrl,
  rewriteYouTubeEmbed,
  buildOpenStreetMapEmbedUrl,
  buildWikipediaSearchUrl,
  buildExternalSearchUrl,
  isBlockedDomain,
  looksLikeDomain,
} from './url';

describe('looksLikeDomain', () => {
  it('accepts plain domains', () => {
    expect(looksLikeDomain('example.com')).toBe(true);
    expect(looksLikeDomain('ar.wikipedia.org')).toBe(true);
    expect(looksLikeDomain('example.com/path?x=1')).toBe(true);
  });
  it('rejects sentences and schemeless garbage', () => {
    expect(looksLikeDomain('how to make hummus')).toBe(false);
    expect(looksLikeDomain('no dot here')).toBe(false);
    expect(looksLikeDomain('')).toBe(false);
    expect(looksLikeDomain('has spaces.com yes')).toBe(false);
  });
});

describe('resolveAddressInput — normalization', () => {
  it('trims whitespace', () => {
    expect(resolveAddressInput('  example.com  ')).toEqual({ kind: 'url', url: 'https://example.com' });
  });
  it('adds https to a bare domain', () => {
    expect(resolveAddressInput('wikipedia.org')).toEqual({ kind: 'url', url: 'https://wikipedia.org' });
  });
  it('forces http to https', () => {
    expect(resolveAddressInput('http://example.com/page')).toEqual({ kind: 'url', url: 'https://example.com/page' });
  });
  it('passes https through unchanged', () => {
    expect(resolveAddressInput('https://example.com/page')).toEqual({ kind: 'url', url: 'https://example.com/page' });
  });
  it('falls back to search for plain text', () => {
    expect(resolveAddressInput('best hummus recipe')).toEqual({ kind: 'search', query: 'best hummus recipe' });
  });
  it('falls back to search for empty input', () => {
    expect(resolveAddressInput('   ')).toEqual({ kind: 'search', query: '' });
  });
});

describe('resolveAddressInput — blocked schemes', () => {
  const schemes = ['javascript:alert(1)', 'data:text/html,hi', 'blob:https://x/1', 'file:///etc/passwd', 'about:blank', 'chrome://settings'];
  for (const s of schemes) {
    it(`treats "${s}" as a search, never a URL`, () => {
      expect(resolveAddressInput(s)).toEqual({ kind: 'search', query: s });
    });
  }
});

describe('isAllowedFrameUrl', () => {
  it('allows a plain https URL', () => {
    expect(isAllowedFrameUrl('https://example.com', 'https://os.faisal')).toBe(true);
  });
  it('rejects non-https schemes', () => {
    expect(isAllowedFrameUrl('http://example.com', 'https://os.faisal')).toBe(false);
    expect(isAllowedFrameUrl('javascript:alert(1)', 'https://os.faisal')).toBe(false);
    expect(isAllowedFrameUrl('data:text/html,hi', 'https://os.faisal')).toBe(false);
    expect(isAllowedFrameUrl('file:///etc/passwd', 'https://os.faisal')).toBe(false);
    expect(isAllowedFrameUrl('about:blank', 'https://os.faisal')).toBe(false);
  });
  it('rejects an invalid URL string', () => {
    expect(isAllowedFrameUrl('not a url', 'https://os.faisal')).toBe(false);
  });
  it('rejects same-origin (never frame the OS itself)', () => {
    expect(isAllowedFrameUrl('https://os.faisal/anything', 'https://os.faisal')).toBe(false);
    expect(isAllowedFrameUrl('https://os.faisal', 'https://os.faisal')).toBe(false);
  });
  it('allows a different origin even if same host name minus port', () => {
    expect(isAllowedFrameUrl('https://os.faisal:8080', 'https://os.faisal')).toBe(true);
  });
});

describe('YouTube rewrite variants', () => {
  it('rewrites a watch URL', () => {
    expect(rewriteYouTubeEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ'))
      .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });
  it('rewrites a watch URL with extra query params', () => {
    expect(rewriteYouTubeEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RD123&t=30s'))
      .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });
  it('rewrites a youtu.be short link', () => {
    expect(rewriteYouTubeEmbed('https://youtu.be/dQw4w9WgXcQ')).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });
  it('rewrites a shorts URL', () => {
    expect(rewriteYouTubeEmbed('https://www.youtube.com/shorts/dQw4w9WgXcQ'))
      .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });
  it('rewrites an m.youtube.com watch URL', () => {
    expect(rewriteYouTubeEmbed('https://m.youtube.com/watch?v=dQw4w9WgXcQ'))
      .toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  });
  it('returns null for a non-video YouTube page', () => {
    expect(rewriteYouTubeEmbed('https://www.youtube.com/')).toBeNull();
    expect(rewriteYouTubeEmbed('https://www.youtube.com/channel/UC123')).toBeNull();
  });
  it('returns null for an unrelated URL', () => {
    expect(rewriteYouTubeEmbed('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });
});

describe('search fallback URLs', () => {
  it('builds a Wikipedia search URL per locale', () => {
    expect(buildWikipediaSearchUrl('قطط', 'ar')).toBe('https://ar.wikipedia.org/w/index.php?search=%D9%82%D8%B7%D8%B7');
    expect(buildWikipediaSearchUrl('cats', 'en')).toBe('https://en.wikipedia.org/w/index.php?search=cats');
  });
  it('builds external engine URLs (opened in a real tab)', () => {
    expect(buildExternalSearchUrl('cats', 'duckduckgo')).toBe('https://duckduckgo.com/?q=cats');
    expect(buildExternalSearchUrl('cats', 'google')).toBe('https://www.google.com/search?q=cats');
    expect(buildExternalSearchUrl('cats', 'bing')).toBe('https://www.bing.com/search?q=cats');
  });
});

describe('buildOpenStreetMapEmbedUrl', () => {
  it('has a default Riyadh bbox', () => {
    expect(buildOpenStreetMapEmbedUrl()).toContain('bbox=46.5%2C24.5%2C46.9%2C24.9');
  });
});

describe('blocklist matching', () => {
  it('blocks exact known domains', () => {
    for (const d of ['google.com', 'facebook.com', 'x.com', 'twitter.com', 'tiktok.com', 'github.com', 'amazon.com', 'netflix.com', 'reddit.com', 'whatsapp.com', 'microsoft.com', 'live.com', 'outlook.com', 'apple.com', 'chatgpt.com', 'openai.com', 'claude.ai', 'linkedin.com', 'instagram.com']) {
      expect(isBlockedDomain(`https://${d}/`)).toBe(true);
    }
  });
  it('blocks subdomains of a blocked domain', () => {
    expect(isBlockedDomain('https://m.facebook.com/')).toBe(true);
    expect(isBlockedDomain('https://www.youtube.com/')).toBe(true);
    expect(isBlockedDomain('https://mail.google.com/')).toBe(true);
    expect(isBlockedDomain('https://accounts.google.com/')).toBe(true);
  });
  it('does NOT block a domain that merely contains the name as a substring', () => {
    expect(isBlockedDomain('https://notfacebook.com/')).toBe(false);
    expect(isBlockedDomain('https://mygoogle.com/')).toBe(false);
    expect(isBlockedDomain('https://reallygithub.com/')).toBe(false);
  });
  it('blocks google country TLDs via pattern', () => {
    expect(isBlockedDomain('https://www.google.co.uk/')).toBe(true);
    expect(isBlockedDomain('https://www.google.de/')).toBe(true);
  });
  it('exempts youtube-nocookie.com embeds from the youtube.com block', () => {
    expect(isBlockedDomain('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toBe(false);
  });
  it('allows ordinary sites', () => {
    expect(isBlockedDomain('https://ar.wikipedia.org/')).toBe(false);
    expect(isBlockedDomain('https://www.openstreetmap.org/')).toBe(false);
    expect(isBlockedDomain('https://archive.org/')).toBe(false);
    expect(isBlockedDomain('https://developer.mozilla.org/')).toBe(false);
  });
});
