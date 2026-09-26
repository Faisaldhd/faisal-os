/**
 * Writer — the footnotes and endnotes UI (واجهة الحواشي والنهايات).
 *
 * The file and model layer of notes is merged and tested on its own (`notemodel.test.ts`,
 * `footnotes-docx.test.ts`); this suite is about what the owner touches: the number drawn at the
 * reference, the commands that insert and delete a note, and the panel that edits its text.
 *
 * TWO RULES THIS FILE EXISTS TO KEEP:
 *  • the number is a MARKER (`data-skip` + `contentEditable=false`), never text: the editor reads a
 *    paragraph back from the page after an input method composes into it, and only `data-skip` keeps
 *    that number out of the model. The "read back" test below fails the moment that is dropped.
 *  • deleting a reference deletes the note, and it does so through `removeNote` — no note is ever
 *    left behind in the model.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { t } from '../../../kernel/i18n';
import type { EditorContext } from '../editor';
import type { DocModel } from '../model';
import type { ButtonControl } from '../ui/ribbon';
import '../strings';
import { blockText, type DocBlock, type NoteInfo, type Run } from './types';
import { createWriter, documentNotes, runIndexAt, runTextOffset, splitRunsAt } from './view';

const text = (value: string): Run => ({ t: 'text', text: value, props: {} });

const noteRun = (kind: 'footnote' | 'endnote', id: number, noteText: string): Run =>
  ({ t: 'opaque', text: '', xml: '', kind: 'note', note: { kind, id, text: noteText, fresh: true } satisfies NoteInfo });

/** Every note of a model, in reading order. */
function notes(model: DocModel): NoteInfo[] {
  const out: NoteInfo[] = [];
  for (const block of model.blocks ?? []) {
    for (const run of block.runs) if (run.t === 'opaque' && run.kind === 'note' && run.note) out.push(run.note);
  }
  return out;
}

interface Mounted {
  model(): DocModel;
  statuses: string[];
  flow: HTMLElement;
  panel(): HTMLElement;
  /** The paragraphs of the page as they are RIGHT NOW (a redraw replaces them). */
  paras(): HTMLElement[];
  /** Runs a ribbon command by its control id, exactly as its button would. */
  run(id: string): void;
  enabled(id: string): boolean;
  dispose(): void;
}

const live: Array<{ dispose(): void }> = [];

/** The Writer over an in-memory model: the same editor the window mounts, with no file behind it. */
function mount(blocks: DocBlock[], editable = true): Mounted {
  let model: DocModel = { kind: 'docx', paragraphs: blocks.map(blockText), blocks };
  const statuses: string[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const ctx: EditorContext = {
    model: () => model,
    commit: (edit) => { model = edit.apply(model) as DocModel; },
    undo: () => undefined,
    redo: () => undefined,
    editable: () => editable,
    refresh: () => undefined,
    setStatus: (value) => { statuses.push(value); },
    host: () => host,
    filePath: () => null,
    fileTab: () => ({ id: 'file', label: 'File', groups: [] }),
    exportFile: async () => undefined,
    print: () => undefined,
  };
  const editor = createWriter(ctx, null);
  host.append(editor.element);
  editor.render();
  live.push(editor);
  const controls = new Map<string, ButtonControl>();
  for (const tab of editor.tabs()) for (const group of tab.groups) for (const control of group.controls) controls.set(control.id, control as ButtonControl);
  const flow = (): HTMLElement => editor.element.querySelector<HTMLElement>('.fo-flow') as HTMLElement;
  return {
    model: () => model,
    statuses,
    get flow() { return flow(); },
    panel: () => editor.element.querySelector<HTMLElement>('.fo-side') as HTMLElement,
    paras: () => [...flow().querySelectorAll<HTMLElement>('.fo-p')],
    run: (id) => {
      const control = controls.get(id);
      if (!control) throw new Error(`no ribbon control named ${id}`);
      control.run();
    },
    enabled: (id) => controls.get(id)?.enabled?.() ?? true,
    dispose: () => editor.dispose(),
  };
}

/** Puts the caret at `offset` characters into a paragraph, the way a click would. */
function caretIn(p: HTMLElement, offset: number): void {
  const node = p.querySelector('.fo-r')?.firstChild ?? p;
  const range = document.createRange();
  range.setStart(node, node.nodeType === Node.TEXT_NODE ? Math.min(offset, (node as Text).data.length) : 0);
  range.collapse(true);
  caretAt(range);
}

/** Puts the caret right before or right after one node (the seam around a note's number). */
function caretBeside(node: Node, side: 'before' | 'after'): void {
  const range = document.createRange();
  if (side === 'before') range.setStartBefore(node);
  else range.setStartAfter(node);
  range.collapse(true);
  caretAt(range);
}

function caretAt(range: Range): void {
  const selection = window.getSelection();
  if (!selection) throw new Error('jsdom has no selection');
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

/** The browser's own input path: the paragraph is read back from the page and diffed against the model. */
function readBack(m: Mounted, p: HTMLElement, offset = 1): void {
  caretIn(p, offset);
  m.flow.dispatchEvent(new Event('input', { bubbles: true }));
}

/** A key press as the browser reports it, which is how the editor receives every edit. */
function press(m: Mounted, inputType: string): void {
  m.flow.dispatchEvent(new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }));
}

