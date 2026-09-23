/**
 * Faisal AI — system tools (أدوات النظام).
 *
 * Lets the agent act inside the OS: files, apps and windows, terminal commands and
 * appearance settings. Reading is free; every change to the system asks the user first
 * through the ConfirmFn handed to execute(). Results are plain English text for the model;
 * labels and confirmation cards follow the OS language (Arabic first-class).
 */
import type { AppManifest, RunningApp, SystemAPI } from '../../kernel/types';
import { HOME } from '../../kernel/types';
import { basename, dirname, join, resolve } from '../../kernel/path';
import { Shell } from '../terminal/shell/shell';
import { ACCENTS, type ThemeMode } from '../../shell/appearance';
import type { ConfirmFn, ToolBox, ToolCall, ToolPreview, ToolSpec } from './agent';

/* ───────────────────────────── Shell ───────────────────────────── */

export interface ToolShell {
  run(
    cmd: string,
    io: { out(s: string): void; err(s: string): void; isTTY?: boolean; signal?: { readonly cancelled: boolean } },
  ): Promise<number>;
}

export interface ToolBoxOptions {
  /** Injected shell (tests); by default one headless Shell per toolbox so `cd` persists. */
  shell?: ToolShell;
}

const FILES_APP = 'org.faisal.Files';
const MAX_OUTPUT = 20000;
const MAX_READ = 20000;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_VISITED = 5000;
const MAX_LIST = 500;
const COMMAND_TIMEOUT_MS = 30000;

/* ─────────────────────── Read-only command check ─────────────────────── */

const READ_ONLY_COMMANDS = new Set([
  'ls', 'll', 'la', 'cat', 'head', 'tail', 'grep', 'find', 'wc', 'pwd', 'echo', 'printf', 'date',
  'whoami', 'uname', 'hostname', 'id', 'tree', 'du', 'df', 'stat', 'file', 'which', 'type', 'env',
  'history', 'help', 'man', 'fastfetch', 'neofetch', 'sort', 'uniq', 'cut', 'tr', 'basename',
  'dirname', 'realpath', 'readlink', 'true', 'false', 'cal', 'uptime', 'free', 'ps', 'seq', 'nl',
  'rev', 'diff', 'cmp', 'sha256sum', 'md5sum', 'base64', 'cd',
]);

/** Flags that turn an otherwise read-only command into one that writes or runs things. */
const WRITING_FLAGS: Record<string, RegExp> = {
  find: /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/,
  sort: /^(-o.*|--output(=.*)?)$/,
  history: /^-[a-z]*[cdwrna]/,
  hostname: /^[^-]/, // `hostname NAME` sets it
  date: /^(-s|--set)/,
};

/**
 * True only when every command of the line is known to be read-only (no redirection,
 * command substitution, tee, xargs or in-place edits). Unsure → false: confirmation is
 * the safe default.
 */
