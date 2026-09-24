/**
 * Office — local import / export (الاستيراد والتصدير المحلي), the boundary with the
 * browser. No server, no cloud and no network: a real `<input type="file">` (or a
 * drop on the window) is read here, and a download is a Blob URL the browser saves
 * itself. The bytes never leave the device, and what is imported is written inside
 * `/home/user` only — the app's own home scope.
 *
 * `.pdf` is not written here either: the browser's own print-to-PDF is what the
 * window offers, labelled as such, because a hand-written PDF could not embed an
 * Arabic font.
 */
import { HOME } from '../../kernel/types';
import { basename } from '../../kernel/path';
import { extensionOf, looksLikeText } from '../viewer/formats';
import { loadOfficeFile } from './file';
import type { FormatPlan, OfficeModel } from './model';

/** The two formats the window imports, and nothing else. */
export const IMPORT_EXTENSIONS = ['.txt', '.csv'] as const;

/** A text buffer larger than this is refused before it is read into memory. */
export const IMPORT_TEXT_LIMIT = 4 * 1024 * 1024;

/** The part of a browser `File` this module needs; a real `File` satisfies it. */
export interface LocalFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type ImportRefusal = 'extension' | 'toolarge' | 'binary' | 'damaged';

export type ImportResult =
  | { ok: true; name: string; path: string; plan: FormatPlan; model: OfficeModel; bytes: Uint8Array; empty: boolean }
  | { ok: false; name: string; refusal: ImportRefusal };

/** `.txt` or `.csv` (case-insensitively), or null for anything else. */
export function importableExtension(name: string): '.txt' | '.csv' | null {
  const ext = extensionOf(basename(name));
  return ext === '.txt' || ext === '.csv' ? ext : null;
}

/** A drop's file name turned into one safe path segment: no directories, no `.` lead. */
export function importLeaf(name: string): string {
  const leaf = basename(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/^[.\-]+/, '').trim();
  return leaf || 'imported';
}

/** Where an imported file is written: its own name inside the app's home folder. */
export function importPathFor(name: string): string {
  return `${HOME}/${importLeaf(name)}`;
}

/**
 * Reads one dropped or chosen file into an import result.
 *
 * The refusal order is deliberate: the extension is checked before a single byte is
 * read (so a 2 GB video is never pulled into memory), then its size for `.txt`, and
 * only then its content — a `.txt` that is really binary is refused exactly as the
 * window refuses one opened from the Files app.
 */
export async function importLocalFile(file: LocalFile): Promise<ImportResult> {
  const name = importLeaf(file.name);
  if (!importableExtension(name)) return { ok: false, name, refusal: 'extension' };
  if (file.size > IMPORT_TEXT_LIMIT) return { ok: false, name, refusal: 'toolarge' };

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.length) {
    // An empty file is a valid new document: `loadOfficeFile` gives it an empty model.
    const loaded = await loadOfficeFile(name, bytes);
    return loaded.ok
      ? { ok: true, name, path: importPathFor(name), plan: loaded.plan, model: loaded.model, bytes, empty: true }
      : { ok: false, name, refusal: loaded.refusal === 'binary' ? 'binary' : 'damaged' };
  }
  // `.csv` is decoded as text by the reader anyway; only `.txt` has a binary check.
  if (extensionOf(name) === '.txt' && !looksLikeText(bytes)) return { ok: false, name, refusal: 'binary' };

  const loaded = await loadOfficeFile(name, bytes);
  if (!loaded.ok) return { ok: false, name, refusal: loaded.refusal === 'binary' ? 'binary' : 'damaged' };
  return { ok: true, name, path: importPathFor(name), plan: loaded.plan, model: loaded.model, bytes, empty: loaded.empty };
}

/** URL lifetimes, so a download's Blob URL is always released. */
const REVOKE_MS = 4000;
let pendingRevoke: number | null = null;

/** Saves text or bytes directly from the page. Nothing is uploaded anywhere. */
export function downloadBlob(name: string, data: string | Uint8Array, mime: string, doc: Document = document): void {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();
  if (pendingRevoke !== null) window.clearTimeout(pendingRevoke);
  pendingRevoke = window.setTimeout(() => {
    pendingRevoke = null;
    URL.revokeObjectURL(url);
  }, REVOKE_MS);
}

/**
 * Hands a print-ready page to the browser's own print dialog — where "save as PDF"
 * lives. The frame is a size-zero fixed element rather than `display:none`, because
 * a hidden frame is not printed by every browser.
 */
export function printHtml(html: string, doc: Document = document): void {
  const frame = doc.createElement('iframe');
  frame.className = 'faisal-office-printframe';
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.srcdoc = html;
  frame.addEventListener('load', () => {
    const view = frame.contentWindow;
    if (view && typeof view.print === 'function') {
      view.focus();
      view.print();
    }
    window.setTimeout(() => frame.remove(), 1000);
  });
  doc.body.append(frame);
}
