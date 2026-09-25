/**
 * Save as / Export — the one dialog the whole suite shares (نافذة «حفظ باسم» الموحّدة).
 *
 * Office, PDF and Photo used to answer "where do I save this?" three different ways: Office had
 * no Save as at all, PDF asked the owner to TYPE a path, and Photo had its own export sheet with
 * an input box for the folder and a "replace" checkbox. All three now open this module, so the
 * rules that protect the owner's files are written once:
 *
 *  • nothing is ever written outside `/home/user` — the folder walk cannot leave it;
 *  • replacing a file keeps EXACTLY one backup, `<name>.bak`, overwritten every time;
 *  • a cancelled or failed save writes nothing at all — the overwrite question is asked BEFORE
 *    the first byte is written, and the bytes are encoded before that;
 *  • after a write the file is read back and compared, and only then does the dialog report
 *    "saved" (acceptance G10).
 *
 * The pure half of the module (name sanitising, format decision, target planning, uniqueness,
 * folder listing) is free of the DOM and covered by `save-as.test.ts`; the DOM half adds the
 * dialog on top of it. Every visible string comes from `./strings` in Arabic and English.
 */
import { HOME, VFSError, type Stat } from '../kernel/types';
import { t } from '../kernel/i18n';
import { join, normalize } from '../kernel/path';
import { pushEscapeLayer } from './esc';
import { shellConfirm } from './dialog';
import { renderIcon } from './icon';
import './strings';

/* ─────────────────────────────── pure policy ─────────────────────────────── */

export const BACKUP_SUFFIX = '.bak';

/** The only place a save may land. */
export function withinHome(path: string): boolean {
  const p = normalize(path);
  return p === HOME || p.startsWith(`${HOME}/`);
}

/** A folder this dialog may write into, normalised, or null when the path is not usable. */
export function usableFolder(dir: string | null | undefined): string | null {
  if (!dir) return null;
  const p = normalize(dir);
  return withinHome(p) ? p : null;
}

/**
 * A file name that is safe on every platform the OS runs on: no path separators, no control
 * characters, no leading dots (a hidden name in a save dialog is a bug, not a feature) and no
 * trailing dot or space (Windows refuses to create those). Returns '' when nothing is left.
 */
export function sanitizeName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .replace(/[. ]+$/g, '');
}

