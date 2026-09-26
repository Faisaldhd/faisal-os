/// <reference types="node" />
/*
 * Writer, Calc and Impress share one stylesheet, so an unscoped class defined twice lets the later
 * app silently restyle the earlier one. jsdom has no layout engine, so these read the CSS as text.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, 'office.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level rule bodies whose selector list is exactly `selector`. */
function rulesFor(selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (sels.includes(selector)) out.push(m[2]);
  }
  return out;
}

describe('office.css: shared class names stay scoped', () => {
  it('the bare .fo-canvas (the Writer page) is never absolutely positioned', () => {
    for (const body of rulesFor('.fo-canvas')) expect(body).not.toMatch(/position\s*:\s*absolute/);
  });

  it('the slide canvas is positioned only inside its frame', () => {
    expect(rulesFor('.fo-canvasframe > .fo-canvas').join('')).toMatch(/position\s*:\s*absolute/);
  });

  it('the fill handle has one definition and no solid 44px background', () => {
    const bodies = rulesFor('.fo-fillhandle');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toMatch(/background\s*:/);
  });
});
