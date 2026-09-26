/**
 * Writer — the page editor (محرر المستندات).
 *
 * The document is drawn as real pages: the page size, margins, header and footer
 * come from the file's section properties, every paragraph gets its style's font,
 * size, colour, spacing and direction, every run its own bold/italic/colour, and
 * tables and pictures are drawn in place. One `contenteditable` flow lies over a
 * stack of page rectangles; pagination pushes a paragraph to the next page with a
 * margin, so the caret is never disturbed.
 *
 * Every keystroke becomes a model edit (typing, Enter, Backspace, paste…) through
 * `beforeinput`; the browser never restructures the document by itself. Input
 * methods that compose text (phone keyboards, IMEs) are reconciled by diffing the
 * paragraph's text when composition ends.
 *
 * A second view, Draft, lists the same paragraphs as plain text fields — fast on a
 * phone and the view where a whole paragraph is formatted at once.
 */
import { t } from '../../../kernel/i18n';
import { insertMergeField, openMailMergePanel } from './mailmerge-ui';
import type { Editor, EditorContext, StatusInfo } from '../editor';
import type { DocModel, Edit, OfficeModel, ParagraphAlign, ParagraphFormat } from '../model';
import { paragraphEdit } from '../model';
import { button, clamp, el, observeSize } from '../ui/dom';
import { icon } from '../ui/icons';
import { openModal, openPopover, type MenuItem } from '../ui/popover';
import { PALETTE, type Control, type RibbonTab } from '../ui/ribbon';
import { blockSplice, formatsEdit, sliceOf } from './docedits';
import {
  countText, emptyBlock, formatRange, mergeBlocks, propsInRange, replaceText, splitBlock, startsRtl, type PropsPatch,
} from './docops';
import { galleryStyles, resolveStyle, type DocLook, type ParaLook, type TextLook } from './docxread';
import { toHtml, toMarkdown } from './export';
import { ODT_MIME, odtTitleOf, toOdt } from './odt';
import { findAll, type Match } from './find';
// The note commands are the merged model layer (`notemodel.ts`): the UI never numbers or edits a
// note by itself — it calls `insertNote` / `setNoteText` / `removeNote` and draws what comes back.
import { insertNote, removeNote, setNoteText, type NoteKind } from './notemodel';
import { paginate, PX } from './paginate';
import {
  applyChangeToText, authorStamp, counts as revisionCounts, decide, decideAll, emptyLog, pending as pendingRevisions, shiftAfter,
  planPieces, record, revisionsOf, type Change, type Revision, type RevisionLog,
} from './revisions';
import { shellConfirm } from '../../../shell/dialog';
import { blockText, type DocBlock, type OpaqueRun, type Run, type RunProps } from './types';
import { shortcutOf, typedDirection, type WriterCommand } from './keys';
import {
  DEFAULT_PAGE, MARGINS, PAGES_FIELD, PAGE_FIELD, PAPERS, hfDisplay, hfText, marginsOf, orientationOf, paperOf,
  withColumns, withMargins, withOrientation, withPaper,
  type HeaderFooterSetup, type HfSetup, type MarginName, type PageSetup, type PaperName,
} from './layout';
import { tableOp, type TableOp } from './tableops';
import { paginateColumns } from './paginate';
import { textOfRange } from './docops';
import { xmlText } from '../xml';
import { textElement } from '../patch';
import { NARROW_BREAKPOINT } from '../ui/dom';
import { menuList } from '../ui/popover';
import './strings';

interface Pos { b: number; o: number }
interface Sel { from: Pos; to: Pos; collapsed: boolean }

const FONTS = [
  'Calibri', 'Arial', 'Aptos', 'Times New Roman', 'Tahoma', 'Segoe UI', 'Cambria', 'Georgia', 'Verdana', 'Courier New',
  'Traditional Arabic', 'Simplified Arabic', 'Sakkal Majalla', 'Arabic Typesetting', 'Noto Naskh Arabic', 'Amiri', 'Dubai',
];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 60, 72];
/** Word's highlight colours (name → hex), in the order the picker shows them. */
const HIGHLIGHTS: Record<string, string> = {
  yellow: 'FFFF00', green: '00FF00', cyan: '00FFFF', magenta: 'FF00FF', blue: '0000FF', red: 'FF0000',
  darkBlue: '000080', darkCyan: '008080', darkGreen: '008000', darkMagenta: '800080', darkRed: '800000',
  darkYellow: '808000', darkGray: '808080', lightGray: 'C0C0C0', black: '000000',
};
const HL_BY_HEX = Object.fromEntries(Object.entries(HIGHLIGHTS).map(([k, v]) => [v, k]));
const GAP = 24;
const LINES = [1, 1.15, 1.5, 2, 2.5, 3];
/** The symbols the Insert › Symbol grid offers (Latin, maths, currency, arrows, Arabic punctuation). */
const SYMBOLS = [
  '©', '®', '™', '§', '¶', '°', '±', '×', '÷', '≠', '≈', '≤', '≥', '∞', '√', '∑', 'π', 'µ',
  '€', '£', '¥', '¢', '﷼', '←', '→', '↑', '↓', '↔', '•', '…', '—', '–', '«', '»', '‰', '✓',
  '✗', '★', '☆', '♥', '☎', '✉', '٪', '؟', '،', '؛', '﴾', '﴿',
];
type ShapeKind = 'rect' | 'rounded' | 'ellipse' | 'arrow' | 'line' | 'star';
const SHAPES: ReadonlyArray<[ShapeKind, string]> = [
  ['rect', 'office.wShapeRect'], ['rounded', 'office.wShapeRounded'], ['ellipse', 'office.wShapeEllipse'],
  ['arrow', 'office.wShapeArrow'], ['line', 'office.wShapeLine'], ['star', 'office.wShapeStar'],
];

/** A `<w:br w:type="column"/>` run: the text moves on to the next column. */
function isColumnBreak(run: OpaqueRun): boolean {
  return run.kind !== 'page' && /<w:br\b[^>]*w:type="column"/.test(run.xml);
}

/** CSS text-align for a Word alignment: left/right are logical in a right-to-left paragraph. */
export function cssAlign(align: ParagraphAlign | undefined): string {
  if (align === 'center') return 'center';
  if (align === 'justify') return 'justify';
  if (align === 'right') return 'end';
  return 'start';
}

/** The logical alignment a visual button means in a paragraph of this direction. */
export function logicalAlign(visual: ParagraphAlign, rtl: boolean): ParagraphAlign {
  if (!rtl || visual === 'center' || visual === 'justify') return visual;
  return visual === 'left' ? 'right' : 'left';
}

function fontStack(name: string | undefined): string {
  const base = 'var(--fo-doc-font)';
  if (!name) return base;
  return `"${name.replace(/["\\]/g, '')}", ${base}`;
}

/* ─────────────────────────── notes (الحواشي) ─────────────────────────── */

/** One note as the reader sees it: where its reference sits, and the number at that reference. */
export interface NoteEntry { blockId: number; runIndex: number; kind: NoteKind; text: string; number: number }

/**
 * Every note of the document in reading order, each numbered 1, 2, 3… **within its own kind** —
 * Word numbers footnotes and endnotes in two separate sequences, so a document can hold "footnote 1"
 * and "endnote 1" at once.
 *
 * This numbering is for DISPLAY only, and it is read from the model, never kept beside it: the ids
 * and the order they must keep come from `renumberNotes` (notemodel.ts), so nothing here can drift
 * away from what the file will say.
 */
export function documentNotes(blocks: readonly DocBlock[]): NoteEntry[] {
  const seen: Record<NoteKind, number> = { footnote: 0, endnote: 0 };
  const out: NoteEntry[] = [];
  for (const block of blocks) {
    block.runs.forEach((run, runIndex) => {
      if (run.t !== 'opaque' || run.kind !== 'note' || !run.note) return;
      seen[run.note.kind] += 1;
      out.push({ blockId: block.id, runIndex, kind: run.note.kind, text: run.note.text, number: seen[run.note.kind] });
    });
  }
  return out;
}

/** The runs with a boundary at `offset`, so a zero-width element can sit exactly at the caret. */
export function splitRunsAt(runs: readonly Run[], offset: number): Run[] {
  const out: Run[] = [];
  let at = 0;
  for (const run of runs) {
    const end = at + run.text.length;
    if (run.t === 'text' && offset > at && offset < end) {
      out.push({ ...run, text: run.text.slice(0, offset - at) }, { ...run, text: run.text.slice(offset - at) });
    } else out.push(run);
    at = end;
  }
  return out;
}

/** The index a zero-width element at `offset` goes at, in runs already split at `offset`. */
export function runIndexAt(runs: readonly Run[], offset: number): number {
  let at = 0;
  for (let i = 0; i < runs.length; i++) {
    const end = at + runs[i].text.length;
    if (offset <= at || offset < end) return i;
    at = end;
  }
  return runs.length;
}

/** The text offset of a run in its paragraph — where a caret sits next to a zero-width element. */
export function runTextOffset(runs: readonly Run[], runIndex: number): number {
  let at = 0;
  for (let i = 0; i < runIndex && i < runs.length; i++) at += runs[i].text.length;
  return at;
}

