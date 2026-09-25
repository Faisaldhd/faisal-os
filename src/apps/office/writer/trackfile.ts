/**
 * Writer — tracked changes written INTO the file (تتبّع التعديلات في الملف), the pure part.
 *
 * In this app a tracked edit changes the document as usual and records what happened
 * (`revisions.ts`). This module is the bridge to the file's own markup:
 *
 *  • OUT (`trackSegments`): how a paragraph's runs must be cut so each piece can carry its mark —
 *    the typed characters wrapped in `w:ins`, and the deleted ones put back as `w:del` with
 *    `w:delText`, in the order the reader will walk them. It reuses `planPieces`, which already
 *    knows where a revision's text sits, so the drawing and the writing can never disagree.
 *  • IN (`readTrackedRevisions`): the `w:ins`/`w:del` elements of a `document.xml` become the same
 *    revision log — author, date and id included — so a file someone else edited shows its changes
 *    instead of a document that quietly already contains them.
 *
 * No DOM and no ZIP here: the caller owns the bytes and the run markup, this owns the meaning.
 */
import { blockText, type DocBlock, type Run, type TextRun } from './types';
import { planPieces, type Revision, type RevisionLog } from './revisions';
import { attrLocal, localName, parsePart, type XmlDoc, type XmlElement } from '../xmlscan';

/** One piece of a paragraph as the file must hold it. */
export interface TrackSegment {
  mark: 'none' | 'insert' | 'delete';
  text: string;
  /** The run the text came from, or -1 for deleted text (which no run holds any more). */
  runIndex: number;
  revision?: Revision;
}

/** The runs of a block, in order, with their index; deleted pieces carry no run. */
const textRuns = (block: DocBlock): TextRun[] => block.runs.filter((run): run is TextRun => run.t === 'text');

/**
 * The paragraph's runs cut into marked pieces.
 *
 * A block with no pending revision comes back as one `none` piece per run, so a caller can use this
 * unconditionally. A revision whose text no longer matches the paragraph is skipped by `planPieces`
 * (the same rule the panel draws by), which keeps a stale mark out of the file.
 */
export function trackSegments(block: DocBlock, revisions: readonly Revision[]): TrackSegment[] {
  const runs = textRuns(block);
  const text = blockText(block);
  const pieces = revisions.length ? planPieces(text, revisions, block.id) : [];
  const segments: TrackSegment[] = [];

  /** The text of one run, minus what earlier pieces already took. */
  let runIndex = 0;
  let runAt = 0;
  const take = (count: number, mark: TrackSegment['mark'], revision?: Revision): void => {
    let left = count;
    while (left > 0 && runIndex < runs.length) {
      const run = runs[runIndex];
      const available = run.text.length - runAt;
      if (available <= 0) { runIndex++; runAt = 0; continue; }
      const size = Math.min(available, left);
      const segment: TrackSegment = { mark, text: run.text.slice(runAt, runAt + size), runIndex, ...(revision ? { revision } : {}) };
      const last = segments[segments.length - 1];
      // Pieces that mean the same thing and continue the same revision are one piece of markup.
      if (last && last.mark === mark && last.revision?.id === revision?.id && last.runIndex === runIndex) last.text += segment.text;
      else segments.push(segment);
      runAt += size;
      left -= size;
      if (runAt >= run.text.length) { runIndex++; runAt = 0; }
    }
  };

  if (!pieces.length) {
    for (const [index, run] of runs.entries()) {
      if (run.text) segments.push({ mark: 'none', text: run.text, runIndex: index });
    }
    return segments;
  }
  for (const piece of pieces) {
    if (piece.mark === 'delete') segments.push({ mark: 'delete', text: piece.text, runIndex: -1, ...(piece.revision ? { revision: piece.revision } : {}) });
    else take(piece.text.length, piece.mark, piece.revision);
  }
  return segments;
}

/** `w:id`, `w:author` and `w:date` for a revision: the three attributes a reader shows. */
export function revisionAttrs(rev: Revision): string {
  return ` w:id="${rev.id}" w:author="${escapeAttr(rev.author)}" w:date="${new Date(rev.time).toISOString()}"`;
}