const badgeOf = (p: HTMLElement): HTMLElement | null => p.querySelector<HTMLElement>('.fo-note');
const badgeText = (p: HTMLElement): string[] => [...p.querySelectorAll<HTMLElement>('.fo-note')].map((n) => n.textContent ?? '');

/** Types into the note field of a card in the panel, which is how a note's text is written. */
function typeNote(m: Mounted, value: string, card = 0): HTMLTextAreaElement {
  const field = [...m.panel().querySelectorAll<HTMLTextAreaElement>('.fo-note-field')][card];
  if (!field) throw new Error(`no note field at ${card}`);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return field;
}

beforeEach(() => {
  // jsdom has no `scrollIntoView` (a browser always does): the panel and "show in document" scroll,
  // and this suite is about what those actions DO, not about a jsdom gap.
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  while (live.length) live.pop()?.dispose();
  document.body.textContent = '';
});

/* ───────────────────────── the number a reference shows ───────────────────────── */

describe('the numbers a document shows', () => {
  it('numbers footnotes and endnotes in two separate sequences, in reading order', () => {
    const blocks: DocBlock[] = [
      { id: 0, runs: [text('أ'), noteRun('footnote', 2, 'ح١')] },
      { id: 1, runs: [noteRun('endnote', 5, 'ن١'), text('ب'), noteRun('footnote', 9, 'ح٢')] },
    ];
    expect(documentNotes(blocks).map((n) => `${n.kind}${n.number}@${n.blockId}:${n.runIndex}`))
      .toEqual(['footnote1@0:1', 'endnote1@1:0', 'footnote2@1:2']);
  });

  it('takes the order from the document, so ids the file chose cannot change what is shown', () => {
    // Word writes its own ids; the number the reader sees is the position among notes of that kind.
    const blocks: DocBlock[] = [
      { id: 0, runs: [noteRun('footnote', 40, '')] },
      { id: 1, runs: [noteRun('footnote', 7, '')] },
    ];
    expect(documentNotes(blocks).map((n) => n.number)).toEqual([1, 2]);
  });
});

describe('splitting a paragraph at the caret', () => {
  it('makes a boundary exactly at the offset, and names where a zero-width element goes', () => {
    const split = splitRunsAt([text('Hello world')], 5);
    expect(split.map((run) => run.text)).toEqual(['Hello', ' world']);
    expect(runIndexAt(split, 5)).toBe(1);
    expect(runIndexAt(split, 0)).toBe(0);
    expect(runIndexAt(split, 11)).toBe(2);
    expect(runTextOffset(split, 1)).toBe(5);
    expect(runTextOffset(split, 2)).toBe(11);
  });

  it('leaves runs alone when the offset already falls on a boundary', () => {
    const runs = [text('Hi'), noteRun('footnote', 2, '')];
    expect(splitRunsAt(runs, 2)).toHaveLength(2);
    // At the seam of an existing reference the new one goes before it, never after the paragraph.
    expect(runIndexAt(runs, 2)).toBe(1);
  });
});

/* ───────────────────────── inserting at the caret ───────────────────────── */

