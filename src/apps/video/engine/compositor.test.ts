import { describe, expect, it } from 'vitest';
import { clipRect, composeFrame, supportsFilter, type FrameProvider } from './compositor';
import { twoClips, title, video, withTrackClips } from './fixtures';
import type { MediaClip } from '../project';

interface Call {
  op: string;
  args: unknown[];
  alpha: number;
  filter?: string;
  direction?: string;
  align?: string;
  fill?: unknown;
}

/** A 2D context that records what is drawn, with the state at each call. */
function fakeContext(withFilter = true) {
  const calls: Call[] = [];
  const stack: Array<Record<string, unknown>> = [];
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '#000', font: '10px sans-serif', textAlign: 'start', direction: 'inherit' };
  if (withFilter) state.filter = 'none';
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args, alpha: state.globalAlpha as number, filter: state.filter as string | undefined, direction: state.direction as string, align: state.textAlign as string, fill: state.fillStyle });
  };
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key === 'save') return () => stack.push({ ...target });
      if (key === 'restore') return () => { const s = stack.pop(); if (s) { for (const k of Object.keys(target)) delete target[k]; Object.assign(target, s); } };
      if (key === 'measureText') return (s: string) => ({ width: s.length * 10 });
      if (key === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(100) });
      if (key in target) return target[key];
      return record(key);
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
    has(target, key: string) {
      return key in target;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const FRAME = { width: 1920, height: 1080 };

function provider(missing: string[] = []): FrameProvider & { image: (id: string) => object } {
  const images = new Map<string, object>();
  const image = (id: string) => {
    if (!images.has(id)) images.set(id, { id });
    return images.get(id)!;
  };
  return {
    image,
    frameFor(clip: MediaClip) {
      if (missing.includes(clip.mediaId)) return null;
      return { image: image(clip.mediaId) as CanvasImageSource, width: 1920, height: 1080 };
    },
    missing(clip: MediaClip) {
      return missing.includes(clip.mediaId) ? { width: 1920, height: 1080, offline: true } : null;
    },
  };
}

const draws = (calls: Call[]) => calls.filter((c) => c.op === 'drawImage');

describe('composeFrame', () => {
  it('draws the background then the single clip at full opacity', () => {
    const { ctx, calls } = fakeContext();
    const p = provider();
    const report = composeFrame(ctx, twoClips(), 1, FRAME, p);
    expect(calls[0].op).toBe('setTransform');
    expect(calls.find((c) => c.op === 'fillRect')!.fill).toBe('#000000');
    const d = draws(calls);
    expect(d).toHaveLength(1);
    expect(d[0].args[0]).toBe(p.image('mA'));
    expect(d[0].alpha).toBe(1);
    expect(d[0].args.slice(5)).toEqual([-960, -540, 1920, 1080]);
    expect(report.drawn).toEqual(['A']);
  });

  it('crossfades: outgoing at full alpha, incoming on top at the progress', () => {
    const { ctx, calls } = fakeContext();
    const p = provider();
    composeFrame(ctx, twoClips('crossfade'), 3.5, FRAME, p);
    const d = draws(calls);
    expect(d.map((c) => c.args[0])).toEqual([p.image('mA'), p.image('mB')]);
    expect(d[0].alpha).toBe(1);
    expect(d[1].alpha).toBeCloseTo(0.5, 6);
  });

  it('slides: both clips drawn, shifted by half a frame each way at the midpoint', () => {
    const { ctx, calls } = fakeContext();
    composeFrame(ctx, twoClips('slide'), 3.5, FRAME, provider());
    const translates = calls.filter((c) => c.op === 'translate').map((c) => c.args[0]);
    expect(translates).toContain(0);
    expect(translates).toContain(1920);
  });

  it('dips to black: a full black veil over the main track at the join', () => {
    const { ctx, calls } = fakeContext();
    const report = composeFrame(ctx, twoClips('dip'), 4, FRAME, provider());
    const veil = calls.filter((c) => c.op === 'fillRect' && c.alpha > 0.99 && c.fill === '#000000');
    expect(veil.length).toBeGreaterThanOrEqual(2); // background + veil
    expect(report.drawn).toEqual(['B']);
  });

  it('draws overlays above the veil and reports their boxes', () => {
    const pip = video('P', 'mP', 10, { scale: 0.5, x: 0.75, y: 0.25, start: 0 });
    const proj = withTrackClips(twoClips('dip'), 'overlay-1', [pip]);
    const { ctx, calls } = fakeContext();
    const report = composeFrame(ctx, proj, 3.8, FRAME, provider());
    const veilIndex = calls.findIndex((c, i) => i > 1 && c.op === 'fillRect' && c.fill === '#000000');
    const pipIndex = calls.findIndex((c) => c.op === 'drawImage' && (c.args[0] as { id: string }).id === 'mP');
    expect(veilIndex).toBeGreaterThan(0);
    expect(pipIndex).toBeGreaterThan(veilIndex);
    expect(report.boxes).toEqual([{ id: 'P', kind: 'overlay', rect: { x: 960, y: 0, width: 960, height: 540 } }]);
  });

  it('applies the colour adjustment through ctx.filter', () => {
    const proj = twoClips('none');
    proj.tracks = proj.tracks.map((t) => (t.kind === 'main' ? { ...t, clips: [{ ...(t.clips[0] as MediaClip), color: { brightness: 1.2, contrast: 1, saturation: 0 } }] } : t));
    const { ctx, calls } = fakeContext(true);
    composeFrame(ctx, proj, 1, FRAME, provider());
    expect(draws(calls)[0].filter).toBe('brightness(1.200) contrast(1.000) saturate(0.000)');
  });

  it('falls back to per-pixel colour when the context has no filter', () => {
    const proj = twoClips('none');
    proj.tracks = proj.tracks.map((t) => (t.kind === 'main' ? { ...t, clips: [{ ...(t.clips[0] as MediaClip), color: { brightness: 1, contrast: 1, saturation: 0 } }] } : t));
    const main = fakeContext(false);
    const scratch = fakeContext(false);
    const scratchCanvas = { scratch: true };
    composeFrame(main.ctx, proj, 1, FRAME, provider(), { scratch: () => ({ canvas: scratchCanvas as unknown as CanvasImageSource, ctx: scratch.ctx }) });
    expect(scratch.calls.some((c) => c.op === 'putImageData')).toBe(true);
    expect(draws(main.calls)[0].args[0]).toBe(scratchCanvas);
    expect(supportsFilter(main.ctx)).toBe(false);
  });

  it('draws an Arabic title right-to-left, on top of the picture', () => {
    const proj = withTrackClips(twoClips(), 'text-1', [title('T', 0, 'مرحبا بكم في فيصل', { animIn: 'none', animOut: 'none' })]);
    const { ctx, calls } = fakeContext();
    const report = composeFrame(ctx, proj, 1, FRAME, provider());
    const text = calls.filter((c) => c.op === 'fillText');
    expect(text).toHaveLength(1);
    expect(text[0].args[0]).toBe('مرحبا بكم في فيصل');
    expect(text[0].direction).toBe('rtl');
    expect(calls.indexOf(text[0])).toBeGreaterThan(calls.findIndex((c) => c.op === 'drawImage'));
    expect(report.texts).toEqual(['T']);
    expect(report.boxes.find((b) => b.kind === 'text')!.rect.width).toBe('مرحبا بكم في فيصل'.length * 10);
  });

  it('fades a title in with its animation', () => {
    const proj = withTrackClips(twoClips(), 'text-1', [title('T', 0, 'Hello', { animIn: 'fade', animDuration: 1 })]);
    const { ctx, calls } = fakeContext();
    composeFrame(ctx, proj, 0.5, FRAME, provider());
    const alpha = calls.find((c) => c.op === 'fillText')!.alpha;
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);
  });

  it('skips an empty title', () => {
    const proj = withTrackClips(twoClips(), 'text-1', [title('T', 0, '   ')]);
    const { ctx, calls } = fakeContext();
    expect(composeFrame(ctx, proj, 1, FRAME, provider()).texts).toEqual([]);
    expect(calls.some((c) => c.op === 'fillText')).toBe(false);
  });

  it('marks media without a picture as missing and labels offline media', () => {
    const { ctx, calls } = fakeContext();
    const report = composeFrame(ctx, twoClips(), 1, FRAME, provider(['mA']), { offlineLabel: 'غير متصل' });
    expect(report.missing).toEqual(['A']);
    expect(draws(calls)).toHaveLength(0);
    expect(calls.find((c) => c.op === 'fillText')!.args[0]).toBe('غير متصل');
  });

  it('scales the whole composition into a preview view', () => {
    const { ctx, calls } = fakeContext();
    composeFrame(ctx, twoClips(), 1, FRAME, provider(), { view: { scale: 0.5, dx: 0, dy: 10 }, canvas: { width: 960, height: 560 } });
    const transforms = calls.filter((c) => c.op === 'setTransform').map((c) => c.args);
    expect(transforms).toContainEqual([0.5, 0, 0, 0.5, 0, 10]);
  });

  it('draws the safe-area guides only when asked', () => {
    const a = fakeContext();
    composeFrame(a.ctx, twoClips(), 1, FRAME, provider());
    expect(a.calls.some((c) => c.op === 'strokeRect')).toBe(false);
    const b = fakeContext();
    composeFrame(b.ctx, twoClips(), 1, FRAME, provider(), { guides: true });
    expect(b.calls.filter((c) => c.op === 'strokeRect')).toHaveLength(2);
  });

  it('draws only the background past the end of the film', () => {
    const { ctx, calls } = fakeContext();
    const report = composeFrame(ctx, twoClips(), 50, FRAME, provider());
    expect(draws(calls)).toHaveLength(0);
    expect(report.drawn).toEqual([]);
  });
});

