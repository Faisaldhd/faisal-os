/**
 * Impress — the slide editor (محرّر الشرائح) for a complete presentation.
 *
 * The rail shows every slide as a real thumbnail: tap to go to it, drag (or
 * long-press then drag on touch) to reorder, right-click for duplicate / delete /
 * move, and the "New slide" button offers the four layouts. The stage draws the
 * current slide at its real layout; a shape is selected with a tap, moved by
 * dragging, resized with its handles, deleted with Delete, and its text is edited
 * in place (double-click, or a second tap). Every change is one undoable edit of
 * the deck; the save patches only what changed.
 */
import { t } from '../../../kernel/i18n';
import type { Editor, EditorContext, StatusInfo } from '../editor';
import { button, el, NARROW_BREAKPOINT, observeSize } from '../ui/dom';
import { icon, type IconName } from '../ui/icons';
import { menuList, openPopover, type MenuItem } from '../ui/popover';
import { PALETTE, type RibbonTab } from '../ui/ribbon';
import { EMU_PER_PT, type Anim, type Deck, type DeckShape, type Transition } from './deck';
import {
  addShape, addSlide, deckEdit, deleteShape, deleteSlide, duplicateSlide, moveSlide, newPicture, newShape, setAnim, setBounds,
  setParaStyle, setShapeText, setTransition, SLIDE_LAYOUTS, type NewShapeKind, type SlideLayoutKind,
} from './ops';
import { controlColor, paraStyleOf, type ParaStyle, type ParaStylePatch } from './parafmt';
import { drawSlide, fitSlide, fitWidth } from './render';
import { startShow } from './show';
import './strings';

/** The sizes the size control offers, in points: the ones a slide deck actually uses. */
const FONT_SIZES: readonly number[] = [12, 14, 16, 18, 20, 24, 28, 32, 36, 44, 54, 60];

const LAYOUT_LABEL: Record<SlideLayoutKind, string> = {
  title: 'office.impLayoutTitle', content: 'office.impLayoutContent', two: 'office.impLayoutTwo', blank: 'office.impLayoutBlank',
};
const SHAPES: ReadonlyArray<{ kind: NewShapeKind; icon: IconName; label: string }> = [
  { kind: 'rect', icon: 'rect', label: 'office.impRect' },
  { kind: 'ellipse', icon: 'ellipse', label: 'office.impEllipse' },
  { kind: 'arrow', icon: 'arrow', label: 'office.impArrow' },
  { kind: 'line', icon: 'line', label: 'office.impLine' },
];
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
const pt = (emu: number): number => emu / EMU_PER_PT;

