/**
 * PDF engine — a content-stream reader (قارئ تدفّق المحتوى).
 *
 * Splits a decoded page/form content stream (a latin1 string: one char per byte) into operators
 * with their operands, keeping each operator's exact source span so a caller can copy untouched
 * operators byte for byte and only rewrite the ones it changes. Inline images (`BI … ID … EI`)
 * come back as ONE operator named `BI` whose span covers the binary data. DOM-free.
 */

export type Tok =
  | { k: 'num'; v: number }
  | { k: 'name'; v: string }
  | { k: 'str'; v: number[] }
  | { k: 'arr'; v: Tok[] }
  | { k: 'dict'; v: Tok[] }
  | { k: 'kw'; v: string };

export interface Op {
  op: string;
  args: Tok[];
  /** Span in the source (from the first operand to the end of the operator). */
  start: number;
  end: number;
  /** For `BI`: the inline image dictionary entries. */
  inline?: Tok[];
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));

export function tokenizeContent(src: string): Op[] {
  let i = 0;
  const n = src.length;
  const code = (at: number): number => src.charCodeAt(at);

  const skipWs = (): void => {
    while (i < n) {
      const c = code(i);
      if (WS.has(c)) { i++; continue; }
      if (c === 37 /* % */) { while (i < n && code(i) !== 10 && code(i) !== 13) i++; continue; }
      break;
    }
  };

  const literal = (): number[] => {
    // at '('
    i++;
    const out: number[] = [];
    let depth = 1;
    while (i < n) {
      const c = code(i++);
      if (c === 92 /* \ */) {
        if (i >= n) break;
        const e = code(i++);
        const map: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
        if (map[e] !== undefined) out.push(map[e]);
        else if (e >= 48 && e <= 55) {
          let v = e - 48;
          for (let k = 0; k < 2 && i < n && code(i) >= 48 && code(i) <= 55; k++) v = v * 8 + (code(i++) - 48);
          out.push(v & 255);
        } else if (e === 13) { if (code(i) === 10) i++; } else if (e === 10) { /* line continuation */ } else out.push(e);
        continue;
      }
      if (c === 40) depth++;
      if (c === 41 && --depth === 0) break;
      out.push(c & 255);
    }
    return out;
  };

  const hex = (): number[] => {
    i++;
    let digits = '';
    while (i < n && code(i) !== 62) { const ch = src[i++]; if (/[0-9a-fA-F]/.test(ch)) digits += ch; }
    i++;
    if (digits.length % 2) digits += '0';
    const out: number[] = [];
    for (let k = 0; k < digits.length; k += 2) out.push(parseInt(digits.slice(k, k + 2), 16));
    return out;
  };

  const regular = (): string => {
    const s = i;
    while (i < n && !WS.has(code(i)) && !DELIM.has(code(i))) i++;
    return src.slice(s, i);
  };

  /** One token, or null at a closing delimiter / end. */
  const token = (): Tok | null => {
    skipWs();
    if (i >= n) return null;
    const c = code(i);
    if (c === 40) return { k: 'str', v: literal() };
    if (c === 60) {
      if (code(i + 1) === 60) {
        i += 2;
        const items: Tok[] = [];
        for (;;) {
          skipWs();
          if (i >= n) break;
          if (code(i) === 62 && code(i + 1) === 62) { i += 2; break; }
          const t = token();
          if (!t) { i++; continue; }
          items.push(t);
        }
        return { k: 'dict', v: items };
      }
      return { k: 'str', v: hex() };
    }
    if (c === 91) {
      i++;
      const items: Tok[] = [];
      for (;;) {
        skipWs();
        if (i >= n) break;
        if (code(i) === 93) { i++; break; }
        const t = token();
        if (!t) { i++; continue; }
        items.push(t);
      }
      return { k: 'arr', v: items };
    }
    if (c === 47) { i++; return { k: 'name', v: regular() }; }
    if (c === 41 || c === 62 || c === 93 || c === 123 || c === 125) return null;
    const word = regular();
    if (!word) { i++; return null; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { k: 'num', v: Number(word) };
    return { k: 'kw', v: word };
  };

  const ops: Op[] = [];
  let args: Tok[] = [];
  let start = -1;
  while (i < n) {
    skipWs();
    if (i >= n) break;
    const at = i;
    const t = token();
    if (!t) { i = Math.max(i, at + 1); continue; }
    if (start < 0) start = at;
    if (t.k === 'kw' && t.v !== 'true' && t.v !== 'false' && t.v !== 'null') {
      if (t.v === 'BI') {
        // inline image: dictionary entries up to ID, then binary data up to a free-standing EI
        const inline: Tok[] = [];
        for (;;) {
          skipWs();
          if (i >= n) break;
          const save = i;
          const d = token();
          if (!d) { i = save + 1; continue; }
          if (d.k === 'kw' && d.v === 'ID') break;
          inline.push(d);
        }
        i++; // the single white-space byte after ID
        const re = /[\0\t\n\f\r ]EI(?=[\0\t\n\f\r ]|$)/g;
        re.lastIndex = i;
        const m = re.exec(src);
        i = m ? m.index + m[0].length : n;
        ops.push({ op: 'BI', args, start, end: i, inline });
      } else {
        ops.push({ op: t.v, args, start, end: i });
      }
      args = [];
      start = -1;
    } else {
      args.push(t);
    }
  }
  return ops;
}

/* ───────── writing tokens back ───────── */

export function numText(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
}

export function hexString(bytes: readonly number[]): string {
  return `<${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}>`;
}

export function tokText(t: Tok): string {
  switch (t.k) {
    case 'num': return numText(t.v);
    case 'name': return `/${t.v}`;
    case 'str': return hexString(t.v);
    case 'arr': return `[${t.v.map(tokText).join(' ')}]`;
    case 'dict': return `<<${t.v.map(tokText).join(' ')}>>`;
    default: return t.v;
  }
}
