/**
 * Writer — tracked changes (تتبّع التعديلات), the pure part.
 *
 * Every edit made while tracking is on is recorded as a REVISION: what changed (an insertion or a
 * deletion), where, by whom and when. The document itself is edited as usual — the log is the
 * record of what happened, and accepting or rejecting a revision turns into a plain paragraph edit
 * (`remove` the inserted characters, or `restore` the deleted ones), so undo/redo and the save
 * keep working exactly as they did.
 *
 * Nothing here touches the DOM, so the whole decision surface (record, merge a burst of typing
 * into one revision, accept, reject, and what each verdict does to the text) is testable.
 */
import { diffText } from './docops';

export type RevisionKind = 'insert' | 'delete';
export type RevisionStatus = 'pending' | 'accepted' | 'rejected';
export type RevisionAction = 'accept' | 'reject';

export interface Revision {
  id: number;
  kind: RevisionKind;
  /** The paragraph's stable id (not its index: paragraphs move). */
  block: number;
  /** Offset of the changed text in the paragraph the edit produced. */
  at: number;
  text: string;
  author: string;
  /** Epoch milliseconds. */
  time: number;
  status: RevisionStatus;
}

export interface RevisionLog {
  nextId: number;
  items: Revision[];
}

/**
 * The author stamped on a revision. This app has no user profile yet, so every change is stamped
 * with the one name the OS knows; a settings slice can replace it without touching this module.
 */
export const DEFAULT_AUTHOR = 'Faisal OS';

/** A burst of typing in the same place within this window is ONE revision, not one per keystroke. */
export const MERGE_MS = 4000;

export function emptyLog(): RevisionLog {
  return { nextId: 1, items: [] };
}

export interface NewRevision {
  kind: RevisionKind;
  block: number;
  at: number;
  text: string;
  author?: string;
  time?: number;
}

/**
 * Records one change, merging it into the revision it continues: same kind, same paragraph, same
 * author, within `mergeMs`, and immediately adjacent (typing forward, or backspacing backwards).
 */
export function record(log: RevisionLog, entry: NewRevision, opts: { mergeMs?: number } = {}): RevisionLog {
  const author = entry.author ?? DEFAULT_AUTHOR;
  const time = entry.time ?? Date.now();
  const mergeMs = opts.mergeMs ?? MERGE_MS;
  if (!entry.text) return log;
  const last = log.items[log.items.length - 1];
  if (last && last.status === 'pending' && last.kind === entry.kind && last.block === entry.block
      && last.author === author && time - last.time <= mergeMs) {
    // Typing forward: the new text starts where the previous one ended.
    if (last.kind === 'insert' && entry.at === last.at + last.text.length) {
      const merged: Revision = { ...last, text: last.text + entry.text, time };
      return { ...log, items: [...log.items.slice(0, -1), merged] };
    }
    // Backspacing: the deleted text sits just before the previous deletion.
    if (last.kind === 'delete' && entry.at + entry.text.length === last.at) {
      const merged: Revision = { ...last, at: entry.at, text: entry.text + last.text, time };
      return { ...log, items: [...log.items.slice(0, -1), merged] };
    }
  }
  return { nextId: log.nextId + 1, items: [...log.items, { id: log.nextId, kind: entry.kind, block: entry.block, at: entry.at, text: entry.text, author, time, status: 'pending' }] };
}

export function pending(log: RevisionLog): Revision[] {
  return log.items.filter((r) => r.status === 'pending');
}

export function counts(log: RevisionLog): { pending: number; accepted: number; rejected: number } {
  let accepted = 0;
  let rejected = 0;
  for (const r of log.items) {
    if (r.status === 'accepted') accepted++;
    else if (r.status === 'rejected') rejected++;
  }
  return { pending: log.items.length - accepted - rejected, accepted, rejected };
}

/** What a verdict does to the paragraph's text. */
export interface Change {
  kind: RevisionKind;
  block: number;
  at: number;
  text: string;
  op: 'none' | 'remove' | 'restore';
}

/**
 * The verdict on one revision: accept keeps what the document already shows (the typed text stays,
 * the deleted text stays gone); reject undoes it in the document (removes the typed text, restores
 * the deleted one).
 */
