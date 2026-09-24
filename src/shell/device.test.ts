import { describe, it, expect, afterEach } from 'vitest';
import { NARROW_BREAKPOINT, isCoarsePointer, isCompactWidth, shouldFillScreen, watchPointerKind } from './device';

describe('isCompactWidth', () => {
  // The shell's compact chrome (the measured dock, the icons standing aside) and the window
  // manager's "fill the surface" answer must agree on where narrow begins.
  it('is strict at NARROW_BREAKPOINT, exactly like the media query mirroring it', () => {
    expect(isCompactWidth(320)).toBe(true);
    expect(isCompactWidth(390)).toBe(true);
    expect(isCompactWidth(699)).toBe(true);
    expect(isCompactWidth(700)).toBe(false);
    expect(isCompactWidth(1280)).toBe(false);
  });

  it('accepts an explicit breakpoint and never depends on the pointer', () => {
    expect(isCompactWidth(900, 1024)).toBe(true);
    expect(isCompactWidth(1024, 1024)).toBe(false);
  });
});

describe('shouldFillScreen', () => {
  const matrix = [
    // width, coarse, expected, why
    [1200, false, false, 'wide + fine -> floating window, exactly like the desktop build'],
    [1200, true, true, 'coarse pointer -> fill even on a desktop-sized tablet'],
    [500, false, true, 'narrow + fine -> fill (replaces the old wm.ts narrow check)'],
    [500, true, true, 'narrow + coarse -> fill'],
  ] as const;
  for (const [width, coarse, expected, why] of matrix) {
    it(`${width}px / coarse=${coarse} -> ${expected} (${why})`, () => {
      expect(shouldFillScreen({ width, coarse })).toBe(expected);
    });
  }

  it('defaults the breakpoint to the window manager breakpoint', () => {
    expect(NARROW_BREAKPOINT).toBe(700);
    // Just below / just above the default: proves the default comes from NARROW_BREAKPOINT.
    expect(shouldFillScreen({ width: NARROW_BREAKPOINT - 1, coarse: false })).toBe(true);
    expect(shouldFillScreen({ width: NARROW_BREAKPOINT, coarse: false })).toBe(false);
  });

  it('is strict at the boundary: exactly 700 behaves like the window manager (floats)', () => {
    expect(shouldFillScreen({ width: 700, coarse: false })).toBe(false);
    expect(shouldFillScreen({ width: 699, coarse: false })).toBe(true);
    expect(shouldFillScreen({ width: 701, coarse: false })).toBe(false);
  });

  it('accepts an explicit breakpoint', () => {
    expect(shouldFillScreen({ width: 900, breakpoint: 1024, coarse: false })).toBe(true);
    expect(shouldFillScreen({ width: 1024, breakpoint: 1024, coarse: false })).toBe(false);
  });

  it('coarse always fills, whatever the width and breakpoint', () => {
    expect(shouldFillScreen({ width: 4000, coarse: true })).toBe(true);
    expect(shouldFillScreen({ width: 0, coarse: true })).toBe(true);
  });
});

describe('isCoarsePointer', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  afterEach(() => {
    if (original) Object.defineProperty(window, 'matchMedia', original);
    else delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('returns false when matchMedia is unavailable (jsdom) and never throws', () => {
    expect((window as { matchMedia?: unknown }).matchMedia).toBeUndefined();
    expect(() => isCoarsePointer()).not.toThrow();
    expect(isCoarsePointer()).toBe(false);
  });

  it('reads the (pointer: coarse) query', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({ matches: query === '(pointer: coarse)', media: query, addEventListener: () => {} }),
    });
    expect(isCoarsePointer()).toBe(true);
  });

  it('returns false for a fine pointer', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({ matches: false, media: query, addEventListener: () => {} }),
    });
    expect(isCoarsePointer()).toBe(false);
  });
});

describe('watchPointerKind', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
  afterEach(() => {
    if (original) Object.defineProperty(window, 'matchMedia', original);
    else delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('degrades to a no-op unsubscribe when matchMedia is unavailable', () => {
    let unsub: (() => void) | undefined;
    expect(() => { unsub = watchPointerKind(() => { throw new Error('must not fire'); }); }).not.toThrow();
    expect(typeof unsub).toBe('function');
    expect(() => unsub!()).not.toThrow();
  });

  it('fires on media query change and stops after unsubscribe', () => {
    const listeners = new Set<() => void>();
    const state = { matches: false };
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        get matches() { return state.matches; },
        media: query,
        addEventListener: (_: 'change', l: () => void) => { listeners.add(l); },
        removeEventListener: (_: 'change', l: () => void) => { listeners.delete(l); },
      }),
    });

    const seen: boolean[] = [];
    const unsub = watchPointerKind((coarse) => seen.push(coarse));
    expect(listeners.size).toBe(1);

    state.matches = true;
    listeners.forEach((l) => l());
    expect(seen).toEqual([true]);

    unsub();
    expect(listeners.size).toBe(0);
    state.matches = false;
    listeners.forEach((l) => l());
    expect(seen).toEqual([true]);
  });

  it('is a no-op when the media query list has no addEventListener (older WebKit)', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({ matches: true, media: query }),
    });
    const unsub = watchPointerKind(() => { throw new Error('must not fire'); });
    expect(() => unsub()).not.toThrow();
  });
});
