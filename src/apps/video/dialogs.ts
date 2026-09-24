/**
 * Dialogs: the Files picker (browse the system's files for media or projects),
 * the keyboard shortcuts sheet (generated from the same table that binds the
 * keys), and the honest-limits sheet with the live capability table.
 */
import type { Stat, VFS } from '../../kernel/types';
import { dirname } from '../../kernel/path';
import { extensionOf } from '../viewer/formats';
import { formatBytes } from '../files/format';
import type { Locale } from '../../kernel/types';
import { capabilityTable, type CapabilityProbe, type CapabilityRow } from './capabilities';
import { helpRows } from './shortcuts';
import { button, el, openModal, s } from './ui';
import { icon, type IconName } from './icons';

const ROOTS = ['/home/user', '/tmp'];
const MAX_DEPTH = 6;
const MAX_FILES = 600;

/** Every file under the home folder whose extension is in `exts`, newest first. */
export async function scanFiles(vfs: VFS, exts: readonly string[]): Promise<Stat[]> {
  const wanted = new Set(exts.map((e) => e.toLowerCase()));
  const found: Stat[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let entries: Stat[] = [];
    try {
      entries = await vfs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      if (entry.name.startsWith('.')) continue;
      if (entry.type === 'dir') await walk(entry.path, depth + 1);
      else if (wanted.has(extensionOf(entry.name).toLowerCase())) found.push(entry);
    }
  };
  for (const root of ROOTS) await walk(root, 0);
  return found.sort((a, b) => b.mtime - a.mtime);
}

export interface PickerCategory {
  key: string;
  label: string;
  exts: readonly string[];
  icon: IconName;
}

/**
 * The Files picker. Resolves the chosen paths (several when `multiple`), or []
 * when cancelled.
 */
export function pickFromFiles(opts: {
  host: HTMLElement;
  vfs: VFS;
  locale: Locale;
  title: string;
  categories: PickerCategory[];
  initial?: string;
  multiple: boolean;
  okLabel: string;
}): Promise<string[]> {
  return new Promise((resolve) => {
    const modal = openModal(opts.host, opts.title, { wide: true });
    const chips = el('div', 'fvs-chips');
    const search = el('input', 'fvs-input');
    search.type = 'search';
    search.placeholder = s('searchFiles');
    search.setAttribute('aria-label', s('searchFiles'));
    search.dir = 'auto';
    const list = el('div', 'fvs-picker-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-multiselectable', String(opts.multiple));
    const status = el('p', 'fvs-note');
    status.setAttribute('role', 'status');
    modal.body.append(chips, search, list, status);
    const cancel = button(s('cancel'), 'fvs-btn');
    const ok = button(opts.okLabel, 'fvs-btn is-primary');
    ok.disabled = true;
    modal.actions.append(cancel, ok);

    let category = opts.categories.find((c) => c.key === opts.initial) ?? opts.categories[0];
    let files: Stat[] = [];
    const chosen = new Set<string>();
    let result: string[] = [];

    const allExts = [...new Set(opts.categories.flatMap((c) => c.exts))];
    const chipButtons = opts.categories.map((c) => {
      const b = button(c.label, 'fvs-chip', c.icon);
      b.addEventListener('click', () => {
        category = c;
        for (const other of chipButtons) other.setAttribute('aria-pressed', String(other === b));
        paint();
      });
      b.setAttribute('aria-pressed', String(c === category));
      chips.append(b);
      return b;
    });
    if (opts.categories.length < 2) chips.hidden = true;

    const syncOk = () => {
      ok.disabled = chosen.size === 0;
      const label = opts.multiple && chosen.size > 1 ? `${opts.okLabel} (${chosen.size})` : opts.okLabel;
      const span = ok.querySelector('.fvs-btn-label');
      if (span) span.textContent = label;
    };

    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const exts = new Set(category.exts.map((e) => e.toLowerCase()));
      const shown = files.filter((f) => exts.has(extensionOf(f.name).toLowerCase()) && (!q || f.name.toLowerCase().includes(q)));
      list.replaceChildren();
      if (shown.length === 0) {
        const empty = el('div', 'fvs-empty-state is-compact');
        const art = el('div', 'fvs-empty-art');
        art.append(icon(category.icon));
        empty.append(art, el('p', 'fvs-empty-title', s('pickerEmpty')), el('p', 'fvs-empty-hint', s('pickerEmptyHint')));
        list.append(empty);
        return;
      }
      for (const file of shown) {
        const row = el('button', 'fvs-picker-row');
        row.type = 'button';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(chosen.has(file.path)));
        const kind = opts.categories.find((c) => c.exts.includes(extensionOf(file.name).toLowerCase()));
        const name = el('span', 'fvs-picker-name', file.name);
        name.dir = 'auto';
        const meta = el('span', 'fvs-picker-meta', `${dirname(file.path)} · ${formatBytes(file.size, opts.locale)}`);
        meta.dir = 'ltr';
        const text = el('span', 'fvs-picker-text');
        text.append(name, meta);
        const check = el('span', 'fvs-picker-check');
        check.append(icon('check'));
        row.append(icon(kind?.icon ?? 'film'), text, check);
        row.addEventListener('click', () => {
          if (!opts.multiple) chosen.clear();
          if (chosen.has(file.path)) chosen.delete(file.path);
          else chosen.add(file.path);
          if (!opts.multiple) {
            for (const other of list.querySelectorAll('.fvs-picker-row')) other.setAttribute('aria-selected', 'false');
          }
          row.setAttribute('aria-selected', String(chosen.has(file.path)));
          syncOk();
        });
        row.addEventListener('dblclick', () => {
          chosen.add(file.path);
          result = [...chosen];
          modal.close();
        });
        list.append(row);
      }
    };

    search.addEventListener('input', paint);
    cancel.addEventListener('click', () => modal.close());
    ok.addEventListener('click', () => {
      result = [...chosen];
      modal.close();
    });
    modal.onClose(() => resolve(result));
    status.textContent = s('scanning');
    list.append(el('span', 'fvs-spinner'));
    void scanFiles(opts.vfs, allExts).then((found) => {
      files = found;
      status.textContent = s('filesFound', { n: found.length });
      paint();
    });
  });
}

