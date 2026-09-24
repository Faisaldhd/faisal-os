import { describe, expect, it } from 'vitest';
import { frameCount, layerAlpha, layerPlan, quantize, safeAreas, scaleAbout, textFont, textPlan, toCanvas, viewFor, LINE_HEIGHT } from './layout';
import { title, video } from './fixtures';

const FRAME = { width: 1920, height: 1080 };
const measure = (s: string) => s.length * 10;
const still = { alpha: 1, dy: 0, scale: 1 };

describe('layerPlan', () => {
  it('fills a same-aspect frame with a main clip', () => {
    const plan = layerPlan({ width: 1280, height: 720 }, video('a', 'm', 3), FRAME)!;
    expect(plan.rect).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(plan.cx).toBe(960);
    expect(plan.cy).toBe(540);
    expect(plan.rotation).toBe(0);
    expect(plan.source).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
    expect(plan.width).toBe(1920);
  });

  it('letterboxes a portrait clip with contain and fills with cover', () => {
    const contain = layerPlan({ width: 1080, height: 1920 }, video('a', 'm', 3), FRAME)!;
    expect(contain.rect.height).toBe(1080);
    expect(contain.rect.width).toBeCloseTo(607.5, 5);
    const cover = layerPlan({ width: 1080, height: 1920 }, video('a', 'm', 3, { fit: 'cover' }), FRAME)!;
    expect(cover.rect.width).toBe(1920);
    expect(cover.rect.height).toBeCloseTo(3413.33, 1);
  });

  it('swaps the box for a quarter turn so the rotated picture fits', () => {
    const clip = video('a', 'm', 3, { transform: { rotation: 90, flip: { horizontal: false, vertical: false }, crop: { x: 0, y: 0, width: 1, height: 1 } } });
    const plan = layerPlan({ width: 1920, height: 1080 }, clip, FRAME)!;
    // After rotation the visible picture is portrait: 1080 wide on screen would be 607.5.
    expect(plan.rect.height).toBe(1080);
    expect(plan.rect.width).toBeCloseTo(607.5, 5);
    // The pre-rotation box is the swapped one.
    expect(plan.width).toBe(1080);
    expect(plan.height).toBeCloseTo(607.5, 5);
    expect(plan.rotation).toBeCloseTo(Math.PI / 2, 10);
  });

  it('carries flips and the crop rectangle', () => {
    const clip = video('a', 'm', 3, { transform: { rotation: 0, flip: { horizontal: true, vertical: true }, crop: { x: 0.25, y: 0, width: 0.5, height: 1 } } });
    const plan = layerPlan({ width: 1920, height: 1080 }, clip, FRAME)!;
    expect(plan.flipX).toBe(-1);
    expect(plan.flipY).toBe(-1);
    expect(plan.source).toEqual({ x: 480, y: 0, width: 960, height: 1080 });
  });

  it('places a picture-in-picture overlay by scale and centre', () => {
    const clip = video('a', 'm', 3, { scale: 0.5, x: 0.75, y: 0.25 });
    const plan = layerPlan({ width: 1920, height: 1080 }, clip, FRAME)!;
    expect(plan.rect).toEqual({ x: 1440 - 480, y: 270 - 270, width: 960, height: 540 });
  });

  it('slides by a fraction of the frame width', () => {
    const plan = layerPlan({ width: 1920, height: 1080 }, video('a', 'm', 3), FRAME, -0.5)!;
    expect(plan.rect.x).toBe(-960);
  });

  it('refuses sizes it cannot draw', () => {
    expect(layerPlan({ width: 0, height: 10 }, video('a', 'm', 3), FRAME)).toBeNull();
    expect(layerPlan({ width: 10, height: 10 }, video('a', 'm', 3), { width: 0, height: 0 })).toBeNull();
  });
});

describe('layerAlpha', () => {
  it('multiplies and clamps', () => {
    expect(layerAlpha(0.5, 0.5)).toBe(0.25);
    expect(layerAlpha(2, 1)).toBe(1);
    expect(layerAlpha(-1, 1)).toBe(0);
    expect(layerAlpha(Number.NaN, 0.4)).toBe(0.4);
  });
});

