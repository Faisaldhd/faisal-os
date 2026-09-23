import type { Stat } from '../../../../kernel/types';
import { VFSError } from '../../../../kernel/types';
import { basename, dirname, normalize } from '../../../../kernel/path';
import type { CommandContext, CommandSpec } from '../types';
import { columns, errCode, errText, getopt, globToRegExp, human, lsDate, modeString, padStart, safeName, strWidth } from '../util';
import { colorName, ownerOf, treeSize, tryStat, usageError, walk } from './common';

/* ───────────── ls ───────────── */

async function ls(ctx: CommandContext): Promise<number> {
  let o;
  try { o = getopt(ctx.args, 'laAh1drtSR', '', { all: 'a', 'almost-all': 'A', 'human-readable': 'h', directory: 'd', reverse: 'r', recursive: 'R' }); }
  catch (e) { return usageError(ctx, (e as Error).message); }
  const f = o.flags;
  const long = f.has('l');
  const operands = o.operands.length ? o.operands : ['.'];
  const tty = ctx.isTTY;
  const cols = ctx.shell.host.size?.().cols ?? 80;
  let status = 0;

  const sortList = (list: Stat[]) => {
    list.sort((a, b) => a.name.replace(/^\./, '').localeCompare(b.name.replace(/^\./, ''), 'en'));
    if (f.has('t')) list.sort((a, b) => b.mtime - a.mtime);
    if (f.has('S')) list.sort((a, b) => b.size - a.size);
    if (f.has('r')) list.reverse();
    return list;
  };

  const format = (entries: { st: Stat; shown: string }[], showTotal: boolean) => {
    if (long) {
      const rows = entries.map(({ st, shown }) => {
        const owner = ownerOf(st.path, ctx.shell.home);
        const size = st.type === 'dir' ? 4096 : st.size;
        return {
          mode: modeString(st.type, st.mode),
          links: st.type === 'dir' ? '2' : '1',
          owner,
          size: f.has('h') ? human(size) : String(size),
          date: lsDate(st.mtime),
          name: colorName(st, shown, tty),
        };
      });
      const w = (k: 'links' | 'owner' | 'size') => Math.max(0, ...rows.map((r) => strWidth(r[k])));
      const lw = w('links'), ow = w('owner'), sw = w('size');
      let s = '';
      if (showTotal) {
        const blocks = entries.reduce((n, { st }) => n + (st.type === 'dir' ? 4 : Math.ceil(st.size / 4096) * 4), 0);
        s += `total ${f.has('h') ? human(blocks * 1024) : blocks}\n`;
      }
      for (const r of rows) {
        s += `${r.mode}. ${padStart(r.links, lw)} ${r.owner.padEnd(ow)} ${r.owner.padEnd(ow)} ${padStart(r.size, sw)} ${r.date} ${r.name}\n`;
      }
      return s;
    }
    const items = entries.map(({ st, shown }) => ({ text: colorName(st, shown, tty), width: strWidth(safeName(shown)) }));
    if (!tty || f.has('1')) return items.map((i) => i.text).join('\n') + (items.length ? '\n' : '');
    return columns(items, cols);
  };

  const files: { st: Stat; shown: string }[] = [];
  const dirs: { st: Stat; shown: string }[] = [];
  for (const op of operands) {
    const st = await tryStat(ctx, ctx.shell.resolve(op));
    if (!st) { ctx.err(`ls: cannot access '${op}': No such file or directory\n`); status = 2; continue; }
    if (st.type === 'dir' && !f.has('d')) dirs.push({ st, shown: op });
    else files.push({ st, shown: op });
  }
  let first = true;
  if (files.length) { ctx.out(format(files, false)); first = false; }

  const listDir = async (st: Stat, shown: string, header: boolean) => {
    let entries: Stat[];
    try { entries = await ctx.shell.vfs.readdir(st.path); }
    catch (e) { ctx.err(`ls: cannot open directory '${shown}': ${errText(e)}\n`); status = 2; return; }
    if (!f.has('a') && !f.has('A')) entries = entries.filter((e) => !e.name.startsWith('.'));
    sortList(entries);
    const list = entries.map((e) => ({ st: e, shown: e.name }));
    if (f.has('a')) {
      const parent = (await tryStat(ctx, dirname(st.path))) ?? st;
      list.unshift({ st: { ...st, name: '.' }, shown: '.' }, { st: { ...parent, name: '..' }, shown: '..' });
    }
    if (!first) ctx.out('\n');
    first = false;
    if (header) ctx.out(`${safeName(shown)}:\n`);
    ctx.out(format(list, true));
    if (f.has('R')) {
      for (const e of entries) {
        if (e.type === 'dir' && !ctx.signal.cancelled) await listDir(e, shown === '/' ? `/${e.name}` : `${shown}/${e.name}`, true);
      }
    }
  };
  for (const { st, shown } of dirs) await listDir(st, shown, operands.length > 1 || f.has('R'));
  return status;
}

