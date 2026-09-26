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
 *
 * Around the stage, like WPS Presentation: a ribbon of seven tabs (Home, Insert, Design,
 * Transitions, Animations, Slide Show, View), the Format pane for the selected shape, the speaker
 * notes under the slide, smart guides while a shape is dragged, and three views (normal, slide
 * sorter, notes page). On a phone the slide fills the width, the thumbnails run along the bottom
 * and a labelled bar of large tools replaces the ribbon.
 */
import { t } from '../../../kernel/i18n';
import type { Editor, EditorContext, StatusInfo } from '../editor';
import { button, el, NARROW_BREAKPOINT, observeSize } from '../ui/dom';
import { menuList, openModal, openPopover, closePopovers, type MenuItem } from '../ui/popover';
import { PALETTE, type RibbonTab } from '../ui/ribbon';
import { EMU_PER_PT, type Anim, type Deck, type DeckShape, type MasterText, type Transition } from './deck';
import {
  addShape, addSlide, alignShape, arrangeShape, canFill, canOutline, connectShapes, deckEdit, deleteShape, deleteSlide, duplicateSlide, masterOf,
  moveSlide, newPicture, newShape, newTable, safeLink, setAnim, setBounds, setMaster, setNotes, setParaStyle, setShapeLink, setShapeLook,
  setShapeText, setTableCell, setTransition, ungroup, type AlignKind, type ArrangeKind, type NewShapeKind, type ShapeLook, type SlideLayoutKind,
} from './ops';
import { connectable } from './connectors';
import { DIAGRAM_KINDS, diagramShape, type DiagramKind } from './diagrams';
import { controlColor, modelColor, paraStyleOf, type ParaStyle, type ParaStylePatch } from './parafmt';
import { drawSlide, fitSlide, fitWidth } from './render';
import { startShow } from './show';
import { layoutGallery, shapeGallery, tablePicker, themeGallery, themeName } from './gallery';
import { applyResizeSnap, handleAnchors, snapBox, type Guide } from './guides';
import { createFormatPane, FONT_FAMILIES, FONT_SIZES } from './pane';
import { applyTheme, currentTheme, setSlideSize, SLIDE_SIZES, slideSizeOf, type DeckTheme, type SlideSizeKind } from './themes';
import './strings';

/** Past this width the Format pane opens beside the slide by itself; below it, on request. */
const PANE_AUTO_WIDTH = 1100;
/** How close (in screen pixels) a dragged edge must come to a line before it snaps. */
const SNAP_PX = 6;

/** The fonts the master dialog offers: families that exist on Windows, macOS and most phones. */
const MASTER_FONTS: readonly string[] = ['Tahoma', 'Arial', 'Calibri', 'Segoe UI', 'Times New Roman', 'Courier New'];