describe('clipRect', () => {
  it('keeps the part inside the frame, in whole pixels', () => {
    expect(clipRect({ x: -10.5, y: 5.2, width: 100, height: 2000 }, FRAME)).toEqual({ x: 0, y: 5, width: 90, height: 1075 });
    expect(clipRect({ x: 3000, y: 0, width: 10, height: 10 }, FRAME).width).toBe(0);
  });
});

/**
 * The effects must be drawn by THIS function, because it is the one both the preview and the
 * frame-by-frame MP4 export call: an effect that lived in the player would export none, and one
 * that lived in the exporter would preview none. These assertions are the "both paths" proof.
 */
describe('clip effects on the shared draw path', () => {
  const withFx = (fx: Partial<MediaClip['effects']>) => {
    const p = twoClips();
    // The effects belong to the MAIN track's clip: patching `tracks[0]` would patch whichever
    // track happens to be first and leave the picture untouched.
    const main = p.tracks.find((t) => t.kind === 'main')!;
    const clip = { ...main.clips[0] as MediaClip, start: 0, out: 4, in: 0, speed: 1, effects: { fadeIn: 0, fadeOut: 0, blur: 0, dark: 0, ...fx } };
    return { ...p, tracks: p.tracks.map((t) => (t.id === main.id ? { ...t, clips: [clip] } : t)) };
  };

  it('paints a full black cover at the start of a fade in, and none after it', () => {
    const { ctx, calls } = fakeContext();
    const project = withFx({ fadeIn: 1 });
    composeFrame(ctx, project, 0, FRAME, provider());
    const black = calls.filter((c) => c.op === 'fillRect' && c.fill === '#000000' && c.alpha > 0.9);
    expect(black.length).toBeGreaterThan(0);
    const { ctx: ctx2, calls: calls2 } = fakeContext();
    composeFrame(ctx2, project, 2, FRAME, provider());
    const veiled = calls2.filter((c) => c.op === 'fillRect' && c.fill === '#000000' && c.alpha > 0.01 && c.args[2] !== FRAME.width);
    expect(veiled).toHaveLength(0);
  });

  it('applies the blur through the canvas filter while drawing the clip', () => {
    const { ctx, calls } = fakeContext();
    composeFrame(ctx, withFx({ blur: 1 }), 2, FRAME, provider());
    const filtered = draws(calls).filter((c) => (c.filter ?? '').includes('blur('));
    expect(filtered).toHaveLength(1);
    expect(filtered[0].filter).toMatch(/blur\(1[0-9.]+px\)/);
  });

  it('draws the dark frame as four bands inside the clip, and needs no filter support', () => {
    const { ctx, calls } = fakeContext(false);
    composeFrame(ctx, withFx({ dark: 1 }), 2, FRAME, provider());
    const bands = calls.filter((c) => c.op === 'fillRect' && c.fill === '#000000' && c.alpha > 0.4 && c.alpha < 0.95);
    expect(bands.length).toBeGreaterThanOrEqual(4);
  });

  it('draws nothing extra when the clip has no effects', () => {
    const { ctx, calls } = fakeContext();
    composeFrame(ctx, withFx({}), 2, FRAME, provider());
    expect(draws(calls)).toHaveLength(1);
    expect((draws(calls)[0].filter ?? 'none')).toBe('none');
  });
});
