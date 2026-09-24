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
 * The tool strip must never put a tool off-screen.
 *
 * This was measured in a real Chrome at 320×640: the sheet used to make `.faisal-photo-tools`
 * a single horizontal scrolling row, the row's content was 626px wide against a 302px client
 * width, and five tools sat outside the viewport. jsdom has no layout engine, so this test
 * cannot re-measure pixels — it pins the CSS CONTRACT that produced the fix, which is the part
 * a later edit could silently undo:
 *
 *   1. at ≤760px the strip is a wrapping 3-column grid (so all nine tools are on screen),
 *   2. nothing inside the photo sheet scrolls horizontally at any width,
 *   3. the ≥720px desktop layout is untouched (a single column strip, no wrap),
 *   4. every tool keeps a touch target of at least 44px in both axes.
 *
 * Anything this test cannot see (real rendered geometry) is stated in the report instead of
 * being assumed here.
 */
const css = readFileSync(resolve(process.cwd(), 'src/apps/photo/photo.css'), 'utf8');
const indexSource = readFileSync(resolve(process.cwd(), 'src/apps/photo/index.ts'), 'utf8');

/** The body of a `@media (...) { … }` block, by its condition text. */
function mediaBlock(condition: string): string {
  const start = css.indexOf(`@media ${condition}`);
  expect(start, `media query ${condition} exists`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
    }
  }
  throw new Error(`unclosed media block: ${condition}`);
}

/** A rule body by selector inside a text chunk. */
function ruleBody(chunk: string, selector: string): string {
  const at = chunk.indexOf(`${selector} {`);
  expect(at, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
  const open = chunk.indexOf('{', at);
  const close = chunk.indexOf('}', open);
  return chunk.slice(open + 1, close);
}

const narrow = mediaBlock('(max-width: 760px)');
const veryNarrow = mediaBlock('(max-width: 480px)');

describe('photo phones CSS — every tool stays on screen at 320px', () => {
  it('turns the tool strip into a 3-column grid below 760px, not a scrolling row', () => {
    const tools = ruleBody(narrow, '.faisal-photo-tools');
    expect(tools).toContain('display: grid');
    expect(tools).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    // The measured overflow came from this exact property; it must not come back.
    expect(tools).not.toContain('overflow-x: auto');
    expect(tools).not.toContain('overflow-x:auto');
    expect(tools).toContain('overflow: visible');
  });

  it('keeps every tool a touch target of at least 44px in both axes', () => {
    const tool = ruleBody(narrow, '.faisal-photo-tool');
    expect(tool).toContain('min-height: 52px'); // ≥ the 44px floor, with its own padding
    expect(tool).toContain('min-width: 0');
    // No fixed width that could exceed a 320px/3 column (≈97px) and overflow the cell.
    expect(tool).not.toMatch(/min-width:\s*\d\d+px/);
    expect(tool).toContain('overflow-wrap: anywhere');
  });

  it('hides the visible word below 480px but keeps the accessible name on the button', () => {
    const tool = ruleBody(veryNarrow, '.faisal-photo-tool');
    expect(tool).toContain('font-size: 0');
    // The name is not lost with the text: every tool button carries aria-label plus
    // aria-pressed, and the SVG inside is decorative. Assert that at its source.
    const index = indexSource;
    const toolButton = index.slice(
      index.indexOf('function toolButton'),
      index.indexOf('function toolButton') + 400,
    );
    expect(toolButton).toContain("b.setAttribute('aria-label', label)");
    expect(toolButton).toContain('renderIcon(iconMarkup)');
    expect(index).toContain("b.setAttribute('aria-pressed', String(key === id))");
  });

  it('does not scroll horizontally anywhere in this sheet', () => {
    for (const forbidden of ['overflow-x: auto', 'overflow-x:auto', 'overflow-x: scroll', 'white-space: nowrap']) {
      expect(css, `photo.css must not use ${forbidden}`).not.toContain(forbidden);
    }
    // The only horizontal overflow left is the dialog's max-width guard, which is vertical.
    expect(css).toContain('inline-size: min(92vw, 420px)');
  });
});

describe('photo desktop CSS — the wide layout is untouched', () => {
  it('keeps the strip a single vertical column with no wrap above the phone breakpoint', () => {
    const base = css.slice(0, css.indexOf('@media (max-width: 760px)'));
    const tools = ruleBody(base, '.faisal-photo-tools');
    expect(tools).toContain('flex-direction: column');
    expect(tools).not.toContain('flex-wrap');
    expect(tools).not.toContain('display: grid');
  });

  it('keeps the three-region desktop grid and the 44px button floor', () => {
    const base = css.slice(0, css.indexOf('@media (max-width: 760px)'));
    expect(base).toContain("grid-template-areas:\n    'bar bar bar'\n    'tools stage stage'\n    'tools stage inspect'");
    for (const selector of ['.faisal-photo-btn,', '.faisal-photo-tool,', '.faisal-photo-primary {']) {
      expect(base).toContain(selector);
    }
    expect(base).toMatch(/\.faisal-photo-btn,[\s\S]{0,80}min-height: 44px/);
  });

  it('uses only logical (RTL-safe) spacing properties for horizontal padding and margins', () => {
    for (const line of css.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
      expect(trimmed, `physical horizontal property in: ${trimmed}`)
        .not.toMatch(/^(padding|margin)-(left|right):/);
    }
  });
});
