/**
 * Built-in date and time functions on Excel serials: TODAY, NOW (both volatile,
 * read the workbook's clock), DATE, TIME, YEAR, MONTH, DAY, HOUR, MINUTE, SECOND,
 * WEEKDAY, EDATE, EOMONTH, DATEDIF, DAYS, DATEVALUE. A date argument may be a
 * serial or a date text ("2024-01-15").
 */
import { dateFromJs, dateToSerial, daysInMonth, MAX_SERIAL, serialToDate, serialToTime } from '../dates';
import { registerFunction, type CallContext } from '../registry';
import { ERR, isArea, isError, textToNumber, type CellError, type Value } from '../values';
import { eachCell, num, optNum, text } from './helpers';

/** A date argument's serial (#NUM! outside Excel's range). */
function serialArg(v: Value, ctx: CallContext): number | CellError {
  const n = num(v, ctx);
  if (isError(n)) return n;
  return n < 0 || n > MAX_SERIAL + 1 ? ERR.NUM : n;
}

registerFunction('TODAY', (_args, ctx) => dateFromJs(ctx.now(), false), { minArgs: 0, maxArgs: 0, volatile: true, aliases: ['اليوم'] });
registerFunction('NOW', (_args, ctx) => dateFromJs(ctx.now(), true), { minArgs: 0, maxArgs: 0, volatile: true, aliases: ['الآن'] });

registerFunction('DATE', (args, ctx) => {
  const ns = args.map((a) => num(a, ctx));
  const bad = ns.find(isError);
  if (bad) return bad;
  let [y, m, d] = (ns as number[]).map(Math.trunc);
  if (y < 0 || y > 9999) return ERR.NUM;
  if (y < 1900) y += 1900;
  const serial = dateToSerial(y, m, d);
  return serial < 0 || serial > MAX_SERIAL ? ERR.NUM : serial;
}, { minArgs: 3, maxArgs: 3 });

registerFunction('TIME', (args, ctx) => {
  const ns = args.map((a) => num(a, ctx));
  const bad = ns.find(isError);
  if (bad) return bad;
  const [h, m, s] = (ns as number[]).map(Math.trunc);
  const total = h * 3600 + m * 60 + s;
  if (total < 0) return ERR.NUM;
  return (total % 86400) / 86400;
}, { minArgs: 3, maxArgs: 3 });

function datePart(name: string, fn: (serial: number) => number): void {
  registerFunction(name, (args, ctx) => {
    const s = serialArg(args[0], ctx);
    return isError(s) ? s : fn(s);
  }, { minArgs: 1, maxArgs: 1 });
}
datePart('YEAR', (s) => serialToDate(s).year);
datePart('MONTH', (s) => serialToDate(s).month);
datePart('DAY', (s) => serialToDate(s).day);
datePart('HOUR', (s) => serialToTime(s).hour);
datePart('MINUTE', (s) => serialToTime(s).minute);
datePart('SECOND', (s) => serialToTime(s).second);

registerFunction('WEEKDAY', (args, ctx) => {
  const s = serialArg(args[0], ctx);
  if (isError(s)) return s;
  const type = optNum(args, 1, 1, ctx);
  if (isError(type)) return type;
  const wd = serialToDate(s).weekday; // 0 = Sunday
  switch (Math.trunc(type)) {
    case 1: case 17: return wd + 1;
    case 2: case 11: return ((wd + 6) % 7) + 1;
    case 3: return (wd + 6) % 7;
    case 12: return ((wd + 5) % 7) + 1; // Tuesday = 1
    case 13: return ((wd + 4) % 7) + 1;
    case 14: return ((wd + 3) % 7) + 1;
    case 15: return ((wd + 2) % 7) + 1;
    case 16: return ((wd + 1) % 7) + 1; // Saturday = 1
    default: return ERR.NUM;
  }
}, { minArgs: 1, maxArgs: 2 });

function addMonths(serial: number, months: number, endOfMonth: boolean): number {
  const { year, month, day } = serialToDate(serial);
  const total = year * 12 + (month - 1) + Math.trunc(months);
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const last = daysInMonth(y, m);
  return dateToSerial(y, m, endOfMonth ? last : Math.min(day, last));
}

registerFunction('EDATE', (args, ctx) => {
  const s = serialArg(args[0], ctx);
  const m = num(args[1], ctx);
  if (isError(s)) return s;
  if (isError(m)) return m;
  const out = addMonths(s, m, false);
  return out < 0 ? ERR.NUM : out;
}, { minArgs: 2, maxArgs: 2 });

registerFunction('EOMONTH', (args, ctx) => {
  const s = serialArg(args[0], ctx);
  const m = num(args[1], ctx);
  if (isError(s)) return s;
  if (isError(m)) return m;
  const out = addMonths(s, m, true);
  return out < 0 ? ERR.NUM : out;
}, { minArgs: 2, maxArgs: 2 });

registerFunction('DAYS', (args, ctx) => {
  const end = serialArg(args[0], ctx);
  const start = serialArg(args[1], ctx);
  if (isError(end)) return end;
  if (isError(start)) return start;
  return Math.trunc(end) - Math.trunc(start);
}, { minArgs: 2, maxArgs: 2, xlfn: true });