describe('inserting a note at the caret', () => {
  it('puts the reference at the caret and draws the number as a marker, not as text', () => {
    const m = mount([{ id: 0, runs: [text('Hello world')] }]);
    caretIn(m.paras()[0], 5);
    m.run('footnote');

    // The number is on the page but NOT in the document's text.
    expect(m.model().paragraphs[0]).toBe('Hello world');
    expect(blockText(m.model().blocks?.[0] as DocBlock)).toBe('Hello world');
    const badge = badgeOf(m.paras()[0]);
    expect(badge?.textContent).toBe('1');
    expect(badge?.dataset.skip).toBe('1');
    expect(badge?.contentEditable).toBe('false');
    expect(badge?.getAttribute('aria-label')).toBe(t('office.footnoteRef', { n: 1 }));
    // The reference sits BETWEEN the two halves of the split paragraph.
    const kids = [...(m.paras()[0].childNodes)];
    expect(kids.map((n) => (n as HTMLElement).className)).toEqual(['fo-r', 'fo-op fo-op-note fo-note is-footnote', 'fo-r']);
    expect((kids[0] as HTMLElement).textContent).toBe('Hello');
    expect((kids[2] as HTMLElement).textContent).toBe(' world');
    expect(notes(m.model())).toHaveLength(1);
    expect(notes(m.model())[0]).toMatchObject({ kind: 'footnote', text: '' });
  });

  it('never lets the number leak into the paragraph when the browser reads the page back', () => {
    const m = mount([{ id: 0, runs: [text('Hello world')] }]);
    caretIn(m.paras()[0], 5);
    m.run('footnote');

    // This is the silent-corruption path: an input method composes into the paragraph, the paragraph
    // is read back from the page, and everything visible without `data-skip` becomes document text.
    readBack(m, m.paras()[0], 3);
    expect(m.model().paragraphs[0]).toBe('Hello world');
    expect(blockText(m.model().blocks?.[0] as DocBlock)).toBe('Hello world');
    expect(m.paras()[0].textContent).toBe('Hello1 world'); // the badge is still drawn, and still a marker
  });

  it('renumbers the references that follow when a note lands before them', () => {
    const m = mount([{ id: 0, runs: [text('one')] }, { id: 1, runs: [text('two')] }]);
    caretIn(m.paras()[1], 3);
    m.run('footnote');
    caretIn(m.paras()[0], 3);
    m.run('footnote');

    expect(badgeText(m.paras()[0])).toEqual(['1']);
    expect(badgeText(m.paras()[1])).toEqual(['2']);
    expect(documentNotes(m.model().blocks ?? []).map((n) => n.number)).toEqual([1, 2]);
  });

  it('inserts an endnote as its own kind, with a number of its own', () => {
    const m = mount([{ id: 0, runs: [text('one')] }, { id: 1, runs: [text('two')] }]);
    caretIn(m.paras()[0], 3);
    m.run('footnote');
    caretIn(m.paras()[1], 3);
    m.run('endnote');

    expect(badgeOf(m.paras()[1])?.classList.contains('is-endnote')).toBe(true);
    expect(badgeText(m.paras()[1])).toEqual(['1']);
    expect(documentNotes(m.model().blocks ?? []).map((n) => `${n.kind}${n.number}`)).toEqual(['footnote1', 'endnote1']);
  });

  it('inserts at the end of the last paragraph when the document was never clicked', () => {
    const m = mount([{ id: 0, runs: [text('first')] }, { id: 1, runs: [text('last')] }]);
    m.run('footnote');
    expect(badgeText(m.paras()[0])).toEqual([]);
    expect(badgeText(m.paras()[1])).toEqual(['1']);
    expect(m.model().paragraphs).toEqual(['first', 'last']);
  });

  it('refuses to insert into a paragraph whose file structure cannot be rewritten', () => {
    const m = mount([{ id: 0, runs: [text('locked')], locked: true }]);
    caretIn(m.paras()[0], 3);
    m.run('footnote');
    expect(notes(m.model())).toEqual([]);
    expect(m.statuses).toContain(t('office.noteLocked'));
  });

  it('does nothing in a read-only document (and says so through the button)', () => {
    const m = mount([{ id: 0, runs: [text('x')] }], false);
    expect(m.enabled('footnote')).toBe(false);
    expect(m.enabled('endnote')).toBe(false);
    m.run('footnote');
    expect(notes(m.model())).toEqual([]);
  });

  it('refuses to change the notes when the file holds a reference it could not read', () => {
    // A reference whose note is not in the package: shown as a marker that claims no number, and
    // nothing about the notes may be touched — the save would rebuild the part from the model alone.
    const dangling: Run = { t: 'opaque', text: '', xml: '', kind: 'note', ref: 'footnote' };
    const m = mount([{ id: 0, runs: [dangling, text('نصّ')] }]);
    const badge = badgeOf(m.paras()[0]);
    expect(badge?.textContent).toBe('?');
    expect(badge?.dataset.skip).toBe('1');
    expect(badge?.contentEditable).toBe('false');
    expect(badge?.getAttribute('aria-label')).toBe(t('office.noteMissing'));

    caretIn(m.paras()[0], 1);
    m.run('footnote');
    expect(notes(m.model())).toEqual([]);
    expect(m.statuses).toContain(t('office.noteUnreadable'));
  });

  it('does not mistake a comment mark for a note it could not read', () => {
    // A comment reference is a note-kind run with no note BY DESIGN: it must not block the notes.
    const comment: Run = { t: 'opaque', text: '', xml: '', kind: 'note', ref: 'comment' };
    const m = mount([{ id: 0, runs: [comment, text('نصّ')] }]);
    expect(badgeOf(m.paras()[0])).toBeNull();
    caretIn(m.paras()[0], 1);
    m.run('footnote');
    expect(notes(m.model())).toHaveLength(1);
    expect(badgeText(m.paras()[0])).toEqual(['1']);
  });
});

