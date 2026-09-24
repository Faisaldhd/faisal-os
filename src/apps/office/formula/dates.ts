/**
 * Office Calc engine — Excel date serials (التواريخ).
 *
 * Excel's 1900 date system: serial 1 = 1900-01-01, the day part is the integer
 * and the time of day is the fraction. Serial 60 is the fictitious 1900-02-29
 * Excel keeps for Lotus compatibility, so every date from 1900-03-01 on matches
 * Excel exactly (serial 45306 = 2024-01-15).
 *
 *   dateToSerial(y, m, d)   months/days overflow like DATE() (month 13 = next January)
 *   serialToDate(serial)    → { year, month, day, weekday (0 = Sunday) }
 *   serialToTime(serial)    → { hour, minute, second } of the fraction, rounded to the second
 *   dateFromJs(date)        a JS Date's local calendar date and time as a serial
 *   daysInMonth(y, m)
 */

const DAY_MS = 86400000;
const EPOCH = Date.UTC(1899, 11, 30);

/** The serial of a calendar date (Excel's DATE semantics: overflowing months and days roll over). */
export function dateToSerial(year: number, month: number, day: number): number {
  const ms = Date.UTC(2000, 0, 1) + 0; // anchor so setUTCFullYear handles years < 100 correctly
  const date = new Date(ms);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  const days = Math.round((date.getTime() - EPOCH) / DAY_MS);
  return days < 61 ? days - 1 : days;
}

export interface DateParts { year: number; month: number; day: number; weekday: number }

/** The calendar date of a serial's day part. Serial 60 is 1900-02-29, serial 0 is "1900-01-00". */
export function serialToDate(serial: number): DateParts {
  const whole = Math.floor(serial + 1e-9);
  if (whole === 60) return { year: 1900, month: 2, day: 29, weekday: 3 };
  if (whole === 0) return { year: 1900, month: 1, day: 0, weekday: 6 };
  const days = whole < 60 ? whole + 1 : whole;
  const date = new Date(EPOCH + days * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

export interface TimeParts { hour: number; minute: number; second: number }

/** The time of day in a serial's fraction, rounded to the nearest second. */
export function serialToTime(serial: number): TimeParts {
  let seconds = Math.round((serial - Math.floor(serial)) * 86400);
  if (seconds >= 86400) seconds = 0;
  return { hour: Math.floor(seconds / 3600), minute: Math.floor((seconds % 3600) / 60), second: seconds % 60 };
}

/** A JS Date's local date and time as a serial (what TODAY/NOW return). */
export function dateFromJs(date: Date, withTime = true): number {
  const serial = dateToSerial(date.getFullYear(), date.getMonth() + 1, date.getDate());
  if (!withTime) return serial;
  return serial + (date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000) / 86400;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** The largest serial Excel accepts (9999-12-31). */
export const MAX_SERIAL = 2958465;
