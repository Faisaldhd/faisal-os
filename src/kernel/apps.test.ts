import { describe, expect, it } from 'vitest';
import { validateManifest } from './apps';
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