/* ───────────── cd / pwd ───────────── */

async function cd(ctx: CommandContext): Promise<number> {
  const sh = ctx.shell;
  const args = ctx.args.filter((a) => a !== '--');
  if (args.length > 1) { ctx.err('bash: cd: too many arguments\n'); return 1; }
  let target = args[0] ?? sh.home;
  if (target === '-') {
    target = sh.env.get('OLDPWD') ?? sh.cwd;
    ctx.out(target + '\n');
  }
  const path = sh.resolve(target);
  const st = await tryStat(ctx, path);
  if (!st) { ctx.err(`bash: cd: ${target}: No such file or directory\n`); return 1; }
  if (st.type !== 'dir') { ctx.err(`bash: cd: ${target}: Not a directory\n`); return 1; }
  sh.env.set('OLDPWD', sh.cwd);
  sh.cwd = path;
  sh.env.set('PWD', path);
  return 0;
}

function pwd(ctx: CommandContext): number {
  ctx.out(ctx.shell.cwd + '\n');
  return 0;
}

/* ───────────── cat ───────────── */

async function cat(ctx: CommandContext): Promise<number> {
  let o;
  try { o = getopt(ctx.args, 'nAE', '', { number: 'n' }); } catch (e) { return usageError(ctx, (e as Error).message); }
  let status = 0;
  let lineNo = 0;
  const list = o.operands.length ? o.operands : ['-'];
  for (const op of list) {
    let text: string;
    if (op === '-') text = ctx.stdin ?? '';
    else {
      const path = ctx.shell.resolve(op);
      try {
        const st = await ctx.shell.vfs.stat(path);
        if (st.type === 'dir') throw new VFSError('EISDIR', path);
        text = await ctx.shell.vfs.readText(path);
      } catch (e) { ctx.err(`cat: ${op}: ${errText(e)}\n`); status = 1; continue; }
    }
    if (o.flags.has('n')) {
      const lines = text.split('\n');
      const trailing = lines[lines.length - 1] === '';
      if (trailing) lines.pop();
      text = lines.map((l) => `${String(++lineNo).padStart(6)}\t${l}`).join('\n') + (trailing ? '\n' : '');
    }
    ctx.out(text);
  }
  return status;
}

/* ───────────── mkdir / rmdir ───────────── */

async function mkdir(ctx: CommandContext): Promise<number> {
  let o;
  try { o = getopt(ctx.args, 'pv', '', { parents: 'p', verbose: 'v' }); } catch (e) { return usageError(ctx, (e as Error).message); }
  if (!o.operands.length) return usageError(ctx, 'missing operand');
  let status = 0;
  for (const op of o.operands) {
    const path = ctx.shell.resolve(op);
    try {
      const exists = await ctx.shell.vfs.exists(path);
      if (exists) {
        if (o.flags.has('p')) continue;
        throw new VFSError('EEXIST', path);
      }
      if (!o.flags.has('p') && !(await ctx.shell.vfs.exists(dirname(path)))) throw new VFSError('ENOENT', path);
      ctx.shell.assertWritable(path);
      await ctx.shell.vfs.mkdir(path, { recursive: o.flags.has('p') });
      if (o.flags.has('v')) ctx.out(`mkdir: created directory '${op}'\n`);
    } catch (e) {
      ctx.err(`mkdir: cannot create directory '${op}': ${errText(e)}\n`);
      status = 1;
    }
  }
  return status;
}

