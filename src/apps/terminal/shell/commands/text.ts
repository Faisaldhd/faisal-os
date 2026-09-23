import type { CommandContext, CommandSpec } from '../types';
import { C, errText, getopt, safeName, splitLines } from '../util';
import { inputs, tryStat, usageError, walk } from './common';

/* ───────────── echo ───────────── */

export function echoEscapes(s: string): { text: string; stop: boolean } {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i + 1 >= s.length) { out += c; continue; }
    const n = s[++i];
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case 'e': case 'E': out += '\x1b'; break;
      case '\\': out += '\\'; break;
      case 'c': return { text: out, stop: true };
      case '0': {
        const m = /^[0-7]{0,3}/.exec(s.slice(i + 1))![0];
        out += String.fromCharCode(parseInt(m || '0', 8)); i += m.length; break;
      }
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i + 1));
        if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += m[0].length; } else out += '\\x';
        break;
      }
      case 'u': {
        const m = /^[0-9a-fA-F]{1,4}/.exec(s.slice(i + 1));
        if (m) { out += String.fromCodePoint(parseInt(m[0], 16)); i += m[0].length; } else out += '\\u';
        break;
      }
      default: out += '\\' + n;
    }
  }
  return { text: out, stop: false };
}

function echo(ctx: CommandContext): number {
  let newline = true;
  let escapes = false;
  let i = 0;
  for (; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    if (!/^-[neE]+$/.test(a)) break;
    for (const f of a.slice(1)) {
      if (f === 'n') newline = false;
      else if (f === 'e') escapes = true;
      else escapes = false;
    }
  }
  let text = ctx.args.slice(i).join(' ');
  if (escapes) {
    const r = echoEscapes(text);
    text = r.text;
    if (r.stop) newline = false;
  }
  ctx.out(text + (newline ? '\n' : ''));
  return 0;
}

/* ───────────── head / tail ───────────── */

function lineCountArgs(ctx: CommandContext): { n: number; fromStart: boolean; operands: string[] } | string {
  const args = ctx.args.map((a) => (/^-\d+$/.test(a) ? `-n${a.slice(1)}` : a));
  let o;
  try { o = getopt(args, 'qv', 'n', { lines: 'n' }); } catch (e) { return (e as Error).message; }
  const raw = o.values.get('n') ?? '10';
  const fromStart = raw.startsWith('+');
  const n = parseInt(raw.replace(/^[+-]/, ''), 10);
  if (Number.isNaN(n)) return `invalid number of lines: '${raw}'`;
  return { n, fromStart, operands: o.operands };
}

async function headTail(ctx: CommandContext, which: 'head' | 'tail'): Promise<number> {
  const a = lineCountArgs(ctx);
  if (typeof a === 'string') return usageError(ctx, a);
  let status = 0;
  const multi = a.operands.length > 1;
  let first = true;
  for await (const inp of inputs(ctx, a.operands)) {
    if ('error' in inp) { ctx.err(`${which}: cannot open '${inp.name}' for reading: ${inp.error}\n`); status = 1; continue; }
    if (multi) { ctx.out(`${first ? '' : '\n'}==> ${safeName(inp.name)} <==\n`); first = false; }
    const lines = splitLines(inp.text);
    let sel: string[];
    if (which === 'head') sel = lines.slice(0, a.n);
    else sel = a.fromStart ? lines.slice(Math.max(0, a.n - 1)) : a.n === 0 ? [] : lines.slice(-a.n);
    if (sel.length) ctx.out(sel.join('\n') + '\n');
  }
  return status;
}

/* ───────────── wc ───────────── */

async function wc(ctx: CommandContext): Promise<number> {
  let o;
  try { o = getopt(ctx.args, 'lwcm', '', { lines: 'l', words: 'w', bytes: 'c', chars: 'm' }); } catch (e) { return usageError(ctx, (e as Error).message); }
  const f = o.flags.size ? o.flags : new Set(['l', 'w', 'c']);
  const rows: { counts: number[]; name: string }[] = [];
  const total = [0, 0, 0, 0];
  let status = 0;
  const enc = new TextEncoder();
  for await (const inp of inputs(ctx, o.operands)) {
    if ('error' in inp) { ctx.err(`wc: ${inp.name}: ${inp.error}\n`); status = 1; continue; }
    const t = inp.text;
    const all = [
      (t.match(/\n/g) ?? []).length,
      t.split(/\s+/).filter(Boolean).length,
      [...t].length,
      enc.encode(t).length,
    ];
    all.forEach((v, i) => (total[i] += v));
    rows.push({ counts: all, name: o.operands.length ? inp.name : '' });
  }
  if (rows.length > 1) rows.push({ counts: total, name: 'total' });
  const pick = (c: number[]) => [f.has('l') ? c[0] : -1, f.has('w') ? c[1] : -1, f.has('m') ? c[2] : -1, f.has('c') ? c[3] : -1].filter((x) => x >= 0);
  const single = rows.length === 1 && pick(rows[0].counts).length === 1;
  const width = single ? 0 : Math.max(1, ...rows.flatMap((r) => pick(r.counts).map((n) => String(n).length)));
  for (const r of rows) {
    ctx.out(pick(r.counts).map((n) => String(n).padStart(width)).join(' ') + (r.name ? ` ${safeName(r.name)}` : '') + '\n');
  }
  return status;
}

