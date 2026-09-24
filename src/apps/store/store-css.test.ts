/// <reference types="node" />
/*
 * `node` types are pulled in for THIS FILE only. The root tsconfig lists `types: ["vite/client"]`
 * and does not include node, so a bare `import ... from 'node:fs'` fails `npm run typecheck`
 * even though @types/node is present in the tree. This test has to read the stylesheet as text
 * (jsdom has no layout engine), so it opts into node types here rather than widening the whole
 * project's compiler options from inside an app folder.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The Store's visual contract: tidy spacing, a calm grid, equal card rhythm, sticky chrome,
 * 44px touch targets and one focus ring — in both themes, in both directions.
 *
 * jsdom has no layout engine, so this cannot re-measure pixels. It pins the CSS CONTRACT that
 * produces that look, which is exactly the part a later edit could silently undo. Anything it
 * cannot see (real rendered geometry, contrast in a real browser) is stated in the report
 * instead of being assumed here.
 */
/**
 * Read a source file with its newlines normalised to `\n`.
 *
 * Why this exists: `desktop-release.yml` builds on `windows-latest`, which checks the repo out
 * with CRLF line endings, while `pr-checks.yml` runs on `ubuntu-latest` with LF. A raw multi-line
 * read therefore made such an assertion pass on the pull-request check and fail on the release
 * build — four desktop releases in this repo died that way (see `src/apps/photo/photo-css.test.ts`).
 * Normalising keeps every assertion just as strong without pinning the platform, so the same
 * commit is judged the same way on both runners.
 */
function readSource(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8').replace(/\r\n/g, '\n');
}

const css = readSource('src/apps/store/store.css');
/**
 * The sheet with its block comments stripped. Prose must not be able to satisfy — or trip — an
 * assertion that is about code: the file explains in a comment that it does NOT patch colours
 * per theme, and that sentence used to make the parity assertions below read as failures.
 */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The body of a `@container faisal-window (...) { … }` block, by its condition text.
 *
 * The Store keys its width rules off the WINDOW it lives in, not the screen: a window is
 * usually narrower than the display (`theme.css` declares `.faisal-window-content` as
 * `container: faisal-window / inline-size`, the same container every other app uses). A
 * viewport media query here was the bug: on a 1440px screen the default 640px window still
 * got three columns of 190px cards and a horizontal scrollbar.
 */
function containerBlock(condition: string): string {
  const start = css.indexOf(`@container faisal-window ${condition}`);
  expect(start, `container query ${condition} exists`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
    }
  }
  throw new Error(`unclosed container block: ${condition}`);
}

/** A rule body by exact selector inside a text chunk. */
function ruleBody(chunk: string, selector: string): string {
  const at = chunk.indexOf(`${selector} {`);
  expect(at, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
  const open = chunk.indexOf('{', at);
  const close = chunk.indexOf('}', open);
  return chunk.slice(open + 1, close);
}

const wide = css.slice(0, css.indexOf('@container faisal-window (max-width: 1023px)'));
const medium = containerBlock('(max-width: 1023px)');
const narrow = containerBlock('(max-width: 480px)');

describe('store CSS — the grid follows the window, never the viewport', () => {
  it('states its width rules as container queries on the named window container', () => {
    expect(code).toContain('@container faisal-window (max-width: 1023px)');
    expect(code).toContain('@container faisal-window (max-width: 480px)');
  });

  it('keeps no viewport media query for the grid, which is what looked cramped on a wide screen', () => {
    expect(code).not.toContain('@media (max-width: 1023px)');
    expect(code).not.toContain('@media (max-width: 480px)');
    expect(code).not.toMatch(/@media\s*\(max-width:\s*1023px\)/);
  });
});

/* ── 1. one spacing scale, no !important ────────────────────────────── */

const SCALE = new Set(['0', '4px', '8px', '12px', '16px', '24px', '32px', 'auto']);
const SPACING_PROP = /^(padding|margin|gap|row-gap|column-gap)(-(block|inline)(-(start|end))?)?$/;

describe('store CSS — one spacing scale only', () => {
  it('uses nothing but 4/8/12/16/24/32 for every padding, gap and margin', () => {
    const offenders: string[] = [];
    for (const raw of code.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('/*') || line.startsWith('*') || line.startsWith('//')) continue;
      const decl = /^([a-z-]+)\s*:\s*([^;]+);/.exec(line);
      if (!decl) continue;
      if (!SPACING_PROP.test(decl[1])) continue;
      for (const token of decl[2].split(/[\s/]+/).filter(Boolean)) {
        if (!SCALE.has(token)) offenders.push(`${decl[1]}: ${decl[2]}`);
      }
    }
    expect([...new Set(offenders)], 'spacing values outside the 4/8/12/16/24/32 scale').toEqual([]);
  });

  it('never needs !important', () => {
    expect(code).not.toContain('!important');
  });
});