registerFunction('DATEVALUE', (args, ctx) => {
  const t = text(args[0], ctx);
  if (isError(t)) return t;
  const n = textToNumber(t);
  return n === null || n < 1 ? ERR.VALUE : Math.floor(n);
}, { minArgs: 1, maxArgs: 1 });

registerFunction('DATEDIF', (args, ctx) => {
  const s = serialArg(args[0], ctx);
  const e = serialArg(args[1], ctx);
  const unit = text(args[2], ctx);
  if (isError(s)) return s;
  if (isError(e)) return e;
  if (isError(unit)) return unit;
  const a = Math.trunc(s);
  const b = Math.trunc(e);
  if (a > b) return ERR.NUM;
  const da = serialToDate(a);
  const db = serialToDate(b);
  let months = (db.year - da.year) * 12 + (db.month - da.month);
  if (db.day < da.day) months--;
  switch (unit.toUpperCase()) {
    case 'D': return b - a;
    case 'M': return months;
    case 'Y': return Math.floor(months / 12);
    case 'YM': return months % 12;
    case 'MD': {
      if (db.day >= da.day) return db.day - da.day;
      // Days from the same day of the previous month.
      const pm = db.month === 1 ? 12 : db.month - 1;
      const py = db.month === 1 ? db.year - 1 : db.year;
      return b - dateToSerial(py, pm, da.day);
    }
    case 'YD': {
      let start = dateToSerial(db.year, da.month, da.day);
      if (start > b) start = dateToSerial(db.year - 1, da.month, da.day);
      return b - start;
    }
    default: return ERR.NUM;
  }
}, { minArgs: 3, maxArgs: 3 });

/* ── batch 2: common date functions this library did not have yet ── */

/** WEEKNUM: type 1 counts weeks from Sunday, type 2 from Monday (Excel's two common modes). */
registerFunction('WEEKNUM', (args, ctx) => {
  const serial = serialArg(args[0], ctx);
  if (isError(serial)) return serial;
  const type = optNum(args, 1, 1, ctx);
  if (isError(type)) return type;
  if (type !== 1 && type !== 2) return ERR.NUM;
  const whole = Math.floor(serial);
  const year = serialToDate(whole).year;
  const first = dateToSerial(year, 1, 1);
  const firstDay = serialToDate(first).weekday;               // 0 = Sunday in this engine
  const before = type === 2 ? (firstDay + 6) % 7 : firstDay;  // days of the first week already past
  return Math.floor((whole - first + before) / 7) + 1;
}, { minArgs: 1, maxArgs: 2 });

/** TIMEVALUE: the fraction of a day a "13:30" or "1:30 PM" text means (#VALUE! otherwise). */
registerFunction('TIMEVALUE', (args, ctx) => {
  const raw = text(args[0], ctx);
  if (isError(raw)) return raw;
  const m = /^\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)?\s*$/i.exec(raw);
  if (!m) return ERR.VALUE;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = Number(m[3] ?? 0);
  const half = (m[4] ?? '').toLowerCase();
  if (half === 'pm' && hour < 12) hour += 12;
  if (half === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return ERR.VALUE;
  return (hour * 3600 + minute * 60 + second) / 86400;
}, { minArgs: 1, maxArgs: 1 });

/** DAYS360: the 360-day year both accounting methods use. */
registerFunction('DAYS360', (args, ctx) => {
  const a = serialArg(args[0], ctx);
  if (isError(a)) return a;
  const b = serialArg(args[1], ctx);
  if (isError(b)) return b;
  const european = args.length > 2 && optNum(args, 2, 0, ctx) !== 0;
  const one = serialToDate(Math.floor(a));
  const two = serialToDate(Math.floor(b));
  let d1 = one.day;
  let d2 = two.day;
  if (d1 === 31) d1 = 30;
  if (european) { if (d2 === 31) d2 = 30; }
  else if (d2 === 31 && d1 === 30) d2 = 30;
  return (two.year - one.year) * 360 + (two.month - one.month) * 30 + (d2 - d1);
}, { minArgs: 2, maxArgs: 3 });

/** NETWORKDAYS: Monday-to-Friday days between two dates, holidays excluded, negative backwards. */
registerFunction('NETWORKDAYS', (args, ctx) => {
  const a = serialArg(args[0], ctx);
  if (isError(a)) return a;
  const b = serialArg(args[1], ctx);
  if (isError(b)) return b;
  const from = Math.floor(Math.min(a, b));
  const to = Math.floor(Math.max(a, b));
  const holidays = new Set<number>();
  if (args.length > 2 && args[2] !== null) {
    if (isArea(args[2])) {
      eachCell(args[2], (v) => {
        const n = typeof v === 'number' ? v : textToNumber(String(v ?? ''));
        if (typeof n === 'number' && Number.isFinite(n)) holidays.add(Math.floor(n));
      });
    } else {
      // A single date text or serial is a holiday too, the way Excel takes it.
      const one = serialArg(args[2], ctx);
      if (typeof one === 'number' && Number.isFinite(one)) holidays.add(Math.floor(one));
    }
  }
  let days = 0;
  for (let s = from; s <= to; s++) {
    const day = serialToDate(s).weekday;
    if (day === 0 || day === 6) continue;
    if (holidays.has(s)) continue;
    days++;
  }
  return a <= b ? days : -days;
}, { minArgs: 2, maxArgs: 3 });
