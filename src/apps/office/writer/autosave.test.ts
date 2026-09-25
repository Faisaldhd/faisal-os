/**
 * Writer's autosave decision logic, and the rules about the recovery copy's name and age.
 *
 * These are the tests the slice was asked for: WHEN does the timer write, and WHICH recovery copy
 * is worth offering. No DOM, no file system — the browser proof covers the wiring.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTOSAVE_INTERVALS, AUTOSAVE_KEY, DEFAULT_AUTOSAVE, clampInterval, documentOfRecovery,
  formatClock, newestRecovery, parseAutosavePrefs, recoveryPathFor, serializeAutosavePrefs,
  shouldAutosave, type AutosaveFacts,
} from './autosave';

const facts = (over: Partial<AutosaveFacts> = {}): AutosaveFacts => ({
  on: true,
  seconds: 30,
  dirty: true,
  saving: false,
  editSeq: 5,
  writtenSeq: 4,
  sinceEditMs: 30_000,
  ...over,
});

describe('when autosave may write', () => {
  it('writes after the interval has passed quietly on a changed document', () => {
    expect(shouldAutosave(facts())).toBe(true);
    expect(shouldAutosave(facts({ sinceEditMs: 29_999 }))).toBe(false);
    expect(shouldAutosave(facts({ sinceEditMs: 30_000 }))).toBe(true);
  });

  it('never writes while autosave is off, or a document is clean', () => {
    expect(shouldAutosave(facts({ on: false }))).toBe(false);
    expect(shouldAutosave(facts({ dirty: false }))).toBe(false);
  });

  it('never writes during an explicit save', () => {
    expect(shouldAutosave(facts({ saving: true }))).toBe(false);
  });

  it('writes once per change, not once per tick: the same content is never rewritten', () => {
    // Written for edit 5: the document is still dirty (only an explicit save cleans it) but there
    // is nothing new to copy, so the timer stays quiet however long it runs.
    expect(shouldAutosave(facts({ editSeq: 5, writtenSeq: 5, sinceEditMs: 600_000 }))).toBe(false);
    expect(shouldAutosave(facts({ editSeq: 6, writtenSeq: 5, sinceEditMs: 30_000 }))).toBe(true);
  });

  it('honours the chosen interval', () => {
    expect(shouldAutosave(facts({ seconds: 15, sinceEditMs: 15_000 }))).toBe(true);
    expect(shouldAutosave(facts({ seconds: 120, sinceEditMs: 119_000 }))).toBe(false);
    expect(shouldAutosave(facts({ seconds: 120, sinceEditMs: 120_000 }))).toBe(true);
  });

  it('falls back to the default interval for a value nobody offered', () => {
    // A hand-edited setting must not become a one-second writer.
    expect(shouldAutosave(facts({ seconds: 1, sinceEditMs: 1_000 }))).toBe(false);
    expect(shouldAutosave(facts({ seconds: 1, sinceEditMs: DEFAULT_AUTOSAVE.seconds * 1000 }))).toBe(true);
    expect(shouldAutosave(facts({ seconds: Number.NaN, sinceEditMs: 30_000 }))).toBe(true);
  });
});

describe('the recovery copy', () => {
  it('lives beside the document, under the document’s own name', () => {
    expect(recoveryPathFor('/home/user/Documents/notes.docx')).toBe('/home/user/Documents/notes.docx.autosave');
    expect(documentOfRecovery('/home/user/Documents/notes.docx.autosave')).toBe('/home/user/Documents/notes.docx');
    expect(documentOfRecovery('/home/user/Documents/notes.docx')).toBeNull();
  });

  it('is offered only when it is NEWER than the file it belongs to', () => {
    const doc = '/home/user/Documents/notes.docx';
    const older = [{ path: recoveryPathFor(doc), mtime: 1000 }];
    const newer = [{ path: recoveryPathFor(doc), mtime: 2000 }];
    expect(newestRecovery(newer, doc, 1500)).toEqual({ path: recoveryPathFor(doc), mtime: 2000 });
    expect(newestRecovery(older, doc, 1500)).toBeNull();     // the file was saved after the copy
    expect(newestRecovery(newer, doc, 2000)).toBeNull();     // equal: the file is the same age
  });

  it('ignores another document’s copy and other files in the folder', () => {
    const doc = '/home/user/Documents/notes.docx';
    const entries = [
      { path: '/home/user/Documents/other.docx.autosave', mtime: 9000 },
      { path: '/home/user/Documents/notes.docx.bak', mtime: 9000 },
      { path: '/home/user/Documents/notes.docx', mtime: 9000 },
    ];
    expect(newestRecovery(entries, doc, 1000)).toBeNull();
  });

  it('picks the newest copy when several match', () => {
    const doc = '/home/user/Documents/notes.docx';
    const wanted = recoveryPathFor(doc);
    const entries = [{ path: wanted, mtime: 2000 }, { path: wanted, mtime: 5000 }, { path: wanted, mtime: 3000 }];
    expect(newestRecovery(entries, doc, 1000)?.mtime).toBe(5000);
  });
});

describe('the settings', () => {
  it('defaults to on, every thirty seconds', () => {
    expect(DEFAULT_AUTOSAVE).toEqual({ on: true, seconds: 30 });
    expect(parseAutosavePrefs(null)).toEqual(DEFAULT_AUTOSAVE);
    expect(parseAutosavePrefs('not json')).toEqual(DEFAULT_AUTOSAVE);
    expect(parseAutosavePrefs('"a string"')).toEqual(DEFAULT_AUTOSAVE);
    expect(parseAutosavePrefs('{"on":"yes"}')).toEqual(DEFAULT_AUTOSAVE);
  });

  it('round-trips the choices it offers, and only those', () => {
    for (const seconds of AUTOSAVE_INTERVALS) {
      const prefs = { on: false, seconds };
      expect(parseAutosavePrefs(serializeAutosavePrefs(prefs))).toEqual(prefs);
    }
    expect(parseAutosavePrefs('{"on":false,"seconds":7}')).toEqual({ on: false, seconds: 15 });
    expect(serializeAutosavePrefs({ on: true, seconds: 7 })).toBe('{"on":true,"seconds":15}');
  });

  it('clamps any number to the nearest offered interval', () => {
    expect(clampInterval(1)).toBe(15);
    expect(clampInterval(29)).toBe(30);
    expect(clampInterval(45)).toBe(30);
    expect(clampInterval(1000)).toBe(120);
    expect(clampInterval(Number.POSITIVE_INFINITY)).toBe(30);
  });

  it('has one storage key', () => {
    expect(AUTOSAVE_KEY).toBe('faisal.office.autosave');
  });
});

describe('the clock in the status line', () => {
  it('reads as a two-digit 24-hour time', () => {
    expect(formatClock(new Date(2026, 0, 2, 9, 5))).toBe('09:05');
    expect(formatClock(new Date(2026, 0, 2, 23, 59))).toBe('23:59');
    expect(formatClock(new Date(2026, 0, 2, 0, 0))).toBe('00:00');
  });
});
