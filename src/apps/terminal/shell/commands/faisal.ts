import type { CommandContext, CommandSpec } from '../types';
import { C, errText, padEnd, strWidth } from '../util';
import { uptimeText } from './sys';

/**
 * Original Fai$al logo: the brand "$" — an S of two bowls, the vertical stroke,
 * and the rhombus nuqta on top. Columns 12–13 are the stroke; rows 0–1 the dot.
 */
const LOGO = [
  '            /\\',
  '            \\/',
  '         .--||--.',
  "       .'   ||   `.",
  "      /     ||     '",
  '      |     ||',
  '       \\    ||',
  "        '-._||",
  "            ||'-._",
  '            ||    \\',
  '            ||     |',
  '      .     ||     /',
  "       `.   ||   .'",
  "         '--||--'",
  '            ||',
  "            ''",
  '',
  '     F A I $ A L',
];
const BAR_COLS = [12, 13];
/** Brand palette in truecolor: gold, light gold, ivory. */
const RGB = {
  gold: '\x1b[1;38;2;227;182;80m',
  light: '\x1b[1;38;2;240;207;122m',
  ivory: '\x1b[38;2;247;241;227m',
  royal: '\x1b[1;38;2;143;166;224m',
};

function paintLogoLine(line: string, row: number): string {
  let out = '';
  let cur = '';
  for (let col = 0; col < line.length; col++) {
    const ch = line[col];
    let color = RGB.gold;
    if (row <= 1) color = RGB.light;
    else if (row === LOGO.length - 1) color = ch === '$' ? RGB.gold : RGB.ivory;
    else if (BAR_COLS.includes(col)) color = RGB.light;
    if (ch !== ' ' && color !== cur) { out += color; cur = color; }
    out += ch;
  }
  return cur ? out + C.reset : out;
}

export async function readOsRelease(ctx: CommandContext): Promise<Record<string, string>> {
  const info: Record<string, string> = {};
  try {
    const text = await ctx.shell.vfs.readText('/etc/os-release');
    for (const line of text.split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) info[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }
  } catch { /* file missing: fall back below */ }
  return info;
}

function browserName(): string {
  const ua = (globalThis.navigator?.userAgent ?? '') as string;
  const m = /(Firefox|Edg|OPR|Chrome|Safari)\/(\d+)/.exec(ua);
  if (!m) return 'Web browser';
  const name = { Edg: 'Edge', OPR: 'Opera' }[m[1]] ?? m[1];
  return `${name} ${m[2]}`;
}

async function fastfetch(ctx: CommandContext): Promise<number> {
  const os = await readOsRelease(ctx);
  const tty = ctx.isTTY;
  const key = (s: string) => (tty ? `${RGB.gold}${s}${C.reset}` : s);
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  const scr = (globalThis as { screen?: Screen }).screen;
  const title = `${ctx.shell.user}@${ctx.shell.hostname}`;
  let apps = 0;
  try { apps = ctx.shell.host.listApps?.().length ?? 0; } catch { apps = 0; }
  const start = (globalThis as { performance?: Performance }).performance?.timeOrigin ?? ctx.shell.startedAt;

  const info: [string, string][] = [
    ['OS', `${os.PRETTY_NAME ?? os.NAME ?? 'Fai$al OS'} web`],
    ['Host', browserName()],
    ['Kernel', 'Faisal 1.0.0-web.nr1'],
    ['Uptime', uptimeText(start)],
    ['Packages', `${apps} (built-in)`],
    ['Shell', 'bash 5.2 (faisal-sh)'],
    ['Display', scr ? `${scr.width}x${scr.height}` : 'unknown'],
    ['DE', 'Faisal Shell (GNOME-inspired)'],
    ['Terminal', 'faisal-terminal (xterm.js)'],
    ['CPU', `${nav?.hardwareConcurrency ?? 1} logical core(s)`],
    ['Memory', nav?.deviceMemory ? `~${nav.deviceMemory} GiB` : 'unknown'],
    ['Locale', ctx.shell.env.get('LANG') ?? 'en_US.UTF-8'],
  ];
  const right = [
    tty ? `${RGB.royal}${ctx.shell.user}${C.reset}@${RGB.royal}${ctx.shell.hostname}${C.reset}` : title,
    '-'.repeat(title.length),
    ...info.map(([k, v]) => `${key(k)}: ${v}`),
    '',
    tty ? [40, 41, 42, 43, 44, 45, 46, 47].map((c) => `\x1b[${c}m   `).join('') + C.reset : '',
    tty ? [100, 101, 102, 103, 104, 105, 106, 107].map((c) => `\x1b[${c}m   `).join('') + C.reset : '',
  ];
  const logoW = Math.max(...LOGO.map((l) => strWidth(l))) + 3;
  const cols = ctx.shell.host.size?.().cols ?? 80;
  const n = Math.max(LOGO.length, right.length);
  let out = '\n';
  for (let i = 0; i < n; i++) {
    const l = LOGO[i] ?? '';
    if (cols < logoW + 30) { if (right[i] !== undefined) out += right[i] + '\n'; continue; }
    out += padEnd(tty ? paintLogoLine(l, i) : l, logoW) + (right[i] ?? '') + '\n';
  }
  ctx.out(out + '\n');
  return 0;
}

