/**
 * The sheet's function library (مكتبة الدوال): the categories of the Formulas tab and of the
 * "Insert function" dialog, and a search over them.
 *
 * The lists name functions; only the ones the engine really has are ever offered (`available`
 * reads the formula registry), so a menu can never insert a name that evaluates to #NAME?. A
 * function the engine has but no category lists still shows under "All".
 *
 * HYPERLINK is registered here: it is how a sheet carries a link in Excel and WPS (a formula, so
 * it saves and reopens like any other), and the grid draws a cell holding one as a link.
 */
import { listFunctions, registerFunction, toText, type Value } from '../formula/index';

export type FunctionCategory = 'math' | 'statistical' | 'logical' | 'text' | 'date' | 'lookup' | 'financial' | 'info';

export const FUNCTION_CATEGORIES: ReadonlyArray<{ id: FunctionCategory; names: readonly string[] }> = [
  { id: 'math', names: ['SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT', 'SUMSQ', 'PRODUCT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'MROUND', 'INT', 'TRUNC', 'ABS', 'MOD', 'QUOTIENT', 'POWER', 'SQRT', 'EXP', 'LN', 'LOG', 'LOG10', 'PI', 'RAND', 'RANDBETWEEN', 'CEILING', 'FLOOR', 'EVEN', 'ODD', 'SIGN', 'GCD', 'LCM', 'DEGREES', 'RADIANS'] },
  { id: 'statistical', names: ['AVERAGE', 'AVERAGEIF', 'AVERAGEIFS', 'AVERAGEA', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS', 'MAX', 'MAXA', 'MAXIFS', 'MIN', 'MINA', 'MINIFS', 'MEDIAN', 'MODE', 'LARGE', 'SMALL', 'RANK', 'PERCENTILE', 'QUARTILE', 'STDEV', 'STDEV.P', 'VAR', 'VAR.P'] },
  { id: 'logical', names: ['IF', 'IFS', 'IFERROR', 'IFNA', 'AND', 'OR', 'XOR', 'NOT', 'SWITCH', 'TRUE', 'FALSE'] },
  { id: 'text', names: ['CONCAT', 'CONCATENATE', 'TEXTJOIN', 'LEFT', 'RIGHT', 'MID', 'LEN', 'TRIM', 'UPPER', 'LOWER', 'PROPER', 'FIND', 'SEARCH', 'REPLACE', 'SUBSTITUTE', 'REPT', 'TEXT', 'VALUE', 'EXACT', 'CLEAN', 'CHAR', 'CODE', 'UNICHAR', 'UNICODE', 'T'] },
  { id: 'date', names: ['TODAY', 'NOW', 'DATE', 'TIME', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'WEEKDAY', 'WEEKNUM', 'EDATE', 'EOMONTH', 'DAYS', 'DAYS360', 'DATEDIF', 'DATEVALUE', 'TIMEVALUE', 'NETWORKDAYS'] },
  { id: 'lookup', names: ['XLOOKUP', 'VLOOKUP', 'HLOOKUP', 'INDEX', 'MATCH', 'XMATCH', 'CHOOSE', 'OFFSET', 'ROW', 'ROWS', 'COLUMN', 'COLUMNS', 'TRANSPOSE', 'HYPERLINK'] },
  { id: 'financial', names: ['PMT', 'FV', 'PV', 'NPER', 'RATE', 'NPV', 'IRR', 'SLN'] },
  { id: 'info', names: ['ISBLANK', 'ISNUMBER', 'ISTEXT', 'ISNONTEXT', 'ISLOGICAL', 'ISERROR', 'ISERR', 'ISNA', 'ISEVEN', 'ISODD', 'N', 'NA'] },
];

/**
 * The functions whose one-line help the dialog shows (`office.fnHelp_<NAME>`): the ones people
 * reach for most. The others show their name and category only.
 */
export const DESCRIBED_FUNCTIONS: readonly string[] = [
  'SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'IF', 'IFERROR', 'AND', 'OR', 'SUMIF', 'COUNTIF',
  'VLOOKUP', 'XLOOKUP', 'INDEX', 'MATCH', 'ROUND', 'TODAY', 'NOW', 'DATE', 'CONCAT', 'LEFT', 'RIGHT',
  'LEN', 'TRIM', 'TEXT', 'PMT', 'HYPERLINK',
];

/** The functions of a category the engine really has, in the category's own order. */
export function functionsIn(category: FunctionCategory | 'all', available: readonly string[] = listFunctions()): string[] {
  const have = new Set(available);
  if (category === 'all') return [...have].sort();
  return (FUNCTION_CATEGORIES.find((c) => c.id === category)?.names ?? []).filter((n) => have.has(n));
}

/** The category a function belongs to ('all' when none lists it). */
export function categoryOf(name: string): FunctionCategory | 'all' {
  return FUNCTION_CATEGORIES.find((c) => c.names.includes(name.toUpperCase()))?.id ?? 'all';
}

/**
 * The functions matching what the owner typed: names that start with it first, then names that
 * contain it, then (for words) the functions whose help text contains it.
 */
export function searchFunctions(query: string, names: readonly string[], help: (name: string) => string = () => ''): string[] {
  const q = query.trim().toUpperCase();
  if (!q) return [...names];
  const starts = names.filter((n) => n.startsWith(q));
  const contains = names.filter((n) => !n.startsWith(q) && n.includes(q));
  const lower = query.trim().toLowerCase();
  const described = names.filter((n) => !n.includes(q) && help(n).toLowerCase().includes(lower));
  return [...starts, ...contains, ...described];
}

/** The text a chosen function puts in the cell: `=NAME(` for the owner to finish. */
export function functionEntry(name: string, current = ''): string {
  const base = current.trim().startsWith('=') ? current.trimEnd() : '=';
  const joiner = base === '=' || /[(,:+\-*/^&=<>]$/.test(base) ? '' : '+';
  return `${base}${joiner}${name}(`;
}

/** A link a cell may open: http(s) and mailto only (never javascript: or data:). */
export function safeLink(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (/^www\.[^\s]+$/i.test(u)) return `https://${u}`;
  return null;
}

/** The link a formula carries, when it is a HYPERLINK: `=HYPERLINK("url", "name")`. */
export function hyperlinkOf(formula: string | undefined): string | null {
  const m = /^=\s*HYPERLINK\(\s*"((?:[^"]|"")*)"/i.exec(formula ?? '');
  return m ? safeLink(m[1].replace(/""/g, '"')) : null;
}

/** The formula for a link with its shown name. */
export function hyperlinkFormula(url: string, name: string): string {
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  return name.trim() && name.trim() !== url.trim() ? `=HYPERLINK(${q(url.trim())},${q(name.trim())})` : `=HYPERLINK(${q(url.trim())})`;
}

let registered = false;
/** HYPERLINK(url, [name]): the cell shows the name (or the address); the grid makes it a link. */
export function registerSheetFunctions(): void {
  if (registered) return;
  registered = true;
  registerFunction('HYPERLINK', (args: Value[], ctx) => {
    const url = ctx.scalar(args[0]);
    const name = args.length > 1 ? ctx.scalar(args[1]) : url;
    return toText(name);
  }, { minArgs: 1, maxArgs: 2 });
}
registerSheetFunctions();
