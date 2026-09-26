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
