/** Plain data types shared by the editor's pure modules. No DOM in here. */

/** An RGBA image in memory: 4 bytes per pixel, row-major, exactly `width * height * 4` bytes. */
export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** An axis-aligned rectangle in image pixels (fractions are normalised/rounded by geometry.ts). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Free-angle + quarter-turn rotation, in degrees clockwise. */
export interface Rotation {
  /** Accumulated 90° turns: 0, 1, 2 or 3 (clockwise). */
  quarter: number;
  /** Additional free angle in degrees, clockwise, within (-180, 180]. */
  free: number;
}

export interface Size {
  width: number;
  height: number;
}

export type AdjustmentKey =
  | 'brightness'
  | 'contrast'
  | 'saturation'
  | 'exposure'
  | 'temperature'
  | 'highlights'
  | 'shadows';

/** Every adjustment this editor has, each in the range -100..100. */
export type Adjustments = Record<AdjustmentKey, number>;

export type ToolId =
  | 'move'
  | 'select'
  | 'crop'
  | 'brush'
  | 'line'
  | 'rectangle'
  | 'ellipse'
  | 'arrow'
  | 'text';

export type Point = { x: number; y: number };
