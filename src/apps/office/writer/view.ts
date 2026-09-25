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
import type { Editor, EditorContext, StatusInfo } from '../editor';
import type { DocModel, ParagraphAlign, ParagraphFormat } from '../model';
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
import { findAll, type Match } from './find';
import { paginate, PX } from './paginate';
import {
  applyChangeToText, authorStamp, counts as revisionCounts, decide, decideAll, emptyLog, pending as pendingRevisions, shiftAfter,
  planPieces, record, revisionsOf, type Change, type Revision, type RevisionLog,
} from './revisions';
import { shellConfirm } from '../../../shell/dialog';
import { blockText, type DocBlock, type OpaqueRun, type Run, type RunProps } from './types';

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
  let sideTab: 'nav' | 'comments' = look?.comments.length ? 'comments' : 'nav';
  let pending: RunProps | null = null;
  let lastSel: Sel | null = null;
  /** Set while a Draft field has focus: formatting then acts on that whole paragraph. */
  let draftPara: number | null = null;
  let composing = false;
  let pageCount = 1;
  let caretPage = 0;
  let wordToken = 0;
  let selectedImage: { b: number; run: number } | null = null;
  const mediaUrls = new Map<string, string>();
  const newUrls = new WeakMap<Uint8Array, string>();
  const opaqueText = new WeakMap<HTMLElement, string>();

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
  canvas.append(stage);
  const draft = el('div', 'fo-draft');
  draft.hidden = true;
  const side = el('aside', 'fo-side');
  side.hidden = true;
  main.append(canvas, draft);
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

  interface ParaView { dir: 'rtl' | 'ltr'; /** Direction guessed from the text for display (the file states none). */ autoDir: boolean; align: ParagraphAlign | undefined; text: TextLook; marker?: string; spaceBefore: number; spaceAfter: number; line?: number; lineExact: boolean; indStart: number; indEnd: number; firstLine: number; outline?: number; shade?: string }

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
      align: format.align !== undefined ? format.align ?? undefined : para.align,
      text: styled.text,
      marker,
      spaceBefore: para.before ?? 0,
      spaceAfter: para.after ?? (look ? 0 : 8),
      line: format.line ?? para.line,
      lineExact: format.line ? false : !!para.lineExact,
      indStart: (para.indStart ?? 0) + listIndent,
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
    p.dir = view.dir;
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
  let revLog: RevisionLog = emptyLog();
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
    panel.append(head, list);
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

  function pageGeometry(): { w: number; h: number; top: number; bottom: number; left: number; right: number } {
    const p = look?.page ?? { w: 595.3, h: 841.9, top: 72, bottom: 72, left: 72, right: 72 };
    return { w: p.w * PX, h: p.h * PX, top: p.top * PX, bottom: p.bottom * PX, left: p.left * PX, right: p.right * PX };
  }

  function headerFooter(kind: 'headers' | 'footers', page: number): HTMLElement | null {
    const set = look?.[kind];
    const hf = page === 0 && look?.page.titlePage ? set?.first : set?.default;
    if (!hf) return null;
    const box = el('div', kind === 'headers' ? 'fo-header' : 'fo-footer');
    for (const line of hf.lines) {
      const row = el('div', 'fo-hfline', line.text.replace(/\u0001/g, String(page + 1)).replace(/\u0002/g, String(pageCount)));
      row.dir = line.rtl ? 'rtl' : 'ltr';
      row.style.textAlign = cssAlign(line.align);
      if (line.size) row.style.fontSize = `${line.size}pt`;
      box.append(row);
    }
    return box;
  }

  function layoutPages(): void {
    const g = pageGeometry();
    stage.style.width = fluid ? '' : `${g.w}px`;
    flow.style.width = fluid ? '' : `${g.w - g.left - g.right}px`;
    flow.style.insetInlineStart = '';
    flow.style.left = fluid ? '' : `${g.left}px`;
    flow.style.top = fluid ? '' : `${g.top}px`;
    if (fluid) {
      for (const unit of units) unit.style.marginTop = '';
      pageLayer.replaceChildren();
      pageCount = 1;
      stage.style.height = '';
      ctx.refresh();
      return;
    }
    const heights = units.map((u) => u.offsetHeight);
    const breaks = new Set<number>();
    units.forEach((u, k) => { if (u.querySelector(':scope > .fo-pagebreak, :scope .fo-p > .fo-pagebreak') && k + 1 < units.length) breaks.add(k + 1); });
    const result = paginate(heights, { height: g.h, gap: GAP, top: 0, bottom: g.top + g.bottom }, breaks);
    units.forEach((u, k) => {
      const want = result.pushes[k] ? `${result.pushes[k]}px` : '';
      if (u.style.marginTop !== want) u.style.marginTop = want;
    });
    pageCount = result.pages;
    const layer: HTMLElement[] = [];
    for (let k = 0; k < result.pages; k++) {
      const page = el('div', 'fo-page');
      page.style.top = `${k * (g.h + GAP)}px`;
      page.style.height = `${g.h}px`;
      const header = headerFooter('headers', k);
      if (header) { header.style.top = `${(look?.page.header ?? 36) * PX}px`; header.style.insetInline = `${g.left}px ${g.right}px`; page.append(header); }
      const footer = headerFooter('footers', k);
      if (footer) { footer.style.bottom = `${(look?.page.footer ?? 36) * PX}px`; footer.style.insetInline = `${g.left}px ${g.right}px`; page.append(footer); }
      layer.push(page);
    }
    pageLayer.replaceChildren(...layer);
    stage.style.height = `${result.pages * g.h + (result.pages - 1) * GAP}px`;
    pageOfUnit = result.pageOf;
    updateCaretPage();
    ctx.refresh();
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

  function readSel(): Sel | null {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !s.anchorNode || !s.focusNode) return null;
    const pa = paraOf(s.anchorNode);
    const pf = paraOf(s.focusNode);
    if (!pa || !pf || !flow.contains(pa) || !flow.contains(pf)) return null;
    const a: Pos = { b: Number(pa.dataset.i), o: offsetIn(pa, s.anchorNode, s.anchorOffset) };
    const f: Pos = { b: Number(pf.dataset.i), o: offsetIn(pf, s.focusNode, s.focusOffset) };
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
    updateCaretPage();
  }

  document.addEventListener('selectionchange', onSelectionChange);
  function onSelectionChange(): void {
    const sel = readSel();
    if (!sel) return;
    lastSel = sel;
    draftPara = null;
    if (!sel.collapsed || pending) pending = sel.collapsed ? pending : null;
    updateCaretPage();
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
    // A new, empty paragraph typed in Arabic becomes a right-to-left paragraph.
    if (!blockText(first) && first.id >= (look?.paras.length ?? 0) && startsRtl(text) === true && paraView(sel.from.b, new Map()).dir === 'ltr') {
      format = { ...(format ?? {}), dir: 'rtl' };
    }
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
    const key = sel.collapsed && sel.from.b === sel.to.b ? `type:${first.id}:${wordToken}` : undefined;
    pending = null;
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
    commitSplice(s.from.b, 1, [left, right], [format, rightFormat], { b: s.from.b + 1, o: 0 });
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
    const sel = targetRange();
    const m = doc();
    if (!sel || !m?.blocks) return {};
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
      rtl,
    };
  }

  function applyRun(patch: PropsPatch): void {
    const sel = targetRange();
    const m = doc();
    if (!sel || !m?.blocks || !ctx.editable()) return;
    if (sel.collapsed && draftPara === null) {
      pending = { ...(pending ?? {}) };
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
    const at = (targetRange()?.to.b ?? m.blocks.length - 1) + 1;
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
        const g = pageGeometry();
        const maxPt = (g.w - g.left - g.right) / PX;
        let w = img.naturalWidth * 0.75;
        let h = img.naturalHeight * 0.75;
        if (w > maxPt) { h = (h * maxPt) / w; w = maxPt; }
        URL.revokeObjectURL(url);
        const run: Run = { t: 'opaque', text: '', xml: '', kind: 'image', newImage: { data, ext, w: Math.round(w), h: Math.round(h), name: file.name } };
        const format = currentFormat();
        insertBlocksAfter([{ id: nextId++, runs: [run, { t: 'text', text: '', props: {} }] }], [{ align: 'center', ...(format.dir === 'rtl' ? { dir: 'rtl' } : {}) }]);
      };
      img.onerror = () => { URL.revokeObjectURL(url); ctx.setStatus(t('office.imageFailed')); };
      img.src = url;
    });
    input.click();
  }

  function insertPageBreak(): void {
    insertBlocksAfter([{ id: nextId++, runs: [{ t: 'opaque', text: '\n', xml: '', kind: 'page' }] }, emptyBlock(nextId++)], [undefined, undefined]);
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

  function renderSide(): void {
    side.hidden = !sideOpen;
    root.classList.toggle('has-side', sideOpen);
    if (!sideOpen) return;
    const head = el('div', 'fo-panel-head');
    const tabs = el('div', 'fo-panel-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [['nav', t('office.navigator')], ['comments', t('office.comments')]] as const) {
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

  function emptyState(name: 'navigator' | 'comment', text: string): HTMLElement {
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

  function tabs(): RibbonTab[] {
    const fontOptions = (): Array<{ value: string; label: string }> => FONTS.map((f) => ({ value: f, label: f }));
    return [
      ctx.fileTab(),
      {
        id: 'home', label: t('office.tabHome'), groups: [
          {
            label: t('office.groupFont'), controls: [
              { type: 'select', id: 'font', label: t('office.fontName'), cls: 'fo-fontname', width: 150, enabled: can, options: fontOptions, value: () => currentProps().font ?? '', onChange: (v) => applyRun({ font: v }) },
              {
                type: 'select', id: 'size', label: t('office.formatSize'), cls: 'faisal-office-fsize', width: 72, enabled: can,
                options: () => SIZES.map((s) => ({ value: String(s), label: String(s) })),
                value: () => String(currentProps().sz ?? ''),
                onChange: (v) => { const n = Number(v); if (n > 0) applyRun({ sz: n }); },
              },
              { type: 'button', id: 'bold', icon: 'bold', label: t('office.formatBold'), enabled: can, phone: true, pressed: () => currentProps().b === true, run: () => toggle('b') },
              { type: 'button', id: 'italic', icon: 'italic', label: t('office.formatItalic'), enabled: can, phone: true, pressed: () => currentProps().i === true, run: () => toggle('i') },
              { type: 'button', id: 'underline', icon: 'underline', label: t('office.formatUnderline'), enabled: can, pressed: () => currentProps().u === true, run: () => toggle('u') },
              { type: 'button', id: 'strike', icon: 'strike', label: t('office.formatStrike'), enabled: can, pressed: () => currentProps().strike === true, run: () => toggle('strike') },
              { type: 'color', id: 'color', icon: 'textColor', label: t('office.textColor'), noneLabel: t('office.colorAuto'), palette: PALETTE, enabled: can, phone: true, value: () => currentProps().color ?? '000000', onPick: (hex) => applyRun({ color: hex }) },
              { type: 'color', id: 'highlight', icon: 'highlight', label: t('office.highlight'), noneLabel: t('office.colorNone'), palette: Object.values(HIGHLIGHTS), enabled: can, value: () => { const h = currentProps().hl; return h ? HIGHLIGHTS[h] ?? null : null; }, onPick: (hex) => applyRun({ hl: hex ? HL_BY_HEX[hex] ?? 'yellow' : null }) },
            ],
          },
          {
            label: t('office.groupParagraph'), controls: [
              { type: 'button', id: 'bullets', icon: 'bullets', label: t('office.bullets'), enabled: can, phone: true, pressed: () => currentFormat().list === 'bullet', run: () => setParaFormat({ list: currentFormat().list === 'bullet' ? null : 'bullet' }) },
              { type: 'button', id: 'numbers', icon: 'numbers', label: t('office.numbering'), enabled: can, pressed: () => currentFormat().list === 'number', run: () => setParaFormat({ list: currentFormat().list === 'number' ? null : 'number' }) },
              alignButton('right', 'office.formatAlignRight', 'alignRight', true),
              alignButton('center', 'office.formatAlignCenter', 'alignCenter'),
              alignButton('left', 'office.formatAlignLeft', 'alignLeft'),
              alignButton('justify', 'office.formatAlignJustify', 'alignJustify'),
              { type: 'button', id: 'rtl', icon: 'rtl', label: t('office.dirRtl'), enabled: can, pressed: () => currentFormat().dir === 'rtl', run: () => setParaFormat({ dir: 'rtl' }) },
              { type: 'button', id: 'ltr', icon: 'ltr', label: t('office.dirLtr'), enabled: can, pressed: () => currentFormat().dir === 'ltr', run: () => setParaFormat({ dir: 'ltr' }) },
              {
                type: 'menu', id: 'line', icon: 'lineSpacing', label: t('office.lineSpacing'), enabled: can,
                items: () => [1, 1.15, 1.5, 2, 2.5, 3].map((n) => ({ label: String(n), checked: Math.abs((currentFormat().line ?? 1.15) - n) < 0.01, run: () => setParaFormat({ line: n }) })),
              },
            ],
          },
          {
            label: t('office.groupStyles'), controls: [
              { type: 'menu', id: 'styles', icon: 'styles', label: t('office.styles'), showLabel: true, enabled: can, items: styleItems },
            ],
          },
          {
            label: t('office.groupEditing'), controls: [
              { type: 'button', id: 'find', icon: 'find', label: t('office.find'), enabled: () => !!doc(), run: () => openFind(false, findAnchor()) },
              { type: 'button', id: 'replace', icon: 'replace', label: t('office.replace'), enabled: can, run: () => openFind(true, findAnchor()) },
            ],
          },
        ],
      },
      {
        // Review: tracking on/off, the change list, and the verdicts. Everything is a real button
        // in the ribbon or in the panel, so nothing here depends on a hover or a right-click.
        id: 'review', label: t('office.tabReview'), groups: [
          {
            label: t('office.groupTracking'), controls: [
              {
                type: 'button', id: 'tracking', icon: 'check', label: t('office.revToggle'), showLabel: true, phone: true,
                pressed: () => tracking,
                run: () => { tracking = !tracking; ctx.refresh(); renderFlow(); },
              },
              { type: 'button', id: 'revpanel', icon: 'comment', label: t('office.revPanel'), showLabel: true, phone: true, enabled: () => revLog.items.length > 0, run: () => toggleReviewPanel(true) },
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
        id: 'insert', label: t('office.tabInsert'), groups: [
          {
            label: t('office.groupTables'), controls: [
              { type: 'button', id: 'table', icon: 'table', label: t('office.insertTable'), showLabel: true, enabled: can, run: askTable },
              { type: 'button', id: 'image', icon: 'image', label: t('office.insertImage'), showLabel: true, enabled: can, run: insertImage },
            ],
          },
          {
            label: t('office.groupPages'), controls: [
              { type: 'button', id: 'pagebreak', icon: 'pageBreak', label: t('office.insertPageBreak'), showLabel: true, enabled: can, run: insertPageBreak },
              { type: 'button', id: 'toc', icon: 'toc', label: t('office.insertToc'), showLabel: true, enabled: can, run: insertToc },
              { type: 'button', id: 'date', icon: 'date', label: t('office.insertDate'), showLabel: true, enabled: can, run: insertDate },
            ],
          },
        ],
      },
      {
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
        ],
      },
      {
        id: 'view', label: t('office.tabView'), groups: [
          {
            label: t('office.groupViews'), controls: [
              { type: 'button', id: 'pageview', icon: 'pageView', label: t('office.pageView'), showLabel: true, pressed: () => mode === 'page', run: () => setMode('page') },
              { type: 'button', id: 'draftview', icon: 'draft', label: t('office.draftView'), showLabel: true, pressed: () => mode === 'draft', run: () => setMode('draft') },
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
      flow.contentEditable = ctx.editable() ? 'true' : 'false';
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
      const mod = ev.ctrlKey || ev.metaKey;
      if (!mod) return false;
      const key = ev.key.toLowerCase();
      if (key === 'b') { toggle('b'); return true; }
      if (key === 'i') { toggle('i'); return true; }
      if (key === 'u') { toggle('u'); return true; }
      if (key === 'f') { openFind(false, findAnchor()); return true; }
      if (key === 'h') { openFind(true, findAnchor()); return true; }
      if (key === 'p') { printDoc(); return true; }
      if (key === 'e') { align('center'); return true; }
      return false;
    },
    dispose(): void {
      resize.disconnect();
      document.removeEventListener('selectionchange', onSelectionChange);
      for (const url of mediaUrls.values()) URL.revokeObjectURL(url);
      mediaUrls.clear();
    },
    ...{ printDoc, exportHtml: () => { const m = doc(); if (m) void ctx.exportFile(toHtml(m, ctx.filePath() ?? '', outlines()), 'html', 'text/html'); }, exportMd: () => { const m = doc(); if (m) void ctx.exportFile(toMarkdown(m, outlines()), 'md', 'text/markdown'); } },
  } as Editor & { printDoc(): void; exportHtml(): void; exportMd(): void };
}