async function rmdir(ctx: CommandContext): Promise<number> {
  const ops = ctx.args.filter((a) => !a.startsWith('-'));
  if (!ops.length) return usageError(ctx, 'missing operand');
  let status = 0;
  for (const op of ops) {
    const path = ctx.shell.resolve(op);
    try {
      const st = await ctx.shell.vfs.stat(path);
      if (st.type !== 'dir') throw new VFSError('ENOTDIR', path);
      if ((await ctx.shell.vfs.readdir(path)).length) throw new VFSError('ENOTEMPTY', path);
      ctx.shell.assertWritable(path);
      await ctx.shell.vfs.remove(path);
    } catch (e) {
      ctx.err(`rmdir: failed to remove '${op}': ${errText(e)}\n`);
      status = 1;
    }
  }
  return status;
}

/* ───────────── rm ───────────── */

async function rm(ctx: CommandContext): Promise<number> {
  let o;
  try { o = getopt(ctx.args, 'rRfvd', '', { recursive: 'r', force: 'f', verbose: 'v', dir: 'd' }); } catch (e) { return usageError(ctx, (e as Error).message); }
  const rec = o.flags.has('r') || o.flags.has('R');
  const force = o.flags.has('f');
  if (!o.operands.length) { if (force) return 0; return usageError(ctx, 'missing operand'); }
  let status = 0;
  for (const op of o.operands) {
    const path = ctx.shell.resolve(op);
    if (path === '/' && rec) { ctx.err(`rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n`); status = 1; continue; }
    if (/(^|\/)\.\.?$/.test(op)) { ctx.err(`rm: refusing to remove '.' or '..' directory: skipping '${op}'\n`); status = 1; continue; }
    const st = await tryStat(ctx, path);
    if (!st) { if (!force) { ctx.err(`rm: cannot remove '${op}': No such file or directory\n`); status = 1; } continue; }
    try {
      if (st.type === 'dir') {
        if (!rec) {
          if (!o.flags.has('d')) throw new VFSError('EISDIR', path);
          if ((await ctx.shell.vfs.readdir(path)).length) throw new VFSError('ENOTEMPTY', path);
        }
      }
      ctx.shell.assertWritable(path);
      await ctx.shell.vfs.remove(path, { recursive: rec });
      if (o.flags.has('v')) ctx.out(`removed ${st.type === 'dir' ? 'directory ' : ''}'${op}'\n`);
    } catch (e) {
      ctx.err(`rm: cannot remove '${op}': ${errText(e)}\n`);
      status = 1;
    }
  }
  return status;
}

/* ───────────── touch ───────────── */

async function touch(ctx: CommandContext): Promise<number> {
  const ops = ctx.args.filter((a) => !a.startsWith('-'));
  if (!ops.length) return usageError(ctx, 'missing file operand');
  let status = 0;
  for (const op of ops) {
    const path = ctx.shell.resolve(op);
    try {
      const st = await tryStat(ctx, path);
      if (st?.type === 'dir') continue;
      ctx.shell.assertWritable(path);
      if (!st && !(await ctx.shell.vfs.exists(dirname(path)))) throw new VFSError('ENOENT', path);
      const data = st ? await ctx.shell.vfs.readFile(path) : '';
      await ctx.shell.vfs.writeFile(path, data);
    } catch (e) {
      ctx.err(`touch: cannot touch '${op}': ${errText(e)}\n`);
      status = 1;
    }
  }
  return status;
}

/* ───────────── cp / mv ───────────── */

