import { describe, expect, it } from 'vitest';
import { NEW_RELEASE_DAYS, daysSinceRelease, formatReleaseDate, isNewRelease, parseReleaseDate } from './release';

const DAY = 86_400_000;
const RELEASED = '2026-09-24';
const AT_RELEASE = Date.UTC(2026, 8, 24);

describe('parseReleaseDate', () => {
  it('reads an ISO day as midnight UTC', () => {
    expect(parseReleaseDate(RELEASED)).toBe(AT_RELEASE);
    expect(parseReleaseDate('2026-01-01')).toBe(Date.UTC(2026, 0, 1));
    expect(parseReleaseDate('2024-02-29')).toBe(Date.UTC(2024, 1, 29));
  });

  it('refuses anything that is not a real calendar date', () => {
    expect(parseReleaseDate(undefined)).toBeNull();
    expect(parseReleaseDate('')).toBeNull();
    expect(parseReleaseDate('2026-2-4')).toBeNull();
    expect(parseReleaseDate('2026-02-31')).toBeNull();
    expect(parseReleaseDate('2026-13-01')).toBeNull();
    expect(parseReleaseDate('2025-02-29')).toBeNull();
    expect(parseReleaseDate('2026-09-24T00:00:00Z')).toBeNull();
    expect(parseReleaseDate('not a date')).toBeNull();
  });
});

describe('daysSinceRelease', () => {
  it('counts whole days from the release', () => {
    expect(daysSinceRelease(RELEASED, AT_RELEASE)).toBe(0);
    expect(daysSinceRelease(RELEASED, AT_RELEASE + DAY)).toBe(1);
    expect(daysSinceRelease(RELEASED, AT_RELEASE + 13 * DAY)).toBe(13);
    expect(daysSinceRelease(RELEASED, AT_RELEASE + 400 * DAY)).toBe(400);
  });

  it('treats a future date as day zero instead of a negative age', () => {
    expect(daysSinceRelease(RELEASED, AT_RELEASE - 5 * DAY)).toBe(0);
  });

  it('has no answer without a valid date', () => {
    expect(daysSinceRelease(undefined, AT_RELEASE)).toBeNull();
    expect(daysSinceRelease('2026-02-31', AT_RELEASE)).toBeNull();
  });
});

describe('isNewRelease', () => {
  it('keeps the badge for the whole window and drops it on the boundary day', () => {
    expect(isNewRelease(RELEASED, AT_RELEASE)).toBe(true);
    expect(isNewRelease(RELEASED, AT_RELEASE + (NEW_RELEASE_DAYS - 1) * DAY)).toBe(true);
    expect(isNewRelease(RELEASED, AT_RELEASE + NEW_RELEASE_DAYS * DAY)).toBe(false);
    expect(isNewRelease(RELEASED, AT_RELEASE + 60 * DAY)).toBe(false);
  });

  it('never invents a badge for an app without a release date', () => {
    expect(isNewRelease(undefined, AT_RELEASE)).toBe(false);
    expect(isNewRelease('2026-02-31', AT_RELEASE)).toBe(false);
  });

  it('accepts an explicit window', () => {
    expect(isNewRelease(RELEASED, AT_RELEASE + 3 * DAY, 3)).toBe(false);
    expect(isNewRelease(RELEASED, AT_RELEASE + 2 * DAY, 3)).toBe(true);
  });
});

describe('formatReleaseDate', () => {
  it('formats in both languages, in UTC, without a timezone shift', () => {
    const ar = formatReleaseDate(RELEASED, 'ar');
    const en = formatReleaseDate(RELEASED, 'en');
    expect(ar).toBeTruthy();
    expect(en).toBeTruthy();
    expect(ar).not.toBe(en);
    // en-GB medium: "24 Sept 2026" — the day must never shift by a timezone.
    expect(en).toContain('2026');
    expect(en).toMatch(/24/);
  });

  it('returns null when there is no honest date to show', () => {
    expect(formatReleaseDate(undefined, 'ar')).toBeNull();
    expect(formatReleaseDate('2026-02-31', 'en')).toBeNull();
  });
});
