import type { CommandContext, CommandSpec } from '../types';
import { C, DAYS, MONTHS, MONTHS_LONG, getopt, strftime, tzName } from '../util';
import { usageError } from './common';

function whoami(ctx: CommandContext): number { ctx.out(ctx.shell.user + '\n'); return 0; }

function id(ctx: CommandContext): number {
  const u = ctx.shell.user;
  if (ctx.args.includes('-u')) { ctx.out('1000\n'); return 0; }
  if (ctx.args.includes('-un') || ctx.args.includes('-nu')) { ctx.out(u + '\n'); return 0; }
  ctx.out(`uid=1000(${u}) gid=1000(${u}) groups=1000(${u}) context=unconfined_u:unconfined_r:unconfined_t:s0\n`);
  return 0;
}

function hostname(ctx: CommandContext): number { ctx.out(ctx.shell.hostname + '\n'); return 0; }

function uname(ctx: CommandContext): number {
  let o;
  try { o = getopt(ctx.args, 'asnrvmpio', '', { all: 'a' }); } catch (e) { return usageError(ctx, (e as Error).message); }
  const f = o.flags;
  const fields: [string, string][] = [
    ['s', 'Faisal'],
    ['n', ctx.shell.hostname],
    ['r', '1.0.0-web.nr1'],
    ['v', '#1 SMP PREEMPT_DYNAMIC (browser sandbox)'],
    ['m', 'wasm32'],
    ['p', 'unknown'],
    ['i', 'unknown'],
    ['o', 'Fai$al OS'],
  ];
  const all = f.has('a');
  let sel = fields.filter(([k]) => all ? !['p', 'i'].includes(k) : f.has(k));
  if (!sel.length) sel = [fields[0]];
  ctx.out(sel.map(([, v]) => v).join(' ') + '\n');
  return 0;
}

function date(ctx: CommandContext): number {
  const d = new Date();
  const u = ctx.args.includes('-u') || ctx.args.includes('--utc');
  const fmt = ctx.args.find((a) => a.startsWith('+'));
  const dd = u ? new Date(d.getTime() + d.getTimezoneOffset() * 60000) : d;
  if (fmt) { ctx.out(strftime(fmt.slice(1), dd) + '\n'); return 0; }
  const p = (n: number) => String(n).padStart(2, '0');
  ctx.out(`${DAYS[dd.getDay()]} ${MONTHS[dd.getMonth()]} ${String(dd.getDate()).padStart(2, ' ')} ${p(dd.getHours())}:${p(dd.getMinutes())}:${p(dd.getSeconds())} ${u ? 'UTC' : tzName(d)} ${dd.getFullYear()}\n`);
  return 0;
}

export function uptimeText(startedAt: number): string {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  const days = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days} day${days > 1 ? 's' : ''}`);
  if (h) parts.push(`${h} hour${h > 1 ? 's' : ''}`);
  parts.push(`${m} min${m === 1 ? '' : 's'}`);
  return parts.join(', ');
}

function bootTime(ctx: CommandContext): number {
  const perf = (globalThis as { performance?: Performance }).performance;
  return perf?.timeOrigin ? Math.min(perf.timeOrigin, ctx.shell.startedAt) : ctx.shell.startedAt;
}

function uptime(ctx: CommandContext): number {
  const start = bootTime(ctx);
  if (ctx.args.includes('-p')) { ctx.out(`up ${uptimeText(start)}\n`); return 0; }
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const secs = Math.floor((Date.now() - start) / 1000);
  const up = secs < 3600 ? `${Math.floor(secs / 60)} min` : `${Math.floor(secs / 3600)}:${p(Math.floor((secs % 3600) / 60))}`;
  ctx.out(` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} up ${up},  1 user,  load average: 0.08, 0.03, 0.01\n`);
  return 0;
}

function clear(ctx: CommandContext): number {
  if (ctx.shell.host.clear) ctx.shell.host.clear();
  else ctx.out('\x1b[H\x1b[2J\x1b[3J');
  return 0;
}

async function history(ctx: CommandContext): Promise<number> {
  const h = ctx.shell.history;
  if (ctx.args[0] === '-c') { h.length = 0; return 0; }
  const n = ctx.args[0] ? parseInt(ctx.args[0], 10) : h.length;
  if (Number.isNaN(n)) { ctx.err(`bash: history: ${ctx.args[0]}: numeric argument required\n`); return 1; }
  const start = Math.max(0, h.length - n);
  let out = '';
  for (let i = start; i < h.length; i++) out += `${String(i + 1).padStart(5)}  ${h[i]}\n`;
  ctx.out(out);
  return 0;
}

function env(ctx: CommandContext): number {
  if (ctx.args.length && ctx.name === 'printenv') {
    let st = 0;
    for (const a of ctx.args) { const v = ctx.shell.env.get(a); if (v === undefined) st = 1; else ctx.out(v + '\n'); }
    return st;
  }
  const e = new Map(ctx.shell.env);
  e.set('PWD', ctx.shell.cwd);
  ctx.out([...e].map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return 0;
}

function exportCmd(ctx: CommandContext): number {
  const args = ctx.args.filter((a) => a !== '-p' && a !== '-n');
  if (!args.length) {
    ctx.out([...ctx.shell.env].map(([k, v]) => `declare -x ${k}="${v.replace(/(["\\$`])/g, '\\$1')}"`).join('\n') + '\n');
    return 0;
  }
  let st = 0;
  for (const a of args) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/s.exec(a);
    if (!m) { ctx.err(`bash: export: \`${a}': not a valid identifier\n`); st = 1; continue; }
    if (m[2] !== undefined) ctx.shell.env.set(m[1], m[2]);
    else if (!ctx.shell.env.has(m[1])) ctx.shell.env.set(m[1], '');
  }
  return st;
}