async function copyTree(ctx: CommandContext, from: string, to: string): Promise<void> {
  const st = await ctx.shell.vfs.stat(from);
  if (st.type === 'file') {
    await ctx.shell.vfs.writeFile(to, await ctx.shell.vfs.readFile(from));
    try { await ctx.shell.vfs.chmod(to, st.mode); } catch { /* best effort */ }
    return;
  }
  if (!(await ctx.shell.vfs.exists(to))) await ctx.shell.vfs.mkdir(to);
  for (const e of await ctx.shell.vfs.readdir(from)) {
    if (ctx.signal.cancelled) return;
    await copyTree(ctx, `${from}/${e.name}`.replace(/^\/\//, '/'), `${to}/${e.name}`.replace(/^\/\//, '/'));
  }
}

async function destinationFor(ctx: CommandContext, srcs: string[], dest: string): Promise<{ dir: boolean } | string> {
  const dst = await tryStat(ctx, ctx.shell.resolve(dest));
  if (srcs.length > 1 && dst?.type !== 'dir') return `target '${dest}' is not a directory`;
  return { dir: dst?.type === 'dir' };
}

async function cp(ctx: CommandContext): Promise<number> {
  let o;
  try { o = getopt(ctx.args, 'rRafvn', '', { recursive: 'r', archive: 'a', force: 'f', verbose: 'v', 'no-clobber': 'n' }); } catch (e) { return usageError(ctx, (e as Error).message); }
  const rec = o.flags.has('r') || o.flags.has('R') || o.flags.has('a');
  if (o.operands.length < 2) return usageError(ctx, o.operands.length ? `missing destination file operand after '${o.operands[0]}'` : 'missing file operand');
  const dest = o.operands[o.operands.length - 1];
  const srcs = o.operands.slice(0, -1);
  const d = await destinationFor(ctx, srcs, dest);
  if (typeof d === 'string') { ctx.err(`cp: ${d}\n`); return 1; }
  let status = 0;
  for (const s of srcs) {
    const from = ctx.shell.resolve(s);
    const to = d.dir ? normalize(`${ctx.shell.resolve(dest)}/${basename(from)}`) : ctx.shell.resolve(dest);
    try {
      const st = await tryStat(ctx, from);
      if (!st) { ctx.err(`cp: cannot stat '${s}': No such file or directory\n`); status = 1; continue; }
      if (st.type === 'dir' && !rec) { ctx.err(`cp: -r not specified; omitting directory '${s}'\n`); status = 1; continue; }
      if (to === from || to.startsWith(from + '/')) { ctx.err(`cp: cannot copy a directory, '${s}', into itself, '${dest}'\n`); status = 1; continue; }
      if (o.flags.has('n') && (await ctx.shell.vfs.exists(to))) continue;
      const target = await tryStat(ctx, to);
      if (target?.type === 'dir' && st.type === 'file') throw new VFSError('EISDIR', to);
      ctx.shell.assertWritable(to);
      if (!(await ctx.shell.vfs.exists(dirname(to)))) throw new VFSError('ENOENT', to);
      await copyTree(ctx, from, to);
      if (o.flags.has('v')) ctx.out(`'${s}' -> '${to}'\n`);
    } catch (e) {
      ctx.err(`cp: cannot create ${errCode(e) === 'EISDIR' ? 'regular file' : 'file'} '${dest}': ${errText(e)}\n`);
      status = 1;
    }
  }
  return status;
}

async function mv(ctx: CommandContext): Promise<number> {
  let o;
  try { o = getopt(ctx.args, 'fvn', '', { force: 'f', verbose: 'v', 'no-clobber': 'n' }); } catch (e) { return usageError(ctx, (e as Error).message); }
  if (o.operands.length < 2) return usageError(ctx, o.operands.length ? `missing destination file operand after '${o.operands[0]}'` : 'missing file operand');
  const dest = o.operands[o.operands.length - 1];
  const srcs = o.operands.slice(0, -1);
  const d = await destinationFor(ctx, srcs, dest);
  if (typeof d === 'string') { ctx.err(`mv: ${d}\n`); return 1; }
  let status = 0;
  for (const s of srcs) {
    const from = ctx.shell.resolve(s);
    const to = d.dir ? normalize(`${ctx.shell.resolve(dest)}/${basename(from)}`) : ctx.shell.resolve(dest);
    try {
      const st = await tryStat(ctx, from);
      if (!st) { ctx.err(`mv: cannot stat '${s}': No such file or directory\n`); status = 1; continue; }
      if (to === from) { ctx.err(`mv: '${s}' and '${dest}' are the same file\n`); status = 1; continue; }
      if (to.startsWith(from + '/')) { ctx.err(`mv: cannot move '${s}' to a subdirectory of itself, '${dest}'\n`); status = 1; continue; }
      const existing = await tryStat(ctx, to);
      if (existing && o.flags.has('n')) continue;
      if (existing?.type === 'dir' && st.type === 'file') throw new VFSError('EISDIR', to);
      ctx.shell.assertWritable(from);
      ctx.shell.assertWritable(to);
      if (existing && existing.type === 'file') await ctx.shell.vfs.remove(to);
      await ctx.shell.vfs.rename(from, to);
      if (o.flags.has('v')) ctx.out(`renamed '${s}' -> '${to}'\n`);
    } catch (e) {
      ctx.err(`mv: cannot move '${s}' to '${dest}': ${errText(e)}\n`);
      status = 1;
    }
  }
  return status;
}

/* ───────────── stat / chmod ───────────── */

function isoDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000000 ${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}

function inodeOf(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 16777619);
  return (h >>> 0) % 900000 + 100000;
}

async function stat(ctx: CommandContext): Promise<number> {
  const ops = ctx.args.filter((a) => !a.startsWith('-'));
  if (!ops.length) return usageError(ctx, 'missing operand');
  let status = 0;
  for (const op of ops) {
    const st = await tryStat(ctx, ctx.shell.resolve(op));
    if (!st) { ctx.err(`stat: cannot statx '${op}': No such file or directory\n`); status = 1; continue; }
    const owner = ownerOf(st.path, ctx.shell.home);
    const uid = owner === 'user' ? 1000 : 0;
    const size = st.type === 'dir' ? 4096 : st.size;
    const blocks = Math.ceil(size / 4096) * 8;
    const oct = (st.mode & 0o7777).toString(8).padStart(4, '0');
    ctx.out(
      `  File: ${safeName(op)}\n` +
      `  Size: ${String(size).padEnd(10)}\tBlocks: ${String(blocks).padEnd(10)} IO Block: 4096   ${st.type === 'dir' ? 'directory' : size ? 'regular file' : 'regular empty file'}\n` +
      `Device: 0,42\tInode: ${String(inodeOf(st.path)).padEnd(11)} Links: ${st.type === 'dir' ? 2 : 1}\n` +
      `Access: (${oct}/${modeString(st.type, st.mode)})  Uid: (${String(uid).padStart(5)}/${owner.padStart(8)})   Gid: (${String(uid).padStart(5)}/${owner.padStart(8)})\n` +
      `Access: ${isoDate(st.mtime)}\n` +
      `Modify: ${isoDate(st.mtime)}\n` +
      `Change: ${isoDate(st.ctime)}\n` +
      ` Birth: ${isoDate(st.ctime)}\n`,
    );
  }
  return status;
}

/** Applies an octal or symbolic (u+x, go-w, a=r, +x) mode. Returns null if invalid. */
export function applyMode(spec: string, mode: number, isDir: boolean): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8);
  let m = mode;
  for (const clause of spec.split(',')) {
    const r = /^([ugoa]*)([+\-=])([rwxX]*)$/.exec(clause);
    if (!r) return null;
    const who = r[1] || 'a';
    let bits = 0;
    for (const p of r[3]) {
      const v = p === 'r' ? 4 : p === 'w' ? 2 : p === 'x' ? 1 : (isDir || mode & 0o111 ? 1 : 0);
      bits |= v;
    }
    let mask = 0;
    let set = 0;
    for (const w of who === 'a' ? 'ugo' : who) {
      const shift = w === 'u' ? 6 : w === 'g' ? 3 : 0;
      mask |= 7 << shift;
      set |= bits << shift;
    }
    if (!r[1] && r[2] === '+') set &= ~0o022 | 0o700; // hofaisal umask 022 for "+w" without who
    if (r[2] === '+') m |= set;
    else if (r[2] === '-') m &= ~set;
    else m = (m & ~mask) | set;
  }
  return m;
}