/* ── 2. a calm grid: 1 / 2 / 3 columns ──────────────────────────────── */

describe('store CSS — the grid is 1 / 2 / 3 columns and never scrolls sideways', () => {
  it('is 3 equal tracks from 1024px up, and the tracks can shrink (minmax(0, 1fr))', () => {
    const grid = ruleBody(wide, '.faisal-store-grid');
    expect(grid).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(grid).toContain('align-items: stretch'); // equal heights inside a row
    expect(grid).toContain('min-inline-size: 0');
    expect(grid).toContain('gap: 12px');
    // No fixed px track could ever overflow the body.
    expect(grid).not.toMatch(/grid-template-columns:\s*repeat\(3,\s*\d+px/);
  });

  it('is 2 columns from 481 to 1023px', () => {
    expect(ruleBody(medium, '.faisal-store-grid'))
      .toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
  });

  it('is exactly 1 column at 480px and below', () => {
    const grid = ruleBody(narrow, '.faisal-store-grid');
    expect(grid).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(grid).not.toContain('repeat(');
  });

  it('declares the narrow breakpoint after the medium one, so 480px really wins', () => {
    expect(css.indexOf('@container faisal-window (max-width: 1023px)'))
      .toBeLessThan(css.indexOf('@container faisal-window (max-width: 480px)'));
  });

  it('pins the sideways-scroll guards on the body and the card', () => {
    const body = ruleBody(css, '.faisal-store-body');
    expect(body).toContain('overflow-x: hidden');
    expect(body).toContain('overflow-y: auto'); // the body is the one scrollport
    expect(ruleBody(wide, '.faisal-store-card')).toContain('min-inline-size: 0');
    for (const forbidden of ['overflow-x: auto', 'overflow-x:auto', 'overflow-x: scroll']) {
      expect(code, `store.css must not use ${forbidden}`).not.toContain(forbidden);
    }
  });
});

/* ── 3. equal card rhythm ───────────────────────────────────────────── */

describe('store CSS — equal card rhythm', () => {
  it('clamps the card description to exactly two lines', () => {
    const desc = ruleBody(wide, '.faisal-store-card-desc');
    expect(desc).toContain('display: -webkit-box');
    expect(desc).toContain('-webkit-box-orient: vertical');
    expect(desc).toContain('-webkit-line-clamp: 2');
    expect(desc).toContain('overflow: hidden');
    // Two lines of the 1.5 line-height: one-line copy does not shorten the card.
    expect(desc).toContain('min-block-size: 3em');
    expect(desc).toContain('line-height: 1.5');
  });

  it('reserves the badges row height, so a card without a badge is exactly as tall as one with', () => {
    const badges = ruleBody(wide, '.faisal-store-badges');
    expect(badges).toContain('min-block-size: 24px');
    expect(badges).toContain('margin-block-start: auto'); // bottom-aligned in the card
    expect(badges).toContain('align-items: center');
    expect(ruleBody(wide, '.faisal-store-badge')).toContain('min-block-size: 24px');
  });

  it('keeps a fixed icon box and a one-line name/category block', () => {
    const icon = ruleBody(wide, '.faisal-store-card-icon');
    expect(icon).toContain('inline-size: 48px');
    expect(icon).toContain('block-size: 48px');
    expect(icon).toContain('flex: 0 0 auto');
    expect(ruleBody(wide, '.faisal-store-card-head')).toContain('min-inline-size: 0');
    for (const part of ['.faisal-store-card-name', '.faisal-store-card-cat']) {
      const rule = ruleBody(wide, part);
      expect(rule, `${part} must not wrap into a second line`).toContain('white-space: nowrap');
      expect(rule).toContain('text-overflow: ellipsis');
    }
  });
});

/* ── 4. sticky chrome ───────────────────────────────────────────────── */

describe('store CSS — header and tabs stay reachable over the scrolling body', () => {
  it('sticks the header and the tabs to the block start', () => {
    for (const selector of ['.faisal-store-header', '.faisal-store-tabs']) {
      const rule = ruleBody(css, selector);
      expect(rule, `${selector} must be sticky`).toContain('position: sticky');
      expect(rule).toContain('inset-block-start: 0');
      expect(rule).toMatch(/z-index: \d+/);
      // Opaque token background: nothing shows through as the body scrolls underneath.
      expect(rule, `${selector} needs an opaque background`).toMatch(/background: var\(--faisal-bg/);
    }
    // The header sits above the tabs in the stacking order.
    expect(Number(/z-index: (\d+)/.exec(ruleBody(css, '.faisal-store-header'))?.[1]))
      .toBeGreaterThan(Number(/z-index: (\d+)/.exec(ruleBody(css, '.faisal-store-tabs'))?.[1]));
  });

  it('reserves the scrollbar gutter so filtering does not shift the layout', () => {
    expect(ruleBody(css, '.faisal-store-body')).toContain('scrollbar-gutter: stable');
  });

  it('lays the search + chips row out as one wrapping row inside the header', () => {
    const controls = ruleBody(css, '.faisal-store-controls');
    expect(controls).toContain('display: flex');
    expect(controls).toContain('flex-wrap: wrap');
    expect(controls).toContain('gap: 8px');
    expect(ruleBody(css, '.faisal-store-search')).toContain('flex: 1 1 auto');
    expect(ruleBody(css, '.faisal-store-chips')).toContain('flex-wrap: wrap');
  });

  it('hides the inactive panels and the detail-view search row the way index.ts hides them', () => {
    // `panel.hidden = !active` and `controls.hidden = true` in the detail view: the author
    // `display` rules above must not out-rank the UA `[hidden] { display: none }`.
    expect(ruleBody(css, '.faisal-store-body[hidden]')).toContain('display: none');
    expect(ruleBody(css, '.faisal-store-controls[hidden]')).toContain('display: none');
    // With the search row hidden the header would be an empty strip: collapse it.
    expect(code).toContain('.faisal-store-header:not(:has(.faisal-store-controls:not([hidden])))');
  });
});

/* ── 5. 44px touch targets ──────────────────────────────────────────── */

describe('store CSS — every interactive target is at least 44px tall', () => {
  it('gives the search field, chips, tabs, cards, back and action buttons a 44px floor', () => {
    const targets = [
      '.faisal-store-search',
      '.faisal-store-chip',
      '.faisal-store-tab',
      '.faisal-store-card',
      '.faisal-store-back',
      '.faisal-store-btn',
      '.faisal-store-banner',
    ];
    for (const selector of targets) {
      expect(ruleBody(css, selector), `${selector} must be ≥ 44px tall`)
        .toContain('min-block-size: 44px');
    }
  });
});

/* ── 6. one focus ring, brand coloured ──────────────────────────────── */

describe('store CSS — one visible brand focus ring, never hover only', () => {
  const ringStart = css.indexOf('.faisal-store-chip:focus-visible');
  const ringOpen = css.indexOf('{', ringStart);
  const ringSelectors = css.slice(ringStart, ringOpen);
  const ringBody = css.slice(ringOpen + 1, css.indexOf('}', ringOpen));

  it('draws one 2px brand ring for chips, tabs, cards, search, back and buttons', () => {
    expect(ringStart, 'a :focus-visible ring rule exists').toBeGreaterThanOrEqual(0);
    for (const selector of [
      '.faisal-store-chip:focus-visible',
      '.faisal-store-tab:focus-visible',
      '.faisal-store-card:focus-visible',
      '.faisal-store-search:focus-visible',
      '.faisal-store-back:focus-visible',
      '.faisal-store-btn:focus-visible',
    ]) {
      expect(ringSelectors, `${selector} must share the one ring`).toContain(selector);
    }
    expect(ringBody).toContain('outline: 2px solid var(--faisal-focus-ring');
    expect(ringBody).toContain('outline-offset: 2px');
    // No second, competing ring style on the same controls.
    expect(css).not.toContain('.faisal-store-search:focus {');
    expect(css).not.toContain('.faisal-store-card:focus {');
  });

  it('keeps a ring on the dark banner with the brand gold', () => {
    expect(ruleBody(css, '.faisal-store-banner:focus-visible'))
      .toContain('outline: 2px solid var(--faisal-brand-gold-light)');
  });
});

/* ── 7. dark/light parity, tokens only, logical properties ──────────── */

/*
 * The raw hex values already present before this pass (used as `var(--token, fallback)`
 * fallbacks). Anything outside this set is a NEW colour literal and would break parity,
 * because a raw colour cannot follow `data-theme` / `prefers-color-scheme`.
 */
const HEX_BASELINE = new Set([
  '#0b1530', '#16264f', '#1a1d26', '#22386f', '#2e7d4f', '#565b67',
  '#7fd9a4', '#8a6510', '#8f6412', '#c01c28', '#ecebe6', '#f0cf7a', '#f5f4f1', '#fff',
  '#fff',
]);

describe('store CSS — dark and light parity come from tokens', () => {
  it('adds no new raw colour literal', () => {
    const found = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    const added = [...new Set(found.map((h) => h.toLowerCase()))].filter((h) => !HEX_BASELINE.has(h));
    expect(added, `new raw colours (a raw colour cannot follow the theme): ${added.join(', ')}`).toEqual([]);
  });

  it('keeps rgba() out of the sheet except as a --faisal-* token fallback', () => {
    for (const line of code.split('\n')) {
      if (!line.includes('rgba(')) continue;
      expect(line.trim(), `raw rgba() outside a token fallback: ${line.trim()}`)
        .toContain('var(--faisal-');
    }
  });

  it('needs no per-theme colour override at all', () => {
    expect(code).not.toContain('data-theme');
    expect(code).not.toContain('prefers-color-scheme');
  });

  it('never mirrors incorrectly: no physical left/right offsets', () => {
    for (const raw of code.split('\n')) {
      const line = raw.trim();
      expect(line, `physical horizontal property in: ${line}`).not.toMatch(/^(padding|margin)-(left|right):/);
      expect(line, `physical horizontal property in: ${line}`).not.toMatch(/^(left|right):/);
    }
  });
});

/* ── 8. a deliberate empty state ────────────────────────────────────── */

describe('store CSS — the empty state looks deliberate', () => {
  it('draws a bordered panel instead of a bare line of text', () => {
    const empty = ruleBody(css, '.faisal-store-empty');
    expect(empty).toContain('text-align: center');
    expect(empty).toContain('border: 1px dashed var(--faisal-border');
    expect(empty).toContain('border-radius: var(--faisal-radius');
    expect(empty).toMatch(/background: var\(--faisal-surface/);
    expect(empty).toContain('padding: 32px 24px');
  });
});

/* ── 9. the frozen structure is fully covered ───────────────────────── */

/** Every class name in the frozen store structure this sheet shares with `index.ts`. */
const FROZEN_CLASSES = [
  'faisal-store', 'faisal-store-header', 'faisal-store-search', 'faisal-store-chips',
  'faisal-store-chip', 'faisal-store-tabs', 'faisal-store-tab', 'faisal-store-body',
  'faisal-store-banner', 'faisal-store-banner-icon', 'faisal-store-banner-text',
  'faisal-store-banner-eyebrow', 'faisal-store-banner-name', 'faisal-store-banner-desc',
  'faisal-store-banner-cta', 'faisal-store-grid', 'faisal-store-card',
  'faisal-store-card-top', 'faisal-store-card-icon', 'faisal-store-card-head',
  'faisal-store-card-name', 'faisal-store-card-cat', 'faisal-store-card-desc',
  'faisal-store-card-released', 'faisal-store-badges', 'faisal-store-badge',
  'faisal-store-detail', 'faisal-store-back', 'faisal-store-detail-head',
  'faisal-store-detail-icon', 'faisal-store-detail-info', 'faisal-store-detail-name',
  'faisal-store-detail-meta', 'faisal-store-detail-desc', 'faisal-store-detail-actions',
  'faisal-store-btn', 'faisal-store-detail-section', 'faisal-store-permissions',
  'faisal-store-perm-item', 'faisal-store-perm-dot', 'faisal-store-empty',
];

describe('store CSS — the shared structure is fully styled', () => {
  it('has a real rule for every frozen class name (no half-styled shared DOM)', () => {
    const missing = FROZEN_CLASSES.filter((name) => !new RegExp(`\\.${name}\\s*[,{:]`).test(code));
    expect(missing, `frozen classes with no rule of their own: ${missing.join(', ')}`).toEqual([]);
  });

  it('gives the detail section headings one shared look', () => {
    const title = ruleBody(css, '.faisal-store-detail-section-title');
    expect(title).toContain('text-transform: uppercase');
    expect(title).toContain('color: var(--faisal-fg-muted');
    expect(title).toContain('margin-block-end: 8px');
  });

  it('marks the powerful-permission warning with the danger token, not colour alone', () => {
    expect(ruleBody(css, '.faisal-store-perm-warning'))
      .toContain('color: var(--store-danger-ink)');
    expect(ruleBody(css, '.faisal-store-perm-item.is-warning'))
      .toContain('border-color: var(--store-danger-ink)');
  });
});