const TRANSITIONS: ReadonlyArray<{ value: Exclude<Transition, 'other'>; label: string }> = [
  { value: 'none', label: 'office.impTransNone' },
  { value: 'fade', label: 'office.impTransFade' },
  { value: 'push', label: 'office.impTransPush' },
  { value: 'wipe', label: 'impress.transWipe' },
  { value: 'cover', label: 'impress.transCover' },
];
const ANIMS: ReadonlyArray<{ value: Exclude<Anim, null> | 'none'; label: string }> = [
  { value: 'none', label: 'office.impAnimNone' },
  { value: 'appear', label: 'office.impAnimAppear' },
  { value: 'fade', label: 'office.impAnimFade' },
  { value: 'fly', label: 'impress.animFly' },
];
type ViewMode = 'normal' | 'sorter' | 'notes';
/** The three diagrams the Insert group offers, each one group of boxes joined by real arrows. */
const DIAGRAM_LABEL: Record<DiagramKind, string> = {
  list: 'impress.diagramList', process: 'impress.diagramProcess', cycle: 'impress.diagramCycle',
};
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
  /** The status bar's zoom, on top of the fit-to-stage size (1 = the slide fits the stage). */
  let zoom = 1;
  let stageWidth = 0;
  let railDragging = false;
  /** The connector gesture: `connecting` false = not drawing one, `connectFrom` null = waiting for
   *  the first shape, a uid = waiting for the second. Escape, a tap on nothing, or a slide change
   *  ends it, so a half-finished gesture can never surprise anyone later. */
  let connecting = false;
  let connectFrom: number | null = null;
  /** Normal (thumbnails + slide + notes), the slide sorter, or the notes page. */
  let view: ViewMode = 'normal';
  /** The Format pane: null = decided by the window's width, else the user's own choice. */
  let paneChoice: boolean | null = null;
  /** The notes under the slide: null = decided by the width (hidden on a phone), else chosen. */
  let notesChoice: boolean | null = null;
  /** Smart guides while dragging (View → Guides turns them off). */
  let snapOn = true;

  const root = el('div', 'fo-impress is-rich');
  const rail = el('nav', 'fo-rail');
  rail.setAttribute('aria-label', t('office.slidesPanel'));
  const list = el('div', 'fo-rail-list');
  const add = button('slideAdd', t('office.impNewSlide'), () => layoutMenu(add), { showLabel: true, cls: 'fo-rail-add' });
  rail.append(list, add);
  const stage = el('div', 'fo-slidestage is-rich');
  // The notes under the slide: a header that folds them away, and the words themselves.
  const notesBox = el('section', 'fo-imp-notes');
  const notesHead = el('button', 'fo-imp-noteshead');
  notesHead.type = 'button';
  notesHead.setAttribute('aria-expanded', 'true');
  const notesArea = el('textarea', 'fo-imp-notestext');
  notesArea.dir = 'auto';
  notesArea.placeholder = t('impress.notesPlaceholder');
  notesArea.setAttribute('aria-label', t('impress.notesPane'));
  notesBox.append(notesHead, notesArea);
  const sorter = el('div', 'fo-imp-sorter');
  sorter.setAttribute('role', 'listbox');
  sorter.setAttribute('aria-label', t('impress.viewSorter'));
  const center = el('div', 'fo-imp-center');
  center.append(stage, notesBox, sorter);
  const pane = createFormatPane({
    look: (patch) => formatLook(patch),
    text: (patch) => formatText(patch),
    bounds: (b) => { const d = deck(); if (d && selected !== null) { apply(setBounds(d, current, selected, b)); afterShapeEdit(); } },
    link: (url) => setLink(url),
    close: () => { paneChoice = false; layoutChrome(); ctx.refresh(); },
    design: () => { paneChoice = isNarrow() ? false : paneChoice; layoutChrome(); ctx.host().querySelector<HTMLElement>('.fo-tab[data-tab="design"]')?.click(); },
  });
  const phone = el('div', 'fo-imp-phone');
  phone.setAttribute('role', 'toolbar');
  phone.setAttribute('aria-label', t('impress.phoneTools'));
  root.append(rail, center, pane.element, phone);
  list.addEventListener('touchmove', (ev) => { if (railDragging) ev.preventDefault(); }, { passive: false });
  notesHead.addEventListener('click', () => { notesChoice = !notesShown(); layoutChrome(); });
  notesArea.addEventListener('input', () => {
    const d = deck();
    if (d) apply(setNotes(d, current, notesArea.value), `notes:${d.slides[current]?.uid}`);
  });
  notesArea.readOnly = !ctx.editable();

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
    connecting = false;
    connectFrom = null;
    current = Math.max(0, Math.min(d.slides.length - 1, index));
    selected = null;
    [...list.children].forEach((c, i) => c.setAttribute('aria-current', String(i === current)));
    list.children[current]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    drawStage();
    renderNotes();
    syncPane();
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

  /** "New slide": the layouts as little slides in this deck's own colours (WPS's gallery). */
  function layoutMenu(anchor: HTMLElement): void {
    const d = deck();
    if (!d) return;
    if (!ctx.editable()) { ctx.setStatus(t('impress.readOnly')); return; }
    const pop = openPopover(anchor, layoutGallery(d, (kind) => { pop.close(); newSlide(kind); }), { label: t('impress.layoutPick') });
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
      mini.append(fitSlide(d, drawSlide(d, slide, { index: s }), width).frame);
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
    mini.replaceChildren(fitSlide(d, drawSlide(d, slide, { index: at }), thumbWidth()).frame);
  }

  /* ─────────────────────────── the slide master ─────────────────────────── */

  /**
   * The design behind the slides: the background and the look of the title and body text, kept
   * in the file's slide master. One dialog, one undoable edit, and every slide that inherits from
   * that master is repainted the moment it is applied — the canvas may not show a colour the file
   * would not have.
   */
  function openMasterDialog(): void {
    const d = deck();
    const slide = d?.slides[current];
    const master = d ? masterOf(d as Deck, slide) : null;
    if (!d || !master) { ctx.setStatus(t('impress.masterNone')); return; }
    const form = el('div', 'fo-form fo-master-form');
    form.append(el('p', 'fo-field-label', t('impress.masterHint')));
    const bg = colorField(t('impress.masterBackground'), master.bg);
    const titleFont = fontField(t('impress.masterFont'), master.title.font);
    const titleSize = sizeField(t('impress.masterSize'), master.title.size);
    const titleColor = colorField(t('impress.masterColor'), master.title.color);
    const bodyFont = fontField(t('impress.masterFont'), master.body.font);
    const bodySize = sizeField(t('impress.masterSize'), master.body.size);
    const bodyColor = colorField(t('impress.masterColor'), master.body.color);
    const footer = footerField(master.footer);
    const slideNumber = checkField(t('impress.masterSlideNumber'), t('impress.masterSlideNumberHint'), master.slideNumber);
    form.append(
      bg.row,
      textClass(t('impress.masterTitleText'), titleFont.row, titleSize.row, titleColor.row),
      textClass(t('impress.masterBodyText'), bodyFont.row, bodySize.row, bodyColor.row),
      textClass(t('impress.masterFooter'), footer.row),
      textClass(t('impress.masterSlideNumber'), slideNumber.row),
    );
    const text = (font: string | null, size: number | null, color: string | null): MasterText => ({ font, color, size });
    openModal({
      title: t('impress.masterTitle'), body: form, okLabel: t('impress.masterApply'), cancelLabel: t('office.cancel'), host: ctx.host(),
      onOk: () => {
        const footerText = footer.value();
        // Empty footer means "no footer", not "an empty box at the foot of every slide".
        apply(setMaster(d as Deck, master.part, {
          bg: bg.value(),
          title: text(titleFont.value(), titleSize.value(), titleColor.value()),
          body: text(bodyFont.value(), bodySize.value(), bodyColor.value()),
          footer: footerText === null || footerText.trim() === '' ? null : footerText,
          slideNumber: slideNumber.value(),
        }));
        drawStage();
        renderRail();
        ctx.refresh();
      },
    });
  }

  /** The footer's words: one line of text, empty meaning "no footer at all". */
  function footerField(value: string | null): { row: HTMLElement; value(): string | null } {
    const row = el('label', 'fo-field');
    row.append(el('span', 'fo-field-label', t('impress.masterFooterHint')));
    const input = el('input', 'fo-input');
    input.type = 'text';
    input.maxLength = 120;
    input.dir = 'auto';
    input.value = value ?? '';
    input.placeholder = t('impress.masterFooter');
    row.append(input);
    return { row, value: () => (input.value.trim() === '' ? null : input.value.trim()) };
  }

  /** A labelled switch, with the label as the touch target on a phone. */
  function checkField(label: string, hint: string, value: boolean): { row: HTMLElement; value(): boolean } {
    const row = el('label', 'fo-check fo-master-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = value;
    row.append(box, el('span', undefined, `${label} — ${hint}`));
    return { row, value: () => box.checked };
  }

  /** One class of master text: its own heading, then whatever fields say what it looks like. */
  function textClass(heading: string, ...fields: HTMLElement[]): HTMLElement {
    const box = el('fieldset', 'fo-master-class');
    box.append(el('legend', 'fo-field-label', heading), ...fields);
    return box;
  }

  /** A colour, or "automatic" — which is what a slide inherits from the theme instead. */
  function colorField(label: string, value: string | null): { row: HTMLElement; value(): string | null } {
    const row = el('div', 'fo-field');
    row.append(el('span', 'fo-field-label', label));
    const line = el('div', 'fo-master-row');
    const input = el('input', 'fo-input fo-colorinput');
    input.type = 'color';
    // The picker only ever hands back `#rrggbb`, and the model keeps exactly that: a bare hex
    // value is a colour CSS silently refuses, which once painted a whole deck wrong.
    input.value = modelColor(value) ?? '#FFFFFF';
    const auto = el('label', 'fo-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = !value;
    auto.append(box, el('span', undefined, t('impress.masterAuto')));
    line.append(input, auto);
    row.append(line);
    return { row, value: () => (box.checked ? null : modelColor(input.value)) };
  }

  /** A font family, with the file's own family kept as a choice so it is never lost silently. */
  function fontField(label: string, value: string | null): { row: HTMLElement; value(): string | null } {
    const row = el('label', 'fo-field');
    row.append(el('span', 'fo-field-label', label));
    const select = el('select', 'fo-select');
    const families = value && !MASTER_FONTS.includes(value) ? [value, ...MASTER_FONTS] : MASTER_FONTS;
    const theme = el('option', undefined, t('impress.masterThemeFont'));
    theme.value = '';
    select.append(theme);
    for (const family of families) {
      const option = el('option', undefined, family);
      option.value = family;
      select.append(option);
    }
    select.value = value ?? '';
    row.append(select);
    return { row, value: () => select.value || null };
  }

  /** A size in points; an empty box means "inherit it from the theme". */
  function sizeField(label: string, value: number | null): { row: HTMLElement; value(): number | null } {
    const row = el('label', 'fo-field');
    row.append(el('span', 'fo-field-label', label));
    const input = el('input', 'fo-input');
    input.type = 'number';
    input.min = '8';
    input.max = '200';
    input.placeholder = t('impress.masterAuto');
    input.value = value === null ? '' : String(Math.round(value));
    row.append(input);
    return {
      row,
      value: () => {
        const n = Number(input.value);
        return input.value.trim() === '' || !Number.isFinite(n) ? null : Math.max(8, Math.min(200, Math.round(n)));
      },
    };
  }

  /* ─────────────────────────────── the stage ─────────────────────────────── */

  let frame: HTMLElement | null = null;
  let canvas: HTMLElement | null = null;
  let overlay: HTMLElement | null = null;
  let guideLayer: HTMLElement | null = null;

  /** The smart guides of the drag in progress, drawn over the slide (none = cleared). */
  function drawGuides(guides: readonly Guide[]): void {
    if (!guideLayer) return;
    guideLayer.replaceChildren(...guides.map((g) => {
      const line = el('div', `fo-imp-guide is-${g.axis}`);
      if (g.axis === 'x') {
        line.style.left = `${pt(g.pos) * scale}px`;
        line.style.top = `${pt(g.from) * scale}px`;
        line.style.height = `${pt(g.to - g.from) * scale}px`;
      } else {
        line.style.top = `${pt(g.pos) * scale}px`;
        line.style.left = `${pt(g.from) * scale}px`;
        line.style.width = `${pt(g.to - g.from) * scale}px`;
      }
      return line;
    }));
  }

  /** Right-click on a shape: its own menu (format, arrange, link, delete). */
  function shapeMenu(anchor: HTMLElement): void {
    const s = shapeOf(selected);
    if (!s) return;
    const off = !ctx.editable() || s.locked;
    const items: Array<MenuItem | 'sep'> = [
      { label: t('impress.formatPane'), run: () => { paneChoice = true; layoutChrome(); } },
      { label: t('impress.link'), run: () => openLinkDialog(), disabled: off || s.kind === 'group' },
      'sep',
      { label: t('impress.bringFront'), run: () => arrange('front'), disabled: off },
      { label: t('impress.bringForward'), run: () => arrange('forward'), disabled: off },
      { label: t('impress.sendBackward'), run: () => arrange('backward'), disabled: off },
      { label: t('impress.sendBack'), run: () => arrange('back'), disabled: off },
      'sep',
      { label: t('office.impDeleteObject'), run: deleteSelected, danger: true, disabled: off },
    ];
    const pop = openPopover(anchor, menuList(items, () => pop.close()), { label: t('impress.formatPane') });
  }

  function drawStage(): void {
    const d = deck();
    stage.replaceChildren();
    editing = false;
    const slide = d?.slides[current];
    if (!d || !slide) return;
    const box = stage.getBoundingClientRect();
    const pad = (box.width || 1000) <= NARROW_BREAKPOINT ? 24 : 48;
    stageWidth = box.width;
    const width = fitWidth(d, (box.width || 960) - pad, (box.height || 600) - pad) * zoom;
    stage.classList.toggle('is-zoomed', zoom > 1);
    canvas = drawSlide(d, slide, { prompts: true, index: current });
    const fitted = fitSlide(d, canvas, width);
    frame = fitted.frame;
    scale = fitted.scale;
    frame.classList.add('fo-editframe');
    frame.setAttribute('role', 'group');
    frame.setAttribute('aria-label', t('office.slide', { n: current + 1 }));
    overlay = el('div', 'fo-selection');
    guideLayer = el('div', 'fo-imp-guides');
    frame.append(overlay, guideLayer);
    frame.addEventListener('pointerdown', onPointerDown);
    frame.addEventListener('contextmenu', (ev) => {
      const node = (ev.target as Element).closest<HTMLElement>('[data-uid]');
      if (!node) return;
      ev.preventDefault();
      selected = Number(node.dataset.uid);
      drawSelection();
      shapeMenu(node);
      ctx.refresh();
    });
    frame.addEventListener('dblclick', (ev) => {
      // The second click of a double-click may already have opened the overlay (a tap on the
      // selected shape does): a second overlay would blur the first and close both at once.
      if (editing) return;
      const node = (ev.target as Element).closest<HTMLElement>('[data-uid]');
      if (node) { selected = Number(node.dataset.uid); beginEdit(); }
    });
    stage.append(frame);
    drawSelection();
    frame.classList.toggle('is-connecting', connecting);
    if (connecting && connectFrom !== null) canvas.querySelector(`[data-uid="${connectFrom}"]`)?.classList.add('is-cxn-from');
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

  /* ─────────────────────────────── connectors ─────────────────────────────── */

  /**
   * Two taps: the shape the connector starts from, then the shape it ends at. The line is
   * attached to the closest pair of sides and stays attached, so moving either box afterwards
   * carries the line with it — on the canvas and in the saved file at once.
   */
  function startConnect(): void {
    connecting = true;
    connectFrom = null;
    selected = null;
    drawStage();
    ctx.setStatus(t('impress.connectFirst'));
    ctx.refresh();
  }

  function cancelConnect(): void {
    if (!connecting) return;
    connecting = false;
    connectFrom = null;
    drawStage();
    ctx.setStatus(t('impress.connectCancelled'));
    ctx.refresh();
  }

  function onConnectPick(ev: PointerEvent): void {
    const d = deck();
    const slide = d?.slides[current];
    const node = (ev.target as Element | null)?.closest<HTMLElement>('[data-uid]') ?? null;
    if (!slide || !node) { cancelConnect(); return; }
    const uid = Number(node.dataset.uid);
    const shape = slide.shapes.find((s) => s.uid === uid) ?? null;
    if (!connectable(shape)) { ctx.setStatus(t('impress.connectNotShape')); return; }
    if (connectFrom === null) {
      connectFrom = uid;
      canvas?.querySelector(`[data-uid="${uid}"]`)?.classList.add('is-cxn-from');
      ctx.setStatus(t('impress.connectSecond'));
      return;
    }
    if (connectFrom === uid) { ctx.setStatus(t('impress.connectSame')); return; }
    const next = connectShapes(d as Deck, current, connectFrom, uid);
    if (next === d) { ctx.setStatus(t('impress.connectNotShape')); return; }
    const added = next.slides[current]?.shapes.slice(-1)[0] ?? null;
    connecting = false;
    connectFrom = null;
    apply(next);
    selected = added?.uid ?? null;
    drawStage();
    refreshThumb(current);
    ctx.setStatus(t('impress.connectDone'));
    ctx.refresh();
  }

  function onPointerDown(ev: PointerEvent): void {
    if (editing || ev.button !== 0) return;
    if (connecting) { onConnectPick(ev); return; }
    const target = ev.target as HTMLElement;
    const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle ?? null;
    let s: DeckShape | null;
    let wasSelected = false;
    if (handle) s = shapeOf(selected);
    else {
      const node = target.closest<HTMLElement>('[data-uid]');
      if (!node) { selected = null; drawSelection(); syncPane(); ctx.refresh(); return; }
      const uid = Number(node.dataset.uid);
      wasSelected = selected === uid;
      selected = uid;
      s = shapeOf(uid);
      drawSelection();
      syncPane();
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
    // What the dragged shape may line up with: the slide, and every other shape on it.
    const d0 = deck();
    const targets = (d0?.slides[current]?.shapes ?? []).filter((o) => o.uid !== shape.uid).map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }));
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
      // Smart guides: Alt (or View → Guides off) moves freely, like PowerPoint.
      if (snapOn && !e.altKey && d0) {
        const snap = snapBox(next, targets, { w: d0.cx, h: d0.cy }, (SNAP_PX / scale) * EMU_PER_PT, handleAnchors(handle));
        next = handle ? applyResizeSnap(next, handle, snap.dx, snap.dy) : { ...next, x: next.x + snap.dx, y: next.y + snap.dy };
        drawGuides(snap.guides);
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
      drawGuides([]);
      const d = deck();
      if (moved && d) {
        apply(setBounds(d, current, shape.uid, next));
        drawStage();
        refreshThumb(current);
        syncPane();
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
    syncPane();
    ctx.refresh();
  }

  /** The overlay takes the look of the paragraph it edits, so what is typed looks like the slide. */
  function paintEditArea(area: HTMLTextAreaElement, s: DeckShape): void {
    const first = s.paras[0];
    const d = deck();
    const slide = d?.slides[current];
    const master = d ? masterOf(d, slide) : null;
    const heading = s.ph === 'title' || s.ph === 'ctrTitle';
    const inherited = s.ph ? (heading ? master?.title : master?.body) : null;
    area.style.fontSize = `${(first?.size ?? 18) * s.fontScale}px`;
    area.style.fontWeight = first?.bold ? '700' : '';
    area.style.fontStyle = first?.italic ? 'italic' : '';
    area.style.textDecoration = first?.underline ? 'underline' : '';
    area.style.color = first?.color ?? s.ink ?? inherited?.color ?? d?.scheme.dk1 ?? '#000';
    // The overlay sits on the slide's own background (a dark theme types light on dark).
    area.style.background = s.fill ?? slide?.bgOwn ?? slide?.bgLayout ?? master?.bg ?? d?.scheme.lt1 ?? '#fff';
    const family = first?.font ?? inherited?.font ?? (d?.fonts ? (heading ? d.fonts.major : d.fonts.minor) : null);
    area.style.fontFamily = family ? `"${family.replace(/["\\]/g, '')}", var(--fo-doc-font)` : '';
    // `start` follows the overlay's own `dir="auto"`, which is what keeps Arabic typing RTL.
    area.style.textAlign = first?.align === 'ctr' ? 'center' : first?.align === 'r' ? 'right' : first?.align === 'l' ? 'left' : 'start';
  }

  function beginEdit(): void {
    if (editing) return;
    const s = shapeOf(selected);
    if (s?.kind === 'frame' && s.table && !s.locked && ctx.editable()) { editTable(s); return; }
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
    syncPane();
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
    syncPane();
    ctx.refresh();
  }

  /**
   * One diagram: a whole group of boxes joined by arrows, added as a single undoable edit and
   * selected as one shape — drag it, resize it, delete it.
   */
  function insertDiagram(kind: DiagramKind): void {
    const d = deck();
    if (!d) return;
    insert(diagramShape(d, kind));
    ctx.setStatus(t('impress.diagramAdded'));
  }

  /** Takes the selected group apart, so its boxes can be moved and typed in one by one. */
  function ungroupSelected(): void {
    const d = deck();
    const s = shapeOf(selected);
    if (!d || !s || s.kind !== 'group') return;
    const next = ungroup(d, current, s.uid);
    if (next === d) return;
    apply(next);
    selected = null;
    drawStage();
    refreshThumb(current);
    ctx.setStatus(t('impress.ungrouped'));
    ctx.refresh();
  }

  /* ───────────────────────────── format, arrange, link ───────────────────────────── */

  /** After an edit of the selected shape: the stage, its thumbnail, the pane and the ribbon. */
  function afterShapeEdit(): void {
    drawStage();
    refreshThumb(current);
    syncPane();
    ctx.refresh();
  }

  function formatLook(patch: ShapeLook): void {
    const d = deck();
    const s = shapeOf(selected);
    if (!d || !s || s.locked) { ctx.setStatus(t('impress.selectShape')); return; }
    apply(setShapeLook(d, current, s.uid, patch));
    afterShapeEdit();
  }

  function arrange(kind: ArrangeKind): void {
    const d = deck();
    if (!d || selected === null) { ctx.setStatus(t('impress.selectShape')); return; }
    apply(arrangeShape(d, current, selected, kind));
    afterShapeEdit();
  }

  function alignTo(kind: AlignKind): void {
    const d = deck();
    if (!d || selected === null) { ctx.setStatus(t('impress.selectShape')); return; }
    apply(alignShape(d, current, selected, kind));
    afterShapeEdit();
  }

  /** Links the selected shape; false (and nothing changed) when the address is refused. */
  function setLink(url: string | null): boolean {
    const d = deck();
    if (!d || selected === null) return false;
    if (url && !safeLink(url)) return false;
    apply(setShapeLink(d, current, selected, url));
    afterShapeEdit();
    ctx.setStatus(url ? t('impress.linkAdded') : t('impress.linkRemoved'));
    return true;
  }

  function openLinkDialog(): void {
    const s = shapeOf(selected);
    if (!s || s.kind === 'group') { ctx.setStatus(t('impress.linkSelect')); return; }
    const form = el('div', 'fo-form');
    const row = el('label', 'fo-field');
    row.append(el('span', 'fo-field-label', t('impress.linkHint')));
    const input = el('input', 'fo-input');
    input.type = 'url';
    input.dir = 'ltr';
    input.placeholder = 'https://';
    input.value = s.link ?? '';
    row.append(input);
    const error = el('p', 'fo-imp-paneerror');
    error.setAttribute('role', 'status');
    form.append(row, error);
    openModal({
      title: t('impress.linkTitle'), body: form, okLabel: t('impress.linkApply'), cancelLabel: t('office.cancel'), host: ctx.host(),
      onOk: () => {
        if (setLink(input.value.trim() || null)) return true;
        error.textContent = t('impress.linkBad');
        return false;
      },
    });
  }

  /** A table's cells typed in place: one field per cell over the drawn table, Tab moves on. */
  function editTable(s: DeckShape): void {
    if (!canvas || !s.table) return;
    const node = canvas.querySelector<HTMLElement>(`[data-uid="${s.uid}"]`);
    if (!node) return;
    editing = true;
    const grid = el('div', 'fo-imp-tableedit');
    grid.style.left = `${pt(s.x)}px`;
    grid.style.top = `${pt(s.y)}px`;
    grid.style.width = `${pt(s.w)}px`;
    grid.style.height = `${pt(s.h)}px`;
    const cols = Math.max(1, ...s.table.map((r) => r.length));
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    const uid = s.uid;
    const fields: HTMLTextAreaElement[] = [];
    s.table.forEach((row, r) => row.forEach((cell, c) => {
      const f = el('textarea', 'fo-imp-tablefield');
      f.value = cell;
      f.dir = 'auto';
      f.setAttribute('aria-label', t('impress.tableCell', { row: r + 1, col: c + 1 }));
      f.addEventListener('input', () => {
        const d = deck();
        if (d) apply(setTableCell(d, current, uid, r, c, f.value), `cell:${uid}:${r}:${c}`);
      });
      f.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Escape') { ev.preventDefault(); finish(); }
      });
      fields.push(f);
      grid.append(f);
    }));
    const finish = (): void => {
      if (!editing) return;
      editing = false;
      document.removeEventListener('pointerdown', outside, true);
      drawStage();
      refreshThumb(current);
      ctx.refresh();
    };
    const outside = (ev: PointerEvent): void => { if (!grid.contains(ev.target as Node)) finish(); };
    document.addEventListener('pointerdown', outside, true);
    grid.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    canvas.append(grid);
    node.classList.add('is-editing');
    fields[0]?.focus();
  }

  function insertTable(rows: number, cols: number): void {
    const d = deck();
    if (!d) return;
    insert(newTable(d, rows, cols));
    ctx.setStatus(t('impress.tableAdded'));
  }

  function insertShape(kind: NewShapeKind): void {
    const d = deck();
    if (d) insert(newShape(d, kind));
  }

  /* ───────────────────────────── design ───────────────────────────── */

  function pickTheme(theme: DeckTheme): void {
    const d = deck();
    if (!d || !ctx.editable()) return;
    closePopovers();
    apply(applyTheme(d, theme));
    render();
    ctx.setStatus(t('impress.themeApplied', { name: themeName(theme) }));
  }

  function setSize(kind: SlideSizeKind): void {
    const d = deck();
    if (!d) return;
    const size = SLIDE_SIZES[kind];
    if (d.cx === size.cx && d.cy === size.cy) return;
    apply(setSlideSize(d, size.cx, size.cy));
    render();
    ctx.setStatus(t('impress.sizeChanged'));
  }

  function transitionAll(): void {
    const d = deck();
    const tr = d?.slides[current]?.transition;
    if (!d || !tr || tr === 'other') return;
    let next = d;
    d.slides.forEach((_, i) => { next = setTransition(next, i, tr); });
    apply(next);
    renderRail();
    ctx.setStatus(t('impress.appliedAll'));
    ctx.refresh();
  }

  /** Plays the current slide's transition and entrance effects once, right on the stage. */
  function preview(): void {
    const d = deck();
    const slide = d?.slides[current];
    if (!d || !slide || !frame || !canvas) return;
    const cls = slide.transition === 'fade' ? 'is-enter-fade' : slide.transition === 'push' ? 'is-enter-push'
      : slide.transition === 'wipe' ? 'is-enter-wipe' : slide.transition === 'cover' ? 'is-enter-cover' : '';
    if (cls) { canvas.classList.remove(cls); void canvas.offsetWidth; canvas.classList.add(cls); }
    for (const s of slide.shapes) {
      if (!s.anim) continue;
      const node = canvas.querySelector<HTMLElement>(`[data-uid="${s.uid}"]`);
      const a = s.anim === 'fly' ? 'is-flyin' : 'is-fadein';
      node?.classList.remove(a);
      void node?.offsetWidth;
      node?.classList.add(a);
    }
  }

  /* ───────────────────────────── the chrome ───────────────────────────── */

  function isNarrow(): boolean {
    const office = root.closest<HTMLElement>('.faisal-office');
    const width = office?.clientWidth || root.getBoundingClientRect().width || 1200;
    return width < NARROW_BREAKPOINT;
  }
  function wide(): boolean {
    const office = root.closest<HTMLElement>('.faisal-office');
    return (office?.clientWidth || root.getBoundingClientRect().width || 1200) >= PANE_AUTO_WIDTH;
  }
  const paneShown = (): boolean => view !== 'sorter' && (paneChoice ?? (wide() && selected !== null));
  const notesShown = (): boolean => view === 'notes' || (view === 'normal' && (notesChoice ?? !isNarrow()));

  /** Which panels are on show: the pane, the notes, the sorter — and the phone bar's state. */
  function layoutChrome(): void {
    root.dataset.view = view;
    root.classList.toggle('is-phone', isNarrow());
    const showPane = paneShown();
    pane.element.hidden = !showPane;
    root.classList.toggle('has-pane', showPane);
    const showNotes = notesShown();
    notesBox.classList.toggle('is-open', showNotes);
    notesHead.setAttribute('aria-expanded', String(showNotes));
    notesHead.replaceChildren(el('span', 'fo-imp-notesicon', showNotes ? '▾' : '▸'), el('span', undefined, t('impress.notesPane')));
    notesArea.hidden = !showNotes;
    notesBox.hidden = view === 'sorter';
    stage.hidden = view === 'sorter';
    sorter.hidden = view !== 'sorter';
    rail.hidden = view === 'sorter';
    if (showPane) syncPane();
    renderPhone();
  }

  function syncPane(): void {
    if (pane.element.hidden && !paneShown()) { layoutPaneIfNeeded(); return; }
    layoutPaneIfNeeded();
    pane.update(deck(), shapeOf(selected), ctx.editable());
  }

  /** On a wide window the pane follows the selection by itself (unless it was closed). */
  function layoutPaneIfNeeded(): void {
    const want = paneShown();
    if (pane.element.hidden === !want) return;
    pane.element.hidden = !want;
    root.classList.toggle('has-pane', want);
    if (want) pane.update(deck(), shapeOf(selected), ctx.editable());
  }

  function renderNotes(): void {
    const slide = deck()?.slides[current];
    if (document.activeElement !== notesArea) notesArea.value = slide?.notes ?? '';
    notesArea.readOnly = !ctx.editable();
  }

  function setView(next: ViewMode): void {
    if (editing) return;
    view = next;
    if (view === 'sorter') renderSorter();
    layoutChrome();
    drawStage();
    ctx.refresh();
  }

  /** The slide sorter: every slide large, in a grid; a tap picks, a double-tap opens it. */
  function renderSorter(): void {
    const d = deck();
    sorter.replaceChildren();
    if (!d) return;
    const width = isNarrow() ? 148 : 220;
    d.slides.forEach((slide, i) => {
      const b = el('button', 'fo-imp-sortitem');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(i === current));
      b.setAttribute('aria-label', t('office.slide', { n: i + 1 }));
      b.append(fitSlide(d, drawSlide(d, slide, { index: i }), width).frame, el('span', 'fo-imp-sortn', String(i + 1)));
      b.addEventListener('click', () => { current = i; [...sorter.children].forEach((c, k) => c.setAttribute('aria-selected', String(k === i))); ctx.refresh(); });
      b.addEventListener('dblclick', () => { current = i; setView('normal'); goTo(i); });
      b.addEventListener('contextmenu', (ev) => { ev.preventDefault(); slideMenu(b, i); });
      b.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); current = i; setView('normal'); goTo(i); }
        else if (ev.key === 'Delete') { ev.preventDefault(); remove(i); renderSorter(); }
      });
      sorter.append(b);
    });
  }

  /* ───────────────────────────── the phone ───────────────────────────── */

  /** A phone bottom sheet of large labelled tools. */
  function phoneSheet(anchor: HTMLElement, title: string, fill: (box: HTMLElement, close: () => void) => void): void {
    const box = el('div', 'fo-sheet-ribbon fo-imp-phonesheet');
    const pop = openPopover(anchor, box, { label: title, sheet: true });
    fill(box, () => pop.close());
  }

  function sheetGrid(box: HTMLElement, label: string | null): HTMLElement {
    if (label) box.append(el('div', 'fo-sheet-group', label));
    const g = el('div', 'fo-sheet-grid');
    box.append(g);
    return g;
  }

  function renderPhone(): void {
    const narrow = isNarrow();
    phone.hidden = !narrow;
    if (!narrow) { phone.replaceChildren(); return; }
    const can = ctx.editable();
    const tool = (name: Parameters<typeof button>[0], label: string, run: (b: HTMLElement) => void, opts: { primary?: boolean; disabled?: boolean } = {}): HTMLButtonElement => {
      const b = button(name, label, () => run(b), { showLabel: true, keepFocus: true, primary: opts.primary, cls: 'fo-imp-phonebtn' });
      b.disabled = !!opts.disabled;
      return b;
    };
    phone.replaceChildren(
      tool('slideAdd', t('impress.phoneNew'), (b) => layoutMenu(b), { disabled: !can }),
      tool('plus', t('impress.phoneInsert'), (b) => phoneSheet(b, t('impress.phoneInsert'), (box, close) => {
        const g = sheetGrid(box, null);
        const act = (name: Parameters<typeof button>[0], label: string, run: () => void): void => {
          g.append(button(name, label, () => { close(); run(); }, { showLabel: true }));
        };
        act('textBox', t('office.impTextBox'), () => insertShape('text'));
        act('image', t('office.insertImage'), insertPicture);
        act('table', t('impress.table'), () => insertTable(3, 3));
        act('link', t('impress.link'), openLinkDialog);
        box.append(el('div', 'fo-sheet-group', t('office.impShapes')), shapeGallery((k) => { close(); insertShape(k); }));
      }), { disabled: !can }),
      tool('fill', t('impress.phoneFormat'), () => { paneChoice = !paneShown(); layoutChrome(); }),
      tool('theme', t('impress.phoneDesign'), (b) => phoneSheet(b, t('impress.themes'), (box) => {
        const d = deck();
        box.append(themeGallery(d ? currentTheme(d)?.id ?? null : null, pickTheme));
      }), { disabled: !can }),
      tool('play', t('impress.phonePlay'), () => present(current, false), { primary: true }),
      tool('more', t('impress.phoneMore'), () => { ctx.host().querySelector<HTMLElement>('.fo-phonebar .fo-more')?.click(); }),
    );
  }

  /* ─────────────────────────────── ribbon ─────────────────────────────── */

  function present(from: number, presenter: boolean): void {
    const d = deck();
    if (d) startShow(ctx.host(), d, from, presenter);
  }

  function tabs(): RibbonTab[] {
    const can = (): boolean => ctx.editable();
    const sel = (): DeckShape | null => shapeOf(selected);
    const shapeOn = (): boolean => can() && !!sel() && !sel()?.locked;
    const d0 = (): Deck | null => deck();
    const transition = (): Transition => d0()?.slides[current]?.transition ?? 'none';
    const custom = (id: string, label: string, build: () => HTMLElement, sync?: () => void): RibbonTab['groups'][number]['controls'][number] =>
      ({ type: 'custom', id, label, render: build, sync });
    // The theme gallery is drawn once per ribbon build and re-marked on every sync.
    let themeRow: HTMLElement | null = null;
    const markThemes = (): void => {
      const id = d0() ? currentTheme(d0() as Deck)?.id ?? null : null;
      themeRow?.querySelectorAll<HTMLElement>('.fo-imp-theme').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.theme === id));
        (b as HTMLButtonElement).disabled = !can();
      });
    };
    return [
      ctx.fileTab(),
      {
        id: 'home', label: t('office.tabHome'), groups: [
          { label: t('office.impGroupSlides'), controls: [
            { type: 'button', id: 'newSlide', icon: 'slideAdd', label: t('office.impNewSlide'), showLabel: true, phone: true, enabled: can,
              run: () => { const anchor = ctx.host().querySelector<HTMLElement>('[data-control="newSlide"]:not([hidden])') ?? add; layoutMenu(anchor); } },
            { type: 'button', id: 'dupSlide', icon: 'duplicate', label: t('office.impDuplicate'), enabled: can, run: () => duplicate() },
            { type: 'button', id: 'delSlide', icon: 'trash', label: t('office.impDeleteSlide'), enabled: () => can() && (d0()?.slides.length ?? 0) > 1, run: () => remove() },
            { type: 'button', id: 'upSlide', icon: 'moveUp', label: t('office.impMoveUp'), enabled: () => can() && current > 0, run: () => move(current, current - 1) },
            { type: 'button', id: 'downSlide', icon: 'moveDown', label: t('office.impMoveDown'), enabled: () => can() && current < (d0()?.slides.length ?? 0) - 1, run: () => move(current, current + 1) },
          ] },
          { label: t('impress.groupFont'), controls: [
            { type: 'select', id: 'fontFamily', label: t('impress.font'), enabled: canText, width: 132,
              options: () => [{ value: '', label: t('impress.fontTheme') }, ...FONT_FAMILIES.map((f) => ({ value: f, label: f }))],
              value: () => style()?.font ?? '', onChange: (v) => formatText({ font: v || null }) },
            { type: 'select', id: 'fontSize', label: t('impress.fontSize'), cls: 'fo-fontsize', enabled: canText, width: 68,
              options: () => FONT_SIZES.map((n) => ({ value: String(n), label: String(n) })),
              value: () => String(style()?.size ?? ''), onChange: (v) => formatText({ size: Number(v) }) },
            { type: 'button', id: 'bold', icon: 'bold', label: t('impress.bold'), phone: true, enabled: canText, pressed: () => !!style()?.bold, run: () => formatText({ bold: !style()?.bold }) },
            { type: 'button', id: 'italic', icon: 'italic', label: t('impress.italic'), enabled: canText, pressed: () => !!style()?.italic, run: () => formatText({ italic: !style()?.italic }) },
            { type: 'button', id: 'underline', icon: 'underline', label: t('impress.underline'), enabled: canText, pressed: () => !!style()?.underline, run: () => formatText({ underline: !style()?.underline }) },
            { type: 'color', id: 'fontColor', icon: 'textColor', label: t('impress.fontColor'), palette: PALETTE, noneLabel: t('impress.colorAuto'), enabled: canText,
              // The control reads bare hex (it prefixes its own `#`), the model keeps `#RRGGBB`.
              value: () => controlColor(style()?.color ?? null), onPick: (hex) => formatText({ color: hex }) },
          ] },
          { label: t('impress.groupParagraph'), controls: [
            { type: 'button', id: 'alignRight', icon: 'alignRight', label: t('impress.alignRight'), enabled: canText, pressed: () => style()?.align === 'r', run: () => formatText({ align: 'r' }) },
            { type: 'button', id: 'alignCenter', icon: 'alignCenter', label: t('impress.alignCenter'), enabled: canText, pressed: () => style()?.align === 'ctr', run: () => formatText({ align: 'ctr' }) },
            { type: 'button', id: 'alignLeft', icon: 'alignLeft', label: t('impress.alignLeft'), enabled: canText, pressed: () => style()?.align === 'l', run: () => formatText({ align: 'l' }) },
            { type: 'button', id: 'alignJustify', icon: 'alignJustify', label: t('impress.alignJustify'), enabled: canText, pressed: () => style()?.align === 'just', run: () => formatText({ align: 'just' }) },
          ] },
          { label: t('impress.groupArrange'), controls: [
            { type: 'menu', id: 'arrange', icon: 'layout', label: t('impress.groupArrange'), showLabel: true, enabled: shapeOn,
              items: () => [
                { label: t('impress.bringFront'), run: () => arrange('front') },
                { label: t('impress.bringForward'), run: () => arrange('forward') },
                { label: t('impress.sendBackward'), run: () => arrange('backward') },
                { label: t('impress.sendBack'), run: () => arrange('back') },
                'sep',
                ...(['left', 'center', 'right', 'top', 'middle', 'bottom'] as const).map((k) => ({ label: t(`impress.align_${k}`), run: () => alignTo(k) })),
              ] },
          ] },
          { label: t('impress.groupShapeStyle'), controls: [
            { type: 'color', id: 'shapeFill', icon: 'fill', label: t('impress.fill'), palette: PALETTE, noneLabel: t('impress.noFill'),
              enabled: () => can() && canFill(sel()), value: () => controlColor(sel()?.fill ?? null), onPick: (hex) => formatLook({ fill: hex }) },
            { type: 'color', id: 'shapeOutline', icon: 'borders', label: t('impress.outline'), palette: PALETTE, noneLabel: t('impress.noOutline'),
              enabled: () => can() && canOutline(sel()), value: () => controlColor(sel()?.stroke ?? null), onPick: (hex) => formatLook({ stroke: hex }) },
            { type: 'button', id: 'formatPane', icon: 'sidebar', label: t('impress.formatPane'), showLabel: true, pressed: () => paneShown(),
              run: () => { paneChoice = !paneShown(); layoutChrome(); } },
          ] },
        ],
      },
      {
        id: 'insert', label: t('impress.tabInsert'), groups: [
          { label: t('impress.groupText'), controls: [
            { type: 'button', id: 'textBox', icon: 'textBox', label: t('office.impTextBox'), showLabel: true, phone: true, enabled: can, run: () => insertShape('text') },
          ] },
          { label: t('impress.groupIllustrations'), controls: [
            { type: 'button', id: 'picture', icon: 'image', label: t('office.insertImage'), showLabel: true, enabled: can, run: insertPicture },
            custom('shapes', t('office.impShapes'), () => {
              const b = button('shape', t('office.impShapes'), () => {
                const pop = openPopover(b, shapeGallery((k) => { pop.close(); insertShape(k); }), { label: t('office.impShapes') });
              }, { showLabel: true, keepFocus: true, cls: 'has-menu' });
              b.setAttribute('aria-haspopup', 'dialog');
              return b;
            }, () => { const b = ctx.host().querySelector<HTMLButtonElement>('[data-control="shapes"]'); if (b) b.disabled = !can(); }),
            custom('table', t('impress.table'), () => {
              const b = button('table', t('impress.table'), () => {
                const pop = openPopover(b, tablePicker((r, c) => { pop.close(); insertTable(r, c); }), { label: t('impress.table') });
              }, { showLabel: true, keepFocus: true, cls: 'has-menu' });
              b.setAttribute('aria-haspopup', 'dialog');
              return b;
            }, () => { const b = ctx.host().querySelector<HTMLButtonElement>('[data-control="table"]'); if (b) b.disabled = !can(); }),
            { type: 'menu', id: 'diagrams', icon: 'chart', label: t('impress.diagrams'), enabled: can,
              items: () => DIAGRAM_KINDS.map((kind) => ({ label: t(DIAGRAM_LABEL[kind]), run: () => insertDiagram(kind) })) },
            { type: 'button', id: 'connector', icon: 'line', label: t('impress.connector'), enabled: can,
              pressed: () => connecting, run: () => { if (connecting) cancelConnect(); else startConnect(); } },
          ] },
          { label: t('impress.groupLinks'), controls: [
            { type: 'button', id: 'link', icon: 'link', label: t('impress.link'), showLabel: true, enabled: () => shapeOn() && sel()?.kind !== 'group', run: openLinkDialog },
          ] },
          { label: t('impress.groupEdit'), controls: [
            { type: 'button', id: 'ungroup', icon: 'cut', label: t('impress.ungroup'), enabled: () => can() && sel()?.kind === 'group', run: ungroupSelected },
            { type: 'button', id: 'delShape', icon: 'trash', label: t('office.impDeleteObject'), enabled: () => can() && !!sel(), run: deleteSelected },
          ] },
        ],
      },
      {
        id: 'design', label: t('impress.tabDesign'), groups: [
          { label: t('impress.themes'), controls: [
            custom('themes', t('impress.themes'), () => {
              const d = d0();
              themeRow = themeGallery(d ? currentTheme(d)?.id ?? null : null, pickTheme);
              themeRow.classList.add('is-ribbon');
              return themeRow;
            }, markThemes),
          ] },
          { label: t('impress.groupCustomize'), controls: [
            { type: 'select', id: 'slideSize', label: t('impress.slideSize'), enabled: can, width: 148,
              options: () => {
                const out = [{ value: 'wide', label: t('impress.sizeWide') }, { value: 'standard', label: t('impress.sizeStandard') }];
                const d = d0();
                if (d && !slideSizeOf(d)) out.push({ value: 'custom', label: t('impress.sizeCustom') });
                return out;
              },
              value: () => { const d = d0(); return d ? slideSizeOf(d) ?? 'custom' : 'wide'; },
              onChange: (v) => { if (v === 'wide' || v === 'standard') setSize(v); } },
            { type: 'button', id: 'master', icon: 'theme', label: t('impress.masterButton'), showLabel: true, enabled: can, run: openMasterDialog },
          ] },
        ],
      },
      {
        id: 'transitions', label: t('impress.tabTransitions'), groups: [
          { label: t('impress.groupPreview'), controls: [
            { type: 'button', id: 'previewTrans', icon: 'play', label: t('impress.preview'), showLabel: true, run: preview },
          ] },
          { label: t('office.impTransition'), controls: TRANSITIONS.map((x) => ({
            type: 'button' as const, id: `trans-${x.value}`, icon: 'transition' as const, label: t(x.label), showLabel: true, enabled: can,
            pressed: () => transition() === x.value,
            run: () => { const d = d0(); if (d) { apply(setTransition(d, current, x.value)); renderRail(); preview(); ctx.refresh(); } },
          })) },
          { label: t('impress.groupApply'), controls: [
            { type: 'button', id: 'transAll', icon: 'duplicate', label: t('impress.applyAll'), showLabel: true, enabled: () => can() && transition() !== 'other', run: transitionAll },
          ] },
        ],
      },
      {
        id: 'animations', label: t('impress.tabAnimations'), groups: [
          { label: t('impress.groupPreview'), controls: [
            { type: 'button', id: 'previewAnim', icon: 'play', label: t('impress.preview'), showLabel: true, run: preview },
          ] },
          { label: t('office.impAnim'), controls: ANIMS.map((x) => ({
            type: 'button' as const, id: `anim-${x.value}`, icon: 'sparkle' as const, label: t(x.label), showLabel: true, enabled: shapeOn,
            pressed: () => !!sel() && (sel()?.anim ?? 'none') === x.value,
            run: () => {
              const d = d0();
              if (!d || selected === null) { ctx.setStatus(t('impress.animSelect')); return; }
              apply(setAnim(d, current, selected, x.value === 'none' ? null : x.value));
              ctx.refresh();
              preview();
            },
          })) },
        ],
      },
      {
        id: 'show', label: t('office.tabSlideshow'), groups: [
          { label: t('impress.groupStart'), controls: [
            { type: 'button', id: 'present', icon: 'play', label: t('office.presentFromStart'), showLabel: true, phone: true, run: () => present(0, false) },
            { type: 'button', id: 'presentHere', icon: 'play', label: t('office.presentFromCurrent'), showLabel: true, run: () => present(current, false) },
            { type: 'button', id: 'presenter', icon: 'presenter', label: t('office.impPresenter'), showLabel: true, run: () => present(current, true) },
          ] },
        ],
      },
      {
        id: 'view', label: t('impress.tabView'), groups: [
          { label: t('impress.groupViews'), controls: [
            { type: 'button', id: 'viewNormal', icon: 'slides', label: t('impress.viewNormal'), showLabel: true, pressed: () => view === 'normal', run: () => setView('normal') },
            { type: 'button', id: 'viewSorter', icon: 'columns', label: t('impress.viewSorter'), showLabel: true, pressed: () => view === 'sorter', run: () => setView('sorter') },
            { type: 'button', id: 'viewNotes', icon: 'footer', label: t('impress.viewNotes'), showLabel: true, pressed: () => view === 'notes', run: () => setView('notes') },
          ] },
          { label: t('impress.groupShowPanes'), controls: [
            { type: 'button', id: 'toggleNotes', icon: 'comment', label: t('impress.notesPane'), showLabel: true, pressed: () => notesShown(),
              run: () => { if (view === 'sorter') setView('normal'); notesChoice = !notesShown(); layoutChrome(); } },
            { type: 'button', id: 'togglePane', icon: 'sidebar', label: t('impress.formatPane'), showLabel: true, pressed: () => paneShown(),
              run: () => { if (view === 'sorter') setView('normal'); paneChoice = !paneShown(); layoutChrome(); } },
            { type: 'button', id: 'toggleGuides', icon: 'ruler', label: t('impress.guidesToggle'), showLabel: true, pressed: () => snapOn,
              run: () => { snapOn = !snapOn; ctx.refresh(); } },
          ] },
        ],
      },
    ];
  }

  function render(): void {
    const d = deck();
    // A slide change ends a half-finished connector: the shape it started from is not on screen.
    connecting = false;
    connectFrom = null;
    if (!d) { list.replaceChildren(); stage.replaceChildren(); return; }
    current = Math.max(0, Math.min(d.slides.length - 1, current));
    if (selected !== null && !shapeOf(selected)) selected = null;
    renderRail();
    if (view === 'sorter') renderSorter();
    layoutChrome();
    drawStage();
    renderNotes();
    syncPane();
    ctx.refresh();
  }

  let lastNarrow: boolean | null = null;
  const sizeWatch = observeSize(stage, () => {
    if (editing) return;
    const narrow = isNarrow();
    if (narrow !== lastNarrow) {
      lastNarrow = narrow;
      renderRail();
      layoutChrome();
    }
    if (Math.abs(stage.getBoundingClientRect().width - stageWidth) > 1) drawStage();
  });

  return {
    element: root,
    tabs,
    render,
    status(): StatusInfo {
      const d = deck();
      if (!d) return { parts: [] };
      const setZoom = (value: number): void => { zoom = value; drawStage(); ctx.refresh(); };
      const theme = currentTheme(d);
      const parts = [t('office.statusSlide', { n: current + 1, total: d.slides.length })];
      if (theme) parts.push(themeName(theme));
      return { parts, zoom: { value: zoom, set: setZoom } };
    },
    onKey(ev: KeyboardEvent): boolean {
      if (ev.key === 'F5') { present(ev.shiftKey ? current : 0, false); return true; }
      if (connecting && ev.key === 'Escape') { ev.preventDefault(); cancelConnect(); return true; }
      const target = ev.target as HTMLElement;
      if (editing || target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT') return false;
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected !== null) { deleteSelected(); return true; }
      if (ev.key === 'Enter' && selected !== null) { beginEdit(); return true; }
      if (ev.key === 'Escape' && selected !== null) { selected = null; drawSelection(); syncPane(); ctx.refresh(); return true; }
      // Arrow keys nudge the selected shape (Shift: a bigger step), like WPS.
      if (selected !== null && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) {
        const d = deck();
        const s = shapeOf(selected);
        if (!d || !s || s.locked || !ctx.editable()) return false;
        const step = (ev.shiftKey ? 10 : 1) * EMU_PER_PT * 2;
        const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
        const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
        apply(setBounds(d, current, s.uid, { x: s.x + dx, y: s.y + dy, w: s.w, h: s.h }), `nudge:${s.uid}`);
        afterShapeEdit();
        return true;
      }
      if (ev.key === 'PageDown') { goTo(current + 1); return true; }
      if (ev.key === 'PageUp') { goTo(current - 1); return true; }
      return false;
    },
    dispose(): void { sizeWatch.disconnect(); },
  };
}