/** Attribute values live in double quotes, so those and the ampersand must be escaped. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function revisionOf(xml: string, element: XmlElement, kind: Revision['kind'], at: number, text: string, fallbackId: number): Revision {
  const id = Number(attrLocal(xml, element, 'id'));
  const date = attrLocal(xml, element, 'date');
  const time = date ? Date.parse(date) : Number.NaN;
  return {
    id: Number.isFinite(id) && id > 0 ? id : fallbackId,
    kind,
    block: -1,
    at,
    text,
    author: attrLocal(xml, element, 'author') ?? 'Unknown',
    time: Number.isFinite(time) ? time : Date.now(),
    status: 'pending',
  };
}

/**
 * The `w:ins` / `w:del` elements of one part as a revision log.
 *
 * The text of a paragraph is what its `w:t` elements hold: an insertion is inside that text (so the
 * offset advances over it) while a deletion is not (its words live in `w:delText`, which the reader
 * does not put back in the paragraph) — the same asymmetry `revisions.ts` records. `at` is therefore
 * the offset in the paragraph's text where the change sits, which is exactly what the panel needs.
 *
 * `blocks` maps a paragraph index to the block id the model uses, because a revision remembers a
 * stable block, not a position. Unknown elements are walked through, so a change inside a hyperlink
 * or a smart tag is still found; move/format-only revisions (`w:moveFrom`, `w:rPrChange`) are not
 * tracked changes in this app's sense and are not invented here.
 */
export function readTrackedRevisions(xml: string, doc: XmlDoc, blocks?: readonly number[]): RevisionLog {
  const items: Revision[] = [];
  let counter = 0;
  const walk = (element: XmlElement, at: number, paragraph: number): number => {
    let offset = at;
    for (const child of element.children) {
      const local = localName(child.name);
      if (local === 't') {
        offset += textOf(xml, child).length;
        continue;
      }
      if (local === 'delText' || local === 'instrText') continue; // deleted text is not in the text
      if (local === 'ins') {
        const start = offset;
        let inner = offset;
        for (const node of child.children) inner = walk(node, inner, paragraph);
        const text = collectedText(xml, child, 't');
        if (text) {
          counter++;
          items.push({ ...revisionOf(xml, child, 'insert', start, text, counter), block: paragraph });
        }
        offset = inner;
        continue;
      }
      if (local === 'del') {
        const text = collectedText(xml, child, 'delText');
        if (text) {
          counter++;
          items.push({ ...revisionOf(xml, child, 'delete', offset, text, counter), block: paragraph });
        }
        continue; // the deleted words are not part of the paragraph's text
      }
      offset = walk(child, offset, paragraph);
    }
    return offset;
  };

  const paragraphs = paragraphElementsOf(doc);
  paragraphs.forEach((paragraph, index) => {
    walk(paragraph, 0, index);
  });
  const blockOf = (index: number): number => blocks?.[index] ?? index;
  return {
    nextId: items.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    items: items.map((item) => ({ ...item, block: blockOf(item.block) })),
  };
}

/** Every `w:p` of the part, in document order — the same order the readers use. */
function paragraphElementsOf(doc: XmlDoc): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (element: XmlElement, inFallback: boolean): void => {
    for (const child of element.children) {
      const fallback = inFallback || localName(child.name) === 'Fallback';
      if (localName(child.name) === 'p' && !fallback) out.push(child);
      walk(child, fallback);
    }
  };
  for (const root of doc.roots) walk(root, false);
  return out;
}

/** The text of the descendants with this local name, in order. */
function collectedText(xml: string, element: XmlElement, name: string): string {
  let out = '';
  for (const child of element.children) {
    if (localName(child.name) === name) out += textOf(xml, child);
    else out += collectedText(xml, child, name);
  }
  return out;
}

/** The text inside an element's own tags, with the predefined entities decoded. */
function textOf(xml: string, element: XmlElement): string {
  const close = xml.indexOf('<', element.openEnd);
  const end = close < 0 || close > element.end ? element.end : close;
  return xml
    .slice(element.openEnd, end)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

/** The revisions this app would write for a block: the pending ones, in order. */
export function pendingFor(revisions: readonly Revision[], block: DocBlock): Revision[] {
  const id = block.id;
  return revisions.filter((rev) => rev.status === 'pending' && rev.block === id);
}

/**
 * The tracked changes of a `word/document.xml` part, ready for the model.
 *
 * `blocks` is the id of each paragraph of the document, in order: a revision is stored against the
 * block the model uses, not against a position that moves.
 */
export function trackedRevisionsIn(xml: string, blocks?: readonly number[]): RevisionLog {
  return readTrackedRevisions(xml, parsePart(xml), blocks);
}

/** A run's text as an OOXML text body: a tab, a break or characters (the caller picks `w:t`/`w:delText`). */
export function textBody(text: string, tag: 'w:t' | 'w:delText'): string {
  let out = '';
  for (const part of text.split(/(\t|\r\n|\n|\r)/)) {
    if (!part) continue;
    if (part === '\t') out += '<w:tab/>';
    else if (part === '\n' || part === '\r' || part === '\r\n') out += '<w:br/>';
    else out += `<${tag} xml:space="preserve">${part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</${tag}>`;
  }
  return out;
}
