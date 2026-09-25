import { describe, expect, it } from 'vitest';
import { formatCursor, formatTick, labelAnchor, rulerCursor, rulerStep, rulerTicks, valueAt } from './rulers';

/**
 * The rulers' arithmetic, which is the part a screenshot cannot check: a tick must sit at the
 * screen position the image maps to, and the number beside it must be the document pixel under
 * that tick — at any zoom, with any pan.
 */
describe('rulerStep — a 1-2-5 step whose spacing clears the label floor', () => {
  it('grows the step as the image shrinks so labels never collide', () => {
    expect(rulerStep(1, 48)).toBe(50);
    expect(rulerStep(0.5, 48)).toBe(100);
    expect(rulerStep(2, 48)).toBe(50);
    expect(rulerStep(4, 48)).toBe(20);
    expect(rulerStep(10, 48)).toBe(5);
    expect(rulerStep(40, 48)).toBe(2);
  });

  it('falls back to zoom 1 for a nonsense zoom instead of looping forever', () => {
    expect(rulerStep(0, 48)).toBe(50);
    expect(rulerStep(Number.NaN, 48)).toBe(50);
    expect(rulerStep(-3, 48)).toBe(50);
  });
});

describe('rulerTicks — screen positions that line up with the document', () => {
  it('places a major tick exactly where document 0 sits, whatever the pan', () => {
    const ticks = rulerTicks(400, 120, 1);
    const zero = ticks.find((t) => t.major && t.value === 0);
    expect(zero?.pos).toBe(120);
  });

  it('places ticks at document values times the zoom, offset by the pan', () => {
    const ticks = rulerTicks(400, 30, 2).filter((t) => t.major);
    // With zoom 2 and a 48px floor the step is 50 document px = 100 screen px.
    expect(ticks.map((t) => [t.value, t.pos])).toEqual([[0, 30], [50, 130], [100, 230], [150, 330]]);
  });

  it('keeps the tick values ascending, majors and minors together', () => {
    const ticks = rulerTicks(500, -160, 3);
    expect(ticks.length).toBeGreaterThan(10);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].value).toBeGreaterThanOrEqual(ticks[i - 1].value);
    expect(ticks.filter((t) => t.major).length).toBeGreaterThan(0);
    expect(ticks.filter((t) => !t.major).length).toBeGreaterThan(0);
  });

  it('keeps the minors between the majors, never closer than a few pixels, and never off the end', () => {
    for (const [length, pan, zoom] of [[600, 0, 0.1], [320, -45, 1], [320, 900, 1], [900, -1200, 0.35]] as const) {
      const ticks = rulerTicks(length, pan, zoom);
      expect(ticks.some((t) => t.major)).toBe(true);
      expect(ticks.some((t) => !t.major)).toBe(true);
      for (const t of ticks) {
        expect(t.pos).toBeGreaterThanOrEqual(-1);
        expect(t.pos).toBeLessThanOrEqual(length + 1);
      }
      for (let i = 1; i < ticks.length; i++) expect(ticks[i].pos - ticks[i - 1].pos).toBeGreaterThanOrEqual(4);
    }
  });

  it('asks for nothing when the ruler has no length or an absurd zoom', () => {
    expect(rulerTicks(0, 0, 1)).toEqual([]);
    expect(rulerTicks(-10, 0, 1)).toEqual([]);
    expect(rulerTicks(300, 0, Number.NaN).length).toBeGreaterThan(0);
  });

  it('labels the document pixel, not the screen pixel, at two zooms', () => {
    const atOne = rulerTicks(200, 0, 1).filter((t) => t.major).map((t) => t.value);
    const atFour = rulerTicks(200, 0, 4).filter((t) => t.major).map((t) => t.value);
    // zoomed in, the same 200px shows less of the document — so its values stay smaller
    expect(atOne[atOne.length - 1]).toBeGreaterThan(atFour[atFour.length - 1]);
  });
});

describe('labels, cursors and readouts', () => {
  it('prints integers for whole steps and one decimal for sub-pixel steps', () => {
    expect(formatTick(250, 50)).toBe('250');
    expect(formatTick(0.5, 0.5)).toBe('0.5');
    expect(formatTick(-120, 50)).toBe('-120');
  });

  it('keeps a label inside the ruler at both ends', () => {
    expect(labelAnchor(0, 300, 12)).toBe(12);
    expect(labelAnchor(300, 300, 12)).toBe(288);
    expect(labelAnchor(150, 300, 12)).toBe(150);
  });

  it('shows the cursor only while it is over the ruler, and reads the document value', () => {
    expect(rulerCursor(-2, 300)).toBeNull();
    expect(rulerCursor(301, 300)).toBeNull();
    expect(rulerCursor(40, 300)).toBe(40);
    expect(valueAt(130, 30, 2)).toBe(50);
    expect(formatCursor(30, 30, 2)).toBe('0');
    expect(formatCursor(33, 30, 2)).toBe('1.5');
    expect(formatCursor(30, -1970, 2)).toBe('1000');
  });
});
