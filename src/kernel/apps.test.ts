import { describe, expect, it } from 'vitest';
import { validateManifest, windowSizeFor } from './apps';
import type { AppManifest } from './types';

/** Smallest manifest that passes every other rule, so each test varies one field. */
const base: AppManifest = {
  id: 'org.faisal.Test',
  name: { ar: 'اختبار', en: 'Test' },
  icon: '<svg></svg>',
  permissions: ['fs:home'],
};

describe('validateManifest: releasedAt', () => {
  it('accepts a manifest without a release date', () => {
    expect(() => validateManifest(base)).not.toThrow();
  });

  it('accepts a real calendar day', () => {
    expect(() => validateManifest({ ...base, releasedAt: '2026-09-24' })).not.toThrow();
    expect(() => validateManifest({ ...base, releasedAt: '2024-02-29' })).not.toThrow();
  });

  it('rejects a date that is not a real day', () => {
    expect(() => validateManifest({ ...base, releasedAt: '2026-02-31' })).toThrow(/releasedAt/);
    expect(() => validateManifest({ ...base, releasedAt: '2025-02-29' })).toThrow(/releasedAt/);
    expect(() => validateManifest({ ...base, releasedAt: '2026-13-01' })).toThrow(/releasedAt/);
  });

  it('rejects a date in the wrong shape or of the wrong type', () => {
    expect(() => validateManifest({ ...base, releasedAt: '24/09/2026' })).toThrow(/releasedAt/);
    expect(() => validateManifest({ ...base, releasedAt: '2026-9-4' })).toThrow(/releasedAt/);
    expect(() => validateManifest({ ...base, releasedAt: '2026-09-24T00:00:00Z' })).toThrow(/releasedAt/);
    expect(() => validateManifest({ ...base, releasedAt: '' })).toThrow(/releasedAt/);
    // @ts-expect-error deliberately wrong type: a number must not be accepted silently
    expect(() => validateManifest({ ...base, releasedAt: 20260924 })).toThrow(/releasedAt/);
  });
});

describe('windowSizeFor', () => {
  it('passes on a size the manifest really asks for', () => {
    expect(windowSizeFor({ ...base, width: 960, height: 680, minWidth: 320, minHeight: 400 }))
      .toEqual({ width: 960, height: 680, minWidth: 320, minHeight: 400 });
  });

  it('passes nothing when the app declares no size, so the window manager default stands', () => {
    expect(windowSizeFor(base)).toEqual({});
  });

  it('passes only the fields that exist', () => {
    expect(windowSizeFor({ ...base, width: 900 })).toEqual({ width: 900 });
    expect(windowSizeFor({ ...base, minWidth: 300, minHeight: 200 })).toEqual({ minWidth: 300, minHeight: 200 });
  });

  it('refuses geometry that could not be rendered', () => {
    expect(windowSizeFor({ ...base, width: 0, height: -20, minWidth: Number.NaN, minHeight: Number.POSITIVE_INFINITY }))
      .toEqual({});
  });
});
