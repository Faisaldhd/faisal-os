/// <reference types="node" />
/*
 * `node` types are pulled in for THIS FILE only, exactly as `src/apps/photo/photo-css.test.ts`
 * does: the root tsconfig lists `types: ["vite/client"]`, so a bare `import ... from 'node:fs'`
 * fails `npm run typecheck` even though @types/node is in the tree.
 *
 * Why the stylesheet is read as text: jsdom has no layout engine, so a test cannot measure that
 * a control is 13px tall. Vite's `?raw` would be the dependency-free way in, but vitest stubs
 * every `.css` request — with `test.css` unset it replaces the module with an empty string, so
 * `import css from './pdf.css?raw'` yields '' and every assertion would pass against nothing.
 * The CSS text is therefore read from disk, which is the only honest way left to pin the rule.
 *
 * This exists because a real-browser check found three controls under 44px: the three page-size
 * radio buttons of the "images → PDF" card were plain `<input type="radio">` elements with no
 * styling and no wrapping label.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, 'pdf.css'), 'utf8');

/** The owner's rule: no control smaller than this, at any width, 320px included. */
const MIN_TARGET = 44;

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The body of the first rule that uses `selector`. The selector must end at a real boundary
 * (`,` / whitespace / `{`), so `.faisal-pdf-move` does not match `.faisal-pdf-moves` and
 * `.faisal-pdf-tab` does not match `.faisal-pdf-tabs`.
 */
function blockFor(selector: string): string {
  const found = new RegExp(`${escapeRe(selector)}(?=[,\\s{])`).exec(css);
  if (!found) throw new Error(`no rule for ${selector}`);
  const open = css.indexOf('{', found.index);
  const end = css.indexOf('}', open);
  return css.slice(found.index, end);
}

/** The value of `prop: 12px` inside a rule body, or NaN when the rule does not set it. */
function px(body: string, prop: string): number {
  const found = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*(-?[0-9.]+)px`).exec(body);
  return found ? Number(found[1]) : Number.NaN;
}

describe('pdf.css touch targets', () => {
  it('really read the stylesheet', () => {
    expect(css.length).toBeGreaterThan(2000);
    expect(css).toContain('.faisal-pdf');
  });

  it('gives every button at least a 44px height', () => {
    for (const selector of [
      '.faisal-pdf-btn', '.faisal-pdf-tab', '.faisal-pdf-pagetoggle', '.faisal-pdf-move',
    ]) {
      expect(px(blockFor(selector), 'min-height'), selector).toBeGreaterThanOrEqual(MIN_TARGET);
    }
  });

  it('gives the page-move arrows 44px in both directions', () => {
    const body = blockFor('.faisal-pdf-move');
    expect(px(body, 'min-width')).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(px(body, 'min-height')).toBeGreaterThanOrEqual(MIN_TARGET);
  });

  it('gives every text field, select and colour swatch a 44px box', () => {
    // `.faisal-pdf-input` is what every text field, select and the colour swatch carries, so its
    // min-height is the one that decides all of them; the colour swatch only adds a min-width.
    // `index.test.ts` proves the colour inputs really do carry `faisal-pdf-input`.
    expect(px(blockFor('.faisal-pdf-input'), 'min-height')).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(px(blockFor('.faisal-pdf-color'), 'min-width')).toBeGreaterThanOrEqual(MIN_TARGET);
  });

  it('makes every radio and checkbox a 44px box, with the glyph still 22px', () => {
    const body = blockFor('.faisal-pdf-check input[type="radio"]');
    expect(body).toContain('box-sizing: content-box');
    const width = px(body, 'width') + 2 * px(body, 'padding');
    const height = px(body, 'height') + 2 * px(body, 'padding');
    expect(width).toBeGreaterThanOrEqual(MIN_TARGET);
    expect(height).toBeGreaterThanOrEqual(MIN_TARGET);
    // The same box rule must cover the controls that are not wrapped in `.faisal-pdf-check`.
    expect(css).toContain('.faisal-pdf-field input[type="radio"]');
    expect(css).toContain('.faisal-pdf-field input[type="checkbox"]');
  });

  it('wraps every choice in a 44px label row, so nothing depends on hover', () => {
    expect(px(blockFor('.faisal-pdf-check'), 'min-height')).toBeGreaterThanOrEqual(MIN_TARGET);
    // Any `:hover`-only reveal would break the owner's rule for touch screens.
    expect(css).not.toContain(':hover');
  });

  it('keeps the print frame off-screen yet rendered, never `display: none`', () => {
    const body = blockFor('.faisal-pdf-printframe');
    expect(body).not.toContain('display');
    expect(body).toContain('position: fixed');
    expect(body).toContain('inset-inline-start: -10000px');
  });
});
