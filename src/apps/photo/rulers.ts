/**
 * Photo Editor — the rulers around the canvas (pure geometry, no DOM).
 *
 * A ruler speaks two units at once and that is the whole difficulty: its ticks sit at SCREEN
 * positions (so they line up with the image whatever the zoom and pan are) while the numbers it
 * prints are DOCUMENT pixels — "how far into the picture am I", which is what a measurement
 * means. So the caller keeps the screen maths and this module keeps the mapping between the two.
 *
 * The step is chosen so labels never collide: the smallest 1-2-5 step whose on-screen spacing
 * clears a floor (48px by default), then four minor ticks between each pair of majors.
 */
/** One tick: where it is drawn (screen px) and the document coordinate it stands for. */
export interface RulerTick {
  pos: number;
  value: number;
  major: boolean;
}

/** The on-screen spacing a labelled tick must clear before the next step up is taken. */
export const RULER_LABEL_MIN = 48;

/** Never emit more than this many ticks, whatever the caller asks for (a guard, not a policy). */
const TICK_GUARD = 4000;

/** 1, 2, 5, 10, 20, 50 … — the step for this zoom whose spacing is at least `minPx` on screen. */
export function rulerStep(zoom: number, minPx = RULER_LABEL_MIN): number {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const raw = Math.max(1e-6, minPx / z);
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5]) if (pow * m >= raw - 1e-9) return pow * m;
  return pow * 10;
}

/** Float noise from `k * step` (0.1 + 0.1 + …) must never reach a label. */
function clean(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * The ticks across a ruler `lengthPx` long whose document origin (0, 0) sits at `panPx` on
 * screen. Values ascend left to right (or top to bottom), with four minors between each pair of
 * labelled majors — the step is chosen so those minors are always at least `minPx / 5` apart,
 * which is why they are never subdivided further.
 */
export function rulerTicks(lengthPx: number, panPx: number, zoom: number, minPx = RULER_LABEL_MIN): RulerTick[] {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const length = Math.max(0, lengthPx);
  if (!length) return [];
  const pan = Number.isFinite(panPx) ? panPx : 0;
  const step = rulerStep(z, minPx);
  const minorStep = step / 5;
  const firstIndex = Math.floor((0 - pan) / z / step);
  const lastIndex = Math.ceil((length - pan) / z / step) + 1;
  const out: RulerTick[] = [];
  for (let k = firstIndex; k <= lastIndex && out.length < TICK_GUARD; k++) {
    const value = clean(k * step);
    const pos = value * z + pan;
    if (pos >= -1 && pos <= length + 1) out.push({ pos, value, major: true });
    for (let i = 1; i < 5; i++) {
      const mv = clean(value + minorStep * i);
      const mpos = mv * z + pan;
      if (mpos >= -1 && mpos <= length + 1) out.push({ pos: mpos, value: mv, major: false });
    }
  }
  return out;
}

/**
 * The label for a tick. Sub-pixel steps keep one decimal (a zoomed-in ruler says 0.5, not 0),
 * everything else is a plain integer — ASCII digits, so the number reads left-to-right in the
 * Arabic interface exactly as a measurement should.
 */
export function formatTick(value: number, step: number): string {
  if (Math.abs(step) < 1) return String(Math.round(value * 10) / 10);
  return String(Math.round(value));
}

/** The pointer position in ruler coordinates: null when the pointer is outside that ruler. */
export function rulerCursor(pos: number, lengthPx: number): number | null {
  return pos >= 0 && pos <= lengthPx ? pos : null;
}

/** Where a tick label should sit so it never runs off the end of the ruler. */
export function labelAnchor(pos: number, lengthPx: number, halfLabel: number): number {
  return Math.max(halfLabel, Math.min(lengthPx - halfLabel, pos));
}

/** The document coordinate under a screen position — what the ruler's cursor readout shows. */
export function valueAt(pos: number, panPx: number, zoom: number): number {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return (pos - panPx) / z;
}

/** The same readout rounded for display (document pixels, one decimal under 10). */
export function formatCursor(pos: number, panPx: number, zoom: number): string {
  const v = valueAt(pos, panPx, zoom);
  return Math.abs(v) < 10 ? String(Math.round(v * 10) / 10) : String(Math.round(v));
}
