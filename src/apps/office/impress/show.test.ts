/**
 * Impress — the slideshow's counter and its clicks.
 *
 * The bugs this guards: in an Arabic window the counter "1 / 2" was laid out by the bidi
 * algorithm as "2 / 1" (it read as slide 2 of 1), and a click on the "back" half of the first
 * slide did nothing — a slide whose shapes all wait for a click stayed blank for good.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { newDeckPptx } from '../pptx';
import { readDeck, type Deck } from './deck';
import { addSlide, setAnim } from './ops';
import { counterText, startShow, stepBack, stepForward } from './show';
import './strings';

async function deck(): Promise<Deck> {
  let d = await readDeck(newDeckPptx('T', 'S'));
  d = addSlide(d, 0, 'content');
  // Every shape of slide 1 waits for a click: the slide opens empty.
  for (const s of d.slides[0]!.shapes) d = setAnim(d, 0, s.uid, 'fade');
  return d;
}

afterEach(() => { document.body.replaceChildren(); });

describe('the show counter', () => {
  it('never claims a slide the deck does not have', async () => {
    const d = await deck();
    expect(counterText(d, { at: 0, step: 0 })).toBe('1 / 2');
    expect(counterText(d, { at: 1, step: 0 })).toBe('2 / 2');
    expect(counterText(d, { at: 7, step: 0 })).toBe('2 / 2');
  });

  it('walks every click of every slide, then back again', async () => {
    const d = await deck();
    const n = d.slides[0]!.shapes.length;
    let s = { at: 0, step: 0 };
    const seen: string[] = [];
    for (let next = stepForward(d, s); next; next = stepForward(d, s)) { s = next; seen.push(`${s.at}:${s.step}`); }
    expect(seen).toEqual([...Array.from({ length: n }, (_, i) => `0:${i + 1}`), '1:0']);
    expect(stepBack(d, { at: 1, step: 0 })).toEqual({ at: 0, step: n });
    expect(stepBack(d, { at: 0, step: 0 })).toBeNull();
  });
});

describe('the show', () => {
  it('draws the counter left to right and moves on with every click, then ends', async () => {
    const d = await deck();
    const host = document.createElement('div');
    host.dir = 'rtl';
    document.body.append(host);
    startShow(host, d, 0, false);
    const show = host.querySelector<HTMLElement>('.fo-show')!;
    const counter = show.querySelector<HTMLElement>('.fo-show-count')!;
    const main = show.querySelector<HTMLElement>('.fo-show-main')!;
    expect(counter.dir).toBe('ltr');
    expect(counter.textContent).toBe('1 / 2');
    // All shapes wait for a click: none shows yet.
    const pending = (): number => main.querySelectorAll('.fo-sh.is-pending').length;
    const total = d.slides[0]!.shapes.length;
    expect(pending()).toBe(total);
    // A click anywhere reveals the next shape (no "back half" in the way).
    main.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1 }));
    expect(pending()).toBe(total - 1);
    for (let i = 1; i < total; i++) main.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(pending()).toBe(0);
    main.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(counter.textContent).toBe('2 / 2');
    // Past the last slide: the end screen, then one more click closes the show.
    show.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(show.classList.contains('is-ended')).toBe(true);
    expect(main.querySelector('.fo-show-endscreen')).not.toBeNull();
    expect(counter.textContent).toBe('2 / 2');
    show.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(show.classList.contains('is-ended')).toBe(false);
    show.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    main.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(host.querySelector('.fo-show')).toBeNull();
  });
});
