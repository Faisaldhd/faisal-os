/**
 * Writer — the round trip the owner asked for: insert a footnote and an endnote from the ribbon,
 * type their texts in the panel, save, and REOPEN the file — the numbers, the texts, the kinds and
 * the order must all be where they were left.
 *
 * It runs the real Office window over an in-memory VFS and the real save path, because "the tag is
 * somewhere in the bytes" proves nothing: a note is split between the body (the reference) and
 * `word/footnotes.xml` / `word/endnotes.xml` (the text), so the only honest check is to write a real
 * package and read it back with the real reader.
 *
 * The last two tests are the ones the merged save path needed: deleting the LAST note of a kind must
 * leave no orphan text behind in the part it used to live in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shell/dialog', () => ({ shellConfirm: vi.fn(async () => true) }));

import { t } from '../../../kernel/i18n';
import type { AppContext, SystemAPI, VFS, WindowHandle } from '../../../kernel/types';
import { openZip, readDocx } from '../../viewer/formats';
import officeApp from '../index';
import { manifest } from '../manifest';
import { contentTypes } from '../ooxml';
import { utf8, writeZip } from '../zip';
import '../strings';

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const FILE = '/home/user/notes.docx';
const FIRST = 'الفقرة الأولى';
const SECOND = 'الفقرة الثانية';
/** Where the caret goes in each paragraph: three letters in, so the split is visible in the bytes. */
const AT = 3;

/** A .docx with two paragraphs and no notes at all — the state a user starts from. */
function docxFixture(): Uint8Array {
  const document =
    `${DECL}<w:document xmlns:w="${W_NS}" xmlns:r="${DOC_REL}"><w:body>` +
    `<w:p><w:r><w:t xml:space="preserve">${FIRST}</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>${SECOND}</w:t></w:r></w:p>` +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>' +
    '</w:body></w:document>';
  const styles = `${DECL}<w:styles xmlns:w="${W_NS}">` +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>';
  return writeZip([
    {
      name: '[Content_Types].xml',
      data: utf8(contentTypes([
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
      ])),
    },
    {
      name: '_rels/.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="word/document.xml"/></Relationships>`),
    },
    { name: 'word/document.xml', data: utf8(document) },
    { name: 'word/styles.xml', data: utf8(styles) },
  ]);
}

interface Store { vfs: VFS; files: Map<string, Uint8Array> }

function memVfs(seed: Record<string, string | Uint8Array> = {}): Store {
  const files = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(seed)) files.set(path, typeof value === 'string' ? utf8(value) : value);
  const vfs = {
    stat: async (p: string) => ({ path: p, name: p, type: 'file' as const, size: files.get(p)?.length ?? 0, mode: 0o644, mtime: 0, ctime: 0 }),
    exists: async (p: string) => files.has(p),
    readdir: async () => [],
    readFile: async (p: string) => {
      const data = files.get(p);
      if (!data) throw new Error(`ENOENT: ${p}`);
      return data;
    },
    readText: async (p: string) => new TextDecoder().decode(await vfs.readFile(p)),
    writeFile: async (p: string, data: string | Uint8Array) => { files.set(p, typeof data === 'string' ? utf8(data) : data); },
    mkdir: async () => undefined,
    remove: async () => undefined,
    rename: async () => undefined,
    chmod: async () => undefined,
  };
  return { vfs: vfs as unknown as VFS, files };
}

/** The Office window over one store: the file lives exactly where the app writes it. */
function open(store: Store) {
  const content = document.createElement('div');
  document.body.append(content);
  const win: WindowHandle = {
    id: 'w1',
    appId: manifest.id,
    content,
    setTitle: () => undefined,
    focus: () => undefined,
    close: () => undefined,
    onClose: () => () => undefined,
    requestClose: async () => undefined,
    setCloseGuard: () => undefined,
    onResize: () => () => undefined,
  };
  return {
    content,
    store,
    launch: (target: string) => {
      const sys = { vfs: store.vfs, locale: () => 'ar' as const, t } as unknown as SystemAPI;
      officeApp.launch({ sys, window: win, args: [target] } as AppContext);
    },
  };
}