/* ───────────────────────── the panel: text, list, delete ───────────────────────── */

describe('the notes panel', () => {
  it('opens on the new note, with the caret in its text, and writes what is typed into the note', () => {
    const m = mount([{ id: 0, runs: [text('Hello')] }]);
    caretIn(m.paras()[0], 5);
    m.run('footnote');

    const field = m.panel().querySelector<HTMLTextAreaElement>('.fo-note-field');
    expect(field).toBeTruthy();
    expect(field?.readOnly).toBe(false);
    expect(document.activeElement).toBe(field);
    expect(field?.getAttribute('aria-label')).toBe(t('office.noteTextLabel', { n: 1 }));

    typeNote(m, 'نصّ الحاشية');
    expect(notes(m.model())[0].text).toBe('نصّ الحاشية');
    // The note's text lives in the note, never in the paragraph that points at it.
    expect(m.model().paragraphs[0]).toBe('Hello');
    expect(m.paras()[0].textContent).toBe('Hello1');
  });

  it('lists footnotes and endnotes in two groups, each numbered from one', () => {
    const m = mount([{ id: 0, runs: [text('one')] }, { id: 1, runs: [text('two')] }]);
    caretIn(m.paras()[0], 3);
    m.run('footnote');
    typeNote(m, 'حاشية', 0);
    caretIn(m.paras()[1], 3);
    m.run('endnote');
    typeNote(m, 'نهاية', 1);

    expect([...m.panel().querySelectorAll('.fo-notes-group')].map((n) => n.textContent))
      .toEqual([t('office.footnotesTitle'), t('office.endnotesTitle')]);
    expect([...m.panel().querySelectorAll('.fo-note-badge')].map((n) => n.textContent)).toEqual(['1', '1']);
    expect([...m.panel().querySelectorAll<HTMLTextAreaElement>('.fo-note-field')].map((n) => n.value))
      .toEqual(['حاشية', 'نهاية']);
  });

  it('shows the empty state when the document has no notes', () => {
    const m = mount([{ id: 0, runs: [text('بلا حواشٍ')] }]);
    m.run('notespanel');
    expect(m.panel().querySelector('.fo-empty-small')?.textContent).toBe(t('office.notesEmpty'));
    expect(m.panel().querySelectorAll('.fo-note-card')).toHaveLength(0);
  });

  it('deletes through the panel: the reference, its text and its number all go, and the rest close the gap', () => {
    const m = mount([{ id: 0, runs: [text('one')] }, { id: 1, runs: [text('two')] }]);
    caretIn(m.paras()[0], 3);
    m.run('footnote');
    typeNote(m, 'الأولى', 0);
    caretIn(m.paras()[1], 3);
    m.run('footnote');
    typeNote(m, 'الثانية', 1);
    expect([...m.panel().querySelectorAll('.fo-note-card')]).toHaveLength(2);

    const remove = [...m.panel().querySelectorAll<HTMLButtonElement>('.fo-note-btn.is-danger')][0];
    expect(remove.textContent).toBe(t('office.noteDelete', { n: 1 }));
    remove.click();

    const left = notes(m.model());
    expect(left).toHaveLength(1);
    expect(left[0].text).toBe('الثانية');
    expect(left[0].id).toBe(2); // renumbered: the gap the deleted note left is closed in the model
    expect(badgeText(m.paras()[0])).toEqual([]);
    expect(badgeText(m.paras()[1])).toEqual(['1']);
    expect(m.statuses).toContain(t('office.noteDeleted'));
  });

  it('deletes nothing when the document is read-only', () => {
    const m = mount([{ id: 0, runs: [text('one'), noteRun('footnote', 2, 'محفوظة')] }], false);
    m.run('notespanel');
    const remove = m.panel().querySelector<HTMLButtonElement>('.fo-note-btn.is-danger');
    expect(remove?.disabled).toBe(true);
    expect(notes(m.model())).toHaveLength(1);
  });
});