export function isReadOnlyCommand(cmd: string): boolean {
  if (typeof cmd !== 'string') return false;
  const line = cmd.trim();
  if (!line) return false;
  // Redirection, substitution, backticks, process substitution: anywhere, even quoted.
  if (/[>`]|\$\(|<\(/.test(line)) return false;
  if (/\btee\b|\bxargs\b|\bsed\s+(-\S*\s+)*-i/.test(line)) return false;
  const segments = line.split(/\|\||&&|\||;|\n/);
  for (const raw of segments) {
    const seg = raw.trim();
    if (!seg) return false;
    if (seg.includes('&')) return false; // background jobs, &>, stray operators
    const words = seg.split(/\s+/);
    const name = words[0];
    if (!READ_ONLY_COMMANDS.has(name)) return false;
    const bad = WRITING_FLAGS[name];
    if (bad && words.slice(1).some((w) => bad.test(w.replace(/^['"]|['"]$/g, '')))) return false;
  }
  return true;
}

/* ─────────────────────────── Localization ─────────────────────────── */

type Lang = 'ar' | 'en';
const LRI = '\u2066';
const PDI = '\u2069';

/** Isolates a path/command so it renders left-to-right inside Arabic text. */
const iso = (lang: Lang, s: string) => (lang === 'ar' ? `${LRI}${s}${PDI}` : s);

const THEME_NAMES: Record<Lang, Record<string, string>> = {
  en: { light: 'light', dark: 'dark', system: 'system' },
  ar: { light: 'الفاتح', dark: 'الداكن', system: 'حسب النظام' },
};

type Args = Record<string, unknown>;
const s = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : String(v));
const clip = (v: string, n = 120) => (v.length > n ? v.slice(0, n - 1) + '…' : v);

const LABELS: Record<string, (a: Args, l: Lang, p: (x: unknown) => string) => string> = {
  list_directory: (a, l, p) => (l === 'ar' ? `يعرض محتويات ${p(a.path ?? HOME)}` : `Listing ${p(a.path ?? HOME)}`),
  read_file: (a, l, p) => (l === 'ar' ? `يقرأ الملف ${p(a.path)}` : `Reading ${p(a.path)}`),
  file_info: (a, l, p) => (l === 'ar' ? `يفحص ${p(a.path)}` : `Inspecting ${p(a.path)}`),
  search_files: (a, l, p) => (l === 'ar'
    ? `يبحث عن «${iso(l, clip(s(a.query), 60))}» في ${p(a.path ?? HOME)}`
    : `Searching for “${clip(s(a.query), 60)}” in ${p(a.path ?? HOME)}`),
  list_apps: (_a, l) => (l === 'ar' ? 'يعرض التطبيقات المثبتة' : 'Listing installed apps'),
  list_windows: (_a, l) => (l === 'ar' ? 'يعرض النوافذ المفتوحة' : 'Listing open windows'),
  open_app: (a, l, p) => {
    const app = iso(l, s(a.app_id));
    if (a.path !== undefined) return l === 'ar' ? `يفتح ${app} مع ${p(a.path)}` : `Opening ${app} with ${p(a.path)}`;
    return l === 'ar' ? `يفتح ${app}` : `Opening ${app}`;
  },
  focus_window: (a, l) => (l === 'ar' ? `ينتقل إلى النافذة ${iso(l, s(a.window_id))}` : `Switching to window ${s(a.window_id)}`),
  run_command: (a, l) => (l === 'ar' ? `يشغّل الأمر: ${iso(l, clip(s(a.command)))}` : `Running: ${clip(s(a.command))}`),
  notify: (a, l) => (l === 'ar' ? `يرسل إشعاراً: ${clip(s(a.title), 60)}` : `Sending a notification: ${clip(s(a.title), 60)}`),
  write_file: (a, l, p) => (a.append === true
    ? (l === 'ar' ? `يضيف إلى الملف ${p(a.path)}` : `Appending to ${p(a.path)}`)
    : (l === 'ar' ? `يكتب الملف ${p(a.path)}` : `Writing ${p(a.path)}`)),
  create_folder: (a, l, p) => (l === 'ar' ? `ينشئ المجلد ${p(a.path)}` : `Creating folder ${p(a.path)}`),
  move: (a, l, p) => (l === 'ar' ? `ينقل ${p(a.from)} إلى ${p(a.to)}` : `Moving ${p(a.from)} to ${p(a.to)}`),
  copy: (a, l, p) => (l === 'ar' ? `ينسخ ${p(a.from)} إلى ${p(a.to)}` : `Copying ${p(a.from)} to ${p(a.to)}`),
  delete: (a, l, p) => (l === 'ar' ? `يحذف ${p(a.path)}` : `Deleting ${p(a.path)}`),
  close_window: (a, l) => (l === 'ar' ? `يغلق النافذة ${iso(l, s(a.window_id))}` : `Closing window ${s(a.window_id)}`),
  set_theme: (a, l) => {
    const mode = THEME_NAMES[l][s(a.mode)] ?? s(a.mode);
    return l === 'ar' ? `يغيّر المظهر إلى ${mode}` : `Switching to the ${mode} theme`;
  },
  set_accent: (a, l) => (l === 'ar' ? `يغيّر لون التمييز إلى ${iso(l, s(a.accent_id))}` : `Changing the accent colour to ${s(a.accent_id)}`),
};

const CONFIRM_TITLES: Record<string, Record<Lang, string>> = {
  write_file: { en: 'Write this file?', ar: 'كتابة هذا الملف؟' },
  overwrite: { en: 'Replace an existing file?', ar: 'استبدال ملف موجود؟' },
  append: { en: 'Add to this file?', ar: 'الإضافة إلى هذا الملف؟' },
  create_folder: { en: 'Create this folder?', ar: 'إنشاء هذا المجلد؟' },
  move: { en: 'Move this item?', ar: 'نقل هذا العنصر؟' },
  copy: { en: 'Copy this item?', ar: 'نسخ هذا العنصر؟' },
  delete: { en: 'Delete permanently?', ar: 'حذف نهائي؟' },
  close_window: { en: 'Close this window?', ar: 'إغلاق هذه النافذة؟' },
  set_theme: { en: 'Change the theme?', ar: 'تغيير المظهر؟' },
  set_accent: { en: 'Change the accent colour?', ar: 'تغيير لون التمييز؟' },
  run_command: { en: 'Run this command?', ar: 'تشغيل هذا الأمر؟' },
  generic: { en: 'Allow this action?', ar: 'السماح بهذا الإجراء؟' },
};

const DETAIL = {
  path: { en: 'Path', ar: 'المسار' },
  size: { en: 'Size', ar: 'الحجم' },
  from: { en: 'From', ar: 'من' },
  to: { en: 'To', ar: 'إلى' },
  command: { en: 'Command', ar: 'الأمر' },
  window: { en: 'Window', ar: 'النافذة' },
  overwrites: { en: 'This replaces the existing file.', ar: 'سيستبدل هذا الملف الموجود.' },
  appends: { en: 'The text is added at the end of the existing file.', ar: 'سيُضاف النص إلى نهاية الملف الموجود.' },
  newFile: { en: 'A new file will be created.', ar: 'سيُنشأ ملف جديد.' },
  folderItems: { en: 'This folder and its {n} item(s) will be deleted.', ar: 'سيُحذف هذا المجلد مع {n} عنصر بداخله.' },
  folder: { en: 'This folder and everything in it will be deleted.', ar: 'سيُحذف هذا المجلد وكل ما بداخله.' },
  unsaved: { en: 'Unsaved work in it may be lost.', ar: 'قد يضيع أي عمل غير محفوظ فيها.' },
  cantUndo: { en: 'This cannot be undone.', ar: 'لا يمكن التراجع عن ذلك.' },
  invalid: { en: 'invalid arguments', ar: 'وسائط غير صالحة' },
  unknown: { en: 'Unknown tool', ar: 'أداة غير معروفة' },
} satisfies Record<string, Record<Lang, string>>;

/* ─────────────────────────── Tool specs ─────────────────────────── */

const PATH_NOTE = 'Absolute, or relative to /home/user.';
const str = (description: string) => ({ type: 'string', description });

const SPECS: ToolSpec[] = [
  {
    name: 'list_directory',
    description: `List a folder's entries (type, size, name). Read-only. ${PATH_NOTE}`,
    parameters: { type: 'object', properties: { path: str(`Folder path, default /home/user. ${PATH_NOTE}`) } },
  },
  {
    name: 'read_file',
    description: `Read a text file. Read-only. Long files are truncated. ${PATH_NOTE}`,
    parameters: {
      type: 'object',
      properties: { path: str(`File path. ${PATH_NOTE}`), max_chars: { type: 'integer', description: 'Max characters to return (default 20000).' } },
      required: ['path'],
    },
  },
  {
    name: 'file_info',
    description: `Show a file's or folder's details (type, size, permissions, dates). Read-only. ${PATH_NOTE}`,
    parameters: { type: 'object', properties: { path: str(`Path. ${PATH_NOTE}`) }, required: ['path'] },
  },
  {
    name: 'search_files',
    description: 'Find files and folders whose name contains the query (case-insensitive), searching recursively. Read-only.',
    parameters: {
      type: 'object',
      properties: { query: str('Part of the name to look for.'), path: str(`Folder to search in, default /home/user. ${PATH_NOTE}`) },
      required: ['query'],
    },
  },
  {
    name: 'list_apps',
    description: 'List the installed apps with their ids, names and descriptions. Read-only.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_windows',
    description: 'List the open windows with their window ids and apps. Read-only.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'open_app',
    description: `Open an app by id (see list_apps), optionally with a file or folder to open in it. ${PATH_NOTE}`,
    parameters: {
      type: 'object',
      properties: { app_id: str('App id, e.g. org.faisal.Files.'), path: str(`Optional file or folder to open. ${PATH_NOTE}`) },
      required: ['app_id'],
    },
  },
  {
    name: 'focus_window',
    description: 'Bring an open window to the front (ids from list_windows).',
    parameters: { type: 'object', properties: { window_id: str('Window id.') }, required: ['window_id'] },
  },
  {
    name: 'run_command',
    description:
      'Run a command line in the Faisal OS terminal (bash-like shell with coreutils; cd persists between calls; starts in /home/user). ' +
      'Returns stdout+stderr and the exit status. Read-only commands run directly; anything else asks the user first.',
    parameters: { type: 'object', properties: { command: str('The command line to run.') }, required: ['command'] },
  },
  {
    name: 'notify',
    description: 'Show a desktop notification to the user.',
    parameters: { type: 'object', properties: { title: str('Notification title.'), body: str('Optional body text.') }, required: ['title'] },
  },
  {
    name: 'write_file',
    description: `Create or replace a text file (or append to it). The parent folder must exist (use create_folder). Asks the user first. ${PATH_NOTE}`,
    parameters: {
      type: 'object',
      properties: {
        path: str(`File path. ${PATH_NOTE}`),
        content: str('Full text content to write.'),
        append: { type: 'boolean', description: 'Add to the end instead of replacing (default false).' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'create_folder',
    description: `Create a folder, including missing parent folders. Asks the user first. ${PATH_NOTE}`,
    parameters: { type: 'object', properties: { path: str(`Folder path. ${PATH_NOTE}`) }, required: ['path'] },
  },
  {
    name: 'move',
    description: `Move or rename a file or folder. Never overwrites; if "to" is an existing folder the item goes inside it. Asks the user first. ${PATH_NOTE}`,
    parameters: { type: 'object', properties: { from: str('Source path.'), to: str('Destination path.') }, required: ['from', 'to'] },
  },
  {
    name: 'copy',
    description: `Copy a file or folder (recursively). Never overwrites; if "to" is an existing folder the copy goes inside it. Asks the user first. ${PATH_NOTE}`,
    parameters: { type: 'object', properties: { from: str('Source path.'), to: str('Destination path.') }, required: ['from', 'to'] },
  },
  {
    name: 'delete',
    description: `Permanently delete a file or folder (folders recursively). Asks the user first. ${PATH_NOTE}`,
    parameters: { type: 'object', properties: { path: str(`Path to delete. ${PATH_NOTE}`) }, required: ['path'] },
  },
  {
    name: 'close_window',
    description: 'Close an open window (ids from list_windows). Asks the user first; unsaved work may be lost.',
    parameters: { type: 'object', properties: { window_id: str('Window id.') }, required: ['window_id'] },
  },
  {
    name: 'set_theme',
    description: 'Switch the system theme. Asks the user first.',
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['light', 'dark', 'system'], description: 'light, dark, or follow the system.' } },
      required: ['mode'],
    },
  },
  {
    name: 'set_accent',
    description: 'Change the system accent colour. Asks the user first.',
    parameters: {
      type: 'object',
      properties: { accent_id: { type: 'string', enum: ACCENTS.map((a) => a.id), description: 'Accent colour id ("faisal" is the brand gold).' } },
      required: ['accent_id'],
    },
  },
];

const SPEC_BY_NAME = new Map(SPECS.map((t) => [t.name, t]));

/** Tools that change the system and always ask first (run_command only when not read-only). */
const MUTATING = new Set(['write_file', 'create_folder', 'move', 'copy', 'delete', 'close_window', 'set_theme', 'set_accent', 'run_command']);

/* ─────────────────────────── Helpers ─────────────────────────── */

class ToolError extends Error {}

function parseArgs(raw: string): Args | null {
  try {
    const v: unknown = JSON.parse(raw && raw.trim() ? raw : '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Args) : null;
  } catch { return null; }
}

function resolvePath(p: string): string {
  if (p.includes('\0')) throw new ToolError('Error: the path contains a NUL character.');
  return resolve(HOME, p.trim());
}

const errCode = (e: unknown): string | undefined => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
};

const HINTS: Record<string, string> = {
  ENOENT: 'no such file or folder',
  EEXIST: 'already exists',
  ENOTDIR: 'not a folder',
  EISDIR: 'is a folder',
  ENOTEMPTY: 'folder is not empty',
  EACCES: 'permission denied (outside the areas this app may access; writes are limited to /home/user and /tmp)',
  EINVAL: 'invalid argument',
};

function errorText(e: unknown): string {
  if (e instanceof ToolError) return e.message;
  const code = errCode(e);
  const path = (e as { path?: unknown } | null)?.path;
  if (code && HINTS[code]) return `Error ${code}: ${HINTS[code]}${typeof path === 'string' ? ` — ${path}` : ''}`;
  const msg = e instanceof Error ? e.message : String(e);
  return `Error: ${msg}`;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (t: string) => t.replace(ANSI_RE, '');

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[… truncated: showing ${max} of ${text.length} characters]`;
}

const PROTECTED = new Set(['/', '/home', HOME]);

/* ─────────────────────────── The toolbox ─────────────────────────── */

export function createToolBox(sys: SystemAPI, opts: ToolBoxOptions = {}): ToolBox {
  const { vfs } = sys;
  const lang = (): Lang => {
    try { return sys.locale() === 'ar' ? 'ar' : 'en'; } catch { return 'en'; }
  };
  const appName = (m: AppManifest) => m.name?.[lang()] ?? m.name?.en ?? m.id;

  const shell: ToolShell = opts.shell ?? new Shell({
    vfs,
    home: HOME,
    host: {
      async open(path, isDir) {
        if (isDir) { await sys.apps.launch(FILES_APP, [path]); return true; }
        const m = sys.apps.appForFile(path);
        if (!m) return false;
        await sys.apps.launch(m.id, [path]);
        return true;
      },
      listApps: () => sys.apps.list().map((m) => ({ id: m.id, name: appName(m) })),
    },
  });

  /* ── Labels & confirmation cards ── */

  const pathText = (l: Lang) => (x: unknown) => {
    if (typeof x !== 'string' || !x) return iso(l, '?');
    try { return iso(l, clip(resolvePath(x), 160)); } catch { return iso(l, '?'); }
  };

  function labelFor(name: string, args: Args, l: Lang): string {
    const fn = LABELS[name];
    if (!fn) return `${DETAIL.unknown[l]}: ${iso(l, name)}`;
    return fn(args, l, pathText(l));
  }

  /** Baseline confirmation (sync, from the arguments alone). execute() may refine it. */
  function baseConfirm(name: string, args: Args, l: Lang): ToolPreview['confirm'] {
    const p = pathText(l);
    const T = (k: string) => (CONFIRM_TITLES[k] ?? CONFIRM_TITLES.generic)[l];
    switch (name) {
      case 'write_file': {
        const bytes = new TextEncoder().encode(s(args.content)).length;
        return {
          title: T(args.append === true ? 'append' : 'write_file'),
          detail: `${DETAIL.path[l]}: ${p(args.path)}\n${DETAIL.size[l]}: ${iso(l, formatSize(bytes))}`,
          danger: false,
        };
      }
      case 'create_folder':
        return { title: T(name), detail: `${DETAIL.path[l]}: ${p(args.path)}`, danger: false };
      case 'move':
      case 'copy':
        return { title: T(name), detail: `${DETAIL.from[l]}: ${p(args.from)}\n${DETAIL.to[l]}: ${p(args.to)}`, danger: false };
      case 'delete':
        return { title: T(name), detail: `${DETAIL.path[l]}: ${p(args.path)}\n${DETAIL.cantUndo[l]}`, danger: true };
      case 'close_window':
        return { title: T(name), detail: `${DETAIL.window[l]}: ${iso(l, s(args.window_id))}\n${DETAIL.unsaved[l]}`, danger: false };
      case 'set_theme':
      case 'set_accent':
        return { title: T(name), detail: labelFor(name, args, l), danger: false };
      case 'run_command': {
        const cmd = s(args.command);
        if (isReadOnlyCommand(cmd)) return undefined;
        return { title: T(name), detail: `${DETAIL.command[l]}: ${iso(l, cmd)}`, danger: /\brm\b|\bmv\b|>/.test(cmd) };
      }
      default:
        return undefined;
    }
  }

  function preview(call: ToolCall): ToolPreview {
    try {
      const l = lang();
      const name = typeof call?.name === 'string' ? call.name : '?';
      const args = parseArgs(typeof call?.arguments === 'string' ? call.arguments : '');
      if (!args) {
        const label = `${iso(l, name)} (${DETAIL.invalid[l]})`;
        if (!MUTATING.has(name)) return { label };
        return { label, confirm: { title: CONFIRM_TITLES.generic[l], detail: `${iso(l, name)}: ${iso(l, clip(s(call.arguments), 300))}`, danger: true } };
      }
      const label = labelFor(name, args, l);
      const confirm = baseConfirm(name, args, l);
      return confirm ? { label, confirm } : { label };
    } catch {
      return { label: String(call?.name ?? 'tool'), confirm: { title: 'Allow this action?', detail: String(call?.name ?? ''), danger: true } };
    }
  }

  /* ── Argument access ── */

  function need(args: Args, key: string): string {
    const v = args[key];
    if (typeof v !== 'string' || !v.trim()) throw new ToolError(`Error: missing required argument "${key}" (a non-empty string).`);
    return v;
  }
  function optStr(args: Args, key: string): string | undefined {
    const v = args[key];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new ToolError(`Error: argument "${key}" must be a string.`);
    return v;
  }

  /* ── Confirmation ── */

  async function ask(name: string, args: Args, confirm: ConfirmFn, request?: ToolPreview['confirm']): Promise<string | null> {
    const req = request ?? baseConfirm(name, args, lang()) ?? { title: CONFIRM_TITLES.generic[lang()], detail: labelFor(name, args, lang()), danger: true };
    let ok = false;
    try { ok = await confirm(req); } catch { ok = false; }
    return ok ? null : `The user declined: ${labelFor(name, args, 'en')}. Do not retry unless they ask.`;
  }

  /* ── Filesystem helpers ── */

  async function statOrNull(path: string) {
    try { return await vfs.stat(path); } catch (e) {
      if (errCode(e) === 'ENOENT') return null;
      throw e;
    }
  }

  async function countEntries(dir: string, limit = 10000): Promise<number | undefined> {
    let n = 0;
    const walk = async (d: string): Promise<boolean> => {
      for (const e of await vfs.readdir(d)) {
        if (++n > limit) return false;
        if (e.type === 'dir' && !(await walk(join(d, e.name)))) return false;
      }
      return true;
    };
    try { return (await walk(dir)) ? n : undefined; } catch { return undefined; }
  }

  async function copyRec(src: string, dst: string): Promise<number> {
    const st = await vfs.stat(src);
    if (st.type === 'file') { await vfs.writeFile(dst, await vfs.readFile(src)); return 1; }
    await vfs.mkdir(dst);
    let n = 1;
    for (const e of await vfs.readdir(src)) n += await copyRec(join(src, e.name), join(dst, e.name));
    return n;
  }

  /** Resolves a move/copy target: into an existing folder, never over an existing item. */
  async function target(from: string, to: string): Promise<string> {
    const st = await statOrNull(to);
    let dest = to;
    if (st?.type === 'dir') dest = join(to, basename(from));
    else if (st) throw new ToolError(`Error EEXIST: ${to} already exists. Choose another name or delete it first.`);
    if (dest === from) throw new ToolError('Error: source and destination are the same.');
    if (dest.startsWith(from + '/')) throw new ToolError('Error: cannot put a folder inside itself.');
    if (await statOrNull(dest)) throw new ToolError(`Error EEXIST: ${dest} already exists. Choose another name or delete it first.`);
    const parent = await statOrNull(dirname(dest));
    if (!parent) throw new ToolError(`Error ENOENT: the folder ${dirname(dest)} does not exist (use create_folder first).`);
    return dest;
  }

  const runningApps = (): RunningApp[] | null => {
    try { return sys.apps.running(); } catch { return null; }
  };

  /* ── Tool implementations ── */

  type Impl = (args: Args, confirm: ConfirmFn) => Promise<string>;

  const impls: Record<string, Impl> = {
    async list_directory(args) {
      const path = resolvePath(optStr(args, 'path') ?? HOME);
      const st = await vfs.stat(path);
      if (st.type !== 'dir') return `Error ENOTDIR: ${path} is a file, not a folder. Use read_file or file_info.`;
      const entries = (await vfs.readdir(path)).sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
      if (!entries.length) return `${path} is empty.`;
      const lines = entries.slice(0, MAX_LIST).map((e) =>
        e.type === 'dir' ? `dir   ${'-'.padStart(9)}  ${e.name}/` : `file  ${formatSize(e.size).padStart(9)}  ${e.name}`);
      const more = entries.length > MAX_LIST ? `\n[… ${entries.length - MAX_LIST} more entries not shown]` : '';
      return `${path} (${entries.length} entries):\n${lines.join('\n')}${more}`;
    },

    async read_file(args) {
      const path = resolvePath(need(args, 'path'));
      const maxRaw = args.max_chars;
      let max = MAX_READ;
      if (maxRaw !== undefined && maxRaw !== null) {
        if (typeof maxRaw !== 'number' || !Number.isFinite(maxRaw) || maxRaw < 1) return 'Error: "max_chars" must be a positive number.';
        max = Math.floor(maxRaw);
      }
      const st = await vfs.stat(path);
      if (st.type === 'dir') return `Error EISDIR: ${path} is a folder. Use list_directory.`;
      const bytes = await vfs.readFile(path);
      if (bytes.subarray(0, 8192).includes(0)) return `${path} looks like a binary file (${formatSize(bytes.length)}); it cannot be shown as text.`;
      const text = new TextDecoder().decode(bytes);
      if (!text) return `${path} is empty.`;
      if (text.length <= max) return text;
      return `${text.slice(0, max)}\n[… truncated: showing ${max} of ${text.length} characters]`;
    },

    async file_info(args) {
      const path = resolvePath(need(args, 'path'));
      const st = await vfs.stat(path);
      const lines = [
        `path: ${st.path}`,
        `type: ${st.type === 'dir' ? 'folder' : 'file'}`,
        ...(st.type === 'file' ? [`size: ${st.size} bytes (${formatSize(st.size)})`] : []),
        `mode: ${(st.mode & 0o7777).toString(8).padStart(4, '0')}`,
        `modified: ${new Date(st.mtime).toISOString()}`,
        `created: ${new Date(st.ctime).toISOString()}`,
      ];
      if (st.type === 'file') {
        const app = sys.apps.appForFile(path);
        if (app) lines.push(`opens with: ${app.id} (${appName(app)})`);
      }
      return lines.join('\n');
    },

    async search_files(args) {
      const query = need(args, 'query').toLowerCase();
      const root = resolvePath(optStr(args, 'path') ?? HOME);
      const st = await vfs.stat(root);
      if (st.type !== 'dir') return `Error ENOTDIR: ${root} is not a folder.`;
      const results: string[] = [];
      let visited = 0;
      let skipped = 0;
      let stopped = false;
      const queue = [root];
      outer: while (queue.length) {
        const dir = queue.shift()!;
        let entries;
        try { entries = await vfs.readdir(dir); } catch { skipped++; continue; }
        for (const e of entries) {
          if (++visited > MAX_SEARCH_VISITED) { stopped = true; break outer; }
          const full = join(dir, e.name);
          if (e.name.toLowerCase().includes(query)) {
            results.push(e.type === 'dir' ? `${full}/` : full);
            if (results.length >= MAX_SEARCH_RESULTS) { stopped = true; break outer; }
          }
          if (e.type === 'dir') queue.push(full);
        }
      }
      const notes: string[] = [];
      if (results.length >= MAX_SEARCH_RESULTS) notes.push(`[stopped at ${MAX_SEARCH_RESULTS} results; narrow the query or path]`);
      else if (stopped) notes.push(`[stopped after visiting ${MAX_SEARCH_VISITED} entries; search a smaller folder for complete results]`);
      if (skipped) notes.push(`[${skipped} folder(s) could not be read]`);
      const head = results.length
        ? `${results.length} match(es) for "${args.query}" under ${root}:\n${results.join('\n')}`
        : `No matches for "${args.query}" under ${root}.`;
      return [head, ...notes].join('\n');
    },

    async list_apps() {
      const apps = sys.apps.list();
      if (!apps.length) return 'No apps are installed.';
      return apps.map((m) => {
        const d = m.description?.[lang()] ?? m.description?.en;
        return `${m.id} — ${appName(m)}${d ? `: ${d}` : ''}`;
      }).join('\n');
    },

    async list_windows() {
      const focusedId = (() => { try { return sys.wm.focused()?.id; } catch { return undefined; } })();
      const minimized = (id: string) => { try { return sys.wm.isMinimized(id); } catch { return false; } };
      const names = new Map(sys.apps.catalog().map((m) => [m.id, appName(m)]));
      const own = sys.wm.list().map((w) => ({ windowId: w.id, appId: w.appId }));
      const all = runningApps() ?? own;
      // Stacking order where the window manager knows it (bottom → top), then the rest.
      const order = new Map(own.map((w, i) => [w.windowId, i]));
      const sorted = [...all].sort((a, b) => (order.get(a.windowId) ?? -1) - (order.get(b.windowId) ?? -1));
      if (!sorted.length) return 'No windows are open.';
      return `Open windows (${sorted.length}):\n` + sorted.map((w) => {
        const flags = [minimized(w.windowId) && 'minimized', w.windowId === focusedId && 'focused'].filter(Boolean);
        return `${w.windowId}  ${w.appId} (${names.get(w.appId) ?? w.appId})${flags.length ? `  [${flags.join(', ')}]` : ''}`;
      }).join('\n');
    },

    async open_app(args) {
      const appId = need(args, 'app_id').trim();
      const rawPath = optStr(args, 'path');
      const m = sys.apps.list().find((a) => a.id === appId);
      if (!m) {
        const known = sys.apps.catalog().find((a) => a.id === appId);
        return known
          ? `Error: ${appId} is not installed. Ask the user to install it from the Store.`
          : `Error: unknown app id "${appId}". Call list_apps to see the installed apps.`;
      }
      const launchArgs: string[] = [];
      if (rawPath) {
        const path = resolvePath(rawPath);
        await vfs.stat(path); // ENOENT → readable error
        launchArgs.push(path);
      }
      const win = await sys.apps.launch(appId, launchArgs);
      return `Opened ${appName(m)} (${appId})${launchArgs.length ? ` with ${launchArgs[0]}` : ''}${win ? ` in window ${win.id}` : ''}.`;
    },

    async focus_window(args) {
      const id = need(args, 'window_id').trim();
      const h = sys.wm.get(id);
      if (h) { h.focus(); return `Focused window ${id} (${h.appId}).`; }
      const r = runningApps()?.find((w) => w.windowId === id);
      if (!r) return `Error: no open window with id "${id}". Call list_windows.`;
      const m = sys.apps.list().find((a) => a.id === r.appId);
      if (m?.singleInstance) { await sys.apps.launch(r.appId); return `Brought ${appName(m)} (window ${id}) to the front.`; }
      return `Error: window ${id} (${r.appId}) belongs to another app and cannot be focused from here. The user can click it in the taskbar.`;
    },

    async notify(args) {
      const title = need(args, 'title');
      const body = optStr(args, 'body');
      sys.notify(title, body);
      return 'Notification shown.';
    },

    async write_file(args, confirm) {
      const path = resolvePath(need(args, 'path'));
      const content = args.content;
      if (typeof content !== 'string') return 'Error: missing required argument "content" (a string).';
      if (args.append !== undefined && typeof args.append !== 'boolean') return 'Error: argument "append" must be true or false.';
      const append = args.append === true;
      if (PROTECTED.has(path)) return `Error EISDIR: ${path} is a folder.`;
      const parent = await statOrNull(dirname(path));
      if (!parent) return `Error ENOENT: the folder ${dirname(path)} does not exist. Create it first with create_folder.`;
      if (parent.type !== 'dir') return `Error ENOTDIR: ${dirname(path)} is a file, not a folder.`;
      const existing = await statOrNull(path);
      if (existing?.type === 'dir') return `Error EISDIR: ${path} is a folder.`;
      const l = lang();
      const base = baseConfirm('write_file', args, l)!;
      const note = existing ? (append ? DETAIL.appends[l] : DETAIL.overwrites[l]) : DETAIL.newFile[l];
      const declined = await ask('write_file', args, confirm, {
        title: existing && !append ? CONFIRM_TITLES.overwrite[l] : base.title,
        detail: `${base.detail}\n${note}`,
        danger: !!existing && !append,
      });
      if (declined) return declined;
      const data = append && existing ? (await vfs.readText(path)) + content : content;
      await vfs.writeFile(path, data);
      const bytes = new TextEncoder().encode(content).length;
      return `${append && existing ? 'Appended' : existing ? 'Replaced' : 'Created'} ${path} (${append && existing ? '+' : ''}${formatSize(bytes)}).`;
    },

    async create_folder(args, confirm) {
      const path = resolvePath(need(args, 'path'));
      const st = await statOrNull(path);
      if (st?.type === 'dir') return `${path} already exists.`;
      if (st) return `Error EEXIST: ${path} is an existing file.`;
      const declined = await ask('create_folder', args, confirm);
      if (declined) return declined;
      await vfs.mkdir(path, { recursive: true });
      return `Created folder ${path}.`;
    },

    async move(args, confirm) {
      const from = resolvePath(need(args, 'from'));
      const to = resolvePath(need(args, 'to'));
      if (PROTECTED.has(from)) return `Error: refusing to move ${from}.`;
      await vfs.stat(from);
      const dest = await target(from, to);
      const l = lang();
      const declined = await ask('move', args, confirm, {
        title: CONFIRM_TITLES.move[l],
        detail: `${DETAIL.from[l]}: ${iso(l, from)}\n${DETAIL.to[l]}: ${iso(l, dest)}`,
        danger: false,
      });
      if (declined) return declined;
      await vfs.rename(from, dest);
      return `Moved ${from} to ${dest}.`;
    },

    async copy(args, confirm) {
      const from = resolvePath(need(args, 'from'));
      const to = resolvePath(need(args, 'to'));
      const st = await vfs.stat(from);
      const dest = await target(from, to);
      const l = lang();
      const declined = await ask('copy', args, confirm, {
        title: CONFIRM_TITLES.copy[l],
        detail: `${DETAIL.from[l]}: ${iso(l, from)}\n${DETAIL.to[l]}: ${iso(l, dest)}`,
        danger: false,
      });
      if (declined) return declined;
      const n = await copyRec(from, dest);
      return st.type === 'dir' ? `Copied folder ${from} to ${dest} (${n} item(s)).` : `Copied ${from} to ${dest}.`;
    },

    async delete(args, confirm) {
      const path = resolvePath(need(args, 'path'));
      if (PROTECTED.has(path)) return `Error: refusing to delete ${path}; it is a protected system folder.`;
      const st = await vfs.stat(path);
      const l = lang();
      let detail = `${DETAIL.path[l]}: ${iso(l, path)}`;
      if (st.type === 'dir') {
        const n = await countEntries(path);
        detail += `\n${n === undefined ? DETAIL.folder[l] : DETAIL.folderItems[l].replace('{n}', String(n))}`;
      } else {
        detail += `\n${DETAIL.size[l]}: ${iso(l, formatSize(st.size))}`;
      }
      detail += `\n${DETAIL.cantUndo[l]}`;
      const declined = await ask('delete', args, confirm, { title: CONFIRM_TITLES.delete[l], detail, danger: true });
      if (declined) return declined;
      await vfs.remove(path, { recursive: true });
      return `Deleted ${st.type === 'dir' ? 'folder ' : ''}${path}.`;
    },

    async close_window(args, confirm) {
      const id = need(args, 'window_id').trim();
      const r = runningApps()?.find((w) => w.windowId === id);
      const own = sys.wm.get(id);
      if (!r && !own) return `Error: no open window with id "${id}". Call list_windows.`;
      const declined = await ask('close_window', args, confirm);
      if (declined) return declined;
      try { sys.apps.closeWindow(id); } catch (e) {
        if (!own) throw e;
        own.close();
      }
      return `Closed window ${id} (${r?.appId ?? own?.appId}).`;
    },

    async set_theme(args, confirm) {
      const mode = need(args, 'mode') as ThemeMode;
      if (!['light', 'dark', 'system'].includes(mode)) return 'Error: "mode" must be one of light, dark, system.';
      const declined = await ask('set_theme', args, confirm);
      if (declined) return declined;
      sys.settings.set('theme', mode);
      return `Theme set to ${mode}.`;
    },

    async set_accent(args, confirm) {
      const id = need(args, 'accent_id');
      if (!ACCENTS.some((a) => a.id === id)) return `Error: unknown accent "${id}". Use one of: ${ACCENTS.map((a) => a.id).join(', ')}.`;
      const declined = await ask('set_accent', args, confirm);
      if (declined) return declined;
      sys.settings.set('accent', id);
      return `Accent colour set to ${id}.`;
    },

    async run_command(args, confirm) {
      const command = need(args, 'command');
      if (!isReadOnlyCommand(command)) {
        const declined = await ask('run_command', args, confirm);
        if (declined) return declined;
      }
      let output = '';
      const sink = (t: string) => { if (output.length <= MAX_OUTPUT * 2) output += t; };
      const signal = { cancelled: false };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((res) => {
        timer = setTimeout(() => { signal.cancelled = true; res('timeout'); }, COMMAND_TIMEOUT_MS);
      });
      try {
        const status = await Promise.race([shell.run(command, { out: sink, err: sink, isTTY: false, signal }), timeout]);
        const text = cap(stripAnsi(output).replace(/\r\n?/g, '\n'), MAX_OUTPUT);
        const body = text.trimEnd() ? `${text.trimEnd()}\n` : '';
        if (status === 'timeout') return `${body}[timed out after ${COMMAND_TIMEOUT_MS / 1000}s]`;
        return `${body}[exit status ${status}]`;
      } finally { clearTimeout(timer); }
    },
  };

  async function execute(call: ToolCall, confirm: ConfirmFn): Promise<string> {
    try {
      const name = typeof call?.name === 'string' ? call.name : '';
      const impl = Object.prototype.hasOwnProperty.call(impls, name) ? impls[name] : undefined;
      if (!impl || !SPEC_BY_NAME.has(name)) {
        return `Error: unknown tool "${name}". Available tools: ${SPECS.map((t) => t.name).join(', ')}.`;
      }
      const args = parseArgs(typeof call.arguments === 'string' ? call.arguments : '');
      if (!args) return `Error: the arguments for ${name} are not a valid JSON object. Call it again with valid JSON.`;
      return await impl(args, confirm);
    } catch (e) {
      return errorText(e);
    }
  }

  return { specs: SPECS, preview, execute };
}