describe('textPlan', () => {
  it('lays out an Arabic title right-to-left with start on the right', () => {
    const clip = title('t', 0, 'مرحبا بالعالم', { align: 'start', size: 0.1 });
    const plan = textPlan(clip, FRAME, still, measure);
    expect(plan.direction).toBe('rtl');
    expect(plan.align).toBe('right');
    expect(plan.px).toBe(108);
    const width = measure('مرحبا بالعالم');
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].x).toBe(960 + width / 2);
    expect(plan.lines[0].y).toBe(540);
  });

  it('lays out a Latin title left-to-right with start on the left', () => {
    const plan = textPlan(title('t', 0, 'Hello', { align: 'start' }), FRAME, still, measure);
    expect(plan.direction).toBe('ltr');
    expect(plan.align).toBe('left');
    expect(plan.lines[0].x).toBe(960 - 25);
  });

  it('centres by default and uses end as the opposite edge', () => {
    expect(textPlan(title('t', 0, 'Hi'), FRAME, still, measure).align).toBe('center');
    expect(textPlan(title('t', 0, 'مرحبا', { align: 'end' }), FRAME, still, measure).align).toBe('left');
  });

  it('wraps long titles inside 90% of the frame and stacks lines around the centre', () => {
    const words = Array.from({ length: 40 }, () => 'كلمة').join(' ');
    const plan = textPlan(title('t', 0, words, { size: 0.05 }), FRAME, still, measure);
    expect(plan.lines.length).toBeGreaterThan(1);
    for (const line of plan.lines) expect(measure(line.text)).toBeLessThanOrEqual(1920 * 0.9);
    const lh = plan.px * LINE_HEIGHT;
    const mid = (plan.lines[0].y + plan.lines[plan.lines.length - 1].y) / 2;
    expect(mid).toBeCloseTo(540, 6);
    expect(plan.lines[1].y - plan.lines[0].y).toBeCloseTo(lh, 6);
  });

  it('keeps explicit line breaks', () => {
    const plan = textPlan(title('t', 0, 'سطر أول\nسطر ثان'), FRAME, still, measure);
    expect(plan.lines.map((l) => l.text)).toEqual(['سطر أول', 'سطر ثان']);
  });

  it('adds a padded background box only when asked', () => {
    expect(textPlan(title('t', 0, 'Hi'), FRAME, still, measure).box).toBeNull();
    const plan = textPlan(title('t', 0, 'Hi', { background: '#000000' }), FRAME, still, measure);
    expect(plan.box).not.toBeNull();
    expect(plan.box!.width).toBeGreaterThan(20);
    expect(plan.bounds).toEqual(plan.box);
  });

  it('applies the animation offset, alpha and scale', () => {
    const plan = textPlan(title('t', 0, 'Hi', { y: 0.5 }), FRAME, { alpha: 0.4, dy: 0.1, scale: 0.8 }, measure);
    expect(plan.cy).toBeCloseTo(0.6 * 1080, 6);
    expect(plan.alpha).toBe(0.4);
    expect(plan.scale).toBe(0.8);
  });

  it('builds a font shorthand from the Arabic-first stacks', () => {
    expect(textFont({ font: 'sans', bold: true }, 40)).toMatch(/^700 40px "Noto Sans Arabic"/);
    expect(textFont({ font: 'naskh', bold: false }, 12.345)).toMatch(/^400 12\.35px "Noto Naskh Arabic"/);
  });
});

describe('frames and guides', () => {
  it('quantises to the frame start', () => {
    expect(quantize(1.0, 30)).toBe(1);
    expect(quantize(1.02, 30)).toBeCloseTo(1, 10);
    expect(quantize(1.034, 30)).toBeCloseTo(31 / 30, 10);
    expect(quantize(-3, 30)).toBe(0);
    expect(quantize(Number.NaN, 30)).toBe(0);
    expect(quantize(0.5, 0)).toBe(0.5);
  });

  it('counts frames of a duration', () => {
    expect(frameCount(3, 30)).toBe(90);
    expect(frameCount(3.01, 30)).toBe(91);
    expect(frameCount(0, 30)).toBe(0);
  });

  it('draws the safe areas inside the frame', () => {
    const { action, title: t } = safeAreas(FRAME);
    expect(action.width).toBeCloseTo(1920 * 0.93, 6);
    expect(t.x).toBeCloseTo(96, 6);
    expect(t.y).toBeCloseTo(54, 6);
  });
});

describe('view', () => {
  it('scales the frame into a smaller preview, letterboxed and centred', () => {
    const view = viewFor(FRAME, { width: 640, height: 640 });
    expect(view.scale).toBeCloseTo(1 / 3, 10);
    expect(view.dx).toBe(0);
    expect(view.dy).toBeCloseTo(140, 6);
    expect(toCanvas({ x: 960, y: 540, width: 300, height: 30 }, view)).toEqual({ x: 320, y: 320, width: 100, height: 10 });
  });

  it('is the identity for an equal canvas and for bad input', () => {
    expect(viewFor(FRAME, FRAME)).toEqual({ scale: 1, dx: 0, dy: 0 });
    expect(viewFor({ width: 0, height: 0 }, FRAME)).toEqual({ scale: 1, dx: 0, dy: 0 });
  });

  it('scales a rectangle about a point', () => {
    expect(scaleAbout({ x: 0, y: 0, width: 10, height: 10 }, 0.5, 5, 5)).toEqual({ x: 2.5, y: 2.5, width: 5, height: 5 });
  });
});
