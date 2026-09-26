/**
 * Impress — a tiny editor host for tests: a model, a history of edits, and the context the slide
 * editor expects from the window. Nothing here is shipped (only `*.test.ts` files import it).
 */
import type { Editor, EditorContext } from '../editor';
import type { Edit, OfficeModel } from '../model';
import { Ribbon } from '../ui/ribbon';
import { deckTexts, type Deck } from './deck';
import { createSlideEditor } from './slides';

export interface Harness {
  editor: Editor;
  ribbon: Ribbon;
  host: HTMLElement;
  deck(): Deck;
  status: string[];
}

export function mountEditor(deck: Deck, width = 1200): Harness {
  let model: OfficeModel = { kind: 'pptx', slides: deckTexts(deck), deck };
  const undo: Edit[] = [];
  const status: string[] = [];
  const host = document.createElement('div');
  host.className = 'faisal-office';
  host.dataset.kind = 'pptx';
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => width });
  document.body.append(host);
  const ribbon = new Ribbon({ more: 'more', tabs: 'tabs' });
  let editor: Editor | null = null;
  const ctx: EditorContext = {
    model: () => model,
    commit: (edit) => { model = edit.apply(model); undo.push(edit); },
    undo: () => { const e = undo.pop(); if (e) model = e.revert(model); editor?.render(); },
    redo: () => undefined,
    editable: () => true,
    refresh: () => ribbon.sync(),
    setStatus: (text) => { status.push(text); },
    host: () => host,
    filePath: () => '/home/user/Documents/deck.pptx',
    fileTab: () => ({ id: 'file', label: 'File', groups: [] }),
    exportFile: async () => undefined,
    print: () => undefined,
  };
  editor = createSlideEditor(ctx);
  host.append(ribbon.element, editor.element, ribbon.phoneBar);
  ribbon.setTabs(editor.tabs(), 'home');
  editor.render();
  return {
    editor, ribbon, host, status,
    deck: () => (model.kind === 'pptx' && model.deck ? model.deck : deck),
  };
}
