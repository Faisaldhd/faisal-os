import { describe, expect, it } from 'vitest';
import {
  blendTextMask, clampBrush, clampFont, coverageOf, dragRect, paintArrow, paintEllipse, paintOp,
  paintRect, parseHexColor, stampDot, strokeSegment, textBoxSize, clampTextPosition, TOOL_MAX_DIMENSION,
  MAX_BRUSH, MIN_BRUSH, MIN_FONT, MAX_FONT,
} from './tools';
import { createBuffer } from './pixels';
import type { PixelBuffer } from './types';

function target(buffer: PixelBuffer = createBuffer(20, 20)): PixelBuffer {
  for (let i = 0; i < buffer.data.length; i += 4) {
    buffer.data[i] = 255; buffer.data[i + 1] = 255; buffer.data[i + 2] = 255; buffer.data[i + 3] = 255;
  }
  return buffer;
}

const pixel = (b: PixelBuffer, x: number, y: number) => {
  const i = (y * b.width + x) * 4;
  return [b.data[i], b.data[i + 1], b.data[i + 2], b.data[i + 3]] as const;
};

describe('tools — colour parsing', () => {
  it('parses #rrggbb and #rgb, and falls back to black', () => {
    expect(parseHexColor('#ff3b30')).toEqual([255, 59, 48]);
    expect(parseHexColor('00ff00')).toEqual([0, 255, 0]);
    expect(parseHexColor('#f00')).toEqual([255, 0, 0]);
    expect(parseHexColor('not-a-colour')).toEqual([0, 0, 0]);
  });
});

describe('tools — brush stamp coverage', () => {
  it('covers its centre fully, its rim partially and its outside not at all', () => {
    expect(coverageOf(10, 10, 3, 10, 10)).toBe(1);
    expect(coverageOf(10, 10, 3, 30, 30)).toBe(0);
    expect(coverageOf(10, 10, 3, 12, 10)).toBeGreaterThan(0);
    expect(coverageOf(10, 10, 3, 12.5, 10)).toBeGreaterThan(0);
    expect(coverageOf(10, 10, 3, 13, 10)).toBe(0);
    expect(coverageOf(10, 10, 0, 10, 10)).toBe(0);
  });

  it('is monotone: a pixel closer to the centre is covered at least as much', () => {
    const near = coverageOf(10, 10, 4, 12, 10);
    const far = coverageOf(10, 10, 4, 13, 10);
    expect(near).toBeGreaterThanOrEqual(far);
  });

  it('clamps the brush size into its range', () => {
    expect(clampBrush(0)).toBe(MIN_BRUSH);
    expect(clampBrush(9999)).toBe(MAX_BRUSH);
    expect(clampBrush(Number.NaN)).toBe(MIN_BRUSH);
  });
});