function unset(ctx: CommandContext): number {
  for (const a of ctx.args) if (!a.startsWith('-')) ctx.shell.env.delete(a);
  return 0;
}

function which(ctx: CommandContext): number {
  if (!ctx.args.length) return 1;
  let st = 0;
  const names = new Set(ctx.shell.commandNames());
  for (const a of ctx.args) {
    if (a.startsWith('-')) continue;
    if (!names.has(a)) { ctx.err(`which: no ${a} in (${ctx.shell.env.get('PATH') ?? ''})\n`); st = 1; continue; }
    ctx.out(ctx.shell.isBuiltin(a) && ['cd', 'export', 'unset', 'history', 'exit', 'source', '.', 'type', 'alias'].includes(a) ? `${a}: shell built-in command\n` : `/usr/bin/${a}\n`);
  }
  return st;
}

function type(ctx: CommandContext): number {
  let st = 0;
  const names = new Set(ctx.shell.commandNames());
  for (const a of ctx.args) {
    if (!names.has(a)) { ctx.err(`bash: type: ${a}: not found\n`); st = 1; continue; }
    ctx.out(ctx.shell.isBuiltin(a) ? `${a} is a shell builtin\n` : `${a} is /usr/bin/${a}\n`);
  }
  return st;
}

async function sleep(ctx: CommandContext): Promise<number> {
  if (!ctx.args.length) return usageError(ctx, 'missing operand');
  let ms = 0;
  for (const a of ctx.args) {
    const m = /^(\d*\.?\d+)([smhd]?)$/.exec(a);
    if (!m) { ctx.err(`sleep: invalid time interval '${a}'\n`); return 1; }
    ms += parseFloat(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2]] * 1000;
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ctx.signal.cancelled) return 130;
    await new Promise((r) => setTimeout(r, Math.min(100, end - Date.now())));
  }
  return 0;
}

function cal(ctx: CommandContext): number {
  const now = new Date();
  const nums = ctx.args.filter((a) => /^\d+$/.test(a)).map(Number);
  let month = now.getMonth();
  let year = now.getFullYear();
  if (nums.length === 2) { month = nums[0] - 1; year = nums[1]; }
  else if (nums.length === 1) { year = nums[0]; month = -1; }
  if (month < -1 || month > 11 || year < 1 || year > 9999) { ctx.err('cal: illegal month value: use 1-12\n'); return 1; }
  const render = (m: number, y: number, withYear: boolean): string[] => {
    const title = withYear ? `${MONTHS_LONG[m]} ${y}` : MONTHS_LONG[m];
    const pad = Math.floor((20 - title.length) / 2);
    const lines = [(' '.repeat(pad) + title).padEnd(20), 'Su Mo Tu We Th Fr Sa'];
    const first = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    let row = '   '.repeat(first);
    for (let d = 1; d <= days; d++) {
      const today = ctx.isTTY && y === now.getFullYear() && m === now.getMonth() && d === now.getDate();
      const cell = String(d).padStart(2);
      row += (today ? C.inverse + cell + C.reset : cell) + ((first + d) % 7 === 0 ? '' : ' ');
      if ((first + d) % 7 === 0) { lines.push(row); row = ''; }
    }
    if (row) lines.push(row.replace(/ $/, ''));
    while (lines.length < 8) lines.push('');
    return lines;
  };
  if (month >= 0) { ctx.out(render(month, year, true).join('\n').trimEnd() + '\n\n'); return 0; }
  let out = `${' '.repeat(29)}${year}\n\n`;
  for (let q = 0; q < 4; q++) {
    const blocks = [0, 1, 2].map((i) => render(q * 3 + i, year, false));
    for (let l = 0; l < 8; l++) {
      out += blocks.map((b) => {
        const s = b[l] ?? '';
        const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
        return s + ' '.repeat(Math.max(0, 20 - visible.length));
      }).join('  ').trimEnd() + '\n';
    }
  }
  ctx.out(out);
  return 0;
}