export function createWriter(ctx: EditorContext, look: DocLook | null): Editor {
  const doc = (): DocModel | null => {
    const m = ctx.model();
    return m && m.kind === 'docx' && m.blocks ? m : null;
  };
  let nextId = Math.max(look?.paras.length ?? 0, ...(doc()?.blocks ?? []).map((b) => b.id + 1), 0);
  let zoom = 1;
  let fitWidth = true;
  let mode: 'page' | 'draft' = 'page';
  let fluid = false;
  let sideOpen = false;
  let sideTab: 'nav' | 'notes' | 'comments' = look?.comments.length ? 'comments' : 'nav';
  let pending: RunProps | null = null;
  let lastSel: Sel | null = null;
  /** Set while a Draft field has focus: formatting then acts on that whole paragraph. */
  let draftPara: number | null = null;
  let composing = false;
  let pageCount = 1;
  let caretPage = 0;
  let wordToken = 0;
  let selectedImage: { b: number; run: number } | null = null;
  /** Where `pending` (formatting chosen with no selection) applies: it is dropped once the caret moves. */
  let pendingAt: Pos | null = null;
  /** Reading mode: the page is shown, nothing is editable (the phone opens a document this way). */
  let reading = false;
  /** True while the phone layout's editing tools are open (the owner pressed Edit). */
  let phoneEditing = false;
  /** The phone layout (a narrow window) was seen: it starts in reading mode once. */
  let narrowSeen = false;
  let showRuler = true;
  const mediaUrls = new Map<string, string>();
  const newUrls = new WeakMap<Uint8Array, string>();
  const opaqueText = new WeakMap<HTMLElement, string>();
  /** The number every reference shows, by "blockId:runIndex" — refilled whenever the page is drawn. */
  let noteNumbers = new Map<string, number>();

  /** Reads the numbers the reader shows at each reference out of the document that is being drawn. */
  function recountNotes(): void {
    noteNumbers = new Map();
    for (const note of documentNotes(doc()?.blocks ?? [])) noteNumbers.set(`${note.blockId}:${note.runIndex}`, note.number);
  }

  /* ───────────────────────────── DOM ───────────────────────────── */

  const root = el('div', 'fo-writer');
  const main = el('div', 'fo-wmain');
  const canvas = el('div', 'fo-canvas');
  const stage = el('div', 'fo-stage');
  const pageLayer = el('div', 'fo-pagelayer');
  pageLayer.setAttribute('aria-hidden', 'true');
  const flow = el('div', 'fo-flow');
  flow.contentEditable = ctx.editable() ? 'true' : 'false';
  flow.setAttribute('role', 'textbox');
  flow.setAttribute('aria-multiline', 'true');
  flow.setAttribute('aria-label', t('office.documentBody'));
  flow.spellcheck = true;
  stage.append(pageLayer, flow);
  const ruler = el('div', 'fo-ruler');
  ruler.setAttribute('aria-hidden', 'true');
  canvas.append(ruler, stage);
  const draft = el('div', 'fo-draft');
  draft.hidden = true;
  const side = el('aside', 'fo-side');
  side.hidden = true;
  // The phone's bottom bar: an Edit button while reading, the compact editing tools while editing.
  const phoneBar = el('div', 'fo-wphone');
  phoneBar.setAttribute('role', 'toolbar');
  phoneBar.setAttribute('aria-label', t('office.wMobileTools'));
  // Reading mode on a desktop window: one clear way back to editing.
  const readingBar = el('div', 'fo-wreading');
  readingBar.hidden = true;
  main.append(readingBar, canvas, draft, phoneBar);
  root.append(main, side);

  /* ─────────────────────────── the look of a paragraph ─────────────────────────── */

  function lookOf(block: DocBlock | undefined, seen = new Set<number>()): ParaLook | undefined {
    if (!block || !look) return undefined;
    if (block.id >= 0 && block.id < look.paras.length && block.tpl === undefined && !block.cell) return look.paras[block.id];
    if (block.tpl === undefined || seen.has(block.tpl)) return undefined;
    seen.add(block.tpl);
    if (block.tpl < look.paras.length) return look.paras[block.tpl];
    const tpl = doc()?.blocks?.find((b) => b.id === block.tpl);
    return lookOf(tpl, seen);
  }

  interface ParaView { dir: 'rtl' | 'ltr'; /** Direction guessed from the text for display (the file states none). */ autoDir: boolean; /** The file or the owner states a direction (else the page uses `dir="auto"`). */ stated: boolean; align: ParagraphAlign | undefined; text: TextLook; marker?: string; spaceBefore: number; spaceAfter: number; line?: number; lineExact: boolean; indStart: number; indEnd: number; firstLine: number; outline?: number; shade?: string }

  function paraView(i: number, counters: Map<string, number>): ParaView {
    const m = doc();
    const block = m?.blocks?.[i];
    const format: ParagraphFormat = m?.formats?.[i] ?? {};
    const pl = lookOf(block);
    const styled = format.style !== undefined && format.style !== pl?.styleId && look
      ? resolveStyle(look.styles, format.style ?? undefined)
      : pl ? { para: pl.para, text: pl.text, outline: pl.outline } : look ? resolveStyle(look.styles, undefined) : { para: {}, text: {}, outline: undefined };
    const para = styled.para;
    // The file's own direction wins; a paragraph that states none is shown in the
    // direction of its first strong letter (Arabic text reads right-to-left), for
    // display only — the saved XML is untouched until the owner edits it.
    const stated = format.dir ?? (para.bidi === undefined ? undefined : para.bidi ? 'rtl' : 'ltr');
    const autoDir = stated === undefined && startsRtl(block ? blockText(block) : '') === true;
    const dir: 'rtl' | 'ltr' = stated ?? (autoDir ? 'rtl' : 'ltr');
    let marker: string | undefined;
    if (format.list === 'bullet') marker = '•';
    else if (format.list === 'number') {
      const n = (counters.get('n') ?? 0) + 1;
      counters.set('n', n);
      marker = `${n}.`;
    } else if (format.list !== null) marker = pl?.marker;
    if (format.list !== 'number') counters.delete('n');
    const listIndent = (format.list === 'bullet' || format.list === 'number') && !pl?.marker ? 36 : 0;
    return {
      dir,
      autoDir,
      stated: stated !== undefined,
      align: format.align !== undefined ? format.align ?? undefined : para.align,
      text: styled.text,
      marker,
      spaceBefore: para.before ?? 0,
      spaceAfter: para.after ?? (look ? 0 : 8),
      line: format.line ?? para.line,
      lineExact: format.line ? false : !!para.lineExact,
      indStart: (format.indent !== undefined ? format.indent ?? 0 : para.indStart ?? 0) + listIndent,
      indEnd: para.indEnd ?? 0,
      firstLine: para.firstLine ?? (listIndent ? -18 : 0),
      outline: format.style !== undefined ? styled.outline : pl?.outline,
      shade: para.shade,
    };
  }

  function runCss(span: HTMLElement, base: TextLook, props: RunProps, rtl: boolean): void {
    const cs = rtl || props.rtl === true;
    const font = props.font ?? (cs ? base.fontCs ?? base.font : base.font);
    const size = props.sz ?? (cs ? base.szCs ?? base.sz : base.sz) ?? 11;
    const bold = props.b ?? base.b;
    const italic = props.i ?? base.i;
    const underline = props.u ?? base.u;
    const strike = props.strike ?? base.strike;
    const color = props.color ?? base.color;
    const hl = props.hl ?? base.hl;
    span.style.fontFamily = fontStack(font);
    span.style.fontSize = `${size}pt`;
    if (bold) span.style.fontWeight = '700';
    if (italic) span.style.fontStyle = 'italic';
    const deco = [underline ? 'underline' : '', strike ? 'line-through' : ''].filter(Boolean).join(' ');
    if (deco) span.style.textDecorationLine = deco;
    if (color) span.style.color = `#${color}`;
    if (hl) span.style.backgroundColor = hl.startsWith('#') ? hl : `#${HIGHLIGHTS[hl] ?? 'FFFF00'}`;
    if (props.va) {
      span.style.verticalAlign = props.va === 'superscript' ? 'super' : 'sub';
      span.style.fontSize = `${size * 0.65}pt`;
    }
    if (base.caps) span.style.textTransform = 'uppercase';
  }

  function imageUrl(run: OpaqueRun): string | null {
    if (run.newImage) {
      let url = newUrls.get(run.newImage.data);
      if (!url) {
        url = URL.createObjectURL(new Blob([run.newImage.data.slice()], { type: run.newImage.ext === 'jpeg' ? 'image/jpeg' : `image/${run.newImage.ext}` }));
        newUrls.set(run.newImage.data, url);
        mediaUrls.set(`new:${url}`, url);
      }
      return url;
    }
    const rid = run.image?.rid;
    if (!rid || !look) return null;
    const cached = mediaUrls.get(rid);
    if (cached) return cached;
    const media = look.media.get(rid);
    if (!media) return null;
    const url = URL.createObjectURL(new Blob([media.bytes.slice()], { type: media.mime }));
    mediaUrls.set(rid, url);
    return url;
  }

  function opaqueEl(run: OpaqueRun, b: number, index: number, base: TextLook, rtl: boolean): HTMLElement {
    const span = el('span', `fo-op fo-op-${run.kind}`);
    span.contentEditable = 'false';
    span.dataset.len = String(run.text.length);
    opaqueText.set(span, run.text);
    if (run.kind === 'image' || run.newImage) {
      const info = run.image ?? (run.newImage ? { w: run.newImage.w, h: run.newImage.h } : null);
      const url = imageUrl(run);
      if (url && info) {
        const img = el('img');
        img.src = url;
        img.alt = run.image?.alt ?? '';
        img.draggable = false;
        img.style.width = `${info.w}pt`;
        img.style.height = `${info.h}pt`;
        span.append(img);
        if (run.image?.float === 'start' || run.image?.float === 'end') span.classList.add(`is-float-${run.image.float}`);
        span.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();
          selectedImage = { b, run: index };
          flow.querySelectorAll('.fo-op.is-selected').forEach((n) => n.classList.remove('is-selected'));
          span.classList.add('is-selected');
          flow.focus({ preventScroll: true });
        });
      } else {
        span.classList.add('fo-op-missing');
        span.textContent = '▢';
      }
      return span;
    }
    if (run.kind === 'page') {
      span.classList.add('fo-pagebreak');
      span.append(el('span', 'fo-pagebreak-label', t('office.pageBreak')));
      return span;
    }
    if (isColumnBreak(run)) {
      span.classList.add('fo-pagebreak', 'fo-colbreak');
      span.append(el('span', 'fo-pagebreak-label', t('office.wColumnBreak')));
      return span;
    }
    if (run.kind === 'note' && run.note) {
      // A note reference is drawn as the number the reader sees. The badge is a MARKER, never text:
      // `reconcile()` and `locate()` read the paragraph back from the page and skip exactly the
      // elements carrying `data-skip` (the same rule `fo-marker` and the `<br>` filler follow), so
      // the number can never leak into the paragraph's text or push the caret — and
      // `contentEditable=false` keeps the caret out of the badge itself.
      const number = noteNumbers.get(`${doc()?.blocks?.[b]?.id ?? -1}:${index}`) ?? 0;
      const kind = run.note.kind;
      const blockId = doc()?.blocks?.[b]?.id ?? -1;
      span.classList.add('fo-note', `is-${kind}`);
      span.dataset.skip = '1';
      span.contentEditable = 'false';
      span.dataset.note = String(index);
      span.textContent = String(number);
      const label = t(kind === 'footnote' ? 'office.footnoteRef' : 'office.endnoteRef', { n: number });
      span.setAttribute('aria-label', label);
      // Tapping the number opens the note itself in the panel — the same place Word's own pane is,
      // and the only way to read a note whose text is not on the page.
      span.addEventListener('click', () => openNotes(blockId, index));
      return span;
    }
    if (run.kind === 'note' && run.ref && run.ref !== 'comment') {
      // A reference whose note is not in the package at all. It is shown — and claims no number —
      // so the owner can see the file is broken instead of wondering where the number went; the
      // note commands refuse to touch such a document (see `notesLocked`).
      span.classList.add('fo-note', 'is-missing');
      span.dataset.skip = '1';
      span.contentEditable = 'false';
      span.textContent = '?';
      span.setAttribute('aria-label', t('office.noteMissing'));
      return span;
    }
    const inner = el('span');
    runCss(inner, base, {}, rtl);
    inner.textContent = run.text;
    span.append(inner);
    if (run.kind === 'link') span.classList.add('is-link');
    return span;
  }

  function paraEl(i: number, counters: Map<string, number>): HTMLElement {
    const m = doc();
    const block = m?.blocks?.[i] as DocBlock;
    const view = paraView(i, counters);
    const p = el('div', 'fo-p');
    p.dataset.i = String(i);
    // A paragraph whose direction nothing states reads like `dir="auto"`: Arabic right-to-left,
    // English left-to-right, each by its own first letter.
    p.dir = view.stated ? view.dir : 'auto';
    // Without w:bidi, Word's left/right are physical edges even for Arabic text.
    p.style.textAlign = view.autoDir && (view.align === 'left' || view.align === 'right') ? view.align : cssAlign(view.align);
    p.style.fontFamily = fontStack(view.dir === 'rtl' ? view.text.fontCs ?? view.text.font : view.text.font);
    p.style.fontSize = `${(view.dir === 'rtl' ? view.text.szCs ?? view.text.sz : view.text.sz) ?? 11}pt`;
    if (view.text.color) p.style.color = `#${view.text.color}`;
    p.style.paddingTop = `${view.spaceBefore}pt`;
    p.style.paddingBottom = `${view.spaceAfter}pt`;
    if (view.line) p.style.lineHeight = view.lineExact ? `${view.line}pt` : String(Math.max(0.8, view.line * 1.17));
    if (view.indStart) p.style.paddingInlineStart = `${Math.max(0, view.indStart)}pt`;
    if (view.indEnd) p.style.paddingInlineEnd = `${Math.max(0, view.indEnd)}pt`;
    if (view.firstLine) p.style.textIndent = `${view.firstLine}pt`;
    if (view.shade) p.style.backgroundColor = `#${view.shade}`;
    if (view.outline !== undefined) p.dataset.outline = String(view.outline);
    if (block.locked) p.contentEditable = 'false';
    if (view.marker) {
      const marker = el('span', 'fo-marker', view.marker);
      marker.contentEditable = 'false';
      marker.dataset.skip = '1';
      marker.setAttribute('aria-hidden', 'true');
      if (view.text.color) marker.style.color = `#${view.text.color}`;
      p.append(marker);
    }
    // A paragraph with pending revisions is drawn from the plan: signed insertions marked, and the
    // text of a pending deletion put back in place, struck through. That deleted text is NOT part
    // of the paragraph any more, so it is rendered `data-skip` (the caret and the text reader both
    // skip it) — the model keeps saying exactly what the deletion produced.
    const marks = pendingRevisions(revLog).filter((r) => r.block === block.id);
    if (marks.length) {
      const text = blockText(block);
      const first = block.runs.find((r) => r.t === 'text' && r.text) as Extract<Run, { t: 'text' }> | undefined;
      for (const piece of planPieces(text, marks, block.id)) {
        if (piece.mark === 'none') {
          const span = el('span', 'fo-r');
          if (first) runCss(span, view.text, { ...first.styled, ...first.props }, view.dir === 'rtl');
          span.textContent = piece.text;
          p.append(span);
          continue;
        }
        const rev = piece.revision as Revision;
        const span = el('span', `fo-rev is-${piece.mark}`);
        span.dataset.rev = String(rev.id);
        span.title = `${t(rev.kind === 'insert' ? 'office.revInsert' : 'office.revDelete')} — ${authorStamp(rev)}`;
        // The sign is what makes the mark readable without relying on colour: + inserted, − deleted.
        const sign = el('span', 'fo-rev-sign', piece.mark === 'insert' ? '+' : '−');
        sign.dataset.skip = '1';
        sign.contentEditable = 'false';
        sign.setAttribute('aria-hidden', 'true');
        span.append(sign);
        const body = el('span', 'fo-rev-text');
        if (first) runCss(body, view.text, { ...first.styled, ...first.props }, view.dir === 'rtl');
        body.textContent = piece.text;
        span.append(body);
        if (piece.mark === 'delete') {
          // Visible, but not part of the paragraph: skipped by the caret and by the text reader.
          span.dataset.skip = '1';
          span.contentEditable = 'false';
          span.setAttribute('aria-label', `${t('office.revDelete')} — ${authorStamp(rev)}: ${piece.text}`);
        }
        p.append(span);
      }
      const shown = text;
      if (!shown || shown.endsWith('\n')) {
        const fill = el('br');
        fill.dataset.skip = '1';
        p.append(fill);
      }
      return p;
    }
    block.runs.forEach((run, index) => {
      if (run.t === 'opaque') { p.append(opaqueEl(run, i, index, view.text, view.dir === 'rtl')); return; }
      if (!run.text) return;
      const span = el('span', 'fo-r');
      runCss(span, view.text, { ...run.styled, ...run.props }, view.dir === 'rtl');
      span.textContent = run.text;
      p.append(span);
    });
    const text = blockText(block);
    if (!text || text.endsWith('\n')) {
      const fill = el('br');
      fill.dataset.skip = '1';
      p.append(fill);
    }
    return p;
  }

  /** The table (of the file or inserted this session) a block belongs to. */
  function tableKey(block: DocBlock): string | null {
    if (block.cell) return `n${block.cell.table}`;
    const pl = lookOf(block);
    return pl?.cell ? `t${pl.cell.table}` : null;
  }

  function tableEl(start: number, end: number, counters: Map<string, number>, paras: HTMLElement[]): HTMLElement {
    const m = doc() as DocModel;
    const blocks = m.blocks as DocBlock[];
    const first = blocks[start];
    const wrap = el('div', 'fo-tablewrap');
    const table = el('table', 'fo-table');
    wrap.append(table);
    if (first.cell) {
      const meta = first.cell;
      table.dir = meta.rtl ? 'rtl' : 'ltr';
      for (let r = 0; r < meta.rows; r++) {
        const tr = el('tr');
        for (let c = 0; c < meta.cols; c++) {
          const td = el('td');
          td.style.border = '0.75pt solid #000';
          for (let i = start; i < end; i++) {
            if (blocks[i].cell?.row === r && blocks[i].cell?.col === c) { const p = paraEl(i, counters); paras[i] = p; td.append(p); }
          }
          tr.append(td);
        }
        table.append(tr);
      }
      return wrap;
    }
    const pl = lookOf(first);
    const tl = look && pl?.cell ? look.tables[pl.cell.table] : undefined;
    if (!tl) return wrap;
    table.dir = tl.rtl ? 'rtl' : 'ltr';
    const colgroup = el('colgroup');
    for (const w of tl.grid) { const col = el('col'); col.style.width = `${w}pt`; colgroup.append(col); }
    table.append(colgroup);
    table.style.width = `${tl.grid.reduce((a, b) => a + b, 0)}pt`;
    if (tl.align === 'center') table.style.marginInline = 'auto';
    const cellsOf = new Map<string, number[]>();
    for (let i = start; i < end; i++) {
      const c = lookOf(blocks[i])?.cell;
      if (!c) continue;
      const key = `${c.row}:${c.cell}`;
      cellsOf.set(key, [...(cellsOf.get(key) ?? []), i]);
    }
    const bordersFor = (td: HTMLElement, cell: typeof tl.rows[number]['cells'][number], r: number, colIndex: number): void => {
      const b = tl.borders;
      const outer = (edge: 'top' | 'bottom' | 'start' | 'end'): string | undefined => cell.borders[edge] ?? (
        edge === 'top' ? (r === 0 ? b.top : b.insideH) :
          edge === 'bottom' ? (r === tl.rows.length - 1 ? b.bottom : b.insideH) :
            edge === 'start' ? (colIndex === 0 ? b.start : b.insideV) :
              (cell.gridCol + cell.span >= tl.grid.length ? b.end : b.insideV));
      const set = (edge: 'top' | 'bottom' | 'start' | 'end', css: string): void => {
        const value = outer(edge);
        if (value && value !== 'none') td.style.setProperty(css, value);
      };
      set('top', 'border-top');
      set('bottom', 'border-bottom');
      set('start', 'border-inline-start');
      set('end', 'border-inline-end');
    };
    tl.rows.forEach((row, r) => {
      const tr = el('tr');
      if (row.height) tr.style.height = `${row.height}pt`;
      row.cells.forEach((cell, c) => {
        const indices = cellsOf.get(`${r}:${c}`) ?? [];
        if (cell.vMerge === 'continue') {
          // Its (empty) paragraphs belong to the merged cell above.
          let up = r - 1;
          while (up >= 0 && tl.rows[up].cells.find((x) => x.gridCol === cell.gridCol)?.vMerge === 'continue') up--;
          const owner = table.querySelector<HTMLElement>(`td[data-cell="${up}:${cell.gridCol}"]`);
          for (const i of indices) { const p = paraEl(i, counters); paras[i] = p; (owner ?? tr).append(p); }
          return;
        }
        const td = el('td');
        td.dataset.cell = `${r}:${cell.gridCol}`;
        if (cell.span > 1) td.colSpan = cell.span;
        if (cell.vMerge === 'restart') {
          let span = 1;
          for (let down = r + 1; down < tl.rows.length; down++) {
            if (tl.rows[down].cells.find((x) => x.gridCol === cell.gridCol)?.vMerge === 'continue') span++;
            else break;
          }
          td.rowSpan = span;
        }
        if (cell.fill && cell.fill !== 'AUTO') td.style.backgroundColor = `#${cell.fill}`;
        if (cell.vAlign === 'center') td.style.verticalAlign = 'middle';
        else if (cell.vAlign === 'bottom') td.style.verticalAlign = 'bottom';
        bordersFor(td, cell, r, c);
        for (const i of indices) { const p = paraEl(i, counters); paras[i] = p; td.append(p); }
        tr.append(td);
      });
      table.append(tr);
    });
    return wrap;
  }

  let paraEls: HTMLElement[] = [];  let units: HTMLElement[] = [];
  let unitOfPara: number[] = [];

  /* ───────────────────────── tracked changes ───────────────────────── */

  /** Tracking is a per-document toggle; the log records every change made while it is on. */
  let tracking = false;
  // A document opened from a file that already carries tracked changes starts with them pending:
  // the marks are the file's own, and the save writes them back.
  let revLog: RevisionLog = doc()?.tracked ?? emptyLog();
  /** The review panel, when it is open. */
  let reviewPanel: HTMLElement | null = null;

  /** Records what an edit changed, in the paragraph's own coordinates. */
  function track(before: string, after: string, blockId: number): void {
    if (!tracking) return;
    for (const change of revisionsOf(before, after)) revLog = record(revLog, { ...change, block: blockId });
  }

  /** The index of the paragraph with this stable id, or -1. */
  function indexOfBlock(id: number): number {
    const blocks = (doc()?.blocks ?? []) as DocBlock[];
    return blocks.findIndex((b) => b.id === id);
  }

  /**
   * A verdict on one revision: the log moves in memory, and rejecting turns into a REAL paragraph
   * edit (remove what was inserted, restore what was deleted) so undo takes it back in one step.
   */
  function applyDecision(id: number, action: 'accept' | 'reject'): void {
    const done = decide(revLog, id, action);
    revLog = done.log;
    if (done.change) commitChanges([done.change]);
    else renderFlow();
    renderReview();
    ctx.refresh();
  }

  function applyAllDecisions(action: 'accept' | 'reject'): void {
    const done = decideAll(revLog, action);
    revLog = done.log;
    commitChanges(done.changes);
    renderReview();
    ctx.refresh();
  }

  /** All the paragraph changes of one verdict as a SINGLE undoable edit. */
  function commitChanges(changes: readonly Change[]): void {
    const m = doc();
    if (!m) return;
    const edits = changes
      .filter((c) => c.op !== 'none')
      .map((c) => {
        const index = indexOfBlock(c.block);
        if (index < 0) return null;
        const before = m.paragraphs[index] ?? '';
        const after = applyChangeToText(before, c);
        if (after === before) return null;
        return { index, edit: paragraphEdit(index, before, after) };
      })
      .filter((e): e is { index: number; edit: ReturnType<typeof paragraphEdit> } => e !== null);
    if (!edits.length) { renderFlow(); return; }
    if (edits.length === 1) ctx.commit(edits[0].edit);
    else {
      // Chained in order, and undone in reverse: one step in the history, exactly like one edit.
      ctx.commit({
        key: 'revisions',
        apply: (model) => edits.reduce((acc, e) => e.edit.apply(acc), model),
        revert: (model) => [...edits].reverse().reduce((acc, e) => e.edit.revert(acc), model),
      });
    }
    renderFlow();
  }

  /** The review panel: every pending change, with a real button for each verdict. */
  function renderReview(): void {
    if (!reviewPanel) return;
    const body = reviewPanel.querySelector<HTMLElement>('.fo-review-list');
    if (!body) return;
    const items = pendingRevisions(revLog);
    body.replaceChildren();
    if (!items.length) {
      body.append(el('div', 'fo-review-empty', t('office.revNone')));
      return;
    }
    for (const rev of items) {
      const row = el('div', 'fo-review-row');
      const what = el('div', 'fo-review-what');
      const label = el('span', `fo-review-kind is-${rev.kind}`, t(rev.kind === 'insert' ? 'office.revInsert' : 'office.revDelete'));
      const text = el('span', 'fo-review-text', rev.text.length > 40 ? `${rev.text.slice(0, 40)}…` : rev.text);
      const meta = el('span', 'fo-review-meta', authorStamp(rev));
      what.append(label, text, meta);
      const accept = el('button', 'fo-review-btn is-accept', t('office.revAccept'));
      accept.type = 'button';
      accept.setAttribute('aria-label', `${t('office.revAccept')} — ${rev.text.slice(0, 20)}`);
      accept.addEventListener('click', () => applyDecision(rev.id, 'accept'));
      const reject = el('button', 'fo-review-btn is-reject', t('office.revReject'));
      reject.type = 'button';
      reject.setAttribute('aria-label', `${t('office.revReject')} — ${rev.text.slice(0, 20)}`);
      reject.addEventListener('click', () => applyDecision(rev.id, 'reject'));
      row.append(what, accept, reject);
      body.append(row);
    }
  }

  function toggleReviewPanel(force?: boolean): void {
    if (reviewPanel && force !== true) { reviewPanel.remove(); reviewPanel = null; return; }
    if (reviewPanel) return;
    const panel = el('div', 'fo-review');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('office.revPanel'));
    const head = el('div', 'fo-review-head');
    head.append(el('span', 'fo-review-title', t('office.revPanel')));
    const close = el('button', 'fo-review-close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', t('office.cancel'));
    close.addEventListener('click', () => toggleReviewPanel(false));
    head.append(close);
    const list = el('div', 'fo-review-list');
    // What the panel says about the FILE is the truth, not a promise: the changes wait for a
    // decision here, and a save writes them as w:ins/w:del and reads them back on open.
    panel.append(head, el('div', 'fo-review-note', t('office.revNotSaved')), list);
    panel.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); toggleReviewPanel(false); } });
    root.append(panel);
    reviewPanel = panel;
    renderReview();
    panel.querySelector<HTMLElement>('.fo-review-btn')?.focus();
  }

  async function confirmBulk(action: 'accept' | 'reject'): Promise<void> {
    const n = pendingRevisions(revLog).length;
    if (!n) return;
    const ok = await shellConfirm({
      title: t(action === 'accept' ? 'office.revAcceptAll' : 'office.revRejectAll'),
      message: t(action === 'accept' ? 'office.revAcceptAllBody' : 'office.revRejectAllBody', { n }),
      okLabel: t(action === 'accept' ? 'office.revAccept' : 'office.revReject'),
      cancelLabel: t('office.cancel'),
      danger: action === 'reject',
    });
    if (ok) applyAllDecisions(action);
  }

  function renderFlow(): void {
    const m = doc();
    flow.replaceChildren();
    paraEls = [];
    units = [];
    unitOfPara = [];
    recountNotes();
    if (!m) return;
    const blocks = m.blocks as DocBlock[];
    const counters = new Map<string, number>();
    let i = 0;
    while (i < blocks.length) {
      const key = tableKey(blocks[i]);
      if (key) {
        let end = i;
        while (end < blocks.length && tableKey(blocks[end]) === key) end++;
        const unit = tableEl(i, end, counters, paraEls);
        for (let k = i; k < end; k++) unitOfPara[k] = units.length;
        units.push(unit);
        flow.append(unit);
        i = end;
        continue;
      }
      const p = paraEl(i, counters);
      paraEls[i] = p;
      unitOfPara[i] = units.length;
      units.push(p);
      flow.append(p);
      i++;
    }
    schedulePaginate();
  }

  /** Redraws one paragraph in place (typing); tables and structure changes redraw the flow. */
  function updatePara(i: number): void {
    const old = paraEls[i];
    const m = doc();
    if (!old || !m) { renderFlow(); return; }
    recountNotes();
    const counters = new Map<string, number>();
    // List counters depend on the paragraphs before: recount cheaply.
    for (let k = 0; k < i; k++) {
      const f = m.formats?.[k];
      if (f?.list === 'number') counters.set('n', (counters.get('n') ?? 0) + 1);
      else counters.delete('n');
    }
    const p = paraEl(i, counters);
    old.replaceWith(p);
    if (units[unitOfPara[i]] === old) units[unitOfPara[i]] = p;
    paraEls[i] = p;
    schedulePaginate();
  }

  /* ─────────────────────────── pages ─────────────────────────── */

  let paginateTimer = 0;
  function schedulePaginate(): void {
    if (paginateTimer) return;
    paginateTimer = window.setTimeout(() => { paginateTimer = 0; layoutPages(); }, 60);
  }

  /** The page the document is laid out on: the owner's setup, else the file's section, else A4. */
  function pageSetup(): PageSetup {
    const own = doc()?.page;
    if (own) return own;
    const p = look?.page;
    return p ? { w: p.w, h: p.h, top: p.top, bottom: p.bottom, left: p.left, right: p.right, header: p.header, footer: p.footer, cols: p.cols, colGap: p.colGap } : DEFAULT_PAGE;
  }

  function pageGeometry(): { w: number; h: number; top: number; bottom: number; left: number; right: number; cols: number; colGap: number } {
    const p = pageSetup();
    // As in Word, a header taller than the top margin pushes the text down (and a footer, up).
    const hf = hfNow();
    const lines = (x: HfSetup | null): number => (x ? x.text.split('\n').filter((l) => l.trim()).length : 0);
    const LINE = 9 * 1.4;
    const top = Math.max(p.top, lines(hf.header) ? p.header + lines(hf.header) * LINE + 6 : 0);
    const bottom = Math.max(p.bottom, lines(hf.footer) ? p.footer + lines(hf.footer) * LINE + 6 : 0);
    return { w: p.w * PX, h: p.h * PX, top: top * PX, bottom: bottom * PX, left: p.left * PX, right: p.right * PX, cols: Math.max(1, p.cols), colGap: p.colGap * PX };
  }

  /** The document's default header and footer: the owner's, else the file's. */
  function hfNow(): HeaderFooterSetup {
    const own = doc()?.headerFooter;
    if (own) return own;
    const of = (hf: { lines: Array<{ text: string; align?: ParagraphAlign }> } | undefined): HfSetup | null =>
      hf?.lines.length ? { text: hfText(hf.lines), align: hf.lines[0].align ?? 'left' } : null;
    return { header: of(look?.headers.default), footer: of(look?.footers.default) };
  }

  /** The body's direction, which a header or footer written here follows. */
  function docRtl(): boolean {
    return paraView(0, new Map()).dir === 'rtl';
  }

  function headerFooter(kind: 'headers' | 'footers', page: number): HTMLElement | null {
    const cls = kind === 'headers' ? 'fo-header' : 'fo-footer';
    const own = doc()?.headerFooter;
    // A first-page header the file keeps (titlePg) still shows on the first page.
    if (own && !(page === 0 && look?.page.titlePage)) {
      const hf = own[kind === 'headers' ? 'header' : 'footer'];
      if (!hf) return null;
      const box = el('div', cls);
      const rtl = docRtl();
      for (const line of hf.text.split('\n')) {
        const row = el('div', 'fo-hfline', hfDisplay(line, page + 1, pageCount));
        row.dir = rtl ? 'rtl' : 'ltr';
        row.style.textAlign = cssAlign(hf.align);
        box.append(row);
      }
      return box;
    }
    const set = look?.[kind];
    const hf = page === 0 && look?.page.titlePage ? set?.first : set?.default;
    if (!hf) return null;
    const box = el('div', cls);
    for (const line of hf.lines) {
      const row = el('div', 'fo-hfline', hfDisplay(line.text, page + 1, pageCount));
      row.dir = line.rtl ? 'rtl' : 'ltr';
      row.style.textAlign = cssAlign(line.align);
      if (line.size) row.style.fontSize = `${line.size}pt`;
      box.append(row);
    }
    return box;
  }

  /** The margin band above or below a page's text: a double-click there edits the header or footer. */
  function hfZone(kind: 'headers' | 'footers', g: ReturnType<typeof pageGeometry>, page: number): HTMLElement {
    const setup = pageSetup();
    const box = headerFooter(kind, page) ?? el('div', `${kind === 'headers' ? 'fo-header' : 'fo-footer'} is-empty`);
    box.title = t(kind === 'headers' ? 'office.wHeader' : 'office.wFooter');
    if (kind === 'headers') box.style.top = `${setup.header * PX}px`;
    else box.style.bottom = `${setup.footer * PX}px`;
    // Word's margins are physical edges: left is left in either direction.
    box.style.left = `${g.left}px`;
    box.style.right = `${g.right}px`;
    const band = kind === 'headers' ? setup.top * PX - setup.header * PX : setup.bottom * PX - setup.footer * PX;
    box.style.minHeight = `${Math.max(12, band - 4)}px`;
    box.addEventListener('dblclick', () => { if (can() && !reading) openHeaderFooter(kind === 'headers' ? 'header' : 'footer'); });
    return box;
  }

  function layoutPages(): void {
    const g = pageGeometry();
    const cols = fluid ? 1 : g.cols;
    const colWidth = (g.w - g.left - g.right - (cols - 1) * g.colGap) / cols;
    stage.style.width = fluid ? '' : `${g.w}px`;
    flow.style.width = fluid ? '' : `${colWidth}px`;
    flow.style.insetInlineStart = '';
    flow.style.left = fluid ? '' : `${g.left}px`;
    flow.style.top = fluid ? '' : `${g.top}px`;
    flow.style.height = '';
    for (const unit of units) { unit.style.top = ''; unit.style.left = ''; unit.style.position = ''; }
    if (fluid) {
      for (const unit of units) unit.style.marginTop = '';
      pageLayer.replaceChildren();
      pageCount = 1;
      stage.style.height = '';
      renderRuler();
      ctx.refresh();
      return;
    }
    const heights = units.map((u) => u.offsetHeight);
    const breaks = new Set<number>();
    const columnBreaks = new Set<number>();
    units.forEach((u, k) => {
      if (k + 1 >= units.length) return;
      if (u.querySelector(':scope > .fo-pagebreak:not(.fo-colbreak), :scope .fo-p > .fo-pagebreak:not(.fo-colbreak)')) breaks.add(k + 1);
      else if (u.querySelector(':scope > .fo-colbreak, :scope .fo-p > .fo-colbreak')) columnBreaks.add(k + 1);
    });
    const stride = g.h + GAP;
    let pages: number;
    if (cols > 1) {
      // Newspaper columns: each block is moved (relatively, never in the DOM) to its column's slot.
      const content = g.h - g.top - g.bottom;
      const laid = paginateColumns(heights, content, cols, breaks, columnBreaks);
      let natural = 0;
      units.forEach((u, k) => {
        const slot = laid.slots[k];
        if (u.style.marginTop) u.style.marginTop = '';
        u.style.position = 'relative';
        u.style.top = `${slot.page * stride + slot.y - natural}px`;
        // Columns run left to right, as Word lays out a section that is not marked right-to-left.
        u.style.left = `${slot.col * (colWidth + g.colGap)}px`;
        natural += heights[k];
      });
      pages = laid.pages;
      pageOfUnit = laid.slots.map((slot) => slot.page);
      flow.style.height = `${Math.max(0, pages * g.h + (pages - 1) * GAP - g.top - g.bottom)}px`;
    } else {
      const result = paginate(heights, { height: g.h, gap: GAP, top: 0, bottom: g.top + g.bottom }, breaks);
      units.forEach((u, k) => {
        const want = result.pushes[k] ? `${result.pushes[k]}px` : '';
        if (u.style.marginTop !== want) u.style.marginTop = want;
      });
      pages = result.pages;
      pageOfUnit = result.pageOf;
    }
    pageCount = pages;
    const layer: HTMLElement[] = [];
    for (let k = 0; k < pages; k++) {
      const page = el('div', 'fo-page');
      page.style.top = `${k * stride}px`;
      page.style.height = `${g.h}px`;
      page.append(hfZone('headers', g, k), hfZone('footers', g, k));
      for (let c = 1; c < cols; c++) {
        const rule = el('div', 'fo-colrule');
        rule.style.left = `${g.left + c * colWidth + (c - 0.5) * g.colGap}px`;
        rule.style.top = `${g.top}px`;
        rule.style.bottom = `${g.bottom}px`;
        page.append(rule);
      }
      layer.push(page);
    }
    pageLayer.replaceChildren(...layer);
    stage.style.height = `${pages * g.h + (pages - 1) * GAP}px`;
    updateCaretPage();
    renderRuler();
    ctx.refresh();
  }

  /** The horizontal ruler over the page: the text area between the margins, a tick every half centimetre. */
  function renderRuler(): void {
    const g = pageGeometry();
    ruler.hidden = !showRuler || fluid || mode !== 'page' || reading;
    if (ruler.hidden) return;
    ruler.replaceChildren();
    ruler.style.width = `${g.w}px`;
    ruler.style.zoom = String(zoom);
    const rtl = docRtl();
    const text = el('div', 'fo-ruler-text');
    // Word's left and right margins are physical edges of the page, in either direction.
    text.style.left = `${g.left}px`;
    text.style.right = `${g.right}px`;
    ruler.append(text);
    const half = (72 / 2.54) * PX / 2;
    const origin = rtl ? g.w - g.right : g.left;
    const span = rtl ? origin : g.w - origin;
    const before = rtl ? g.w - origin : origin;
    for (let k = -Math.floor(before / half); k * half <= span; k++) {
      const x = rtl ? origin - k * half : origin + k * half;
      const major = k % 2 === 0;
      const tick = el('div', major ? 'fo-ruler-tick is-major' : 'fo-ruler-tick');
      tick.style.left = `${x}px`;
      ruler.append(tick);
      if (major && k > 0) {
        const n = el('span', 'fo-ruler-num', String(k / 2));
        n.style.left = `${x}px`;
        ruler.append(n);
      }
    }
  }

  let pageOfUnit: number[] = [];

  function updateCaretPage(): void {
    const b = lastSel?.from.b ?? 0;
    caretPage = pageOfUnit[unitOfPara[b] ?? 0] ?? 0;
  }

  function applyZoom(): void {
    const g = pageGeometry();
    const width = canvas.clientWidth;
    fluid = width > 0 && width < 700;
    root.classList.toggle('is-fluid', fluid);
    if (fitWidth && width > 0 && !fluid) zoom = clamp((width - 48) / g.w, 0.5, 1);
    stage.style.zoom = fluid ? '' : String(zoom);
    // A phone opens the document to read it first; its Edit button brings the editing tools.
    const narrow = isNarrow();
    if (narrow && !narrowSeen) { narrowSeen = true; setReading(true); }
    else if (!narrow && narrowSeen) { narrowSeen = false; if (reading) setReading(false); }
    readingBar.hidden = !reading || narrow;
    renderPhoneBar();
    schedulePaginate();
  }

  /* ─────────────────────────── the Draft view ─────────────────────────── */

  function renderDraft(): void {
    const m = doc();
    const list = el('div', 'fo-draft-list');
    (m?.blocks ?? []).forEach((block, i) => {
      const row = el('div', 'fo-draft-row');
      row.append(el('span', 'fo-draft-index', t('office.paragraphLabel', { n: i + 1 })));
      const area = el('textarea', 'faisal-office-para');
      area.value = blockText(block);
      area.rows = 1;
      area.dir = 'auto';
      area.readOnly = !ctx.editable() || !!block.locked;
      area.setAttribute('aria-label', t('office.paragraphLabel', { n: i + 1 }));
      area.addEventListener('focus', () => { draftPara = i; ctx.refresh(); });
      area.addEventListener('input', () => {
        const cur = doc();
        if (!cur) return;
        const before = cur.paragraphs[i] ?? '';
        if (before === area.value) return;
        ctx.commit(paragraphEdit(i, before, area.value));
        grow(area);
        if (mode === 'page') updatePara(i);
      });
      grow(area);
      row.append(area);
      list.append(row);
    });
    draft.replaceChildren(list);
  }

  function grow(area: HTMLTextAreaElement): void {
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight || 0, 480)}px`;
  }

  /* ─────────────────────────── selection ─────────────────────────── */

  function lenOf(n: Node): number {
    if (n.nodeType === Node.TEXT_NODE) return (n as Text).data.length;
    if (!(n instanceof HTMLElement)) return 0;
    if (n.dataset.skip) return 0;
    if (n.dataset.len !== undefined) return Number(n.dataset.len);
    if (n.tagName === 'BR') return 1;
    let s = 0;
    n.childNodes.forEach((c) => { s += lenOf(c); });
    return s;
  }

  function paraOf(node: Node | null): HTMLElement | null {
    const element = node instanceof HTMLElement ? node : node?.parentElement ?? null;
    return element?.closest<HTMLElement>('.fo-p') ?? null;
  }

  function offsetIn(p: HTMLElement, node: Node, offset: number): number {
    let target: Node = node;
    let off = offset;
    const opaque = (node instanceof HTMLElement ? node : node.parentElement)?.closest<HTMLElement>('[data-len]');
    if (opaque && p.contains(opaque)) {
      target = opaque.parentNode as Node;
      off = [...target.childNodes].indexOf(opaque) + 1;
    }
    let total = 0;
    if (target.nodeType === Node.TEXT_NODE) total += off;
    else for (let k = 0; k < off && k < target.childNodes.length; k++) total += lenOf(target.childNodes[k]);
    let cur: Node = target;
    while (cur !== p && cur.parentNode) {
      for (let sib = cur.previousSibling; sib; sib = sib.previousSibling) total += lenOf(sib);
      cur = cur.parentNode;
    }
    return total;
  }

  /**
   * A selection boundary as a paragraph position. A boundary inside a paragraph is read from its
   * text; one that sits BETWEEN paragraphs (Select All puts both ends on the flow itself, a triple
   * click ends on a table cell) is the start of the first paragraph after it, or the end of the
   * last one before it — so a selection made that way is formatted, not silently ignored.
   */
  function posOf(node: Node, offset: number): Pos | null {
    const p = paraOf(node);
    if (p && flow.contains(p)) return { b: Number(p.dataset.i), o: offsetIn(p, node, offset) };
    if (node !== flow && !flow.contains(node)) return null;
    const point = document.createRange();
    try { point.setStart(node, offset); } catch { return null; }
    let last: number | null = null;
    for (let b = 0; b < paraEls.length; b++) {
      const para = paraEls[b];
      if (!para) continue;
      // The paragraph starts at or after the boundary: the boundary is its start.
      if (point.comparePoint(para, 0) >= 0) return { b, o: 0 };
      last = b;
    }
    return last === null ? null : { b: last, o: (doc()?.paragraphs[last] ?? '').length };
  }

  function readSel(): Sel | null {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !s.anchorNode || !s.focusNode) return null;
    const a = posOf(s.anchorNode, s.anchorOffset);
    const f = posOf(s.focusNode, s.focusOffset);
    if (!a || !f) return null;
    const forward = a.b < f.b || (a.b === f.b && a.o <= f.o);
    const from = forward ? a : f;
    const to = forward ? f : a;
    return { from, to, collapsed: from.b === to.b && from.o === to.o };
  }

  function locate(p: HTMLElement, o: number): { node: Node; offset: number } {
    let left = o;
    const walk = (parent: Node): { node: Node; offset: number } | null => {
      const kids = [...parent.childNodes];
      for (let k = 0; k < kids.length; k++) {
        const n = kids[k];
        if (n instanceof HTMLElement && n.dataset.skip) continue;
        if (n.nodeType === Node.TEXT_NODE) {
          const len = (n as Text).data.length;
          if (left <= len) return { node: n, offset: left };
          left -= len;
          continue;
        }
        if (n instanceof HTMLElement && n.dataset.len !== undefined) {
          const len = Number(n.dataset.len);
          if (left === 0) return { node: parent, offset: k };
          if (left <= len) return { node: parent, offset: k + 1 };
          left -= len;
          continue;
        }
        const found = walk(n);
        if (found) return found;
      }
      return null;
    };
    const found = walk(p);
    if (found) return found;
    const fill = p.querySelector(':scope > br[data-skip]');
    return { node: p, offset: fill ? [...p.childNodes].indexOf(fill) : p.childNodes.length };
  }

  /**
   * The note reference the caret is sitting against in the page: the one before it (Backspace) or
   * the one after it (Delete). A reference is zero-width, so the paragraph's offsets say the same
   * thing on both of its sides — the DOM boundary is the only witness of which side the caret is on.
   */
  function noteAtCaret(direction: 'before' | 'after'): { blockId: number; runIndex: number } | null {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !s.isCollapsed) return null;
    const range = s.getRangeAt(0);
    const p = paraOf(range.startContainer);
    if (!p || !flow.contains(p)) return null;
    const badge = touchingNote(range.startContainer, range.startOffset, direction, p);
    if (!badge) return null;
    const block = blocksNow()[Number(p.dataset.i)];
    const runIndex = Number(badge.dataset.note);
    if (!block || !Number.isInteger(runIndex)) return null;
    return { blockId: block.id, runIndex };
  }

  /** The note badge touching a caret boundary inside `p`, walking out to the paragraph itself. */
  function touchingNote(container: Node, offset: number, direction: 'before' | 'after', p: HTMLElement): HTMLElement | null {
    const asBadge = (n: Node | undefined): HTMLElement | null =>
      n instanceof HTMLElement && n.classList.contains('fo-note') ? n : null;
    let node: Node | null = container;
    let off = offset;
    while (node) {
      // The paragraph itself is the last level: past it there is nothing to delete from.
      const atParagraph = node === p;
      if (node.nodeType === Node.TEXT_NODE) {
        // Inside a run's text there is no element on that side unless the boundary is its very edge.
        const text = node as Text;
        if ((direction === 'before' ? off : text.data.length - off) !== 0) return null;
      } else {
        const kids = [...node.childNodes];
        if (direction === 'before' ? off > 0 : off < kids.length) {
          return asBadge(direction === 'before' ? kids[off - 1] : kids[off]);
        }
      }
      if (atParagraph) return null;
      const parent: Node | null = node.parentNode;
      if (!parent) return null;
      off = [...parent.childNodes].indexOf(node as ChildNode) + (direction === 'after' ? 1 : 0);
      node = parent;
    }
    return null;
  }

  function setCaret(from: Pos, to: Pos = from): void {
    const pa = paraEls[from.b];
    const pb = paraEls[to.b];
    if (!pa || !pb) return;
    const a = locate(pa, from.o);
    const b = locate(pb, to.o);
    const s = window.getSelection();
    if (!s) return;
    try {
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      s.removeAllRanges();
      s.addRange(range);
    } catch { /* a node vanished during a redraw: the next click places the caret */ }
    lastSel = { from, to, collapsed: from.b === to.b && from.o === to.o };
    // The caret moved away from where formatting was picked: that formatting is dropped.
    if (pending && (!lastSel.collapsed || !pendingAt || pendingAt.b !== from.b || pendingAt.o !== from.o)) { pending = null; pendingAt = null; }
    updateCaretPage();
  }

  document.addEventListener('selectionchange', onSelectionChange);
  function onSelectionChange(): void {
    const sel = readSel();
    if (!sel) return;
    lastSel = sel;
    draftPara = null;
    // Formatting picked with no selection belongs to the spot where it was picked: a selection,
    // or a caret moved elsewhere, drops it — it never leaks into the next lines.
    if (pending && (!sel.collapsed || !pendingAt || pendingAt.b !== sel.from.b || pendingAt.o !== sel.from.o)) {
      pending = null;
      pendingAt = null;
    }
    updateCaretPage();
    renderPhoneBar();
    ctx.refresh();
  }

  /** The ranges a formatting command acts on: a Draft paragraph, or the selection. */
  function targetRange(): Sel | null {
    const m = doc();
    if (!m) return null;
    if (draftPara !== null && m.blocks?.[draftPara]) {
      const len = (m.paragraphs[draftPara] ?? '').length;
      return { from: { b: draftPara, o: 0 }, to: { b: draftPara, o: len }, collapsed: len === 0 };
    }
    // The page's own selection when it is in the document: `selectionchange` arrives a task later,
    // and a shortcut pressed right after a double-click must format the word just selected.
    const live = mode === 'page' ? readSel() : null;
    if (live) {
      if (pending && (!live.collapsed || !pendingAt || pendingAt.b !== live.from.b || pendingAt.o !== live.from.o)) { pending = null; pendingAt = null; }
      lastSel = live;
    }
    return lastSel;
  }

  /* ─────────────────────────── editing ─────────────────────────── */

  function blocksNow(): DocBlock[] { return doc()?.blocks ?? []; }

  function commitSplice(start: number, count: number, blocks: DocBlock[], formats: Array<ParagraphFormat | undefined>, caret: Pos | null, key?: string): void {
    const m = doc();
    if (!m || !ctx.editable()) return;
    ctx.commit(blockSplice(start, sliceOf(m, start, count), { blocks, formats }, key));
    if (count === blocks.length && count === 1 && !tableKey(blocks[0])) updatePara(start);
    else renderFlow();
    if (mode === 'draft') renderDraft();
    if (caret) setCaret(caret);
  }

  function formatAt(i: number): ParagraphFormat | undefined { return doc()?.formats?.[i]; }

  /** Replaces the selection (which may span paragraphs) with text. */
  function insertText(sel: Sel, text: string): void {
    const blocks = blocksNow();
    const first = blocks[sel.from.b];
    const last = blocks[sel.to.b];
    if (!first || !last || first.locked) return;
    const beforeText = blockText(first);
    const removedInside = sel.from.b === sel.to.b ? beforeText.slice(sel.from.o, sel.to.o) : beforeText.slice(sel.from.o);
    let merged: DocBlock;
    if (sel.from.b === sel.to.b) {
      merged = { ...first, runs: replaceText(first.runs, sel.from.o, sel.to.o, text, pending ?? undefined) };
    } else {
      const head = { ...first, runs: replaceText(first.runs, sel.from.o, blockText(first).length, '') };
      const tail = { ...last, runs: replaceText(last.runs, 0, sel.to.o, '') };
      const joined = mergeBlocks(head, tail);
      merged = { ...joined, runs: replaceText(joined.runs, sel.from.o, sel.from.o, text, pending ?? undefined) };
    }
    if (pending) {
      const applied = pending;
      merged = { ...merged, runs: formatRange(merged.runs, sel.from.o, sel.from.o + text.length, applied) };
    }
    let format = formatAt(sel.from.b);
    // The first letters typed into a paragraph set its direction, like `dir="auto"`: Arabic reads
    // right-to-left and English left-to-right, and the file says so too (w:bidi), so Word agrees.
    const turn = sel.from.b === sel.to.b ? typedDirection(beforeText, text, paraView(sel.from.b, new Map()).dir) : null;
    if (turn) format = { ...(format ?? {}), dir: turn };
    if (/\s/.test(text)) wordToken++;
    // Tracked: the deletion (what the edit removed) and the insertion (what it typed), in the
    // paragraph's own coordinates. A burst of typing merges into one revision inside the log.
    if (tracking) {
      const deleted = removedInside + (sel.from.b === sel.to.b ? '' : blockText(last).slice(0, sel.to.o));
      // Older marks first: this edit moves the text they point at by the net length change.
      revLog = shiftAfter(revLog, first.id, sel.from.o, text.length - deleted.length);
      if (deleted) revLog = record(revLog, { kind: 'delete', block: first.id, at: sel.from.o, text: deleted });
      if (text) revLog = record(revLog, { kind: 'insert', block: first.id, at: sel.from.o, text });
      renderReview();
    }
    const key = sel.collapsed && sel.from.b === sel.to.b && !turn ? `type:${first.id}:${wordToken}` : undefined;
    pending = null;
    pendingAt = null;
    commitSplice(sel.from.b, sel.to.b - sel.from.b + 1, [merged], [format], { b: sel.from.b, o: sel.from.o + text.length }, key);
  }

  function deleteRange(sel: Sel): void { insertText(sel, ''); }

  function enter(sel: Sel): void {
    let s = sel;
    if (!s.collapsed) { deleteRange(s); s = lastSel ?? s; }
    const blocks = blocksNow();
    const block = blocks[s.from.b];
    if (!block || block.locked) return;
    const format = formatAt(s.from.b);
    // Enter on an empty list item ends the list, as in Word.
    if (!blockText(block) && (format?.list === 'bullet' || format?.list === 'number' || (format?.list !== null && lookOf(block)?.marker))) {
      setParaFormat({ list: null }, { from: s.from, to: s.from, collapsed: true });
      return;
    }
    const [left, right] = splitBlock(block, s.from.o, nextId++);
    let rightFormat = format ? { ...format } : undefined;
    const view = paraView(s.from.b, new Map());
    if (view.outline !== undefined || /^(Heading|Title|Subtitle)/.test(format?.style ?? lookOf(block)?.styleId ?? '')) {
      rightFormat = { ...(rightFormat ?? {}), style: 'Normal' };
    }
    wordToken++;
    // Bold picked at the end of a line carries on into the new paragraph, as in Word.
    const carry = pending;
    commitSplice(s.from.b, 1, [left, right], [format, rightFormat], { b: s.from.b + 1, o: 0 });
    if (carry) { pending = carry; pendingAt = { b: s.from.b + 1, o: 0 }; }
  }

  function sameContainer(a: DocBlock, b: DocBlock): boolean {
    const ca = a.cell ? `n${a.cell.table}:${a.cell.row}:${a.cell.col}` : lookOf(a)?.cell ? `t${lookOf(a)?.cell?.table}:${lookOf(a)?.cell?.row}:${lookOf(a)?.cell?.cell}` : 'body';
    const cb = b.cell ? `n${b.cell.table}:${b.cell.row}:${b.cell.col}` : lookOf(b)?.cell ? `t${lookOf(b)?.cell?.table}:${lookOf(b)?.cell?.row}:${lookOf(b)?.cell?.cell}` : 'body';
    return ca === cb;
  }

  function charBefore(text: string, o: number, word: boolean): number {
    if (o <= 0) return 0;
    if (word) {
      let k = o;
      while (k > 0 && /\s/.test(text[k - 1])) k--;
      while (k > 0 && !/\s/.test(text[k - 1])) k--;
      return k;
    }
    const code = text.charCodeAt(o - 1);
    let k = o - 1;
    if (code >= 0xdc00 && code <= 0xdfff && k > 0) k--;
    // Drop combining marks together with nothing else: Arabic tashkeel is deleted one mark at a time.
    return k;
  }

  function charAfter(text: string, o: number, word: boolean): number {
    if (o >= text.length) return text.length;
    if (word) {
      let k = o;
      while (k < text.length && !/\s/.test(text[k])) k++;
      while (k < text.length && /\s/.test(text[k])) k++;
      return k;
    }
    const code = text.charCodeAt(o);
    return code >= 0xd800 && code <= 0xdbff ? o + 2 : o + 1;
  }

  function removeSelectedImage(): boolean {
    if (!selectedImage) return false;
    const { b, run } = selectedImage;
    selectedImage = null;
    const block = blocksNow()[b];
    if (!block) return false;
    const runs = block.runs.filter((_, k) => k !== run);
    commitSplice(b, 1, [{ ...block, runs: runs.length ? runs : [{ t: 'text', text: '', props: {} }] }], [formatAt(b)], { b, o: 0 });
    return true;
  }

  function del(sel: Sel, back: boolean, word: boolean): void {
    if (removeSelectedImage()) return;
    if (!sel.collapsed) { deleteRange(sel); return; }
    // A note reference has no text at all, so the paragraph's offsets cannot say whether the caret
    // sits before the number or after it — only the page can. Backspace against the number deletes
    // the note, and Delete against its other side does the same; both go through `removeNote`, so
    // the note's text leaves the file with its reference.
    const touching = noteAtCaret(back ? 'before' : 'after');
    if (touching) { deleteNote(touching.blockId, touching.runIndex); return; }
    const blocks = blocksNow();
    const block = blocks[sel.from.b];
    if (!block || block.locked) return;
    const text = blockText(block);
    const o = sel.from.o;
    if (back && o === 0) {
      const format = formatAt(sel.from.b);
      if (format?.list === 'bullet' || format?.list === 'number' || (format?.list !== null && lookOf(block)?.marker)) {
        setParaFormat({ list: null }, sel);
        return;
      }
      const prev = blocks[sel.from.b - 1];
      if (!prev || prev.locked || !sameContainer(prev, block)) return;
      const merged = mergeBlocks(prev, block);
      commitSplice(sel.from.b - 1, 2, [merged], [formatAt(sel.from.b - 1)], { b: sel.from.b - 1, o: blockText(prev).length });
      return;
    }
    if (!back && o >= text.length) {
      const next = blocks[sel.from.b + 1];
      if (!next || next.locked || !sameContainer(next, block)) return;
      commitSplice(sel.from.b, 2, [mergeBlocks(block, next)], [formatAt(sel.from.b)], { b: sel.from.b, o });
      return;
    }
    const start = back ? charBefore(text, o, word) : o;
    const end = back ? o : charAfter(text, o, word);
    // Tracked: this path removes characters without going through `insertText`, so the deletion
    // is recorded here, at the offset the paragraph keeps after the removal.
    const removed = text.slice(start, end);
    if (tracking && removed) {
      // The paragraph shrinks: older marks after the cut move back with their text, then the
      // deletion itself is recorded at the offset the paragraph keeps.
      revLog = shiftAfter(revLog, block.id, start, -removed.length);
      revLog = record(revLog, { kind: 'delete', block: block.id, at: start, text: removed });
      renderReview();
    }
    const runs = replaceText(block.runs, start, end, '');
    commitSplice(sel.from.b, 1, [{ ...block, runs }], [formatAt(sel.from.b)], { b: sel.from.b, o: start }, `del:${block.id}`);
  }

  function pasteText(sel: Sel, text: string): void {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length === 1) { insertText(sel, lines[0]); return; }
    insertText(sel, lines[0]);
    for (const line of lines.slice(1)) {
      const now = lastSel;
      if (!now) return;
      enter(now);
      const after = lastSel;
      if (after && line) insertText(after, line);
    }
  }

  /** Reads a paragraph's text back from the page (after an input method composed into it). */
  function reconcile(p: HTMLElement): void {
    const i = Number(p.dataset.i);
    const block = blocksNow()[i];
    if (!block) return;
    let text = '';
    const walk = (n: Node): void => {
      n.childNodes.forEach((c) => {
        if (c.nodeType === Node.TEXT_NODE) { text += (c as Text).data; return; }
        if (!(c instanceof HTMLElement)) return;
        if (c.dataset.skip) return;
        if (c.dataset.len !== undefined) { text += opaqueText.get(c) ?? ''; return; }
        if (c.tagName === 'BR') { text += '\n'; return; }
        walk(c);
      });
    };
    walk(p);
    const before = blockText(block);
    if (text === before) return;
    const sel = readSel();
    const cur = doc();
    if (!cur) return;
    ctx.commit(paragraphEdit(i, before, text));
    updatePara(i);
    if (sel) setCaret(sel.from, sel.to);
  }

  flow.addEventListener('beforeinput', (ev) => {
    if (!ctx.editable()) { ev.preventDefault(); return; }
    const type = ev.inputType;
    if (type === 'insertCompositionText') return;
    const sel = readSel() ?? lastSel;
    if (!sel) { ev.preventDefault(); return; }
    switch (type) {
      case 'insertText':
      case 'insertReplacementText': {
        ev.preventDefault();
        const text = ev.data ?? ev.dataTransfer?.getData('text/plain') ?? '';
        if (text) insertText(sel, text);
        return;
      }
      case 'insertParagraph': ev.preventDefault(); enter(sel); return;
      case 'insertLineBreak': ev.preventDefault(); insertText(sel, '\n'); return;
      case 'deleteContentBackward': case 'deleteSoftLineBackward': case 'deleteHardLineBackward':
        ev.preventDefault(); del(sel, true, false); return;
      case 'deleteWordBackward': ev.preventDefault(); del(sel, true, true); return;
      case 'deleteContentForward': case 'deleteSoftLineForward': case 'deleteHardLineForward':
        ev.preventDefault(); del(sel, false, false); return;
      case 'deleteWordForward': ev.preventDefault(); del(sel, false, true); return;
      case 'deleteByCut': case 'deleteContent': ev.preventDefault(); deleteRange(sel); return;
      case 'insertFromPaste': case 'insertFromDrop': case 'insertFromYank': case 'insertFromPasteAsQuotation': {
        ev.preventDefault();
        const text = ev.dataTransfer?.getData('text/plain') ?? ev.data ?? '';
        if (text) pasteText(sel, text);
        return;
      }
      case 'historyUndo': ev.preventDefault(); ctx.undo(); return;
      case 'historyRedo': ev.preventDefault(); ctx.redo(); return;
      case 'formatBold': ev.preventDefault(); toggle('b'); return;
      case 'formatItalic': ev.preventDefault(); toggle('i'); return;
      case 'formatUnderline': ev.preventDefault(); toggle('u'); return;
      default: ev.preventDefault();
    }
  });
  flow.addEventListener('paste', (ev) => {
    // Some browsers do not send insertFromPaste with the text: take it from the clipboard event.
    const text = ev.clipboardData?.getData('text/plain');
    if (text === undefined) return;
    ev.preventDefault();
    const sel = readSel() ?? lastSel;
    if (sel && ctx.editable()) pasteText(sel, text);
  });
  flow.addEventListener('compositionstart', () => { composing = true; });
  flow.addEventListener('compositionend', () => {
    composing = false;
    const sel = window.getSelection();
    const p = paraOf(sel?.anchorNode ?? null);
    if (p) reconcile(p);
  });
  flow.addEventListener('input', () => {
    if (composing) return;
    const sel = window.getSelection();
    const p = paraOf(sel?.anchorNode ?? null);
    if (p) reconcile(p);
  });
  flow.addEventListener('keydown', (ev) => {
    if (ev.key === 'Tab' && !ev.ctrlKey && !ev.altKey) {
      const sel = readSel();
      if (!sel) return;
      ev.preventDefault();
      const cell = paraEls[sel.from.b]?.closest('td');
      if (cell) {
        const cells = [...(cell.closest('table')?.querySelectorAll('td') ?? [])];
        const next = cells[cells.indexOf(cell as HTMLTableCellElement) + (ev.shiftKey ? -1 : 1)];
        const p = next?.querySelector<HTMLElement>('.fo-p');
        if (p) setCaret({ b: Number(p.dataset.i), o: 0 });
        return;
      }
      insertText(sel, '\t');
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selectedImage) {
      ev.preventDefault();
      removeSelectedImage();
    }
  });
  flow.addEventListener('pointerdown', (ev) => {
    if (!(ev.target as HTMLElement).closest('.fo-op-image')) {
      selectedImage = null;
      flow.querySelectorAll('.fo-op.is-selected').forEach((n) => n.classList.remove('is-selected'));
    }
  });

  /* ─────────────────────────── formatting ─────────────────────────── */

  function baseLookAt(b: number): TextLook {
    return paraView(b, new Map()).text;
  }

  /** The formatting the toolbar shows: the selection's runs over the paragraph's style. */
  function currentProps(): RunProps & { rtl?: boolean } {
    const m = doc();
    if (!m?.blocks) return {};
    // No caret yet: the toolbar shows the first paragraph's font, never an empty box.
    const sel = targetRange() ?? { from: { b: 0, o: 0 }, to: { b: 0, o: 0 }, collapsed: true };
    const base = baseLookAt(sel.from.b);
    const rtl = paraView(sel.from.b, new Map()).dir === 'rtl';
    const blocks = m.blocks;
    const pick = (b: number, from: number, to: number): RunProps => propsInRange(blocks[b]?.runs ?? [], from, to);
    let props = pick(sel.from.b, sel.from.o, sel.from.b === sel.to.b ? sel.to.o : (m.paragraphs[sel.from.b] ?? '').length);
    if (pending && sel.collapsed) props = { ...props, ...pending };
    return {
      b: props.b ?? base.b ?? false,
      i: props.i ?? base.i ?? false,
      u: props.u ?? base.u ?? false,
      strike: props.strike ?? base.strike ?? false,
      color: props.color ?? base.color,
      hl: props.hl,
      sz: props.sz ?? (rtl ? base.szCs ?? base.sz : base.sz) ?? 11,
      font: props.font ?? (rtl ? base.fontCs ?? base.font : base.font) ?? 'Calibri',
      va: props.va,
      rtl,
    };
  }

  function applyRun(patch: PropsPatch): void {
    const sel = targetRange();
    const m = doc();
    if (!sel || !m?.blocks || !ctx.editable()) return;
    if (sel.collapsed && draftPara === null) {
      pending = { ...(pending ?? {}) };
      pendingAt = { ...sel.from };
      for (const [k, v] of Object.entries(patch)) (pending as Record<string, unknown>)[k] = v ?? undefined;
      ctx.refresh();
      return;
    }
    const blocks: DocBlock[] = [];
    const formats: Array<ParagraphFormat | undefined> = [];
    for (let b = sel.from.b; b <= sel.to.b; b++) {
      const block = m.blocks[b];
      const len = blockText(block).length;
      const from = b === sel.from.b ? sel.from.o : 0;
      const to = b === sel.to.b ? sel.to.o : len;
      blocks.push(len ? { ...block, runs: formatRange(block.runs, from, to, patch) } : block);
      formats.push(m.formats?.[b]);
    }
    const keepDraft = draftPara;
    commitSplice(sel.from.b, blocks.length, blocks, formats, null);
    if (keepDraft === null) setCaret(sel.from, sel.to);
    else draftPara = keepDraft;
    ctx.refresh();
  }

  function toggle(key: 'b' | 'i' | 'u' | 'strike'): void {
    const sel = targetRange();
    if (!sel) return;
    const now = currentProps()[key] === true;
    const base = baseLookAt(sel.from.b)[key] === true;
    const want = !now;
    applyRun({ [key]: want === base ? null : want });
  }

  function setParaFormat(change: ParagraphFormat, range?: Sel): void {
    const sel = range ?? targetRange();
    const m = doc();
    if (!sel || !m || !ctx.editable()) return;
    const changes: Array<{ index: number; before?: ParagraphFormat; after?: ParagraphFormat }> = [];
    for (let b = sel.from.b; b <= sel.to.b; b++) {
      const before = m.formats?.[b];
      const after: ParagraphFormat = { ...(before ?? {}), ...change };
      changes.push({ index: b, before, after });
    }
    const keepDraft = draftPara;
    ctx.commit(formatsEdit(changes));
    renderFlow();
    if (mode === 'draft') renderDraft();
    if (keepDraft === null) setCaret(sel.from, sel.to);
    else draftPara = keepDraft;
    ctx.refresh();
  }

  function currentFormat(): { align: ParagraphAlign; dir: 'rtl' | 'ltr'; logicalRtl: boolean; list?: 'bullet' | 'number' | null; style: string; line?: number } {
    const sel = targetRange();
    const b = sel?.from.b ?? 0;
    const view = paraView(b, new Map());
    const f = doc()?.formats?.[b];
    const logical = view.align ?? 'left';
    // The buttons are visual: in a right-to-left paragraph "start" is the right edge.
    const logicalRtl = view.dir === 'rtl' && !view.autoDir;
    const visual: ParagraphAlign = logicalRtl && (logical === 'left' || logical === 'right') ? (logical === 'left' ? 'right' : 'left') : view.align === undefined && view.autoDir ? 'right' : logical;
    const block = doc()?.blocks?.[b];
    return {
      align: visual,
      dir: view.dir,
      logicalRtl,
      list: f?.list !== undefined ? f.list : lookOf(block)?.marker ? (/\d|[a-z]/i.test(lookOf(block)?.marker ?? '') ? 'number' : 'bullet') : undefined,
      style: f?.style ?? lookOf(block)?.styleId ?? 'Normal',
      line: f?.line ?? view.line,
    };
  }

  function align(visual: ParagraphAlign): void {
    const now = currentFormat();
    const logical = logicalAlign(visual, now.logicalRtl);
    setParaFormat({ align: logical });
  }

  function applyStyle(id: string): void {
    setParaFormat({ style: id });
  }

  /* ─────────────────────────── insert ─────────────────────────── */

  function insertBlocksAfter(blocks: DocBlock[], formats: Array<ParagraphFormat | undefined>): void {
    const m = doc();
    if (!m?.blocks || !ctx.editable()) return;
    let at = (targetRange()?.to.b ?? m.blocks.length - 1) + 1;
    // The caret in a cell of a table inserted in this session: what is inserted goes AFTER the
    // table. Landing between two of its cells would cut the table in two.
    const table = m.blocks[at - 1]?.cell?.table;
    if (table !== undefined) while (at < m.blocks.length && m.blocks[at].cell?.table === table) at++;
    commitSplice(at, 0, blocks, formats, { b: at + blocks.length - 1, o: 0 });
  }

  function insertTable(rows: number, cols: number): void {
    const table = nextId;
    const rtl = currentFormat().dir === 'rtl';
    const cells: DocBlock[] = [];
    const formats: Array<ParagraphFormat | undefined> = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({ id: nextId++, runs: [{ t: 'text', text: '', props: {} }], cell: { table, row: r, col: c, rows, cols, rtl } });
        formats.push(rtl ? { dir: 'rtl' } : undefined);
      }
    }
    const after = emptyBlock(nextId++);
    insertBlocksAfter([...cells, after], [...formats, rtl ? { dir: 'rtl' } : undefined]);
    const firstIndex = (doc()?.blocks ?? []).findIndex((b) => b.id === cells[0].id);
    if (firstIndex >= 0) setCaret({ b: firstIndex, o: 0 });
  }

  function askTable(): void {
    const body = el('div', 'fo-form');
    const rowsIn = numberField(t('office.tableRows'), 3, 1, 50);
    const colsIn = numberField(t('office.tableCols'), 3, 1, 12);
    body.append(rowsIn.row, colsIn.row);
    openModal({
      title: t('office.insertTable'), body, okLabel: t('office.insert'), cancelLabel: t('office.cancel'), host: ctx.host(),
      onOk: () => { insertTable(rowsIn.value(), colsIn.value()); },
    });
  }

  function numberField(label: string, value: number, min: number, max: number): { row: HTMLElement; value(): number } {
    const row = el('label', 'fo-field');
    row.append(el('span', 'fo-field-label', label));
    const input = el('input', 'fo-input');
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    row.append(input);
    return { row, value: () => clamp(Math.round(Number(input.value) || value), min, max) };
  }

  function insertImage(): void {
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const data = new Uint8Array(await file.arrayBuffer());
      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/gif' ? 'gif' : 'jpeg';
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        placePicture(data, ext, img.naturalWidth * 0.75, img.naturalHeight * 0.75, file.name);
      };
      img.onerror = () => { URL.revokeObjectURL(url); ctx.setStatus(t('office.imageFailed')); };
      img.src = url;
    });
    input.click();
  }

  /** A picture (a file, or a drawn shape) in its own centred paragraph after the caret, never wider than the text. */
  function placePicture(data: Uint8Array, ext: 'png' | 'jpeg' | 'gif', wPt: number, hPt: number, name: string): void {
    const g = pageGeometry();
    const maxPt = (g.w - g.left - g.right) / PX / Math.max(1, g.cols);
    let w = wPt;
    let h = hPt;
    if (w > maxPt) { h = (h * maxPt) / w; w = maxPt; }
    const run: Run = { t: 'opaque', text: '', xml: '', kind: 'image', newImage: { data, ext, w: Math.round(w), h: Math.round(h), name } };
    const format = currentFormat();
    insertBlocksAfter([{ id: nextId++, runs: [run, { t: 'text', text: '', props: {} }] }], [{ align: 'center', ...(format.dir === 'rtl' ? { dir: 'rtl' } : {}) }]);
  }

  function insertPageBreak(): void {
    insertBlocksAfter([{ id: nextId++, runs: [{ t: 'opaque', text: '\n', xml: '', kind: 'page' }] }, emptyBlock(nextId++)], [undefined, undefined]);
  }

  /* ─────────────────────────── footnotes & endnotes ─────────────────────────── */

  /**
   * One undoable edit over every paragraph a note command changed. Inserting or deleting a note
   * renumbers the references that follow it — which may live in OTHER paragraphs — so each changed
   * paragraph is committed, and all of them travel as a single undo step (the way a batch of
   * revision verdicts does). Comparing by identity is exact: `insertNote`/`removeNote`/`setNoteText`
   * return the very same objects for the paragraphs they did not touch.
   */
  function noteEdit(next: readonly DocBlock[], key: string): Edit | null {
    const m = doc();
    if (!m?.blocks) return null;
    const edits = next.flatMap((block, i) => (block === m.blocks?.[i]
      ? []
      : [blockSplice(i, sliceOf(m, i, 1), { blocks: [block], formats: [m.formats?.[i]] }, key)]));
    if (!edits.length) return null;
    if (edits.length === 1) return edits[0];
    return {
      key,
      apply: (model) => edits.reduce((acc, edit) => edit.apply(acc), model),
      revert: (model) => [...edits].reverse().reduce((acc, edit) => edit.revert(acc), model),
    };
  }

  /**
   * Commits what a note command produced and redraws the page: a reference appeared, vanished or
   * moved, so the numbers of other references may have changed with it — only a full redraw can be
   * trusted to show that. `focus` opens the notes panel on the note that was just inserted.
   */
  function applyNoteEdit(next: readonly DocBlock[], key: string, caret: Pos | null, focus?: { blockId: number; runIndex: number }): void {
    const edit = noteEdit(next, key);
    if (!edit) return;
    if (focus) { sideOpen = true; sideTab = 'notes'; }
    ctx.commit(edit);
    renderFlow();
    if (mode === 'draft') renderDraft();
    renderSide();
    if (caret) setCaret(caret);
    ctx.refresh();
    if (focus) focusNote(focus.blockId, focus.runIndex);
  }

  /**
   * Where a note about to be inserted goes: the caret, or the end of the last paragraph when the
   * caret was never placed (the same fallback the table and picture commands use).
   */
  function noteAnchor(): Pos | null {
    const blocks = doc()?.blocks ?? [];
    const sel = targetRange();
    if (sel) return blocks[sel.from.b] ? sel.from : null;
    const last = blocks.length - 1;
    if (last < 0) return null;
    return { b: last, o: blockText(blocks[last]).length };
  }

  /**
   * The note references the file holds but this app could not read. A comment is not one of them:
   * a comment mark has no note by design. Anything else here means the package is broken in a way
   * that would make the save rebuild the notes part from the model alone — so nothing about notes
   * is changed while one exists, and the owner is told why instead of losing the file's notes.
   */
  function unreadableNotes(): number {
    let count = 0;
    for (const block of doc()?.blocks ?? []) {
      for (const run of block.runs) {
        if (run.t === 'opaque' && run.kind === 'note' && !run.note && run.ref !== 'comment') count += 1;
      }
    }
    return count;
  }

  /** True when a note command must refuse: the file holds a note this app could not read. */
  function notesLocked(): boolean {
    if (!unreadableNotes()) return false;
    ctx.setStatus(t('office.noteUnreadable'));
    return true;
  }

  /**
   * Inserts a footnote or an endnote at the caret. The reference is a zero-width run, so the
   * paragraph is split at the caret first and the note goes exactly between the two halves; the
   * note's own text starts empty and is typed in the panel that opens.
   */
  function insertNoteAt(kind: NoteKind): void {
    const m = doc();
    if (!m?.blocks || !ctx.editable() || notesLocked()) return;
    const pos = noteAnchor();
    const block = pos ? m.blocks[pos.b] : undefined;
    if (!pos || !block) return;
    if (block.locked) { ctx.setStatus(t('office.noteLocked')); return; }
    const offset = clamp(pos.o, 0, blockText(block).length);
    const runs = splitRunsAt(block.runs, offset);
    const at = runIndexAt(runs, offset);
    const split = m.blocks.map((b, i) => (i === pos.b ? { ...b, runs } : b));
    const { blocks: next } = insertNote(split, block.id, at, kind);
    applyNoteEdit(next, `note:add:${kind}`, { b: pos.b, o: offset }, { blockId: block.id, runIndex: at });
    ctx.setStatus(t('office.noteAdded'));
  }

  /** Deletes a note — through `removeNote`, so its text goes with the reference and nothing is left behind. */
  function deleteNote(blockId: number, runIndex: number): void {
    const m = doc();
    const index = (m?.blocks ?? []).findIndex((b) => b.id === blockId);
    const block = index >= 0 ? m?.blocks?.[index] : undefined;
    if (!m?.blocks || !block || !ctx.editable() || notesLocked()) return;
    const run = block.runs[runIndex];
    if (run?.t !== 'opaque' || run.kind !== 'note' || !run.note) return;
    const at = runTextOffset(block.runs, runIndex);
    applyNoteEdit(removeNote(m.blocks, blockId, runIndex), 'note:del', { b: index, o: at });
    ctx.setStatus(t('office.noteDeleted'));
  }

  /** Writes the text typed into a note's own field into the model (the page itself does not move). */
  function editNote(blockId: number, runIndex: number, text: string): void {
    const m = doc();
    if (!m?.blocks || !ctx.editable() || notesLocked()) return;
    const edit = noteEdit(setNoteText(m.blocks, blockId, runIndex, text), `note:text:${blockId}:${runIndex}`);
    if (!edit) return;
    // No redraw: a note's text is not drawn on the page, and redrawing the panel would take the
    // focus out of the field the owner is typing in. The key merges a burst of typing into one step.
    ctx.commit(edit);
    ctx.refresh();
  }

  /** Puts the caret in a note's field in the panel, and brings that field into view. */
  function focusNote(blockId: number, runIndex: number): void {
    const field = noteField(blockId, runIndex);
    if (!field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
    field.scrollIntoView({ block: 'nearest' });
  }

  function noteField(blockId: number, runIndex: number): HTMLTextAreaElement | null {
    return side.querySelector<HTMLTextAreaElement>(`.fo-note-field[data-note="${blockId}:${runIndex}"]`);
  }

  /** Opens the notes panel, optionally on one note (the reference that was tapped in the page). */
  function openNotes(blockId?: number, runIndex?: number): void {
    sideOpen = true;
    sideTab = 'notes';
    renderSide();
    ctx.refresh();
    if (blockId !== undefined && runIndex !== undefined) focusNote(blockId, runIndex);
  }

  function headings(): Array<{ b: number; level: number; text: string }> {
    const m = doc();
    const out: Array<{ b: number; level: number; text: string }> = [];
    (m?.blocks ?? []).forEach((block, b) => {
      const view = paraView(b, new Map());
      const text = blockText(block).trim();
      if (view.outline !== undefined && view.outline < 3 && text) out.push({ b, level: view.outline, text });
    });
    return out;
  }

  function insertToc(): void {
    const list = headings();
    if (!list.length) { ctx.setStatus(t('office.tocEmpty')); return; }
    const rtl = currentFormat().dir === 'rtl';
    const blocks: DocBlock[] = [];
    const formats: Array<ParagraphFormat | undefined> = [];
    blocks.push({ id: nextId++, runs: [{ t: 'text', text: t('office.tocTitle'), props: { b: true, sz: 14 } }] });
    formats.push(rtl ? { dir: 'rtl' } : undefined);
    for (const h of list) {
      blocks.push({ id: nextId++, runs: [{ t: 'text', text: h.text, props: {} }] });
      formats.push({ style: `TOC${h.level + 1}`, ...(rtl ? { dir: 'rtl' } : {}) });
    }
    insertBlocksAfter(blocks, formats);
  }

  function insertDate(): void {
    const sel = targetRange();
    if (!sel) return;
    const text = new Intl.DateTimeFormat(document.documentElement.lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { dateStyle: 'long' }).format(new Date());
    insertText(sel, text);
  }

  /* ─────────────────────────── clipboard ─────────────────────────── */

  function selectedText(): string {
    const sel = targetRange();
    if (!sel || sel.collapsed) return '';
    return textOfRange(blocksNow(), sel.from, sel.to);
  }

  /** Copy (and for Cut, delete) the selection: the system clipboard gets its plain text. */
  async function copySelection(cut: boolean): Promise<void> {
    const sel = targetRange();
    const text = selectedText();
    if (!sel || !text) return;
    try { await navigator.clipboard.writeText(text); } catch {
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
    }
    if (cut && can() && !reading) deleteRange(sel);
  }

  async function pasteFromClipboard(): Promise<void> {
    const sel = targetRange();
    if (!sel || !can() || reading) return;
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { ctx.setStatus(t('office.wPasteFailed')); return; }
    if (text) pasteText(sel, text);
  }

  /* ─────────────────────────── more formatting ─────────────────────────── */

  function toggleScript(va: 'superscript' | 'subscript'): void {
    applyRun({ va: currentProps().va === va ? null : va });
  }

  /** Clear formatting: every direct character property goes back to the paragraph style's. */
  function clearFormatting(): void {
    applyRun({ b: null, i: null, u: null, strike: null, color: null, hl: null, sz: null, font: null, va: null });
  }

  /** The start indent a paragraph has now, in points (its own, else its style's). */
  function indentOf(b: number): number {
    const own = formatAt(b)?.indent;
    if (own !== undefined) return own ?? 0;
    return lookOf(blocksNow()[b])?.para.indStart ?? 0;
  }

  /** Indent or outdent by half an inch (36pt), as Word's buttons do. */
  function changeIndent(step: 1 | -1): void {
    const sel = targetRange();
    if (!sel) return;
    const now = indentOf(sel.from.b);
    const next = Math.max(0, Math.min(288, (step > 0 ? Math.floor(now / 36 + 1e-6) + 1 : Math.ceil(now / 36 - 1e-6) - 1) * 36));
    setParaFormat({ indent: next || null });
  }

  /* ─────────────────────────── links, symbols, shapes, breaks ─────────────────────────── */

  /** Puts one run at the caret (a selection is replaced first), in one undoable edit. */
  function insertRunAtCaret(run: Run): void {
    let sel = targetRange();
    if (!sel || !can() || reading) return;
    if (!sel.collapsed) { deleteRange(sel); sel = lastSel ?? sel; }
    const pos = sel.from;
    const block = blocksNow()[pos.b];
    if (!block || block.locked) return;
    const offset = clamp(pos.o, 0, blockText(block).length);
    const runs = splitRunsAt(block.runs, offset);
    runs.splice(runIndexAt(runs, offset), 0, run);
    commitSplice(pos.b, 1, [{ ...block, runs }], [formatAt(pos.b)], { b: pos.b, o: offset + run.text.length });
  }

  function textField(label: string, value: string, type = 'text'): { row: HTMLElement; input: HTMLInputElement; value(): string } {
    const row = el('label', 'fo-field');
    row.append(el('span', 'fo-field-label', label));
    const input = el('input', 'fo-input');
    input.type = type;
    input.value = value;
    input.dir = 'auto';
    row.append(input);
    return { row, input, value: () => input.value };
  }

  function selectField(label: string, options: ReadonlyArray<{ value: string; label: string }>, value: string): { row: HTMLElement; value(): string } {
    const row = el('label', 'fo-field');
    row.append(el('span', 'fo-field-label', label));
    const select = el('select', 'fo-select');
    for (const o of options) { const op = el('option', undefined, o.label); op.value = o.value; select.append(op); }
    if (!options.some((o) => o.value === value)) { const op = el('option', undefined, value); op.value = value; select.append(op); }
    select.value = value;
    row.append(select);
    return { row, value: () => select.value };
  }

  function checkField(label: string, checked: boolean): { row: HTMLElement; value(): boolean } {
    const row = el('label', 'fo-check');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = checked;
    row.append(box, el('span', undefined, label));
    return { row, value: () => box.checked };
  }

  function decimalField(label: string, value: number, min: number, max: number, step = 0.1): { row: HTMLElement; value(): number } {
    const f = textField(label, String(Math.round(value * 100) / 100), 'number');
    f.input.min = String(min);
    f.input.max = String(max);
    f.input.step = String(step);
    f.input.dir = 'ltr';
    return { row: f.row, value: () => { const n = Number(f.input.value); return Number.isFinite(n) ? clamp(n, min, max) : value; } };
  }

  /** A link as a HYPERLINK field: it needs no relationship, so it survives both saves and Word shows it as a link. */
  function linkRun(href: string, text: string): OpaqueRun {
    const xml = `<w:fldSimple w:instr=" HYPERLINK &quot;${xmlText(href)}&quot; "><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>${textElement('w:t', null, text)}</w:r></w:fldSimple>`;
    return { t: 'opaque', kind: 'link', text, xml };
  }

  function openLinkDialog(): void {
    if (!can() || reading) return;
    const keep = targetRange();
    const body = el('div', 'fo-form');
    const url = textField(t('office.wLinkUrl'), 'https://', 'url');
    url.input.dir = 'ltr';
    const text = textField(t('office.wLinkText'), selectedText().replace(/\n/g, ' '));
    const error = el('p', 'fo-form-error');
    error.setAttribute('role', 'alert');
    body.append(url.row, text.row, error);
    openModal({
      title: t('office.wLinkTitle'), body, okLabel: t('office.insert'), cancelLabel: t('office.cancel'), host: ctx.host(),
      onOk: () => {
        const href = url.value().trim();
        if (!/^(https?:\/\/|mailto:)[^\s"<>]+$/i.test(href)) { error.textContent = t('office.wLinkBad'); return false; }
        if (keep) lastSel = keep;
        insertRunAtCaret(linkRun(href, (text.value().trim() || href).replace(/\n/g, ' ')));
        return true;
      },
    });
  }

  /** The ribbon node of a control (the visible one), to open a chooser next to it. */
  function anchorFor(id: string): HTMLElement {
    return [...ctx.host().querySelectorAll<HTMLElement>(`[data-control="${id}"]`)].find((n) => n.offsetParent !== null) ?? ctx.host();
  }

  function openSymbols(anchor: HTMLElement): void {
    const keep = targetRange();
    const grid = el('div', 'fo-symbols');
    for (const symbol of SYMBOLS) {
      const b = el('button', 'fo-symbol', symbol);
      b.type = 'button';
      b.setAttribute('aria-label', symbol);
      b.addEventListener('click', () => {
        pop.close();
        if (keep) { lastSel = keep; insertText(keep, symbol); }
      });
      grid.append(b);
    }
    const pop = openPopover(anchor, grid, { label: t('office.wSymbolTitle') });
  }

  /** A shape is drawn once into a picture (PNG) and placed like any picture. */
  function shapePng(kind: ShapeKind): Promise<Uint8Array | null> {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 200;
    const g = c.getContext('2d');
    if (!g) return Promise.resolve(null);
    g.fillStyle = '#5B8DEF';
    g.strokeStyle = '#2F5DB8';
    g.lineWidth = 6;
    g.lineJoin = 'round';
    g.beginPath();
    if (kind === 'rect') g.rect(8, 8, 304, 184);
    else if (kind === 'rounded') g.roundRect(8, 8, 304, 184, 28);
    else if (kind === 'ellipse') g.ellipse(160, 100, 150, 90, 0, 0, Math.PI * 2);
    else if (kind === 'arrow') { g.moveTo(8, 70); g.lineTo(200, 70); g.lineTo(200, 12); g.lineTo(312, 100); g.lineTo(200, 188); g.lineTo(200, 130); g.lineTo(8, 130); g.closePath(); }
    else if (kind === 'line') { g.moveTo(12, 188); g.lineTo(308, 12); }
    else {
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? 40 : 96;
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        if (k) g.lineTo(160 + r * Math.cos(a), 104 + r * Math.sin(a)); else g.moveTo(160 + r * Math.cos(a), 104 + r * Math.sin(a));
      }
      g.closePath();
    }
    if (kind !== 'line') g.fill();
    g.stroke();
    return new Promise((resolve) => {
      c.toBlob((blob) => { if (!blob) { resolve(null); return; } void blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))); }, 'image/png');
    });
  }

  async function insertShape(kind: ShapeKind): Promise<void> {
    if (!can() || reading) return;
    const data = await shapePng(kind);
    if (!data) { ctx.setStatus(t('office.imageFailed')); return; }
    placePicture(data, 'png', 180, 112, `${kind}.png`);
  }

  function insertColumnBreak(): void {
    insertBlocksAfter([{ id: nextId++, runs: [{ t: 'opaque', text: '\n', xml: '<w:r><w:br w:type="column"/></w:r>', kind: 'break' }] }, emptyBlock(nextId++)], [undefined, undefined]);
  }

  /**
   * A cross-reference to a heading: the heading gets a bookmark (once), and a REF field to it goes
   * at the caret, showing the heading's text — Word updates it when the heading changes.
   */
  function insertCrossRef(target: number): void {
    const m = doc();
    const sel = targetRange();
    if (!m?.blocks || !sel || !can() || reading) return;
    const next = m.blocks.slice();
    const heading = next[target];
    if (!heading) return;
    const text = blockText(heading).trim();
    let name = '';
    for (const run of heading.runs) {
      const found = run.t === 'opaque' ? /<w:bookmarkStart\b[^>]*w:name="(_Ref\d+)"/.exec(run.xml) : null;
      if (found) { name = found[1]; break; }
    }
    if (!name) {
      let id = 100;
      for (const block of next) for (const run of block.runs) {
        const found = run.t === 'opaque' ? /<w:bookmarkStart\b[^>]*w:id="(\d+)"/.exec(run.xml) : null;
        if (found) id = Math.max(id, Number(found[1]) + 1);
      }
      name = `_Ref${String(Date.now() % 1e9).padStart(9, '0')}`;
      next[target] = {
        ...heading,
        runs: [
          { t: 'opaque', kind: 'mark', text: '', xml: `<w:bookmarkStart w:id="${id}" w:name="${name}"/>` },
          ...heading.runs,
          { t: 'opaque', kind: 'mark', text: '', xml: `<w:bookmarkEnd w:id="${id}"/>` },
        ],
      };
    }
    const pos = sel.from;
    const block = next[pos.b];
    if (!block || block.locked) return;
    const offset = clamp(pos.o, 0, blockText(block).length);
    const runs = splitRunsAt(block.runs, offset);
    const field: OpaqueRun = { t: 'opaque', kind: 'field', text, xml: `<w:fldSimple w:instr=" REF ${name} \\h "><w:r>${textElement('w:t', null, text)}</w:r></w:fldSimple>` };
    runs.splice(runIndexAt(runs, offset), 0, field);
    next[pos.b] = { ...block, runs };
    const edit = noteEdit(next, 'xref');
    if (!edit) return;
    ctx.commit(edit);
    renderFlow();
    setCaret({ b: pos.b, o: offset + text.length });
    ctx.refresh();
  }

  /* ─────────────────────────── page layout ─────────────────────────── */

  /** One undoable edit that sets a document-level value (the page setup, the header and footer). */
  function setDocValue<K extends 'page' | 'headerFooter'>(key: K, value: DocModel[K]): void {
    const m = doc();
    if (!m || !can()) return;
    const before = m[key];
    const put = (x: OfficeModel, v: DocModel[K] | undefined): OfficeModel => {
      if (x.kind !== 'docx') return x;
      const y: DocModel = { ...x };
      if (v === undefined) delete y[key]; else y[key] = v;
      return y;
    };
    ctx.commit({ apply: (x) => put(x, value), revert: (x) => put(x, before) });
    applyZoom();
    layoutPages();
    ctx.refresh();
  }

  function setPage(next: PageSetup): void {
    if (next === pageSetup()) return;
    setDocValue('page', next);
  }

  function openCustomMargins(): void {
    const page = pageSetup();
    const cm = (pt: number): number => pt / (72 / 2.54);
    const body = el('div', 'fo-form');
    const top = decimalField(t('office.wMarginTop'), cm(page.top), 0, 10);
    const bottom = decimalField(t('office.wMarginBottom'), cm(page.bottom), 0, 10);
    const left = decimalField(t('office.wMarginLeft'), cm(page.left), 0, 10);
    const right = decimalField(t('office.wMarginRight'), cm(page.right), 0, 10);
    const error = el('p', 'fo-form-error');
    error.setAttribute('role', 'alert');
    body.append(top.row, bottom.row, left.row, right.row, error);
    openModal({
      title: t('office.wMargins'), body, okLabel: t('office.apply'), cancelLabel: t('office.cancel'), host: ctx.host(),
      onOk: () => {
        const pt = (v: number): number => Math.round(v * (72 / 2.54) * 10) / 10;
        const next = withMargins(page, { top: pt(top.value()), bottom: pt(bottom.value()), left: pt(left.value()), right: pt(right.value()) });
        if (next === page) { error.textContent = t('office.wMarginsBad'); return false; }
        setPage(next);
        return true;
      },
    });
  }

  function setHeaderFooter(next: HeaderFooterSetup): void {
    setDocValue('headerFooter', next);
  }

  /** The header and footer dialog: their text ({PAGE} and {PAGES} stand for the numbers) and alignment. */
  function openHeaderFooter(focus: 'header' | 'footer'): void {
    if (!can() || reading) return;
    const now = hfNow();
    const shown = (hf: HfSetup | null): string => (hf?.text ?? '').split(PAGE_FIELD).join('{PAGE}').split(PAGES_FIELD).join('{PAGES}');
    const stored = (value: string): string => value.replace(/\{PAGES\}/gi, PAGES_FIELD).replace(/\{PAGE\}/gi, PAGE_FIELD);
    const rtl = docRtl();
    const visualOf = (hf: HfSetup | null): string => {
      const a = hf?.align ?? 'center';
      return a === 'center' || a === 'justify' ? 'center' : logicalAlign(a, rtl);
    };
    const aligns = [
      { value: 'right', label: t('office.formatAlignRight') },
      { value: 'center', label: t('office.formatAlignCenter') },
      { value: 'left', label: t('office.formatAlignLeft') },
    ];
    const body = el('div', 'fo-form');
    const header = textField(t('office.wHeaderText'), shown(now.header));
    const headerAlign = selectField(t('office.wHfAlign'), aligns, visualOf(now.header));
    const footer = textField(t('office.wFooterText'), shown(now.footer));
    const footerAlign = selectField(t('office.wHfAlign'), aligns, visualOf(now.footer));
    const pageNo = checkField(t('office.wHfPageNo'), (now.footer?.text ?? '').includes(PAGE_FIELD));
    body.append(header.row, headerAlign.row, footer.row, footerAlign.row, pageNo.row, el('p', 'fo-form-hint', t('office.wHfFieldsHint')));
    openModal({
      title: t('office.wHeaderFooterTitle'), body, okLabel: t('office.apply'), cancelLabel: t('office.cancel'), host: ctx.host(),
      onOk: () => {
        const make = (value: string, visual: string): HfSetup | null => {
          const text = stored(value).trim();
          return text ? { text, align: logicalAlign(visual as ParagraphAlign, rtl) } : null;
        };
        let foot = make(footer.value(), footerAlign.value());
        if (pageNo.value() && !foot?.text.includes(PAGE_FIELD)) foot = { text: foot ? `${foot.text} ${PAGE_FIELD}` : PAGE_FIELD, align: foot?.align ?? 'center' };
        if (!pageNo.value() && foot) foot = foot.text.replace(/[\u0001\u0002]/g, '').trim() ? { ...foot, text: foot.text.replace(/\s*[\u0001\u0002]/g, '').trim() } : null;
        setHeaderFooter({ header: make(header.value(), headerAlign.value()), footer: foot });
        return true;
      },
    });
    (focus === 'footer' ? footer.input : header.input).focus();
  }

  /** Page numbers from the ribbon: a centred number at the top or the bottom, "Page X of Y", or none. */
  function pageNumbers(preset: 'bottom' | 'top' | 'ofTotal' | 'remove'): void {
    const now = hfNow();
    const strip = (hf: HfSetup | null): HfSetup | null => {
      if (!hf) return null;
      // "Page X of Y" (as this app writes it, in either language) goes whole; a lone field goes too.
      const ofTotal = [['Page', 'of'], ['صفحة', 'من'], [t('office.wPageWord'), t('office.wOfWord')]].map(([p, o]) => `${p} ${PAGE_FIELD} ${o} ${PAGES_FIELD}`);
      const text = hf.text.split('\n')
        .map((line) => ofTotal.reduce((acc, pattern) => acc.split(pattern).join(''), line).replace(/[\u0001\u0002]/g, '').trim())
        .filter(Boolean).join('\n');
      return text ? { ...hf, text } : null;
    };
    const withNumber = (hf: HfSetup | null, field: string): HfSetup => {
      const kept = strip(hf);
      return { text: kept ? `${kept.text}\n${field}` : field, align: 'center' };
    };
    if (preset === 'remove') setHeaderFooter({ header: strip(now.header), footer: strip(now.footer) });
    else if (preset === 'top') setHeaderFooter({ header: withNumber(now.header, PAGE_FIELD), footer: strip(now.footer) });
    else if (preset === 'bottom') setHeaderFooter({ header: strip(now.header), footer: withNumber(now.footer, PAGE_FIELD) });
    else setHeaderFooter({ header: strip(now.header), footer: withNumber(now.footer, `${t('office.wPageWord')} ${PAGE_FIELD} ${t('office.wOfWord')} ${PAGES_FIELD}`) });
  }

  /* ─────────────────────────── table rows and columns ─────────────────────────── */

  /** The paragraphs of the new (this-session) table the caret is in. */
  function tableRange(b: number): { start: number; end: number } | null {
    const blocks = blocksNow();
    const table = blocks[b]?.cell?.table;
    if (table === undefined) return null;
    let start = b;
    while (start > 0 && blocks[start - 1].cell?.table === table) start--;
    let end = b + 1;
    while (end < blocks.length && blocks[end].cell?.table === table) end++;
    return { start, end };
  }

  function runTableOp(op: TableOp): void {
    const sel = targetRange();
    const m = doc();
    if (!sel || !m?.blocks || !can() || reading) return;
    const range = tableRange(sel.from.b);
    const cell = m.blocks[sel.from.b]?.cell;
    if (!range || !cell) return;
    const items = m.blocks.slice(range.start, range.end).map((block, i) => ({ block, format: m.formats?.[range.start + i] }));
    const out = tableOp(items, op, cell.row, cell.col, () => nextId++);
    if (!out) { deleteTable(); return; }
    const size = out[0].block.cell as NonNullable<DocBlock['cell']>;
    const row = op === 'rowBelow' ? cell.row + 1 : Math.min(cell.row, size.rows - 1);
    const col = op === 'colAfter' ? cell.col + 1 : Math.min(cell.col, size.cols - 1);
    commitSplice(range.start, range.end - range.start, out.map((x) => x.block), out.map((x) => x.format), null);
    const at = out.findIndex((x) => x.block.cell?.row === row && x.block.cell?.col === col);
    setCaret({ b: range.start + Math.max(0, at), o: 0 });
    ctx.refresh();
  }

  function deleteTable(): void {
    const sel = targetRange();
    const m = doc();
    if (!sel || !m?.blocks || !can() || reading) return;
    const range = tableRange(sel.from.b);
    if (!range) return;
    const all = range.end - range.start === m.blocks.length;
    commitSplice(range.start, range.end - range.start, all ? [emptyBlock(nextId++)] : [], all ? [undefined] : [], null);
    const left = blocksNow().length;
    setCaret({ b: Math.min(range.start, left - 1), o: 0 });
    ctx.refresh();
  }

  /* ─────────────────────────── font and paragraph dialogs ─────────────────────────── */

  function openFontDialog(): void {
    const keep = targetRange();
    if (!keep || !can() || reading) return;
    const now = currentProps();
    const base = baseLookAt(keep.from.b);
    const body = el('div', 'fo-form');
    const family = selectField(t('office.fontName'), FONTS.map((f) => ({ value: f, label: f })), now.font ?? 'Calibri');
    const size = selectField(t('office.formatSize'), SIZES.map((n) => ({ value: String(n), label: String(n) })), String(now.sz ?? 11));
    const toggles = (['b', 'i', 'u', 'strike'] as const).map((key) => ({
      key, field: checkField(t({ b: 'office.formatBold', i: 'office.formatItalic', u: 'office.formatUnderline', strike: 'office.formatStrike' }[key]), now[key] === true),
    }));
    body.append(family.row, size.row, ...toggles.map((x) => x.field.row));
    openModal({
      title: t('office.wFontTitle'), body, okLabel: t('office.apply'), cancelLabel: t('office.cancel'), host: ctx.host(),
      onOk: () => {
        const patch: PropsPatch = {};
        if (family.value() !== now.font) patch.font = family.value();
        const sz = Number(size.value());
        if (sz > 0 && sz !== now.sz) patch.sz = sz;
        for (const { key, field } of toggles) {
          const want = field.value();
          if (want !== (now[key] === true)) patch[key] = want === (base[key] === true) ? null : want;
        }
        lastSel = keep;
        if (Object.keys(patch).length) applyRun(patch);
        return true;
      },
    });
  }

  function openParagraphDialog(): void {
    const keep = targetRange();
    if (!keep || !can() || reading) return;
    const now = currentFormat();
    const body = el('div', 'fo-form');
    const alignF = selectField(t('office.wHfAlign'), [
      { value: 'right', label: t('office.formatAlignRight') }, { value: 'center', label: t('office.formatAlignCenter') },
      { value: 'left', label: t('office.formatAlignLeft') }, { value: 'justify', label: t('office.formatAlignJustify') },
    ], now.align);
    const dirF = selectField(t('office.wDirection'), [
      { value: 'rtl', label: t('office.dirRtl') }, { value: 'ltr', label: t('office.dirLtr') },
    ], now.dir);
    const lineF = selectField(t('office.lineSpacing'), LINES.map((n) => ({ value: String(n), label: String(n) })), String(now.line ?? 1.15));
    const indentF = decimalField(t('office.wIndentPt'), indentOf(keep.from.b), 0, 288, 1);
    body.append(alignF.row, dirF.row, lineF.row, indentF.row);
    openModal({
      title: t('office.wParagraphTitle'), body, okLabel: t('office.apply'), cancelLabel: t('office.cancel'), host: ctx.host(),
      onOk: () => {
        const dir = dirF.value() === 'rtl' ? 'rtl' : 'ltr';
        const logicalRtl = dir === 'rtl' && (now.logicalRtl || now.dir !== dir);
        const indent = Math.round(indentF.value());
        lastSel = keep;
        setParaFormat({
          align: logicalAlign(alignF.value() as ParagraphAlign, logicalRtl),
          dir,
          line: Number(lineF.value()) || null,
          indent: indent || null,
        }, keep);
        return true;
      },
    });
  }

  /* ─────────────────────────── the context menu ─────────────────────────── */

  /** Right-click (or the menu key): the editing menu at the pointer, a bottom sheet on a phone. */
  function openContextMenu(x: number, y: number): void {
    const office = root.closest<HTMLElement>('.faisal-office') ?? ctx.host();
    const box = office.getBoundingClientRect();
    const anchor = el('span', 'fo-ctxanchor');
    anchor.style.left = `${x - box.left}px`;
    anchor.style.top = `${y - box.top}px`;
    office.append(anchor);
    const sel = targetRange();
    const hasSel = !!sel && !sel.collapsed;
    const edit = can() && !reading;
    const block = sel ? blocksNow()[sel.from.b] : undefined;
    const inNew = !!block?.cell;
    const inFile = !inNew && !!lookOf(block)?.cell;
    const withIcon = (name: 'cut' | 'copy' | 'paste' | 'font' | 'lineSpacing' | 'link' | 'rowAdd' | 'colAdd' | 'rowDelete' | 'colDelete' | 'trash'): SVGSVGElement => icon(name);
    const items: Array<MenuItem | 'sep'> = [
      { label: t('office.wCut'), hint: 'Ctrl+X', icon: withIcon('cut'), disabled: !hasSel || !edit, run: () => { void copySelection(true); } },
      { label: t('office.wCopy'), hint: 'Ctrl+C', icon: withIcon('copy'), disabled: !hasSel, run: () => { void copySelection(false); } },
      { label: t('office.wPaste'), hint: 'Ctrl+V', icon: withIcon('paste'), disabled: !edit, run: () => { void pasteFromClipboard(); } },
      'sep',
      { label: t('office.wFont'), icon: withIcon('font'), disabled: !edit, run: openFontDialog },
      { label: t('office.wParagraph'), icon: withIcon('lineSpacing'), disabled: !edit, run: openParagraphDialog },
      { label: t('office.wLink'), hint: 'Ctrl+K', icon: withIcon('link'), disabled: !edit, run: openLinkDialog },
    ];
    if (inNew || inFile) {
      const ok = inNew && edit;
      items.push('sep',
        { label: t('office.wRowAbove'), icon: withIcon('rowAdd'), disabled: !ok, run: () => runTableOp('rowAbove') },
        { label: t('office.wRowBelow'), icon: withIcon('rowAdd'), disabled: !ok, run: () => runTableOp('rowBelow') },
        { label: t('office.wColBefore'), icon: withIcon('colAdd'), disabled: !ok, run: () => runTableOp('colBefore') },
        { label: t('office.wColAfter'), icon: withIcon('colAdd'), disabled: !ok, run: () => runTableOp('colAfter') },
        { label: t('office.wDeleteRow'), icon: withIcon('rowDelete'), disabled: !ok, run: () => runTableOp('deleteRow') },
        { label: t('office.wDeleteCol'), icon: withIcon('colDelete'), disabled: !ok, run: () => runTableOp('deleteCol') },
        { label: t('office.wDeleteTable'), icon: withIcon('trash'), disabled: !ok, danger: true, run: deleteTable },
      );
      if (inFile) ctx.setStatus(t('office.wTableFileOnly'));
    }
    items.push('sep', { label: t('office.wSelectAll'), hint: 'Ctrl+A', run: selectAll });
    const pop = openPopover(anchor, menuList(items, () => pop.close()), {
      label: t('office.wContextMenu'),
      onClose: () => { anchor.remove(); if (mode === 'page') flow.focus({ preventScroll: true }); },
    });
  }

  flow.addEventListener('contextmenu', (ev) => {
    if (!doc()) return;
    ev.preventDefault();
    let { clientX: x, clientY: y } = ev;
    if (!x && !y) {
      // The menu key: open at the caret.
      const r = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0).getBoundingClientRect() : null;
      x = r?.left ?? 0;
      y = r?.bottom ?? 0;
    }
    openContextMenu(x, y);
  });

  /* ─────────────────────────── commands (keyboard and phone) ─────────────────────────── */

  function docEnds(): { start: Pos; end: Pos } | null {
    const m = doc();
    const n = m?.blocks?.length ?? 0;
    if (!m || !n) return null;
    return { start: { b: 0, o: 0 }, end: { b: n - 1, o: (m.paragraphs[n - 1] ?? '').length } };
  }

  function selectAll(): void {
    const ends = docEnds();
    if (!ends || mode !== 'page') return;
    flow.focus({ preventScroll: true });
    setCaret(ends.start, ends.end);
    ctx.refresh();
  }

  /** Ctrl+Home / Ctrl+End (with Shift they extend the selection), scrolled into view. */
  function goToEdge(end: boolean, extend: boolean): void {
    const ends = docEnds();
    if (!ends || mode !== 'page') return;
    const keep = lastSel;
    flow.focus({ preventScroll: true });
    if (!extend || !keep) setCaret(end ? ends.end : ends.start);
    else if (end) setCaret(keep.from, ends.end);
    else setCaret(ends.start, keep.to);
    const target = end ? paraEls[paraEls.length - 1] : paraEls[0];
    target?.scrollIntoView?.({ block: 'nearest' });
    if (!end) canvas.scrollTop = 0;
    ctx.refresh();
  }

  /** Runs a command exactly as its ribbon button does. Returns false when it does not apply here. */
  function runCommand(cmd: WriterCommand): boolean {
    const editing = can() && !reading;
    switch (cmd) {
      case 'bold': if (!editing) return false; toggle('b'); return true;
      case 'italic': if (!editing) return false; toggle('i'); return true;
      case 'underline': if (!editing) return false; toggle('u'); return true;
      case 'strike': if (!editing) return false; toggle('strike'); return true;
      case 'superscript': if (!editing) return false; toggleScript('superscript'); return true;
      case 'subscript': if (!editing) return false; toggleScript('subscript'); return true;
      case 'clearFormat': if (!editing) return false; clearFormatting(); return true;
      case 'alignLeft': if (!editing) return false; align('left'); return true;
      case 'alignCenter': if (!editing) return false; align('center'); return true;
      case 'alignRight': if (!editing) return false; align('right'); return true;
      case 'alignJustify': if (!editing) return false; align('justify'); return true;
      case 'indent': if (!editing) return false; changeIndent(1); return true;
      case 'outdent': if (!editing) return false; changeIndent(-1); return true;
      case 'link': if (!editing) return false; openLinkDialog(); return true;
      case 'pageBreak': if (!editing) return false; insertPageBreak(); return true;
      case 'docStart': goToEdge(false, false); return true;
      case 'docEnd': goToEdge(true, false); return true;
      case 'docStartExtend': goToEdge(false, true); return true;
      case 'docEndExtend': goToEdge(true, true); return true;
      case 'selectAll': if (mode !== 'page') return false; selectAll(); return true;
      case 'find': openFind(false, findAnchor()); return true;
      case 'replace': if (!editing) return false; openFind(true, findAnchor()); return true;
      case 'print': printDoc(); return true;
      default: return false;
    }
  }

  /* ─────────────────────────── reading mode and the phone ─────────────────────────── */

  function isNarrow(): boolean {
    const office = root.closest<HTMLElement>('.faisal-office');
    const width = office?.clientWidth ?? root.clientWidth;
    return width > 0 && width < NARROW_BREAKPOINT;
  }

  /** Reading mode: the pages alone, nothing editable. The phone opens every document this way. */
  function setReading(on: boolean): void {
    reading = on;
    if (on) phoneEditing = false;
    root.classList.toggle('is-reading', on);
    flow.contentEditable = ctx.editable() && !on ? 'true' : 'false';
    readingBar.hidden = !on || isNarrow();
    renderReadingBar();
    renderRuler();
    renderPhoneBar();
    ctx.refresh();
  }

  function renderReadingBar(): void {
    const label = el('span', 'fo-wreading-label', t('office.wReadingMode'));
    const edit = button('edit', t('office.wEdit'), () => { setReading(false); flow.focus({ preventScroll: true }); }, { showLabel: true, primary: true });
    edit.disabled = !ctx.editable();
    readingBar.replaceChildren(icon('reading'), label, edit);
  }

  /** What the phone's editing bar is about right now: a selection, a table cell, or the caret. */
  function phoneContext(): 'read' | 'selection' | 'table' | 'caret' {
    if (reading || !phoneEditing) return 'read';
    const sel = targetRange();
    if (sel && !sel.collapsed) return 'selection';
    if (sel && blocksNow()[sel.from.b]?.cell) return 'table';
    return 'caret';
  }

  let phoneShown = '';
  function renderPhoneBar(force = false): void {
    const kind = phoneContext();
    const sig = `${kind}:${ctx.editable()}:${can()}`;
    if (!force && sig === phoneShown) return;
    phoneShown = sig;
    const tools: HTMLElement[] = [];
    const add = (name: Parameters<typeof button>[0], label: string, run: (anchor: HTMLElement) => void, opts: { primary?: boolean; disabled?: boolean; pressed?: boolean } = {}): void => {
      const b = button(name, label, () => run(b), { showLabel: true, keepFocus: true, primary: opts.primary, toggle: opts.pressed !== undefined, cls: 'fo-wphone-btn' });
      if (opts.pressed !== undefined) b.setAttribute('aria-pressed', String(opts.pressed));
      b.disabled = !!opts.disabled;
      tools.push(b);
    };
    if (kind === 'read') {
      add('navigator', t('office.navigator'), () => { sideOpen = !(sideOpen && sideTab === 'nav'); sideTab = 'nav'; renderSide(); });
      add('find', t('office.find'), (a) => openFind(false, a));
      if (ctx.editable()) add('edit', t('office.wEdit'), () => { phoneEditing = true; setReading(false); flow.focus({ preventScroll: true }); }, { primary: true });
      else tools.push(el('span', 'fo-wphone-note', t('office.wReadOnlyFile')));
    } else {
      if (kind === 'selection') {
        const p = currentProps();
        add('bold', t('office.formatBold'), () => { toggle('b'); renderPhoneBar(true); }, { pressed: p.b === true });
        add('italic', t('office.formatItalic'), () => { toggle('i'); renderPhoneBar(true); }, { pressed: p.i === true });
        add('underline', t('office.formatUnderline'), () => { toggle('u'); renderPhoneBar(true); }, { pressed: p.u === true });
      } else if (kind === 'table') {
        add('undo', t('office.undo'), () => ctx.undo());
        add('table', t('office.wTableOps'), (a) => openPhoneSheet(a, 'table'));
      } else {
        add('undo', t('office.undo'), () => ctx.undo());
        add('redo', t('office.redo'), () => ctx.redo());
      }
      add('font', t('office.wMobileFormat'), (a) => openPhoneSheet(a, 'format'));
      if (kind !== 'selection') add('plus', t('office.wMobileInsert'), (a) => openPhoneSheet(a, 'insert'));
      add('check', t('office.wDoneEditing'), () => { phoneEditing = false; setReading(true); }, { primary: true });
    }
    phoneBar.replaceChildren(...tools);
    phoneBar.dataset.mode = kind;
  }

  /** The phone's bottom sheets: formatting, inserting, and a table's rows and columns — large targets only. */
  function openPhoneSheet(anchor: HTMLElement, which: 'format' | 'insert' | 'table'): void {
    const box = el('div', 'fo-sheet-ribbon');
    const group = (label: string): HTMLElement => { box.append(el('div', 'fo-sheet-group', label)); const g = el('div', 'fo-sheet-grid'); box.append(g); return g; };
    const act = (g: HTMLElement, name: Parameters<typeof button>[0], label: string, run: () => void, pressed?: boolean): void => {
      const b = button(name, label, () => { pop.close(); run(); }, { showLabel: true, keepFocus: true, toggle: pressed !== undefined });
      if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
      g.append(b);
    };
    if (which === 'format') {
      const p = currentProps();
      const f = currentFormat();
      const font = group(t('office.groupFont'));
      const size = el('select', 'fo-select');
      size.setAttribute('aria-label', t('office.formatSize'));
      for (const n of SIZES) { const op = el('option', undefined, String(n)); op.value = String(n); size.append(op); }
      size.value = String(p.sz ?? 11);
      size.addEventListener('change', () => { const n = Number(size.value); if (n > 0) applyRun({ sz: n }); });
      font.append(size);
      act(font, 'bold', t('office.formatBold'), () => toggle('b'), p.b === true);
      act(font, 'italic', t('office.formatItalic'), () => toggle('i'), p.i === true);
      act(font, 'underline', t('office.formatUnderline'), () => toggle('u'), p.u === true);
      act(font, 'strike', t('office.formatStrike'), () => toggle('strike'), p.strike === true);
      act(font, 'clearFormat', t('office.wClearFormat'), clearFormatting);
      const colors = group(t('office.textColor'));
      for (const hex of ['000000', 'C00000', 'C8894B', '00B050', '0070C0', '7030A0']) {
        const sw = el('button', 'fo-swatch');
        sw.type = 'button';
        sw.style.background = `#${hex}`;
        sw.setAttribute('aria-label', `#${hex}`);
        sw.title = `#${hex}`;
        sw.addEventListener('mousedown', (ev) => ev.preventDefault());
        sw.addEventListener('click', () => { pop.close(); applyRun({ color: hex }); });
        colors.append(sw);
      }
      colors.classList.add('fo-wphone-colors');
      const para = group(t('office.groupParagraph'));
      act(para, 'alignRight', t('office.formatAlignRight'), () => align('right'), f.align === 'right');
      act(para, 'alignCenter', t('office.formatAlignCenter'), () => align('center'), f.align === 'center');
      act(para, 'alignLeft', t('office.formatAlignLeft'), () => align('left'), f.align === 'left');
      act(para, 'alignJustify', t('office.formatAlignJustify'), () => align('justify'), f.align === 'justify');
      act(para, 'bullets', t('office.bullets'), () => setParaFormat({ list: f.list === 'bullet' ? null : 'bullet' }), f.list === 'bullet');
      act(para, 'numbers', t('office.numbering'), () => setParaFormat({ list: f.list === 'number' ? null : 'number' }), f.list === 'number');
      act(para, 'rtl', t('office.dirRtl'), () => setParaFormat({ dir: 'rtl' }), f.dir === 'rtl');
      act(para, 'ltr', t('office.dirLtr'), () => setParaFormat({ dir: 'ltr' }), f.dir === 'ltr');
      const styles = group(t('office.groupStyles'));
      for (const item of styleItems()) act(styles, 'styles', item.label, item.run, item.checked);
    } else if (which === 'insert') {
      const g = group(t('office.tabInsert'));
      act(g, 'table', t('office.insertTable'), askTable);
      act(g, 'image', t('office.insertImage'), insertImage);
      act(g, 'link', t('office.wLink'), openLinkDialog);
      act(g, 'pageBreak', t('office.insertPageBreak'), insertPageBreak);
      act(g, 'pageNumber', t('office.wPageNumber'), () => pageNumbers('bottom'));
      act(g, 'footnote', t('office.insertFootnote'), () => insertNoteAt('footnote'));
      act(g, 'date', t('office.insertDate'), insertDate);
      act(g, 'symbol', t('office.wSymbol'), () => openSymbols(anchor));
    } else {
      const g = group(t('office.wTableOps'));
      act(g, 'rowAdd', t('office.wRowAbove'), () => runTableOp('rowAbove'));
      act(g, 'rowAdd', t('office.wRowBelow'), () => runTableOp('rowBelow'));
      act(g, 'colAdd', t('office.wColBefore'), () => runTableOp('colBefore'));
      act(g, 'colAdd', t('office.wColAfter'), () => runTableOp('colAfter'));
      act(g, 'rowDelete', t('office.wDeleteRow'), () => runTableOp('deleteRow'));
      act(g, 'colDelete', t('office.wDeleteCol'), () => runTableOp('deleteCol'));
      act(g, 'trash', t('office.wDeleteTable'), deleteTable);
    }
    const pop = openPopover(anchor, box, { label: t(which === 'format' ? 'office.wMobileFormat' : which === 'insert' ? 'office.wMobileInsert' : 'office.wTableOps'), sheet: true });
  }

  /* ─────────────────────────── find & replace ─────────────────────────── */

  function openFind(replace: boolean, anchor: HTMLElement): void {
    const box = el('div', 'fo-find');
    const q = el('input', 'fo-input');
    q.type = 'search';
    q.placeholder = t('office.findPlaceholder');
    q.setAttribute('aria-label', t('office.find'));
    const r = el('input', 'fo-input');
    r.placeholder = t('office.replaceWith');
    r.setAttribute('aria-label', t('office.replaceWith'));
    r.hidden = !replace;
    const count = el('div', 'fo-find-count');
    count.setAttribute('role', 'status');
    let matches: Match[] = [];
    let at = -1;
    const refresh = (): void => {
      matches = findAll(doc()?.paragraphs ?? [], q.value);
      count.textContent = q.value ? t('office.findCount', { n: matches.length ? at + 1 : 0, total: matches.length }) : '';
    };
    const go = (step: number): void => {
      refresh();
      if (!matches.length) return;
      at = (at + step + matches.length) % matches.length;
      const m = matches[at];
      paraEls[m.block]?.scrollIntoView({ block: 'center' });
      setCaret({ b: m.block, o: m.start }, { b: m.block, o: m.end });
      refresh();
    };
    const replaceOne = (): void => {
      refresh();
      const m = matches[at] ?? matches[0];
      if (!m) return;
      insertText({ from: { b: m.block, o: m.start }, to: { b: m.block, o: m.end }, collapsed: false }, r.value);
      go(0);
    };
    const replaceAll = (): void => {
      refresh();
      let n = 0;
      for (const m of [...matches].reverse()) { insertText({ from: { b: m.block, o: m.start }, to: { b: m.block, o: m.end }, collapsed: false }, r.value); n++; }
      ctx.setStatus(t('office.replacedCount', { n }));
      refresh();
    };
    q.addEventListener('input', () => { at = -1; refresh(); });
    q.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(ev.shiftKey ? -1 : 1); } });
    const actions = el('div', 'fo-find-actions');
    actions.append(
      button('chevronStart', t('office.findPrev'), () => go(-1)),
      button('chevronEnd', t('office.findNext'), () => go(1)),
    );
    if (replace) {
      actions.append(
        button(null, t('office.replace'), replaceOne, { showLabel: true }),
        button(null, t('office.replaceAll'), replaceAll, { showLabel: true }),
      );
    }
    box.append(q, r, count, actions);
    openPopover(anchor, box, { label: replace ? t('office.replace') : t('office.find') });
    q.focus();
  }

  /* ─────────────────────────── the side panel ─────────────────────────── */

  /* ─────────────────────────── the notes panel ─────────────────────────── */

  /**
   * The Notes tab: every note of the document in reading order — the footnotes, then the endnotes,
   * each with its own numbering — with its text in a field and a delete button that is always
   * visible. Nothing here needs a hover, and every control is the size the phone layout asks for.
   */
  function renderNotes(body: HTMLElement): void {
    const entries = documentNotes(doc()?.blocks ?? []);
    if (!entries.length) {
      body.append(emptyState('footnote', t('office.notesEmpty')));
      return;
    }
    for (const kind of ['footnote', 'endnote'] as const) {
      const list = entries.filter((entry) => entry.kind === kind);
      if (!list.length) continue;
      body.append(el('div', 'fo-notes-group', t(kind === 'footnote' ? 'office.footnotesTitle' : 'office.endnotesTitle')));
      for (const entry of list) body.append(noteCard(entry));
    }
    if (!ctx.editable()) body.append(el('p', 'fo-panel-note', t('office.notesReadOnly')));
  }

  /** One note in the panel: its number, its text, and the two things that can be done to it. */
  function noteCard(entry: NoteEntry): HTMLElement {
    const card = el('div', 'fo-note-card');
    const head = el('div', 'fo-note-head');
    const badge = el('span', `fo-note-badge is-${entry.kind}`, String(entry.number));
    badge.setAttribute('aria-hidden', 'true');
    head.append(badge);
    card.append(head);
    const field = el('textarea', 'fo-note-field');
    field.value = entry.text;
    field.rows = 2;
    field.dir = 'auto';
    field.readOnly = !ctx.editable();
    field.dataset.note = `${entry.blockId}:${entry.runIndex}`;
    field.setAttribute('aria-label', t('office.noteTextLabel', { n: entry.number }));
    field.addEventListener('input', () => editNote(entry.blockId, entry.runIndex, field.value));
    card.append(field);
    const actions = el('div', 'fo-note-actions');
    const go = el('button', 'fo-note-btn', t('office.showInDocument'));
    go.type = 'button';
    go.addEventListener('click', () => {
      const index = (doc()?.blocks ?? []).findIndex((b) => b.id === entry.blockId);
      if (index < 0) return;
      paraEls[index]?.scrollIntoView({ block: 'center' });
      setCaret({ b: index, o: runTextOffset(doc()?.blocks?.[index]?.runs ?? [], entry.runIndex) });
    });
    const remove = el('button', 'fo-note-btn is-danger', t('office.noteDelete', { n: entry.number }));
    remove.type = 'button';
    remove.disabled = !ctx.editable();
    remove.addEventListener('click', () => deleteNote(entry.blockId, entry.runIndex));
    actions.append(go, remove);
    card.append(actions);
    return card;
  }

  function renderSide(): void {
    side.hidden = !sideOpen;
    root.classList.toggle('has-side', sideOpen);
    if (!sideOpen) return;
    const head = el('div', 'fo-panel-head');
    const tabs = el('div', 'fo-panel-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [['nav', t('office.navigator')], ['notes', t('office.notesPanel')], ['comments', t('office.comments')]] as const) {
      const b = el('button', 'fo-panel-tab', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(sideTab === id));
      b.addEventListener('click', () => { sideTab = id; renderSide(); });
      tabs.append(b);
    }
    head.append(tabs, button('close', t('office.closePanel'), () => { sideOpen = false; renderSide(); ctx.refresh(); }));
    const body = el('div', 'fo-panel-body');
    if (sideTab === 'nav') {
      const list = headings();
      if (!list.length) body.append(emptyState('navigator', t('office.navEmpty')));
      for (const h of list) {
        const item = el('button', 'fo-nav-item', h.text);
        item.type = 'button';
        item.style.paddingInlineStart = `${12 + h.level * 16}px`;
        item.addEventListener('click', () => { paraEls[h.b]?.scrollIntoView({ block: 'start', behavior: 'smooth' }); setCaret({ b: h.b, o: 0 }); });
        body.append(item);
      }
    } else if (sideTab === 'notes') {
      renderNotes(body);
    } else {
      const comments = look?.comments ?? [];
      if (!comments.length) body.append(emptyState('comment', t('office.commentsEmpty')));
      for (const c of comments) {
        const card = el('div', 'fo-comment');
        const who = el('div', 'fo-comment-head');
        const avatar = el('span', 'fo-avatar', (c.initials || c.author || '?').slice(0, 2));
        avatar.setAttribute('aria-hidden', 'true');
        who.append(avatar, el('span', 'fo-comment-author', c.author || t('office.unknownAuthor')));
        if (c.date) who.append(el('span', 'fo-comment-date', c.date.slice(0, 10)));
        card.append(who, el('p', 'fo-comment-text', c.text));
        if (c.block !== null) {
          const go = el('button', 'fo-link', t('office.showInDocument'));
          go.type = 'button';
          go.addEventListener('click', () => { const b = c.block ?? 0; paraEls[b]?.scrollIntoView({ block: 'center' }); setCaret({ b, o: 0 }); });
          card.append(go);
        }
        body.append(card);
      }
      body.append(el('p', 'fo-panel-note', t('office.commentsReadOnly')));
    }
    side.replaceChildren(head, body);
  }

  function emptyState(name: 'navigator' | 'comment' | 'footnote', text: string): HTMLElement {
    const box = el('div', 'fo-empty-small');
    box.append(icon(name, 32), el('p', undefined, text));
    return box;
  }

  /* ─────────────────────────── export ─────────────────────────── */

  function outlines(): Array<number | undefined> {
    return (doc()?.blocks ?? []).map((_, b) => paraView(b, new Map()).outline);
  }

  function printDoc(): void {
    const g = pageGeometry();
    const copy = el('div', 'fo-print');
    const clone = flow.cloneNode(true) as HTMLElement;
    clone.removeAttribute('contenteditable');
    clone.querySelectorAll<HTMLElement>('[style*="margin-top"]').forEach((n) => { n.style.marginTop = ''; });
    clone.style.cssText = '';
    copy.append(clone);
    const p = look?.page;
    const css = `@page{size:${(p?.w ?? 595)}pt ${(p?.h ?? 842)}pt;margin:${p?.top ?? 72}pt ${p?.right ?? 72}pt ${p?.bottom ?? 72}pt ${p?.left ?? 72}pt}` +
      'body{margin:0;color:#000;background:#fff;font-family:Calibri,Arial,"Noto Naskh Arabic",sans-serif;--fo-doc-font:Calibri,Arial,"Noto Naskh Arabic",sans-serif}' +
      '.fo-p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.fo-marker{display:inline-block;min-width:18pt}' +
      '.fo-table{border-collapse:collapse}.fo-table td{padding:2pt 5pt;vertical-align:top}.fo-pagebreak{display:block;break-after:page}.fo-pagebreak-label{display:none}' +
      '.fo-op img{max-width:100%}.is-float-start{float:inline-start;margin:0 8pt 4pt 0}.is-float-end{float:inline-end;margin:0 0 4pt 8pt}' +
      `.fo-print{width:${(g.w - g.left - g.right) / PX}pt}`;
    ctx.print(copy, css);
  }

  /* ─────────────────────────── ribbon ─────────────────────────── */

  const can = (): boolean => ctx.editable() && !!doc();
  const alignButton = (visual: ParagraphAlign, labelKey: string, iconName: 'alignLeft' | 'alignCenter' | 'alignRight' | 'alignJustify', phone = false): Control => ({
    type: 'button', id: `align-${visual}`, icon: iconName, label: t(labelKey), enabled: can, phone,
    data: { align: visual },
    pressed: () => currentFormat().align === visual,
    run: () => align(visual),
  });

  function styleItems(): MenuItem[] {
    const list = look ? galleryStyles(look.styles) : [
      { id: 'Normal', name: 'Normal' }, { id: 'Title', name: 'Title' }, { id: 'Subtitle', name: 'Subtitle' },
      { id: 'Heading1', name: 'heading 1' }, { id: 'Heading2', name: 'heading 2' }, { id: 'Heading3', name: 'heading 3' }, { id: 'Quote', name: 'Quote' },
    ];
    const current = currentFormat().style;
    return list.map((s) => ({ label: styleLabel(s.id, s.name), checked: current === s.id, run: () => applyStyle(s.id) }));
  }

  function styleLabel(id: string, name: string): string {
    const key: Record<string, string> = {
      Normal: 'office.styleNormal', Title: 'office.styleTitle', Subtitle: 'office.styleSubtitle', Heading1: 'office.styleHeading1',
      Heading2: 'office.styleHeading2', Heading3: 'office.styleHeading3', Quote: 'office.styleQuote',
    };
    return key[id] ? t(key[id]) : name;
  }

  /** The look a style gallery chip previews: the style's own font, size, weight and colour. */
  function styleLook(id: string): TextLook {
    if (look) return resolveStyle(look.styles, id).text;
    const preset: Record<string, TextLook> = {
      Title: { sz: 28, color: '17365D' }, Subtitle: { sz: 15, i: true, color: '595959' },
      Heading1: { sz: 18, b: true, color: '1F3864' }, Heading2: { sz: 14, b: true, color: '2F5496' },
      Heading3: { sz: 12, b: true, color: '1F3763' }, Quote: { i: true, color: '404040' },
    };
    return preset[id] ?? {};
  }

  /** The styles gallery: each chip is drawn in its own style (a live preview), the current one marked. */
  function styleGallery(): Control {
    const chips: HTMLElement[] = [];
    const ids = ['Normal', 'Title', 'Subtitle', 'Heading1', 'Heading2', 'Heading3', 'Quote'];
    return {
      type: 'custom', id: 'stylegallery', label: t('office.wStyleGallery'), enabled: can,
      render: () => {
        const box = el('div', 'fo-stylegallery');
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', t('office.wStyleGallery'));
        for (const id of ids) {
          const chip = el('button', 'fo-stylechip');
          chip.type = 'button';
          chip.dataset.style = id;
          const name = styleLabel(id, id);
          chip.title = name;
          chip.setAttribute('aria-pressed', 'false');
          const sample = el('span', 'fo-stylechip-sample', name);
          const s = styleLook(id);
          sample.style.fontFamily = fontStack(s.font);
          sample.style.fontSize = `${clamp(Math.round((s.sz ?? 11) * 1.05), 12, 16)}px`;
          if (s.b) sample.style.fontWeight = '700';
          if (s.i) sample.style.fontStyle = 'italic';
          if (s.color && s.color !== '000000') sample.style.color = `#${s.color}`;
          chip.append(sample);
          chip.addEventListener('mousedown', (ev) => ev.preventDefault());
          chip.addEventListener('click', () => applyStyle(id));
          chips.push(chip);
          box.append(chip);
        }
        return box;
      },
      sync: () => {
        const current = currentFormat().style;
        const enabled = can() && !reading;
        for (let k = chips.length - 1; k >= 0; k--) {
          const chip = chips[k];
          if (!chip.isConnected) { chips.splice(k, 1); continue; }
          chip.setAttribute('aria-pressed', String(chip.dataset.style === current));
          (chip as HTMLButtonElement).disabled = !enabled;
        }
      },
    };
  }

  function tabs(): RibbonTab[] {
    const fontOptions = (): Array<{ value: string; label: string }> => FONTS.map((f) => ({ value: f, label: f }));
    const edit = (): boolean => can() && !reading;
    const inNewTable = (): boolean => { const sel = targetRange(); return edit() && !!sel && !!blocksNow()[sel.from.b]?.cell; };
    const page = (): PageSetup => pageSetup();
    const marginItem = (name: MarginName, key: string): MenuItem => ({
      label: t(key), checked: marginsOf(page()) === name, run: () => setPage(withMargins(page(), MARGINS[name])),
    });
    const paperItem = (name: PaperName): MenuItem => ({
      label: `${name} (${Math.round(PAPERS[name][0] / 72 * 25.4)} × ${Math.round(PAPERS[name][1] / 72 * 25.4)} mm)`,
      checked: paperOf(page()) === name, run: () => setPage(withPaper(page(), name)),
    });
    return [
      ctx.fileTab(),
      {
        id: 'home', label: t('office.tabHome'), groups: [
          {
            label: t('office.wGroupClipboard'), controls: [
              { type: 'button', id: 'paste', icon: 'paste', label: t('office.wPaste'), showLabel: true, enabled: edit, run: () => { void pasteFromClipboard(); } },
              { type: 'button', id: 'cut', icon: 'cut', label: t('office.wCut'), enabled: edit, run: () => { void copySelection(true); } },
              { type: 'button', id: 'copy', icon: 'copy', label: t('office.wCopy'), enabled: () => !!doc(), run: () => { void copySelection(false); } },
            ],
          },
          {
            label: t('office.groupFont'), controls: [
              { type: 'select', id: 'font', label: t('office.fontName'), cls: 'fo-fontname', width: 240, enabled: edit, options: fontOptions, value: () => currentProps().font ?? 'Calibri', onChange: (v) => applyRun({ font: v }) },
              {
                type: 'select', id: 'size', label: t('office.formatSize'), cls: 'faisal-office-fsize', width: 72, enabled: edit,
                options: () => SIZES.map((s) => ({ value: String(s), label: String(s) })),
                value: () => String(currentProps().sz ?? 11),
                onChange: (v) => { const n = Number(v); if (n > 0) applyRun({ sz: n }); },
              },
              { type: 'button', id: 'bold', icon: 'bold', label: t('office.formatBold'), enabled: edit, pressed: () => currentProps().b === true, run: () => toggle('b') },
              { type: 'button', id: 'italic', icon: 'italic', label: t('office.formatItalic'), enabled: edit, pressed: () => currentProps().i === true, run: () => toggle('i') },
              { type: 'button', id: 'underline', icon: 'underline', label: t('office.formatUnderline'), enabled: edit, pressed: () => currentProps().u === true, run: () => toggle('u') },
              { type: 'button', id: 'strike', icon: 'strike', label: t('office.formatStrike'), enabled: edit, pressed: () => currentProps().strike === true, run: () => toggle('strike') },
              { type: 'button', id: 'superscript', icon: 'superscript', label: t('office.wSuperscript'), enabled: edit, pressed: () => currentProps().va === 'superscript', run: () => toggleScript('superscript') },
              { type: 'button', id: 'subscript', icon: 'subscript', label: t('office.wSubscript'), enabled: edit, pressed: () => currentProps().va === 'subscript', run: () => toggleScript('subscript') },
              { type: 'color', id: 'color', icon: 'textColor', label: t('office.textColor'), noneLabel: t('office.colorAuto'), palette: PALETTE, enabled: edit, value: () => currentProps().color ?? '000000', onPick: (hex) => applyRun({ color: hex }) },
              { type: 'color', id: 'highlight', icon: 'highlight', label: t('office.highlight'), noneLabel: t('office.colorNone'), palette: Object.values(HIGHLIGHTS), enabled: edit, value: () => { const h = currentProps().hl; return h ? HIGHLIGHTS[h] ?? null : null; }, onPick: (hex) => applyRun({ hl: hex ? HL_BY_HEX[hex] ?? 'yellow' : null }) },
              { type: 'button', id: 'clearformat', icon: 'clearFormat', label: t('office.wClearFormat'), enabled: edit, run: clearFormatting },
            ],
          },
          {
            label: t('office.groupParagraph'), controls: [
              { type: 'button', id: 'bullets', icon: 'bullets', label: t('office.bullets'), enabled: edit, pressed: () => currentFormat().list === 'bullet', run: () => setParaFormat({ list: currentFormat().list === 'bullet' ? null : 'bullet' }) },
              { type: 'button', id: 'numbers', icon: 'numbers', label: t('office.numbering'), enabled: edit, pressed: () => currentFormat().list === 'number', run: () => setParaFormat({ list: currentFormat().list === 'number' ? null : 'number' }) },
              { type: 'button', id: 'outdent', icon: 'outdent', label: t('office.wOutdent'), enabled: () => edit() && indentOf(targetRange()?.from.b ?? 0) > 0, run: () => changeIndent(-1) },
              { type: 'button', id: 'indent', icon: 'indent', label: t('office.wIndent'), enabled: edit, run: () => changeIndent(1) },
              alignButton('right', 'office.formatAlignRight', 'alignRight'),
              alignButton('center', 'office.formatAlignCenter', 'alignCenter'),
              alignButton('left', 'office.formatAlignLeft', 'alignLeft'),
              alignButton('justify', 'office.formatAlignJustify', 'alignJustify'),
              {
                type: 'menu', id: 'line', icon: 'lineSpacing', label: t('office.lineSpacing'), enabled: edit,
                items: () => LINES.map((n) => ({ label: String(n), checked: Math.abs((currentFormat().line ?? 1.15) - n) < 0.01, run: () => setParaFormat({ line: n }) })),
              },
              { type: 'button', id: 'rtl', icon: 'rtl', label: t('office.dirRtl'), enabled: edit, pressed: () => currentFormat().dir === 'rtl', run: () => setParaFormat({ dir: 'rtl' }) },
              { type: 'button', id: 'ltr', icon: 'ltr', label: t('office.dirLtr'), enabled: edit, pressed: () => currentFormat().dir === 'ltr', run: () => setParaFormat({ dir: 'ltr' }) },
            ],
          },
          {
            label: t('office.groupStyles'), controls: [
              styleGallery(),
              { type: 'menu', id: 'styles', icon: 'styles', label: t('office.wMoreStyles'), enabled: edit, items: styleItems },
            ],
          },
          {
            label: t('office.groupEditing'), controls: [
              { type: 'button', id: 'find', icon: 'find', label: t('office.find'), enabled: () => !!doc(), run: () => openFind(false, findAnchor()) },
              { type: 'button', id: 'replace', icon: 'replace', label: t('office.replace'), enabled: edit, run: () => openFind(true, findAnchor()) },
              { type: 'button', id: 'selectall', icon: 'fit', label: t('office.wSelectAll'), enabled: () => !!doc() && mode === 'page', run: selectAll },
            ],
          },
        ],
      },
      {
        id: 'insert', label: t('office.tabInsert'), groups: [
          {
            label: t('office.groupPages'), controls: [
              { type: 'button', id: 'pagebreak', icon: 'pageBreak', label: t('office.insertPageBreak'), showLabel: true, enabled: edit, run: insertPageBreak },
            ],
          },
          {
            label: t('office.groupTables'), controls: [
              { type: 'button', id: 'table', icon: 'table', label: t('office.insertTable'), showLabel: true, enabled: edit, run: askTable },
            ],
          },
          {
            label: t('office.wGroupIllustrations'), controls: [
              { type: 'button', id: 'image', icon: 'image', label: t('office.insertImage'), showLabel: true, enabled: edit, run: insertImage },
              {
                type: 'menu', id: 'shape', icon: 'shape', label: t('office.wShape'), showLabel: true, enabled: edit,
                items: () => SHAPES.map(([kind, key]) => ({ label: t(key), run: () => { void insertShape(kind); } })),
              },
            ],
          },
          {
            label: t('office.wGroupLinks'), controls: [
              { type: 'button', id: 'link', icon: 'link', label: t('office.wLink'), showLabel: true, enabled: edit, run: openLinkDialog },
            ],
          },
          {
            label: t('office.wGroupHeaderFooter'), controls: [
              { type: 'button', id: 'header', icon: 'header', label: t('office.wHeader'), showLabel: true, enabled: edit, run: () => openHeaderFooter('header') },
              { type: 'button', id: 'footer', icon: 'footer', label: t('office.wFooter'), showLabel: true, enabled: edit, run: () => openHeaderFooter('footer') },
              {
                type: 'menu', id: 'pagenumber', icon: 'pageNumber', label: t('office.wPageNumber'), showLabel: true, enabled: edit,
                items: () => [
                  { label: t('office.wPageNumberBottom'), run: () => pageNumbers('bottom') },
                  { label: t('office.wPageNumberTop'), run: () => pageNumbers('top') },
                  { label: t('office.wPageNumberOfTotal'), run: () => pageNumbers('ofTotal') },
                  'sep',
                  { label: t('office.wPageNumberRemove'), run: () => pageNumbers('remove') },
                ],
              },
            ],
          },
          {
            label: t('office.wGroupSymbols'), controls: [
              { type: 'button', id: 'symbol', icon: 'symbol', label: t('office.wSymbol'), showLabel: true, enabled: edit, run: () => openSymbols(anchorFor('symbol')) },
              { type: 'button', id: 'date', icon: 'date', label: t('office.insertDate'), showLabel: true, enabled: edit, run: insertDate },
              {
                type: 'button', id: 'mailmerge', icon: 'toc', label: t('office.mergeTitle'), showLabel: true, enabled: edit,
                run: () => openMailMergePanel(ctx, {
                  paragraphs: () => {
                    const m = ctx.model();
                    return m && m.kind === 'docx' ? m.paragraphs : [];
                  },
                  insertField: (name) => insertMergeField(ctx, name),
                }),
              },
            ],
          },
        ],
      },
      {
        id: 'layout', label: t('office.wTabLayout'), groups: [
          {
            label: t('office.wGroupPageSetup'), controls: [
              {
                type: 'menu', id: 'margins', icon: 'margins', label: t('office.wMargins'), showLabel: true, enabled: edit,
                items: () => [
                  marginItem('normal', 'office.wMarginsNormal'), marginItem('narrow', 'office.wMarginsNarrow'),
                  marginItem('moderate', 'office.wMarginsModerate'), marginItem('wide', 'office.wMarginsWide'),
                  'sep', { label: t('office.wMarginsCustom'), checked: marginsOf(page()) === null, run: openCustomMargins },
                ],
              },
              {
                type: 'menu', id: 'orientation', icon: 'orientation', label: t('office.wOrientation'), showLabel: true, enabled: edit,
                items: () => (['portrait', 'landscape'] as const).map((o) => ({
                  label: t(o === 'portrait' ? 'office.wPortrait' : 'office.wLandscape'), checked: orientationOf(page()) === o,
                  run: () => setPage(withOrientation(page(), o)),
                })),
              },
              {
                type: 'menu', id: 'pagesize', icon: 'pageSize', label: t('office.wSize'), showLabel: true, enabled: edit,
                items: () => (Object.keys(PAPERS) as PaperName[]).map(paperItem),
              },
              {
                type: 'menu', id: 'columns', icon: 'columns', label: t('office.wColumns'), showLabel: true, enabled: edit,
                items: () => [1, 2, 3].map((n) => ({
                  label: n === 1 ? t('office.wColumnsOne') : n === 2 ? t('office.wColumnsTwo') : t('office.wColumnsN', { n }),
                  checked: page().cols === n, run: () => setPage(withColumns(page(), n)),
                })),
              },
              {
                type: 'menu', id: 'breaks', icon: 'pageBreak', label: t('office.wBreaks'), showLabel: true, enabled: edit,
                items: () => [
                  { label: t('office.insertPageBreak'), hint: 'Ctrl+Enter', run: insertPageBreak },
                  { label: t('office.wColumnBreak'), run: insertColumnBreak },
                ],
              },
            ],
          },
          {
            label: t('office.groupParagraph'), controls: [
              { type: 'button', id: 'layoutoutdent', icon: 'outdent', label: t('office.wOutdent'), enabled: () => edit() && indentOf(targetRange()?.from.b ?? 0) > 0, run: () => changeIndent(-1) },
              { type: 'button', id: 'layoutindent', icon: 'indent', label: t('office.wIndent'), enabled: edit, run: () => changeIndent(1) },
            ],
          },
          {
            label: t('office.wTableOps'), controls: [
              { type: 'button', id: 'rowbelow', icon: 'rowAdd', label: t('office.wRowBelow'), enabled: inNewTable, run: () => runTableOp('rowBelow') },
              { type: 'button', id: 'colafter', icon: 'colAdd', label: t('office.wColAfter'), enabled: inNewTable, run: () => runTableOp('colAfter') },
              { type: 'button', id: 'deleterow', icon: 'rowDelete', label: t('office.wDeleteRow'), enabled: inNewTable, run: () => runTableOp('deleteRow') },
              { type: 'button', id: 'deletecol', icon: 'colDelete', label: t('office.wDeleteCol'), enabled: inNewTable, run: () => runTableOp('deleteCol') },
            ],
          },
        ],
      },
      {
        id: 'references', label: t('office.wTabReferences'), groups: [
          {
            label: t('office.wGroupToc'), controls: [
              { type: 'button', id: 'toc', icon: 'toc', label: t('office.insertToc'), showLabel: true, enabled: edit, run: insertToc },
            ],
          },
          {
            // A note is inserted at the caret and its text is typed in the panel that opens, so the
            // whole feature is reachable from the ribbon alone — no hover, no right-click.
            label: t('office.groupNotes'), controls: [
              { type: 'button', id: 'footnote', icon: 'footnote', label: t('office.insertFootnote'), showLabel: true, enabled: edit, run: () => insertNoteAt('footnote') },
              { type: 'button', id: 'endnote', icon: 'endnote', label: t('office.insertEndnote'), showLabel: true, enabled: edit, run: () => insertNoteAt('endnote') },
              { type: 'button', id: 'notespanel', icon: 'footnote', label: t('office.notesPanel'), showLabel: true, pressed: () => sideOpen && sideTab === 'notes', run: () => { sideOpen = !(sideOpen && sideTab === 'notes'); sideTab = 'notes'; renderSide(); ctx.refresh(); } },
            ],
          },
          {
            label: t('office.wGroupLinks'), controls: [
              {
                type: 'menu', id: 'crossref', icon: 'link', label: t('office.wCrossRef'), showLabel: true, enabled: edit,
                items: () => {
                  const list = headings();
                  if (!list.length) return [{ label: t('office.wCrossRefEmpty'), disabled: true, run: () => undefined }];
                  return list.map((h) => ({ label: `${'  '.repeat(h.level)}${h.text.length > 48 ? `${h.text.slice(0, 48)}…` : h.text}`, run: () => insertCrossRef(h.b) }));
                },
              },
            ],
          },
        ],
      },
      {
        // Review: tracking on/off, the change list, the verdicts, the comments and the word count —
        // one tab (the file used to show two tabs called Review). Everything is a real button.
        id: 'review', label: t('office.tabReview'), groups: [
          {
            label: t('office.groupProofing'), controls: [
              { type: 'button', id: 'wordcount', icon: 'wordCount', label: t('office.wordCount'), showLabel: true, enabled: () => !!doc(), run: showCounts },
            ],
          },
          {
            label: t('office.comments'), controls: [
              { type: 'button', id: 'showcomments', icon: 'comment', label: t('office.showComments'), showLabel: true, pressed: () => sideOpen && sideTab === 'comments', run: () => { sideOpen = !(sideOpen && sideTab === 'comments'); sideTab = 'comments'; renderSide(); } },
            ],
          },
          {
            label: t('office.groupTracking'), controls: [
              {
                type: 'button', id: 'tracking', icon: 'check', label: t('office.revToggle'), showLabel: true,
                pressed: () => tracking,
                run: () => { tracking = !tracking; ctx.refresh(); renderFlow(); },
              },
              { type: 'button', id: 'revpanel', icon: 'comment', label: t('office.revPanel'), showLabel: true, enabled: () => revLog.items.length > 0, run: () => toggleReviewPanel(true) },
            ],
          },
          {
            label: t('office.groupVerdicts'), controls: [
              { type: 'button', id: 'revacceptall', icon: 'check', label: t('office.revAcceptAll'), showLabel: true, enabled: () => pendingRevisions(revLog).length > 0, run: () => { void confirmBulk('accept'); } },
              { type: 'button', id: 'revrejectall', icon: 'close', label: t('office.revRejectAll'), showLabel: true, enabled: () => pendingRevisions(revLog).length > 0, run: () => { void confirmBulk('reject'); } },
              { type: 'button', id: 'revclear', icon: 'trash', label: t('office.revClear'), showLabel: true, enabled: () => revLog.items.length > 0, run: () => { revLog = emptyLog(); renderReview(); renderFlow(); ctx.refresh(); } },
            ],
          },
        ],
      },
      {
        id: 'view', label: t('office.tabView'), groups: [
          {
            label: t('office.groupViews'), controls: [
              { type: 'button', id: 'pageview', icon: 'pageView', label: t('office.pageView'), showLabel: true, pressed: () => mode === 'page' && !reading, run: () => { setReading(false); setMode('page'); } },
              { type: 'button', id: 'reading', icon: 'reading', label: t('office.wReadingMode'), showLabel: true, pressed: () => reading, run: () => { setMode('page'); setReading(!reading); } },
              { type: 'button', id: 'draftview', icon: 'draft', label: t('office.draftView'), showLabel: true, pressed: () => mode === 'draft', run: () => { setReading(false); setMode('draft'); } },
            ],
          },
          {
            label: t('office.wGroupShow'), controls: [
              { type: 'button', id: 'ruler', icon: 'ruler', label: t('office.wRuler'), showLabel: true, pressed: () => showRuler, run: () => { showRuler = !showRuler; renderRuler(); } },
              { type: 'button', id: 'navigator', icon: 'navigator', label: t('office.navigator'), showLabel: true, pressed: () => sideOpen && sideTab === 'nav', run: () => { sideOpen = !(sideOpen && sideTab === 'nav'); sideTab = 'nav'; renderSide(); } },
            ],
          },
          {
            label: t('office.groupZoom'), controls: [
              { type: 'button', id: 'zoomout', icon: 'zoomOut', label: t('office.zoomOut'), run: () => setZoom(zoom - 0.1) },
              { type: 'button', id: 'zoomin', icon: 'zoomIn', label: t('office.zoomIn'), run: () => setZoom(zoom + 0.1) },
              { type: 'button', id: 'zoom100', icon: 'pageSize', label: t('office.zoom100'), run: () => setZoom(1) },
              { type: 'button', id: 'fitwidth', icon: 'fit', label: t('office.fitWidth'), pressed: () => fitWidth, run: () => { fitWidth = true; applyZoom(); } },
            ],
          },
        ],
      },
    ];
  }

  function findAnchor(): HTMLElement {
    return ctx.host().querySelector<HTMLElement>('[data-control="find"]:not([hidden])') ?? ctx.host();
  }

  function setZoom(value: number): void {
    fitWidth = false;
    zoom = clamp(Math.round(value * 100) / 100, 0.5, 2);
    applyZoom();
    ctx.refresh();
  }

  function setMode(next: 'page' | 'draft'): void {
    mode = next;
    canvas.hidden = mode !== 'page';
    draft.hidden = mode !== 'draft';
    if (mode === 'draft') renderDraft();
    else { renderFlow(); applyZoom(); }
    ctx.refresh();
  }

  function counts(): ReturnType<typeof countText> & { paragraphs: number } {
    const paragraphs = doc()?.paragraphs ?? [];
    return { ...countText(paragraphs), paragraphs: paragraphs.filter((p) => p.trim()).length };
  }

  function showCounts(): void {
    const c = counts();
    const body = el('dl', 'fo-stats');
    for (const [label, value] of [
      [t('office.statPages'), pageCount], [t('office.statWords'), c.words], [t('office.statChars'), c.chars],
      [t('office.statCharsNoSpaces'), c.charsNoSpaces], [t('office.statParagraphs'), c.paragraphs],
    ] as const) {
      body.append(el('dt', undefined, label), el('dd', undefined, String(value)));
    }
    openModal({ title: t('office.wordCount'), body, okLabel: t('office.close'), cancelLabel: t('office.cancel'), host: ctx.host(), onOk: () => undefined });
  }

  /* ─────────────────────────── lifecycle ─────────────────────────── */

  const resize = observeSize(canvas, () => applyZoom());

  return {
    element: root,
    tabs,
    render(): void {
      flow.contentEditable = ctx.editable() && !reading ? 'true' : 'false';
      const keep = lastSel;
      renderFlow();
      renderDraft();
      renderSide();
      applyZoom();
      if (keep && flow.contains(document.activeElement)) {
        const n = doc()?.blocks?.length ?? 0;
        const b = Math.min(keep.from.b, Math.max(0, n - 1));
        setCaret({ b, o: Math.min(keep.from.o, (doc()?.paragraphs[b] ?? '').length) });
      }
    },
    status(): StatusInfo {
      const c = counts();
      const parts = [
        t('office.statusPage', { n: caretPage + 1, total: pageCount }),
        t('office.statusWords', { n: c.words }),
        t('office.statusChars', { n: c.chars }),
        currentFormat().dir === 'rtl' ? t('office.statusRtl') : t('office.statusLtr'),
      ];
      // The tracking state is never a guess: off says off, on says on and how many changes wait.
      parts.push(tracking
        ? t('office.revOnCount', { n: revisionCounts(revLog).pending })
        : t('office.revOff'));
      return { parts, zoom: mode === 'page' && !fluid ? { value: zoom, set: setZoom } : undefined };
    },
    onKey(ev: KeyboardEvent): boolean {
      const cmd = shortcutOf(ev);
      if (!cmd) return false;
      // A text field of a dialog or panel keeps its own keys; a Draft paragraph takes formatting only.
      const target = ev.target as HTMLElement | null;
      const field = !!target && !flow.contains(target) && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (field) {
        const draftField = target.classList.contains('faisal-office-para');
        const formatting = !['docStart', 'docEnd', 'docStartExtend', 'docEndExtend', 'selectAll', 'find', 'replace', 'print', 'link', 'pageBreak'].includes(cmd);
        if (!(draftField && formatting) && !['find', 'print'].includes(cmd)) return false;
      }
      return runCommand(cmd);
    },
    dispose(): void {
      resize.disconnect();
      document.removeEventListener('selectionchange', onSelectionChange);
      for (const url of mediaUrls.values()) URL.revokeObjectURL(url);
      mediaUrls.clear();
    },
    ...{
      printDoc,
      exportHtml: () => { const m = doc(); if (m) void ctx.exportFile(toHtml(m, ctx.filePath() ?? '', outlines()), 'html', 'text/html'); },
      exportMd: () => { const m = doc(); if (m) void ctx.exportFile(toMarkdown(m, outlines()), 'md', 'text/markdown'); },
      // OpenDocument Text: the package is built by `odt.ts` (mimetype stored and first) and written
      // by the same export path as the other formats — this document keeps its own file.
      exportOdt: () => {
        const m = doc();
        if (m) void ctx.exportFile(toOdt(m, { title: odtTitleOf(m, 'Untitled'), created: new Date().toISOString() }), 'odt', ODT_MIME);
      },
      // What the save must write into the file as `w:ins`/`w:del`: the changes still waiting for a
      // decision. An accepted or rejected one is already in the document's own text.
      pendingRevisions: (): Revision[] => pendingRevisions(revLog),
    },
  } as Editor & { printDoc(): void; exportHtml(): void; exportMd(): void; exportOdt(): void; pendingRevisions(): Revision[] };
}
