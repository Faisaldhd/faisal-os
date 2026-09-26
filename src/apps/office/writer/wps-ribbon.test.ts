/**
 * Writer — the WPS-style ribbon (الشريط بأسلوب WPS).
 *
 * The tabs are the ones WPS Writer has, in its order, each exactly once (the file used to show two
 * tabs called Review); the font box is never blank; the styles gallery previews each style in its
 * own look and marks the paragraph's; and the commands of the new tabs change the model.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { getLocale, registeredKeys, setLocale, t } from '../../../kernel/i18n';
import type { EditorContext } from '../editor';
import type { DocModel } from '../model';
import type { ButtonControl, Control, CustomControl, MenuControl, SelectControl } from '../ui/ribbon';
import '../strings';
import './strings';
import { blockText, type DocBlock } from './types';
import { createWriter } from './view';

const para = (id: number, text: string): DocBlock => ({ id, runs: [{ t: 'text', text, props: {} }] });

const live: Array<{ dispose(): void }> = [];
afterEach(() => { while (live.length) live.pop()?.dispose(); document.body.textContent = ''; });

function mount(blocks: DocBlock[]) {
  let model: DocModel = { kind: 'docx', paragraphs: blocks.map(blockText), blocks };
  const host = document.createElement('div');
  host.className = 'faisal-office';
  document.body.append(host);
  const history: Array<{ apply(m: DocModel): DocModel; revert(m: DocModel): DocModel }> = [];
  const ctx: EditorContext = {
    model: () => model,
    commit: (edit) => { model = edit.apply(model) as DocModel; history.push(edit as never); },
    undo: () => { const edit = history.pop(); if (edit) model = edit.revert(model); },
    redo: () => undefined,
    editable: () => true,
    refresh: () => undefined,
    setStatus: () => undefined,
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
  const controls = new Map<string, Control>();
  for (const tab of editor.tabs()) for (const group of tab.groups) for (const control of group.controls) controls.set(control.id, control);
  return { editor, model: () => model, controls, host, ctx };
}

function caretIn(host: HTMLElement, index: number, offset: number, end = offset): void {
  const p = host.querySelectorAll<HTMLElement>('.fo-p')[index];
  const node = p.querySelector('.fo-r')?.firstChild ?? p;
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
}

describe('the Writer ribbon, tab by tab', () => {
  it('has the WPS tabs in order, each once: Home, Insert, Layout, References, Review, View', () => {
    const { editor } = mount([para(0, 'hello')]);
    const ids = editor.tabs().map((tab) => tab.id);
    expect(ids).toEqual(['file', 'home', 'insert', 'layout', 'references', 'review', 'view']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every control a unique id and a label in both languages', () => {
    const { editor } = mount([para(0, 'hello')]);
    const all = editor.tabs().flatMap((tab) => tab.groups.flatMap((g) => g.controls));
    const ids = all.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of all) expect(c.label, c.id).not.toMatch(/^office\./);
    const ar = new Set(registeredKeys('ar').filter((k) => k.startsWith('office.w')));
    const en = new Set(registeredKeys('en').filter((k) => k.startsWith('office.w')));
    expect([...ar].sort()).toEqual([...en].sort());
    expect(ar.size).toBeGreaterThan(60);
  });

  it('puts the tools WPS has on each tab', () => {
    const { editor } = mount([para(0, 'hello')]);
    const on = (tab: string): string[] => editor.tabs().find((x) => x.id === tab)?.groups.flatMap((g) => g.controls.map((c) => c.id)) ?? [];
    expect(on('home')).toEqual(expect.arrayContaining(['paste', 'cut', 'copy', 'font', 'size', 'bold', 'italic', 'underline', 'strike', 'color', 'highlight', 'bullets', 'numbers', 'indent', 'outdent', 'align-right', 'line', 'rtl', 'ltr', 'stylegallery']));
    expect(on('insert')).toEqual(expect.arrayContaining(['table', 'image', 'shape', 'link', 'header', 'footer', 'pagenumber', 'symbol', 'pagebreak']));
    expect(on('layout')).toEqual(expect.arrayContaining(['margins', 'orientation', 'pagesize', 'columns', 'breaks']));
    expect(on('references')).toEqual(expect.arrayContaining(['toc', 'footnote', 'endnote', 'crossref']));
    expect(on('review')).toEqual(expect.arrayContaining(['tracking', 'revpanel', 'showcomments', 'wordcount']));
    expect(on('view')).toEqual(expect.arrayContaining(['pageview', 'reading', 'ruler', 'zoomin', 'zoomout']));
  });

  it('never shows an empty font or size box, even before the caret is placed', () => {
    const { controls } = mount([para(0, 'hello')]);
    expect((controls.get('font') as SelectControl).value()).toBe('Calibri');
    expect((controls.get('size') as SelectControl).value()).toBe('11');
  });

  it('draws each style chip in its own look and marks the style of the caret’s paragraph', () => {
    const { controls, host } = mount([para(0, 'hello'), para(1, 'world')]);
    const gallery = controls.get('stylegallery') as CustomControl;
    const box = gallery.render();
    host.append(box);
    const chip = (id: string): HTMLButtonElement => box.querySelector<HTMLButtonElement>(`[data-style="${id}"]`) as HTMLButtonElement;
    expect(chip('Heading1').querySelector<HTMLElement>('.fo-stylechip-sample')?.style.fontWeight).toBe('700');
    expect(chip('Title').querySelector<HTMLElement>('.fo-stylechip-sample')?.style.color).not.toBe('');
    caretIn(host, 1, 2);
    chip('Heading2').click();
    gallery.sync?.();
    expect(chip('Heading2').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Normal').getAttribute('aria-pressed')).toBe('false');
  });

  it('indents and outdents a paragraph by half an inch', () => {
    const { controls, host, model } = mount([para(0, 'hello')]);
    caretIn(host, 0, 1);
    (controls.get('indent') as ButtonControl).run();
    (controls.get('indent') as ButtonControl).run();
    expect(model().formats?.[0]?.indent).toBe(72);
    (controls.get('outdent') as ButtonControl).run();
    expect(model().formats?.[0]?.indent).toBe(36);
  });

  it('applies superscript to the selection and clears it again with Clear formatting', () => {
    const { controls, host, model } = mount([para(0, 'x2 end')]);
    caretIn(host, 0, 1, 2);
    (controls.get('superscript') as ButtonControl).run();
    const runs = model().blocks?.[0].runs ?? [];
    expect(runs.find((r) => r.text === '2' && r.t === 'text' && r.props.va === 'superscript')).toBeTruthy();
    const all = document.createRange();
    const texts = [...host.querySelectorAll('.fo-p .fo-r')].map((n) => n.firstChild as Text);
    all.setStart(texts[0], 0);
    all.setEnd(texts[texts.length - 1], texts[texts.length - 1].data.length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(all);
    document.dispatchEvent(new Event('selectionchange'));
    (controls.get('clearformat') as ButtonControl).run();
    expect((model().blocks?.[0].runs ?? []).every((r) => r.t !== 'text' || !r.props.va)).toBe(true);
  });

  it('switches the page to landscape, Letter, narrow margins and two columns from the Layout tab', () => {
    const { controls, model } = mount([para(0, 'hello')]);
    const pick = (id: string, label: string): void => {
      const item = (controls.get(id) as MenuControl).items().find((i) => i !== 'sep' && i.label.startsWith(label));
      if (!item || item === 'sep') throw new Error(`no ${label} in ${id}`);
      item.run();
    };
    pick('orientation', t('office.wLandscape'));
    expect(model().page?.w).toBeGreaterThan(model().page?.h ?? 0);
    pick('pagesize', 'Letter');
    expect(Math.round(model().page?.w ?? 0)).toBe(792);
    pick('margins', t('office.wMarginsNarrow'));
    expect(model().page?.left).toBe(36);
    pick('columns', t('office.wColumnsTwo'));
    expect(model().page?.cols).toBe(2);
  });

  it('reads in either language', () => {
    const was = getLocale();
    setLocale('en');
    try {
      const { editor } = mount([para(0, 'hello')]);
      expect(editor.tabs().map((tab) => tab.label).slice(1)).toEqual(['Home', 'Insert', 'Layout', 'References', 'Review', 'View']);
    } finally { setLocale(was); }
  });
});