/** `report.docx` → `docx`; `report` → ''. */
export function extensionOfName(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** `report.docx` → `report`. */
export function stemOfName(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export interface SaveFormat {
  /** Stable id handed to the app's `encode`, e.g. 'png'. */
  value: string;
  /** Shown in the picker, already localised by the app. */
  label: string;
  /** Extension WITHOUT the dot, e.g. 'png'. */
  ext: string;
  /** MIME type used by "Download to my device". */
  mime: string;
}

export function formatById(id: string | null | undefined, formats: readonly SaveFormat[]): SaveFormat | null {
  if (!id) return null;
  return formats.find((f) => f.value === id) ?? null;
}

/** The format a typed name implies through its extension, or null when it has none we know. */
export function formatForName(name: string, formats: readonly SaveFormat[]): SaveFormat | null {
  const ext = extensionOfName(sanitizeName(name));
  if (!ext) return null;
  return formats.find((f) => f.ext.toLowerCase() === ext) ?? null;
}

/**
 * Which format the bytes are encoded in: the name the owner typed wins (typing `a.jpg` in the
 * PNG app really means JPEG), otherwise the picker, otherwise the only format on offer.
 */
export function effectiveFormat(
  name: string, picked: SaveFormat | null, formats: readonly SaveFormat[],
): SaveFormat | null {
  return formatForName(name, formats) ?? picked ?? formats[0] ?? null;
}

export type TargetError = 'out-of-home' | 'no-name' | 'reserved-name' | 'no-format';

export interface TargetRequest {
  dir: string;
  /** The name as typed: with or without an extension. */
  name: string;
  format: SaveFormat | null;
  /** The names of everything already in `dir` (files and folders). */
  existing: readonly string[];
}

export interface TargetPlan {
  ok: true;
  dir: string;
  /** File name with its extension. */
  fileName: string;
  stem: string;
  ext: string;
  path: string;
  /** True when a file with this name is already there: replacing it needs a yes/no. */
  exists: boolean;
  /** The single backup that replaces the old bytes, or null when there is nothing to back up. */
  backup: string | null;
}

export type TargetResult = TargetPlan | { ok: false; error: TargetError };

/**
 * The whole "where will this go?" rule: the folder must be inside home, the name must be usable,
 * a typed extension wins over the picker, and one `.bak` is planned when the target exists.
 */
export function planTarget(req: TargetRequest): TargetResult {
  const dir = normalize(req.dir);
  if (!withinHome(dir)) return { ok: false, error: 'out-of-home' };
  const name = sanitizeName(req.name);
  if (!name) return { ok: false, error: 'no-name' };
  if (name.toLowerCase().endsWith(BACKUP_SUFFIX)) return { ok: false, error: 'reserved-name' };

  const typed = extensionOfName(name);
  const ext = typed || req.format?.ext.toLowerCase() || '';
  if (!ext) return { ok: false, error: 'no-format' };

  const fileName = typed ? name : `${name}.${ext}`;
  const path = join(dir, fileName);
  const lowered = fileName.toLowerCase();
  const exists = req.existing.some((entry) => entry.toLowerCase() === lowered);
  return {
    ok: true, dir, fileName, stem: stemOfName(fileName), ext, path,
    exists, backup: exists ? `${path}${BACKUP_SUFFIX}` : null,
  };
}

/**
 * `report.docx` → `report (2).docx`: the first free name in that folder, so "keep both" can
 * never overwrite the file the owner was trying to protect.
 */
export function uniqueName(fileName: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(fileName.toLowerCase())) return fileName;
  const stem = stemOfName(fileName);
  const ext = extensionOfName(fileName);
  const suffix = ext ? `.${ext}` : '';
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem} (${n})${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${Date.now()})${suffix}`;
}

export interface Crumb {
  label: string;
  path: string;
  /** The first crumb (the home folder) is drawn with an icon and the localised "Home". */
  home: boolean;
}

/**
 * The breadcrumb from `/home/user` down to `dir` — never above home, because the dialog cannot
 * go there. Segments keep their own spelling; the UI decides on the home label.
 */
export function crumbTrail(dir: string): Crumb[] {
  const p = usableFolder(dir) ?? HOME;
  const crumbs: Crumb[] = [{ label: '', path: HOME, home: true }];
  if (p === HOME) return crumbs;
  let acc = HOME;
  for (const seg of p.slice(HOME.length + 1).split('/')) {
    if (!seg) continue;
    acc = `${acc}/${seg}`;
    crumbs.push({ label: seg, path: acc, home: false });
  }
  return crumbs;
}

/** Sub-folders of a listing, folders only, natural sort, case-insensitive. */
export function childFolders(entries: readonly Stat[]): Stat[] {
  return entries
    .filter((e) => e.type === 'dir')
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/** Byte-for-byte comparison, used for the read-back that must happen before "saved" is shown. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ──────────────────────────────── the dialog ─────────────────────────────── */

/** The file-system calls the dialog needs; the kernel's scoped VFS satisfies it. */
export interface SaveAsVFS {
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<Stat[]>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
}

export interface SaveAsTarget {
  /** Where the bytes go (or the name they download as). */
  path: string;
  dir: string;
  fileName: string;
  /** File name without its extension. */
  stem: string;
  ext: string;
  /** The format id the app should encode with. */
  format: string;
}

/** What an app's `extras` renderer can ask the dialog while it is open. */
export interface SaveAsApi {
  /** The format the dialog would encode with right now. */
  format(): string;
  /** The file name (stem) in the field right now. */
  name(): string;
  /** Called whenever the name or the format changes. */
  onChange(cb: () => void): void;
  /** Encodes the current bytes WITHOUT writing anything (size previews). */
  encode(): Promise<Uint8Array>;
  /** Writes one line into the dialog's live region. */
  note(text: string): void;
}

export interface SaveAsOptions {
  vfs: SaveAsVFS;
  /**
   * Where the overlay is mounted — the app's window content, so the layout follows the WINDOW
   * width through `@container faisal-window` instead of the screen (`faisal-window-content`
   * is the shell's container). A narrow desktop window therefore gets the phone layout.
   */
  host: HTMLElement;
  /** Defaults to the shared "Save as" title; Photo passes its "Export" wording. */
  title?: string;
  /** Folder shown first. Anything outside home (or unreadable) falls back to Documents/Home. */
  dir?: string | null;
  /** Suggested name, with or without an extension. */
  name?: string | null;
  formats: readonly SaveFormat[];
  format?: string | null;
  /** App-specific controls (quality, scale, size preview…), rendered above the target line. */
  extras?: (host: HTMLElement, api: SaveAsApi) => void;
  /**
   * Produces the bytes for the current target. Returning null cancels quietly and writes
   * nothing; throwing shows the message and keeps the dialog open.
   */
  encode: (target: SaveAsTarget) => Promise<Uint8Array | null>;
  /** Runs after the bytes are written and verified, before the dialog closes. */
  onSaved?: (result: { path: string; backup: string | null; bytes: number }) => void;
  /** Primary button label; defaults to the shared "Save". */
  saveLabel?: string;
  /** Hide "Download to my device" (a format that cannot be downloaded honestly). */
  allowDownload?: boolean;
}

export type SaveAsOutcome =
  | { status: 'saved'; path: string; backup: string | null; bytes: number }
  | { status: 'downloaded'; path: string; bytes: number }
  | { status: 'cancelled' };

/* Static, in-code icon markup (the icon set of the suite: 24 grid, 1.75 stroke, currentColor).
 * `renderIcon` parses it as SVG and sanitises it; nothing here is ever user or file content. */
const ICON = {
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5L12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.1l2 2h7.9A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/></svg>',
  folderPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.1l2 2h7.9A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"/><path d="M12 11.5v5M9.5 14h5"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v10M8 10.5l4 4 4-4M5 19h14"/></svg>',
} as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** An icon-only button: the label is both the accessible name and the desktop tooltip. */
function iconButton(markup: string, label: string, cls: string): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.title = label;
  b.append(glyph(markup));
  return b;
}

/**
 * Every icon of the dialog goes through here: the 20px size is set on the element itself, so an
 * icon never falls back to the SVG default (it filled the phone sheet when a stylesheet rule was
 * missing) and the CSS class only has to fine-tune it (16px in the breadcrumbs).
 */
function glyph(markup: string): SVGElement {
  const svg = renderIcon(markup);
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('class', 'faisal-saveas-icon');
  return svg;
}

function button(label: string, cls: string, text?: string): HTMLButtonElement {
  const b = el('button', cls, text ?? label);
  b.type = 'button';
  return b;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps the overlay pinned to the host's VISIBLE box, even when the app content is scrolled. */
export function pinToHost(overlay: HTMLElement, host: HTMLElement): () => void {
  const sync = (): void => {
    overlay.style.top = `${host.scrollTop}px`;
    overlay.style.left = `${host.scrollLeft}px`;
    overlay.style.width = `${host.clientWidth}px`;
    overlay.style.height = `${host.clientHeight}px`;
  };
  sync();
  host.addEventListener('scroll', sync, { passive: true });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null;
  observer?.observe(host);
  return () => {
    host.removeEventListener('scroll', sync);
    observer?.disconnect();
  };
}

function errorText(err: unknown): string {
  if (err instanceof VFSError) {
    if (err.code === 'EINVAL') return t('shell.saveas.quota');
    if (err.code === 'EACCES') return t('shell.saveas.outOfHome');
    return `${err.code}: ${err.path}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Opens the dialog and resolves with what happened. The overlay is a child of `host` so the
 * container queries in `theme.css` measure the window, and it is pinned over the host's visible
 * box so a scrolled app cannot push it out of sight.
 */
export function saveAsDialog(opts: SaveAsOptions): Promise<SaveAsOutcome> {
  const formats = opts.formats.length
    ? opts.formats
    : [{ value: 'bin', label: t('shell.saveas.format'), ext: 'bin', mime: 'application/octet-stream' }];
  const vfs = opts.vfs;
  const host = opts.host;
  const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = el('div', 'faisal-saveas-overlay');
  const card = el('div', 'faisal-saveas');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const titleId = `faisal-saveas-title-${Math.random().toString(36).slice(2, 9)}`;
  card.setAttribute('aria-labelledby', titleId);
  overlay.append(card);

  const head = el('div', 'faisal-saveas-head');
  const title = el('h2', 'faisal-saveas-title', opts.title ?? t('shell.saveas.title'));
  title.id = titleId;
  const closeBtn = iconButton(ICON.close, t('shell.saveas.close'), 'faisal-saveas-iconbtn');
  head.append(title, closeBtn);

  const body = el('div', 'faisal-saveas-body');
  const status = el('p', 'faisal-saveas-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const actions = el('footer', 'faisal-saveas-actions');
  card.append(head, body, status, actions);

  /* ── state ── */
  let dir = usableFolder(opts.dir) ?? '';
  let entries: Stat[] = [];
  let format = formatById(opts.format, formats) ?? formats[0];
  let closed = false;
  let busy = false;

  /* ── folder bar ── */
  const place = el('div', 'faisal-saveas-place');
  const upBtn = iconButton(ICON.up, t('shell.saveas.up'), 'faisal-saveas-iconbtn');
  const crumbs = el('nav', 'faisal-saveas-crumbs');
  crumbs.setAttribute('aria-label', t('shell.saveas.path'));
  place.append(upBtn, crumbs);

  const folderList = el('div', 'faisal-saveas-folders');
  folderList.setAttribute('role', 'group');
  folderList.setAttribute('aria-label', t('shell.saveas.folders'));

  const newFolderRow = el('div', 'faisal-saveas-newfolder');
  const newFolderInput = el('input', 'faisal-saveas-input');
  newFolderInput.type = 'text';
  newFolderInput.dir = 'auto';
  newFolderInput.autocomplete = 'off';
  newFolderInput.placeholder = t('shell.saveas.newFolderHint');
  newFolderInput.setAttribute('aria-label', t('shell.saveas.newFolder'));
  const newFolderBtn = button(t('shell.saveas.create'), 'faisal-saveas-btn is-secondary', t('shell.saveas.create'));
  newFolderBtn.prepend(glyph(ICON.folderPlus));
  newFolderRow.append(newFolderInput, newFolderBtn);

  /* ── name + format ── */
  const fields = el('div', 'faisal-saveas-fields');
  const nameField = el('div', 'faisal-saveas-field');
  const nameLabel = el('label', 'faisal-saveas-label', t('shell.saveas.name'));
  const nameInput = el('input', 'faisal-saveas-input faisal-saveas-name');
  nameInput.type = 'text';
  nameInput.dir = 'auto';
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameInput.setAttribute('aria-label', t('shell.saveas.name'));
  nameLabel.htmlFor = `faisal-saveas-name-${titleId.slice(-6)}`;
  nameInput.id = nameLabel.htmlFor;
  nameField.append(nameLabel, nameInput);

  const formatField = el('div', 'faisal-saveas-field');
  const formatLabel = el('label', 'faisal-saveas-label', t('shell.saveas.format'));
  const formatSelect = el('select', 'faisal-saveas-select');
  formatSelect.id = `faisal-saveas-format-${titleId.slice(-6)}`;
  formatLabel.htmlFor = formatSelect.id;
  for (const f of formats) {
    const option = el('option', undefined, f.label);
    option.value = f.value;
    formatSelect.append(option);
  }
  formatSelect.value = format.value;
  formatField.append(formatLabel, formatSelect);
  const singleFormat = el('p', 'faisal-saveas-single', formats[0].label);
  singleFormat.hidden = formats.length > 1;
  formatField.append(singleFormat);
  formatSelect.hidden = formats.length <= 1;
  formatLabel.hidden = formats.length <= 1;
  fields.append(nameField, formatField);

  /* ── extras + target line ── */
  const extrasHost = el('div', 'faisal-saveas-extras');
  extrasHost.hidden = !opts.extras;
  const targetLine = el('p', 'faisal-saveas-target');
  targetLine.dir = 'ltr';
  const replaceLine = el('div', 'faisal-saveas-replace');
  replaceLine.hidden = true;
  const replaceText = el('span', 'faisal-saveas-replace-text');
  const keepBothBtn = button(t('shell.saveas.keepBoth'), 'faisal-saveas-btn is-secondary', t('shell.saveas.keepBoth'));
  replaceLine.append(replaceText, keepBothBtn);
  const targetPath = el('span', 'faisal-saveas-target-path');
  targetLine.append(targetPath);

  body.append(place, folderList, newFolderRow, fields, extrasHost, targetLine, replaceLine);

  /* ── footer ── */
  const cancelBtn = button(t('shell.saveas.cancel'), 'faisal-saveas-btn is-plain', t('shell.saveas.cancel'));
  const downloadBtn = button(t('shell.saveas.download'), 'faisal-saveas-btn is-secondary', t('shell.saveas.download'));
  downloadBtn.prepend(glyph(ICON.download));
  downloadBtn.hidden = opts.allowDownload === false;
  const saveBtn = button(opts.saveLabel ?? t('shell.saveas.save'), 'faisal-saveas-btn is-primary', opts.saveLabel ?? t('shell.saveas.save'));
  actions.append(cancelBtn, downloadBtn, saveBtn);

  /* ── helpers ── */
  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle('is-error', isError);
  };

  const setBusy = (on: boolean): void => {
    busy = on;
    saveBtn.disabled = on;
    downloadBtn.disabled = on;
    cancelBtn.disabled = false;
    card.setAttribute('aria-busy', on ? 'true' : 'false');
    if (on) setStatus(t('shell.saveas.working'));
  };

  const api: SaveAsApi = {
    format: () => format.value,
    name: () => nameInput.value,
    onChange: (cb) => { changeHandlers.push(cb); },
    encode: async () => {
      const target = currentTarget();
      if (!target) throw new Error(t('shell.saveas.nameRequired'));
      return (await opts.encode(target)) ?? new Uint8Array(0);
    },
    note: (text) => setStatus(text),
  };
  const changeHandlers: Array<() => void> = [];

  function currentTarget(): SaveAsTarget | null {
    const plan = planTarget({ dir, name: nameInput.value, format, existing: entries.map((e) => e.name) });
    if (!plan.ok) return null;
    const encoding = effectiveFormat(plan.fileName, format, formats) ?? format;
    return {
      path: plan.path, dir: plan.dir, fileName: plan.fileName, stem: plan.stem, ext: plan.ext,
      format: encoding.value,
    };
  }

  function renderCrumbs(): void {
    crumbs.replaceChildren();
    for (const crumb of crumbTrail(dir)) {
      if (crumbs.childElementCount) crumbs.append(el('span', 'faisal-saveas-crumb-sep', '/'));
      const b = button(crumb.home ? t('shell.saveas.home') : crumb.label, 'faisal-saveas-crumb', crumb.home ? t('shell.saveas.home') : crumb.label);
      b.dir = 'auto';
      if (crumb.home) b.prepend(glyph(ICON.home));
      if (crumb.path === dir) {
        b.classList.add('is-current');
        b.setAttribute('aria-current', 'true');
      }
      b.addEventListener('click', () => { if (!busy) void goTo(crumb.path); });
      crumbs.append(b);
    }
    upBtn.disabled = busy || dir === HOME;
  }

  function renderFolders(): void {
    folderList.replaceChildren();
    const folders = childFolders(entries);
    if (!folders.length) {
      folderList.append(el('p', 'faisal-saveas-empty', t('shell.saveas.emptyFolder')));
      return;
    }
    for (const folder of folders) {
      const row = button(folder.name, 'faisal-saveas-folder', folder.name);
      row.dir = 'auto';
      row.prepend(glyph(ICON.folder));
      row.addEventListener('click', () => { if (!busy) void goTo(folder.path); });
      folderList.append(row);
    }
  }

  function syncFields(): void {
    const plan = planTarget({ dir, name: nameInput.value, format, existing: entries.map((e) => e.name) });
    if (!plan.ok) {
      targetPath.textContent = dir;
      replaceLine.hidden = true;
      return;
    }
    targetPath.textContent = plan.path;
    replaceLine.hidden = !plan.exists;
    if (plan.exists) {
      replaceText.textContent = t('shell.saveas.replaceNote', { name: plan.fileName, bak: `${plan.fileName}${BACKUP_SUFFIX}` });
    }
    saveBtn.disabled = busy;
    for (const cb of changeHandlers) cb();
  }

  async function refresh(): Promise<boolean> {
    try {
      entries = await vfs.readdir(dir);
      renderFolders();
      syncFields();
      return true;
    } catch {
      entries = [];
      renderFolders();
      syncFields();
      setStatus(t('shell.saveas.badFolder'), true);
      return false;
    }
  }

  async function goTo(path: string): Promise<void> {
    const next = usableFolder(path);
    if (!next) { setStatus(t('shell.saveas.outOfHome'), true); return; }
    dir = next;
    setStatus('');
    renderCrumbs();
    await refresh();
  }

  async function createFolder(): Promise<void> {
    if (busy) return;
    const raw = sanitizeName(newFolderInput.value);
    if (!raw) { setStatus(t('shell.saveas.nameRequired'), true); newFolderInput.focus(); return; }
    const taken = entries.some((e) => e.name.toLowerCase() === raw.toLowerCase());
    if (taken) { setStatus(t('shell.saveas.folderExists', { name: raw }), true); return; }
    try {
      await vfs.mkdir(join(dir, raw));
    } catch {
      setStatus(t('shell.saveas.folderFailed'), true);
      return;
    }
    newFolderInput.value = '';
    if (!(await refresh())) return;
    setStatus(t('shell.saveas.folderCreated', { name: raw }));
  }

  /** Encodes, asks before replacing, writes one `.bak`, and verifies the bytes came back. */
  async function save(): Promise<void> {
    if (busy || closed) return;
    const plan = planTarget({ dir, name: nameInput.value, format, existing: entries.map((e) => e.name) });
    if (!plan.ok) {
      setStatus(plan.error === 'reserved-name' ? t('shell.saveas.reserved') : plan.error === 'out-of-home'
        ? t('shell.saveas.outOfHome') : t('shell.saveas.nameRequired'), true);
      nameInput.focus();
      return;
    }
    const target = currentTarget();
    if (!target) { setStatus(t('shell.saveas.nameRequired'), true); return; }

    setBusy(true);
    let bytes: Uint8Array | null;
    try {
      bytes = await opts.encode(target);
    } catch (err) {
      setBusy(false);
      setStatus(t('shell.saveas.writeFailed', { reason: errorText(err) }), true);
      return;
    }
    if (closed) return;
    if (!bytes) { setBusy(false); setStatus(''); return; }           // the app backed out: nothing written
    if (!bytes.length) { setBusy(false); setStatus(t('shell.saveas.emptyBytes'), true); return; }

    let backup: string | null = null;
    try {
      // The question comes BEFORE the first write, so "no" leaves the disk untouched — and the
      // backup is only planned for a file that really exists.
      if (plan.exists) {
        const yes = await shellConfirm({
          title: t('shell.saveas.replaceTitle', { name: plan.fileName }),
          message: t('shell.saveas.replaceBody', { name: plan.fileName, bak: `${plan.fileName}${BACKUP_SUFFIX}` }),
          okLabel: t('shell.saveas.replaceOk'),
          cancelLabel: t('shell.saveas.cancel'),
          danger: true,
        });
        if (!yes) { setBusy(false); return; }                        // cancelled: nothing written
        const previous = await vfs.readFile(plan.path);
        backup = plan.backup;
        await vfs.writeFile(backup!, previous);
      }
      if (await vfs.exists(plan.path) && !plan.exists) {
        // The file appeared between the listing and the write (another window). Refuse rather
        // than overwrite something the owner was never asked about.
        setBusy(false);
        await refresh();
        setStatus(t('shell.saveas.changed'), true);
        return;
      }
      await vfs.writeFile(plan.path, bytes);
      const back = await vfs.readFile(plan.path);
      if (!sameBytes(back, bytes)) {
        setBusy(false);
        setStatus(t('shell.saveas.verifyFailed', { name: plan.fileName }), true);
        return;
      }
    } catch (err) {
      setBusy(false);
      setStatus(t('shell.saveas.writeFailed', { reason: errorText(err) }), true);
      return;
    }
    setBusy(false);
    const written = bytes.length;
    finish({ status: 'saved', path: plan.path, backup, bytes: written });
  }

  async function download(): Promise<void> {
    if (busy || closed) return;
    setBusy(true);
    try {
      const target = currentTarget();
      if (!target) { setBusy(false); setStatus(t('shell.saveas.nameRequired'), true); return; }
      const bytes = await opts.encode(target);
      if (closed) return;
      if (!bytes) { setBusy(false); return; }
      const encoding = effectiveFormat(target.fileName, format, formats) ?? format;
      const url = URL.createObjectURL(new Blob([bytes.slice()], { type: encoding.mime }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = target.fileName;
      anchor.rel = 'noopener';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setBusy(false);
      finish({ status: 'downloaded', path: target.fileName, bytes: bytes.length });
    } catch (err) {
      setBusy(false);
      setStatus(t('shell.saveas.downloadFailed', { reason: errorText(err) }), true);
    }
  }

  function finish(outcome: SaveAsOutcome): void {
    if (closed) return;
    closed = true;
    overlay.remove();
    releaseEsc?.();
    releaseEsc = null;
    unpin?.();
    if (outcome.status === 'saved') opts.onSaved?.({ path: outcome.path, backup: outcome.backup, bytes: outcome.bytes });
    if (invoker?.isConnected) invoker.focus({ preventScroll: true });
    resolve(outcome);
  }

  /* ── wiring ── */
  let releaseEsc: (() => void) | null = null;
  let unpin: (() => void) | null = null;
  let resolve!: (value: SaveAsOutcome) => void;
  const done = new Promise<SaveAsOutcome>((r) => { resolve = r; });

  nameInput.value = sanitizeName(opts.name ?? t('shell.saveas.untitled')) || t('shell.saveas.untitled');
  if (opts.format) format = formatById(opts.format, formats) ?? format;
  formatSelect.value = format.value;

  nameInput.addEventListener('input', () => { syncFields(); });
  // A typed extension decides the format, exactly like the pure rule says.
  nameInput.addEventListener('blur', () => {
    const typed = formatForName(nameInput.value, formats);
    if (typed && typed.value !== format.value) { format = typed; formatSelect.value = typed.value; }
    syncFields();
  });
  formatSelect.addEventListener('change', () => {
    format = formatById(formatSelect.value, formats) ?? format;
    syncFields();
  });
  nameInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); void save(); }
  });
  newFolderInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); void createFolder(); }
  });
  upBtn.addEventListener('click', () => { if (!busy && dir !== HOME) void goTo(normalize(`${dir}/..`)); });
  newFolderBtn.addEventListener('click', () => { void createFolder(); });
  keepBothBtn.addEventListener('click', () => {
    const plan = planTarget({ dir, name: nameInput.value, format, existing: entries.map((e) => e.name) });
    if (!plan.ok) return;
    nameInput.value = stemOfName(uniqueName(plan.fileName, entries.map((e) => e.name)));
    syncFields();
    nameInput.focus();
  });
  cancelBtn.addEventListener('click', () => finish({ status: 'cancelled' }));
  closeBtn.addEventListener('click', () => finish({ status: 'cancelled' }));
  saveBtn.addEventListener('click', () => { void save(); });
  downloadBtn.addEventListener('click', () => { void download(); });
  overlay.addEventListener('mousedown', (ev) => { if (ev.target === overlay) finish({ status: 'cancelled' }); });
  card.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return;
    const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((n) => !n.hidden && (n.offsetParent !== null || n === document.activeElement || !n.closest('[hidden]')));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
  releaseEsc = pushEscapeLayer(() => finish({ status: 'cancelled' }));

  if (opts.extras) opts.extras(extrasHost, api);

  host.append(overlay);
  unpin = pinToHost(overlay, host);
  void refresh().then((ok) => {
    // A folder that cannot be read must not be a dead end: the home folder is always there.
    if (!ok && !closed && dir !== HOME) void goTo(HOME);
  });
  renderCrumbs();
  syncFields();
  queueMicrotask(() => { if (!closed) nameInput.focus(); });

  return done;
}
