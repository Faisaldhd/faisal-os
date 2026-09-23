/** Small helpers shared by the shell and its commands (pure). */

export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  boldRed: '\x1b[1;31m',
  boldGreen: '\x1b[1;32m',
  boldBlue: '\x1b[1;34m',
  boldCyan: '\x1b[1;36m',
  boldMagenta: '\x1b[1;35m',
  inverse: '\x1b[7m',
};

const ERRNO: Record<string, string> = {
  ENOENT: 'No such file or directory',
  EEXIST: 'File exists',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  ENOTEMPTY: 'Directory not empty',
  EACCES: 'Permission denied',
  EINVAL: 'Invalid argument',
};

/** Maps a (VFS) error to the strerror text Linux would print. */
export function errText(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code && ERRNO[code]) return ERRNO[code];
  return (e as Error)?.message ?? String(e);
}

export function errCode(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

/**
 * File names are untrusted: never let them smuggle escape sequences into the
 * terminal. Control characters are shown as '?' (like GNU ls on a tty).
 */
export function safeName(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
}

/** Visible width of a string once ANSI escapes are removed. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
}

/** Terminal column width of one code point (0 for combining marks, 2 for wide CJK/emoji). */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // combining marks (incl. Arabic harakat)
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x0610 && cp <= 0x061a) || (cp >= 0x064b && cp <= 0x065f) ||
      cp === 0x0670 || (cp >= 0x06d6 && cp <= 0x06dc) || (cp >= 0x06df && cp <= 0x06e4) ||
      (cp >= 0x06e7 && cp <= 0x06e8) || (cp >= 0x06ea && cp <= 0x06ed) || cp === 0x200b || cp === 0x200c ||
      cp === 0x200d || cp === 0x200e || cp === 0x200f || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x20d0 && cp <= 0x20ff)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

export function strWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0)!);
  return w;
}

export function padEnd(s: string, width: number): string {
  const w = strWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function padStart(s: string, width: number): string {
  const w = strWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}

/** 1.5K, 23M ... like `ls -h` / `du -h`. */
export function human(n: number): string {
  if (n < 1024) return String(n);
  const units = ['K', 'M', 'G', 'T'];
  let v = n;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return (v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : String(Math.ceil(v))) + units[u];
}

/** Converts a shell glob (*, ?, [abc]) into a RegExp. Backslash-escaped chars are literal. */
export function globToRegExp(glob: string, flags = ''): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) { re += escapeRe(glob[++i]); continue; }
    if (c === '*') { re += '.*'; continue; }
    if (c === '?') { re += '.'; continue; }
    if (c === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close > 0) {
        let body = glob.slice(i + 1, close);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        re += '[' + body.replace(/\\/g, '\\\\') + ']';
        i = close;
        continue;
      }
    }
    re += escapeRe(c);
  }
  return new RegExp(re + '$', flags);
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function hasGlob(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '*' || s[i] === '?' || s[i] === '[') return true;
  }
  return false;
}

export function unescapeGlob(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

export interface ParsedFlags {
  flags: Set<string>;
  values: Map<string, string>;
  operands: string[];
}

/**
 * Minimal getopt: `bool` is a string of single-letter flags, `withValue` of
 * letters that take an argument. `long` maps long options to letters.
 * Throws a message like "invalid option -- 'z'".
 */
export function getopt(args: string[], bool: string, withValue = '', long: Record<string, string> = {}): ParsedFlags {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { operands.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--') && a.length > 2) {
      const [name, val] = a.slice(2).split(/=(.*)/s, 2);
      const letter = long[name];
      if (!letter) throw new Error(`unrecognized option '${a}'`);
      if (withValue.includes(letter)) {
        const v = val ?? args[++i];
        if (v === undefined) throw new Error(`option '--${name}' requires an argument`);
        values.set(letter, v);
      } else flags.add(letter);
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (withValue.includes(ch)) {
          const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
          if (v === undefined) throw new Error(`option requires an argument -- '${ch}'`);
          values.set(ch, v);
          break;
        }
        if (!bool.includes(ch)) throw new Error(`invalid option -- '${ch}'`);
        flags.add(ch);
      }
      continue;
    }
    operands.push(a);
  }
  return { flags, values, operands };
}