export function decide(log: RevisionLog, id: number, action: RevisionAction): { log: RevisionLog; change: Change | null } {
  const item = log.items.find((r) => r.id === id);
  if (!item || item.status !== 'pending') return { log, change: null };
  const status: RevisionStatus = action === 'accept' ? 'accepted' : 'rejected';
  const op: Change['op'] = action === 'accept' ? 'none' : item.kind === 'insert' ? 'remove' : 'restore';
  const next: RevisionLog = { ...log, items: log.items.map((r) => (r.id === id ? { ...r, status } : r)) };
  return { log: next, change: { kind: item.kind, block: item.block, at: item.at, text: item.text, op } };
}

/** The same verdict on every pending revision, in one go. */
export function decideAll(log: RevisionLog, action: RevisionAction): { log: RevisionLog; changes: Change[] } {
  let next = log;
  const changes: Change[] = [];
  for (const item of pending(log)) {
    const done = decide(next, item.id, action);
    next = done.log;
    if (done.change) changes.push(done.change);
  }
  return { log: next, changes };
}

/** The paragraph text after a change is applied (the view writes this back through an edit). */
export function applyChangeToText(text: string, change: Change): string {
  if (change.op === 'none') return text;
  if (change.op === 'remove') {
    const before = text.slice(0, change.at);
    const after = text.slice(change.at);
    return after.startsWith(change.text) ? before + after.slice(change.text.length) : text;
  }
  const at = Math.max(0, Math.min(change.at, text.length));
  return text.slice(0, at) + change.text + text.slice(at);
}

/** One piece of a paragraph as the editor draws it. */
export interface Piece {
  text: string;
  mark: 'none' | 'insert' | 'delete';
  /** The revision this piece belongs to, when it is a marked one. */
  id?: number;
  revision?: Revision;
}

/**
 * How to draw a paragraph: the text it now holds, with the pending insertions marked where they
 * are and the pending deletions put back in place (struck through) so the owner can see what the
 * document would say if the deletion were rejected.
 */
export function planPieces(text: string, revisions: readonly Revision[], block: number): Piece[] {
  const marks: Array<{ at: number; length: number; piece: Piece }> = [];
  for (const rev of revisions) {
    if (rev.status !== 'pending' || rev.block !== block) continue;
    if (rev.kind === 'insert') {
      // The text is in the paragraph already; mark the characters it occupies.
      if (text.slice(rev.at, rev.at + rev.text.length) !== rev.text) continue;
      marks.push({ at: rev.at, length: rev.text.length, piece: { text: rev.text, mark: 'insert', id: rev.id, revision: rev } });
    } else {
      // The text is gone from the paragraph: put it back, marked, without it being part of the text.
      marks.push({ at: Math.max(0, Math.min(rev.at, text.length)), length: 0, piece: { text: rev.text, mark: 'delete', id: rev.id, revision: rev } });
    }
  }
  marks.sort((a, b) => (a.at - b.at) || (a.length - b.length));
  const pieces: Piece[] = [];
  const push = (piece: Piece): void => {
    if (!piece.text) return;
    const last = pieces[pieces.length - 1];
    if (last && last.mark === piece.mark && last.id === piece.id) { last.text += piece.text; return; }
    pieces.push(piece);
  };
  let at = 0;
  for (const mark of marks) {
    if (mark.at > at) push({ text: text.slice(at, mark.at), mark: 'none' });
    push(mark.piece);
    if (mark.length) at = mark.at + mark.length;
    else at = mark.at;
  }
  if (at < text.length) push({ text: text.slice(at), mark: 'none' });
  return pieces;
}

/**
 * What changed between two versions of a paragraph, as revisions to record: a deletion (the text
 * that went away) and an insertion (the text that arrived), in that order. Returns nothing when
 * the two are the same.
 */
export function revisionsOf(before: string, after: string): Array<{ kind: RevisionKind; at: number; text: string }> {
  if (before === after) return [];
  const { start, del, ins } = diffText(before, after);
  const out: Array<{ kind: RevisionKind; at: number; text: string }> = [];
  if (del > 0) out.push({ kind: 'delete', at: start, text: before.slice(start, start + del) });
  if (ins) out.push({ kind: 'insert', at: start, text: ins });
  return out;
}

/** "Faisal OS · 12:34" — the stamp shown on a revision. */
export function authorStamp(rev: Revision): string {
  const at = new Date(rev.time);
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${rev.author} · ${hh}:${mm}`;
}