async function chmod(ctx: CommandContext): Promise<number> {
  const rec = ctx.args.includes('-R');
  const args = ctx.args.filter((a) => a !== '-R' && a !== '-v');
  if (args.length < 2) return usageError(ctx, args.length ? `missing operand after '${args[0]}'` : 'missing operand');
  const [spec, ...ops] = args;
  let status = 0;
  const apply = async (path: string) => {
    const st = await ctx.shell.vfs.stat(path);
    const m = applyMode(spec, st.mode, st.type === 'dir');
    if (m === null) throw new Error(`invalid mode: '${spec}'`);
    ctx.shell.assertWritable(path);
    await ctx.shell.vfs.chmod(path, m);
    if (rec && st.type === 'dir') for await (const e of walk(ctx, path)) await apply(e.path);
  };
  for (const op of ops) {
    try { await apply(ctx.shell.resolve(op)); }
    catch (e) {
      const msg = errCode(e) === 'ENOENT' ? `cannot access '${op}': No such file or directory`
        : errCode(e) === 'EACCES' ? `changing permissions of '${op}': Operation not permitted` : errText(e);
      ctx.err(`chmod: ${msg}\n`);
      status = 1;
      if (/invalid mode/.test(msg)) return 1;
    }
  }
  return status;
}

/* ───────────── tree / find / du / df ───────────── */