describe('tools — painting', () => {
  it('stamps an opaque dot on a transparent buffer, so a mark on a PNG is visible', () => {
    const b = createBuffer(20, 20);
    stampDot(b, { x: 10, y: 10 }, [255, 0, 0], 4);
    expect(pixel(b, 10, 10)[0]).toBe(255);
    expect(pixel(b, 10, 10)[3]).toBe(255);
    // Far from the stamp nothing changed.
    expect(pixel(b, 0, 0)[3]).toBe(0);
  });

  it('a stroke leaves no gaps between its endpoints', () => {
    const b = target();
    strokeSegment(b, { x: 2, y: 2 }, { x: 17, y: 17 }, [0, 0, 255], 3, 0);
    for (let d = 2; d <= 17; d++) expect(b.data[(d * b.width + d) * 4 + 2]).toBe(255);
  });

  it('drawRect outlines only the border, and filled fills the whole rectangle', () => {
    const outline = target();
    paintRect(outline, { x: 2, y: 2 }, { x: 16, y: 14 }, [0, 0, 0], 3, false);
    expect(pixel(outline, 2, 2)[0]).toBeLessThan(200);   // a corner is painted
    expect(pixel(outline, 6, 14)[0]).toBeLessThan(200);  // the bottom edge is painted
    expect(pixel(outline, 8, 6)[0]).toBe(255);           // the interior is untouched
    expect(pixel(outline, 19, 19)[0]).toBe(255);         // well outside the rectangle
    const filled = target();
    paintRect(filled, { x: 2, y: 2 }, { x: 16, y: 14 }, [0, 0, 0], 1, true);
    expect(pixel(filled, 8, 6)[0]).toBe(0);
  });

  it('a rectangle drag in any direction produces the same rectangle', () => {
    expect(dragRect({ x: 10, y: 10 }, { x: 2, y: 4 })).toEqual({ x: 2, y: 4, w: 8, h: 6 });
    expect(dragRect({ x: 2, y: 4 }, { x: 10, y: 10 })).toEqual({ x: 2, y: 4, w: 8, h: 6 });
  });

  it('an ellipse stays inside its bounding box and hollow when not filled', () => {
    const outline = target();
    paintEllipse(outline, { x: 2, y: 2 }, { x: 16, y: 12 }, [0, 0, 0], 1, false);
    // The top of the curve is painted: the box is 15×11, so its centre column is x=9 and the
    // top of the ellipse lands on y=2..3 (the inner ellipse shrunk by one pixel ends at y=3).
    expect(pixel(outline, 8, 2)[0]).toBeLessThan(255);
    expect(pixel(outline, 9, 7)[0]).toBe(255);   // the centre stays empty
    expect(pixel(outline, 0, 0)[0]).toBe(255);   // the corner outside the box is untouched
    const filled = target();
    paintEllipse(filled, { x: 2, y: 2 }, { x: 16, y: 12 }, [0, 0, 0], 1, true);
    expect(pixel(filled, 9, 7)[0]).toBe(0);
  });

  it('an arrow paints a shaft and a head that reaches off the shaft line', () => {
    const b = target();
    paintArrow(b, { x: 2, y: 18 }, { x: 18, y: 2 }, [255, 0, 0], 2);
    expect(pixel(b, 10, 10)[0]).toBe(255);   // on the shaft
    expect(pixel(b, 18, 2)[0]).toBe(255);    // the tip
    // The barbs are the only paint that is more than a stroke-width away from the shaft line;
    // scan the head area and require several such pixels.
    let offShaft = 0;
    for (let y = 2; y <= 9; y++) {
      for (let x = 12; x <= 18; x++) {
        if (pixel(b, x, y)[0] !== 255) continue;
        const distance = Math.abs((y - 18) + (x - 2)) / Math.sqrt(2);
        if (distance > 2) offShaft++;
      }
    }
    expect(offShaft).toBeGreaterThan(0);
  });

  it('paintOp dispatches every kind, and a single-point brush is a dot', () => {
    const b = target();
    paintOp(b, { kind: 'brush', from: { x: 5, y: 5 }, to: { x: 5, y: 5 }, color: '#000000', size: 3 });
    expect(pixel(b, 5, 5)[0]).toBe(0);
    // A diagonal keeps the stroke centre on the pixel centres, so the check is exact.
    const b2 = target();
    paintOp(b2, { kind: 'line', from: { x: 2, y: 2 }, to: { x: 16, y: 16 }, color: '#000000', size: 2 });
    expect(pixel(b2, 9, 9)[0]).toBe(0);
    const b3 = target();
    paintOp(b3, { kind: 'rect', from: { x: 2, y: 2 }, to: { x: 12, y: 12 }, color: '#000000', size: 1, filled: true });
    expect(pixel(b3, 7, 7)[0]).toBe(0);
    const b4 = target();
    paintOp(b4, { kind: 'ellipse', from: { x: 2, y: 2 }, to: { x: 16, y: 16 }, color: '#000000', size: 1, filled: true });
    expect(pixel(b4, 9, 9)[0]).toBe(0);
    const b5 = target();
    paintOp(b5, { kind: 'arrow', from: { x: 2, y: 2 }, to: { x: 16, y: 16 }, color: '#000000', size: 2 });
    expect(pixel(b5, 9, 9)[0]).toBe(0);
  });

  it('clips painting at the buffer edge instead of throwing', () => {
    const b = target(createBuffer(4, 4));
    stampDot(b, { x: 0, y: 0 }, [0, 0, 0], 10);
    strokeSegment(b, { x: -20, y: 2 }, { x: 40, y: 2 }, [0, 0, 0], 1, 0);
    expect(b.width).toBe(4);
    expect(pixel(b, 0, 2)[0]).toBe(0);
  });
});

describe('tools — text', () => {
  it('clamps the font size into its range', () => {
    expect(clampFont(0)).toBe(MIN_FONT);
    expect(clampFont(1000)).toBe(MAX_FONT);
    expect(clampFont(Number.NaN)).toBe(16);
    expect(clampFont(48.4)).toBe(48);
  });

  it('estimates a box that grows with the text and the font size', () => {
    const small = textBoxSize('hello', 16);
    const big = textBoxSize('hello', 64);
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.height).toBeGreaterThan(small.height);
    expect(textBoxSize('a\nb\nc', 20).height).toBeGreaterThan(textBoxSize('a', 20).height);
    expect(textBoxSize('', 20).width).toBeGreaterThan(0);
  });

  it('keeps the text position inside the image', () => {
    const at = clampTextPosition({ text: 'hello', at: { x: -50, y: 9999 }, fontSize: 32, color: '#fff' }, { width: 200, height: 100 });
    expect(at.x).toBe(0);
    expect(at.y).toBeLessThanOrEqual(100);
    expect(at.y).toBeGreaterThanOrEqual(0);
  });

  it('blends a coverage mask where it is set and leaves the rest alone', () => {
    const b = target(createBuffer(6, 6));
    const mask = new Uint8ClampedArray(4);
    mask[0] = 255; mask[1] = 128; mask[2] = 0; mask[3] = 255;
    blendTextMask(b, mask, 2, 2, { x: 1, y: 1 }, [255, 0, 0]);
    expect(pixel(b, 1, 1)[0]).toBe(255);
    expect(pixel(b, 1, 1)[1]).toBe(0);
    expect(pixel(b, 2, 1)[1]).toBeGreaterThan(0);   // half coverage keeps some white
    expect(pixel(b, 1, 2)[1]).toBe(255);            // zero coverage: untouched
    expect(pixel(b, 2, 2)[1]).toBe(0);              // full coverage
    expect(pixel(b, 0, 0)[1]).toBe(255);            // outside the mask
  });

  it('exposes the largest allocation the editor allows', () => {
    expect(TOOL_MAX_DIMENSION).toBe(16384);
  });
});