/** Lets the async open/save chains settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Waits for the window's own signal that a save finished (and wrote its one `.bak`). */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const button = (content: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...content.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === label);
const meta = (content: HTMLElement): string => content.querySelector('.faisal-office-meta')?.textContent ?? '';
const fields = (content: HTMLElement): HTMLTextAreaElement[] => [...content.querySelectorAll<HTMLTextAreaElement>('.fo-note-field')];
const badges = (content: HTMLElement): HTMLElement[][] =>
  [...content.querySelectorAll<HTMLElement>('.fo-p')].map((p) => [...p.querySelectorAll<HTMLElement>('.fo-note')]);

/** The caret goes into a paragraph by hand, the way a click in the page would put it there. */
function caretIn(content: HTMLElement, paragraph: number, offset: number): void {
  const p = [...content.querySelectorAll<HTMLElement>('.fo-p')][paragraph];
  const node = p?.querySelector('.fo-r')?.firstChild;
  if (!p || !node) throw new Error(`no paragraph ${paragraph} to put the caret in`);
  const range = document.createRange();
  range.setStart(node, Math.min(offset, (node as Text).data.length));
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

/** Types into the note field of one card in the panel. */
function typeNote(content: HTMLElement, card: number, value: string): void {
  const field = fields(content)[card];
  if (!field) throw new Error(`no note field at ${card}`);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Saves and waits for the window's clean state, with the one `.bak` on disk. */
async function save(app: { content: HTMLElement; store: Store }): Promise<void> {
  button(app.content, t('office.save'))?.click();
  await until(() => meta(app.content).includes(t('office.clean')) && app.store.files.has(`${FILE}.bak`));
}

async function partOf(bytes: Uint8Array, name: string): Promise<string | null> {
  const data = await openZip(bytes).read(name);
  return data ? new TextDecoder().decode(data) : null;
}

/** Opens the file and inserts a footnote (paragraph 1) and an endnote (paragraph 2), typing both. */
async function insertBoth(store: Store) {
  const app = open(store);
  app.launch(FILE);
  await settle();
  caretIn(app.content, 1, AT);
  button(app.content, t('office.insertEndnote'))?.click();
  await settle();
  typeNote(app.content, 0, 'نصّ الحاشية الختامية');
  caretIn(app.content, 0, AT);
  button(app.content, t('office.insertFootnote'))?.click();
  await settle();
  typeNote(app.content, 0, 'نصّ الحاشية السفلية');
  return app;
}

/** The document as the owner sees it after a reopen: the panel open on its notes. */
async function reopen(bytes: Uint8Array) {
  const app = open(memVfs({ [FILE]: bytes }));
  app.launch(FILE);
  await settle();
  button(app.content, t('office.notesPanel'))?.click();
  await settle();
  return app;
}

beforeEach(() => {
  // jsdom has no `scrollIntoView`; the panel scrolls its own list in a browser.
  Element.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  document.body.textContent = '';
});

/**
 * The byte shapes Microsoft Word itself writes, copied from a .docx Word 16 produced with one
 * footnote and one endnote through COM:
 *   • `<w:footnote w:type="separator" w:id="-1">` and `<w:footnote w:type="continuationSeparator" w:id="0">`
 *   • the real notes have NO `w:type` and start at `w:id="1"`, and the body points at them with id 1.
 * A file like this used to open as note-less (the reader dropped every id below 2), and the first
 * note command then rebuilt the part from the model alone — dropping Word's notes out of the file.
 */
function wordDocxFixture(parts: { footnote?: string | null; endnote?: string | null } = {}): Uint8Array {
  const footnoteText = parts.footnote === undefined ? 'حاشية من وورد' : parts.footnote;
  const endnoteText = parts.endnote === undefined ? 'نهاية من وورد' : parts.endnote;
  const document =
    `${DECL}<w:document xmlns:w="${W_NS}" xmlns:r="${DOC_REL}"><w:body>` +
    `<w:p><w:r><w:t>الفقرة الأولى</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>` +
    `<w:p><w:r><w:t>الفقرة الثانية</w:t></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p>` +
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>' +
    '</w:body></w:document>';
  const notesPart = (kind: 'footnote' | 'endnote', text: string | null): string => {
    const tag = kind;
    const plural = kind === 'footnote' ? 'footnotes' : 'endnotes';
    const ref = kind === 'footnote' ? 'footnoteRef' : 'endnoteRef';
    const style = kind === 'footnote' ? 'FootnoteText' : 'EndnoteText';
    const refStyle = kind === 'footnote' ? 'FootnoteReference' : 'EndnoteReference';
    const note = text === null ? '' : `<w:${tag} w:id="1"><w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
      + `<w:r><w:rPr><w:rStyle w:val="${refStyle}"/></w:rPr><w:${ref}/></w:r>`
      + `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:${tag}>`;
    return `${DECL}<w:${plural} xmlns:w="${W_NS}">`
      + `<w:${tag} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${tag}>`
      + `<w:${tag} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${tag}>`
      + note
      + `</w:${plural}>`;
  };
  return writeZip([
    {
      name: '[Content_Types].xml',
      data: utf8(contentTypes([
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>',
        '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>',
      ])),
    },
    {
      name: '_rels/.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="word/document.xml"/></Relationships>`),
    },
    {
      name: 'word/_rels/document.xml.rels',
      data: utf8(`${DECL}<Relationships xmlns="${RELS_NS}">` +
        `<Relationship Id="rId2" Type="${DOC_REL}/footnotes" Target="footnotes.xml"/>` +
        `<Relationship Id="rId3" Type="${DOC_REL}/endnotes" Target="endnotes.xml"/></Relationships>`),
    },
    { name: 'word/document.xml', data: utf8(document) },
    { name: 'word/footnotes.xml', data: utf8(notesPart('footnote', footnoteText)) },
    { name: 'word/endnotes.xml', data: utf8(notesPart('endnote', endnoteText)) },
  ]);
}

