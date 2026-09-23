/**
 * The Faisal shell interpreter: runs parsed scripts against the VFS.
 * Pure TS — no DOM, no xterm — so it can be unit tested with a mock VFS.
 */
import type { VFS } from '../../../kernel/types';
import { VFSError } from '../../../kernel/types';
import { normalize, resolve as resolvePath, dirname } from '../../../kernel/path';
import { parse, type Pipeline, type Script, type SimpleCommand, type Word } from './parser';
import type { CancelSignal, CommandContext, CommandSpec, ShellHost, ShellLike } from './types';
import { errText, globToRegExp, hasGlob, unescapeGlob } from './util';
import { defaultCommands } from './commands';

export interface RunIO {
  out(s: string): void;
  err(s: string): void;
  signal?: CancelSignal;
  isTTY?: boolean;
}

export interface ShellOptions {
  vfs: VFS;
  host?: ShellHost;
  commands?: Record<string, CommandSpec>;
  home?: string;
  user?: string;
  hostname?: string;
  lang?: string;
}

const ALIASES: Record<string, string[]> = {
  ll: ['ls', '-l'],
  la: ['ls', '-a'],
  l: ['ls'],
  'xdg-open': ['open'],
  neofetch: ['fastfetch'],
  printenv: ['env'],
  yum: ['dnf'],
};

const NEVER: CancelSignal = { cancelled: false };

const BRACE_RE = /\{([^{}]*,[^{}]*|-?\d+\.\.-?\d+)\}/;

/** Bash brace expansion on unquoted text: a{b,c}d → abd acd, {1..3} → 1 2 3. */
export function braceExpand(word: Word, depth = 0): Word[] {
  if (depth > 8) return [word];
  const idx = word.findIndex((s) => s.kind === 'lit' && !s.quoted && BRACE_RE.test(s.value));
  if (idx < 0) return [word];
  const seg = word[idx] as { kind: 'lit'; value: string; quoted: boolean };
  const m = BRACE_RE.exec(seg.value)!;
  const before = seg.value.slice(0, m.index);
  const after = seg.value.slice(m.index + m[0].length);
  let alts: string[];
  const range = /^(-?\d+)\.\.(-?\d+)$/.exec(m[1]);
  if (range) {
    const a = parseInt(range[1], 10), b = parseInt(range[2], 10);
    const step = a <= b ? 1 : -1;
    alts = [];
    for (let v = a; alts.length < 10000; v += step) { alts.push(String(v)); if (v === b) break; }
  } else alts = m[1].split(',');
  const out: Word[] = [];
  for (const alt of alts) {
    const w: Word = [...word.slice(0, idx), { kind: 'lit', value: before + alt + after, quoted: false }, ...word.slice(idx + 1)];
    out.push(...braceExpand(w, depth + 1));
  }
  return out;
}

/** Writable areas for the unprivileged "user": inside $HOME and /tmp. */
export function isUserWritable(path: string, home: string): boolean {
  const p = normalize(path);
  return p.startsWith(home + '/') || p.startsWith('/tmp/');
}

export class Shell implements ShellLike {
  cwd: string;
  readonly home: string;
  readonly user: string;
  readonly hostname: string;
  readonly vfs: VFS;
  readonly host: ShellHost;
  readonly startedAt = Date.now();
  env = new Map<string, string>();
  history: string[] = [];
  lastStatus = 0;
  private commands: Record<string, CommandSpec>;
  private depth = 0;

  constructor(opts: ShellOptions) {
    this.vfs = opts.vfs;
    this.host = opts.host ?? {};
    this.commands = opts.commands ?? defaultCommands;
    this.home = opts.home ?? '/home/user';
    this.user = opts.user ?? 'user';
    this.hostname = opts.hostname ?? 'faisal';
    this.cwd = this.home;
    const env: Record<string, string> = {
      HOME: this.home,
      USER: this.user,
      LOGNAME: this.user,
      SHELL: '/bin/bash',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      PWD: this.home,
      HOSTNAME: this.hostname,
      TERM: 'xterm-256color',
      LANG: opts.lang ?? 'en_US.UTF-8',
    };
    for (const [k, v] of Object.entries(env)) this.env.set(k, v);
  }