async function tree(ctx: CommandContext): Promise<number> {
  let o;
  try { o = getopt(ctx.args, 'adf', 'L'); } catch (e) { return usageError(ctx, (e as Error).message); }
  const max = o.values.has('L') ? Math.max(1, parseInt(o.values.get('L')!, 10) || 1) : Infinity;
  const roots = o.operands.length ? o.operands : ['.'];
  let dirs = 0, files = 0, status = 0;
  for (const r of roots) {
    const rootPath = ctx.shell.resolve(r);
    const st = await tryStat(ctx, rootPath);
    if (!st || st.type !== 'dir') { ctx.out(`${safeName(r)}  [error opening dir]\n`); status = 2; continue; }
    ctx.out(colorName(st, r, ctx.isTTY) + '\n');
    const rec = async (path: string, prefix: string, depth: number) => {
      if (ctx.signal.cancelled) return;
      let entries = await ctx.shell.vfs.readdir(path);
      if (!o.flags.has('a')) entries = entries.filter((e) => !e.name.startsWith('.'));
      if (o.flags.has('d')) entries = entries.filter((e) => e.type === 'dir');
      entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const last = i === entries.length - 1;
        const shown = o.flags.has('f') ? `${r}/${e.path.slice(rootPath.length + 1)}` : e.name;
        ctx.out(`${prefix}${last ? '└── ' : '├── '}${colorName(e, shown, ctx.isTTY)}\n`);
        if (e.type === 'dir') { dirs++; if (depth < max) await rec(e.path, prefix + (last ? '    ' : '│   '), depth + 1); }
        else files++;
      }
    };
    await rec(rootPath, '', 1);
  }
  ctx.out(`\n${dirs} director${dirs === 1 ? 'y' : 'ies'}${o.flags.has('d') ? '' : `, ${files} file${files === 1 ? '' : 's'}`}\n`);
  return status;
}

