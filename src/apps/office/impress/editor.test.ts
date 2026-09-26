/**
 * Impress — the slide editor in a real (jsdom) host: the gestures and panels that tie the model
 * to the screen.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { newDeckPptx } from '../pptx';
import { readDeck } from './deck';
import { mountEditor } from './harness.test-util';

afterEach(() => { document.body.replaceChildren(); });

const down = (target: Element): void => {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
};

describe('editing text in place', () => {
  it('a double-click opens one overlay, not two that close each other', async () => {
    const h = mountEditor(await readDeck(newDeckPptx('T', 'S')));
    const shape = h.host.querySelector('.fo-editframe .fo-sh')!;
    down(shape); // select
    down(shape); // a second press on the selected shape opens the overlay…
    shape.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); // …and the dblclick must not open another
    expect(h.host.querySelectorAll('.fo-sh-edit').length).toBe(1);
    const area = h.host.querySelector<HTMLTextAreaElement>('.fo-sh-edit')!;
    expect(document.activeElement).toBe(area);
    area.value = 'Hello';
    area.dispatchEvent(new Event('input'));
    expect(h.deck().slides[0]!.shapes[0]!.paras[0]!.text).toBe('Hello');
  });
});

describe('the WPS-style editor', () => {
  it('has the seven tabs of WPS Presentation after File', async () => {
    const h = mountEditor(await readDeck(newDeckPptx('T', 'S')));
    expect(h.editor.tabs().map((tab) => tab.id)).toEqual(['file', 'home', 'insert', 'design', 'transitions', 'animations', 'show', 'view']);
  });

  it('adds a slide from the layout gallery, drawn as little slides', async () => {
    const h = mountEditor(await readDeck(newDeckPptx('T', 'S')));
    h.host.querySelector<HTMLButtonElement>('.fo-rail-add')!.click();
    const items = [...h.host.querySelectorAll<HTMLButtonElement>('.fo-imp-galitem[data-layout]')];
    expect(items.map((b) => b.dataset.layout)).toEqual(['title', 'content', 'two', 'blank']);
    expect(items.every((b) => b.querySelector('svg'))).toBe(true);
    items[1]!.click();
    expect(h.deck().slides.length).toBe(2);
    expect(h.deck().slides[1]!.shapes.map((s) => s.ph)).toEqual(['title', 'body']);
  });

  it('applies a theme from the Design gallery to every slide', async () => {
    const h = mountEditor(await readDeck(newDeckPptx('T', 'S')));
    h.ribbon.select('design');
    h.host.querySelector<HTMLButtonElement>('.fo-imp-theme[data-theme="slate"]')!.click();
    expect(h.deck().masters[0]!.bg).toBe('#1F2328');
    expect(h.host.querySelector('.fo-editframe .fo-canvas')!.getAttribute('style')).toContain('rgb(31, 35, 40)');
    expect(h.host.querySelector('.fo-imp-theme[data-theme="slate"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the Format pane for the selected shape and fills it from there', async () => {
    const h = mountEditor(await readDeck(newDeckPptx('T', 'S')), 1400);
    const pane = h.host.querySelector<HTMLElement>('.fo-imp-pane')!;
    expect(pane.hidden).toBe(true);
    down(h.host.querySelector('.fo-editframe .fo-sh')!);
    expect(pane.hidden).toBe(false);
    const swatch = [...pane.querySelectorAll<HTMLButtonElement>('.fo-imp-panesec:first-child .fo-imp-swatch')].find((b) => b.title === '#C8894B')!;
    swatch.click();
    expect(h.deck().slides[0]!.shapes[0]!.fill).toBe('#C8894B');
    const width = pane.querySelector<HTMLInputElement>('.fo-imp-panenum')!;
    width.value = '10';
    width.dispatchEvent(new Event('change'));
    expect(h.deck().slides[0]!.shapes[0]!.w).toBe(3600000);
  });

  it('keeps the speaker notes typed under the slide', async () => {
    const h = mountEditor(await readDeck(newDeckPptx('T', 'S')));
    const notes = h.host.querySelector<HTMLTextAreaElement>('.fo-imp-notestext')!;
    notes.value = 'Say hello';
    notes.dispatchEvent(new Event('input'));
    expect(h.deck().slides[0]!.notes).toBe('Say hello');
  });

  it('switches to the slide sorter and back', async () => {
    const h = mountEditor(await readDeck(newDeckPptx('T', 'S')));
    h.host.querySelector<HTMLButtonElement>('[data-control="viewSorter"]')!.click();
    expect(h.host.querySelector('.fo-impress')!.getAttribute('data-view')).toBe('sorter');
    expect(h.host.querySelectorAll('.fo-imp-sortitem').length).toBe(1);
    h.host.querySelector<HTMLButtonElement>('[data-control="viewNormal"]')!.click();
    expect(h.host.querySelector<HTMLElement>('.fo-imp-sorter')!.hidden).toBe(true);
  });

  it('on a phone: labelled tools at the bottom, notes folded away', async () => {
    const h = mountEditor(await readDeck(newDeckPptx('T', 'S')), 390);
    const phone = h.host.querySelector<HTMLElement>('.fo-imp-phone')!;
    expect(phone.hidden).toBe(false);
    const labels = [...phone.querySelectorAll('.fo-btn-label')].map((n) => n.textContent);
    expect(labels.length).toBeLessThanOrEqual(6);
    expect(labels.every((l) => !!l)).toBe(true);
    expect(h.host.querySelector<HTMLElement>('.fo-imp-notestext')!.hidden).toBe(true);
  });
});