  /* ─────────────── ShellLike ─────────────── */

  resolve(p: string): string {
    return resolvePath(this.cwd, p, this.home);
  }

  assertWritable(path: string): void {
    if (!isUserWritable(path, this.home)) throw new VFSError('EACCES', normalize(path));
  }

  commandNames(): string[] {
    return [...Object.keys(this.commands), ...Object.keys(ALIASES)].sort();
  }

  isBuiltin(name: string): boolean {
    return !!this.commands[name]?.builtin;
  }

  async runScript(src: string, ctx: CommandContext): Promise<number> {
    if (this.depth > 16) { ctx.err('bash: maximum nesting level exceeded\n'); return 1; }
    this.depth++;
    try {
      return await this.run(src, { out: ctx.out, err: ctx.err, signal: ctx.signal, isTTY: ctx.isTTY });
    } finally { this.depth--; }
  }

  /* ─────────────── Execution ─────────────── */

  /** Returns true when `src` is syntactically unfinished (open quote, trailing |, &&...). */
  static needsMore(src: string): boolean {
    const r = parse(src);
    return !r.ok && r.incomplete;
  }

  async run(src: string, io: RunIO): Promise<number> {
    const r = parse(src);
    if (!r.ok) {
      io.err(`bash: ${r.message}\n`);
      this.lastStatus = 2;
      return 2;
    }
    return this.runScriptAst(r.script, io);
  }

  private async runScriptAst(script: Script, io: RunIO): Promise<number> {
    const signal = io.signal ?? NEVER;
    for (const item of script) {
      if (signal.cancelled) return (this.lastStatus = 130);
      let status = await this.runPipeline(item.first, io);
      this.lastStatus = status;
      for (const { op, pipeline } of item.rest) {
        if (signal.cancelled) return (this.lastStatus = 130);
        if ((op === '&&' && status !== 0) || (op === '||' && status === 0)) continue;
        status = await this.runPipeline(pipeline, io);
        this.lastStatus = status;
      }
      if (this.exited) break;
    }
    return this.lastStatus;
  }

  /** Set by `exit` so that the rest of a script is skipped. */
  exited = false;

  private async runPipeline(pl: Pipeline, io: RunIO): Promise<number> {
    let stdin: string | null = null;
    let status = 0;
    for (let i = 0; i < pl.cmds.length; i++) {
      const last = i === pl.cmds.length - 1;
      const buf: string[] = [];
      const out = last ? io.out : (s: string) => { buf.push(s); };
      status = await this.runSimple(pl.cmds[i], {
        stdin,
        out,
        err: io.err,
        signal: io.signal ?? NEVER,
        isTTY: last && io.isTTY !== false,
        inPipeline: pl.cmds.length > 1,
      });
      stdin = buf.join('');
    }
    return pl.negate ? (status === 0 ? 1 : 0) : status;
  }