/* ───────────── grep ───────────── */

async function grep(ctx: CommandContext): Promise<number> {
  let o;
  try { o = getopt(ctx.args, 'invcrRlEFwoHhq', 'e', { 'ignore-case': 'i', 'line-number': 'n', 'invert-match': 'v', count: 'c', recursive: 'r', 'files-with-matches': 'l', 'fixed-strings': 'F', 'word-regexp': 'w', 'only-matching': 'o', quiet: 'q' }); }
  catch (e) { return usageError(ctx, (e as Error).message, 'grep [OPTION]... PATTERNS [FILE]...'); }
  const f = o.flags;
  const ops = [...o.operands];
  const pattern = o.values.get('e') ?? ops.shift();
  if (pattern === undefined) return usageError(ctx, 'missing pattern', 'grep [OPTION]... PATTERNS [FILE]...');
  let src = f.has('F') ? pattern.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') : pattern;
  // basic-regex niceties: \| \( \) \{ \} behave like ERE
  if (!f.has('F') && !f.has('E')) src = src.replace(/\\([|(){}+?])/g, '$1');
  if (f.has('w')) src = `\\b(?:${src})\\b`;
  let re: RegExp;
  try { re = new RegExp(src, f.has('i') ? 'giu' : 'gu'); }
  catch { ctx.err(`grep: Invalid regular expression: '${pattern}'\n`); return 2; }

  const recursive = f.has('r') || f.has('R');
  const targets: string[] = [];
  let status = 0;
  if (recursive) {
    for (const op of ops.length ? ops : ['.']) {
      const path = ctx.shell.resolve(op);
      const st = await tryStat(ctx, path);
      if (!st) { ctx.err(`grep: ${op}: No such file or directory\n`); status = 2; continue; }
      if (st.type === 'file') { targets.push(op); continue; }
      for await (const e of walk(ctx, path)) if (e.st.type === 'file') targets.push((op === '.' ? '' : op.replace(/\/$/, '') + '/') + e.path.slice(path === '/' ? 1 : path.length + 1));
    }
  } else targets.push(...ops);
  const showName = f.has('H') || (!f.has('h') && (targets.length > 1 || recursive));
  const tty = ctx.isTTY;
  let matched = false;

  for await (const inp of inputs(ctx, recursive && !targets.length ? [] : targets)) {
    if (recursive && !targets.length) break;
    if ('error' in inp) { ctx.err(`grep: ${inp.name}: ${inp.error}\n`); status = 2; continue; }
    let count = 0;
    const lines = splitLines(inp.text);
    const name = tty ? `${C.magenta}${safeName(inp.name)}${C.reset}${C.cyan}:${C.reset}` : `${safeName(inp.name)}:`;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      const hit = re.test(line) !== f.has('v');
      if (!hit) continue;
      count++;
      matched = true;
      if (f.has('q')) return 0;
      if (f.has('c') || f.has('l')) continue;
      const prefix = (showName ? name : '') + (f.has('n') ? (tty ? `${C.green}${i + 1}${C.reset}${C.cyan}:${C.reset}` : `${i + 1}:`) : '');
      if (f.has('o') && !f.has('v')) {
        for (const m of line.matchAll(re)) if (m[0]) ctx.out(prefix + (tty ? `${C.boldRed}${m[0]}${C.reset}` : m[0]) + '\n');
        continue;
      }
      const shown = tty && !f.has('v') ? line.replace(re, (m) => (m ? `${C.boldRed}${m}${C.reset}` : m)) : line;
      ctx.out(prefix + shown + '\n');
    }
    if (f.has('c')) ctx.out((showName ? name : '') + count + '\n');
    if (f.has('l') && count) ctx.out((tty ? `${C.magenta}${safeName(inp.name)}${C.reset}` : safeName(inp.name)) + '\n');
  }
  return status === 2 && !matched ? 2 : matched ? 0 : 1;
}

/* ───────────── sort / uniq ───────────── */

