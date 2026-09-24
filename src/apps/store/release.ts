/**
 * Release dates in the Store.
 *
 * `AppManifest.releasedAt` is an optional ISO calendar date (`YYYY-MM-DD`). An app that
 * predates the field has none, and the Store then shows no date at all rather than
 * inventing one. A release keeps a «جديد / New» badge for a short window so the owner
 * can see what actually arrived, and every comparison is done in UTC against midnight
 * UTC, so the same release reads the same way regardless of the machine's timezone.
 */
import type { Locale } from '../../kernel/types';

/** How long a release keeps the "new" badge, in days. */
export const NEW_RELEASE_DAYS = 14;

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse `YYYY-MM-DD` as midnight UTC.
 *
 * @param value - The manifest value, possibly absent or malformed.
 * @returns Milliseconds, or null when the value is not a real calendar date
 *   (`2026-02-31` is rejected instead of silently rolling into March).
 */
export function parseReleaseDate(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return ms;
}

/**
 * Whole days between the release and `now`.
 *
 * @param value - The manifest release date.
 * @param now - Current time in ms.
 * @returns Non-negative day count, or null when there is no valid date. A future date
 *   (a clock running behind) clamps to 0 so it still counts as new rather than negative.
 */
export function daysSinceRelease(value: string | undefined, now: number): number | null {
  const ms = parseReleaseDate(value);
  if (ms === null) return null;
  return Math.max(0, Math.floor((now - ms) / DAY_MS));
}

/**
 * Whether a release is recent enough to wear the "new" badge.
 *
 * @param value - The manifest release date.
 * @param now - Current time in ms.
 * @param windowDays - Window length; a release exactly `windowDays` old is no longer new.
 * @returns True only for a valid date inside the window.
 */
export function isNewRelease(value: string | undefined, now: number, windowDays: number = NEW_RELEASE_DAYS): boolean {
  const days = daysSinceRelease(value, now);
  return days !== null && days < windowDays;
}

/**
 * Format a release date for display in the owner's language.
 *
 * @param value - The manifest release date.
 * @param locale - Active locale.
 * @returns The localised date, or null when there is nothing honest to show.
 */
export function formatReleaseDate(value: string | undefined, locale: Locale): string | null {
  const ms = parseReleaseDate(value);
  if (ms === null) return null;
  try {
    return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(ms);
  } catch {
    // No Intl data at all: fall back to the ISO day rather than throwing in the Store.
    return new Date(ms).toISOString().slice(0, 10);
  }
}