const DNF_USAGE = `usage: dnf [options] COMMAND

List of Main Commands:

list          List installed and available packages
info          Show details about an app
install       Install a package (coming in a later phase)
remove        Remove a package (coming in a later phase)
search        Search packages
upgrade       Upgrade installed packages
`;

function dnf(ctx: CommandContext): number {
  const [sub, ...rest] = ctx.args.filter((a) => !a.startsWith('-') || a === '--help');
  const apps = ctx.shell.host.listApps?.() ?? [];
  const pkg = (id: string) => `${id}.noarch`;
  switch (sub) {
    case undefined:
    case '--help':
    case 'help':
      ctx.out(DNF_USAGE);
      return sub === undefined ? 1 : 0;
    case 'list': {
      const w = Math.max(20, ...apps.map((a) => pkg(a.id).length)) + 2;
      let out = 'Installed Packages\n';
      for (const a of apps) out += `${pkg(a.id).padEnd(w)}${'1.0.0-1.nr1'.padEnd(16)}@faisal-builtin\n`;
      out += 'Available Packages\n(none yet: the Faisal package repository arrives in a later phase)\n';
      ctx.out(out);
      return 0;
    }
    case 'info': {
      const q = rest[0]?.toLowerCase();
      const found = apps.filter((a) => !q || a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
      if (!found.length) { ctx.err('Error: No matching Packages to list\n'); return 1; }
      ctx.out(found.map((a) => `Name         : ${a.id}\nSummary      : ${a.name}\nVersion      : 1.0.0\nRelease      : 1.nr1\nArchitecture : noarch\nRepository   : @faisal-builtin\n`).join('\n'));
      return 0;
    }
    case 'search': {
      const q = (rest[0] ?? '').toLowerCase();
      const found = apps.filter((a) => a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
      if (!found.length) { ctx.out(`No matches found.\n`); return 1; }
      ctx.out(found.map((a) => `${pkg(a.id)} : ${a.name}`).join('\n') + '\n');
      return 0;
    }
    case 'upgrade':
    case 'update':
    case 'check-update':
      ctx.out('Last metadata expiration check: just now.\nDependencies resolved.\nNothing to do.\nComplete!\n');
      return 0;
    case 'install':
    case 'remove':
    case 'erase':
    case 'reinstall':
    case 'downgrade':
      ctx.err(
        `${C.yellow}dnf:${C.reset} Fai$al OS does not have a package repository yet.\n` +
        `Installing and removing packages comes in a later phase; every app is built in for now.\n` +
        `Run 'dnf list' to see what is installed.\n`,
      );
      return 1;
    default:
      ctx.err(`No such command: ${sub}. Please use /usr/bin/dnf --help\n`);
      return 1;
  }
}

async function open(ctx: CommandContext): Promise<number> {
  const ops = ctx.args.filter((a) => !a.startsWith('-'));
  if (!ops.length) { ctx.err('open: missing file operand\n'); return 1; }
  let status = 0;
  for (const op of ops) {
    const path = ctx.shell.resolve(op);
    try {
      const st = await ctx.shell.vfs.stat(path);
      const ok = (await ctx.shell.host.open?.(path, st.type === 'dir')) ?? false;
      if (!ok) { ctx.err(`open: no application knows how to open '${op}'\n`); status = 1; }
    } catch (e) {
      ctx.err(`open: ${op}: ${errText(e)}\n`);
      status = 1;
    }
  }
  return status;
}

function linux(ctx: CommandContext): number {
  if (!ctx.shell.host.switchBackend) { ctx.err('linux: the Linux virtual machine is not available here\n'); return 1; }
  ctx.shell.host.switchBackend('v86');
  return 0;
}

function apt(ctx: CommandContext): number {
  ctx.err(`bash: ${ctx.name}: command not found\nFai$al OS follows the Fedora way: try 'dnf' instead.\n`);
  return 127;
}

export const faisalCommands: Record<string, CommandSpec> = {
  fastfetch: { run: fastfetch, group: 'faisal', help: 'show system information with the Faisal logo' },
  dnf: { run: dnf, group: 'faisal', help: 'package manager (list, info, search; install comes later)' },
  open: { run: open, group: 'faisal', help: 'open a file or folder with its app' },
  linux: { run: linux, group: 'faisal', help: 'boot a real Linux kernel (v86 emulator)' },
  apt: { run: apt, group: 'faisal', help: 'hint: use dnf' },
  'apt-get': { run: apt, group: 'faisal', help: 'hint: use dnf' },
};