/* ───────────────────────── deleting the reference from the page ───────────────────────── */

describe('backspace and delete against a number', () => {
  it('deletes the note when Backspace is pressed right after its number', () => {
    const m = mount([{ id: 0, runs: [text('Hello')] }]);
    caretIn(m.paras()[0], 5);
    m.run('footnote');
    typeNote(m, 'ملاحظة');
    caretBeside(badgeOf(m.paras()[0]) as HTMLElement, 'after');
    press(m, 'deleteContentBackward');

    expect(notes(m.model())).toEqual([]);
    expect(m.model().paragraphs[0]).toBe('Hello');
    expect(badgeText(m.paras()[0])).toEqual([]);
  });

  it('still deletes letters when Backspace is pressed inside the text before the number', () => {
    const m = mount([{ id: 0, runs: [text('Hello')] }]);
    caretIn(m.paras()[0], 5);
    m.run('footnote');
    caretIn(m.paras()[0], 3);
    press(m, 'deleteContentBackward');

    expect(m.model().paragraphs[0]).toBe('Helo');
    expect(notes(m.model())).toHaveLength(1);
  });

  it('deletes the note when Delete is pressed right before its number', () => {
    const m = mount([{ id: 0, runs: [text('Hello world')] }]);
    caretIn(m.paras()[0], 5);
    m.run('footnote');
    caretBeside(badgeOf(m.paras()[0]) as HTMLElement, 'before');
    press(m, 'deleteContentForward');

    expect(notes(m.model())).toEqual([]);
    expect(m.model().paragraphs[0]).toBe('Hello world');
  });

  it('deletes the following letter, not the note, when Delete is pressed right after it', () => {
    const m = mount([{ id: 0, runs: [text('Hello world')] }]);
    caretIn(m.paras()[0], 5);
    m.run('footnote');
    caretBeside(badgeOf(m.paras()[0]) as HTMLElement, 'after');
    press(m, 'deleteContentForward');

    expect(m.model().paragraphs[0]).toBe('Helloworld');
    expect(notes(m.model())).toHaveLength(1);
  });
});

/* ───────────────────────── accessibility of the number ───────────────────────── */

describe('reaching a note from its number', () => {
  it('opens the panel on the note whose number was tapped', () => {
    const m = mount([{ id: 0, runs: [text('one')] }, { id: 1, runs: [text('two')] }]);
    caretIn(m.paras()[0], 3);
    m.run('footnote');
    typeNote(m, 'الأولى', 0);
    caretIn(m.paras()[1], 3);
    m.run('footnote');
    typeNote(m, 'الثانية', 1);

    (badgeOf(m.paras()[0]) as HTMLElement).click();
    const focused = document.activeElement as HTMLTextAreaElement;
    expect(focused?.value).toBe('الأولى');
    expect(focused?.dataset.note).toBe(String(m.model().blocks?.[0].id) + ':1');
  });
});
