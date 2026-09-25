/**
 * The change-list reducer behind tracked changes: recording (with author and time), merging a
 * burst of typing into one revision, accept/reject, and what each verdict does to the text.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTHOR, MERGE_MS, applyChangeToText, authorStamp, counts, decide, decideAll, emptyLog,
  pending, planPieces, record, revisionsOf, shiftAfter, type RevisionLog,
} from './revisions';

const at = (ms: number): number => 1_700_000_000_000 + ms;

describe('recording revisions', () => {
  it('stamps the author and the time', () => {
    const log = record(emptyLog(), { kind: 'insert', block: 3, at: 5, text: 'hello', time: at(0) });
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toMatchObject({ kind: 'insert', block: 3, at: 5, text: 'hello', author: DEFAULT_AUTHOR, status: 'pending' });
    expect(log.items[0].time).toBe(at(0));
    expect(authorStamp(log.items[0])).toMatch(/^Faisal OS · \d\d:\d\d$/);
  });

  it('numbers the revisions and ignores an empty change', () => {
    let log = record(emptyLog(), { kind: 'insert', block: 1, at: 0, text: 'a', time: at(0) });
    log = record(log, { kind: 'delete', block: 1, at: 9, text: 'b', time: at(0) });
    expect(log.items.map((r) => r.id)).toEqual([1, 2]);
    expect(record(log, { kind: 'insert', block: 1, at: 0, text: '', time: at(0) })).toBe(log);
  });

  it('merges a burst of typing forward into ONE revision', () => {
    let log = record(emptyLog(), { kind: 'insert', block: 2, at: 0, text: 'Hel', time: at(0) });
    log = record(log, { kind: 'insert', block: 2, at: 3, text: 'lo', time: at(500) });
    expect(log.items).toHaveLength(1);
    expect(log.items[0].text).toBe('Hello');
    expect(log.items[0].time).toBe(at(500));
  });

  it('merges backspacing backwards, keeping the earliest position', () => {
    let log = record(emptyLog(), { kind: 'delete', block: 2, at: 5, text: 'o', time: at(0) });
    log = record(log, { kind: 'delete', block: 2, at: 4, text: 'l', time: at(300) });
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toMatchObject({ at: 4, text: 'lo' });
  });

  it('does not merge a different kind, another paragraph, a gap in time, or a far-away edit', () => {
    const base = record(emptyLog(), { kind: 'insert', block: 2, at: 0, text: 'a', time: at(0) });
    expect(record(base, { kind: 'delete', block: 2, at: 1, text: 'b', time: at(10) }).items).toHaveLength(2);
    expect(record(base, { kind: 'insert', block: 7, at: 1, text: 'b', time: at(10) }).items).toHaveLength(2);
    expect(record(base, { kind: 'insert', block: 2, at: 1, text: 'b', time: at(MERGE_MS + 1) }).items).toHaveLength(2);
    expect(record(base, { kind: 'insert', block: 2, at: 40, text: 'b', time: at(10) }).items).toHaveLength(2);
  });

  it('counts what has been settled and what has not', () => {
    let log: RevisionLog = emptyLog();
    log = record(log, { kind: 'insert', block: 1, at: 0, text: 'a', time: at(0) });
    log = record(log, { kind: 'insert', block: 1, at: 9, text: 'b', time: at(0) });
    log = record(log, { kind: 'insert', block: 1, at: 20, text: 'c', time: at(0) });
    expect(counts(log)).toEqual({ pending: 3, accepted: 0, rejected: 0 });
    log = decide(log, 1, 'accept').log;
    log = decide(log, 2, 'reject').log;
    expect(counts(log)).toEqual({ pending: 1, accepted: 1, rejected: 1 });
    expect(pending(log).map((r) => r.id)).toEqual([3]);
  });
});

describe('accept and reject', () => {
  const withInsert = (): RevisionLog => record(emptyLog(), { kind: 'insert', block: 4, at: 2, text: 'NEW', time: at(0) });
  const withDelete = (): RevisionLog => record(emptyLog(), { kind: 'delete', block: 4, at: 2, text: 'OLD', time: at(0) });

  it('accepting an insertion leaves the text alone', () => {
    const { log, change } = decide(withInsert(), 1, 'accept');
    expect(change?.op).toBe('none');
    expect(applyChangeToText('abNEWcd', change!)).toBe('abNEWcd');
    expect(log.items[0].status).toBe('accepted');
  });

  it('rejecting an insertion takes the text back out', () => {
    const { log, change } = decide(withInsert(), 1, 'reject');
    expect(change?.op).toBe('remove');
    expect(applyChangeToText('abNEWcd', change!)).toBe('abcd');
    expect(log.items[0].status).toBe('rejected');
  });

  it('accepting a deletion leaves the text gone, rejecting it brings the text back', () => {
    const accepted = decide(withDelete(), 1, 'accept');
    expect(accepted.change?.op).toBe('none');
    expect(applyChangeToText('abcd', accepted.change!)).toBe('abcd');
    const rejected = decide(withDelete(), 1, 'reject');
    expect(rejected.change?.op).toBe('restore');
    expect(applyChangeToText('abcd', rejected.change!)).toBe('abOLDcd');
  });

  it('refuses to decide twice, and knows nothing about an unknown id', () => {
    const first = decide(withInsert(), 1, 'accept');
    expect(decide(first.log, 1, 'reject').change).toBeNull();
    expect(decide(withInsert(), 99, 'accept').change).toBeNull();
    expect(decide(withInsert(), 99, 'accept').log.items[0].status).toBe('pending');
  });

  it('settles every pending revision in one call, and stops when there are none', () => {
    let log: RevisionLog = emptyLog();
    log = record(log, { kind: 'insert', block: 1, at: 0, text: 'a', time: at(0) });
    log = record(log, { kind: 'delete', block: 2, at: 9, text: 'b', time: at(0) });
    const all = decideAll(log, 'reject');
    expect(all.changes.map((c) => `${c.block}:${c.op}`)).toEqual(['1:remove', '2:restore']);
    expect(counts(all.log)).toEqual({ pending: 0, accepted: 0, rejected: 2 });
    expect(decideAll(all.log, 'accept').changes).toEqual([]);
  });

  it('applies each change to the paragraph it belongs to', () => {
    const log = record(emptyLog(), { kind: 'insert', block: 1, at: 1, text: 'XY', time: at(0) });
    const { change } = decide(log, 1, 'reject');
    expect(applyChangeToText('aXYb', change!)).toBe('ab');
    expect(applyChangeToText('aXb', change!)).toBe('aXb');       // no match: untouched, never corrupted
  });
});

describe('what changed between two versions of a paragraph', () => {
  it('reports a pure insertion', () => {
    expect(revisionsOf('Hello', 'Hello world')).toEqual([{ kind: 'insert', at: 5, text: ' world' }]);
  });

  it('reports a pure deletion', () => {
    expect(revisionsOf('Hello world', 'Hello')).toEqual([{ kind: 'delete', at: 5, text: ' world' }]);
  });

  it('reports a replacement as a deletion then an insertion', () => {
    expect(revisionsOf('cat', 'dog')).toEqual([
      { kind: 'delete', at: 0, text: 'cat' },
      { kind: 'insert', at: 0, text: 'dog' },
    ]);
  });

  it('reports nothing when nothing changed', () => {
    expect(revisionsOf('same', 'same')).toEqual([]);
  });
});

describe('keeping marks anchored when the text moves', () => {
  it('moves the pending revisions that sit after an edit, and leaves the settled ones alone', () => {
    let log = record(emptyLog(), { kind: 'insert', block: 1, at: 10, text: 'X', time: at(0) });
    log = record(log, { kind: 'insert', block: 1, at: 30, text: 'Y', time: at(10) });
    log = decide(log, 2, 'accept').log;
    const moved = shiftAfter(log, 1, 4, 5);
    expect(moved.items[0].at).toBe(15);
    expect(moved.items[1].at).toBe(30);
  });

  it('moves a mark backwards when text before it is deleted, never below zero', () => {
    const log = record(emptyLog(), { kind: 'insert', block: 1, at: 3, text: 'X', time: at(0) });
    expect(shiftAfter(log, 1, 0, -2).items[0].at).toBe(1);
    expect(shiftAfter(log, 1, 0, -10).items[0].at).toBe(0);
  });

  it('touches nothing for another paragraph, an edit after the mark, or no change at all', () => {
    const log = record(emptyLog(), { kind: 'insert', block: 1, at: 10, text: 'X', time: at(0) });
    expect(shiftAfter(log, 2, 0, 5)).toBe(log);
    expect(shiftAfter(log, 1, 20, 5)).toBe(log);
    expect(shiftAfter(log, 1, 0, 0)).toBe(log);
  });

  it('keeps a mark drawable after an earlier edit moved the paragraph', () => {
    // The paragraph is "abcdef"; a change marked at 4 ("ef") must survive "ab" being deleted.
    const log = shiftAfter(record(emptyLog(), { kind: 'insert', block: 7, at: 4, text: 'ef', time: at(0) }), 7, 0, -2);
    const pieces = planPieces('cdef', log.items, 7);
    expect(pieces.filter((p) => p.mark === 'insert').map((p) => p.text)).toEqual(['ef']);
  });
});

describe('drawing a paragraph', () => {
  const insert = { id: 1, kind: 'insert' as const, block: 5, at: 2, text: 'NEW', author: 'A', time: at(0), status: 'pending' as const };
  const remove = { id: 2, kind: 'delete' as const, block: 5, at: 2, text: 'OLD', author: 'A', time: at(0), status: 'pending' as const };

  it('marks the inserted characters where they are', () => {
    expect(planPieces('abNEWcd', [insert], 5)).toEqual([
      { text: 'ab', mark: 'none' },
      { text: 'NEW', mark: 'insert', id: 1, revision: insert },
      { text: 'cd', mark: 'none' },
    ]);
  });

  it('puts the deleted text back in place, marked', () => {
    expect(planPieces('abcd', [remove], 5)).toEqual([
      { text: 'ab', mark: 'none' },
      { text: 'OLD', mark: 'delete', id: 2, revision: remove },
      { text: 'cd', mark: 'none' },
    ]);
  });

  it('shows a replacement as the old text and the new one, both marked', () => {
    const pieces = planPieces('abNEWcd', [insert, remove], 5);
    expect(pieces.map((p) => `${p.mark}:${p.text}`)).toEqual(['none:ab', 'delete:OLD', 'insert:NEW', 'none:cd']);
  });

  it('ignores another paragraph, settled revisions, and an insertion that is no longer there', () => {
    expect(planPieces('abNEWcd', [{ ...insert, block: 9 }], 5)).toEqual([{ text: 'abNEWcd', mark: 'none' }]);
    expect(planPieces('abNEWcd', [{ ...insert, status: 'accepted' }], 5)).toEqual([{ text: 'abNEWcd', mark: 'none' }]);
    expect(planPieces('abcd', [insert], 5)).toEqual([{ text: 'abcd', mark: 'none' }]);
  });

  it('never loses a character of the paragraph', () => {
    const text = 'The quick brown fox';
    const pieces = planPieces(text, [insert, remove], 5);
    expect(pieces.filter((p) => p.mark !== 'delete').map((p) => p.text).join('')).toBe(text);
  });
});