export function createSlideEditor(ctx: EditorContext): Editor {
  const deck = (): Deck | null => {
    const m = ctx.model();
    return m && m.kind === 'pptx' && m.deck ? m.deck : null;
  };
  let current = 0;
  let selected: number | null = null;
  let editing = false;
  /** Repaints the open text overlay after a formatting command (null while nothing is edited). */
  let repaintEdit: (() => void) | null = null;
  /** Puts the caret back into the overlay after a picker took focus (null while nothing is edited). */
  let restoreCaret: (() => void) | null = null;
  let scale = 1;
  let stageWidth = 0;
  let railDragging = false;

  const root = el('div', 'fo-impress is-rich');
  const rail = el('nav', 'fo-rail');
  rail.setAttribute('aria-label', t('office.slidesPanel'));
  const list = el('div', 'fo-rail-list');
  const add = button('slideAdd', t('office.impNewSlide'), () => layoutMenu(add), { showLabel: true, cls: 'fo-rail-add' });
  rail.append(list, add);
  const stage = el('div', 'fo-slidestage is-rich');
  root.append(rail, stage);
  list.addEventListener('touchmove', (ev) => { if (railDragging) ev.preventDefault(); }, { passive: false });

  const apply = (next: Deck, key?: string): void => {
    const before = deck();
    if (!before || next === before || !ctx.editable()) return;
    ctx.commit(deckEdit(before, next, key));
  };
  const shapeOf = (uid: number | null): DeckShape | null =>
    uid === null ? null : deck()?.slides[current]?.shapes.find((s) => s.uid === uid) ?? null;

  /* ─────────────────────────────── slides ─────────────────────────────── */

  function goTo(index: number): void {
    const d = deck();
    if (!d) return;
    current = Math.max(0, Math.min(d.slides.length - 1, index));
    selected = null;
    [...list.children].forEach((c, i) => c.setAttribute('aria-current', String(i === current)));
    list.children[current]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    drawStage();
    ctx.refresh();
  }

  function newSlide(kind: SlideLayoutKind): void {
    const d = deck();
    if (!d) return;
    apply(addSlide(d, current, kind));
    current += 1;
    selected = null;
    render();
  }
  function duplicate(at = current): void {
    const d = deck();
    if (!d) return;
    apply(duplicateSlide(d, at));
    current = at + 1;
    render();
  }
  function remove(at = current): void {
    const d = deck();
    if (!d) return;
    if (d.slides.length <= 1) { ctx.setStatus(t('office.impLastSlide')); return; }
    apply(deleteSlide(d, at));
    current = Math.min(at, d.slides.length - 2);
    selected = null;
    render();
  }
  function move(at: number, to: number): void {
    const d = deck();
    if (!d || to < 0 || to >= d.slides.length || to === at) return;
    apply(moveSlide(d, at, to));
    current = to;
    render();
  }

  function layoutMenu(anchor: HTMLElement): void {
    const items: MenuItem[] = SLIDE_LAYOUTS.map((kind) => ({ label: t(LAYOUT_LABEL[kind]), run: () => newSlide(kind), disabled: !ctx.editable() }));
    const pop = openPopover(anchor, menuList(items, () => pop.close()), { label: t('office.impNewSlide') });
  }

  function slideMenu(anchor: HTMLElement, at: number): void {
    const d = deck();
    if (!d) return;
    const off = !ctx.editable();
    const items: Array<MenuItem | 'sep'> = [
      { label: t('office.impDuplicate'), run: () => duplicate(at), disabled: off },
      { label: t('office.impMoveUp'), run: () => move(at, at - 1), disabled: off || at === 0 },
      { label: t('office.impMoveDown'), run: () => move(at, at + 1), disabled: off || at === d.slides.length - 1 },
      'sep',
      { label: t('office.impDeleteSlide'), run: () => remove(at), danger: true, disabled: off || d.slides.length <= 1 },
    ];
    const pop = openPopover(anchor, menuList(items, () => pop.close()), { label: t('office.impSlideActions', { n: at + 1 }) });
  }

  function thumbWidth(): number {
    return (root.getBoundingClientRect().width || 1000) <= NARROW_BREAKPOINT ? 104 : 148;
  }

  function renderRail(): void {
    const d = deck();
    list.replaceChildren();
    if (!d) return;
    const width = thumbWidth();
    d.slides.forEach((slide, s) => {
      const thumb = el('button', 'fo-thumb');
      thumb.type = 'button';
      thumb.setAttribute('aria-label', t('office.slide', { n: s + 1 }));
      thumb.setAttribute('aria-current', String(s === current));
      thumb.append(el('span', 'fo-thumb-n', String(s + 1)));
      const mini = el('span', 'fo-thumb-slide');
      mini.append(fitSlide(d, drawSlide(d, slide), width).frame);
      thumb.append(mini);
      let suppress = false;
      thumb.addEventListener('click', () => { if (suppress) { suppress = false; return; } goTo(s); });
      thumb.addEventListener('contextmenu', (ev) => { ev.preventDefault(); slideMenu(thumb, s); });
      thumb.addEventListener('keydown', (ev) => {
        if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft')) { ev.preventDefault(); move(s, s - 1); }
        else if (ev.altKey && (ev.key === 'ArrowDown' || ev.key === 'ArrowRight')) { ev.preventDefault(); move(s, s + 1); }
        else if (ev.key === 'Delete') { ev.preventDefault(); remove(s); }
        else if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) { ev.preventDefault(); slideMenu(thumb, s); }
      });
      thumb.addEventListener('pointerdown', (ev) => dragThumb(ev, thumb, s, () => { suppress = true; }));
      list.append(thumb);
    });
  }

  /** Drag to reorder: at once with a mouse, after a still long-press on touch. */
  function dragThumb(ev: PointerEvent, thumb: HTMLElement, from: number, onDragged: () => void): void {
    if (ev.button !== 0 || !ctx.editable()) return;
    const touch = ev.pointerType !== 'mouse';
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    let dragging = false;
    let drop: number | null = null;
    const begin = (): void => {
      dragging = true;
      railDragging = true;
      thumb.classList.add('is-dragging');
      try { thumb.setPointerCapture(ev.pointerId); } catch { /* not every pointer can be captured */ }
    };
    const timer = touch ? window.setTimeout(begin, 350) : 0;
    const thumbs = (): HTMLElement[] => [...list.children] as HTMLElement[];
    const moveTo = (e: PointerEvent): void => {
      const dist = Math.hypot(e.clientX - x0, e.clientY - y0);
      if (!dragging) {
        if (touch) { if (dist > 8) finish(); return; }
        if (dist < 6) return;
        begin();
      }
      e.preventDefault();
      let best = from;
      let bestD = Infinity;
      thumbs().forEach((node, i) => {
        const r = node.getBoundingClientRect();
        const d = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        if (d < bestD) { bestD = d; best = i; }
      });
      drop = best;
      thumbs().forEach((node, i) => node.classList.toggle('is-drop', i === drop && i !== from));
    };
    const finish = (): void => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', moveTo);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', finish);
      thumb.classList.remove('is-dragging');
      thumbs().forEach((node) => node.classList.remove('is-drop'));
      railDragging = false;
    };
    const up = (): void => {
      const was = dragging;
      finish();
      if (!was) return;
      onDragged();
      if (drop !== null && drop !== from) move(from, drop);
    };
    window.addEventListener('pointermove', moveTo, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', finish);
  }

  function refreshThumb(at: number): void {
    const d = deck();
    const slide = d?.slides[at];
    const mini = list.children[at]?.querySelector('.fo-thumb-slide');
    if (!d || !slide || !mini) return;
    mini.replaceChildren(fitSlide(d, drawSlide(d, slide), thumbWidth()).frame);
  }

  /* ─────────────────────────────── the stage ─────────────────────────────── */

  let frame: HTMLElement | null = null;
  let canvas: HTMLElement | null = null;
  let overlay: HTMLElement | null = null;

  function drawStage(): void {
    const d = deck();
    stage.replaceChildren();
    editing = false;
    const slide = d?.slides[current];
    if (!d || !slide) return;
    const box = stage.getBoundingClientRect();
    const pad = (box.width || 1000) <= NARROW_BREAKPOINT ? 24 : 48;
    stageWidth = box.width;
    const width = fitWidth(d, (box.width || 960) - pad, (box.height || 600) - pad);
    canvas = drawSlide(d, slide, { prompts: true });
    const fitted = fitSlide(d, canvas, width);
    frame = fitted.frame;
    scale = fitted.scale;
    frame.classList.add('fo-editframe');
    frame.setAttribute('role', 'group');
    frame.setAttribute('aria-label', t('office.slide', { n: current + 1 }));
    overlay = el('div', 'fo-selection');
    frame.append(overlay);
    frame.addEventListener('pointerdown', onPointerDown);
    frame.addEventListener('dblclick', (ev) => {
      const node = (ev.target as Element).closest<HTMLElement>('[data-uid]');
      if (node) { selected = Number(node.dataset.uid); beginEdit(); }
    });
    stage.append(frame);
    drawSelection();
  }

  function drawSelection(bounds?: { x: number; y: number; w: number; h: number }): void {
    if (!overlay) return;
    overlay.replaceChildren();
    const s = shapeOf(selected);
    canvas?.querySelectorAll('.is-selected').forEach((n) => n.classList.remove('is-selected'));
    if (!s) return;
    canvas?.querySelector(`[data-uid="${s.uid}"]`)?.classList.add('is-selected');
    const b = bounds ?? s;
    const box = el('div', `fo-selbox${s.locked ? ' is-locked' : ''}`);
    box.style.left = `${pt(b.x) * scale}px`;
    box.style.top = `${pt(b.y) * scale}px`;
    box.style.width = `${pt(b.w) * scale}px`;
    box.style.height = `${pt(b.h) * scale}px`;
    if (!s.locked && ctx.editable()) {
      for (const h of HANDLES) {
        const handle = el('span', `fo-handle is-${h}`);
        handle.dataset.handle = h;
        handle.setAttribute('aria-hidden', 'true');
        box.append(handle);
      }
    }
    overlay.append(box);
  }

  function onPointerDown(ev: PointerEvent): void {
    if (editing || ev.button !== 0) return;
    const target = ev.target as HTMLElement;
    const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle ?? null;
    let s: DeckShape | null;
    let wasSelected = false;
    if (handle) s = shapeOf(selected);
    else {
      const node = target.closest<HTMLElement>('[data-uid]');
      if (!node) { selected = null; drawSelection(); ctx.refresh(); return; }
      const uid = Number(node.dataset.uid);
      wasSelected = selected === uid;
      selected = uid;
      s = shapeOf(uid);
      drawSelection();
      ctx.refresh();
    }
    if (!s || s.locked || !ctx.editable()) return;
    ev.preventDefault();
    const shape = s;
    const x0 = ev.clientX;
    const y0 = ev.clientY;
    const node = canvas?.querySelector<HTMLElement>(`[data-uid="${shape.uid}"]`) ?? null;
    let moved = false;
    let next = { x: shape.x, y: shape.y, w: shape.w, h: shape.h };
    const minSize = shape.kind === 'line' ? 0 : 12700 * 8;
    const onMove = (e: PointerEvent): void => {
      const dx = ((e.clientX - x0) / scale) * EMU_PER_PT;
      const dy = ((e.clientY - y0) / scale) * EMU_PER_PT;
      if (!moved && Math.hypot(e.clientX - x0, e.clientY - y0) < 4) return;
      moved = true;
      if (!handle) next = { ...next, x: shape.x + dx, y: shape.y + dy };
      else {
        let { x, y, w, h } = shape;
        if (handle.includes('w')) { x = Math.min(shape.x + dx, shape.x + shape.w - minSize); w = shape.x + shape.w - x; }
        if (handle.includes('e')) w = Math.max(minSize, shape.w + dx);
        if (handle.includes('n')) { y = Math.min(shape.y + dy, shape.y + shape.h - minSize); h = shape.y + shape.h - y; }
        if (handle.includes('s')) h = Math.max(minSize, shape.h + dy);
        next = { x, y, w, h };
      }
      if (node) {
        node.style.left = `${pt(next.x)}px`;
        node.style.top = `${pt(next.y)}px`;
        node.style.width = `${pt(next.w)}px`;
        node.style.height = `${pt(next.h)}px`;
      }
      drawSelection(next);
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      const d = deck();
      if (moved && d) {
        apply(setBounds(d, current, shape.uid, next));
        drawStage();
        refreshThumb(current);
      } else if (!handle && wasSelected) beginEdit();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  /**
   * The look of the selected text box — the ribbon's pressed states read this, and `null` means
   * "nothing here can take text", which is what greys the whole Text group out.
   */
  const style = (): ParaStyle | null => {
    const s = shapeOf(selected);
    return s && !s.locked && (s.kind === 'text' || s.kind === 'shape') ? paraStyleOf(s.paras) : null;
  };
  const canText = (): boolean => ctx.editable() && !!style();

  /**
   * One formatting command, applied to the whole text box (what PowerPoint does with nothing
   * selected inside it) as a single undoable edit. While the text overlay is open it is repainted
   * from the model and the caret is handed straight back, so changing the size or the colour from
   * the ribbon never interrupts the typing — that was the one rough edge of this feature.
   */
  function formatText(patch: ParaStylePatch): void {
    const d = deck();
    if (!d || selected === null || !canText()) { ctx.setStatus(t('impress.selectTextBox')); return; }
    apply(setParaStyle(d, current, selected, patch));
    if (editing) { repaintEdit?.(); restoreCaret?.(); }
    else drawStage();
    refreshThumb(current);
    ctx.refresh();
  }

  /** The overlay takes the look of the paragraph it edits, so what is typed looks like the slide. */
  function paintEditArea(area: HTMLTextAreaElement, s: DeckShape): void {
    const first = s.paras[0];
    area.style.fontSize = `${(first?.size ?? 18) * s.fontScale}px`;
    area.style.fontWeight = first?.bold ? '700' : '';
    area.style.fontStyle = first?.italic ? 'italic' : '';
    area.style.textDecoration = first?.underline ? 'underline' : '';
    area.style.color = first?.color ?? s.ink ?? deck()?.scheme.dk1 ?? '#000';
    // `start` follows the overlay's own `dir="auto"`, which is what keeps Arabic typing RTL.
    area.style.textAlign = first?.align === 'ctr' ? 'center' : first?.align === 'r' ? 'right' : first?.align === 'l' ? 'left' : 'start';
  }

  function beginEdit(): void {
    const s = shapeOf(selected);
    if (!s || s.locked || !ctx.editable() || (s.kind !== 'text' && s.kind !== 'shape') || !canvas) return;
    const node = canvas.querySelector<HTMLElement>(`[data-uid="${s.uid}"]`);
    if (!node) return;
    editing = true;
    node.classList.add('is-editing');
    const area = el('textarea', 'fo-sh-edit');
    area.value = s.paras.map((p) => p.text).join('\n');
    area.dir = 'auto';
    area.setAttribute('aria-label', t('office.impEditText'));
    area.title = t('impress.editHint');
    area.style.left = `${pt(s.x)}px`;
    area.style.top = `${pt(s.y)}px`;
    area.style.width = `${Math.max(pt(s.w), 40)}px`;
    area.style.height = `${Math.max(pt(s.h), 24)}px`;
    paintEditArea(area, s);
    const uid = s.uid;
    repaintEdit = () => { const now = shapeOf(uid); if (now) paintEditArea(area, now); };
    area.addEventListener('input', () => {
      const d = deck();
      if (d) apply(setShapeText(d, current, uid, area.value), `slidetext:${uid}`);
    });
    area.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { ev.preventDefault(); area.blur(); }
    });
    area.addEventListener('pointerdown', (ev) => ev.stopPropagation());

    /**
     * While the overlay is open, the ribbon is part of the same gesture: the size list and the
     * colour picker take focus, and the edit must survive that. A pointer anywhere else — the
     * stage, another window, another app — closes the overlay exactly as before.
     */
    let caret: [number, number] = [area.value.length, area.value.length];
    let pickerGesture = false;
    const finishEdit = (): void => {
      if (!editing) return;
      editing = false;
      repaintEdit = null;
      restoreCaret = null;
      document.removeEventListener('pointerdown', onPointerDown, true);
      drawStage();
      refreshThumb(current);
      ctx.refresh();
    };
    const onPointerDown = (ev: PointerEvent): void => {
      if (!editing) return;
      const target = ev.target as HTMLElement | null;
      if (target && (target === area || area.contains(target))) return; // typing continues
      pickerGesture = !!target?.closest('.fo-ribbon, .fo-phonebar, .fo-pop, .fo-sheet');
      if (pickerGesture) { caret = [area.selectionStart, area.selectionEnd]; return; }
      finishEdit();
    };
    restoreCaret = () => {
      if (!editing || !area.isConnected) return;
      // The caret never left (a command that did not need focus): leave the selection alone.
      if (document.activeElement === area) return;
      area.focus();
      area.setSelectionRange(caret[0], caret[1]);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    area.addEventListener('blur', (ev) => {
      if (!editing) return;
      const to = ev.relatedTarget as HTMLElement | null;
      // Focus went to a formatting control: keep the overlay and take the caret back after it.
      // Read from the element that actually took focus, never from a flag left over from the
      // previous gesture: a stale flag kept the overlay "editing" for ever, so `finishEdit`
      // never redrew the stage and a new colour was never painted.
      if (to?.closest('.fo-ribbon, .fo-phonebar, .fo-pop, .fo-sheet')) {
        caret = [area.selectionStart, area.selectionEnd];
        return;
      }
      finishEdit();
    });
    canvas.append(area);
    area.focus();
    area.select();
  }

  /* ─────────────────────────────── insert ─────────────────────────────── */

  function insert(shape: DeckShape): void {
    const d = deck();
    if (!d) return;
    apply(addShape(d, current, shape));
    selected = shape.uid;
    drawStage();
    refreshThumb(current);
    ctx.refresh();
    if (shape.kind === 'text') beginEdit();
  }

  function insertPicture(): void {
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      const d = deck();
      if (!file || !d) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const mime = file.type || 'image/png';
        const ext = mime === 'image/jpeg' ? 'jpeg' : mime === 'image/gif' ? 'gif' : 'png';
        const size = await new Promise<{ w: number; h: number }>((resolve) => {
          const img = new Image();
          const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
          img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
          img.onerror = () => { resolve({ w: 0, h: 0 }); URL.revokeObjectURL(url); };
          img.src = url;
        });
        if (!size.w) { ctx.setStatus(t('office.impPictureFailed')); return; }
        insert(newPicture(d, bytes, mime, ext, size.w, size.h));
      } catch {
        ctx.setStatus(t('office.impPictureFailed'));
      }
    });
    input.click();
  }

  function deleteSelected(): void {
    const d = deck();
    if (!d || selected === null) return;
    apply(deleteShape(d, current, selected));
    selected = null;
    drawStage();
    refreshThumb(current);
    ctx.refresh();
  }

  /* ─────────────────────────────── ribbon ─────────────────────────────── */

  function present(from: number, presenter: boolean): void {
    const d = deck();
    if (d) startShow(ctx.host(), d, from, presenter);
  }

  function tabs(): RibbonTab[] {
    const can = (): boolean => ctx.editable();
    const sel = (): DeckShape | null => shapeOf(selected);
    const transitions = (): Array<{ value: string; label: string }> => {
      const out = [
        { value: 'none', label: t('office.impTransNone') },
        { value: 'fade', label: t('office.impTransFade') },
        { value: 'push', label: t('office.impTransPush') },
      ];
      if (deck()?.slides[current]?.transition === 'other') out.push({ value: 'other', label: t('office.impTransOther') });
      return out;
    };
    return [
      ctx.fileTab(),
      {
        id: 'home', label: t('office.tabHome'), groups: [
          { label: t('office.impGroupSlides'), controls: [
            { type: 'menu', id: 'newSlide', icon: 'slideAdd', label: t('office.impNewSlide'), showLabel: true, phone: true, enabled: can,
              items: () => SLIDE_LAYOUTS.map((kind) => ({ label: t(LAYOUT_LABEL[kind]), run: () => newSlide(kind) })) },
            { type: 'button', id: 'dupSlide', icon: 'duplicate', label: t('office.impDuplicate'), enabled: can, run: () => duplicate() },
            { type: 'button', id: 'delSlide', icon: 'trash', label: t('office.impDeleteSlide'), enabled: () => can() && (deck()?.slides.length ?? 0) > 1, run: () => remove() },
            { type: 'button', id: 'upSlide', icon: 'moveUp', label: t('office.impMoveUp'), enabled: () => can() && current > 0, run: () => move(current, current - 1) },
            { type: 'button', id: 'downSlide', icon: 'moveDown', label: t('office.impMoveDown'), enabled: () => can() && current < (deck()?.slides.length ?? 0) - 1, run: () => move(current, current + 1) },
          ] },
          { label: t('office.impGroupInsert'), controls: [
            { type: 'button', id: 'textBox', icon: 'textBox', label: t('office.impTextBox'), showLabel: true, phone: true, enabled: can, run: () => { const d = deck(); if (d) insert(newShape(d, 'text')); } },
            { type: 'button', id: 'picture', icon: 'image', label: t('office.insertImage'), enabled: can, run: insertPicture },
            { type: 'menu', id: 'shapes', icon: 'shape', label: t('office.impShapes'), phone: true, enabled: can,
              items: () => SHAPES.map((s) => ({ label: t(s.label), icon: icon(s.icon), run: () => { const d = deck(); if (d) insert(newShape(d, s.kind)); } })) },
            { type: 'button', id: 'delShape', icon: 'trash', label: t('office.impDeleteObject'), enabled: () => can() && !!sel(), run: deleteSelected },
          ] },
          // Type into a text box (double-click) and shape what you typed; the whole box takes
          // the command, and a command with nothing selected says so instead of doing nothing.
          { label: t('impress.textGroup'), controls: [
            { type: 'button', id: 'bold', icon: 'bold', label: t('impress.bold'), phone: true, enabled: canText, pressed: () => !!style()?.bold, run: () => formatText({ bold: !style()?.bold }) },
            { type: 'button', id: 'italic', icon: 'italic', label: t('impress.italic'), enabled: canText, pressed: () => !!style()?.italic, run: () => formatText({ italic: !style()?.italic }) },
            { type: 'button', id: 'underline', icon: 'underline', label: t('impress.underline'), enabled: canText, pressed: () => !!style()?.underline, run: () => formatText({ underline: !style()?.underline }) },
            { type: 'select', id: 'fontSize', label: t('impress.fontSize'), cls: 'fo-fontsize', enabled: canText, width: 76,
              options: () => FONT_SIZES.map((n) => ({ value: String(n), label: String(n) })),
              value: () => String(style()?.size ?? ''), onChange: (v) => formatText({ size: Number(v) }) },
            { type: 'color', id: 'fontColor', icon: 'textColor', label: t('impress.fontColor'), palette: PALETTE, noneLabel: t('impress.colorAuto'),
              // The control reads bare hex (it prefixes its own `#`), the model keeps `#RRGGBB`.
              value: () => controlColor(style()?.color ?? null), onPick: (hex) => formatText({ color: hex }) },
            { type: 'button', id: 'alignRight', icon: 'alignRight', label: t('impress.alignRight'), enabled: canText, pressed: () => style()?.align === 'r', run: () => formatText({ align: 'r' }) },
            { type: 'button', id: 'alignCenter', icon: 'alignCenter', label: t('impress.alignCenter'), enabled: canText, pressed: () => style()?.align === 'ctr', run: () => formatText({ align: 'ctr' }) },
            { type: 'button', id: 'alignLeft', icon: 'alignLeft', label: t('impress.alignLeft'), enabled: canText, pressed: () => style()?.align === 'l', run: () => formatText({ align: 'l' }) },
          ] },
        ],
      },
      {
        id: 'animate', label: t('office.impTabAnimate'), groups: [
          { label: t('office.impTransition'), controls: [
            { type: 'select', id: 'transition', label: t('office.impTransition'), enabled: can, options: transitions,
              value: () => deck()?.slides[current]?.transition ?? 'none',
              onChange: (v) => { const d = deck(); if (d && v !== 'other') { apply(setTransition(d, current, v as Transition)); ctx.refresh(); } } },
          ] },
          { label: t('office.impAnim'), controls: [
            { type: 'select', id: 'anim', label: t('office.impAnim'), enabled: () => can() && !!sel() && !sel()?.locked,
              options: () => [
                { value: 'none', label: t('office.impAnimNone') },
                { value: 'appear', label: t('office.impAnimAppear') },
                { value: 'fade', label: t('office.impAnimFade') },
              ],
              value: () => sel()?.anim ?? 'none',
              onChange: (v) => { const d = deck(); if (d && selected !== null) { apply(setAnim(d, current, selected, v === 'none' ? null : v as Anim)); ctx.refresh(); } } },
          ] },
        ],
      },
      {
        id: 'show', label: t('office.tabSlideshow'), groups: [
          { label: t('office.groupShow'), controls: [
            { type: 'button', id: 'present', icon: 'play', label: t('office.presentFromStart'), showLabel: true, phone: true, run: () => present(0, false) },
            { type: 'button', id: 'presentHere', icon: 'play', label: t('office.presentFromCurrent'), showLabel: true, run: () => present(current, false) },
            { type: 'button', id: 'presenter', icon: 'presenter', label: t('office.impPresenter'), showLabel: true, run: () => present(current, true) },
          ] },
        ],
      },
    ];
  }

  function render(): void {
    const d = deck();
    if (!d) { list.replaceChildren(); stage.replaceChildren(); return; }
    current = Math.max(0, Math.min(d.slides.length - 1, current));
    if (selected !== null && !shapeOf(selected)) selected = null;
    renderRail();
    drawStage();
    ctx.refresh();
  }

  const sizeWatch = observeSize(stage, () => {
    if (editing) return;
    if (Math.abs(stage.getBoundingClientRect().width - stageWidth) > 1) drawStage();
  });

  return {
    element: root,
    tabs,
    render,
    status(): StatusInfo {
      const d = deck();
      return { parts: d ? [t('office.statusSlide', { n: current + 1, total: d.slides.length })] : [] };
    },
    onKey(ev: KeyboardEvent): boolean {
      if (ev.key === 'F5') { present(ev.shiftKey ? current : 0, false); return true; }
      const target = ev.target as HTMLElement;
      if (editing || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT') return false;
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected !== null) { deleteSelected(); return true; }
      if (ev.key === 'Enter' && selected !== null) { beginEdit(); return true; }
      if (ev.key === 'Escape' && selected !== null) { selected = null; drawSelection(); ctx.refresh(); return true; }
      if (ev.key === 'PageDown') { goTo(current + 1); return true; }
      if (ev.key === 'PageUp') { goTo(current - 1); return true; }
      return false;
    },
    dispose(): void { sizeWatch.disconnect(); },
  };
}
