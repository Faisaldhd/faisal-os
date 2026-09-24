/**
 * File Viewer (عارض الملفات): opens the files no other app handles.
 * PDF in the browser's own PDF viewer, audio and video in the browser's players,
 * Excel/CSV as a table, Word and PowerPoint as their text, readable files as text,
 * and anything else as a card with a Download button — a file never "does nothing".
 *
 * Everything is shown with textContent. A blob is only ever given a known media
 * type (PDF, audio, video, image); every other file stays application/octet-stream.
 */
import { manifest } from './manifest';
import type { AppContext, AppModule } from '../../kernel/types';
import { basename } from '../../kernel/path';
import { t } from '../../kernel/i18n';
import { nativeWeb } from '../../shell/native-web';
import { formatBytes } from '../files/format';
import {
  kindOf, mimeOf, looksLikeText, parseCsv, readXlsx, readDocx, readPptx,
  MAX_ROWS, MAX_COLS, type FileKind, type Sheet,
} from './formats';
import './strings';
import './viewer.css';

const TEXT_LIMIT = 2 * 1024 * 1024;

const KIND_LABEL: Record<FileKind | 'text', string> = {
  pdf: 'viewer.kindPdf', sheet: 'viewer.kindSheet', csv: 'viewer.kindSheet', doc: 'viewer.kindDoc',
  slides: 'viewer.kindSlides', audio: 'viewer.kindAudio', video: 'viewer.kindVideo',
  image: 'viewer.kindImage', text: 'viewer.kindText', other: 'viewer.kindOther',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function launch(ctx: AppContext): void {
  const { sys, window: win, args } = ctx;
  win.setTitle(t('viewer.title'));
  const root = el('div', 'faisal-viewer');
  win.content.append(root);

  const urls: string[] = [];
  let closed = false;
  win.onClose(() => { closed = true; urls.forEach((u) => URL.revokeObjectURL(u)); });

  const path = args[0];
  if (!path) {
    root.append(el('div', 'faisal-viewer-note', t('viewer.noFile')));
    return;
  }
  const name = basename(path);
  win.setTitle(`${name} — ${t('viewer.title')}`);

  const bar = el('div', 'faisal-viewer-bar');
  const title = el('div', 'faisal-viewer-name', name);
  title.title = path;
  const meta = el('div', 'faisal-viewer-meta');
  const actions = el('div', 'faisal-viewer-actions');
  const info = el('div', 'faisal-viewer-info');
  info.append(title, meta);
  bar.append(info, actions);
  const body = el('div', 'faisal-viewer-body');
  body.append(el('div', 'faisal-viewer-note', t('viewer.loading')));
  root.append(bar, body);

  void (async () => {
    let bytes: Uint8Array;
    try {
      bytes = await sys.vfs.readFile(path);
    } catch {
      if (closed) return;
      body.textContent = '';
      body.append(el('div', 'faisal-viewer-note', t('viewer.readError')));
      return;
    }
    if (closed) return;

    const kind = kindOf(path);
    const text = kind === 'other' && bytes.length <= TEXT_LIMIT && looksLikeText(bytes);
    meta.textContent = `${t(KIND_LABEL[text ? 'text' : kind])} · ${formatBytes(bytes.length, sys.locale())}`;

    const blobUrl = (type = mimeOf(path)) => {
      const u = URL.createObjectURL(new Blob([bytes.slice()], { type }));
      urls.push(u);
      return u;
    };
    const button = (label: string, onClick: () => void, primary = false) => {
      const b = el('button', `faisal-viewer-btn${primary ? ' is-primary' : ''}`, label);
      b.type = 'button';
      b.addEventListener('click', onClick);
      return b;
    };
    const download = () => {
      // Always octet-stream: the browser saves it and never tries to render it.
      const a = el('a');
      a.href = blobUrl('application/octet-stream');
      a.download = name;
      a.style.display = 'none';
      document.body.append(a);
      a.click();
      a.remove();
    };
    // A new tab only in a browser, and only for types the browser shows safely by itself.
    // (The desktop app sends new windows to the system browser, which cannot read a blob.)
    const canOpenTab = !nativeWeb() && ['pdf', 'audio', 'video', 'image'].includes(kind);
    const openTab = () => { window.open(blobUrl(), '_blank', 'noopener'); };
    if (canOpenTab) actions.append(button(t('viewer.openTab'), openTab));
    actions.append(button(t('viewer.download'), download, true));

    const show = (...nodes: Node[]) => { body.textContent = ''; body.append(...nodes); };
    const note = (msg: string, withButtons = false) => {
      const card = el('div', 'faisal-viewer-card');
      card.append(el('div', 'faisal-viewer-card-name', name), el('p', 'faisal-viewer-card-text', msg));
      if (withButtons) {
        const row = el('div', 'faisal-viewer-actions');
        if (canOpenTab) row.append(button(t('viewer.openTab'), openTab));
        row.append(button(t('viewer.download'), download, true));
        card.append(row);
      }
      return card;
    };

    try {
      if (bytes.length === 0) { show(note(t('viewer.empty'))); return; }
      if (text) { show(textView(new TextDecoder().decode(bytes))); return; }
      switch (kind) {
        case 'pdf': {
          // Chrome on Android (and some others) cannot show a PDF inside the page.
          const nav = navigator as Navigator & { pdfViewerEnabled?: boolean };
          if (nav.pdfViewerEnabled === false) { show(note(t('viewer.pdfNoViewer'), true)); return; }
          const frame = el('iframe', 'faisal-viewer-frame');
          frame.title = name;
          frame.src = blobUrl();
          show(frame);
          return;
        }
        case 'audio':
        case 'video': {
          const media = el(kind, `faisal-viewer-${kind}`);
          media.controls = true;
          media.preload = 'metadata';
          media.src = blobUrl();
          media.addEventListener('error', () => show(note(t('viewer.unknown'), true)), { once: true });
          show(media);
          return;
        }
        case 'image': {
          const img = el('img', 'faisal-viewer-image');
          img.alt = name;
          img.src = blobUrl();
          img.addEventListener('error', () => show(note(t('viewer.unknown'), true)), { once: true });
          show(img);
          return;
        }
        case 'csv': {
          const delimiter = path.toLowerCase().endsWith('.tsv') ? '\t' : ',';
          const rows = parseCsv(new TextDecoder().decode(bytes), delimiter);
          const truncated = rows.length > MAX_ROWS || rows.some((r) => r.length > MAX_COLS);
          show(sheetsView([{ name, rows: rows.slice(0, MAX_ROWS).map((r) => r.slice(0, MAX_COLS)), truncated }]));
          return;
        }
        case 'sheet': {
          const sheets = await readXlsx(bytes);
          if (closed) return;
          show(sheets.length ? sheetsView(sheets) : note(t('viewer.empty')));
          return;
        }
        case 'doc': {
          const paras = await readDocx(bytes);
          if (closed) return;
          const page = el('article', 'faisal-viewer-doc');
          page.dir = 'auto';
          for (const p of paras) page.append(el('p', undefined, p || ' '));
          show(paras.some((p) => p.trim()) ? page : note(t('viewer.empty')));
          return;
        }
        case 'slides': {
          const slides = await readPptx(bytes);
          if (closed) return;
          const list = el('div', 'faisal-viewer-slides');
          slides.forEach((paras, i) => {
            const s = el('section', 'faisal-viewer-slide');
            s.dir = 'auto';
            s.append(el('h3', undefined, t('viewer.slide', { n: i + 1 })));
            for (const p of paras) s.append(el('p', undefined, p));
            list.append(s);
          });
          show(list);
          return;
        }
        default:
          show(note(t('viewer.unknown'), true));
      }
    } catch {
      if (!closed) show(note(t('viewer.readError'), true));
    }
  })();
}

function textView(text: string): HTMLElement {
  const pre = el('pre', 'faisal-viewer-text', text);
  pre.dir = 'auto';
  return pre;
}

function sheetsView(sheets: Sheet[]): HTMLElement {
  const wrap = el('div', 'faisal-viewer-sheets');
  const tabs = el('div', 'faisal-viewer-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', t('viewer.sheets'));
  const holder = el('div', 'faisal-viewer-tablewrap');
  const select = (i: number) => {
    [...tabs.children].forEach((b, j) => b.setAttribute('aria-selected', String(i === j)));
    holder.textContent = '';
    const sheet = sheets[i];
    if (sheet.truncated) {
      holder.append(el('div', 'faisal-viewer-truncated', t('viewer.truncated', { rows: MAX_ROWS, cols: MAX_COLS })));
    }
    if (!sheet.rows.some((r) => r.some((c) => c !== ''))) {
      holder.append(el('div', 'faisal-viewer-note', t('viewer.empty')));
      return;
    }
    const width = Math.max(...sheet.rows.map((r) => r.length));
    const table = el('table', 'faisal-viewer-table');
    table.dir = 'auto';
    const tbody = el('tbody');
    sheet.rows.forEach((r, ri) => {
      const tr = el('tr');
      tr.append(el('th', undefined, String(ri + 1)));
      for (let c = 0; c < width; c++) tr.append(el('td', undefined, r[c] ?? ''));
      tbody.append(tr);
    });
    table.append(tbody);
    holder.append(table);
  };
  if (sheets.length > 1) {
    sheets.forEach((s, i) => {
      const b = el('button', 'faisal-viewer-tab', s.name);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => select(i));
      tabs.append(b);
    });
    wrap.append(tabs);
  }
  wrap.append(holder);
  select(0);
  return wrap;
}

const app: AppModule = { manifest, launch };
export default app;
