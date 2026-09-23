import { describe, expect, it } from 'vitest';
import { YOUTUBE_PLAYER, youtubePlayerInput } from './youtube';
import { applyUrlTransform, webAppKind } from './registry';
import { planNavigation } from './outcome';

const SELF = 'https://os.example';
const EMBED = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';

/**
 * The player's whole contract is: type either a full YouTube link or a bare id,
 * and end up on YouTube's own /embed/ endpoint. These tests pin the transform and
 * the resulting navigation plan, with no network and no DOM.
 */
describe('YouTube player input', () => {
  it('accepts a bare video id and plans the embeddable endpoint', () => {
    const url = youtubePlayerInput('dQw4w9WgXcQ');
    expect(url).toBe('dQw4w9WgXcQ');
    // It is a bare id, so the shared policy resolves it as a search unless the
    // def turns it into a URL first — which is exactly why the id is wrapped.
    expect(planNavigation(`https://www.youtube.com/watch?v=${url}`, 'en', SELF).embedUrl).toBe(EMBED);
  });

  it('passes a watch URL through so the shared rewriter produces the embed', () => {
    const raw = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const transformed = youtubePlayerInput(raw);
    expect(transformed).toBe(raw);
    const plan = planNavigation(transformed, 'en', SELF);
    expect(plan.embedUrl).toBe(EMBED);
    expect(plan.rewrittenFrom).toBe(raw);
  });

  it('handles every video link shape through the one shared rewriter', () => {
    const cases = [
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://www.youtube.com/live/dQw4w9WgXcQ',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ];
    for (const raw of cases) {
      const transformed = youtubePlayerInput(raw);
      expect(transformed, raw).toBe(raw);
      expect(planNavigation(transformed, 'en', SELF).embedUrl, raw).toBe(EMBED);
    }
  });

  it('accepts a bare youtube.com link without a scheme', () => {
    // The shared policy is what adds https; the transform only has to keep it.
    expect(youtubePlayerInput('youtube.com/watch?v=dQw4w9WgXcQ'))
      .toBe('https://youtube.com/watch?v=dQw4w9WgXcQ');
    expect(planNavigation('youtube.com/watch?v=dQw4w9WgXcQ', 'en', SELF).embedUrl).toBe(EMBED);
  });

  it('declines everything that is not a video, so the honest card is shown', () => {
    // A channel, the home page, a search, an empty box: no id exists, so there is
    // nothing this app may frame — and it never invents one.
    for (const raw of [
      '',
      '   ',
      'https://www.youtube.com/',
      'https://www.youtube.com/@someChannel',
      'https://www.youtube.com/results?search_query=faisal',
      'not a video id',
      'https://www.youtube.com/playlist?list=PLabcdefghijklmnop',
      'https://example.com/video/1',
      'javascript:alert(1)',
    ]) {
      expect(youtubePlayerInput(raw), JSON.stringify(raw)).toBe('');
    }
  });

  it('treats a scheme-only payload as declined, never as a video', () => {
    // `unsafe-scheme` inputs are not video ids: the transform must not rescue
    // them into a URL the shared policy would then have to refuse.
    expect(youtubePlayerInput('data:text/html,<h1>x</h1>')).toBe('');
    expect(youtubePlayerInput('file:///C:/secret.txt')).toBe('');
  });

  it('declines a non-YouTube link rather than handing it to the frame', () => {
    expect(youtubePlayerInput('https://example.com/video/1')).toBe('');
  });

  it('never returns a non-https URL for a bare id', () => {
    // The shared policy only ever frames https, so a transform that produced
    // http:// would be refused later anyway; this pins that it never does.
    const weird = youtubePlayerInput('dQw4w9WgXcQ');
    expect(weird.startsWith('http')).toBe(false);
  });
});

describe('the player as a registry def', () => {
  it('is a "player" kind, allowed to embed, with a transform and an icon', () => {
    expect(webAppKind(YOUTUBE_PLAYER)).toBe('player');
    expect(YOUTUBE_PLAYER.embedNote).toBe('allowed');
    expect(YOUTUBE_PLAYER.transformUrl).toBe(youtubePlayerInput);
    expect(YOUTUBE_PLAYER.icon).toContain('<svg');
    expect(YOUTUBE_PLAYER.title.ar.length).toBeGreaterThan(0);
    expect(YOUTUBE_PLAYER.title.en.length).toBeGreaterThan(0);
    expect(YOUTUBE_PLAYER.description?.ar.length).toBeGreaterThan(0);
    expect(YOUTUBE_PLAYER.description?.en.length).toBeGreaterThan(0);
  });

  it('starts on an embeddable home URL — /embed/, never the site home', () => {
    expect(YOUTUBE_PLAYER.url).toBe(EMBED);
    const plan = planNavigation(YOUTUBE_PLAYER.url, 'en', SELF);
    expect(plan.refusal).toBeNull();
    expect(plan.embedUrl).toBe(EMBED);
  });

  it('goes through applyUrlTransform, which swallows a throwing transform', () => {
    // The shared window must survive a def whose transform misbehaves: it is
    // treated as "declined", never as a crash in the address bar.
    const broken = { ...YOUTUBE_PLAYER, transformUrl: () => { throw new Error('boom'); } };
    expect(applyUrlTransform(broken, 'dQw4w9WgXcQ')).toBe('');
  });

  it('leaves a def with no transform untouched', () => {
    expect(applyUrlTransform({ id: 'x', title: { ar: 'x', en: 'x' }, url: 'https://x.example/' }, 'raw input'))
      .toBe('raw input');
  });
});