async function sort(ctx: CommandContext): Promise<number> {
  let o;
  try { o = getopt(ctx.args, 'rnufb', '', { reverse: 'r', 'numeric-sort': 'n', unique: 'u', 'ignore-case': 'f' }); } catch (e) { return usageError(ctx, (e as Error).message); }
  const lines: string[] = [];
  let status = 0;
  for await (const inp of inputs(ctx, o.operands)) {
    if ('error' in inp) { ctx.err(`sort: cannot read: ${inp.name}: ${inp.error}\n`); status = 2; continue; }
    lines.push(...splitLines(inp.text));
  }
  const key = (s: string) => (o.flags.has('f') ? s.toLowerCase() : s);
  if (o.flags.has('n')) lines.sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0) || a.localeCompare(b, 'en'));
  else lines.sort((a, b) => key(a).localeCompare(key(b), 'en'));
  if (o.flags.has('r')) lines.reverse();
  const res = o.flags.has('u') ? lines.filter((l, i) => i === 0 || key(l) !== key(lines[i - 1])) : lines;
  if (res.length) ctx.out(res.join('\n') + '\n');
  return status;
}

async function uniq(ctx: CommandContext): Promise<number> {
  let o;
  try { o = getopt(ctx.args, 'cdui', '', { count: 'c', repeated: 'd', unique: 'u', 'ignore-case': 'i' }); } catch (e) { return usageError(ctx, (e as Error).message); }
  const [input] = o.operands;
  let text = '';
  for await (const inp of inputs(ctx, input ? [input] : [])) {
    if ('error' in inp) { ctx.err(`uniq: ${inp.name}: ${inp.error}\n`); return 1; }
    text = inp.text;
  }
  const lines = splitLines(text);
  const eq = (a: string, b: string) => (o.flags.has('i') ? a.toLowerCase() === b.toLowerCase() : a === b);
  const groups: { line: string; n: number }[] = [];
  for (const l of lines) {
    const g = groups[groups.length - 1];
    if (g && eq(g.line, l)) g.n++;
    else groups.push({ line: l, n: 1 });
  }
  let out = '';
  for (const g of groups) {
    if (o.flags.has('d') && g.n < 2) continue;
    if (o.flags.has('u') && g.n > 1) continue;
    out += (o.flags.has('c') ? `${String(g.n).padStart(7)} ` : '') + g.line + '\n';
  }
  ctx.out(out);
  return 0;
}

/* ───────────── tee / seq ───────────── */

async function tee(ctx: CommandContext): Promise<number> {
  const append = ctx.args.includes('-a');
  const files = ctx.args.filter((a) => a !== '-a');
  const data = ctx.stdin ?? '';
  ctx.out(data);
  let status = 0;
  for (const f of files) {
    const path = ctx.shell.resolve(f);
    try {
      ctx.shell.assertWritable(path);
      const prev = append && (await ctx.shell.vfs.exists(path)) ? await ctx.shell.vfs.readText(path) : '';
      await ctx.shell.vfs.writeFile(path, prev + data);
    } catch (e) { ctx.err(`tee: ${f}: ${errText(e)}\n`); status = 1; }
  }
  return status;
}

function seq(ctx: CommandContext): number {
  const nums = ctx.args.map(Number);
  if (!nums.length || nums.length > 3 || nums.some(Number.isNaN)) return usageError(ctx, ctx.args.length ? `invalid argument` : 'missing operand');
  const [first, inc, last] = nums.length === 1 ? [1, 1, nums[0]] : nums.length === 2 ? [nums[0], 1, nums[1]] : nums;
  if (inc === 0) { ctx.err('seq: invalid Zero increment value\n'); return 1; }
  const out: string[] = [];
  for (let v = first; inc > 0 ? v <= last : v >= last; v += inc) {
    out.push(String(Math.round(v * 1e9) / 1e9));
    if (out.length > 100000) break;
  }
  if (out.length) ctx.out(out.join('\n') + '\n');
  return 0;
}

export const textCommands: Record<string, CommandSpec> = {
  echo: { run: echo, group: 'text', builtin: true, help: 'display a line of text (-n, -e)' },
  head: { run: (c) => headTail(c, 'head'), group: 'text', help: 'first lines of a file (-n N)' },
  tail: { run: (c) => headTail(c, 'tail'), group: 'text', help: 'last lines of a file (-n N, -n +N)' },
  wc: { run: wc, group: 'text', help: 'count lines, words and bytes (-l -w -c -m)' },
  grep: { run: grep, group: 'text', help: 'search text (-i -n -v -c -r -l -w -o -F)' },
  sort: { run: sort, group: 'text', help: 'sort lines (-r -n -u -f)' },
  uniq: { run: uniq, group: 'text', help: 'filter repeated lines (-c -d -u -i)' },
  tee: { run: tee, group: 'text', help: 'copy stdin to files and stdout (-a)' },
  seq: { run: seq, group: 'text', help: 'print a sequence of numbers' },
};