const bodyRefIds = (xml: string, kind: 'footnote' | 'endnote'): number[] =>
  [...xml.matchAll(new RegExp(`<w:${kind}Reference w:id="(-?\\d+)"/>`, 'g'))].map((m) => Number(m[1])).sort((a, b) => a - b);
const partNoteIds = (xml: string, kind: 'footnote' | 'endnote'): number[] =>
  [...xml.matchAll(new RegExp(`<w:${kind} w:id="(-?\\d+)">`, 'g'))].map((m) => Number(m[1])).sort((a, b) => a - b);

describe('a .docx Microsoft Word wrote', () => {
  it('opens with Word\'s own notes: their numbers, their kinds and their texts', async () => {
    const app = await reopen(wordDocxFixture());
    expect(badges(app.content).map((list) => list.map((n) => n.textContent))).toEqual([['1'], ['1']]);
    expect(badges(app.content).map((list) => list.map((n) => (n.classList.contains('is-endnote') ? 'endnote' : 'footnote'))))
      .toEqual([['footnote'], ['endnote']]);
    expect(fields(app.content).map((f) => f.value)).toEqual(['حاشية من وورد', 'نهاية من وورد']);
    expect(badges(app.content)[0][0].dataset.skip).toBe('1');
  });

  it('keeps Word\'s notes when a new footnote is added, and the references still point at them', async () => {
    const store = memVfs({ [FILE]: wordDocxFixture() });
    const app = open(store);
    app.launch(FILE);
    await settle();
    caretIn(app.content, 0, 3);
    button(app.content, t('office.insertFootnote'))?.click();
    await settle();
    typeNote(app.content, 0, 'حاشية أضافها التطبيق');
    await save(app);

    const saved = store.files.get(FILE) ?? new Uint8Array();
    const body = (await partOf(saved, 'word/document.xml')) ?? '';
    const footnotes = (await partOf(saved, 'word/footnotes.xml')) ?? '';
    const endnotes = (await partOf(saved, 'word/endnotes.xml')) ?? '';

    // Word's own note is still in the file, with its text, beside the one this app added.
    expect(footnotes).toContain('حاشية من وورد');
    expect(footnotes).toContain('حاشية أضافها التطبيق');
    expect(footnotes).toContain('w:type="separator" w:id="-1"');
    expect(footnotes).toContain('w:type="continuationSeparator" w:id="0"');
    // Every reference in the body points at a note that exists, and no two notes share an id.
    const refs = bodyRefIds(body, 'footnote');
    const partIds = partNoteIds(footnotes, 'footnote');
    expect(partIds).toEqual(refs);
    expect(partIds).toHaveLength(2);
    expect(new Set(partIds).size).toBe(2);
    // The endnote part and its reference are untouched.
    expect(endnotes).toContain('نهاية من وورد');
    expect(bodyRefIds(body, 'endnote')).toEqual(partNoteIds(endnotes, 'endnote'));
    expect(await readDocx(saved)).toEqual(['الفقرة الأولى', 'الفقرة الثانية']);
  });

  it('keeps Word\'s notes when only the body text is edited', async () => {
    const store = memVfs({ [FILE]: wordDocxFixture() });
    const app = open(store);
    app.launch(FILE);
    await settle();
    caretIn(app.content, 0, 0);
    app.content.querySelector('.fo-flow')?.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'ز', bubbles: true, cancelable: true }));
    await settle();
    await save(app);

    const saved = store.files.get(FILE) ?? new Uint8Array();
    const body = (await partOf(saved, 'word/document.xml')) ?? '';
    const footnotes = (await partOf(saved, 'word/footnotes.xml')) ?? '';
    expect(footnotes).toContain('حاشية من وورد');
    // The ids in the file did not have to move: the note kept id 1 and so did its reference.
    expect(partNoteIds(footnotes, 'footnote')).toEqual([1]);
    expect(bodyRefIds(body, 'footnote')).toEqual([1]);
    expect(await readDocx(saved)).toEqual(['زالفقرة الأولى', 'الفقرة الثانية']);
  });

  it('deletes only the note the owner deleted, and leaves Word\'s other notes alone', async () => {
    const store = memVfs({ [FILE]: wordDocxFixture() });
    const app = open(store);
    app.launch(FILE);
    await settle();
    button(app.content, t('office.notesPanel'))?.click();
    await settle();
    [...app.content.querySelectorAll<HTMLButtonElement>('.fo-note-btn.is-danger')][0].click();
    await settle();
    await save(app);

    const saved = store.files.get(FILE) ?? new Uint8Array();
    const body = (await partOf(saved, 'word/document.xml')) ?? '';
    const footnotes = (await partOf(saved, 'word/footnotes.xml')) ?? '';
    const endnotes = (await partOf(saved, 'word/endnotes.xml')) ?? '';
    expect(footnotes).not.toContain('حاشية من وورد');
    expect(bodyRefIds(body, 'footnote')).toEqual([]);
    expect(endnotes).toContain('نهاية من وورد');
    expect(bodyRefIds(body, 'endnote')).toEqual(partNoteIds(endnotes, 'endnote'));
  });

  it('shows a reference whose note is missing from the package, and refuses to touch the notes', async () => {
    // The body points at note 1 while the footnotes part holds only the structural pair: a broken
    // package. The reference must be visible (and claim no number), and the commands must refuse
    // instead of rewriting the part from a model that lost it.
    const broken = wordDocxFixture({ footnote: null });
    const store = memVfs({ [FILE]: broken });
    const app = open(store);
    app.launch(FILE);
    await settle();
    const missing = app.content.querySelector<HTMLElement>('.fo-note.is-missing');
    expect(missing?.textContent).toBe('?');
    expect(missing?.dataset.skip).toBe('1');
    expect(missing?.getAttribute('aria-label')).toBe(t('office.noteMissing'));

    caretIn(app.content, 0, 3);
    button(app.content, t('office.insertFootnote'))?.click();
    await settle();
    // The command says why, and nothing was inserted: the broken reference is still there, and so is
    // the endnote that could be read — neither of them was rewritten.
    expect(app.content.querySelector('.faisal-office-status')?.textContent).toBe(t('office.noteUnreadable'));
    expect(badges(app.content).map((list) => list.map((n) => n.textContent))).toEqual([['?'], ['1']]);
  });
});