function exit(ctx: CommandContext): number {
  const code = ctx.args[0] ? parseInt(ctx.args[0], 10) & 255 : 0;
  (ctx.shell as unknown as { exited: boolean }).exited = true;
  ctx.shell.host.exit?.();
  return code;
}

function sudo(ctx: CommandContext): number {
  ctx.err(
    `${C.yellow}sudo:${C.reset} Fai$al OS runs every app, including this terminal, as the unprivileged user '${ctx.shell.user}'.\n` +
    `There is no root account in this browser sandbox, so nothing can be run with elevated rights.\n` +
    `You can freely change files in ~ (${ctx.shell.home}) and /tmp.\n` +
    `Tip: type 'linux' to boot a real Linux VM where you are root inside the VM.\n`,
  );
  return 1;
}

async function source(ctx: CommandContext): Promise<number> {
  const [file] = ctx.args;
  if (!file) {
    if (ctx.name === 'sh' || ctx.name === 'bash') {
      if (ctx.stdin !== null) return ctx.shell.runScript(ctx.stdin, ctx);
      ctx.err(`${ctx.name}: interactive sub-shells are not supported; you are already in bash\n`);
      return 1;
    }
    ctx.err(`bash: ${ctx.name}: filename argument required\n`);
    return 2;
  }
  if (file === '-c' && (ctx.name === 'sh' || ctx.name === 'bash')) return ctx.shell.runScript(ctx.args[1] ?? '', ctx);
  const path = ctx.shell.resolve(file);
  let src: string;
  try { src = await ctx.shell.vfs.readText(path); }
  catch { ctx.err(`bash: ${file}: No such file or directory\n`); return 1; }
  return ctx.shell.runScript(src, ctx);
}

function trueCmd(): number { return 0; }
function falseCmd(): number { return 1; }

export const sysCommands: Record<string, CommandSpec> = {
  whoami: { run: whoami, group: 'system', help: 'print the current user name' },
  id: { run: id, group: 'system', help: 'print user and group ids' },
  hostname: { run: hostname, group: 'system', help: 'show the system host name' },
  uname: { run: uname, group: 'system', help: 'print system information (-a)' },
  date: { run: date, group: 'system', help: 'print the date (+FORMAT, -u)' },
  uptime: { run: uptime, group: 'system', help: 'how long the system has been running (-p)' },
  clear: { run: clear, group: 'shell', help: 'clear the terminal screen (Ctrl+L)' },
  history: { run: history, group: 'shell', builtin: true, help: 'show command history (-c clears)' },
  env: { run: env, group: 'shell', help: 'print the environment' },
  export: { run: exportCmd, group: 'shell', builtin: true, help: 'set environment variables (VAR=value)' },
  unset: { run: unset, group: 'shell', builtin: true, help: 'remove variables' },
  which: { run: which, group: 'shell', help: 'locate a command' },
  type: { run: type, group: 'shell', builtin: true, help: 'describe a command' },
  true: { run: trueCmd, group: 'shell', builtin: true, help: 'do nothing, successfully' },
  false: { run: falseCmd, group: 'shell', builtin: true, help: 'do nothing, unsuccessfully' },
  sleep: { run: sleep, group: 'shell', help: 'delay for a time (1, 0.5, 2m)' },
  cal: { run: cal, group: 'system', help: 'display a calendar (cal [[month] year])' },
  exit: { run: exit, group: 'shell', builtin: true, help: 'close the terminal' },
  sudo: { run: sudo, group: 'system', help: 'why there is no root here' },
  su: { run: sudo, group: 'system', help: 'why there is no root here' },
  source: { run: source, group: 'shell', builtin: true, help: 'run a script in the current shell' },
  '.': { run: source, group: 'shell', builtin: true, help: 'same as source' },
  sh: { run: source, group: 'shell', help: 'run a shell script (sh file, sh -c "cmd")' },
  bash: { run: source, group: 'shell', help: 'run a shell script (bash file, bash -c "cmd")' },
};