/** F1: every shortcut, from the table that binds them. */
export function showShortcuts(host: HTMLElement): void {
  const modal = openModal(host, s('shortcutsTitle'), { wide: true });
  const table = el('div', 'fvs-keys');
  for (const row of helpRows()) {
    const line = el('div', 'fvs-keys-row');
    const keys = el('span', 'fvs-keys-keys');
    keys.dir = 'ltr';
    row.keys.forEach((k, i) => {
      if (i > 0) keys.append(el('span', 'fvs-keys-or', s('or')));
      keys.append(el('kbd', 'fvs-kbd', k));
    });
    line.append(el('span', 'fvs-keys-name', s(`key_${row.action}`)), keys);
    table.append(line);
  }
  modal.body.append(el('p', 'fvs-note', s('shortcutsNote')), table);
  const close = button(s('close'), 'fvs-btn is-primary');
  close.addEventListener('click', () => modal.close());
  modal.actions.append(close);
}

/** The honesty panel: limits in plain words, and what this browser really plays. */
export function showLimits(host: HTMLElement, probe: CapabilityProbe, recorder: Array<{ mime: string; ok: boolean }>): void {
  const modal = openModal(host, s('limitsTitle'), { wide: true });
  const list = el('ul', 'fvs-limits');
  for (const key of ['limitRealtime', 'limitReencode', 'limitFormats', 'limitSpeed', 'limitFonts', 'limitQuota', 'limitBrowser']) {
    list.append(el('li', undefined, s(key)));
  }
  const rows: CapabilityRow[] = capabilityTable(probe);
  const grouped = new Map<string, CapabilityRow[]>();
  for (const row of rows) grouped.set(row.format.ext, [...(grouped.get(row.format.ext) ?? []), row]);
  const table = el('table', 'fvs-table');
  table.dir = 'ltr';
  const head = el('tr');
  head.append(el('th', undefined, s('capsFormat')), el('th', undefined, s('capsPlayable')));
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const [ext, group] of grouped) {
    const best = group.find((r) => r.answer !== 'no');
    const tr = el('tr');
    const verdict = el('td', `fvs-cap is-${best ? best.answer : 'no'}`, best ? (best.answer === 'maybe' ? s('capsMaybe') : s('capsYes')) : s('capsNo'));
    tr.append(el('td', undefined, `${ext} — ${group[0].format.label}`), verdict);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const rec = el('table', 'fvs-table');
  rec.dir = 'ltr';
  const rbody = el('tbody');
  for (const r of recorder) {
    const tr = el('tr');
    tr.append(el('td', undefined, r.mime), el('td', `fvs-cap is-${r.ok ? 'probably' : 'no'}`, r.ok ? s('capsYes') : s('capsNo')));
    rbody.append(tr);
  }
  rec.append(rbody);
  modal.body.append(
    list,
    el('h3', 'fvs-modal-sub', s('capsTitle')),
    el('p', 'fvs-note', s('capsIntro')),
    table,
    el('h3', 'fvs-modal-sub', s('recorderTitle')),
    rec,
  );
  const close = button(s('close'), 'fvs-btn is-primary');
  close.addEventListener('click', () => modal.close());
  modal.actions.append(close);
}