describe('a note written from the toolbar and read back from the file', () => {
  it('saves the number, the text, the kind and the order of both notes', async () => {
    const fixture = docxFixture();
    const store = memVfs({ [FILE]: fixture });
    const app = await insertBoth(store);

    // The page already shows what will be written: one footnote number in the first paragraph and
    // one endnote number in the second, each numbered in its own sequence.
    expect(badges(app.content).map((list) => list.map((n) => n.textContent))).toEqual([['1'], ['1']]);
    expect(badges(app.content)[0][0].dataset.skip).toBe('1');
    expect(badges(app.content)[0][0].getAttribute('aria-label')).toBe(t('office.footnoteRef', { n: 1 }));
    expect(badges(app.content)[1][0].getAttribute('aria-label')).toBe(t('office.endnoteRef', { n: 1 }));

    await save(app);
    const saved = store.files.get(FILE) ?? new Uint8Array();

    const body = (await partOf(saved, 'word/document.xml')) ?? '';
    const footnotes = (await partOf(saved, 'word/footnotes.xml')) ?? '';
    const endnotes = (await partOf(saved, 'word/endnotes.xml')) ?? '';
    const types = (await partOf(saved, '[Content_Types].xml')) ?? '';
    const rels = (await partOf(saved, 'word/_rels/document.xml.rels')) ?? '';

    // The body points at the notes with the ids the model gave them.
    expect(body).toContain('<w:footnoteReference w:id="2"/>');
    expect(body).toContain('<w:endnoteReference w:id="2"/>');
    // Each reference sits where the caret was: after the first three letters of its own paragraph.
    expect(body).toContain(`<w:t>${FIRST.slice(0, AT)}</w:t></w:r><w:r><w:footnoteReference`);
    expect(body).toContain(`<w:t>${SECOND.slice(0, AT)}</w:t></w:r><w:r><w:endnoteReference`);

    // Each kind lives in its own part, with Word's two structural notes.
    expect(footnotes).toContain('w:type="separator" w:id="-1"');
    expect(footnotes).toContain('w:type="continuationSeparator" w:id="0"');
    expect(footnotes).toContain('<w:footnote w:id="2">');
    expect(footnotes).toContain('نصّ الحاشية السفلية');
    expect(footnotes).not.toContain('الختامية');
    expect(endnotes).toContain('<w:endnote w:id="2">');
    expect(endnotes).toContain('نصّ الحاشية الختامية');
    expect(endnotes).not.toContain('السفلية');

    // Both parts are announced to whatever reads the package.
    expect(types).toContain('/word/footnotes.xml');
    expect(types).toContain('wordprocessingml.footnotes+xml');
    expect(types).toContain('/word/endnotes.xml');
    expect(rels).toMatch(/relationships\/footnotes"/);
    expect(rels).toContain('Target="footnotes.xml"');
    expect(rels).toMatch(/relationships\/endnotes"/);

    // The paragraph text the file holds is the text the owner typed: no number leaked into it.
    expect(await readDocx(saved)).toEqual([FIRST, SECOND]);

    // One backup, and it is the file exactly as it was before the save.
    expect([...store.files.keys()].filter((p) => p.endsWith('.bak'))).toEqual([`${FILE}.bak`]);
    expect(store.files.get(`${FILE}.bak`)).toEqual(fixture);
  });

  it('reopens the saved file with the notes, their numbers and their texts in place', async () => {
    const store = memVfs({ [FILE]: docxFixture() });
    const app = await insertBoth(store);
    await save(app);
    const saved = store.files.get(FILE) ?? new Uint8Array();

    const second = await reopen(saved);
    expect(await readDocx(saved)).toEqual([FIRST, SECOND]);
    expect(badges(second.content).map((list) => list.map((n) => n.textContent))).toEqual([['1'], ['1']]);
    expect(badges(second.content)[0][0].dataset.skip).toBe('1');
    expect(badges(second.content)[0][0].getAttribute('aria-label')).toBe(t('office.footnoteRef', { n: 1 }));
    expect(badges(second.content)[1][0].classList.contains('is-endnote')).toBe(true);
    expect(badges(second.content)[1][0].getAttribute('aria-label')).toBe(t('office.endnoteRef', { n: 1 }));

    // The panel lists them the way the file holds them: the footnote, then the endnote.
    expect([...second.content.querySelectorAll('.fo-notes-group')].map((n) => n.textContent))
      .toEqual([t('office.footnotesTitle'), t('office.endnotesTitle')]);
    expect(fields(second.content).map((f) => f.value)).toEqual(['نصّ الحاشية السفلية', 'نصّ الحاشية الختامية']);
    expect([...second.content.querySelectorAll('.fo-note-badge')].map((n) => n.textContent)).toEqual(['1', '1']);
  });

  it('leaves no text and no reference behind when the last footnote is deleted and saved again', async () => {
    const store = memVfs({ [FILE]: docxFixture() });
    const app = await insertBoth(store);
    await save(app);
    const saved = store.files.get(FILE) ?? new Uint8Array();

    const second = await reopen(saved);
    // The footnote goes through the panel; the endnote next to it must stay exactly as it was.
    [...second.content.querySelectorAll<HTMLButtonElement>('.fo-note-btn.is-danger')][0].click();
    await settle();
    expect(fields(second.content).map((f) => f.value)).toEqual(['نصّ الحاشية الختامية']);
    expect(badges(second.content).map((list) => list.map((n) => n.textContent))).toEqual([[], ['1']]);

    await save(second);
    const after = second.store.files.get(FILE) ?? new Uint8Array();

    const body = (await partOf(after, 'word/document.xml')) ?? '';
    const footnotes = await partOf(after, 'word/footnotes.xml');
    const endnotes = (await partOf(after, 'word/endnotes.xml')) ?? '';

    expect(body).not.toContain('footnoteReference');
    expect(body).toContain('<w:endnoteReference w:id="2"/>');
    // The part stays a valid notes part (Word's structural notes), with the deleted note's text GONE.
    expect(footnotes).not.toBeNull();
    expect(footnotes).toContain('w:type="separator" w:id="-1"');
    expect(footnotes).not.toContain('السفلية');
    expect(endnotes).toContain('نصّ الحاشية الختامية');
    // Still exactly one backup, holding the file as it was before this second save.
    expect([...second.store.files.keys()].filter((p) => p.endsWith('.bak'))).toEqual([`${FILE}.bak`]);
    expect(second.store.files.get(`${FILE}.bak`)).toEqual(saved);
  });

  it('renders the reopened file with no footnote at all after the deletion round trip', async () => {
    const store = memVfs({ [FILE]: docxFixture() });
    const app = await insertBoth(store);
    await save(app);

    const second = await reopen(store.files.get(FILE) as Uint8Array);
    [...second.content.querySelectorAll<HTMLButtonElement>('.fo-note-btn.is-danger')][0].click();
    await settle();
    await save(second);

    const third = await reopen(second.store.files.get(FILE) as Uint8Array);
    expect(badges(third.content).map((list) => list.map((n) => n.textContent))).toEqual([[], ['1']]);
    expect(badges(third.content)[1][0].classList.contains('is-endnote')).toBe(true);
    // The panel is open on the notes tab with the one note that survived, and nothing else.
    const tab = third.content.querySelector<HTMLElement>('.fo-side:not([hidden]) .fo-panel-tab[aria-selected="true"]');
    expect(tab?.textContent).toBe(t('office.notesPanel'));
    expect([...third.content.querySelectorAll('.fo-note-card')]).toHaveLength(1);
    expect(fields(third.content).map((f) => f.value)).toEqual(['نصّ الحاشية الختامية']);
    expect(await readDocx(second.store.files.get(FILE) as Uint8Array)).toEqual([FIRST, SECOND]);
  });
});
