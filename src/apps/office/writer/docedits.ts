/**
 * Writer — undoable edits on the rich paragraphs (تعديلات قابلة للتراجع).
 *
 * One primitive covers everything: replace paragraphs `[start, start + n)` with
 * other paragraphs. Typing replaces one paragraph with its new version; Enter
 * replaces one with two; Backspace at the start merges two into one; inserting a
 * table adds several. The plain `paragraphs` list and the index-keyed paragraph
 * `formats` move with the blocks, so the model is always consistent and undo is
 * the exact inverse.
 */
import type { DocModel, Edit, OfficeModel, ParagraphFormat } from '../model';
import { blockText, type DocBlock } from './types';

export interface BlockSlice {
  blocks: DocBlock[];
  formats: Array<ParagraphFormat | undefined>;
}

/** Paragraphs `[start, start + count)` of a model, with their formats. */
export function sliceOf(model: DocModel, start: number, count: number): BlockSlice {
  const blocks = (model.blocks ?? []).slice(start, start + count);
  const formats = blocks.map((_, i) => model.formats?.[start + i]);
  return { blocks, formats };
}

function spliceFormats(
  formats: Record<number, ParagraphFormat> | undefined,
  start: number,
  removed: number,
  inserted: ReadonlyArray<ParagraphFormat | undefined>,
): Record<number, ParagraphFormat> | undefined {
  const out: Record<number, ParagraphFormat> = {};
  const shift = inserted.length - removed;
  for (const [key, value] of Object.entries(formats ?? {})) {
    const index = Number(key);
    if (index < start) out[index] = value;
    else if (index >= start + removed) out[index + shift] = value;
  }
  inserted.forEach((format, i) => { if (format && Object.keys(format).length) out[start + i] = format; });
  return Object.keys(out).length ? out : undefined;
}

function apply(m: OfficeModel, start: number, removed: number, slice: BlockSlice): OfficeModel {
  if (m.kind !== 'docx' || !m.blocks) return m;
  const blocks = m.blocks.slice();
  blocks.splice(start, removed, ...slice.blocks);
  const paragraphs = m.paragraphs.slice();
  paragraphs.splice(start, removed, ...slice.blocks.map(blockText));
  const formats = spliceFormats(m.formats, start, removed, slice.formats);
  const next: DocModel = { ...m, blocks, paragraphs };
  if (formats) next.formats = formats;
  else delete next.formats;
  return next;
}

/** Replaces `before` (at `start`) with `after`. `key` lets a burst of typing merge into one step. */
export function blockSplice(start: number, before: BlockSlice, after: BlockSlice, key?: string): Edit {
  const frozenBefore: BlockSlice = { blocks: before.blocks.slice(), formats: before.formats.slice() };
  const frozenAfter: BlockSlice = { blocks: after.blocks.slice(), formats: after.formats.slice() };
  return {
    ...(key ? { key } : {}),
    apply: (m) => apply(m, start, frozenBefore.blocks.length, frozenAfter),
    revert: (m) => apply(m, start, frozenAfter.blocks.length, frozenBefore),
  };
}

/** An edit that changes the paragraph-level format of several paragraphs at once. */
export function formatsEdit(changes: ReadonlyArray<{ index: number; before?: ParagraphFormat; after?: ParagraphFormat }>): Edit {
  const put = (m: OfficeModel, pick: 'before' | 'after'): OfficeModel => {
    if (m.kind !== 'docx') return m;
    const formats: Record<number, ParagraphFormat> = { ...(m.formats ?? {}) };
    for (const change of changes) {
      const value = change[pick];
      if (!value || !Object.values(value).some((v) => v !== undefined)) delete formats[change.index];
      else formats[change.index] = value;
    }
    const next: DocModel = { ...m, formats };
    if (!Object.keys(formats).length) delete next.formats;
    return next;
  };
  return { apply: (m) => put(m, 'after'), revert: (m) => put(m, 'before') };
}

/** The next unused paragraph id of a model. */
export function nextBlockId(model: DocModel): number {
  let max = -1;
  for (const block of model.blocks ?? []) if (block.id > max) max = block.id;
  return max + 1;
}