async function find(ctx: CommandContext): Promise<number> {
  const args = [...ctx.args];
  const roots: string[] = [];
  while (args.length && !args[0].startsWith('-')) roots.push(args.shift()!);
  if (!roots.length) roots.push('.');
  const preds: ((p: string, st: Stat, depth: number) => boolean)[] = [];
  let maxDepth = Infinity;
  let minDepth = 0;
  while (args.length) {
    const a = args.shift()!;
    const need = () => {
      const v = args.shift();
      if (v === undefined) throw new Error(`missing argument to \`${a}'`);
      return v;
    };
    try {
      if (a === '-name' || a === '-iname') {
        const re = globToRegExp(need(), a === '-iname' ? 'i' : '');
        preds.push((_p, st) => re.test(st.name));
      } else if (a === '-type') {
        const t = need();
        if (t !== 'f' && t !== 'd') throw new Error(`Unknown argument to -type: ${t}`);
        preds.push((_p, st) => (t === 'd' ? st.type === 'dir' : st.type === 'file'));
      } else if (a === '-maxdepth') maxDepth = parseInt(need(), 10);
      else if (a === '-mindepth') minDepth = parseInt(need(), 10);
      else if (a === '-print') { /* default */ }
      else throw new Error(`unknown predicate \`${a}'`);
    } catch (e) { ctx.err(`find: ${(e as Error).message}\n`); return 1; }
  }
  let status = 0;
  const match = (p: string, st: Stat, depth: number) => depth >= minDepth && preds.every((fn) => fn(p, st, depth));
  for (const r of roots) {
    const rootPath = ctx.shell.resolve(r);
    const st = await tryStat(ctx, rootPath);
    if (!st) { ctx.err(`find: '${r}': No such file or directory\n`); status = 1; continue; }
    if (match(r, { ...st, name: basename(rootPath) }, 0)) ctx.out(safeName(r) + '\n');
    if (st.type !== 'dir' || maxDepth < 1) continue;
    for await (const e of walk(ctx, rootPath, maxDepth)) {
      const shown = (r.endsWith('/') ? r : r + '/') + e.path.slice(rootPath === '/' ? 1 : rootPath.length + 1);
      if (match(shown, e.st, e.depth)) ctx.out(safeName(shown) + '\n');
    }
  }
  return status;
}

async function du(ctx: CommandContext): Promise<number> {
  let o;
  try { o = getopt(ctx.args, 'shac', '', { summarize: 's', 'human-readable': 'h', all: 'a', total: 'c' }); } catch (e) { return usageError(ctx, (e as Error).message); }
  const fmt = (bytes: number) => (o.flags.has('h') ? human(Math.max(bytes ? 4096 : 0, Math.ceil(bytes / 4096) * 4096)) : String(Math.ceil(bytes / 1024)));
  const ops = o.operands.length ? o.operands : ['.'];
  let status = 0;
  let total = 0;
  for (const op of ops) {
    const path = ctx.shell.resolve(op);
    const st = await tryStat(ctx, path);
    if (!st) { ctx.err(`du: cannot access '${op}': No such file or directory\n`); status = 1; continue; }
    if (!o.flags.has('s') && st.type === 'dir') {
      const sizes = new Map<string, number>();
      const entries: { path: string; st: Stat }[] = [];
      for await (const e of walk(ctx, path)) entries.push(e);
      for (const e of entries) {
        if (e.st.type !== 'file') continue;
        for (let d = dirname(e.path); d.length >= path.length; d = dirname(d)) {
          sizes.set(d, (sizes.get(d) ?? 0) + e.st.size);
          if (d === path || d === '/') break;
        }
        if (o.flags.has('a')) ctx.out(`${fmt(e.st.size)}\t${safeName(op + e.path.slice(path.length))}\n`);
      }
      const dirsList = entries.filter((e) => e.st.type === 'dir').map((e) => e.path).reverse();
      for (const d of dirsList) ctx.out(`${fmt(sizes.get(d) ?? 0)}\t${safeName(op + d.slice(path.length))}\n`);
    }
    const size = await treeSize(ctx, path);
    total += size;
    ctx.out(`${fmt(size)}\t${safeName(op)}\n`);
  }
  if (o.flags.has('c')) ctx.out(`${fmt(total)}\ttotal\n`);
  return status;
}

