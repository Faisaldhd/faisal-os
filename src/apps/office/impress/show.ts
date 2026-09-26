/**
 * Impress — the slideshow and the presenter view (العرض ووضع المُحاضر).
 *
 * The show draws each slide at its real layout, plays the slide's transition (fade
 * or push) and reveals the shapes with an entrance animation one click at a time.
 * The presenter view works on one screen: the current slide, the next one, the
 * speaker notes, a timer, and previous/next — the audience view is one tap away.
 */
import { t } from '../../../kernel/i18n';
import { button, el, observeSize } from '../ui/dom';
import type { Deck } from './deck';
import { drawSlide, fitSlide, fitWidth } from './render';

export interface ShowState { at: number; step: number }

/** The next position of a show: reveal the next animated shape, else the next slide. */
export function stepForward(deck: Deck, s: ShowState): ShowState | null {
  const slide = deck.slides[s.at];
  if (!slide) return null;
  const animated = slide.shapes.filter((x) => x.anim).length;
  if (s.step < animated) return { at: s.at, step: s.step + 1 };
  if (s.at + 1 < deck.slides.length) return { at: s.at + 1, step: 0 };
  return null;
}

/** One step back: the previous slide, shown complete. */
export function stepBack(deck: Deck, s: ShowState): ShowState | null {
  if (s.step > 0) return { at: s.at, step: s.step - 1 };
  if (s.at === 0) return null;
  const prev = deck.slides[s.at - 1];
  return { at: s.at - 1, step: prev ? prev.shapes.filter((x) => x.anim).length : 0 };
}

/**
 * The counter under the show: "slide / total", clamped so it can never claim a slide the deck
 * does not have. It is always drawn left-to-right (`dir="ltr"` on the node): in an Arabic window
 * the bidi algorithm would otherwise lay "1 / 2" out as "2 / 1", which read as slide 2 of 1.
 */
