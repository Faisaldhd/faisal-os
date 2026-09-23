/** Pure helpers for the Image Viewer — kept separate from the DOM code so they're easy to unit-test. */

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif'];

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = path.slice(dot).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

export interface NamedEntry {
  path: string;
  name: string;
  type: 'file' | 'dir';
}

/** Sorts entries the way a photo gallery expects: images only, natural-order by name. */
export function galleryOrder<T extends NamedEntry>(entries: T[]): T[] {
  return entries
    .filter((e) => e.type === 'file' && isImagePath(e.path))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/** Index of `path` within the ordered list, or -1. */
export function indexOfPath(paths: string[], path: string): number {
  return paths.indexOf(path);
}

/** Wrap-free clamp to the next/previous index within [0, length-1]; returns -1 if list is empty. */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length === 0) return -1;
  const next = current + delta;
  if (next < 0) return 0;
  if (next >= length) return length - 1;
  return next;
}

export type Fit = 'fit' | 'actual' | number;

/** Clamps a zoom factor (used by +/-/ctrl+wheel) to a sane range. */
export function clampZoom(z: number): number {
  return Math.min(8, Math.max(0.1, z));
}

export function formatDimensions(w: number, h: number): string {
  return `${w}×${h}`;
}

export function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
