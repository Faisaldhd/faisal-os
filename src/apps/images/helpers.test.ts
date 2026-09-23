import { describe, it, expect } from 'vitest';
import { galleryOrder, indexOfPath, isImagePath, stepIndex, clampZoom, formatDimensions, formatBytesShort } from './helpers';

describe('isImagePath', () => {
  it('accepts known image extensions, case-insensitively', () => {
    expect(isImagePath('/a/b/c.PNG')).toBe(true);
    expect(isImagePath('/a/b/c.jpeg')).toBe(true);
    expect(isImagePath('/a/b/c.svg')).toBe(true);
  });
  it('rejects non-image extensions and extension-less paths', () => {
    expect(isImagePath('/a/b/c.txt')).toBe(false);
    expect(isImagePath('/a/b/c')).toBe(false);
  });
});

describe('galleryOrder', () => {
  it('filters out directories and non-image files, sorts naturally by name', () => {
    const entries = [
      { path: '/p/img10.png', name: 'img10.png', type: 'file' as const },
      { path: '/p/img2.png', name: 'img2.png', type: 'file' as const },
      { path: '/p/sub', name: 'sub', type: 'dir' as const },
      { path: '/p/notes.txt', name: 'notes.txt', type: 'file' as const },
      { path: '/p/img1.png', name: 'img1.png', type: 'file' as const },
    ];
    const out = galleryOrder(entries).map((e) => e.name);
    expect(out).toEqual(['img1.png', 'img2.png', 'img10.png']);
  });

  it('returns an empty list when nothing qualifies', () => {
    expect(galleryOrder([{ path: '/p/a.txt', name: 'a.txt', type: 'file' as const }])).toEqual([]);
  });
});

describe('indexOfPath / stepIndex', () => {
  const paths = ['/a', '/b', '/c'];

  it('finds the index of a path, or -1', () => {
    expect(indexOfPath(paths, '/b')).toBe(1);
    expect(indexOfPath(paths, '/z')).toBe(-1);
  });

  it('steps forward and clamps at the end', () => {
    expect(stepIndex(0, 1, 3)).toBe(1);
    expect(stepIndex(2, 1, 3)).toBe(2);
  });

  it('steps backward and clamps at the start', () => {
    expect(stepIndex(1, -1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(0);
  });

  it('returns -1 for an empty list', () => {
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});

describe('clampZoom', () => {
  it('clamps within [0.1, 8]', () => {
    expect(clampZoom(0)).toBe(0.1);
    expect(clampZoom(100)).toBe(8);
    expect(clampZoom(1.5)).toBe(1.5);
  });
});

describe('formatDimensions / formatBytesShort', () => {
  it('formats width x height with a multiplication sign', () => {
    expect(formatDimensions(1920, 1080)).toBe('1920×1080');
  });
  it('formats bytes with the right unit', () => {
    expect(formatBytesShort(500)).toBe('500 B');
    expect(formatBytesShort(2048)).toBe('2.0 KB');
    expect(formatBytesShort(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