export function splitLines(s: string): string[] {
  if (!s) return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export { MONTHS, DAYS };

const p2 = (n: number) => String(n).padStart(2, '0');

/** "Sep 23 11:06" (recent) or "Sep 23  2024" (older than ~6 months), like ls -l. */
export function lsDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const head = `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')}`;
  const recent = Math.abs(now - ms) < 182 * 24 * 3600 * 1000;
  return recent ? `${head} ${p2(d.getHours())}:${p2(d.getMinutes())}` : `${head}  ${d.getFullYear()}`;
}

export function tzName(d: Date): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName');
    return part?.value ?? 'UTC';
  } catch { return 'UTC'; }
}

/** strftime subset used by `date +FORMAT`. */
export function strftime(fmt: string, d: Date): string {
  return fmt.replace(/%([a-zA-Z%])/g, (_, k: string) => {
    switch (k) {
      case 'Y': return String(d.getFullYear());
      case 'y': return p2(d.getFullYear() % 100);
      case 'm': return p2(d.getMonth() + 1);
      case 'd': return p2(d.getDate());
      case 'e': return String(d.getDate()).padStart(2, ' ');
      case 'H': return p2(d.getHours());
      case 'I': return p2(((d.getHours() + 11) % 12) + 1);
      case 'p': return d.getHours() < 12 ? 'AM' : 'PM';
      case 'M': return p2(d.getMinutes());
      case 'S': return p2(d.getSeconds());
      case 'a': return DAYS[d.getDay()];
      case 'A': return DAYS_LONG[d.getDay()];
      case 'b': case 'h': return MONTHS[d.getMonth()];
      case 'B': return MONTHS_LONG[d.getMonth()];
      case 'j': {
        const start = new Date(d.getFullYear(), 0, 0);
        return String(Math.floor((d.getTime() - start.getTime()) / 86400000)).padStart(3, '0');
      }
      case 's': return String(Math.floor(d.getTime() / 1000));
      case 'Z': return tzName(d);
      case 'F': return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      case 'T': return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
      case 'D': return `${p2(d.getMonth() + 1)}/${p2(d.getDate())}/${p2(d.getFullYear() % 100)}`;
      case 'u': return String(d.getDay() || 7);
      case 'w': return String(d.getDay());
      case 'n': return '\n';
      case 't': return '\t';
      case '%': return '%';
      default: return '%' + k;
    }
  });
}

export function modeString(type: 'file' | 'dir', mode: number): string {
  const r = (bit: number, ch: string) => (mode & bit ? ch : '-');
  return (type === 'dir' ? 'd' : '-') +
    r(0o400, 'r') + r(0o200, 'w') + r(0o100, 'x') +
    r(0o040, 'r') + r(0o020, 'w') + r(0o010, 'x') +
    r(0o004, 'r') + r(0o002, 'w') + r(0o001, 'x');
}

/** Lays out names in columns like `ls` on a tty. */
export function columns(items: { text: string; width: number }[], cols: number): string {
  if (!items.length) return '';
  const gap = 2;
  const maxW = Math.max(...items.map((i) => i.width));
  for (let ncol = Math.min(items.length, Math.max(1, Math.floor(cols / (1 + gap)))); ncol >= 1; ncol--) {
    const nrow = Math.ceil(items.length / ncol);
    const widths: number[] = [];
    for (let c = 0; c < ncol; c++) {
      let w = 0;
      for (let r = 0; r < nrow; r++) { const it = items[c * nrow + r]; if (it) w = Math.max(w, it.width); }
      widths.push(w);
    }
    const total = widths.reduce((a, b) => a + b, 0) + gap * (ncol - 1);
    if (total <= cols || ncol === 1) {
      let out = '';
      for (let r = 0; r < nrow; r++) {
        const row: string[] = [];
        for (let c = 0; c < ncol; c++) {
          const it = items[c * nrow + r];
          if (!it) continue;
          const last = c === ncol - 1 || !items[(c + 1) * nrow + r];
          row.push(last ? it.text : it.text + ' '.repeat(widths[c] - it.width + gap));
        }
        out += row.join('') + '\n';
      }
      return out;
    }
  }
  return items.map((i) => i.text).join('\n') + (maxW ? '\n' : '');
}
