/**
 * The storage policy itself: which platform gets which budget, and that the budgets stay in a
 * sane order. The browser-facing behaviour is covered in `vfs.test.ts` and `file-drop.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { MB, STORAGE_QUOTAS, quotaFor, storageTierFor } from './quota';

describe('storageTierFor', () => {
  it('puts the desktop app first, whatever else it reports', () => {
    expect(storageTierFor({ desktop: true })).toBe('app');
    expect(storageTierFor({ desktop: true, coarsePointer: true, deviceMemory: 2 })).toBe('app');
  });

  it('treats a touch-first device as mobile', () => {
    expect(storageTierFor({ coarsePointer: true })).toBe('mobile');
    expect(storageTierFor({ coarsePointer: true, deviceMemory: 32 })).toBe('mobile');
  });

  it('treats a low-memory device as mobile even without a coarse pointer', () => {
    expect(storageTierFor({ deviceMemory: 4 })).toBe('mobile');
    expect(storageTierFor({ deviceMemory: 2 })).toBe('mobile');
  });

  it('keeps a desktop browser on the desktop tier', () => {
    expect(storageTierFor({})).toBe('desktop');
    expect(storageTierFor({ deviceMemory: 32 })).toBe('desktop');
    expect(storageTierFor({ coarsePointer: false, desktop: false })).toBe('desktop');
  });

  it('ignores a missing or nonsensical memory reading instead of guessing mobile', () => {
    for (const bad of [undefined, 0, -4, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(storageTierFor({ deviceMemory: bad as number })).toBe('desktop');
    }
  });
});

describe('storage quotas', () => {
  it('gives every tier a file cap it can also hold in total', () => {
    for (const [tier, q] of Object.entries(STORAGE_QUOTAS)) {
      expect(q.file, tier).toBeGreaterThan(0);
      expect(q.file, tier).toBeLessThanOrEqual(q.total);
    }
  });

  it('orders the tiers by what each platform can actually take', () => {
    expect(STORAGE_QUOTAS.mobile.file).toBeLessThan(STORAGE_QUOTAS.desktop.file);
    expect(STORAGE_QUOTAS.desktop.file).toBeLessThan(STORAGE_QUOTAS.app.file);
    expect(STORAGE_QUOTAS.mobile.total).toBeLessThan(STORAGE_QUOTAS.desktop.total);
    expect(STORAGE_QUOTAS.desktop.total).toBeLessThan(STORAGE_QUOTAS.app.total);
  });

  it('keeps the measured desktop budget (100 MB per file, 1 GB in total)', () => {
    expect(quotaFor('desktop')).toEqual({ file: 100 * MB, total: 1024 * MB });
  });

  it('keeps the phone budget small enough for a phone heap', () => {
    expect(quotaFor('mobile')).toEqual({ file: 30 * MB, total: 300 * MB });
  });
});
