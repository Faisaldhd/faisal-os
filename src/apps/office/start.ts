/**
 * Office — the start screen (شاشة البداية) and the recent-files list.
 *
 * New document / spreadsheet / presentation cards, Open (a file from the device,
 * or a supported file from the home folder), and the last files this app opened.
 * The recent list lives in localStorage behind try/catch: a private window simply
 * shows no history.
 */
import { t } from '../../kernel/i18n';
import type { VFS } from '../../kernel/types';
import { basename } from '../../kernel/path';
import { el } from './ui/dom';
import { icon, type IconName } from './ui/icons';
import { OFFICE_EXTENSIONS } from './model';

const RECENT_KEY = 'faisal.office.recent.v1';
export const RECENT_LIMIT = 10;

export interface RecentEntry { path: string; time: number }

/** Adds a path to the front of the list, without duplicates, capped. */
export function pushRecent(list: readonly RecentEntry[], path: string, time: number): RecentEntry[] {
  return [{ path, time }, ...list.filter((e) => e.path !== path)].slice(0, RECENT_LIMIT);
}

export function loadRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is RecentEntry => !!e && typeof e.path === 'string' && typeof e.time === 'number').slice(0, RECENT_LIMIT);
  } catch { return []; }
}

export function rememberRecent(path: string): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(pushRecent(loadRecent(), path, Date.now()))); } catch { /* storage blocked: no history */ }
}

export type NewKind = 'docx' | 'xlsx' | 'pptx';

export interface StartActions {
  create(kind: NewKind): void;
  open(path: string): void;
  openDevice(): void;
}

function kindIcon(path: string): IconName {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.csv' || ext === '.tsv') return 'sheet';
  if (ext === '.pptx') return 'slides';
  return 'doc';
}

/** Supported files found in the home folder's usual places (for the Open list). */
export async function findOfficeFiles(vfs: VFS): Promise<string[]> {
  const out: string[] = [];
  for (const dir of ['/home/user/Documents', '/home/user/Desktop', '/home/user/Downloads', '/home/user']) {
    try {
      for (const entry of await vfs.readdir(dir)) {
        if (entry.type !== 'file') continue;
        const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
        if (OFFICE_EXTENSIONS.includes(ext) && !entry.name.endsWith('.bak')) out.push(`${dir}/${entry.name}`);
      }
    } catch { /* a folder that does not exist */ }
  }
  return out.slice(0, 40);
}

export function renderStart(actions: StartActions, vfs: VFS): HTMLElement {
  const root = el('div', 'fo-start');
  const hero = el('div', 'fo-start-hero');
  hero.append(el('h1', 'fo-start-title', t('office.startTitle')), el('p', 'fo-start-sub', t('office.noFile')));
  root.append(hero);

  const cards = el('div', 'fo-start-cards');
  const card = (kind: NewKind, name: IconName, title: string, hint: string): HTMLButtonElement => {
    const b = el('button', `fo-card fo-card-${kind}`);
    b.type = 'button';
    const art = el('span', 'fo-card-art');
    art.append(icon(name, 32));
    b.append(art, el('span', 'fo-card-title', title), el('span', 'fo-card-hint', hint));
    b.addEventListener('click', () => actions.create(kind));
    return b;
  };
  cards.append(
    card('docx', 'doc', t('office.newDocument'), t('office.newDocumentHint')),
    card('xlsx', 'sheet', t('office.newSpreadsheet'), t('office.newSpreadsheetHint')),
    card('pptx', 'slides', t('office.newPresentation'), t('office.newPresentationHint')),
  );
  const openCard = el('button', 'fo-card fo-card-open');
  openCard.type = 'button';
  const art = el('span', 'fo-card-art');
  art.append(icon('upload', 32));
  openCard.append(art, el('span', 'fo-card-title', t('office.openDevice')), el('span', 'fo-card-hint', t('office.openDeviceHint')));
  openCard.addEventListener('click', () => actions.openDevice());
  cards.append(openCard);
  root.append(cards);

  const lists = el('div', 'fo-start-lists');
  const section = (title: string): { box: HTMLElement; list: HTMLElement } => {
    const box = el('section', 'fo-start-section');
    box.append(el('h2', 'fo-section-title', title));
    const list = el('div', 'fo-filelist');
    box.append(list);
    lists.append(box);
    return { box, list };
  };
  const recent = section(t('office.recent'));
  const files = section(t('office.filesInHome'));
  root.append(lists);

  const row = (path: string, time?: number): HTMLButtonElement => {
    const b = el('button', 'fo-filerow');
    b.type = 'button';
    const ic = el('span', `fo-filerow-icon is-${kindIcon(path)}`);
    ic.append(icon(kindIcon(path)));
    const text = el('span', 'fo-filerow-text');
    const name = el('span', 'fo-filerow-name', basename(path));
    const where = el('span', 'fo-filerow-path', path);
    where.dir = 'ltr';
    text.append(name, where);
    b.append(ic, text);
    if (time) {
      const when = el('span', 'fo-filerow-date', new Date(time).toLocaleDateString(document.documentElement.lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB'));
      b.append(when);
    }
    b.addEventListener('click', () => actions.open(path));
    return b;
  };
  const empty = (text: string): HTMLElement => {
    const box = el('div', 'fo-empty-small');
    box.append(icon('clock', 28), el('p', undefined, text));
    return box;
  };

  void (async () => {
    const entries: RecentEntry[] = [];
    for (const e of loadRecent()) {
      try { if (await vfs.exists(e.path)) entries.push(e); } catch { /* unreadable: skip */ }
    }
    recent.list.replaceChildren(...(entries.length ? entries.map((e) => row(e.path, e.time)) : [empty(t('office.recentEmpty'))]));
    const found = await findOfficeFiles(vfs);
    files.list.replaceChildren(...(found.length ? found.map((p) => row(p)) : [empty(t('office.filesEmpty'))]));
  })();
  recent.list.append(el('div', 'fo-skeleton'));
  files.list.append(el('div', 'fo-skeleton'));
  return root;
}