export function counterText(deck: Deck, s: ShowState): string {
  const total = deck.slides.length;
  return `${Math.max(1, Math.min(total, s.at + 1))} / ${total}`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const two = (n: number): string => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

export function startShow(host: HTMLElement, deck: Deck, start: number, presenterFirst: boolean): void {
  let state: ShowState = { at: Math.max(0, Math.min(deck.slides.length - 1, start)), step: 0 };
  let presenter = presenterFirst;
  let entering = true;
  /** Past the last click: the black "end of the show" screen, one more click closes it. */
  let ended = false;
  const show = el('div', 'fo-show is-deck');
  show.tabIndex = 0;
  show.setAttribute('role', 'dialog');
  show.setAttribute('aria-label', t('office.slideshow'));
  const main = el('div', 'fo-show-main');
  const side = el('aside', 'fo-show-side');
  const nextBox = el('div', 'fo-show-next');
  const notes = el('div', 'fo-show-notes');
  notes.dir = 'auto';
  const clock = el('div', 'fo-show-clock');
  clock.setAttribute('aria-label', t('office.impTimer'));
  const counter = el('div', 'fo-show-count');
  counter.dir = 'ltr';
  const bar = el('div', 'fo-show-bar');

  // The timer: elapsed time of the talk, pausable and resettable.
  let started = Date.now();
  let pausedAt: number | null = null;
  const elapsed = (): number => (pausedAt ?? Date.now()) - started;
  const tick = (): void => { clock.textContent = formatClock(elapsed()); };
  const timer = setInterval(tick, 1000);

  const draw = (): void => {
    const slide = deck.slides[state.at];
    if (!slide) return;
    show.classList.toggle('is-presenter', presenter);
    show.classList.toggle('is-ended', ended);
    counter.textContent = counterText(deck, state);
    if (ended) {
      main.replaceChildren(el('p', 'fo-show-endscreen', t('impress.showEnd')));
      return;
    }
    const box = main.getBoundingClientRect();
    const width = fitWidth(deck, box.width || 960, box.height || 540);
    const canvas = drawSlide(deck, slide, { hideAnimated: true, index: state.at });
    const animated = slide.shapes.filter((x) => x.anim);
    animated.forEach((shape, i) => {
      if (i >= state.step) return;
      const node = canvas.querySelector<HTMLElement>(`[data-uid="${shape.uid}"]`);
      node?.classList.remove('is-pending');
      if (node && i === state.step - 1 && !entering && shape.anim === 'fade') node.classList.add('is-fadein');
      if (node && i === state.step - 1 && !entering && shape.anim === 'fly') node.classList.add('is-flyin');
    });
    const { frame } = fitSlide(deck, canvas, width);
    if (entering && slide.transition === 'fade') frame.classList.add('is-enter-fade');
    if (entering && slide.transition === 'push') frame.classList.add('is-enter-push');
    if (entering && slide.transition === 'wipe') frame.classList.add('is-enter-wipe');
    if (entering && slide.transition === 'cover') frame.classList.add('is-enter-cover');
    main.replaceChildren(frame);
    entering = false;
    if (presenter) {
      nextBox.replaceChildren(el('div', 'fo-show-label', t('office.impNextSlide')));
      const next = deck.slides[state.at + 1];
      if (next) {
        const sideBox = side.getBoundingClientRect().width || 280;
        const sideWidth = Math.max(96, (show.getBoundingClientRect().width || 1000) <= 700 ? sideBox * 0.4 - 12 : Math.min(sideBox, 420) - 24);
        nextBox.append(fitSlide(deck, drawSlide(deck, next, { index: state.at + 1 }), sideWidth).frame);
      } else nextBox.append(el('p', 'fo-show-end', t('office.impEndOfShow')));
      notes.replaceChildren(el('div', 'fo-show-label', t('office.impNotes')), el('p', 'fo-show-notetext', slide.notes || t('office.impNoNotes')));
      tick();
    }
  };

  const go = (next: ShowState | null): void => {
    if (!next) return;
    entering = next.at !== state.at;
    ended = false;
    state = next;
    draw();
  };
  // Every click moves the talk on, like PowerPoint: past the last one comes the end screen, and
  // one more closes the show. (Clicking the "back" half of the slide once did nothing on the first
  // slide, which left a slide whose shapes all wait for a click looking blank for good.)
  const forward = (): void => {
    if (ended) { close(); return; }
    const next = stepForward(deck, state);
    if (next) { go(next); return; }
    ended = true;
    draw();
  };
  const back = (): void => {
    if (ended) { ended = false; draw(); return; }
    const b = stepBack(deck, state);
    if (b) { entering = false; state = b; draw(); }
  };

  const resize = observeSize(show, draw);
  const close = (): void => {
    clearInterval(timer);
    resize.disconnect();
    show.remove();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };

  const prevBtn = button('chevronStart', t('office.impPrev'), (ev) => { ev.stopPropagation(); back(); }, { cls: 'fo-show-btn' });
  const nextBtn = button('chevronEnd', t('office.impNext'), (ev) => { ev.stopPropagation(); forward(); }, { cls: 'fo-show-btn' });
  const modeBtn = button('presenter', t('office.impPresenter'), (ev) => { ev.stopPropagation(); presenter = !presenter; modeBtn.setAttribute('aria-pressed', String(presenter)); requestAnimationFrame(draw); }, { cls: 'fo-show-btn', toggle: true });
  modeBtn.setAttribute('aria-pressed', String(presenter));
  const pauseBtn = button('timer', t('office.impTimerPause'), (ev) => {
    ev.stopPropagation();
    if (pausedAt === null) pausedAt = Date.now(); else { started += Date.now() - pausedAt; pausedAt = null; }
    pauseBtn.setAttribute('aria-pressed', String(pausedAt !== null));
    tick();
  }, { cls: 'fo-show-btn fo-show-ponly', toggle: true });
  const resetBtn = button('revert', t('office.impTimerReset'), (ev) => { ev.stopPropagation(); started = Date.now(); if (pausedAt !== null) pausedAt = started; tick(); }, { cls: 'fo-show-btn fo-show-ponly' });
  const exit = button('close', t('office.endShow'), (ev) => { ev.stopPropagation(); close(); }, { cls: 'fo-show-btn' });
  bar.append(prevBtn, counter, nextBtn, clock, pauseBtn, resetBtn, modeBtn, exit);
  bar.addEventListener('click', (ev) => ev.stopPropagation());
  side.append(nextBox, notes);
  show.append(main, side, bar);

  show.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(ev.key)) forward();
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(ev.key)) back();
    else if (ev.key === 'Home') go({ at: 0, step: 0 });
    else if (ev.key === 'End') go({ at: deck.slides.length - 1, step: 0 });
    else return;
    ev.preventDefault();
  });
  main.addEventListener('click', (ev) => {
    // A shape with a link opens its address (web and mail only, checked when it was set) in a
    // new tab instead of moving the show on.
    const link = (ev.target as Element | null)?.closest<HTMLElement>('[data-link]')?.dataset.link;
    if (link && !ended && /^(https?:|mailto:)/i.test(link)) { window.open(link, '_blank', 'noopener,noreferrer'); return; }
    forward();
  });
  main.addEventListener('contextmenu', (ev) => { ev.preventDefault(); back(); });

  host.append(show);
  tick();
  draw();
  show.focus();
  void show.requestFullscreen?.().catch(() => undefined);
}