async function df(ctx: CommandContext): Promise<number> {
  const h = ctx.args.some((a) => /^-.*h/.test(a));
  let quota = 2 * 1024 ** 3;
  let usage = 0;
  try {
    const est = await (globalThis.navigator as Navigator | undefined)?.storage?.estimate?.();
    if (est?.quota) quota = Math.min(est.quota, 64 * 1024 ** 3);
    if (est?.usage) usage = est.usage;
  } catch { /* not available */ }
  if (!usage) { try { usage = await treeSize(ctx, ctx.shell.home); } catch { usage = 0; } }
  const rows: [string, number, number, string][] = [
    ['faisalfs', quota, usage, '/'],
    ['tmpfs', 512 * 1024 ** 2, 0, '/tmp'],
    ['devtmpfs', 4 * 1024 ** 2, 0, '/dev'],
  ];
  const f = (n: number) => (h ? human(n) : String(Math.ceil(n / 1024)));
  const lines = [[`Filesystem`, h ? 'Size' : '1K-blocks', 'Used', 'Avail', 'Use%', 'Mounted on']];
  for (const [fs, size, used, mnt] of rows) {
    lines.push([fs, f(size), f(used), f(size - used), `${Math.ceil((used / size) * 100)}%`, mnt]);
  }
  const widths = lines[0].map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  for (const l of lines) {
    ctx.out(l.map((c, i) => (i === 0 || i === 5 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join(' ').trimEnd() + '\n');
  }
  return 0;
}

/* ───────────── basename / dirname ───────────── */

function basenameCmd(ctx: CommandContext): number {
  if (!ctx.args.length) return usageError(ctx, 'missing operand');
  const [p, suffix] = ctx.args;
  let b = p === '/' ? '/' : p.replace(/\/+$/, '').split('/').pop() ?? '';
  if (suffix && b.endsWith(suffix) && b !== suffix) b = b.slice(0, -suffix.length);
  ctx.out(b + '\n');
  return 0;
}

function dirnameCmd(ctx: CommandContext): number {
  if (!ctx.args.length) return usageError(ctx, 'missing operand');
  for (const p of ctx.args) {
    const t = p.replace(/\/+$/, '');
    if (!t) { ctx.out('/\n'); continue; }
    const i = t.lastIndexOf('/');
    ctx.out((i < 0 ? '.' : i === 0 ? '/' : t.slice(0, i).replace(/\/+$/, '') || '/') + '\n');
  }
  return 0;
}

export const fsCommands: Record<string, CommandSpec> = {
  ls: { run: ls, group: 'files', help: 'list directory contents (-l -a -h -1 -R -t -S -r)' },
  cd: { run: cd, group: 'shell', builtin: true, help: 'change the working directory' },
  pwd: { run: pwd, group: 'shell', builtin: true, help: 'print the working directory' },
  cat: { run: cat, group: 'text', help: 'print files (-n numbers lines)' },
  mkdir: { run: mkdir, group: 'files', help: 'make directories (-p parents)' },
  rmdir: { run: rmdir, group: 'files', help: 'remove empty directories' },
  rm: { run: rm, group: 'files', help: 'remove files or directories (-r -f)' },
  touch: { run: touch, group: 'files', help: 'create a file or update its time' },
  cp: { run: cp, group: 'files', help: 'copy files (-r for directories)' },
  mv: { run: mv, group: 'files', help: 'move / rename files' },
  stat: { run: stat, group: 'files', help: 'display file status' },
  chmod: { run: chmod, group: 'files', help: 'change permissions (755, u+x, go-w; -R)' },
  tree: { run: tree, group: 'files', help: 'list a directory as a tree (-a -d -L n)' },
  find: { run: find, group: 'files', help: 'search for files (-name -iname -type -maxdepth)' },
  du: { run: du, group: 'files', help: 'estimate disk usage (-s -h -a -c)' },
  df: { run: df, group: 'system', help: 'report file system space (-h)' },
  basename: { run: basenameCmd, group: 'text', help: 'strip directory (and suffix) from a path' },
  dirname: { run: dirnameCmd, group: 'text', help: 'strip the last component from a path' },
};