  private async runSimple(
    cmd: SimpleCommand,
    io: { stdin: string | null; out(s: string): void; err(s: string): void; signal: CancelSignal; isTTY: boolean; inPipeline: boolean },
  ): Promise<number> {
    // 1. expand
    let argv: string[] = [];
    for (const w of cmd.words) for (const bw of braceExpand(w)) argv.push(...(await this.expandWord(bw)));
    const assigns: [string, string][] = [];
    for (const a of cmd.assigns) assigns.push([a.name, (await this.expandWord(a.value, false)).join(' ')]);

    // 2. redirections
    let stdin = io.stdin;
    let outFile: { path: string; append: boolean } | null = null;
    let errFile: { path: string; append: boolean } | null = null;
    let errToOut = false;
    let bothToFile = false;
    for (const r of cmd.redirs) {
      if (r.op === '2>&1') { errToOut = true; continue; }
      const words = await this.expandWord(r.target!);
      if (words.length !== 1) { io.err(`bash: ${words.join(' ') || "''"}: ambiguous redirect\n`); return 1; }
      const target = words[0];
      const path = target === '/dev/null' ? '/dev/null' : this.resolve(target);
      try {
        if (r.op === '<') {
          if (path === '/dev/null') { stdin = ''; continue; }
          const st = await this.vfs.stat(path);
          if (st.type === 'dir') throw new VFSError('EISDIR', path);
          stdin = await this.vfs.readText(path);
        } else {
          if (path !== '/dev/null') await this.checkWriteTarget(path);
          const spec = { path, append: r.op === '>>' || r.op === '2>>' };
          if (r.op === '>' || r.op === '>>') outFile = spec;
          else if (r.op === '&>') { outFile = spec; bothToFile = true; }
          else errFile = spec;
          // like bash, `>` truncates (creates) the file before the command runs
          if (path !== '/dev/null' && !spec.append) await this.vfs.writeFile(path, '');
          else if (path !== '/dev/null' && !(await this.vfs.exists(path))) await this.vfs.writeFile(path, '');
        }
      } catch (e) {
        io.err(`bash: ${target}: ${errText(e)}\n`);
        return 1;
      }
    }

    // 3. assignments without a command set shell variables
    if (!argv.length) {
      for (const [k, v] of assigns) this.env.set(k, v);
      return 0;
    }

    // 4. aliases
    const alias = ALIASES[argv[0]];
    if (alias && !this.commands[argv[0]]) argv = [...alias, ...argv.slice(1)];

    const outBuf: string[] = [];
    const errBuf: string[] = [];
    const signal = io.signal;
    const guard = (fn: (s: string) => void) => (s: string) => { if (!signal.cancelled) fn(s); };
    const out = outFile ? (s: string) => { outBuf.push(s); } : guard(io.out);
    let err = errFile ? (s: string) => { errBuf.push(s); } : guard(io.err);
    if (errToOut || bothToFile) err = out;

    const saved = new Map<string, string | undefined>();
    for (const [k, v] of assigns) { saved.set(k, this.env.get(k)); this.env.set(k, v); }

    let status: number;
    try {
      status = await this.exec(argv, {
        args: argv.slice(1),
        name: argv[0],
        stdin,
        out,
        err,
        isTTY: io.isTTY && !outFile,
        signal,
        shell: this,
      });
    } finally {
      for (const [k, v] of saved) { if (v === undefined) this.env.delete(k); else this.env.set(k, v); }
    }

    // 5. flush redirected output
    const flush = async (f: { path: string; append: boolean } | null, data: string[]) => {
      if (!f || f.path === '/dev/null') return;
      try {
        const prev = f.append && (await this.vfs.exists(f.path)) ? await this.vfs.readText(f.path) : '';
        await this.vfs.writeFile(f.path, prev + data.join(''));
      } catch (e) {
        io.err(`bash: ${f.path}: ${errText(e)}\n`);
        status = 1;
      }
    };
    await flush(outFile, outBuf);
    if (errFile && !errToOut) await flush(errFile, errBuf);
    return status;
  }

  private async checkWriteTarget(path: string): Promise<void> {
    if (await this.vfs.exists(path)) {
      const st = await this.vfs.stat(path);
      if (st.type === 'dir') throw new VFSError('EISDIR', path);
    } else {
      const parent = dirname(path);
      if (!(await this.vfs.exists(parent))) throw new VFSError('ENOENT', path);
    }
    this.assertWritable(path);
  }

  private async exec(argv: string[], ctx: CommandContext): Promise<number> {
    const name = argv[0];
    const spec = this.commands[name];
    if (spec) {
      try {
        return await spec.run(ctx);
      } catch (e) {
        ctx.err(`${name}: ${errText(e)}\n`);
        return 1;
      }
    }
    if (name.includes('/')) return this.execFile(name, ctx);
    ctx.err(`bash: ${name}: command not found\n`);
    return 127;
  }

  /** `./script.sh` — runs executable text files as Faisal shell scripts. */
  private async execFile(name: string, ctx: CommandContext): Promise<number> {
    const path = this.resolve(name);
    try {
      const st = await this.vfs.stat(path);
      if (st.type === 'dir') { ctx.err(`bash: ${name}: Is a directory\n`); return 126; }
      if (!(st.mode & 0o111)) { ctx.err(`bash: ${name}: Permission denied\n`); return 126; }
      const src = await this.vfs.readText(path);
      return await this.runScript(src, ctx);
    } catch (e) {
      ctx.err(`bash: ${name}: ${errText(e)}\n`);
      return 127;
    }
  }

