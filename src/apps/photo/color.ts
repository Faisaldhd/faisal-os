/**
 * Photo Editor — colour conversions for the colour picker (saturation/value square + hue bar)
 * and the swatches. Pure maths, unit tested.
 */
import { parseHexColor } from './tools';

export type RGB = [number, number, number];
export interface HSV { h: number; s: number; v: number }

/** "#abc", "abc", "#aabbcc" → "#aabbcc"; anything else → null. */
export function normaliseHex(input: string): string | null {
  const s = input.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  return null;
}

export function hexToRgb(hex: string): RGB {
  return parseHexColor(hex);
}

export function rgbToHex(rgb: readonly number[]): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

/** h in [0, 360), s and v in [0, 1]. */
export function rgbToHsv(rgb: readonly number[]): HSV {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb(hsv: HSV): RGB {
  const h = ((hsv.h % 360) + 360) % 360;
  const s = Math.min(1, Math.max(0, hsv.s));
  const v = Math.min(1, Math.max(0, hsv.v));
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rgb: [number, number, number];
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [Math.round((rgb[0] + m) * 255), Math.round((rgb[1] + m) * 255), Math.round((rgb[2] + m) * 255)];
}

/** Relative luminance (WCAG), used to pick a readable text colour over a swatch. */
export function relativeLuminance(rgb: readonly number[]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** A small, pleasant default palette shown under the picker. */
export const SWATCHES = [
  '#000000', '#ffffff', '#e5484d', '#f5a524', '#f7d154', '#3dd68c',
  '#2bb3c0', '#5b8def', '#8e6cf0', '#e46fb0', '#c8894b', '#6e7890',
];