  /* ─────────────── Expansion ─────────────── */

  private varValue(name: string): string {
    switch (name) {
      case '?': return String(this.lastStatus);
      case '$': return '4242';
      case '0': return 'bash';
      case '#': return '0';
      case '@': case '*': case '!': return '';
      case 'PWD': return this.cwd;
      case 'RANDOM': return String(Math.floor(Math.random() * 32768));
      default: return this.env.get(name) ?? '';
    }
  }

  /**
   * Expands one word into zero or more fields: ~, $VAR (with field splitting
   * when unquoted) and pathname globs.
   */
  async expandWord(word: Word, split = true): Promise<string[]> {
    // each field: text (unescaped) + pattern (glob chars from quotes are escaped)
    type Field = { text: string; pattern: string; glob: boolean; quoted: boolean };
    const fields: Field[] = [];
    let cur: Field | null = null;
    const ensure = () => (cur ??= { text: '', pattern: '', glob: false, quoted: false });
    const escGlob = (s: string) => s.replace(/[*?[\]\\]/g, '\\$&');

    for (const seg of word) {
      if (seg.kind === 'tilde') {
        const f = ensure(); f.text += this.home; f.pattern += escGlob(this.home); f.quoted = true;
      } else if (seg.kind === 'lit') {
        const f = ensure();
        f.text += seg.value;
        if (seg.quoted) { f.pattern += escGlob(seg.value); f.quoted = true; }
        else { f.pattern += seg.value; if (hasGlob(seg.value)) f.glob = true; }
      } else {
        const val = this.varValue(seg.name);
        if (seg.quoted || !split) {
          const f = ensure(); f.text += val; f.pattern += escGlob(val); f.quoted = true;
        } else {
          const parts = val.split(/[ \t\n]+/);
          parts.forEach((part, idx) => {
            if (idx > 0) { if (cur) fields.push(cur); cur = null; }
            if (part === '') return;
            const f = ensure(); f.text += part; f.pattern += part; if (hasGlob(part)) f.glob = true;
          });
        }
      }
    }
    if (cur) fields.push(cur);

    const result: string[] = [];
    for (const f of fields) {
      if (!f.text && !f.quoted) continue;
      if (f.glob && split) {
        const matches = await this.glob(f.pattern);
        if (matches.length) { result.push(...matches); continue; }
        result.push(unescapeGlob(f.pattern));
        continue;
      }
      result.push(f.text);
    }
    return result;
  }

  private async glob(pattern: string): Promise<string[]> {
    const absolute = pattern.startsWith('/');
    const segs = pattern.split('/').filter((s, i) => s !== '' || i === 0);
    let bases: { shown: string; real: string }[] = [{ shown: absolute ? '/' : '', real: absolute ? '/' : this.cwd }];
    const parts = absolute ? segs.slice(1) : segs;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const isLast = i === parts.length - 1;
      const next: typeof bases = [];
      for (const b of bases) {
        if (!hasGlob(seg)) {
          const lit = unescapeGlob(seg);
          const real = normalize(`${b.real}/${lit}`);
          if (isLast ? await this.vfs.exists(real) : await this.isDir(real)) {
            next.push({ shown: b.shown + (b.shown && !b.shown.endsWith('/') ? '/' : '') + lit, real });
          }
          continue;
        }
        let entries;
        try { entries = await this.vfs.readdir(b.real); } catch { continue; }
        const re = globToRegExp(seg);
        const showHidden = seg.startsWith('.') || seg.startsWith('\\.');
        for (const e of entries.map((x) => x).sort((a, c) => (a.name < c.name ? -1 : 1))) {
          if (e.name.startsWith('.') && !showHidden) continue;
          if (!re.test(e.name)) continue;
          if (!isLast && e.type !== 'dir') continue;
          next.push({ shown: b.shown + (b.shown && !b.shown.endsWith('/') ? '/' : '') + e.name, real: normalize(`${b.real}/${e.name}`) });
        }
      }
      bases = next;
      if (!bases.length) break;
    }
    return bases.map((b) => b.shown).filter(Boolean);
  }

  private async isDir(p: string): Promise<boolean> {
    try { return (await this.vfs.stat(p)).type === 'dir'; } catch { return false; }
  }
}
